'use client';

import { useRefreshReplayPolicy } from '@/app/api/epic/replay/config/behaviors/refresh-replay-policy/use-refresh-replay-policy.hook';

/**
 * Keeps the replay policy fresh and hands it to the replay lifecycle manager.
 * Mounted once at the root so every route group shares one loader. Renders
 * nothing and starts no capture.
 */
export function ReplayPolicyLoader() {
  useRefreshReplayPolicy();
  return null;
}
