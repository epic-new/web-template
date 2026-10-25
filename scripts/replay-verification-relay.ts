/**
 * SYNTHETIC LOCAL VERIFICATION ONLY. This is an external-API fixture, not an
 * application server. No outbound fetch, filesystem writes, Cloud API or real
 * publishing credential. State survives browser documents, not this process.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { z } from "zod";
import { REPLAY_RECORDING_LIMITS } from "../lib/replay/replay-config.contract";
import { ReplayUploadError, type ReplayRecordingCapability } from "../lib/replay/replay-upload-contract";
import { createSyntheticEpi210 } from "../lib/replay/tests/synthetic-epi210.core";

export const SYNTHETIC_RELAY_TOKEN = "synthetic-web4-local-only";
export const SYNTHETIC_RELAY_PROJECT = "synthetic-web4";
export const SYNTHETIC_RELAY_MAX_REQUESTS = 10_000;
const MAX_BODY_BYTES = REPLAY_RECORDING_LIMITS.maxBatchBytes;
const faults = z.enum(["accept", "advanced_cursor_next_retry", "close_next_append", "lose_next_receipt", "lose_next_registration", "offline", "fail_503", "tiny_batch"]);
const controlSchema = z.object({ mode: faults }).strict();
type Fault = z.infer<typeof faults>;
interface Diagnostic {
  recordingId: string;
  subject: string;
  startedAt: number;
  release: string | null;
  configVersion: string;
}
interface CallDiagnostic {
  recordingId: string | null;
  sequence: number | null;
  types: number[];
  timestamps: number[];
  final: boolean;
  status: number | "lost_receipt";
  code: string | null;
}

const response = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { "Cache-Control": "no-store", "X-Replay-Fixture": "synthetic-local-only" },
});
const failure = (code: ConstructorParameters<typeof ReplayUploadError>[0]) => {
  const error = new ReplayUploadError(code);
  return response(error.toBody(), error.status);
};

async function readBoundedJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) throw new ReplayUploadError("payload_too_large");
  const reader = request.body?.getReader();
  if (!reader) throw new ReplayUploadError("invalid_request");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY_BYTES) { await reader.cancel(); throw new ReplayUploadError("payload_too_large"); }
      chunks.push(chunk.value);
    }
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } catch (error) {
    if (error instanceof ReplayUploadError) throw error;
    throw new ReplayUploadError("invalid_request");
  } finally { reader.releaseLock(); }
}

/** The exact same handler is exercised by Vitest and the loopback listener. */
export function createReplayVerificationRelay({ now = Date.now }: { now?: () => number } = {}) {
  const fixture = createSyntheticEpi210({ now,
    fingerprint: (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    maxRecordings: 100, maxReceipts: 2_000,
  });
  const diagnostics = new Map<string, Diagnostic>();
  const subjects = new Map<string, string>();
  const calls: CallDiagnostic[] = [];
  let mode: Fault = "accept";
  let requests = 0;
  const resetFault = () => { mode = "accept"; fixture.setMode("accept"); };

  function policy() {
    const issuedAt = now();
    return {
      contractVersion: 1, projectId: SYNTHETIC_RELAY_PROJECT, applicationId: "synthetic-web4-app",
      environment: "development", configVersion: "4", issuedAt, expiresAt: issuedAt + 300_000, refreshIntervalMs: 30_000,
      capture: { enabled: true, sessionSampleRate: 1,
        routes: { include: ["/styleguide/replay/*", "/auth/signin"], exclude: ["/styleguide/replay/excluded"] },
        privacy: { maskAllInputs: true, maskTextSelector: "[data-mask]", blockSelector: "[data-private]" },
        diagnostics: { console: false, network: false },
      },
      reporting: { enabled: false }, recording: { transport: "epic-http", limits: { ...REPLAY_RECORDING_LIMITS } },
    };
  }

  async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    // No CORS and no browser access. Hosts are exact to prevent DNS rebinding.
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || request.headers.has("origin")) return response({ synthetic: true, error: "Loopback CLI/BFF requests only" }, 403);
    if (request.headers.get("authorization") !== `Bearer ${SYNTHETIC_RELAY_TOKEN}`) return failure("REPLAY_CREDENTIAL_INVALID");
    if (++requests > SYNTHETIC_RELAY_MAX_REQUESTS) return failure("unavailable");
    if (request.method === "GET" && url.pathname === "/__synthetic/state") {
      return response({ synthetic: true, scope: "local fixture; no Cloud or playback evidence", mode, requests,
        recordings: fixture.recordings().map((row) => ({ ...diagnostics.get(row.recordingId), status: row.status,
          nextSequence: row.nextSequence, availability: row.availability })),
        calls, limits: { recordings: 100, receipts: 2_000, calls: 128, requests: SYNTHETIC_RELAY_MAX_REQUESTS },
      });
    }
    if (request.method === "GET" && url.pathname === "/api/replay/v1/runtime-config") return response(policy());
    if (request.method !== "POST") return response({ synthetic: true, error: "Not found" }, 404);
    if (!request.headers.get("content-type")?.startsWith("application/json")) return failure("invalid_request");
    let payload: unknown;
    try { payload = await readBoundedJson(request); }
    catch (error) { return error instanceof ReplayUploadError ? response(error.toBody(), error.status) : failure("invalid_request"); }
    if (url.pathname === "/__synthetic/control") {
      const parsed = controlSchema.safeParse(payload);
      if (!parsed.success) return failure("invalid_request");
      mode = parsed.data.mode;
      fixture.setMode(mode === "tiny_batch" || mode === "fail_503" ? mode : "accept");
      return response({ synthetic: true, mode });
    }
    if (mode === "offline") return null;
    const match = /^\/api\/replay\/v1\/recordings\/([^/]+)\/batches$/.exec(url.pathname);
    const recordingId = match?.[1] ?? null;
    if (recordingId && mode === "close_next_append") { fixture.closeRecording(recordingId); resetFault(); }
    let answer = fixture.central(url.pathname, payload);
    if (!answer) return response({ synthetic: true, error: "Not found" }, 404);
    if (url.pathname === "/api/replay/v1/recordings" && answer.status < 300) {
      const capability = answer.body as ReplayRecordingCapability;
      const intent = payload as { subjectId: string; release: string | null; configVersion: string };
      if (!subjects.has(intent.subjectId)) subjects.set(intent.subjectId, `subject-${subjects.size + 1}`);
      diagnostics.set(capability.recordingId, { recordingId: capability.recordingId, subject: subjects.get(intent.subjectId)!,
        startedAt: capability.startedAt, release: intent.release, configVersion: intent.configVersion });
      if (mode === "advanced_cursor_next_retry" && answer.status === 200) {
        fixture.advanceCursor(capability.recordingId);
        answer = fixture.central(url.pathname, payload)!;
        resetFault();
      }
      if (mode === "lose_next_registration") { resetFault(); return null; }
    }
    if (recordingId) {
      const parsed = payload as { sequence?: unknown; events?: unknown; final?: unknown };
      const events = Array.isArray(parsed.events) ? parsed.events.slice(0, 2).filter((event) =>
        event && typeof event === "object" && Number.isInteger(event.type) && Number.isInteger(event.timestamp)) : [];
      const lose = mode === "lose_next_receipt" && answer.status === 200;
      calls.push({ recordingId, sequence: typeof parsed.sequence === "number" ? parsed.sequence : null, types: events.map((event) => event.type),
        timestamps: events.map((event) => event.timestamp), final: parsed.final === true,
        status: lose ? "lost_receipt" : answer.status, code: (answer.body as { code?: string }).code ?? null });
      if (calls.length > 128) calls.shift();
      if (lose) { resetFault(); return null; }
    }
    return response(answer.body, answer.status);
  }
  return { handle };
}

/** No caller can bind this fixture to a non-loopback interface. */
export async function startReplayVerificationRelay({ port = 4319, lifetimeMs = 60 * 60_000 } = {}) {
  if (process.env.NODE_ENV === "production") throw new Error("Synthetic relay cannot run in production");
  if (!Number.isInteger(port) || port < 0 || port > 65_535 || !Number.isFinite(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 60 * 60_000) throw new Error("Invalid synthetic relay bounds");
  const relay = createReplayVerificationRelay();
  const server = createServer({ requestTimeout: 12_000, headersTimeout: 5_000, maxHeaderSize: 8_192 }, async (incoming, outgoing) => {
    if (!["127.0.0.1", "::ffff:127.0.0.1", "::1"].includes(incoming.socket.remoteAddress ?? "")) { outgoing.writeHead(403).end(); return; }
    try {
      const host = incoming.headers.host;
      if (!host || !/^(localhost|127\.0\.0\.1):[0-9]+$/.test(host)) { outgoing.writeHead(403).end(); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { outgoing.writeHead(413).end(); incoming.destroy(); return; }
        chunks.push(Buffer.from(chunk));
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      const request = new Request(`http://${host}${incoming.url}`, { method: incoming.method, headers,
        ...(incoming.method === "POST" ? { body: Buffer.concat(chunks) } : {}) });
      const result = await relay.handle(request);
      if (!result) { incoming.socket.destroy(); return; }
      outgoing.writeHead(result.status, Object.fromEntries(result.headers));
      outgoing.end(Buffer.from(await result.arrayBuffer()));
    } catch { outgoing.writeHead(500).end(); }
  });
  server.maxConnections = 16;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const timer = setTimeout(() => server.close(), lifetimeMs);
  timer.unref();
  const address = server.address();
  return { port: typeof address === "object" && address ? address.port : port,
    async close() { clearTimeout(timer); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

if (import.meta.main) {
  if (!process.argv.includes("--synthetic-local-only")) throw new Error("Pass --synthetic-local-only to acknowledge the fixture scope");
  const relay = await startReplayVerificationRelay({ port: Number(process.env.REPLAY_FIXTURE_PORT ?? 4319) });
  console.info(`SYNTHETIC Replay relay: http://localhost:${relay.port}; memory only; expires in one hour; no Cloud writes.`);
  const stop = () => { void relay.close().then(() => process.exit(0)); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
