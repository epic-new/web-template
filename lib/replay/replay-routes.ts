/**
 * Route eligibility for replay capture.
 *
 * Patterns are exact (`/settings`), prefix wildcards (`/admin/*`, which also
 * matches `/admin` itself) or carry single-segment params (`/users/:id`).
 * Exclude wins over include, an empty include means every route, and the
 * built-in exclusions always apply.
 */

export const BUILT_IN_REPLAY_EXCLUSIONS = ["/api/*", "/_next/*"] as const;

export function normalizeReplayPath(pathname: string): string {
  let path = pathname.split(/[?#]/, 1)[0] ?? "";
  try {
    path = decodeURI(path);
  } catch {
    // Malformed percent-encoding: match on the raw path.
  }
  path = path.replace(/\/{2,}/g, "/");
  if (!path.startsWith("/")) path = `/${path}`;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path;
}

function segments(path: string): string[] {
  return path === "/" ? [] : path.slice(1).split("/");
}

function matches(path: string, pattern: string): boolean {
  const normalized = normalizeReplayPath(pattern);
  const prefix = normalized === "/*" || normalized.endsWith("/*");
  const patternSegments = segments(prefix ? normalized.slice(0, -2) || "/" : normalized);
  const pathSegments = segments(path);

  if (prefix ? pathSegments.length < patternSegments.length : pathSegments.length !== patternSegments.length) {
    return false;
  }
  return patternSegments.every(
    (segment, index) => segment.startsWith(":") || segment === pathSegments[index],
  );
}

export function isReplayRouteAllowed(
  pathname: string,
  routes: { include: readonly string[]; exclude: readonly string[] },
): boolean {
  const path = normalizeReplayPath(pathname);
  const excluded = [...BUILT_IN_REPLAY_EXCLUSIONS, ...routes.exclude];
  if (excluded.some((pattern) => matches(path, pattern))) return false;
  return routes.include.length === 0 || routes.include.some((pattern) => matches(path, pattern));
}
