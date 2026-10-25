// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { epicReplayConsent } from "@/lib/replay/replay-consent";
import { createReplayDocumentOwners } from "@/lib/replay/replay-document-owner";
import { createReplayRecordingPipeline } from "@/lib/replay/replay-recording-pipeline";
import { createReplayRootRuntime, type ReplayRootRuntime } from "@/lib/replay/replay-root-runtime";
import { activeReplayPolicy } from "@/lib/replay/tests/replay-policy.fixture";
import { createSyntheticBrowserFetch, createSyntheticEpi210 } from "@/lib/replay/tests/synthetic-epi210.core";
import { EpicReplayContext, useEpicReplay, useEpicReplayDiagnostics } from "../use-epic-replay.hook";

describe("useEpicReplay marker controls", () => {
  let runtime: ReplayRootRuntime | undefined;
  afterEach(() => {
    cleanup(); runtime?.dispose(); runtime = undefined;
    epicReplayConsent.reset(); vi.useRealTimers(); vi.restoreAllMocks();
  });

  it("returns harmless defaults through SSR and without a provider, without reading the payload", () => {
    const payload = new Proxy({}, { get() { throw new Error("must not inspect disabled input"); } });
    function Readout() {
      const replay = useEpicReplay();
      return <span>{replay.track(payload).status}:{String(replay.getEvidenceReference())}</span>;
    }
    expect(renderToString(<Readout />)).toContain("dropped");
    const { result } = renderHook(useEpicReplay);
    expect(result.current.track(payload)).toEqual({ status: "dropped", reason: "provider_unavailable" });
    expect(result.current.getEvidenceReference()).toBeNull();
    expect(result.current.trackAcknowledgedReport(payload, null as never)).toEqual({ status: "dropped", reason: "provider_unavailable" });
  });

  it("keeps ordinary controls stable while actual recorded markers update only private diagnostics", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
    window.history.replaceState({}, "", "/styleguide/replay/upload");
    sessionStorage.clear();
    const policy = activeReplayPolicy();
    const fixture = createSyntheticBrowserFetch(createSyntheticEpi210());
    runtime = createReplayRootRuntime({ documentRelease: "build-A", getPolicy: () => policy,
      subscribePolicy: () => () => {}, fetch: fixture.fetch, owners: createReplayDocumentOwners(),
      sampler: { decide: () => true }, locks: null, loadPipeline: async () => ({ createReplayRecordingPipeline }),
    });
    const root = runtime;
    const wrapper = ({ children }: { children: ReactNode }) => <EpicReplayContext.Provider value={root}>{children}</EpicReplayContext.Provider>;
    let renders = 0;
    const ordinary = renderHook(() => { renders++; return useEpicReplay(); }, { wrapper });
    const diagnostics = renderHook(useEpicReplayDiagnostics, { wrapper });
    act(() => { root.setIdentity("synthetic-user-1"); root.attach(); epicReplayConsent.grant(); });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
      for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
    });
    expect(ordinary.result.current.status).toBe("capturing");
    const before = ordinary.result.current;
    const previousRenders = renders;
    const beforeMarkers = diagnostics.result.current?.markers.length ?? 0;
    let result: unknown;
    act(() => { result = ordinary.result.current.track({ tag: "epic.behavior.started", payload: {
      version: 1, behaviorId: "synthetic.example", occurrenceId: crypto.randomUUID(),
    } }); });
    expect(result).toEqual({ status: "emitted" });
    expect(diagnostics.result.current?.markers.length).toBe(beforeMarkers + 1);
    expect(ordinary.result.current).toBe(before);
    expect(renders).toBe(previousRenders);
    const evidence = ordinary.result.current.getEvidenceReference();
    expect(evidence).toMatchObject({ recordingId: ordinary.result.current.reference?.recordingId, release: "build-A" });
    expect(Object.isFrozen(evidence)).toBe(true);
  });
});
