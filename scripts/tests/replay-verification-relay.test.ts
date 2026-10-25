import { afterEach, describe, expect, it, vi } from "vitest";
import { createReplayVerificationRelay, startReplayVerificationRelay, SYNTHETIC_RELAY_MAX_MARKERS, SYNTHETIC_RELAY_TOKEN } from "../replay-verification-relay";
import { registrationBody } from "../../lib/replay/tests/replay-relay.fixture";
import { REPLAY_RECORDING_LIMITS } from "../../lib/replay/replay-config.contract";

function setup() {
  const relay = createReplayVerificationRelay();
  const send = (path: string, body?: unknown, overrides: RequestInit = {}) => relay.handle(new Request(`http://localhost:4319${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${SYNTHETIC_RELAY_TOKEN}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...overrides,
  }));
  const register = async () => {
    const { viewport, ...intent } = registrationBody();
    const payload = { ...intent, subjectId: "sub_synthetic-account-one", captureContext: {
      browser: { name: "Unknown", majorVersion: null }, os: { name: "Unknown", majorVersion: null }, deviceClass: "unknown", viewport,
    } };
    const result = await send("/api/replay/v1/recordings", payload);
    return { capability: await result!.json(), payload };
  };
  return { relay, send, register };
}

describe("synthetic loopback verification relay", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("survives independent document clients and keeps only bounded metadata diagnostics", async () => {
    const { send, register } = setup();
    const { capability, payload } = await register();
    const path = `/api/replay/v1/recordings/${capability.recordingId}/batches`;
    const batch = { contractVersion: 1, subjectId: payload.subjectId, recordingToken: capability.recordingToken,
      batchId: crypto.randomUUID(), sequence: 0, final: false,
      events: [{ type: 4, timestamp: payload.startedAt, data: { href: "/synthetic" } },
        { type: 2, timestamp: payload.startedAt, data: { privateSyntheticText: "never-in-diagnostics" } }],
    };
    expect((await send(path, batch))!.status).toBe(200);
    const successor = await (await send("/api/replay/v1/recordings", payload))!.json();
    expect(successor).toMatchObject({ recordingId: capability.recordingId, startedAt: payload.startedAt, nextSequence: 1 });
    const diagnostic = await (await send("/__synthetic/state"))!.text();
    for (const forbidden of [payload.subjectId, capability.recordingToken, successor.recordingToken, "never-in-diagnostics", "captureContext"])
      expect(diagnostic).not.toContain(forbidden);
    expect(JSON.parse(diagnostic)).toMatchObject({ synthetic: true,
      recordings: [{ subject: "subject-1", recordingId: capability.recordingId, nextSequence: 1, status: "open" }],
      calls: [{ types: [4, 2], sequence: 0, final: false, status: 200 }],
    });
    const policy = await (await send("/api/replay/v1/runtime-config"))!.json();
    expect(policy.capture).toMatchObject({ sessionSampleRate: 1,
      routes: { include: ["/styleguide/replay/*", "/auth/signin"] }, privacy: { maskAllInputs: true } });
  });

  it("recovers a lost immutable receipt once and enforces advanced/closed append controls", async () => {
    const { send, register } = setup();
    const { capability, payload } = await register();
    const path = `/api/replay/v1/recordings/${capability.recordingId}/batches`;
    const batch = { contractVersion: 1, subjectId: payload.subjectId, recordingToken: capability.recordingToken,
      batchId: crypto.randomUUID(), sequence: 0, final: false,
      events: [{ type: 4, timestamp: payload.startedAt, data: {} }, { type: 2, timestamp: payload.startedAt, data: {} }] };
    await send("/__synthetic/control", { mode: "lose_next_receipt" });
    expect(await send(path, batch)).toBeNull();
    const receipt = await (await send(path, batch))!.json();
    expect(receipt).toMatchObject({ nextSequence: 1, batchId: batch.batchId });
    expect((await send(path, { ...batch, events: [] }))!.status).toBe(409);
    await send("/__synthetic/control", { mode: "advanced_cursor_next_retry" });
    expect(await (await send("/api/replay/v1/recordings", payload))!.json()).toMatchObject({ nextSequence: 2 });
    await send("/__synthetic/control", { mode: "close_next_append" });
    const closed = await send(path, { ...batch, batchId: crypto.randomUUID(), sequence: 2 });
    expect(await closed!.json()).toMatchObject({ code: "recording_closed" });
    expect((await send("/api/replay/v1/recordings", payload))!.status).toBe(409);
  });

  it("summarizes only safe committed markers in original milliseconds and deduplicates receipt retries after eviction", async () => {
    const { send, register } = setup();
    const { capability, payload } = await register();
    const path = `/api/replay/v1/recordings/${capability.recordingId}/batches`;
    const occurrenceId = crypto.randomUUID();
    const marker = (offsetMs: number, context: Record<string, unknown> = {}) => ({ type: 5,
      timestamp: payload.startedAt + offsetMs, data: { tag: "epic.behavior.started",
        payload: { version: 1, behaviorId: "synthetic-operation", occurrenceId, ...context } } });
    const batch = { contractVersion: 1, subjectId: payload.subjectId, recordingToken: capability.recordingToken,
      batchId: crypto.randomUUID(), sequence: 0, final: false,
      events: [
        { type: 4, timestamp: payload.startedAt, data: {} },
        { type: 2, timestamp: payload.startedAt, data: {} },
        marker(1_234, { message: "never-keep-message", reportText: "never-keep-report", token: "never-keep-token" }),
        marker(1_235, { version: 99 }),
        marker(1_236, { behaviorId: "oversized-secret".repeat(200) }),
        marker(-1),
        { type: 5, timestamp: payload.startedAt + 1_237, data: { tag: "unrelated-secret-tag", payload: { value: "never-keep-custom" } } },
      ],
    };

    await send("/__synthetic/control", { mode: "lose_next_receipt" });
    expect(await send(path, batch)).toBeNull();
    const read = async () => await (await send("/__synthetic/state"))!.json();
    const first = await read();
    expect(first.markers).toEqual([{ recordingId: capability.recordingId, batchId: batch.batchId,
      sequence: 0, eventIndex: 2, timestamp: payload.startedAt + 1_234, startedAt: payload.startedAt,
      offsetMs: 1_234, tag: "epic.behavior.started", payload: { version: 1, behaviorId: "synthetic-operation", occurrenceId } }]);
    expect((await send(path, batch))!.status).toBe(200);
    expect((await read()).markers).toEqual(first.markers);
    for (const secret of [payload.subjectId, capability.recordingToken, "never-keep-", "oversized-secret", "unrelated-secret-tag"])
      expect(JSON.stringify(first)).not.toContain(secret);

    const later = { ...batch, batchId: crypto.randomUUID(), sequence: 1,
      events: Array.from({ length: SYNTHETIC_RELAY_MAX_MARKERS + 5 }, (_, index) => marker(2_000 + index, { occurrenceId: crypto.randomUUID() })) };
    expect((await send(path, { ...later, subjectId: "sub_wrong-owner" }))!.status).toBe(403);
    expect((await read()).markers).toEqual(first.markers);
    expect((await send(path, later))!.status).toBe(200);
    const bounded = await read();
    expect(bounded.markers).toHaveLength(SYNTHETIC_RELAY_MAX_MARKERS);
    expect(bounded.markers[0]).toMatchObject({ batchId: later.batchId, eventIndex: 5, offsetMs: 2_005 });
    expect(bounded.limits.markers).toBe(SYNTHETIC_RELAY_MAX_MARKERS);

    // The first receipt remains committed even when every one of its summaries
    // has left the ring. An old retry cannot resurrect the evicted marker.
    expect((await send(path, batch))!.status).toBe(200);
    expect((await read()).markers).toEqual(bounded.markers);

    const other = await register();
    const otherPath = `/api/replay/v1/recordings/${other.capability.recordingId}/batches`;
    expect((await send(otherPath, { ...later, subjectId: other.payload.subjectId,
      recordingToken: other.capability.recordingToken, batchId: crypto.randomUUID(), sequence: 0,
      events: later.events.slice(0, 30) }))!.status).toBe(200);
    const shared = await read();
    expect(shared.markers).toHaveLength(SYNTHETIC_RELAY_MAX_MARKERS);
    expect(shared.markers.filter((item: { recordingId: string }) => item.recordingId === capability.recordingId)).toHaveLength(20);
    expect(shared.markers.filter((item: { recordingId: string }) => item.recordingId === other.capability.recordingId)).toHaveLength(30);
  });

  it("rejects ownership/shape faults, foreign origins, credentials, and oversized bodies", async () => {
    const { relay, send, register } = setup();
    expect((await relay.handle(new Request("http://remote.example/__synthetic/state")))!.status).toBe(403);
    expect((await send("/__synthetic/state", undefined, { headers: { origin: "http://localhost:8080", authorization: `Bearer ${SYNTHETIC_RELAY_TOKEN}` } }))!.status).toBe(403);
    expect((await send("/__synthetic/state", undefined, { headers: { authorization: "Bearer real-credential-is-never-accepted" } }))!.status).toBe(401);
    expect((await send("/__synthetic/control", { mode: "accept", production: true }))!.status).toBe(422);
    expect((await send("/api/replay/v1/recordings", "x".repeat(REPLAY_RECORDING_LIMITS.maxBatchBytes)))!.status).toBe(413);
    const { capability, payload } = await register();
    const path = `/api/replay/v1/recordings/${capability.recordingId}/batches`;
    const batch = { contractVersion: 1, subjectId: "sub_other", recordingToken: capability.recordingToken,
      batchId: crypto.randomUUID(), sequence: 0, events: [], final: true };
    expect(await (await send(path, batch))!.json()).toMatchObject({ code: "subject_mismatch" });
    expect((await send(path, { ...batch, subjectId: payload.subjectId, unexpected: "forged" }))!.status).toBe(422);
    expect((await send(path, { ...batch, events: "invalid" }))!.status).toBe(422);
    const finalized = await (await send(path, { ...batch, subjectId: payload.subjectId }))!.json();
    expect(finalized).toMatchObject({ delivery: "finalized", availability: "waiting_for_events" });
  });

  it("binds only loopback and shuts down without touching the application preview", async () => {
    const relay = await startReplayVerificationRelay({ port: 0, lifetimeMs: 10_000 });
    try {
      const result = await fetch(`http://127.0.0.1:${relay.port}/__synthetic/state`, {
        headers: { authorization: `Bearer ${SYNTHETIC_RELAY_TOKEN}` },
      });
      expect(result.headers.get("X-Replay-Fixture")).toBe("synthetic-local-only");
      expect(await result.json()).toMatchObject({ synthetic: true, recordings: [] });
    } finally { await relay.close(); }
    vi.stubEnv("NODE_ENV", "production");
    await expect(startReplayVerificationRelay({ port: 0 })).rejects.toThrow("cannot run in production");
  });
});
