// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: vi.fn(), cookies: vi.fn() }));

import { db } from "@/db";
import * as schema from "@/db/schema";
import { PreDB } from "@/lib/db-test";
import { epicReplayConsent } from "@/lib/replay/replay-consent";
import { replayLifecycle } from "@/lib/replay/replay-lifecycle";
import { clearEpicEnv } from "@/lib/replay/tests/runtime-config.fixture";
import { replayRequest, routeParams, signUp } from "@/lib/replay/tests/replay-route.fixture";
import { resetPreviewReplayUpload, usePreviewReplayUpload } from "../use-preview-replay-upload.hook";

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
  });
}

// Real sign-up hashing, routes and recorder: generous under a loaded machine.
describe("usePreviewReplayUpload", { timeout: 30_000 }, () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/styleguide/replay/upload");
    window.sessionStorage.clear();
    document.body.innerHTML = '<main><p data-mask>Synthetic SSN 000-12-3456</p><input id="harness-input"></main>';
  });

  afterEach(() => {
    resetPreviewReplayUpload();
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
    expect(log[0]).toMatchObject({ path: "/recordings", status: 201 });
    const batches = log.filter((entry) => entry.path.endsWith("/batches"));
    expect(batches.map((entry) => entry.sequence)).toEqual([0, 1]);
    expect(batches[0]!.firstEventTypes).toEqual([4, 2]);
    for (const entry of log) {
      expect(entry.bodyKeys).not.toContain("subjectId");
      expect(entry.bodyKeys).not.toContain("projectId");
    }
    expect(JSON.stringify(result.current.state)).not.toMatch(/playable|ready/i);
  });

  it("reports the real relay's not_configured with an empty buffer when EPIC_* is unset", async () => {
    clearEpicEnv();
    await PreDB(db, schema, { user: [], account: [], session: [], replay_recording: [], replay_rate_limit: [] });
    const { cookie } = await signUp("user1@example.com");
    const { POST: register } = await import("@/app/api/epic/replay/recordings/route");
    const { POST: renew } = await import("@/app/api/epic/replay/recordings/[recordingId]/capability/route");
    const { POST: upload } = await import("@/app/api/epic/replay/recordings/[recordingId]/batches/route");
    // Only the browser's network transport is replaced: requests reach the real routes.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input).replace("/api/epic/replay", "");
        const request = replayRequest(path, { body: init?.body as string, cookie });
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
    await vi.waitFor(() => expect(result.current.state.pipeline.upload.status).toBe("unavailable"));

    expect(result.current.state).toMatchObject({ target: "application", policySource: "harness" });
    expect(result.current.state.pipeline.upload).toMatchObject({
      reason: "not_configured",
      current: null,
      bufferedEvents: 0,
    });

    await act(() => result.current.sendForgedRequests());
    expect(result.current.state.forged.map(({ status, code }) => [status, code])).toEqual([
      [400, "invalid_request"],
      [503, "not_configured"],
      [503, "not_configured"],
    ]);
  });
});
