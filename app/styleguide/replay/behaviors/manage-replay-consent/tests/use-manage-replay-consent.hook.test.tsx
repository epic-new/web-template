// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { epicReplayConsent } from "@/lib/replay/replay-consent";
import { REPLAY_WITHDRAWN_NOTICE, useManageReplayConsent } from "../use-manage-replay-consent.hook";

describe("useManageReplayConsent", () => {
  afterEach(() => epicReplayConsent.reset());

  it("starts without consent", () => {
    const { result } = renderHook(() => useManageReplayConsent());
    expect(result.current).toMatchObject({ consent: "unknown", notice: null });
  });

  it("withdraws with a notice that claims no deletion of uploads", () => {
    const { result } = renderHook(() => useManageReplayConsent());

    act(() => result.current.grant());
    expect(result.current.consent).toBe("granted");
    act(() => result.current.withdraw());

    expect(result.current).toMatchObject({ consent: "withdrawn", notice: REPLAY_WITHDRAWN_NOTICE });
    expect(REPLAY_WITHDRAWN_NOTICE).toBe("Capture stopped. Local recording data on this device was cleared.");
    expect(REPLAY_WITHDRAWN_NOTICE).not.toMatch(/delet|cloud|upload/i);
  });

  it("clears the notice on a new grant", () => {
    const { result } = renderHook(() => useManageReplayConsent());
    act(() => result.current.withdraw());
    act(() => result.current.grant());

    expect(result.current).toMatchObject({ consent: "granted", notice: null });
  });
});
