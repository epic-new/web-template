"use client";

import { record } from "@rrweb/record";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import type { PublicReplayConfig } from "@/lib/replay/replay-config.contract";
import { replayLifecycle } from "@/lib/replay/replay-lifecycle";
import {
  createReplayRecordingPipeline,
  type ReplayPipelineState,
  type ReplayRecordingPipeline,
} from "@/lib/replay/replay-recording-pipeline";
import { REPLAY_RECORDER_VERSION } from "@/lib/replay/replay-upload-contract";
import { syntheticReplayPolicy } from "../preview-replay-capture/synthetic-policies";
import { createHarnessFixture, type SyntheticFixtureMode } from "./synthetic-epi210";

/**
 * The upload harness's recording pipeline: the real WEB-2 recorder, gates and
 * redaction feeding this issue's real upload transport, pointed at one of two
 * labelled targets:
 *
 * - "application": the real same-origin relay routes. When the deployment's
 *   own policy is inactive (e.g. `EPIC_*` unset) the harness gates capture
 *   with its synthetic development policy instead, so the relay's honest
 *   answer (`not_configured`) is what the transport reports.
 * - "synthetic": the in-browser synthetic EPI-210 fixture (not Epic, not rrweb).
 *
 * Module-level so it survives client navigation between the harness pages;
 * disposed a task after the last harness page unmounts.
 */

export type ReplayUploadTarget = "application" | "synthetic";

/** A safe request record: routing and identity fields only, never events. */
export interface ReplayHarnessLogEntry {
  id: number;
  path: string;
  status: number | "network_error";
  code: string | null;
  batchId: string | null;
  sequence: number | null;
  eventCount: number | null;
  firstEventTypes: number[] | null;
  final: boolean | null;
  bodyKeys: string[];
}

export interface ReplayForgedResult {
  label: string;
  status: number | "network_error";
  code: string | null;
}

export interface ReplayUploadHarnessSnapshot {
  target: ReplayUploadTarget;
  fixtureMode: SyntheticFixtureMode;
  running: boolean;
  /** Which policy gates capture: the deployment's or the harness's synthetic one. */
  policySource: "application" | "harness";
  pipeline: ReplayPipelineState;
  log: readonly ReplayHarnessLogEntry[];
  forged: readonly ReplayForgedResult[];
}

const BASE_URL = "/api/epic/replay";

let target: ReplayUploadTarget = "application";
let running = false;
let harness = createHarnessFixture();
let harnessPolicy: PublicReplayConfig | null = null;
let pipeline: ReplayRecordingPipeline | null = null;
let appLog: ReplayHarnessLogEntry[] = [];
let forged: ReplayForgedResult[] = [];
let logCounter = 0;
let customCounter = 0;
const listeners = new Set<() => void>();
const policyListeners = new Set<() => void>();
let unsubscribeFixture: (() => void) | null = null;

function syntheticPolicy(): PublicReplayConfig {
  if (!harnessPolicy || Date.now() >= harnessPolicy.expiresAt) {
    harnessPolicy = { ...syntheticReplayPolicy("synthetic-sampled"), configVersion: "1" };
  }
  return harnessPolicy;
}

function policySource(): "application" | "harness" {
  return target === "application" && replayLifecycle.getSnapshot().status === "active" ? "application" : "harness";
}

function getPolicy(): PublicReplayConfig {
  return policySource() === "application" ? replayLifecycle.getSnapshot() : syntheticPolicy();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseBody(init?: RequestInit): unknown {
  try {
    return typeof init?.body === "string" ? JSON.parse(init.body) : null;
  } catch {
    return null;
  }
}

/** The real relay, with each request summarized into the safe log. */
const applicationFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
  const body = parseBody(init);
  const entry: ReplayHarnessLogEntry = {
    id: ++logCounter,
    path: url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url,
    status: "network_error",
    code: null,
    batchId: isRecord(body) && typeof body.batchId === "string" ? body.batchId : null,
    sequence: isRecord(body) && typeof body.sequence === "number" ? body.sequence : null,
    eventCount: isRecord(body) && Array.isArray(body.events) ? body.events.length : null,
    firstEventTypes: null,
    final: isRecord(body) && typeof body.final === "boolean" ? body.final : null,
    bodyKeys: isRecord(body) ? Object.keys(body).sort() : [],
  };
  appLog = [...appLog, entry].slice(-100);
  emit();
  try {
    const response = await fetch(input, init);
    const payload = await response
      .clone()
      .json()
      .catch(() => null);
    appLog = appLog.map((existing) =>
      existing.id === entry.id
        ? { ...existing, status: response.status, code: isRecord(payload) && typeof payload.code === "string" ? payload.code : null }
        : existing,
    );
    emit();
    return response;
  } catch (error) {
    emit();
    throw error;
  }
}) as typeof fetch;

function targetFetch(): typeof fetch {
  return target === "synthetic" ? harness.browser.fetch : applicationFetch;
}

function getPipeline(): ReplayRecordingPipeline {
  if (pipeline) return pipeline;
  const created = createReplayRecordingPipeline({
    getPolicy,
    subscribePolicy: (listener) => {
      const unsubscribe = replayLifecycle.subscribe(listener);
      policyListeners.add(listener);
      return () => {
        unsubscribe();
        policyListeners.delete(listener);
      };
    },
    fetch: targetFetch(),
    baseUrl: BASE_URL,
    // The harness has no build-bound release of its own: unknown, never the server's.
    getDocumentRelease: () => null,
    isOnline: () =>
      (typeof navigator === "undefined" || navigator.onLine !== false) &&
      !(target === "synthetic" && harness.fixture.getMode() === "offline"),
  });
  created.subscribe(emit);
  pipeline = created;
  return created;
}

const idleState: ReplayPipelineState = {
  capture: { status: "blocked", reason: "policy_disabled", boundary: 0 },
  upload: {
    status: "idle",
    reason: null,
    current: null,
    history: [],
    bufferedEvents: 0,
    bufferedBytes: 0,
    evidence: "unverified",
  },
};

function build(): ReplayUploadHarnessSnapshot {
  return {
    target,
    fixtureMode: harness.fixture.getMode(),
    running,
    policySource: policySource(),
    pipeline: pipeline?.getState() ?? idleState,
    log: target === "synthetic" ? harness.browser.log.map((entry) => ({ ...entry })) : appLog,
    forged,
  };
}

let snapshot = build();

function emit() {
  snapshot = build();
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function attachFixture() {
  unsubscribeFixture?.();
  unsubscribeFixture = harness.browser.subscribe(emit);
}
attachFixture();

function setTarget(next: ReplayUploadTarget) {
  if (next === target) return;
  pipeline?.dispose();
  pipeline = null;
  running = false;
  target = next;
  forged = [];
  for (const listener of [...policyListeners]) listener();
  emit();
}

function setFixtureMode(mode: SyntheticFixtureMode) {
  harness.fixture.setMode(mode);
  emit();
}

function start() {
  running = true;
  getPipeline().start();
  emit();
}

function stop() {
  running = false;
  pipeline?.stop();
  emit();
}

function emitCustomEvent() {
  try {
    record.addCustomEvent("epic-replay-harness", { n: ++customCounter });
  } catch {
    // No active recorder: nothing to emit, and nothing escapes.
  }
}

/**
 * Sends a registration carrying `subjectId` and `projectId`, then a capability
 * and a batch for a random recording UUID, to the selected target. None of
 * the forged fields may ever be accepted.
 */
async function sendForgedRequests() {
  const send = targetFetch();
  const randomId = crypto.randomUUID();
  const requests: { label: string; path: string; body: unknown }[] = [
    {
      label: "Registration with subjectId and projectId",
      path: "/recordings",
      body: {
        contractVersion: 1,
        idempotencyKey: crypto.randomUUID(),
        startedAt: Date.now(),
        route: "/styleguide/replay/upload",
        recorderVersion: REPLAY_RECORDER_VERSION,
        configVersion: "forged",
        release: null,
        viewport: null,
        subjectId: "sub_forged",
        projectId: "forged-project",
      },
    },
    { label: "Capability for a random recording", path: `/recordings/${randomId}/capability`, body: { contractVersion: 1 } },
    {
      label: "Batch for a random recording",
      path: `/recordings/${randomId}/batches`,
      body: {
        contractVersion: 1,
        recordingToken: "forged-capability",
        batchId: crypto.randomUUID(),
        sequence: 0,
        events: [{ type: 5, timestamp: Date.now(), data: { tag: "forged", payload: {} } }],
        final: false,
      },
    },
  ];
  forged = [];
  emit();
  for (const request of requests) {
    let result: ReplayForgedResult;
    try {
      const response = await send(`${BASE_URL}${request.path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(request.body),
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      result = {
        label: request.label,
        status: response.status,
        code: isRecord(payload) && typeof payload.code === "string" ? payload.code : null,
      };
    } catch {
      result = { label: request.label, status: "network_error", code: null };
    }
    forged = [...forged, result];
    emit();
  }
}

let mounted = 0;
let disposeTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * The upload harness: pipeline state, safe request log and controls. Only
 * components inside `data-private` may render its counters: it re-renders on
 * every admitted event.
 */
export function usePreviewReplayUpload() {
  useEffect(() => {
    mounted++;
    clearTimeout(disposeTimer);
    return () => {
      mounted--;
      disposeTimer = setTimeout(() => {
        if (mounted > 0) return;
        pipeline?.dispose();
        pipeline = null;
        running = false;
        emit();
      }, 0);
    };
  }, []);

  const state = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);

  return {
    state,
    log: state.log,
    setTarget: useCallback((next: ReplayUploadTarget) => setTarget(next), []),
    setFixtureMode: useCallback((mode: SyntheticFixtureMode) => setFixtureMode(mode), []),
    start: useCallback(() => start(), []),
    stop: useCallback(() => stop(), []),
    emitCustomEvent: useCallback(() => emitCustomEvent(), []),
    sendForgedRequests: useCallback(() => sendForgedRequests(), []),
  };
}

// Tests only.
export function resetPreviewReplayUpload() {
  clearTimeout(disposeTimer);
  pipeline?.dispose();
  pipeline = null;
  mounted = 0;
  running = false;
  target = "application";
  harness = createHarnessFixture();
  attachFixture();
  harnessPolicy = null;
  appLog = [];
  forged = [];
  emit();
}
