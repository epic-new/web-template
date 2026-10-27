import { EpicRuntimeLoader } from "./epic-runtime-loader";

/**
 * Epic's runtime for this app — session replay, its consent prompt and the
 * bug-report button — loaded from Epic rather than kept here, so a fix to any
 * of it reaches this app on its next page load instead of never.
 *
 * Renders nothing unless this deployment is registered with Epic
 * (`EPIC_API_URL` and `EPIC_PUBLISHING_TOKEN`). What the runtime may record is
 * Epic's policy for this environment, and nothing is recorded before the
 * visitor consents; mark anything that must never leave the browser with
 * `data-private`. Its requests go only to this app's own `/api/epic` route,
 * which adds the credential.
 */
export function EpicRuntime() {
  const apiUrl = process.env.EPIC_API_URL;
  if (!apiUrl || !process.env.EPIC_PUBLISHING_TOKEN) return null;

  let src: string;
  try {
    src = new URL("/api/epic-runtime", apiUrl).toString();
  } catch {
    return null;
  }
  // The build this document belongs to, stamped on what it records. Public by design.
  const release = process.env.EPIC_RELEASE || process.env.VERCEL_GIT_COMMIT_SHA || "";
  return <EpicRuntimeLoader src={src} release={release} />;
}
