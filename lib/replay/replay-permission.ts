import type { PublicReplayConfig } from "./replay-config.contract";
import type { ReplayConsentState } from "./replay-consent";
import { isReplayRouteAllowed } from "./replay-routes";

/**
 * Whether capture is allowed right now. Every gate must pass, in this order,
 * and the first failure is the reason. The sampler is consulted last, so an
 * unconsented or excluded page never draws a sample.
 *
 * `consentMode: "required"` records nothing until the visitor accepts;
 * `"not_required"` treats an unanswered prompt as accepted, while an explicit
 * withdrawal still stops everything.
 */

export type ReplayBlockReason =
  | "policy_disabled"
  | "policy_expired"
  | "consent_absent"
  | "consent_withdrawn"
  | "route_excluded"
  | "not_sampled";

export type ReplayPermission = { allowed: true } | { allowed: false; reason: ReplayBlockReason };

export function evaluateCapturePermission({
  policy,
  consent: consentState,
  pathname,
  sampled,
}: {
  policy: PublicReplayConfig;
  consent: ReplayConsentState;
  pathname: string;
  sampled: () => boolean;
}): ReplayPermission {
  let consent = consentState;
  if (policy.status !== "active") {
    return { allowed: false, reason: policy.reason === "expired" ? "policy_expired" : "policy_disabled" };
  }
  if (!policy.capture.enabled || policy.environment === null) {
    return { allowed: false, reason: "policy_disabled" };
  }
  // Where the application decided consent is not needed, only an opt-out stops capture.
  if (consent === "unknown" && policy.capture.consentMode === "not_required") consent = "granted";
  if (consent === "unknown") return { allowed: false, reason: "consent_absent" };
  if (consent === "withdrawn") return { allowed: false, reason: "consent_withdrawn" };
  if (!isReplayRouteAllowed(pathname, policy.capture.routes)) {
    return { allowed: false, reason: "route_excluded" };
  }
  if (!sampled()) return { allowed: false, reason: "not_sampled" };
  return { allowed: true };
}
