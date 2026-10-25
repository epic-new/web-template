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
import { createReplayHandoff, REPLAY_HANDOFF_STORAGE_KEY, type ReplayHandoffLedgerRecord, type ReplayHandoffLedger } from "../replay-handoff";
import { epicReplayConsent } from "../replay-consent";
import type { ReplayLockManager } from "../replay-ownership";
import { replayRegistrationRequestSchema, type ReplayFetch } from "../replay-upload-contract";
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
    const browserFetch = vi.fn(browser);
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
    const create = (type: "reload" | "navigate", opener = false, documentRelease = "synthetic-build-A") => {
      const runtime = createReplayRootRuntime({ documentRelease, getPolicy: () => policy,
        subscribePolicy: () => () => {}, fetch: browserFetch, pipelineOptions: { record },
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
    return { create, inspect, control, browserFetch };
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

  it("registers a fresh build-B document through the real BFF without resuming its build-A handoff", async () => {
    const { create, inspect, browserFetch } = await setup();
    const original = create("navigate");
    await capture(original);
    const referenceA = original.getSnapshot().reference!;
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    expect(original.getSnapshot().continuity).toBe("handoff");
    expect(sessionStorage.getItem(REPLAY_HANDOFF_STORAGE_KEY)).not.toBeNull();
    original.dispose(); epicReplayConsent.reset();
    await vi.advanceTimersByTimeAsync(200);

    // A new document receives its own public build identity. Even an otherwise
    // eligible clean build-A frontier cannot authorize continuation under B.
    const successor = create("reload", false, "synthetic-build-B");
    const continuity: string[] = [];
    successor.subscribe(() => continuity.push(successor.getSnapshot().continuity));
    await capture(successor);
    const referenceB = successor.getSnapshot().reference!;
    expect(successor.getSnapshot()).toMatchObject({ status: "capturing", continuity: "new_recording",
      snapshotReceived: true, evidence: "unverified" });
    expect(continuity).not.toContain("resumed");
    expect(referenceB.recordingId).not.toBe(referenceA.recordingId);
    expect(referenceB.startedAt).toBeGreaterThan(referenceA.startedAt);
    expect(sessionStorage.getItem(REPLAY_HANDOFF_STORAGE_KEY)).toBeNull();

    const registrations = browserFetch.mock.calls
      .filter(([path]) => String(path).endsWith("/recordings"))
      .map(([, init]) => replayRegistrationRequestSchema.parse(JSON.parse(String(init?.body))));
    expect(registrations).toHaveLength(2);
    expect(registrations.map(({ release, startedAt, configVersion }) => ({ release, startedAt, configVersion }))).toEqual([
      { release: "synthetic-build-A", startedAt: referenceA.startedAt, configVersion: "4" },
      { release: "synthetic-build-B", startedAt: referenceB.startedAt, configVersion: "4" },
    ]);
    expect(registrations[1]!.idempotencyKey).not.toBe(registrations[0]!.idempotencyKey);

    const state = await inspect();
    expect(state.recordings).toHaveLength(2);
    expect(state.recordings).toEqual(expect.arrayContaining([
      expect.objectContaining({ recordingId: referenceA.recordingId, startedAt: referenceA.startedAt,
        release: "synthetic-build-A", nextSequence: 1, status: "open" }),
      expect.objectContaining({ recordingId: referenceB.recordingId, startedAt: referenceB.startedAt,
        release: "synthetic-build-B", nextSequence: 1, status: "open" }),
    ]));
    expect(state.calls).toMatchObject([
      { recordingId: referenceA.recordingId, sequence: 0, types: [4, 2], status: 200, final: false },
      { recordingId: referenceB.recordingId, sequence: 0, types: [4, 2], status: 200, final: false },
    ]);
    await PostDB(db, schema, { replay_recording: [
      { recordingId: referenceA.recordingId, status: "open" },
      { recordingId: referenceB.recordingId, status: "open" },
    ] });
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

  it("spends a lost resume registration once and rejects replay of its consumed candidate through the real BFF", async () => {
    const { create, inspect, control, browserFetch } = await setup();
    const original = create("navigate"); await capture(original);
    const reference = original.getSnapshot().reference!;
    const originalIntent = browserFetch.mock.calls.find(([path]) => String(path).endsWith("/recordings"))![1]!.body;
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    const savedCandidate = sessionStorage.getItem(REPLAY_HANDOFF_STORAGE_KEY)!;
    expect(savedCandidate).not.toBeNull();
    original.dispose(); epicReplayConsent.reset();
    await control("lose_next_registration");

    const successor = create("reload");
    const continuity: string[] = [];
    successor.subscribe(() => continuity.push(successor.getSnapshot().continuity));
    await capture(successor, 20_000);
    expect(successor.getSnapshot()).toMatchObject({ continuity: "new_recording" });
    expect(successor.getSnapshot().reference!.recordingId).not.toBe(reference.recordingId);
    expect(successor.getDiagnostics().recoveryDebt).toBe(1);
    expect(continuity).not.toContain("resumed");
    expect(sessionStorage.getItem(REPLAY_HANDOFF_STORAGE_KEY)).toBeNull();

    // A copied carrier cannot revive the already-consumed shared generation,
    // even while its original acceptance window is still open.
    sessionStorage.setItem(REPLAY_HANDOFF_STORAGE_KEY, savedCandidate);
    const clone = create("reload"); await capture(clone, 20_000);
    expect(clone.getSnapshot()).toMatchObject({ continuity: "new_recording" });
    expect(clone.getSnapshot().reference!.recordingId).not.toBe(reference.recordingId);
    const originalAttempts = browserFetch.mock.calls.filter(([path, init]) =>
      String(path).endsWith("/recordings") && init?.body === originalIntent);
    expect(originalAttempts).toHaveLength(2); // Initial registration and one lost resume ACK.
    const state = await inspect();
    expect(state.recordings).toHaveLength(3);
    expect(state.recordings).toContainEqual(expect.objectContaining({ recordingId: reference.recordingId, status: "open", nextSequence: 1 }));
    expect(state.calls.filter((call: { recordingId: string }) => call.recordingId === reference.recordingId)).toHaveLength(1);
    await PostDB(db, schema, { replay_recording: [{ status: "open" }, { status: "open" }, { status: "open" }] });
  }, 30_000);

  it("recovers a lost first resumed snapshot ACK with the exact immutable batch through the real BFF", async () => {
    const { create, inspect, control, browserFetch } = await setup();
    const original = create("navigate"); await capture(original);
    const reference = original.getSnapshot().reference!;
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    original.dispose(); epicReplayConsent.reset();
    await control("lose_next_receipt");

    const successor = create("reload");
    await vi.waitFor(async () => {
      const state = await inspect();
      expect(state.calls).toContainEqual(expect.objectContaining({ recordingId: reference.recordingId,
        sequence: 1, types: [4, 2], status: "lost_receipt", final: false }));
    }, { timeout: 11_000, interval: 50 });
    expect(successor.getSnapshot()).toMatchObject({ continuity: "resuming", snapshotReceived: false,
      reference: { recordingId: reference.recordingId, startedAt: reference.startedAt } });
    expect(successor.getDiagnostics().eligibleHandoff).toBe(false);
    expect(sessionStorage.getItem(REPLAY_HANDOFF_STORAGE_KEY)).toBeNull();

    await capture(successor);
    expect(successor.getSnapshot()).toMatchObject({ continuity: "resumed", snapshotReceived: true,
      reference: { recordingId: reference.recordingId, startedAt: reference.startedAt } });
    expect(successor.getDiagnostics().recoveryDebt).toBe(0);
    const resumedRequests = browserFetch.mock.calls.filter(([path, init]) =>
      String(path).endsWith(`/recordings/${reference.recordingId}/batches`) && JSON.parse(String(init?.body)).sequence === 1);
    expect(resumedRequests).toHaveLength(2);
    expect(resumedRequests[1]![1]!.body).toBe(resumedRequests[0]![1]!.body);
    const state = await inspect();
    expect(state.recordings).toHaveLength(1);
    expect(state.recordings[0]).toMatchObject({ recordingId: reference.recordingId, nextSequence: 2, status: "open" });
    expect(state.calls).toMatchObject([
      { sequence: 0, status: 200 },
      { sequence: 1, types: [4, 2], status: "lost_receipt", final: false },
      { sequence: 1, types: [4, 2], status: 200, final: false },
    ]);
    await PostDB(db, schema, { replay_recording: [{ status: "open" }] });
  }, 30_000);
});
