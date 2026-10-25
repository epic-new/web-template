// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { createReplayMarkers } from "../replay-markers";
import type { EvidenceInput } from "../replay-otlp";

function setup(recording = true) {
  const added: { tag: string; payload: unknown }[] = [];
  const evidence: EvidenceInput[] = [];
  const markers = createReplayMarkers(
    (tag, payload) => {
      if (!recording) return false;
      added.push({ tag, payload });
      return true;
    },
    (input) => evidence.push(input),
    () => "/checkout",
    () => 1_800_000_000_000,
  );
  return { markers, added, evidence };
}

describe("replay markers as evidence", () => {
  it("sends behavior markers as evidence even when the replay is not recording", () => {
    const { markers, added, evidence } = setup(false);

    expect(markers.event("epic.behavior.failed", { behaviorId: "pay", occurrenceId: "occ-1", extra: "dropped" })).toEqual({
      recorded: false,
      reason: "not_recording",
    });

    expect(added).toEqual([]);
    expect(evidence).toEqual([
      {
        event: "behavior.failed",
        at: 1_800_000_000_000,
        route: "/checkout",
        body: "behavior.failed pay",
        behaviorName: "pay",
        occurrence: "occ-1",
      },
    ]);
    expect(markers.getLastBehavior()).toEqual({ behaviorId: "pay", occurrenceId: "occ-1" });
  });

  it("keeps the marker inside the replay as well", () => {
    const { markers, added, evidence } = setup(true);

    expect(markers.event("epic.behavior.started", { behaviorId: "pay" })).toEqual({ recorded: true });

    expect(added).toEqual([{ tag: "epic.behavior.started", payload: { behaviorId: "pay" } }]);
    expect(evidence).toHaveLength(1);
  });

  it("does not turn screens or reports into behavior evidence", () => {
    const { markers, evidence } = setup(true);

    markers.event("epic.screen.viewed");
    markers.event("epic.bug.reported", { reportId: "r1" });
    markers.event("epic.unknown");

    expect(evidence).toEqual([]);
  });

  it("sends a browser error as a bounded, redacted plain-text record", () => {
    const { markers, added, evidence } = setup(false);
    markers.start();

    window.dispatchEvent(new ErrorEvent("error", { error: new TypeError("token=abc12345678 failed for a@b.example") }));
    markers.stop();

    expect(added).toEqual([]);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ event: "browser.error", route: "/checkout" });
    expect(evidence[0]!.body).toMatch(/^TypeError: /);
    expect(evidence[0]!.body).not.toContain("abc12345678");
    expect(evidence[0]!.body).not.toContain("a@b.example");
  });

  it("never throws into the page when evidence fails", () => {
    const failing = vi.fn(() => {
      throw new Error("boom");
    });
    const markers = createReplayMarkers(() => true, failing);

    expect(markers.event("epic.behavior.succeeded", { behaviorId: "pay" })).toEqual({ recorded: true });
    expect(failing).toHaveBeenCalled();
  });
});
