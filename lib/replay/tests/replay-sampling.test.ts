// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { createReplaySampler } from "../replay-sampling";

describe("createReplaySampler", () => {
  afterEach(() => window.sessionStorage.clear());

  it("keeps one decision across repeated evaluation of the same policy", () => {
    const random = vi.fn().mockReturnValueOnce(0.4).mockReturnValueOnce(0.9);
    const sampler = createReplaySampler({ storage: window.sessionStorage, random });
    const policy = { configVersion: "v1", sessionSampleRate: 0.5 };

    expect([sampler.decide(policy), sampler.decide(policy), sampler.decide(policy)]).toEqual([true, true, true]);
    expect(random).toHaveBeenCalledTimes(1);
  });

  it("draws once more for a changed policy", () => {
    const random = vi.fn().mockReturnValueOnce(0.4).mockReturnValueOnce(0.9);
    const sampler = createReplaySampler({ storage: window.sessionStorage, random });
    sampler.decide({ configVersion: "v1", sessionSampleRate: 0.5 });

    const v2 = { configVersion: "v2", sessionSampleRate: 0.5 };
    expect([sampler.decide(v2), sampler.decide(v2)]).toEqual([false, false]);
    expect(random).toHaveBeenCalledTimes(2);
  });

  it("keeps the stored decision for a new sampler in the same tab session", () => {
    createReplaySampler({ storage: window.sessionStorage, random: () => 0.1 }).decide({
      configVersion: "v1",
      sessionSampleRate: 0.5,
    });
    const random = vi.fn(() => 0.9);

    expect(
      createReplaySampler({ storage: window.sessionStorage, random }).decide({
        configVersion: "v1",
        sessionSampleRate: 0.5,
      }),
    ).toBe(true);
    expect(random).not.toHaveBeenCalled();
  });

  it("never consults random for rates 0 and 1", () => {
    const random = vi.fn(() => 0.5);
    const sampler = createReplaySampler({ storage: null, random });

    expect(sampler.decide({ configVersion: "a", sessionSampleRate: 0 })).toBe(false);
    expect(sampler.decide({ configVersion: "b", sessionSampleRate: 1 })).toBe(true);
    expect(random).not.toHaveBeenCalled();
  });

  it("falls back to memory when storage throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    const random = vi.fn().mockReturnValueOnce(0.1).mockReturnValueOnce(0.9);
    const sampler = createReplaySampler({ storage: broken, random });
    const policy = { configVersion: "v1", sessionSampleRate: 0.5 };

    expect([sampler.decide(policy), sampler.decide(policy)]).toEqual([true, true]);
    expect(random).toHaveBeenCalledTimes(1);
  });

  it("does not read storage again once a policy's decision is known", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const sampler = createReplaySampler({ storage: window.sessionStorage, random: () => 0.1 });
    const policy = { configVersion: "v1", sessionSampleRate: 0.5 };
    sampler.decide(policy);
    getItem.mockClear();

    for (let index = 0; index < 5; index += 1) sampler.decide(policy);
    expect(getItem).not.toHaveBeenCalled();
    getItem.mockRestore();
  });
});
