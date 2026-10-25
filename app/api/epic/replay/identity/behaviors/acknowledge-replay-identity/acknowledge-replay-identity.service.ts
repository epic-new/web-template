import "server-only";

import { replayIdentityRequestSchema } from "@/lib/replay/replay-upload-contract";
import { isAnonymousReplayAllowed } from "@/lib/replay/server/replay-request";
import { ReplayUploadError } from "@/lib/replay/server/replay-upload-error";
import { relayFailure } from "@/lib/replay/server/relay-failure";

export interface AcknowledgeReplayIdentityCommand {
  /** The signed-in user, from the session. */
  user: { userId: string } | null;
  /** A visitor whose signed cookie already verified. */
  visitorId: string | null;
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
      if (!process.env.BETTER_AUTH_SECRET) throw new ReplayUploadError("not_configured");

      if (command.user) return { mintVisitor: false };
      if (!isAnonymousReplayAllowed(input.purpose ?? "capture")) {
        throw new ReplayUploadError("identity_required");
      }
      return { mintVisitor: command.visitorId === null };
    } catch (error) {
      throw relayFailure(error);
    }
  }
}
