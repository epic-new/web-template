// @vitest-environment jsdom
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EpicReplaySnapshot, ReplayRootRuntime } from "@/lib/replay/replay-root-runtime";
import { beginReplayIdentityBoundary } from "@/lib/replay/replay-identity";
import { EpicReplayProvider } from "../epic-replay-provider";
import { EMPTY_EPIC_REPLAY, EpicReplayContext, useEpicReplay, useEpicReplayDiagnostics } from "@/shared/hooks/use-epic-replay.hook";

// The component's public policy hook and framework auth boundary are isolated
// here. Runtime and real Route/Service behavior have their own integration tests.
const boundary = vi.hoisted(() => ({
  session: { isPending: false, error: null as unknown, data: { user: { id: "user-1" } } as { user: { id: string } } | null },
  getSession: vi.fn(), createRuntime: vi.fn(), policy: vi.fn(),
}));
vi.mock("@/lib/auth/client", () => ({ authClient: { useSession: () => boundary.session, getSession: boundary.getSession } }));
vi.mock("@/app/api/epic/replay/config/behaviors/refresh-replay-policy/use-refresh-replay-policy.hook", () => ({ useRefreshReplayPolicy: boundary.policy }));
vi.mock("@/lib/replay/replay-root-runtime", () => ({ createReplayRootRuntime: boundary.createRuntime }));

function fakeRuntime() {
  let state: EpicReplaySnapshot = { ...EMPTY_EPIC_REPLAY, status: "waiting", reason: "consent_unknown" };
  let diagnostics = { pipeline: null, eligibleHandoff: false, recoveryDebt: 0 };
  const listeners = new Set<() => void>();
  const privateListeners = new Set<() => void>();
  let attached = 0;
  let maximum = 0;
  const value = {
    attach: vi.fn(() => { attached++; maximum = Math.max(attached, maximum); return () => { attached--; }; }),
    setIdentity: vi.fn(), beginIdentityChange: vi.fn(), start: vi.fn(), stop: vi.fn(), restart: vi.fn(), dispose: vi.fn(),
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getDiagnostics: () => diagnostics,
    subscribeDiagnostics: (listener: () => void) => { privateListeners.add(listener); return () => { privateListeners.delete(listener); }; },
  };
  return {
    value, runtime: value as unknown as ReplayRootRuntime,
    maximum: () => maximum, attached: () => attached,
    tick: () => { for (const listener of listeners) listener(); diagnostics = { ...diagnostics, recoveryDebt: diagnostics.recoveryDebt + 1 }; for (const listener of privateListeners) listener(); },
    publish: (change: Partial<EpicReplaySnapshot>) => { state = { ...state, ...change }; for (const listener of listeners) listener(); },
  };
}

function Readout() {
  const replay = useEpicReplay();
  return <output aria-label="Replay state">{replay.status}:{replay.reason}</output>;
}

describe("EpicReplayProvider and public hook", () => {
  beforeEach(() => {
    Reflect.deleteProperty(globalThis, Symbol.for("epic.replay.document-hosts.v1"));
    boundary.createRuntime.mockReset();
    boundary.getSession.mockReset();
    boundary.policy.mockClear();
    boundary.session = { isPending: false, error: null, data: { user: { id: "user-1" } } };
    sessionStorage.clear();
  });
  afterEach(() => { cleanup(); Reflect.deleteProperty(document, "visibilityState"); vi.restoreAllMocks(); });

  it("renders children and a harmless stable fallback without a provider or server runtime", () => {
    const { result, rerender } = renderHook(() => useEpicReplay());
    const first = result.current;
    expect(first).toMatchObject({ status: "disabled", reason: "provider_unavailable", reference: null });
    expect(() => { first.start(); first.stop(); first.restart(); }).not.toThrow();
    rerender();
    expect(result.current).toBe(first);
    expect(renderToString(<EpicReplayProvider documentRelease="build-a"><span>Host content</span><Readout /></EpicReplayProvider>))
      .toContain("Host content");
    expect(boundary.createRuntime).not.toHaveBeenCalled();
  });

  it("lazily attaches one owner through StrictMode and retains the document release on remount", async () => {
    const fixture = fakeRuntime();
    boundary.createRuntime.mockReturnValue(fixture.runtime);
    const view = render(<StrictMode><EpicReplayProvider documentRelease="build-a"><span>Application input</span><Readout /></EpicReplayProvider></StrictMode>);
    expect(screen.getByText("Application input")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Replay state")).toHaveTextContent("waiting:consent_unknown"));
    expect(boundary.createRuntime).toHaveBeenCalledTimes(1);
    expect(boundary.createRuntime.mock.calls[0]![0]).toMatchObject({ documentRelease: "build-a" });
    expect(fixture.maximum()).toBe(1);
    expect(fixture.value.setIdentity).toHaveBeenLastCalledWith("user-1");
    view.unmount();
    expect(fixture.attached()).toBe(0);
    render(<EpicReplayProvider documentRelease="build-b"><Readout /></EpicReplayProvider>);
    await waitFor(() => expect(fixture.attached()).toBe(1));
    expect(boundary.createRuntime).toHaveBeenCalledTimes(1);
    expect(fixture.value.dispose).not.toHaveBeenCalled();
  });

  it("cancels a lazy initialization when the root unmounts before import completion", async () => {
    const fixture = fakeRuntime();
    boundary.createRuntime.mockReturnValue(fixture.runtime);
    const view = render(<EpicReplayProvider documentRelease="build-a"><Readout /></EpicReplayProvider>);
    view.unmount();
    await act(async () => { await Promise.resolve(); });
    expect(boundary.createRuntime).not.toHaveBeenCalled();
    expect(fixture.attached()).toBe(0);
  });

  it("keeps ordinary context consumers stable while private event diagnostics update", () => {
    const fixture = fakeRuntime();
    let ordinaryRenders = 0;
    function Ordinary() { ordinaryRenders++; const value = useEpicReplay(); return <span>{value.status}</span>; }
    function Private() { const value = useEpicReplayDiagnostics(); return <output aria-label="Private count" data-private>{value?.recoveryDebt}</output>; }
    render(<EpicReplayContext.Provider value={fixture.runtime}><Ordinary /><Private /></EpicReplayContext.Provider>);
    const initial = ordinaryRenders;
    act(() => { for (let i = 0; i < 50; i++) fixture.tick(); });
    expect(ordinaryRenders).toBe(initial);
    expect(screen.getByLabelText("Private count")).toHaveTextContent("50");
    act(() => fixture.publish({ status: "unavailable", reason: "delivery_uncertain" }));
    expect(ordinaryRenders).toBe(initial + 1);
  });

  it("stops synchronously on identity boundaries and ignores obsolete session responses", async () => {
    const fixture = fakeRuntime();
    boundary.createRuntime.mockReturnValue(fixture.runtime);
    const pending: ((value: { data: { user: { id: string } } | null; error: null }) => void)[] = [];
    boundary.getSession.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
    render(<EpicReplayProvider documentRelease="build-a"><Readout /></EpicReplayProvider>);
    await waitFor(() => expect(fixture.attached()).toBe(1));
    const finishFirst = beginReplayIdentityBoundary();
    expect(fixture.value.beginIdentityChange).toHaveBeenCalledTimes(1);
    finishFirst();
    const finishSecond = beginReplayIdentityBoundary();
    finishSecond();
    expect(boundary.getSession).toHaveBeenCalledTimes(2);
    await act(async () => { pending[0]!({ data: { user: { id: "stale-user" } }, error: null }); });
    expect(fixture.value.setIdentity).not.toHaveBeenCalledWith("stale-user");
    await act(async () => { pending[1]!({ data: { user: { id: "user-2" } }, error: null }); });
    expect(fixture.value.setIdentity).toHaveBeenLastCalledWith("user-2");
  });

  it("gates unresolved and externally changed auth in layout timing without blocking children", async () => {
    const fixture = fakeRuntime();
    boundary.createRuntime.mockReturnValue(fixture.runtime);
    boundary.session = { isPending: true, error: null, data: null };
    const view = render(<EpicReplayProvider documentRelease="build-a"><Readout /></EpicReplayProvider>);
    await waitFor(() => expect(fixture.attached()).toBe(1));
    expect(fixture.value.setIdentity).toHaveBeenLastCalledWith(undefined);
    boundary.session = { isPending: false, error: null, data: null };
    view.rerender(<EpicReplayProvider documentRelease="build-a"><Readout /></EpicReplayProvider>);
    expect(fixture.value.setIdentity).toHaveBeenLastCalledWith(null);
    boundary.session = { isPending: false, error: null, data: { user: { id: "user-2" } } };
    view.rerender(<EpicReplayProvider documentRelease="build-a"><Readout /></EpicReplayProvider>);
    expect(fixture.value.setIdentity).toHaveBeenLastCalledWith("user-2");
    expect(screen.getByLabelText("Replay state")).toBeInTheDocument();
  });

  it("revalidates auth on focus, visibility restoration and BFCache before capture resumes", async () => {
    const fixture = fakeRuntime();
    boundary.createRuntime.mockReturnValue(fixture.runtime);
    boundary.getSession.mockResolvedValue({ data: { user: { id: "user-2" } }, error: null });
    render(<EpicReplayProvider documentRelease="build-a"><Readout /></EpicReplayProvider>);
    await waitFor(() => expect(fixture.attached()).toBe(1));
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(fixture.value.beginIdentityChange).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(fixture.value.setIdentity).toHaveBeenLastCalledWith("user-2"));
    act(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(fixture.value.beginIdentityChange).toHaveBeenCalledTimes(2);
    await act(async () => { await Promise.resolve(); });
    const restored = new Event("pageshow");
    Object.defineProperty(restored, "persisted", { value: true });
    act(() => { window.dispatchEvent(restored); });
    expect(fixture.value.beginIdentityChange).toHaveBeenCalledTimes(3);
    await act(async () => { await Promise.resolve(); });
    expect(boundary.getSession).toHaveBeenCalledTimes(3);
  });

  it("does not let focus or React remount overtake an outstanding authentication operation", async () => {
    const fixture = fakeRuntime();
    boundary.createRuntime.mockReturnValue(fixture.runtime);
    boundary.getSession.mockResolvedValue({ data: { user: { id: "user-2" } }, error: null });
    const view = render(<EpicReplayProvider documentRelease="build-a"><Readout /></EpicReplayProvider>);
    await waitFor(() => expect(fixture.attached()).toBe(1));
    const finish = beginReplayIdentityBoundary();
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(boundary.getSession).not.toHaveBeenCalled();
    view.unmount();
    render(<EpicReplayProvider documentRelease="build-b"><Readout /></EpicReplayProvider>);
    await waitFor(() => expect(fixture.attached()).toBe(1));
    expect(fixture.value.setIdentity).toHaveBeenLastCalledWith(undefined);
    expect(boundary.getSession).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(fixture.value.setIdentity).toHaveBeenLastCalledWith("user-2"));
    expect(boundary.getSession).toHaveBeenCalledTimes(1);
  });
});
