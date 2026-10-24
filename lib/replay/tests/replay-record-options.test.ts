import { describe, expect, it } from "vitest";

import { buildReplayRecordOptions } from "../replay-record-options";

describe("buildReplayRecordOptions", () => {
  it("keeps the defaults when a policy loosens privacy", () => {
    const options = buildReplayRecordOptions({ maskAllInputs: false, maskTextSelector: null, blockSelector: ".secret" });

    expect(options.blockSelector).toBe("[data-private], .secret");
    expect(options.maskTextSelector).toBe("[data-mask]");
    expect(options.maskInputOptions?.password).toBe(true);
    expect(options.maskAllInputs).toBe(false);
  });

  it("does not repeat a default the policy already names", () => {
    const options = buildReplayRecordOptions({
      maskAllInputs: true,
      maskTextSelector: "[data-mask]",
      blockSelector: "[data-private]",
    });

    expect(options.blockSelector).toBe("[data-private]");
    expect(options.maskTextSelector).toBe("[data-mask]");
  });

  it("records no canvas, inline images or fonts, and masks to same-length asterisks", () => {
    const options = buildReplayRecordOptions({ maskAllInputs: true, maskTextSelector: null, blockSelector: null });

    expect(options).toMatchObject({ inlineImages: false, recordCanvas: false, collectFonts: false });
    expect(options.maskTextFn?.("ab c", null)).toBe("** *");
  });
});
