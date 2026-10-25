import {
  createSyntheticBrowserFetch,
  createSyntheticEpi210,
  type SyntheticFixtureMode,
} from "@/lib/replay/tests/synthetic-epi210.core";

/**
 * The development harness's in-browser SYNTHETIC EPI-210 FIXTURE - not Epic,
 * not rrweb. It answers the agreed central v1 responses so the real upload
 * transport can be played through accepted, expired, uncertain, offline and
 * 503 paths. Nothing it says is receipt, readiness or playback evidence.
 */

export type { SyntheticFixtureMode };

export const SYNTHETIC_FIXTURE_BADGE = "Synthetic fixture - not Epic, not rrweb";

export const SYNTHETIC_FIXTURE_MODES: { value: SyntheticFixtureMode; label: string }[] = [
  { value: "accept", label: "Accept" },
  { value: "delay_registration", label: "Delay registration 2 s" },
  { value: "offline", label: "Offline" },
  { value: "fail_503", label: "Fail every batch (503)" },
  { value: "delivery_uncertain_next", label: "Next batch is delivery_uncertain" },
  { value: "expire_capability", label: "Expire capability after first batch" },
  { value: "tiny_batch", label: "Tiny batch (2 KiB)" },
];

export function createHarnessFixture() {
  const fixture = createSyntheticEpi210();
  const browser = createSyntheticBrowserFetch(fixture);
  return { fixture, browser };
}

export type HarnessFixture = ReturnType<typeof createHarnessFixture>;
