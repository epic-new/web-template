const INTERNAL_ORIGIN = "http://internal.local";
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;

function isSafeInternalPath(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  if (value.includes("\\") || CONTROL_CHARACTER_PATTERN.test(value)) return false;

  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith("//") || decoded.includes("\\")) return false;

    return new URL(value, INTERNAL_ORIGIN).origin === INTERNAL_ORIGIN;
  } catch {
    return false;
  }
}

export function safeRedirectPath(
  value: string | null | undefined,
  fallback: string,
): string {
  return value && isSafeInternalPath(value) ? value : fallback;
}

/**
 * Await a server action that ends in `redirect()`, treating the redirect as
 * the outcome it is.
 *
 * `redirect()` works by throwing: the client that awaited the action receives
 * Next's `NEXT_REDIRECT` signal after the navigation is already under way. A
 * caller that turns every throw into an error — a mutation, a `catch` with a
 * toast — then reports "NEXT_REDIRECT" on the very path that succeeded.
 * Resolves to `null` on that signal and rethrows anything else.
 */
export async function untilRedirect<T>(action: Promise<T>): Promise<T | null> {
  try {
    return await action;
  } catch (error) {
    if (isRedirectSignal(error)) return null;
    throw error;
  }
}

function isRedirectSignal(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  if (typeof digest === "string") return digest.split(";")[0] === "NEXT_REDIRECT";
  return error instanceof Error && error.message === "NEXT_REDIRECT";
}
