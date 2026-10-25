import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { registrationBody } from "./replay-relay.fixture";
import { createSyntheticBrowserFetch, createSyntheticEpi210 } from "./synthetic-epi210.core";

describe("bounded synthetic central state", () => {
  it("bounds new recordings and receipts while preserving immutable retries", async () => {
    const fixture = createSyntheticEpi210({ maxRecordings: 1, maxReceipts: 1,
      fingerprint: (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex") });
    const browser = createSyntheticBrowserFetch(fixture);
    const send = (path: string, body: unknown) => browser.fetch(`/api/epic/replay${path}`, { method: "POST", body: JSON.stringify(body) });
    const intent = registrationBody();
    const registered = await (await send("/recordings", intent)).json();
    expect((await send("/recordings", intent)).status).toBe(200);
    expect((await send("/recordings", registrationBody())).status).toBe(503);
    const body = { contractVersion: 1, recordingToken: registered.recordingToken, batchId: crypto.randomUUID(), sequence: 0,
      events: [{ type: 4, timestamp: intent.startedAt, data: { href: "/synthetic" } }, { type: 2, timestamp: intent.startedAt, data: { node: {} } }], final: false };
    const path = `/recordings/${registered.recordingId}/batches`;
    const receipt = await (await send(path, body)).json();
    expect(receipt.nextSequence).toBe(1);
    expect(await (await send(path, body)).json()).toEqual(receipt);
    expect((await send(path, { ...body, batchId: crypto.randomUUID(), sequence: 1 })).status).toBe(503);
    expect(fixture.providerAppends).toHaveLength(1);
    expect(fixture.recordings()[0]!.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("exposes deterministic advanced-cursor and closed-append faults without reopening", async () => {
    const fixture = createSyntheticEpi210();
    const browser = createSyntheticBrowserFetch(fixture);
    const intent = registrationBody();
    const registered = await (await browser.fetch("/api/epic/replay/recordings", { body: JSON.stringify(intent) })).json();
    expect(fixture.advanceCursor(registered.recordingId)).toBe(true);
    const retried = await (await browser.fetch("/api/epic/replay/recordings", { body: JSON.stringify(intent) })).json();
    expect(retried).toMatchObject({ recordingId: registered.recordingId, startedAt: intent.startedAt, nextSequence: 1 });
    fixture.closeRecording(registered.recordingId);
    const answer = fixture.central(`/api/replay/v1/recordings/${registered.recordingId}/batches`, {
      contractVersion: 1, subjectId: fixture.recordings()[0]!.subjectId, recordingToken: retried.recordingToken,
      batchId: crypto.randomUUID(), sequence: 1, events: [], final: true,
    });
    expect(answer).toMatchObject({ status: 409, body: { code: "recording_closed" } });
    expect(fixture.providerAppends).toHaveLength(0);
  });
});
