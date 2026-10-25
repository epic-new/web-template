import { describe, expect, it } from "vitest";

import { deriveReplayCaptureContext, majorVersion } from "../server/capture-context";
import { deriveReplaySubject } from "../server/replay-subject";
import {
  mintReplayVisitorId,
  signReplayVisitorCookie,
  verifyReplayVisitorCookie,
} from "../server/replay-visitor-cookie";

const SECRET = "test-secret-key-for-testing-only-32-chars-min";

describe("replay subject", () => {
  it("is stable, opaque and distinct by kind and id", () => {
    const user = deriveReplaySubject({ kind: "user", userId: "user-1" }, SECRET);
    expect(user).toMatch(/^sub_[A-Za-z0-9_-]{43}$/);
    expect(deriveReplaySubject({ kind: "user", userId: "user-1" }, SECRET)).toBe(user);
    expect(deriveReplaySubject({ kind: "user", userId: "user-2" }, SECRET)).not.toBe(user);
    expect(deriveReplaySubject({ kind: "anonymous", visitorId: "user-1" }, SECRET)).not.toBe(user);
    expect(deriveReplaySubject({ kind: "user", userId: "user-1" }, `${SECRET}x`)).not.toBe(user);
    expect(user).not.toContain("user-1");
  });
});

describe("visitor cookie", () => {
  it("accepts its own signature and ignores tampering", () => {
    const id = mintReplayVisitorId();
    const cookie = signReplayVisitorCookie(id, SECRET);

    expect(verifyReplayVisitorCookie(cookie, SECRET)).toBe(id);
    expect(verifyReplayVisitorCookie(cookie, `${SECRET}x`)).toBeNull();
    expect(verifyReplayVisitorCookie(`${mintReplayVisitorId()}.${cookie.split(".")[1]}`, SECRET)).toBeNull();
    expect(verifyReplayVisitorCookie(`${cookie}.x`, SECRET)).toBeNull();
    expect(verifyReplayVisitorCookie(undefined, SECRET)).toBeNull();
  });
});

describe("capture context", () => {
  it("reduces a User-Agent to coarse enums", () => {
    expect(
      deriveReplayCaptureContext(
        {
          browser: { name: "Mobile Safari", version: "17.4.1" },
          os: { name: "iOS", version: "17.4" },
          device: { type: "mobile" },
        },
        { width: 390, height: 844 },
      ),
    ).toEqual({
      browser: { name: "Safari", majorVersion: "17" },
      os: { name: "iOS", majorVersion: "17" },
      deviceClass: "mobile",
      viewport: { width: 390, height: 844 },
    });

    expect(
      deriveReplayCaptureContext({ browser: {}, os: {}, device: {} }, null),
    ).toEqual({
      browser: { name: "Other", majorVersion: null },
      os: { name: "Other", majorVersion: null },
      deviceClass: "other",
      viewport: null,
    });
  });

  it("keeps only a one-to-four digit major version", () => {
    expect(majorVersion("12345.0")).toBeNull();
    expect(majorVersion("abc")).toBeNull();
    expect(majorVersion("128")).toBe("128");
  });
});
