import "server-only";

import { createHmac } from "node:crypto";

import type { ReplaySubject } from "@/shared/policies/replay-recording.policy";

/**
 * Who a replay recording belongs to, as established by the application's own
 * authentication. Never read from browser input.
 */
export type ReplayActor =
  | { kind: "user"; userId: string }
  | { kind: "anonymous"; visitorId: string };

/**
 * The opaque subject sent to Epic. It is keyed with the application's stable
 * identity secret (`BETTER_AUTH_SECRET`), never the rotating publishing
 * token, so rotating `EPIC_PUBLISHING_TOKEN` keeps every subject. No email,
 * name or raw identifier leaves the server.
 */
export function deriveReplaySubject(actor: ReplayActor, secret: string): ReplaySubject {
  const id = actor.kind === "user" ? actor.userId : actor.visitorId;
  const digest = createHmac("sha256", secret)
    .update(`epic-replay-subject:v1:${actor.kind}:${id}`)
    .digest("base64url");
  return { subjectId: `sub_${digest}` };
}
