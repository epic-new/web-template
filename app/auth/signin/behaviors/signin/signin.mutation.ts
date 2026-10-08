import { mutationOptions } from "@tanstack/react-query";
import { untilRedirect } from "@/lib/auth/redirect";
import { signIn } from "./signin.action";

export function signInMutation(redirectURL: string) {
  return mutationOptions({
    mutationFn: async (formData: FormData) => {
      // The action redirects on success (see `untilRedirect`); on failure it returns { error }.
      const result = await untilRedirect(signIn({ error: null }, formData, redirectURL));
      if (result?.error) throw new Error(result.error);
      return result;
    },
  });
}
