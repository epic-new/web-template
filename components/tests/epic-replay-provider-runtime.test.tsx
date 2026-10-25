// @vitest-environment jsdom
import type { record as rrwebRecord } from "@rrweb/record";
import type { eventWithTime } from "@rrweb/types";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplayRootOptions, ReplayRootRuntime } from "@/lib/replay/replay-root-runtime";
import { createReplayDocumentOwners } from "@/lib/replay/replay-document-owner";
import { createReplayRecordingPipeline } from "@/lib/replay/replay-recording-pipeline";
import { epicReplayConsent } from "@/lib/replay/replay-consent";
import { replayLifecycle } from "@/lib/replay/replay-lifecycle";
import { activeReplayPolicy } from "@/lib/replay/tests/replay-policy.fixture";
import { createSyntheticBrowserFetch, createSyntheticEpi210 } from "@/lib/replay/tests/synthetic-epi210.core";
import { EpicReplayProvider } from "../epic-replay-provider";
import { useEpicReplay } from "@/shared/hooks/use-epic-replay.hook";

const auth = vi.hoisted(() => ({
  session: { isPending: false, error: null as unknown, data: { user: { id: "user-1" } } as { user: { id: string } } | null },
  getSession: vi.fn(),
}));
vi.mock("@/lib/auth/client", () => ({ authClient: { useSession: () => auth.session, getSession: auth.getSession } }));
// Policy fetching is a public hook boundary; the runtime still reads the real
// synchronous lifecycle store, including its expiry and consent gates.
vi.mock("@/app/api/epic/replay/config/behaviors/refresh-replay-policy/use-refresh-replay-policy.hook", () => ({ useRefreshReplayPolicy: () => {} }));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function Readout() {
  const replay = useEpicReplay();
  return <output aria-label="Replay state">{replay.status}:{replay.reason}:{replay.reference?.recordingId ?? "none"}</output>;
}

describe("provider import and cross-tab boundaries through the real runtime", () => {
  const runtimes: ReplayRootRuntime[] = [];
  let releaseImport: () => void;
  let browser: ReturnType<typeof createSyntheticBrowserFetch>;
  let record: ReturnType<typeof vi.fn>;
  let callbacks: ((event: eventWithTime) => void)[];
  const channels: { onmessage: ((event: MessageEvent) => void) | null; postMessage: ReturnType<typeof vi.fn> }[] = [];

  beforeEach(() => {
    Reflect.deleteProperty(globalThis, Symbol.for("epic.replay.document-hosts.v1"));
    window.history.replaceState({}, "", "/styleguide/replay/upload");
    sessionStorage.clear();
    replayLifecycle.reset();
    replayLifecycle.apply(activeReplayPolicy());
    epicReplayConsent.reset();
    epicReplayConsent.grant();
    auth.session = { isPending: false, error: null, data: { user: { id: "user-1" } } };
    auth.getSession.mockReset().mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    callbacks = [];
    channels.length = 0;
    vi.stubGlobal("BroadcastChannel", class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      postMessage = vi.fn();
      constructor() { channels.push(this); }
      close() {}
    });
    browser = createSyntheticBrowserFetch(createSyntheticEpi210());
    record = vi.fn((options?: { emit?: (event: eventWithTime) => void }) => {
      const emit = options?.emit;
      if (emit) callbacks.push(emit);
      emit?.({ type: 4, timestamp: Date.now(), data: { href: location.href, width: 100, height: 100 } } as eventWithTime);
      emit?.({ type: 2, timestamp: Date.now(), data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { left: 0, top: 0 } } } as unknown as eventWithTime);
      return () => {};
    });
    const gate = deferred<void>();
    releaseImport = () => gate.resolve();
    // Delay only module delivery. Once delivered, use the real manager,
    // capture, pipeline and uploader; the recorder and HTTP peer are external.
    vi.doMock("@/lib/replay/replay-root-runtime", async (importOriginal) => {
      await gate.promise;
      const actual = await importOriginal<typeof import("@/lib/replay/replay-root-runtime")>();
      return { ...actual, createReplayRootRuntime: (options: ReplayRootOptions) => {
        const runtime = actual.createReplayRootRuntime({ ...options, fetch: browser.fetch,
          loadPipeline: async () => ({ createReplayRecordingPipeline }),
          pipelineOptions: { record: record as unknown as typeof rrwebRecord },
          owners: createReplayDocumentOwners(), locks: null,
        });
        runtimes.push(runtime);
        return runtime;
      } };
    });
  });
  afterEach(() => {
    cleanup();
    for (const runtime of runtimes.splice(0)) runtime.dispose();
    replayLifecycle.reset(); epicReplayConsent.reset();
    vi.doUnmock("@/lib/replay/replay-root-runtime");
    vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  });

  it.each(["consent", "route", "policy", "auth_error", "account_pending", "unmount"] as const)(
    "cannot capture after %s revocation while the lightweight runtime import is pending", async (gate) => {
      const view = render(<EpicReplayProvider documentRelease="build-A"><input aria-label="Usable app" /><Readout /></EpicReplayProvider>);
      expect(record).not.toHaveBeenCalled();
      expect(browser.log).toHaveLength(0);
      act(() => {
        if (gate === "consent") epicReplayConsent.withdraw();
        if (gate === "route") window.history.pushState({}, "", "/excluded");
        if (gate === "policy") replayLifecycle.gate();
        if (gate === "auth_error") auth.session = { ...auth.session, error: new Error("Session unavailable") };
        if (gate === "account_pending") auth.session = { ...auth.session, isPending: true };
      });
      if (gate === "unmount") view.unmount();
      else view.rerender(<EpicReplayProvider documentRelease="build-A"><input aria-label="Usable app" /><Readout /></EpicReplayProvider>);
      await act(async () => { releaseImport(); });
      if (gate !== "unmount") await waitFor(() => expect(runtimes).toHaveLength(1));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
      expect(record).not.toHaveBeenCalled();
      expect(browser.log).toHaveLength(0);
      if (gate !== "unmount") {
        expect(runtimes[0]!.getSnapshot().reference).toBeNull();
        expect(screen.getByLabelText("Usable app")).toBeInTheDocument();
      }
    },
  );

  it("stops the old producer on cross-tab invalidation and waits for the new acknowledged account", async () => {
    const session = deferred<{ data: { user: { id: string } }; error: null }>();
    auth.getSession.mockReturnValue(session.promise);
    render(<EpicReplayProvider documentRelease="build-A"><input aria-label="Usable app" /><Readout /></EpicReplayProvider>);
    await act(async () => { releaseImport(); });
    await waitFor(() => {
      expect(runtimes).toHaveLength(1);
      expect(runtimes[0]!.getSnapshot().reference).not.toBeNull();
    });
    const runtime = runtimes[0]!;
    const first = runtime.getSnapshot().reference!;
    const oldCallback = callbacks[0]!;
    // BroadcastChannel delivery is the browser boundary. It contains no user,
    // session, cookie or token; the host must resolve identity independently.
    act(() => { channels[0]!.onmessage!(new MessageEvent("message", { data: { type: "identity-invalidated" } })); });
    expect(runtime.getSnapshot()).toMatchObject({ status: "waiting", reason: "identity_pending", reference: null });
    const requestsWhilePaused = browser.log.length;
    act(() => { oldCallback({ type: 5, timestamp: Date.now(), data: { tag: "stale-producer", payload: {} } } as eventWithTime); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(browser.log).toHaveLength(requestsWhilePaused);
    expect(record).toHaveBeenCalledTimes(1);
    await act(async () => { session.resolve({ data: { user: { id: "user-2" } }, error: null }); });
    await waitFor(() => {
      expect(runtime.getSnapshot().status).toBe("capturing");
      expect(runtime.getSnapshot().reference).not.toBeNull();
      expect(runtime.getSnapshot().reference?.recordingId).not.toBe(first.recordingId);
    });
    expect(runtime.getSnapshot().reference).not.toBeNull();
    expect(browser.log.filter((entry) => entry.path === "/recordings")).toHaveLength(2);
    expect(record).toHaveBeenCalledTimes(2);
    act(() => { oldCallback({ type: 5, timestamp: Date.now(), data: { tag: "stale-after-switch", payload: {} } } as eventWithTime); });
    await waitFor(() => expect(runtime.getSnapshot().snapshotReceived).toBe(true), { timeout: 6_500 });
    expect(browser.log.filter((entry) => entry.path.endsWith("/batches"))).toMatchObject([
      { recordingId: runtime.getSnapshot().reference!.recordingId, sequence: 0, eventCount: 2, firstEventTypes: [4, 2] },
    ]);
    expect(screen.getByLabelText("Usable app")).toBeInTheDocument();
  }, 10_000);
});
