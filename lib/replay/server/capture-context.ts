import "server-only";

/**
 * The only device context Epic receives: coarse browser/OS/device enums and a
 * major version, derived here from the request's own User-Agent. The enums
 * are Epic's (`REPLAY_*` in its publishing contract); a value outside them is
 * refused centrally. The raw
 * User-Agent is never stored or forwarded.
 */

export const REPLAY_BROWSER_NAMES = ["Chrome", "Safari", "Firefox", "Edge", "Opera", "Samsung Internet", "Other"] as const;
export const REPLAY_OS_NAMES = ["Windows", "macOS", "Linux", "Android", "iOS", "ChromeOS", "Other"] as const;
export const REPLAY_DEVICE_CLASSES = ["desktop", "mobile", "tablet", "other"] as const;

type BrowserName = (typeof REPLAY_BROWSER_NAMES)[number];
type OsName = (typeof REPLAY_OS_NAMES)[number];
type DeviceClass = (typeof REPLAY_DEVICE_CLASSES)[number];

export interface ReplayCaptureContext {
  browser: { name: BrowserName; majorVersion: string | null };
  os: { name: OsName; majorVersion: string | null };
  deviceClass: DeviceClass;
  viewport: { width: number; height: number } | null;
}

/** The subset of Next's `userAgent()` result this module reads. */
export interface UserAgentInfo {
  browser: { name?: string; version?: string };
  os: { name?: string; version?: string };
  device: { type?: string };
}

const BROWSERS: [RegExp, BrowserName][] = [
  [/^(mobile )?safari$/i, "Safari"],
  [/^(chrome|chromium|chrome headless|chrome webview|mobile chrome)$/i, "Chrome"],
  [/^(edge|microsoft edge)$/i, "Edge"],
  [/^(firefox|mobile firefox)$/i, "Firefox"],
  [/^opera( mini| mobile| touch)?$/i, "Opera"],
  [/^samsung ?(internet|browser)$/i, "Samsung Internet"],
];

const OSES: [RegExp, OsName][] = [
  [/^ios$/i, "iOS"],
  [/^(mac ?os|macos)$/i, "macOS"],
  [/^windows/i, "Windows"],
  [/^android/i, "Android"],
  [/^(chromium os|chrome os)$/i, "ChromeOS"],
  [/^(linux|ubuntu|debian|fedora|arch|gentoo|mint|suse|red hat|centos)/i, "Linux"],
];

export function majorVersion(version: string | undefined): string | null {
  const match = /^(\d{1,4})(?:\D|$)/.exec(version ?? "");
  return match ? String(Number(match[1])) : null;
}

function lookup<T extends string>(table: [RegExp, T][], name: string | undefined, fallback: T): T {
  return table.find(([pattern]) => name && pattern.test(name))?.[1] ?? fallback;
}

export function deriveReplayCaptureContext(
  userAgent: UserAgentInfo,
  viewport: { width: number; height: number } | null,
): ReplayCaptureContext {
  const browser = lookup(BROWSERS, userAgent.browser.name, "Other");
  const os = lookup(OSES, userAgent.os.name, "Other");
  const type = userAgent.device.type;
  const desktopOs = os === "Windows" || os === "macOS" || os === "Linux" || os === "ChromeOS";
  const deviceClass: DeviceClass =
    type === "mobile" ? "mobile" : type === "tablet" ? "tablet" : !type && desktopOs ? "desktop" : "other";

  return {
    browser: { name: browser, majorVersion: browser === "Other" ? null : majorVersion(userAgent.browser.version) },
    os: { name: os, majorVersion: os === "Other" ? null : majorVersion(userAgent.os.version) },
    deviceClass,
    viewport,
  };
}
