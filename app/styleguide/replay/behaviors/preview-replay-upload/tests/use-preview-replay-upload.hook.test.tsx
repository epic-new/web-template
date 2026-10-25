// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: vi.fn(), cookies: vi.fn() }));

import { db } from "@/db";
import * as schema from "@/db/schema";
import { PreDB } from "@/lib/db-test";
import { epicReplayConsent } from "@/lib/replay/replay-consent";
import { replayLifecycle } from "@/lib/replay/replay-lifecycle";
import { createReplayRootRuntime, type ReplayRootRuntime } from "@/lib/replay/replay-root-runtime";
import { createReplayRecordingPipeline } from "@/lib/replay/replay-recording-pipeline";
import { activeReplayPolicy } from "@/lib/replay/tests/replay-policy.fixture";
import { createSyntheticBrowserFetch, createSyntheticEpi210 } from "@/lib/replay/tests/synthetic-epi210.core";
import { EpicReplayContext } from "@/shared/hooks/use-epic-replay.hook";
import { replayDocumentOwners } from "@/lib/replay/replay-document-owner";
import { beginReplayIdentityBoundary } from "@/lib/replay/replay-identity";
import { clearEpicEnv } from "@/lib/replay/tests/runtime-config.fixture";
import { replayRequest, routeParams, signUp } from "@/lib/replay/tests/replay-route.fixture";
import { resetPreviewReplayUpload, usePreviewReplayUpload, usePreviewReplayUploadControls } from "../use-preview-replay-upload.hook";

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
  });
}

// Real sign-up hashing, routes and recorder: generous under a loaded machine.
describe("usePreviewReplayUpload", { timeout: 30_000 }, () => {
  let runtime: ReplayRootRuntime | null = null;
  beforeEach(() => {
    window.history.replaceState({}, "", "/styleguide/replay/upload");
    window.sessionStorage.clear();
    document.body.innerHTML = '<main><p data-mask>Synthetic SSN 000-12-3456</p><input id="harness-input"></main>';
  });

  afterEach(() => {
    cleanup();
    resetPreviewReplayUpload();
    runtime?.dispose(); runtime = null;
    epicReplayConsent.reset();
    replayLifecycle.reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("registers, then uploads ordered batches to the synthetic fixture with unverified evidence", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    const { result } = renderHook(() => usePreviewReplayUpload());

    act(() => {
      result.current.setTarget("synthetic");
      epicReplayConsent.grant();
      result.current.start();
    });
    await settle();
    expect(result.current.state.pipeline.upload).toMatchObject({ status: "registered", evidence: "unverified" });
    const reference = result.current.state.pipeline.upload.current!;
    expect(reference.startedAt).toBeGreaterThan(0);

    await settle(5_000);
    act(() => result.current.emitCustomEvent());
    await settle(5_000);

    expect(result.current.state.pipeline.upload).toMatchObject({ status: "pending", evidence: "unverified" });
    const log = result.current.log;
    expect(log.find((entry) => entry.path === "/recordings")).toMatchObject({ path: "/recordings", status: 201 });
    const batches = log.filter((entry) => entry.path.endsWith("/batches"));
    expect(batches.map((entry) => entry.sequence)).toEqual([0, 1]);
    expect(batches[0]!.firstEventTypes).toEqual([4, 2]);
    for (const entry of log) {
      expect(entry.bodyKeys).not.toContain("subjectId");
      expect(entry.bodyKeys).not.toContain("projectId");
    }
    expect(JSON.stringify(result.current.state)).not.toMatch(/playable|ready/i);
  });

  it("keeps an unconfigured application target disabled without synthetic fallback and preserves real forged-route checks", async () => {
    clearEpicEnv();
    await PreDB(db, schema, { user: [], account: [], session: [], replay_recording: [], replay_rate_limit: [] });
    const { cookie } = await signUp("user1@example.com");
    const { POST: identity } = await import("@/app/api/epic/replay/identity/route");
    const { POST: register } = await import("@/app/api/epic/replay/recordings/route");
    const { POST: renew } = await import("@/app/api/epic/replay/recordings/[recordingId]/capability/route");
    const { POST: upload } = await import("@/app/api/epic/replay/recordings/[recordingId]/batches/route");
    // Only the browser's network transport is replaced: requests reach the real routes.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input).replace("/api/epic/replay", "");
        const request = replayRequest(path, { body: init?.body as string, cookie });
        if (path === "/identity") return identity(request);
        const match = /^\/recordings\/([^/]+)\/(capability|batches)$/.exec(path);
        if (!match) return register(request);
        return match[2] === "capability" ? renew(request, routeParams(match[1]!)) : upload(request, routeParams(match[1]!));
      }),
    );

    const { result } = renderHook(() => usePreviewReplayUpload());
    act(() => {
      epicReplayConsent.grant();
      result.current.start();
    });
    expect(result.current.state).toMatchObject({ target: "application", policySource: "application", provider: { status: "disabled", reason: "provider_unavailable" } });
    expect(result.current.state.pipeline.upload).toMatchObject({
      status: "idle",
      current: null,
      bufferedEvents: 0,
    });
    expect(fetch).not.toHaveBeenCalled();
    act(() => { result.current.runSuccessfulExample(); });
    expect(result.current.state.example).toMatchObject({ outcome: "succeeded", value: 10,
      started: { status: "dropped", reason: "provider_unavailable" }, completed: { status: "dropped", reason: "provider_unavailable" } });
    act(() => { result.current.runFailedExample(); result.current.freezeEvidence(); });
    expect(result.current.state.example).toMatchObject({ outcome: "failed", value: null });
    expect(result.current.state.frozenEvidence).toBeNull();
    expect(result.current.state.markers).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();

    await act(() => result.current.sendForgedRequests());
    expect(result.current.state.forged.map(({ status, code }) => [status, code])).toEqual([
      [400, "invalid_request"],
      [503, "not_configured"],
      [503, "not_configured"],
    ]);
  });

  it("captures successful and failed local occurrences and keeps frozen evidence across restart", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    const { result } = renderHook(() => usePreviewReplayUpload());
    act(() => { result.current.setTarget("synthetic"); epicReplayConsent.grant(); result.current.start(); });
    await settle(5_000);
    act(() => { result.current.runSuccessfulExample(); });
    expect(result.current.state.example).toMatchObject({ outcome: "succeeded", value: 10,
      started: { status: "emitted" }, completed: { status: "emitted" } });
    const success = result.current.state.example!;
    act(() => { result.current.runFailedExample(); result.current.freezeEvidence(); });
    expect(result.current.state.example).toMatchObject({ outcome: "failed", value: null,
      started: { status: "emitted" }, completed: { status: "emitted" } });
    const failed = result.current.state.example!;
    expect(success.occurrenceId).not.toBe(failed.occurrenceId);
    expect(result.current.state.markers.filter((marker) => marker.tag.startsWith("epic.behavior.")).map((marker) => ({ tag: marker.tag, payload: marker.payload })))
      .toEqual([
        { tag: "epic.behavior.started", payload: { version: 1, behaviorId: "synthetic.example", occurrenceId: success.occurrenceId } },
        { tag: "epic.behavior.succeeded", payload: { version: 1, behaviorId: "synthetic.example", occurrenceId: success.occurrenceId } },
        { tag: "epic.behavior.started", payload: { version: 1, behaviorId: "synthetic.example", occurrenceId: failed.occurrenceId } },
        { tag: "epic.behavior.failed", payload: { version: 1, behaviorId: "synthetic.example", occurrenceId: failed.occurrenceId, code: "synthetic.invalid_json" } },
      ]);
    const frozen = result.current.state.frozenEvidence;
    expect(frozen).toMatchObject({ recordingId: result.current.state.pipeline.upload.current?.recordingId, release: null });
    expect(frozen!.offsetMs).toBe(frozen!.capturedAt - frozen!.startedAt);
    expect(Number.isSafeInteger(frozen!.offsetMs)).toBe(true);
    expect(frozen!.offsetMs).toBeGreaterThan(0);
    expect(Object.isFrozen(frozen)).toBe(true);
    await settle(5_000);
    act(() => result.current.restart());
    await settle(5_000);
    expect(result.current.state.frozenEvidence).toBe(frozen);
    expect(result.current.state.pipeline.upload.current?.recordingId).not.toBe(frozen?.recordingId);
    act(() => { epicReplayConsent.withdraw(); result.current.runSuccessfulExample(); });
    expect(result.current.state.example).toMatchObject({ outcome: "succeeded", value: 10, started: { status: "dropped" }, completed: { status: "dropped" } });
    expect(result.current.state.frozenEvidence).toBe(frozen);
  });

  it("uses the one root pipeline for application capture and exclusively displaces it for synthetic capture", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    const fixture = createSyntheticBrowserFetch(createSyntheticEpi210());
    const policy = activeReplayPolicy();
    runtime = createReplayRootRuntime({
      documentRelease: "build-A", fetch: fixture.fetch,
      getPolicy: () => policy, subscribePolicy: () => () => {}, sampler: { decide: () => true },
      locks: null, loadPipeline: async () => ({ createReplayRecordingPipeline }),
    });
    const root = runtime;
    act(() => { root.setIdentity("synthetic-user-1"); root.attach(); });
    const { result } = renderHook(() => usePreviewReplayUpload(), {
      wrapper: ({ children }: { children: ReactNode }) => <EpicReplayContext.Provider value={root}>{children}</EpicReplayContext.Provider>,
    });
    act(() => { epicReplayConsent.grant(); result.current.start(); });
    await settle(5_000);
    expect(result.current.state.pipeline).toBe(root.getDiagnostics().pipeline);
    expect(result.current.state.provider?.reference).toEqual(root.getSnapshot().reference);
    expect(fixture.log.filter((entry) => entry.path === "/recordings")).toHaveLength(1);
    const original = root.getSnapshot().reference;
    expect(original).not.toBeNull();
    act(() => { result.current.setTarget("synthetic"); result.current.start(); });
    await settle(5_000);
    expect(replayDocumentOwners().getOwner()).toBe("harness");
    expect(root.getDiagnostics().pipeline?.capture.status).toBe("blocked");
    expect(result.current.state.pipeline.upload.current?.recordingId).not.toBe(original!.recordingId);
    const applicationRequests = fixture.log.length;
    act(() => result.current.emitCustomEvent());
    await settle(5_000);
    expect(fixture.log).toHaveLength(applicationRequests);
    expect(result.current.state.policySource).toBe("harness");
  });

  it("cancels synthetic identity bootstrap before recorder initialization on withdrawal", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    const { result } = renderHook(() => usePreviewReplayUpload());
    act(() => {
      result.current.setTarget("synthetic");
      epicReplayConsent.grant();
      result.current.start();
      epicReplayConsent.withdraw();
    });
    await settle(10_000);
    expect(result.current.state.pipeline.upload.bufferedEvents).toBe(0);
    expect(result.current.log.filter((entry) => entry.path === "/recordings")).toHaveLength(0);
  });

  it("stops synthetic capture before auth changes and opens a fresh boundary only after settlement", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    const { result } = renderHook(() => usePreviewReplayUpload());
    act(() => { result.current.setTarget("synthetic"); epicReplayConsent.grant(); result.current.start(); });
    await settle(5_000);
    const old = result.current.state.pipeline.upload.current!;
    expect(old).not.toBeNull();
    let finish = () => {};
    act(() => { result.current.emitCustomEvent(); finish = beginReplayIdentityBoundary(); });
    expect(result.current.state.pipeline.capture.status).toBe("blocked");
    expect(result.current.state.pipeline.upload.bufferedEvents).toBe(0);
    act(() => result.current.emitCustomEvent());
    await settle(5_000);
    expect(result.current.log.filter((entry) => entry.path === "/recordings")).toHaveLength(1);
    act(() => finish());
    await settle(5_000);
    expect(result.current.state.pipeline.upload.current?.recordingId).not.toBe(old.recordingId);
    expect(result.current.log.filter((entry) => entry.path === "/recordings")).toHaveLength(2);
  });

  it("keeps the control snapshot stable while the real recorder emits events", async () => {
    window.history.replaceState({}, "", "/styleguide/replay/upload");
    let controlsRenders = 0;
    const controls = renderHook(() => { controlsRenders++; return usePreviewReplayUploadControls(); });
    const readout = renderHook(() => usePreviewReplayUpload());
    act(() => {
      controls.result.current.setTarget("synthetic");
      epicReplayConsent.grant();
      controls.result.current.start();
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const before = controlsRenders;
    const controlSnapshot = controls.result.current.state;
    const beforeReadout = readout.result.current.state;
    act(() => {
      for (let i = 0; i < 20; i++) controls.result.current.emitCustomEvent();
    });
    expect(readout.result.current.state).not.toBe(beforeReadout);
    expect(readout.result.current.state.pipeline.upload.bufferedEvents).toBeGreaterThan(0);
    expect(controls.result.current.state).toBe(controlSnapshot);
    expect(controlsRenders).toBe(before);
  });
});
