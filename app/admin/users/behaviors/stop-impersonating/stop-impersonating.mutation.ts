import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { usersKeys } from "../../users.query";
import { stopImpersonating } from "./stop-impersonating.action";
import { withReplayIdentityBoundary } from "@/lib/replay/replay-identity";

export function stopImpersonatingMutation(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: () => withReplayIdentityBoundary(async () => {
      const response = await stopImpersonating();
      if (!response.success) throw new Error(response.error);
      return response.data;
    }),
    onSettled: () => queryClient.removeQueries({ queryKey: usersKeys.root }),
  });
}
