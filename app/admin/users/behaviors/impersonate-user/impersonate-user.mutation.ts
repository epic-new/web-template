import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { usersKeys } from "../../users.query";
import { impersonateUser } from "./impersonate-user.action";
import { withReplayIdentityBoundary } from "@/lib/replay/replay-identity";

export function impersonateUserMutation(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (userId: string) => withReplayIdentityBoundary(async () => {
      const response = await impersonateUser({ userId });
      if (!response.success) throw new Error(response.error);
      return response.data;
    }),
    onSettled: () => queryClient.removeQueries({ queryKey: usersKeys.root }),
  });
}
