// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReplayUploadReason, ReplayUploadState, ReplayUploadStatus } from "@/lib/replay/replay-uploader";
import type { ReplayUploadHarnessSnapshot } from "../../behaviors/preview-replay-upload/use-preview-replay-upload.hook";

const hook = vi.hoisted(() => ({
  state: null as unknown as ReplayUploadHarnessSnapshot,
  setTarget: vi.fn(),
  setFixtureMode: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  emitCustomEvent: vi.fn(),
  sendForgedRequests: vi.fn(async () => {}),
}));

vi.mock("../../behaviors/preview-replay-upload/use-preview-replay-upload.hook", () => ({
  usePreviewReplayUpload: () => ({ ...hook, log: hook.state.log }),
  usePreviewReplayUploadControls: () => hook,
}));

import { ReplayUploadHarness } from "../ReplayUploadHarness";

const reference = { recordingId: "6f1c2f8e-5a3b-4c1d-9e2f-1a2b3c4d5e6f", startedAt: 1_800_000_000_000, boundary: 1 };

function upload(status: ReplayUploadStatus, reason: ReplayUploadReason = null, overrides: Partial<ReplayUploadState> = {}): ReplayUploadState {
  const live = status !== "idle" && status !== "recorder_started" && status !== "unavailable";
  return {
    status,
    reason,
    current: live ? reference : null,
    history: live ? [{ reference, outcome: "open", reason: null, acceptedBatches: status === "pending" ? 2 : 0, availability: "events_received" }] : [],
    bufferedEvents: status === "recorder_started" ? 4 : 0,
    bufferedBytes: 0,
    evidence: "unverified",
    ...overrides,
  };
}

function show(state: ReplayUploadState, overrides: Partial<ReplayUploadHarnessSnapshot> = {}) {
  hook.state = {
    target: "synthetic",
    fixtureMode: "accept",
    running: true,
    policySource: "harness",
    pipeline: { capture: { status: "capturing", reason: null, boundary: 1 }, upload: state },
    log: [],
    forged: [],
    ...overrides,
  };
  cleanup();
  render(<ReplayUploadHarness />);
}

// Each case renders the whole harness; generous under a loaded test machine.
describe("ReplayUploadHarness", { timeout: 30_000 }, () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("labels every transport stage honestly and never claims readiness", () => {
    const cases: [ReplayUploadState, string][] = [
      [upload("idle"), "Idle"],
      [upload("recorder_started"), "Recorder started - waiting for registration"],
      [upload("registered"), "Registered"],
      [upload("uploading"), "Uploading"],
      [upload("pending"), "Pending - received, playback not verified"],
      [upload("pending", "offline"), "Pending upload - offline"],
      [upload("unavailable", "not_configured"), "Unavailable - not configured"],
      [upload("unavailable", "attempts_exhausted"), "Unavailable - attempts exhausted"],
      [upload("unavailable", "snapshot_too_large"), "Unavailable - snapshot too large"],
      [upload("unavailable", "buffer_exceeded"), "Unavailable - buffer exceeded"],
      [upload("unavailable", "delivery_uncertain"), "Incomplete - delivery uncertain"],
    ];
    for (const [state, label] of cases) {
      show(state);
      expect(screen.getByLabelText("Upload status")).toHaveTextContent(label);
      expect(screen.getAllByText("Evidence: unverified").length).toBeGreaterThan(0);
      expect(document.body.textContent).not.toMatch(/Playable|Ready/);
    }
  });

  it("shows the reference, startedAt, counts, history and the synthetic badge", () => {
    show(upload("pending"), {
      log: [
        { id: 1, path: "/recordings", status: 201, code: null, batchId: null, sequence: null, eventCount: null, firstEventTypes: null, final: null, bodyKeys: ["contractVersion", "idempotencyKey"] },
        { id: 2, path: `/recordings/${reference.recordingId}/batches`, status: 200, code: null, batchId: "aaaaaaaa-0000", sequence: 0, eventCount: 2, firstEventTypes: [4, 2], final: false, bodyKeys: ["batchId", "events"] },
      ],
    });

    expect(screen.getByText("Synthetic fixture - not Epic, not rrweb")).toBeInTheDocument();
    expect(screen.getAllByText(reference.recordingId).length).toBeGreaterThan(0);
    expect(screen.getAllByText(String(reference.startedAt)).length).toBeGreaterThan(0);
    expect(screen.getByText("Open - received, playback not verified")).toBeInTheDocument();
    expect(screen.getByLabelText("Request log")).toHaveTextContent("/recordings");
    expect(screen.getByLabelText("Request log")).toHaveTextContent("(types 4, 2...)");
    // The readout blocks its own capture.
    expect(screen.getByLabelText("Upload status").closest("[data-private]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Start recording" }).closest("[data-private]")).not.toBeNull();
    expect(screen.getByLabelText("Harness input").closest("[data-private]")).toBeNull();
  });

  it("keeps a withdrawn recording's reference in history and lists forged rejections", () => {
    show(
      upload("idle", null, {
        history: [{ reference, outcome: "incomplete", reason: null, acceptedBatches: 1, availability: "events_received" }],
      }),
      {
        target: "application",
        pipeline: { capture: { status: "blocked", reason: "consent_withdrawn", boundary: 1 }, upload: upload("idle", null, {
          history: [{ reference, outcome: "incomplete", reason: null, acceptedBatches: 1, availability: "events_received" }],
        }) },
        forged: [
          { label: "Registration with subjectId and projectId", status: 400, code: "invalid_request" },
          { label: "Capability for a random recording", status: 404, code: "recording_not_found" },
          { label: "Batch for a random recording", status: 404, code: "recording_not_found" },
        ],
      },
    );

    expect(screen.getByText("stopped (consent_withdrawn)")).toBeInTheDocument();
    expect(screen.getByLabelText("Recording history")).toHaveTextContent(reference.recordingId);
    expect(screen.getByLabelText("Recording history")).toHaveTextContent("Evidence: unverified");
    expect(screen.getByLabelText("Forged request results")).toHaveTextContent("400 invalid_request");
    expect(screen.queryByText("Synthetic fixture - not Epic, not rrweb")).toBeNull();
  });

  it("wires the controls to the public hook", () => {
    show(upload("idle"), { running: false });

    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    fireEvent.click(screen.getByRole("button", { name: "Emit custom event" }));
    fireEvent.click(screen.getByRole("button", { name: "Send forged requests" }));
    fireEvent.change(screen.getByLabelText("Fixture mode"), { target: { value: "fail_503" } });
    fireEvent.click(screen.getByLabelText("Application relay"));

    expect(hook.start).toHaveBeenCalled();
    expect(hook.emitCustomEvent).toHaveBeenCalled();
    expect(hook.sendForgedRequests).toHaveBeenCalled();
    expect(hook.setFixtureMode).toHaveBeenCalledWith("fail_503");
    expect(hook.setTarget).toHaveBeenCalledWith("application");
    expect(screen.getByRole("link", { name: "Navigate" })).toHaveAttribute("href", "/styleguide/replay/upload/second");
  });
});
