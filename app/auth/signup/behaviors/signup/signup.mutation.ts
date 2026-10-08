import { mutationOptions } from "@tanstack/react-query";
import { untilRedirect } from "@/lib/auth/redirect";

import { HOME_URL } from "@/app.config";
import { signup } from "./signup.action";

export function signupMutation(redirectURL: string = HOME_URL) {
  return mutationOptions({
    mutationFn: async (formData: FormData) => {
      const result = await untilRedirect(signup({ error: null }, formData, redirectURL));
      if (result?.error) throw new Error(result.error);
      return result;
    },
  });
}
