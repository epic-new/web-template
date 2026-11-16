import { createEpicRoute } from "@epicnew/analytics/next";

import { getUser } from "@/lib/auth";

const bypass = process.env.EPIC_VERCEL_PROTECTION_BYPASS;

export const { GET, POST } = createEpicRoute({
  // The auth secret keeps the pseudonyms people were already recorded under.
  secret: process.env.EPIC_SECRET || process.env.EPIC_REPLAY_SECRET || process.env.BETTER_AUTH_SECRET,
  // Only an Epic behind Vercel Deployment Protection (staging) asks for it.
  upstreamHeaders: bypass ? { "x-vercel-protection-bypass": bypass } : undefined,
  async currentUserId() {
    const { user } = await getUser();
    return user?.id;
  },
});
