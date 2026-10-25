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
import { epicReplayConsent } from "../replay-consent";
import { deriveReplaySubject } from "../server/replay-subject";
import type { ReplayFetch } from "../replay-upload-contract";
import { replayRequest, routeParams, signUp } from "./replay-route.fixture";

describe("cross-tab attribution through real replay routes", () => {
  const runtimes: ReturnType<typeof createReplayRootRuntime>[] = [];
  beforeEach(async () => {
    await PreDB(db, schema, { user: [], account: [], session: [], replay_recording: [], replay_rate_limit: [] });
    sessionStorage.clear();
    window.history.replaceState({}, "", "/styleguide/replay/upload");
  });
  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.dispose();
    epicReplayConsent.reset();
    vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  });

  it("drops old queues on cross-tab invalidation and registers distinct new-subject streams", async () => {
    const one = await signUp("cross-tab-one@example.test");
    const two = await signUp("cross-tab-two@example.test");
    let cookie = one.cookie;
    const relay = createReplayVerificationRelay();
    vi.stubEnv("EPIC_API_URL", "http://localhost:4319");
    vi.stubEnv("EPIC_PROJECT_ID", SYNTHETIC_RELAY_PROJECT);
    vi.stubEnv("EPIC_PUBLISHING_TOKEN", SYNTHETIC_RELAY_TOKEN);
    vi.stubEnv("EPIC_ENVIRONMENT", "development");
    const central: ReplayFetch = async (input, init) => {
      const response = await relay.handle(new Request(String(input), init));
      if (!response) throw new TypeError("Synthetic lost response");
      return response;
    };
    vi.stubGlobal("fetch", central);
    const policy = await (await readPolicy()).json();
    expect(policy.status).toBe("active");
    const browser: ReplayFetch = async (input, init) => {
      const path = String(input).replace("/api/epic/replay", "");
      const request = replayRequest(path, { cookie, body: JSON.parse(String(init?.body)) });
      if (path === "/identity") return init?.method === "DELETE" ? resetIdentity(request) : establish(request);
      if (path === "/recordings") return register(request);
      const match = /^\/recordings\/([^/]+)\/(batches|capability)$/.exec(path);
      if (!match) throw new Error("Unexpected browser request");
      return match[2] === "batches" ? upload(request, routeParams(match[1]!)) : renew(request, routeParams(match[1]!));
    };
    const inspect = async () => (await (await central("http://localhost:4319/__synthetic/state", {
      headers: { authorization: `Bearer ${SYNTHETIC_RELAY_TOKEN}` },
    })).json()) as { recordings: { recordingId: string; subject: string }[]; calls: { recordingId: string; sequence: number }[] };
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const documents = [0, 1].map(() => {
      let emit!: (event: eventWithTime) => void;
      const record = ((options?: { emit?: (event: eventWithTime) => void }) => {
        emit = options!.emit!;
        emit({ type: 4, timestamp: Date.now(), data: { href: location.href, width: 100, height: 100 } } as eventWithTime);
        emit({ type: 2, timestamp: Date.now(), data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { left: 0, top: 0 } } } as unknown as eventWithTime);
        return () => {};
      }) as typeof rrwebRecord;
      const runtime = createReplayRootRuntime({ documentRelease: "synthetic-build-A", getPolicy: () => policy,
        subscribePolicy: () => () => {}, fetch: browser, pipelineOptions: { record },
        loadPipeline: async () => ({ createReplayRecordingPipeline }), owners: createReplayDocumentOwners(),
        locks: null, monotonicNow: Date.now, navigation: { type: "navigate", opener: false },
      });
      runtimes.push(runtime); runtime.setIdentity(one.userId); runtime.attach();
      return { runtime, emit: () => emit };
    });
    epicReplayConsent.grant();
    const waitForSnapshots = () => vi.waitFor(() => {
      for (const { runtime } of documents) expect(runtime.getSnapshot().snapshotReceived).toBe(true);
    }, { timeout: 11_000, interval: 100 });
    await waitForSnapshots();
    const original = documents.map(({ runtime }) => runtime.getSnapshot().reference!.recordingId);
    expect(new Set(original).size).toBe(2);
    const staleEmitters = documents.map((document) => document.emit());
    const mutation = () => ({ type: 3, timestamp: Date.now(), data: { source: 0, adds: [], removes: [], texts: [], attributes: [] } }) as eventWithTime;
    staleEmitters.forEach((emit) => emit(mutation()));
    expect(documents.every(({ runtime }) => runtime.getDiagnostics().pipeline!.upload.bufferedEvents > 0)).toBe(true);

    // The provider/BroadcastChannel test owns invalidation delivery. Here two
    // independent document runtimes follow the source auth barrier, shared
    // cookie switch and remote invalidation. Broadcast delivery is not a
    // synchronous pre-cookie barrier for another physical tab.
    documents[0]!.runtime.beginIdentityChange();
    cookie = two.cookie;
    documents[1]!.runtime.beginIdentityRevalidation();
    staleEmitters.forEach((emit) => emit(mutation()));
    await vi.advanceTimersByTimeAsync(5_100);
    expect((await inspect()).calls).toHaveLength(2);
    for (const { runtime } of documents) {
      expect(runtime.getSnapshot().reference).toBeNull();
      expect(runtime.getDiagnostics().pipeline!.upload.bufferedEvents).toBe(0);
    }

    documents.forEach(({ runtime }) => runtime.setIdentity(two.userId));
    await waitForSnapshots();
    const current = documents.map(({ runtime }) => runtime.getSnapshot().reference!.recordingId);
    expect(new Set([...original, ...current]).size).toBe(4);
    const state = await inspect();
    expect(state.calls).toHaveLength(4);
    expect(state.calls.every((call) => call.sequence === 0)).toBe(true);
    const byId = new Map(state.recordings.map((row) => [row.recordingId, row.subject]));
    expect(original.map((id) => byId.get(id))).toEqual(["subject-1", "subject-1"]);
    expect(current.map((id) => byId.get(id))).toEqual(["subject-2", "subject-2"]);
    const subjectOf = (userId: string) => deriveReplaySubject({ kind: "user", userId }, process.env.BETTER_AUTH_SECRET!).subjectId;
    await PostDB(db, schema, { replay_recording: [
      ...original.map((recordingId) => ({ recordingId, subjectId: subjectOf(one.userId), status: "open" })),
      ...current.map((recordingId) => ({ recordingId, subjectId: subjectOf(two.userId), status: "open" })),
    ] });
  }, 25_000);
});
