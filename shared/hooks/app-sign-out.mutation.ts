import { mutationOptions } from "@tanstack/react-query";
import { SIGNIN_URL } from "@/app.config";
import { untilRedirect } from "@/lib/auth/redirect";
import { withReplayIdentityBoundary } from "@/lib/replay/replay-identity";
import { signOut } from "@/shared/actions/sign-out.action";

/** The existing auth-only Action, with a synchronous replay boundary. */
export function appSignOutMutation(redirectURL: string = SIGNIN_URL) {
  return mutationOptions({
    mutationFn: () => withReplayIdentityBoundary(() => untilRedirect(signOut(true, redirectURL))),
  });
}
