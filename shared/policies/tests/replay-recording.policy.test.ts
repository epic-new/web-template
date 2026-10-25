import { describe, expect, it } from "vitest";

import { ReplayRecordingPolicy } from "../replay-recording.policy";

const owner = { subjectId: "sub_a" };
const bound = (overrides = {}) => ({ subjectId: "sub_a", recordingId: "rec-1", ...overrides });

describe("ReplayRecordingPolicy", () => {
  it("relays and attaches only a bound recording of the same subject", () => {
    for (const check of [ReplayRecordingPolicy.canRelay, ReplayRecordingPolicy.canAttach]) {
      expect(check(owner, bound())).toBe(true);
      expect(check(owner, bound({ subjectId: "sub_b" }))).toBe(false);
      expect(check(owner, bound({ recordingId: null }))).toBe(false);
      expect(check(owner, null)).toBe(false);
    }
  });
});
