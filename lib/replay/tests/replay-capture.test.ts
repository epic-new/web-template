// @vitest-environment jsdom
import { record as rrwebRecord } from "@rrweb/record";
import { EventType, IncrementalSource, type eventWithTime } from "@rrweb/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createReplayMemoryBuffer } from "../replay-buffer";
import { createReplayCaptureSession } from "../replay-capture";
import { disabledReplayConfig, REPLAY_RECORDING_LIMITS, type PublicReplayConfig } from "../replay-config.contract";
import { epicReplayConsent } from "../replay-consent";
import { activeReplayPolicy } from "./replay-policy.fixture";

const always = { decide: () => true };

const FIXTURE = `
  <main>
    <div data-private><label>Card <input id="private" value="synthetic-secret-4111"></label></div>
    <input id="password" type="password" value="hunter2-synthetic">
    <input id="email" type="email" value="synthetic@example.test">
    <p data-mask>Synthetic SSN 000-12-3456</p>
    <a href="/excluded?access_token=synthetic-access-token&_proxy_token=synthetic-proxy-token">Excluded</a>
  </main>
`;

const SECRETS = [
  "synthetic-secret-4111",
  "hunter2-synthetic",
  "synthetic@example.test",
  "Synthetic SSN 000-12-3456",
  "synthetic-access-token",
  "synthetic-proxy-token",
];

function setup({
  policy = activeReplayPolicy(),
  record = rrwebRecord,
  getCaptureAllowed,
}: { policy?: PublicReplayConfig; record?: typeof rrwebRecord; getCaptureAllowed?: () => boolean } = {}) {
  let current = policy;
  const policyListeners = new Set<() => void>();
  const buffer = createReplayMemoryBuffer(REPLAY_RECORDING_LIMITS);
  const session = createReplayCaptureSession({
    sink: buffer,
    getPolicy: () => current,
    subscribePolicy: (listener) => {
      policyListeners.add(listener);
      return () => policyListeners.delete(listener);
    },
    sampler: always,
    record,
    getCaptureAllowed,
  });
  return {
    buffer,
    session,
    setPolicy(next: PublicReplayConfig, notify = true) {
      current = next;
      if (notify) for (const listener of policyListeners) listener();
    },
    json: () => JSON.stringify(buffer.events()),
  };
}

function fakeRecord() {
  const stop = vi.fn();
  let emit: ((event: eventWithTime) => void) | undefined;
  const record = vi.fn((options?: { emit?: (event: eventWithTime) => void }) => {
    emit = options?.emit;
    emit?.({ type: EventType.Meta, timestamp: 1, data: { href: location.href, width: 1, height: 1 } } as eventWithTime);
    emit?.({ type: EventType.FullSnapshot, timestamp: 2, data: { node: { type: 0, id: 1, childNodes: [] } } } as unknown as eventWithTime);
    return stop;
  }) as unknown as typeof rrwebRecord;
  return {
    record,
    stop,
    emit: (event: Partial<eventWithTime> = {}) =>
      emit?.({ type: EventType.IncrementalSnapshot, timestamp: 3, data: { source: 2 }, ...event } as eventWithTime),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createReplayCaptureSession", () => {
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    document.body.innerHTML = FIXTURE;
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    epicReplayConsent.reset();
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("emits actual pinned-recorder markers only through the permitted wrapper and contains SDK failure", async () => {
    const buffer = createReplayMemoryBuffer(REPLAY_RECORDING_LIMITS);
    const session = createReplayCaptureSession({ sink: buffer, getPolicy: () => activeReplayPolicy(),
      subscribePolicy: () => () => {}, sampler: always, preflightMarker: () => null });
    dispose = () => session.dispose();
    const marker = { tag: "epic.behavior.started", payload: { version: 1, behaviorId: "synthetic.example" } };
    expect(session.track(marker)).toMatchObject({ status: "dropped" });
    epicReplayConsent.grant(); session.start(); await flush();
    const before = buffer.events().length;
    expect(session.track(marker)).toEqual({ status: "emitted" });
    const captured = buffer.events().slice(before).find(({ event }) => event.type === EventType.Custom)!.event;
    expect(captured).toMatchObject({ type: EventType.Custom, timestamp: expect.any(Number), data: marker });
    const count = () => buffer.events().filter(({ event }) => event.type === EventType.Custom).length;
    const n = count();
    rrwebRecord.addCustomEvent("epic.bug.reported", { version: 1, reportId: "synthetic" });
    rrwebRecord.addCustomEvent({ toJSON: () => "epic.bug.reported" } as unknown as string, { version: 1, reportId: "synthetic" });
    expect(count()).toBe(n);
    const sdk = vi.spyOn(rrwebRecord, "addCustomEvent").mockImplementation(() => { throw new Error("synthetic private telemetry failure"); });
    expect(session.track(marker)).toEqual({ status: "dropped", reason: "recorder_unavailable" });
    sdk.mockRestore();
    expect(session.track(marker)).toEqual({ status: "emitted" });
    epicReplayConsent.withdraw();
    expect(session.track(marker)).toMatchObject({ status: "dropped" });
    expect(buffer.events()).toHaveLength(0);
  });

  it("records nothing before consent", () => {
    const fake = fakeRecord();
    const { session, buffer } = setup({ record: fake.record });
    dispose = session.dispose;

    session.start();

    expect(fake.record).not.toHaveBeenCalled();
    expect(buffer.events()).toEqual([]);
    expect(session.getState()).toMatchObject({ status: "blocked", reason: "consent_absent" });
  });

  it("records nothing under a disabled policy even with consent", () => {
    const fake = fakeRecord();
    const { session, buffer } = setup({
      policy: disabledReplayConfig({ reason: "not_configured", environment: null, release: null, now: 0 }),
      record: fake.record,
    });
    dispose = session.dispose;
    epicReplayConsent.grant();

    session.start();

    expect(fake.record).not.toHaveBeenCalled();
    expect(buffer.events()).toEqual([]);
    expect(session.getState().reason).toBe("policy_disabled");
  });

  it("never starts the recorder on an excluded initial route", () => {
    window.history.replaceState({}, "", "/excluded");
    const fake = fakeRecord();
    const { session } = setup({ record: fake.record });
    dispose = session.dispose;
    epicReplayConsent.grant();

    session.start();

    expect(fake.record).not.toHaveBeenCalled();
    expect(session.getState().reason).toBe("route_excluded");
  });

  it("stores masked, blocked and redacted events from the real recorder", async () => {
    const { session, buffer, json } = setup();
    dispose = session.dispose;
    epicReplayConsent.grant();

    session.start();
    const input = document.getElementById("email") as HTMLInputElement;
    input.value = "synthetic@example.test";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();

    expect(session.getState()).toEqual({ status: "capturing", reason: null, boundary: 1 });
    expect(buffer.events().slice(0, 2).map((entry) => entry.event.type)).toEqual([EventType.Meta, EventType.FullSnapshot]);
    for (const secret of SECRETS) expect(json()).not.toContain(secret);
    expect(json()).toContain("access_token=%5Bredacted%5D");
  });

  describe("real recorder regressions", () => {
    it("defers loading-document capture so lifecycle events cannot precede its opening Meta/FullSnapshot", async () => {
      let readiness: DocumentReadyState = "loading";
      vi.spyOn(document, "readyState", "get").mockImplementation(() => readiness);
      const raw: eventWithTime[] = [];
      const stopRaw = rrwebRecord({ emit: (event) => raw.push(event) });
      try {
        expect(raw).toEqual([]);
        readiness = "interactive";
        document.dispatchEvent(new Event("DOMContentLoaded"));
        readiness = "complete";
        window.dispatchEvent(new Event("load"));
        // This is the installed real 2.2.0 recorder, not an ideal event mock.
        expect(raw.slice(0, 4).map((event) => event.type)).toEqual([
          EventType.DomContentLoaded, EventType.Load, EventType.Meta, EventType.FullSnapshot,
        ]);
      } finally {
        stopRaw?.();
      }

      readiness = "loading";
      const initialized = vi.fn();
      let actualMetaTimestamp: number | undefined;
      const realRecorder = ((options?: Parameters<typeof rrwebRecord<eventWithTime>>[0]) => {
        initialized();
        return rrwebRecord<eventWithTime>({ ...options, emit: (event, checkout) => {
          if (event.type === EventType.Meta) actualMetaTimestamp = event.timestamp;
          options?.emit?.(event, checkout);
        } });
      }) as unknown as typeof rrwebRecord;
      const { session, buffer } = setup({ record: realRecorder });
      dispose = session.dispose;
      epicReplayConsent.grant();
      session.start();
      expect(initialized).not.toHaveBeenCalled();
      expect(session.getState().reason).toBe("document_loading");
      readiness = "interactive";
      document.dispatchEvent(new Event("DOMContentLoaded"));
      expect(initialized).not.toHaveBeenCalled();
      readiness = "complete";
      window.dispatchEvent(new Event("load"));
      await flush();
      expect(initialized).toHaveBeenCalledTimes(1);
      expect(buffer.events().slice(0, 2).map(({ event }) => event.type)).toEqual([
        EventType.Meta, EventType.FullSnapshot,
      ]);
      expect(buffer.events()[0]!.event.timestamp).toBe(actualMetaTimestamp);
      expect(buffer.events().some(({ event }) => event.type === EventType.DomContentLoaded || event.type === EventType.Load)).toBe(false);
    });

    it.each([
      ["loading", "dispose"], ["loading", "withdraw"], ["loading", "excluded"],
      ["loading", "expired"], ["loading", "identity"],
      ["deferred", "dispose"], ["deferred", "withdraw"], ["deferred", "excluded"],
      ["deferred", "expired"], ["deferred", "identity"],
    ] as const)("cancels a real-recorder %s readiness wait on %s", async (phase, cancellation) => {
      let readiness: DocumentReadyState = "loading";
      let identityReady = true;
      vi.spyOn(document, "readyState", "get").mockImplementation(() => readiness);
      const realRecorder = vi.fn((options) => rrwebRecord(options)) as unknown as typeof rrwebRecord;
      const { session, buffer, setPolicy } = setup({ record: realRecorder, getCaptureAllowed: () => identityReady });
      dispose = session.dispose;
      epicReplayConsent.grant();
      session.start();
      if (phase === "deferred") {
        readiness = "interactive";
        document.dispatchEvent(new Event("DOMContentLoaded"));
      }
      switch (cancellation) {
        case "dispose": session.dispose(); break;
        case "withdraw": epicReplayConsent.withdraw(); break;
        case "excluded": window.history.pushState({}, "", "/excluded"); break;
        case "expired": setPolicy(disabledReplayConfig({ reason: "expired", environment: "development", release: null, now: 0 })); break;
        case "identity": identityReady = false; session.refresh(); break;
      }
      readiness = "complete";
      document.dispatchEvent(new Event("DOMContentLoaded"));
      window.dispatchEvent(new Event("load"));
      await flush();
      expect(realRecorder).not.toHaveBeenCalled();
      expect(buffer.events()).toEqual([]);
      expect(session.getState().status).toBe("blocked");
    });

    it("masks hidden and password values changed through setAttribute after recording starts", async () => {
      document.body.insertAdjacentHTML(
        "beforeend",
        `<input id="hidden" type="hidden" value="synthetic-hidden-initial">
         <input id="password2" type="password" value="synthetic-password-initial">`,
      );
      const { session, json } = setup();
      dispose = session.dispose;
      epicReplayConsent.grant();
      session.start();

      document.getElementById("hidden")!.setAttribute("value", "synthetic-hidden-changed");
      document.getElementById("password2")!.setAttribute("value", "synthetic-password-changed");
      // A node added after the snapshot, whose type flips to hidden.
      document.body.insertAdjacentHTML("beforeend", `<input id="late" type="text">`);
      await flush();
      const late = document.getElementById("late")!;
      late.setAttribute("type", "hidden");
      late.setAttribute("value", "synthetic-late-hidden");
      await flush();

      expect(json()).not.toMatch(/synthetic-(hidden|password|late)-/);
    });

    it("masks a value mutation whose node context is missing", async () => {
      const { session, json } = setup();
      dispose = session.dispose;
      epicReplayConsent.grant();
      session.start();
      // Losing context: the sanitizer only knows nodes of this boundary, so a
      // node it was never told about must not leak its value.
      const hidden = document.createElement("input");
      hidden.type = "hidden";
      document.body.append(hidden);
      hidden.setAttribute("value", "synthetic-context-missing");
      await flush();

      expect(json()).not.toContain("synthetic-context-missing");
    });

    it("redacts credentials from CSSOM, style diffs, _cssText and rr_src", async () => {
      document.head.innerHTML = `<style id="sheet">.a { background: url(/a.png?token=synthetic-csstext); }</style>`;
      document.body.insertAdjacentHTML(
        "beforeend",
        `<div id="styled" style="color: red"></div><iframe id="frame" src="/embed?access_token=synthetic-rrsrc"></iframe>`,
      );
      // jsdom leaves `sheet.ownerNode` unset; rrweb needs it to attribute
      // CSSOM changes, so restore what a browser provides.
      const styleElement = document.getElementById("sheet") as HTMLStyleElement;
      const sheet = styleElement.sheet!;
      Object.defineProperty(sheet, "ownerNode", { value: styleElement });
      const { session, buffer, json } = setup();
      dispose = session.dispose;
      epicReplayConsent.grant();
      session.start();

      sheet.insertRule(".b { background: url(/b.png?sig=synthetic-insert); }", 0);
      sheet.insertRule(String.raw`.escaped { background: url("/a?\000074 oken=synthetic-css-escape"); }`, 0);
      (sheet.cssRules[1] as CSSStyleRule).style.setProperty("background-image", "url(/c.png?jwt=synthetic-setproperty)");
      (document.getElementById("styled") as HTMLElement).style.setProperty(
        "background-image",
        "url(/d.png?secret=synthetic-diff)",
      );
      document.getElementById("frame")!.setAttribute("src", "/embed?code=synthetic-rrsrc-changed");
      if ("adoptedStyleSheets" in document && typeof CSSStyleSheet.prototype.replaceSync === "function") {
        const adopted = new CSSStyleSheet();
        adopted.replaceSync(".e { background: url(/e.png?password=synthetic-adopted); }");
        document.adoptedStyleSheets = [adopted];
      }
      await flush();

      // The recorder really emitted the insertRule envelope being sanitized.
      // jsdom's rule declarations and adopted sheets are not observable by
      // rrweb; those envelopes are covered in replay-event-sanitizer.test.ts.
      const sources = buffer.events().map((entry) => (entry.event.data as { source?: number }).source);
      expect(sources).toContain(IncrementalSource.StyleSheetRule);
      const stored = json();
      expect(stored).not.toMatch(/synthetic-(csstext|insert|setproperty|diff|rrsrc|adopted)/);
      expect(stored).not.toContain("synthetic-css-escape");
      expect(stored).toContain(".escaped");
      expect(stored).toContain("%5Bredacted%5D");
      expect(getComputedStyle(document.getElementById("styled")!).color).toBe("rgb(255, 0, 0)");
      document.head.innerHTML = "";
    });
  });

  it("uses the same cancellable readiness gate when restarting a boundary", async () => {
    let readiness: DocumentReadyState = "complete";
    vi.spyOn(document, "readyState", "get").mockImplementation(() => readiness);
    const fake = fakeRecord();
    const { session, buffer } = setup({ record: fake.record });
    dispose = session.dispose;
    epicReplayConsent.grant();
    session.start();
    readiness = "loading";
    session.restartBoundary();
    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(fake.record).toHaveBeenCalledTimes(1);
    readiness = "interactive";
    document.dispatchEvent(new Event("DOMContentLoaded"));
    expect(fake.record).toHaveBeenCalledTimes(1);
    await flush();
    expect(fake.record).toHaveBeenCalledTimes(2);
    expect(buffer.events().filter(({ boundary }) => boundary === 2).map(({ event }) => event.type)).toEqual([
      EventType.Meta, EventType.FullSnapshot,
    ]);
  });

  it.each(["lifecycle_first", "incremental_second", "invalid_snapshot", "invalid_root"] as const)(
    "rejects %s without forwarding a partial opening pair",
    (failure) => {
      const stop = vi.fn();
      const record = vi.fn((options?: { emit?: (event: eventWithTime) => void }) => {
        if (failure === "lifecycle_first") {
          options?.emit?.({ type: EventType.Load, timestamp: 1, data: {} });
        } else {
          options?.emit?.({ type: EventType.Meta, timestamp: 1, data: { href: location.href, width: 1, height: 1 } });
          options?.emit?.({
            type: failure === "incremental_second" ? EventType.IncrementalSnapshot : EventType.FullSnapshot,
            timestamp: 2, data: failure === "invalid_root" ? { node: {} } : {},
          } as unknown as eventWithTime);
        }
        return stop;
      }) as unknown as typeof rrwebRecord;
      const { session, buffer } = setup({ record });
      dispose = session.dispose;
      epicReplayConsent.grant();
      session.start();
      expect(buffer.events()).toEqual([]);
      expect(session.getState().status).toBe("blocked");
      expect(stop).toHaveBeenCalledOnce();
    },
  );

  it("bounds incomplete opening snapshot staging by age", async () => {
    vi.useFakeTimers();
    const stop = vi.fn();
    const record = vi.fn((options?: { emit?: (event: eventWithTime) => void }) => {
      options?.emit?.({ type: EventType.Meta, timestamp: 1, data: { href: location.href, width: 1, height: 1 } });
      return stop;
    }) as unknown as typeof rrwebRecord;
    const policy = activeReplayPolicy();
    policy.recording.limits.maxBufferAgeMs = 10;
    const { session, buffer } = setup({ policy, record });
    dispose = session.dispose;
    epicReplayConsent.grant();
    session.start();
    expect(session.getState().reason).toBe("opening_snapshot");
    expect(buffer.events()).toEqual([]);
    await vi.advanceTimersByTimeAsync(10);
    expect(stop).toHaveBeenCalledOnce();
    expect(session.getState().reason).toBe("policy_disabled");
    expect(buffer.events()).toEqual([]);
  });

  it("rejects an oversized opening before either event reaches the sink", () => {
    const fake = fakeRecord();
    const policy = activeReplayPolicy();
    policy.recording.limits.maxBufferBytes = 64;
    const { session, buffer } = setup({ policy, record: fake.record });
    dispose = session.dispose;
    epicReplayConsent.grant();
    session.start();
    expect(fake.stop).toHaveBeenCalledOnce();
    expect(session.getState().status).toBe("blocked");
    expect(buffer.events()).toEqual([]);
  });

  it("keeps an excluded route's content out and resumes with a fresh boundary", async () => {
    const { session, buffer, json } = setup();
    dispose = session.dispose;
    epicReplayConsent.grant();
    session.start();

    window.history.pushState({}, "", "/excluded");
    document.body.insertAdjacentHTML("beforeend", "<p>Synthetic excluded content EXCLUDED-7731</p>");
    await flush();

    expect(session.getState()).toMatchObject({ status: "blocked", reason: "route_excluded" });
    expect(json()).not.toContain("EXCLUDED-7731");

    document.body.innerHTML = FIXTURE;
    window.history.pushState({}, "", "/");
    expect(session.getState().status).toBe("blocked");
    await flush();

    expect(session.getState()).toEqual({ status: "capturing", reason: null, boundary: 2 });
    const second = buffer.events().filter((entry) => entry.boundary === 2);
    expect(second.slice(0, 2).map((entry) => entry.event.type)).toEqual([EventType.Meta, EventType.FullSnapshot]);
    expect(json()).not.toContain("EXCLUDED-7731");
  });

  it("drops events once the policy has expired, without a notification", () => {
    const fake = fakeRecord();
    const { session, buffer, setPolicy } = setup({ record: fake.record });
    dispose = session.dispose;
    epicReplayConsent.grant();
    session.start();
    const before = buffer.events().length;

    setPolicy(disabledReplayConfig({ reason: "expired", environment: "development", release: null, now: 0 }), false);
    fake.emit();

    expect(buffer.events()).toHaveLength(before);
    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(session.getState()).toMatchObject({ status: "blocked", reason: "policy_expired" });
  });

  it("stops and clears local state inside withdraw(), and restarts on a new grant", () => {
    const fake = fakeRecord();
    const { session, buffer } = setup({ record: fake.record });
    dispose = session.dispose;
    epicReplayConsent.grant();
    session.start();
    fake.emit();
    expect(buffer.events().length).toBeGreaterThan(0);

    epicReplayConsent.withdraw();

    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(buffer.events()).toEqual([]);
    expect(session.getState()).toMatchObject({ status: "blocked", reason: "consent_withdrawn" });

    fake.emit();
    expect(buffer.events()).toEqual([]);

    epicReplayConsent.grant();
    expect(session.getState()).toEqual({ status: "capturing", reason: null, boundary: 2 });
    expect(buffer.events().map((entry) => entry.event.type)).toEqual([EventType.Meta, EventType.FullSnapshot]);
  });

  it.each([
    ["policy_expired", disabledReplayConfig({ reason: "expired", environment: "development", release: null, now: 0 })],
    ["policy_disabled", { ...activeReplayPolicy(), capture: { ...activeReplayPolicy().capture, enabled: false } }],
  ] as const)("clears retained events on withdrawal even when %s already blocks capture", (reason, blocked) => {
    const fake = fakeRecord();
    const { session, buffer, setPolicy } = setup({ record: fake.record });
    dispose = session.dispose;
    epicReplayConsent.grant();
    session.start();
    fake.emit();
    expect(buffer.events().length).toBeGreaterThan(0);

    setPolicy(blocked as PublicReplayConfig);
    expect(session.getState().reason).toBe(reason);
    expect(buffer.events().length).toBeGreaterThan(0);

    epicReplayConsent.withdraw();

    expect(buffer.events()).toEqual([]);
    expect(session.getState()).toMatchObject({ status: "blocked", reason });
    fake.emit();
    expect(buffer.events()).toEqual([]);
    expect(() => window.history.pushState({}, "", "/other")).not.toThrow();
  });

  it("clears retained events on withdrawal on an excluded route", () => {
    const fake = fakeRecord();
    const { session, buffer } = setup({ record: fake.record });
    dispose = session.dispose;
    epicReplayConsent.grant();
    session.start();
    window.history.pushState({}, "", "/excluded");
    expect(buffer.events().length).toBeGreaterThan(0);

    epicReplayConsent.withdraw();

    expect(buffer.events()).toEqual([]);
  });

  it("starts at most one recorder and restores history on dispose", () => {
    const fake = fakeRecord();
    const original = window.history.pushState;
    const { session } = setup({ record: fake.record });
    epicReplayConsent.grant();

    session.start();
    session.start();
    expect(window.history.pushState).not.toBe(original);
    session.dispose();
    session.dispose();

    expect(fake.record).toHaveBeenCalledTimes(1);
    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(window.history.pushState).toBe(original);
  });

  it("keeps the app working when the recorder throws", () => {
    const record = vi.fn(() => {
      throw new Error("recorder unavailable");
    }) as unknown as typeof rrwebRecord;
    const { session } = setup({ record });
    dispose = session.dispose;
    epicReplayConsent.grant();

    expect(() => session.start()).not.toThrow();
    expect(session.getState()).toMatchObject({ status: "blocked", reason: "policy_disabled" });
    expect(() => window.history.pushState({}, "", "/other")).not.toThrow();
  });

  it("restarts a boundary with fresh Meta and FullSnapshot only while still permitted", () => {
    const fake = fakeRecord();
    const { session, buffer, setPolicy } = setup({ record: fake.record });
    dispose = session.dispose;
    epicReplayConsent.grant();
    session.start();

    session.restartBoundary();

    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(session.getState()).toMatchObject({ status: "capturing", boundary: 2 });
    expect(buffer.events().filter((entry) => entry.boundary === 2).map((entry) => entry.event.type)).toEqual([
      EventType.Meta,
      EventType.FullSnapshot,
    ]);

    setPolicy(disabledReplayConfig({ reason: "not_configured", environment: null, release: null, now: 0 }), false);
    session.restartBoundary();
    expect(session.getState()).toMatchObject({ status: "blocked", boundary: 2 });
    expect(fake.record).toHaveBeenCalledTimes(2);
  });
});
