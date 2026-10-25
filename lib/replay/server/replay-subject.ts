import "server-only";

import { createHmac } from "node:crypto";

export type ReplayActor =
  | { kind: "user"; userId: string }
  | { kind: "anonymous"; visitorId: string };

// Versioned so a future derivation can coexist with this one.
const SUBJECT_DOMAIN = "epic-replay-subject:v1";

/**
 * The opaque subject Epic sees for an identity: `sub_` plus a base64url
 * HMAC-SHA256 under the application's auth secret. It is keyed by neither the
 * publishing token (which rotates) nor any email or name, so it stays stable
 * across token rotation and reveals nothing about the person.
 */
export function deriveReplaySubject(actor: ReplayActor, secret: string): string {
  const id = actor.kind === "user" ? actor.userId : actor.visitorId;
  const digest = createHmac("sha256", secret)
    .update(`${SUBJECT_DOMAIN}:${actor.kind}:${id}`)
    .digest("base64url");
  return `sub_${digest}`;
}

/**
 * The key replay identities are derived under: `EPIC_REPLAY_SECRET` when set,
 * else the app's auth secret. A dedicated key lets the auth secret rotate
 * without silently re-keying every replay subject and visitor cookie.
 */
export function replaySecret(): string | undefined {
  return process.env.EPIC_REPLAY_SECRET || process.env.BETTER_AUTH_SECRET || undefined;
}
