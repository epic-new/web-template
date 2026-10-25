import "server-only";

import { createHmac } from "node:crypto";

import { replaySecret } from "@/lib/replay/server/replay-subject";
import { replayIdentityRequestSchema } from "@/lib/replay/replay-upload-contract";
import { isAnonymousReplayAllowed } from "@/lib/replay/server/replay-request";
import { ReplayUploadError } from "@/lib/replay/server/replay-upload-error";
import { relayFailure } from "@/lib/replay/server/relay-failure";
import { ReplayRecordingModel } from "@/shared/models/replay-recording";

/**
 * New anonymous visitors per network address. Every minted cookie is a fresh
 * subject with its own budgets, so without this one client could mint
 * thousands and drain the application's shared limits at Epic.
 */
const VISITOR_MINT_RATE = { limit: 20, windowMs: 60_000 };

export interface AcknowledgeReplayIdentityCommand {
  /** The signed-in user, from the session. */
  user: { userId: string } | null;
  /** A visitor whose signed cookie already verified. */
  visitorId: string | null;
  /** The client's network address as the platform reports it, or null. */
  clientAddress: string | null;
  input: unknown;
}

export interface IdentityAcknowledgment {
  /** The route must mint a protected visitor cookie before answering. */
  mintVisitor: boolean;
}

/**
 * The identity handshake that precedes registration and anonymous reports.
 * It makes no central call and writes nothing: a lost response can be retried
 * and the subject Epic later sees cannot change under it, because the
 * anonymous cookie is minted here and nowhere else.
 */
export class AcknowledgeReplayIdentity {
  static async execute(command: AcknowledgeReplayIdentityCommand): Promise<IdentityAcknowledgment> {
    try {
      const input = replayIdentityRequestSchema.parse(command.input);
      if (!replaySecret()) throw new ReplayUploadError("not_configured");

      if (command.user) return { mintVisitor: false };
      if (!isAnonymousReplayAllowed(input.purpose ?? "capture")) {
        throw new ReplayUploadError("identity_required");
      }
      if (command.visitorId !== null) return { mintVisitor: false };

      // Keyed by an HMAC so no raw address is stored.
      const addressKey = `ip_${createHmac("sha256", replaySecret()!).update(`ip:${command.clientAddress ?? "unknown"}`).digest("base64url")}`;
      const now = Date.now();
      await ReplayRecordingModel.pruneRate("identity", now - 10 * VISITOR_MINT_RATE.windowMs);
      const rate = await ReplayRecordingModel.consumeRate(addressKey, "identity", { ...VISITOR_MINT_RATE, now });
      if (!rate.allowed) throw new ReplayUploadError("rate_limited", { retryAfterMs: rate.retryAfterMs });
      return { mintVisitor: true };
    } catch (error) {
      throw relayFailure(error);
    }
  }
}
