import { mutationOptions } from "@tanstack/react-query";
import { untilRedirect } from "@/lib/auth/redirect";
import { withReplayIdentityBoundary } from "@/lib/replay/replay-identity";
import { signIn } from "./signin.action";

export function signInMutation(redirectURL: string) {
  return mutationOptions({
    mutationFn: (formData: FormData) => withReplayIdentityBoundary(async () => {
      // The action redirects on success (see `untilRedirect`); on failure it returns { error }.
      const result = await untilRedirect(signIn({ error: null }, formData, redirectURL));
      if (result?.error) throw new Error(result.error);
      return result;
    }),
  });
}
