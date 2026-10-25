"use client";

import { useMutation } from "@tanstack/react-query";
import { appSignOutMutation } from "./app-sign-out.mutation";

/** Shared by the ordinary app's Logout form and signup's account switch. */
export function useAppSignOut(redirectURL?: string) {
  const mutation = useMutation(appSignOutMutation(redirectURL));
  return {
    handleSignOut: async () => { await mutation.mutateAsync(); },
    formAction: () => { mutation.mutate(); },
    isLoading: mutation.isPending,
    error: mutation.error?.message ?? null,
  };
}
