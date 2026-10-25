// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { record as rrwebRecord } from "@rrweb/record";
import type { eventWithTime } from "@rrweb/types";
vi.mock("next/headers", () => ({ headers: vi.fn(), cookies: vi.fn() }));
import { db } from "@/db";
import * as schema from "@/db/schema";
import { PostDB, PreDB } from "@/lib/db-test";
import { POST as establish, DELETE as resetIdentity } from "@/app/api/epic/replay/identity/route";
import { GET as readPolicy } from "@/app/api/epic/replay/config/route";
import { POST as register } from "@/app/api/epic/replay/recordings/route";
import { POST as upload } from "@/app/api/epic/replay/recordings/[recordingId]/batches/route";
import { POST as renew } from "@/app/api/epic/replay/recordings/[recordingId]/capability/route";
import { createReplayVerificationRelay, SYNTHETIC_RELAY_PROJECT, SYNTHETIC_RELAY_TOKEN } from "@/scripts/replay-verification-relay";
import { createReplayRootRuntime } from "../replay-root-runtime";
import { createReplayRecordingPipeline } from "../replay-recording-pipeline";
import { createReplayDocumentOwners } from "../replay-document-owner";
import { createReplayHandoff, type ReplayHandoffLedgerRecord, type ReplayHandoffLedger } from "../replay-handoff";
import { epicReplayConsent } from "../replay-consent";
import type { ReplayLockManager } from "../replay-ownership";
import type { ReplayFetch } from "../replay-upload-contract";
import { replayRequest, routeParams, signUp } from "./replay-route.fixture";

describe("root runtime through real BFF and document-independent synthetic relay", () => {
  const runtimes: ReturnType<typeof createReplayRootRuntime>[] = [];
  beforeEach(async () => {
    await PreDB(db, schema, { user: [], account: [], session: [], replay_recording: [], replay_rate_limit: [] });
    sessionStorage.clear();
    window.history.replaceState({}, "", "/styleguide/replay/upload");
  });
  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.dispose();
    epicReplayConsent.reset(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  });

  async function setup() {
    const user = await signUp("synthetic-user-1@example.com");
    const relay = createReplayVerificationRelay();
    vi.stubEnv("EPIC_API_URL", "http://localhost:4319");
    vi.stubEnv("EPIC_PROJECT_ID", SYNTHETIC_RELAY_PROJECT);
    vi.stubEnv("EPIC_PUBLISHING_TOKEN", SYNTHETIC_RELAY_TOKEN);
    vi.stubEnv("EPIC_ENVIRONMENT", "development");
    const central: ReplayFetch = async (input, init) => {
      const result = await relay.handle(new Request(String(input), init));
      if (!result) throw new TypeError("Synthetic lost receipt");
      return result;
    };
    vi.stubGlobal("fetch", central);
    const policy = await (await readPolicy()).json();
    expect(policy.status).toBe("active");
    const browser: ReplayFetch = async (input, init) => {
      const path = String(input).replace("/api/epic/replay", "");
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const request = replayRequest(path, { body, cookie: user.cookie });
      if (path === "/identity") return init?.method === "DELETE" ? resetIdentity(request) : establish(request);
      if (path === "/recordings") return register(request);
      const match = /^\/recordings\/([^/]+)\/(batches|capability)$/.exec(path);
      if (!match) throw new Error("Unexpected synthetic browser request");
      return match[2] === "batches" ? upload(request, routeParams(match[1]!)) : renew(request, routeParams(match[1]!));
    };
    const held = new Set<string>();
    const locks: ReplayLockManager = { async request(name, _options, callback) {
      if (held.has(name)) throw new Error("Contended synthetic browser lock");
      held.add(name); try { await callback({ name }); } finally { held.delete(name); }
    } };
    const rows = new Map<string, ReplayHandoffLedgerRecord>();
    const ledger: ReplayHandoffLedger = {
      async arm(row) { if (rows.has(row.generation)) return false; rows.set(row.generation, { ...row }); return true; },
      async consume(generation, proof, now) { const row = rows.get(generation); if (!row || row.consumed || row.proof !== proof || row.expiresAt <= now) return false; row.consumed = true; return true; },
      async remove(generation) { rows.delete(generation); },
    };
    const record = ((options?: { emit?: (event: eventWithTime) => void }) => {
      options?.emit?.({ type: 4, timestamp: Date.now(), data: { href: location.href, width: 100, height: 100 } } as eventWithTime);
      options?.emit?.({ type: 2, timestamp: Date.now(), data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { left: 0, top: 0 } } } as unknown as eventWithTime);
      return () => {};
    }) as typeof rrwebRecord;
    const create = (type: "reload" | "navigate", opener = false) => {
      const runtime = createReplayRootRuntime({ documentRelease: "synthetic-build-A", getPolicy: () => policy,
        subscribePolicy: () => () => {}, fetch: browser, pipelineOptions: { record },
        loadPipeline: async () => ({ createReplayRecordingPipeline }), owners: createReplayDocumentOwners(), locks,
        monotonicNow: Date.now, handoff: createReplayHandoff({ storage: sessionStorage, ledger, now: Date.now, monotonicNow: Date.now, epochNow: Date.now }),
        navigation: { type, opener },
      });
      runtimes.push(runtime); runtime.setIdentity(user.userId); runtime.attach(); epicReplayConsent.grant();
      return runtime;
    };
    const inspect = async () => (await (await central("http://localhost:4319/__synthetic/state", { headers: { authorization: `Bearer ${SYNTHETIC_RELAY_TOKEN}` } })).json());
    const control = (mode: string) => central("http://localhost:4319/__synthetic/control", { method: "POST", headers: {
      authorization: `Bearer ${SYNTHETIC_RELAY_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ mode }) });
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    return { create, inspect, control };
  }
  async function capture(runtime: ReturnType<typeof createReplayRootRuntime>, timeout = 11_000) {
    await vi.waitFor(() => expect(runtime.getSnapshot().snapshotReceived, JSON.stringify(runtime.getSnapshot())).toBe(true), { timeout, interval: 100 });
    await vi.waitFor(() => expect(runtime.getDiagnostics().eligibleHandoff).toBe(true), { timeout: 2_000, interval: 50 });
  }

  it("retries the real registration after reload, appends its fresh snapshot, and isolates an opener", async () => {
    const { create, inspect } = await setup();
    const original = create("navigate");
    await capture(original);
    const reference = original.getSnapshot().reference!;
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    expect(original.getSnapshot().continuity).toBe("handoff");
    original.dispose(); epicReplayConsent.reset();
    await vi.advanceTimersByTimeAsync(200);
    const successor = create("reload");
    await capture(successor);
    expect(successor.getSnapshot()).toMatchObject({ continuity: "resumed", reference: { recordingId: reference.recordingId, startedAt: reference.startedAt }, evidence: "unverified" });
    const state = await inspect();
    expect(state.recordings).toHaveLength(1);
    expect(state.calls).toMatchObject([{ sequence: 0, types: [4, 2], final: false }, { sequence: 1, types: [4, 2], final: false }]);
    expect(state.calls[1].timestamps[0]).toBeGreaterThan(state.calls[0].timestamps[0]);
    const opener = create("navigate", true); await capture(opener);
    expect(opener.getSnapshot().reference!.recordingId).not.toBe(reference.recordingId);
    await PostDB(db, schema, { replay_recording: [{ status: "open" }, { status: "open" }] });
  }, 20_000);

  it.each(["advanced_cursor_next_retry", "close_next_append"])("rotates conservatively through the real BFF on %s", async (mode) => {
    const { create, inspect, control } = await setup();
    const original = create("navigate"); await capture(original);
    const reference = original.getSnapshot().reference!;
    window.dispatchEvent(new PageTransitionEvent("pagehide")); original.dispose(); epicReplayConsent.reset();
    await control(mode);
    const successor = create("reload"); await capture(successor, 20_000);
    expect(successor.getSnapshot()).toMatchObject({ continuity: "new_recording" });
    expect(successor.getSnapshot().reference!.recordingId).not.toBe(reference.recordingId);
    const state = await inspect();
    const oldAppends = state.calls.filter((call: { recordingId: string; status: number }) => call.recordingId === reference.recordingId && call.status === 200);
    expect(oldAppends).toHaveLength(1);
    if (mode === "close_next_append") {
      expect(state.calls).toContainEqual(expect.objectContaining({ recordingId: reference.recordingId,
        sequence: 1, types: [4, 2], status: 409, code: "recording_closed", final: false }));
      expect(state.recordings).toContainEqual(expect.objectContaining({ recordingId: reference.recordingId, status: "closed", nextSequence: 1 }));
    }
  }, 30_000);
});
