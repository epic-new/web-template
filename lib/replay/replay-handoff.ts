import { z } from "zod";

import { replayUploadCheckpointSchema, type ReplayUploadCheckpoint } from "./replay-upload-checkpoint";
import { replayRecordingLockName, type ReplayOwnershipLease } from "./replay-ownership";
import { safeReplayPathname } from "./replay-upload-contract";

export const REPLAY_HANDOFF_STORAGE_KEY = "epic-replay:handoff:v1";
export const REPLAY_HANDOFF_MAX_BYTES = 8_192;
export const REPLAY_HANDOFF_DEFAULT_WINDOW_MS = 15_000;
export const REPLAY_HANDOFF_MAX_RECORDS = 100;
const PREARM_TTL_MS = 60_000;
const CLOCK_DRIFT_TOLERANCE_MS = 1_000;
const DATABASE = "epic-replay-handoff-v1";
const STORE = "generations";

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const contextSchema = z.object({
  fingerprint: z.string().min(1).max(4_096),
  documentRelease: z.string().min(1).max(128).regex(/^[A-Za-z0-9._+\-/]+$/),
  remainingDurationMs: z.number().int().positive().max(3_600_000),
  remainingInactivityMs: z.number().int().positive().max(900_000),
  recoveryDebt: z.number().int().min(0).max(3),
}).strict();

export type ReplayHandoffContext = z.infer<typeof contextSchema>;

const preparedSchema = z.object({
  version: z.literal(1),
  generation: z.uuid(),
  upload: replayUploadCheckpointSchema,
  context: contextSchema,
  preparedAt: timestamp,
  armedUntil: timestamp,
  windowMs: z.number().int().min(1_000).max(30_000),
}).strict().refine((value) =>
  value.upload.registration.release === value.context.documentRelease &&
  safeReplayPathname(value.upload.registration.route) === value.upload.registration.route &&
  !["incomplete", "unavailable", "expired", "deleted"].includes(value.upload.lastAcknowledgment.availability) &&
  value.armedUntil === value.preparedAt + PREARM_TTL_MS,
"Mismatched document or preparation lifetime");

export type PreparedReplayHandoff = z.infer<typeof preparedSchema>;

export const replayHandoffCandidateSchema = z.object({
  prepared: preparedSchema,
  offeredAt: timestamp,
  expiresAt: timestamp,
  elapsedBeforeOfferMs: z.number().int().nonnegative().max(PREARM_TTL_MS),
}).strict().refine((value) =>
  value.offeredAt >= value.prepared.preparedAt &&
  value.offeredAt < value.prepared.armedUntil &&
  value.expiresAt === Math.min(value.offeredAt + value.prepared.windowMs, value.prepared.armedUntil) &&
  value.elapsedBeforeOfferMs >= value.offeredAt - value.prepared.preparedAt &&
  value.elapsedBeforeOfferMs < value.prepared.context.remainingDurationMs &&
  value.elapsedBeforeOfferMs < value.prepared.context.remainingInactivityMs,
"Invalid checkpoint clocks or elapsed lifecycle limits");

export type ReplayHandoffCandidate = z.infer<typeof replayHandoffCandidateSchema>;
export interface ConsumedReplayHandoff {
  candidate: ReplayHandoffCandidate;
  /** Import these remaining limits/debt; a reload never replenishes them. */
  remaining: ReplayHandoffContext;
}

export interface ReplayHandoffLedgerRecord {
  generation: string;
  recordingId: string;
  proof: string;
  expiresAt: number;
  consumed: boolean;
}

/** The browser storage boundary. consume must be one atomic transaction. */
export interface ReplayHandoffLedger {
  arm(record: ReplayHandoffLedgerRecord, now: number): Promise<boolean>;
  consume(generation: string, proof: string, now: number): Promise<boolean>;
  remove(generation: string): Promise<void>;
}

function browserIndexedDB(): IDBFactory | null {
  try { return typeof indexedDB === "undefined" ? null : indexedDB; } catch { return null; }
}

/**
 * The ledger contains metadata only, never events or capabilities. It is a
 * cooperative one-shot ledger, not a central fence. Missing state rejects
 * continuation, including after eviction, private-mode cleanup or corruption.
 */
export function createIndexedDBReplayHandoffLedger(factory: IDBFactory | null = browserIndexedDB()): ReplayHandoffLedger {
  const transaction = <T>(fallback: T, run: (store: IDBObjectStore, result: (value: T) => void) => void): Promise<T> => {
    if (!factory) return Promise.resolve(fallback);
    return new Promise((resolve) => {
      let finished = false;
      let db: IDBDatabase | undefined;
      let tx: IDBTransaction | undefined;
      let result = fallback;
      const finish = (value: T) => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        db?.close();
        resolve(value);
      };
      const deadline = setTimeout(() => {
        try { tx?.abort(); } catch { /* Already complete. */ }
        finish(fallback);
      }, 1_000);
      try {
        const open = factory.open(DATABASE, 1);
        open.onupgradeneeded = () => {
          if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE, { keyPath: "generation" });
        };
        open.onerror = open.onblocked = () => finish(fallback);
        open.onsuccess = () => {
          db = open.result;
          if (finished) { db.close(); return; }
          try {
            tx = db.transaction(STORE, "readwrite");
            tx.oncomplete = () => finish(result);
            tx.onerror = tx.onabort = () => finish(fallback);
            run(tx.objectStore(STORE), (value) => { result = value; });
          } catch { finish(fallback); }
        };
      } catch { finish(fallback); }
    });
  };
  return {
    arm(record, now) {
      return transaction(false, (store, result) => {
        const request = store.getAll();
        request.onsuccess = () => {
          const rows = request.result as (ReplayHandoffLedgerRecord | null)[];
          let retained = 0;
          for (const row of rows) {
            if (!row || typeof row.generation !== "string") { retained++; continue; }
            if (!Number.isFinite(row.expiresAt) || row.expiresAt <= now) store.delete(row.generation);
            else retained++;
          }
          // Do not replace spent generations or evict still-live tombstones.
          if (rows.some((row) => row?.generation === record.generation) || retained >= REPLAY_HANDOFF_MAX_RECORDS) return;
          store.add(record);
          result(true);
        };
      });
    },
    consume(generation, proof, now) {
      return transaction(false, (store, result) => {
        const request = store.get(generation);
        request.onsuccess = () => {
          const row = request.result as ReplayHandoffLedgerRecord | undefined;
          if (!row || row.consumed || row.expiresAt <= now || row.proof !== proof) return;
          store.put({ ...row, consumed: true });
          result(true);
        };
      });
    },
    async remove(generation) {
      await transaction(false, (store, result) => { store.delete(generation); result(true); });
    },
  };
}

export interface ReplayReloadNavigation {
  type: string;
  opener: boolean;
  persisted?: boolean;
  discarded?: boolean;
  prerendering?: boolean;
}

export function currentReplayNavigation(): ReplayReloadNavigation {
  try {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return {
      type: navigation?.type ?? "unknown",
      opener: window.opener !== null,
      discarded: !!(document as Document & { wasDiscarded?: boolean }).wasDiscarded,
      prerendering: !!(document as Document & { prerendering?: boolean }).prerendering,
    };
  } catch { return { type: "unknown", opener: true }; }
}

function sessionStorageOrNull(): Storage | null {
  try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; }
}

function matchingContext(left: ReplayHandoffContext, right: ReplayHandoffContext): boolean {
  return left.fingerprint === right.fingerprint && left.documentRelease === right.documentRelease;
}

function serialized(value: unknown): string | null {
  try {
    const json = JSON.stringify(value);
    return new TextEncoder().encode(json).byteLength <= REPLAY_HANDOFF_MAX_BYTES ? json : null;
  } catch { return null; }
}

export function createReplayHandoff({
  storage = sessionStorageOrNull(),
  ledger = createIndexedDBReplayHandoffLedger(),
  now = () => Date.now(),
  monotonicNow = () => performance.now(),
  randomUUID = () => crypto.randomUUID(),
  windowMs = REPLAY_HANDOFF_DEFAULT_WINDOW_MS,
}: {
  storage?: Storage | null;
  ledger?: ReplayHandoffLedger;
  now?: () => number;
  monotonicNow?: () => number;
  randomUUID?: () => string;
  windowMs?: number;
} = {}) {
  let epoch = 0;
  let armed: { value: PreparedReplayHandoff; monotonic: number } | null = null;

  function clearCandidate(): boolean {
    try { storage?.removeItem(REPLAY_HANDOFF_STORAGE_KEY); return storage !== null; } catch { return false; }
  }

  function invalidate() {
    epoch++;
    const old = armed;
    armed = null;
    clearCandidate();
    if (old) void ledger.remove(old.value.generation).catch(() => {});
  }

  function remaining(candidate: ReplayHandoffCandidate, at: number): ReplayHandoffContext | null {
    if (at < candidate.offeredAt || at >= candidate.expiresAt) return null;
    const elapsed = candidate.elapsedBeforeOfferMs + at - candidate.offeredAt;
    const context = candidate.prepared.context;
    const duration = context.remainingDurationMs - elapsed;
    const inactivity = context.remainingInactivityMs - elapsed;
    if (duration <= 0 || inactivity <= 0) return null;
    return { ...context, remainingDurationMs: duration, remainingInactivityMs: inactivity };
  }

  function readCandidate(): ReplayHandoffCandidate | null {
    try {
      const raw = storage?.getItem(REPLAY_HANDOFF_STORAGE_KEY);
      if (!raw || new TextEncoder().encode(raw).byteLength > REPLAY_HANDOFF_MAX_BYTES) return null;
      const value = replayHandoffCandidateSchema.safeParse(JSON.parse(raw));
      return value.success && remaining(value.data, now()) ? value.data : null;
    } catch { return null; }
  }

  return {
    async prepare(upload: ReplayUploadCheckpoint, context: ReplayHandoffContext): Promise<PreparedReplayHandoff | null> {
      invalidate();
      const generation = epoch;
      if (!storage || !Number.isInteger(windowMs) || windowMs < 1_000 || windowMs > 30_000) return null;
      const at = now();
      const monotonic = monotonicNow();
      let parsed: ReturnType<typeof preparedSchema.safeParse>;
      try {
        parsed = preparedSchema.safeParse({ version: 1, generation: randomUUID(), upload, context, preparedAt: at, armedUntil: at + PREARM_TTL_MS, windowMs });
      } catch { return null; }
      if (!parsed.success) return null;
      const value = parsed.data;
      const proof = serialized(value);
      if (!proof) return null;
      try {
        const accepted = await ledger.arm({ generation: value.generation, recordingId: upload.recordingId, proof, expiresAt: value.armedUntil, consumed: false }, at);
        if (!accepted) return null;
        if (generation !== epoch || now() < at || now() >= value.armedUntil) {
          void ledger.remove(value.generation).catch(() => {});
          return null;
        }
        armed = { value, monotonic };
        return value;
      } catch { return null; }
    },

    /** Called only AFTER capture/transport quiesce; no asynchronous unload work. */
    offer(prepared: PreparedReplayHandoff, upload: ReplayUploadCheckpoint, context: ReplayHandoffContext, lease: ReplayOwnershipLease, { persisted = false }: { persisted?: boolean } = {}): boolean {
      const current = armed;
      if (!current || current.value !== prepared || !contextSchema.safeParse(context).success || persisted || !lease.isHeld() || lease.name !== replayRecordingLockName(upload.recordingId)) return false;
      const at = now();
      const wallElapsed = at - prepared.preparedAt;
      const monoElapsed = monotonicNow() - current.monotonic;
      if (wallElapsed < 0 || monoElapsed < 0 || Math.abs(wallElapsed - monoElapsed) > CLOCK_DRIFT_TOLERANCE_MS || !matchingContext(prepared.context, context)) return false;
      const parsedUpload = replayUploadCheckpointSchema.safeParse(upload);
      if (!parsedUpload.success || JSON.stringify(parsedUpload.data) !== JSON.stringify(prepared.upload)) return false;
      // Changes to debt or shorter host limits require a new preparation.
      if (context.recoveryDebt !== prepared.context.recoveryDebt) return false;
      const candidate = replayHandoffCandidateSchema.safeParse({
        prepared,
        offeredAt: at,
        expiresAt: Math.min(at + windowMs, prepared.armedUntil),
        elapsedBeforeOfferMs: Math.ceil(Math.max(wallElapsed, monoElapsed,
          prepared.context.remainingDurationMs - context.remainingDurationMs,
          prepared.context.remainingInactivityMs - context.remainingInactivityMs)),
      });
      if (!candidate.success || !remaining(candidate.data, now())) return false;
      const json = serialized(candidate.data);
      if (!json) return false;
      try {
        storage!.setItem(REPLAY_HANDOFF_STORAGE_KEY, json);
        if (storage!.getItem(REPLAY_HANDOFF_STORAGE_KEY) !== json) { clearCandidate(); return false; }
      } catch { clearCandidate(); return false; }
      // Preserve its shared ledger record; consume, not invalidation, owns it now.
      armed = null;
      epoch++;
      return true;
    },

    peek(navigation: ReplayReloadNavigation = currentReplayNavigation()): ReplayHandoffCandidate | null {
      if (navigation.type !== "reload" || navigation.opener || navigation.persisted || navigation.discarded || navigation.prerendering) {
        clearCandidate();
        return null;
      }
      const candidate = readCandidate();
      if (!candidate) clearCandidate();
      return candidate;
    },

    async consume(candidate: ReplayHandoffCandidate, context: ReplayHandoffContext, lease: ReplayOwnershipLease, signal?: AbortSignal): Promise<ConsumedReplayHandoff | null> {
      const parsed = replayHandoffCandidateSchema.safeParse(candidate);
      const local = readCandidate();
      if (!clearCandidate() || !parsed.success || !contextSchema.safeParse(context).success || !local || JSON.stringify(local) !== JSON.stringify(parsed.data)) return null;
      const value = parsed.data;
      if (signal?.aborted || !lease.isHeld() || lease.name !== replayRecordingLockName(value.prepared.upload.recordingId) || !matchingContext(value.prepared.context, context)) return null;
      const proof = serialized(value.prepared);
      if (!proof || !remaining(value, now())) return null;
      try {
        if (!await ledger.consume(value.prepared.generation, proof, now())) return null;
        // Even cancellation/expiry after the transaction permanently spends it.
        const limits = remaining(value, now());
        if (!limits || signal?.aborted || !lease.isHeld()) return null;
        return { candidate: value, remaining: {
          ...limits,
          remainingDurationMs: Math.min(limits.remainingDurationMs, context.remainingDurationMs),
          remainingInactivityMs: Math.min(limits.remainingInactivityMs, context.remainingInactivityMs),
          recoveryDebt: Math.max(limits.recoveryDebt, context.recoveryDebt),
        } };
      } catch { return null; }
    },

    invalidate,
    clear: invalidate,
  };
}

export type ReplayHandoff = ReturnType<typeof createReplayHandoff>;
