import type { record } from "@rrweb/record";

import type { PublicReplayConfig } from "./replay-config.contract";

/**
 * The privacy half of rrweb's `record()` options. The defaults are always
 * applied, and the policy's selectors only add to them, so a policy can widen
 * what is hidden but never narrow it. See docs/replay-privacy.md for the
 * marker semantics.
 */

type RecordOptions = NonNullable<Parameters<typeof record>[0]>;

/** The element and its subtree are not recorded; replay shows a same-size placeholder. */
export const REPLAY_BLOCK_SELECTOR_DEFAULT = "[data-private]";
/** Text inside is recorded as `*`. */
export const REPLAY_MASK_TEXT_SELECTOR_DEFAULT = "[data-mask]";

function joinSelectors(defaultSelector: string, policySelector: string | null): string {
  const extra = policySelector?.trim();
  return extra && extra !== defaultSelector ? `${defaultSelector}, ${extra}` : defaultSelector;
}

const mask = (text: string) => text.replace(/\S/g, "*");

export function buildReplayRecordOptions(
  privacy: PublicReplayConfig["capture"]["privacy"],
): Omit<RecordOptions, "emit"> {
  return {
    blockSelector: joinSelectors(REPLAY_BLOCK_SELECTOR_DEFAULT, privacy.blockSelector),
    maskTextSelector: joinSelectors(REPLAY_MASK_TEXT_SELECTOR_DEFAULT, privacy.maskTextSelector),
    maskAllInputs: privacy.maskAllInputs,
    // Passwords stay masked even when a policy turns `maskAllInputs` off;
    // hidden inputs are masked by the event sanitizer.
    maskInputOptions: { password: true },
    maskInputFn: mask,
    maskTextFn: mask,
    inlineImages: false,
    recordCanvas: false,
    collectFonts: false,
    inlineStylesheet: true,
    // rrweb event-detail sampling, not session sampling (replay-sampling.ts).
    sampling: { mousemove: 50, scroll: 150, media: 800, input: "last" },
    slimDOMOptions: "all",
  };
}
