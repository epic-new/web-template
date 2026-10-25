import { replayIdentityResponseSchema, type ReplayFetch } from "./replay-upload-contract";

const REQUEST_TIMEOUT_MS = 12_000;
type IdentityEvent = { phase: "begin" | "settled" | "external"; epoch: number };
const listeners = new Set<(event: IdentityEvent) => void>();
let epoch = 0;
const pendingBoundaries = new Set<number>();
let channel: BroadcastChannel | null = null;
const RESET_KEY = "epic-replay:identity-reset";

export function replayIdentityResetPending(): boolean {
  try { return typeof window !== "undefined" && window.sessionStorage.getItem(RESET_KEY) === "required"; }
  catch { return false; }
}
export function clearReplayIdentityReset(): void {
  try { if (typeof window !== "undefined") window.sessionStorage.removeItem(RESET_KEY); } catch { /* Optional metadata. */ }
}
export function replayIdentityBoundaryPending(): boolean { return pendingBoundaries.size > 0; }

function notify(event: IdentityEvent) {
  for (const listener of [...listeners]) {
    try { listener(event); } catch { /* Replay cannot interrupt authentication. */ }
  }
}

/** Stops replay synchronously before an authentication mutation can change the DOM. */
export function beginReplayIdentityBoundary(): () => void {
  try { if (typeof window !== "undefined") window.sessionStorage.setItem(RESET_KEY, "required"); } catch { /* No credential is stored. */ }
  const current = ++epoch;
  pendingBoundaries.add(current);
  notify({ phase: "begin", epoch: current });
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    pendingBoundaries.delete(current);
    notify({ phase: "settled", epoch: current });
    try { channel?.postMessage({ type: "identity-invalidated" }); } catch { /* Optional cross-tab hint. */ }
  };
}

/** Preserves the authentication operation's result/error and never waits on replay. */
export async function withReplayIdentityBoundary<T>(operation: () => Promise<T>): Promise<T> {
  const finish = beginReplayIdentityBoundary();
  try { return await operation(); } finally { finish(); }
}

export function subscribeReplayIdentityBoundary(listener: (event: IdentityEvent) => void): () => void {
  listeners.add(listener);
  if (!channel && typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
    try {
      channel = new BroadcastChannel("epic-replay:identity");
      channel.onmessage = (event) => {
        if (event.data?.type === "identity-invalidated") notify({ phase: "external", epoch: ++epoch });
      };
    } catch { /* Unavailable broadcasting does not permit stale capture on local transitions. */ }
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { channel?.close(); channel = null; }
  };
}

export interface ReplayIdentityOptions {
  fetch?: ReplayFetch;
  timeoutMs?: number;
  maxAttempts?: () => number;
  now?: () => number;
}

/** Serialized cookie operations: a cancelled reset cannot be overtaken by a new bootstrap. */
export function createReplayIdentity({
  fetch: fetchImpl = (input, init) => fetch(input, init),
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxAttempts = () => 3,
  now = Date.now,
}: ReplayIdentityOptions = {}) {
  let tail: Promise<unknown> = Promise.resolve();
  let resetVersion = 0;
  let acknowledgedReset = 0;

  async function request(method: "POST" | "DELETE", signal: AbortSignal, deadline: number): Promise<boolean> {
    const attempts = Math.min(3, Math.max(1, maxAttempts()));
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (signal.aborted || now() >= deadline) return false;
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, Math.min(timeoutMs, deadline - now()));
      try {
        const response = await fetchImpl("/api/epic/replay/identity", {
          method, credentials: "same-origin", cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contractVersion: 1 }), signal: controller.signal,
        });
        if (signal.aborted || controller.signal.aborted || now() >= deadline) return false;
        if (response.ok) {
          const payload = await response.json();
          return !signal.aborted && !controller.signal.aborted && now() < deadline && replayIdentityResponseSchema.safeParse(payload).success;
        }
        // Policy, cookie and malformed acknowledgments are not transient permission.
        if (response.status < 500 && response.status !== 429) return false;
      } catch { /* A bounded next attempt may acknowledge the same cookie operation. */ }
      finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
    }
    return false;
  }

  return {
    acknowledge({ signal, reset = false, deadline = Infinity }: {
      signal: AbortSignal; reset?: boolean; deadline?: number;
    }): Promise<boolean> {
      if (reset) resetVersion++;
      const operation = tail.then(async () => {
        if (signal.aborted) return false;
        while (acknowledgedReset < resetVersion) {
          const version = resetVersion;
          if (!await request("DELETE", signal, deadline)) return false;
          acknowledgedReset = version;
        }
        return request("POST", signal, deadline);
      }).catch(() => false);
      tail = operation;
      return operation;
    },
    requireReset(): void { resetVersion++; },
  };
}
