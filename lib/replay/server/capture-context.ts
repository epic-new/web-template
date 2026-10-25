import "server-only";

import type { ReplayViewport } from "@/lib/replay/replay-upload-contract";

/**
 * Coarse, reported display context for a recording, derived from the
 * application's own incoming request (Next's `userAgent()` parser) plus the
 * browser's bounded initial viewport. The raw User-Agent is never kept or
 * forwarded, and none of this is identity or ownership.
 */

export interface ReplayUserAgent {
  ua: string;
  browser: { name?: string; version?: string };
  os: { name?: string; version?: string };
  device: { type?: string };
}

export type ReplayBrowserName = "Chrome" | "Edge" | "Firefox" | "Safari" | "Opera" | "Other" | "Unknown";
export type ReplayOsName = "Windows" | "macOS" | "iOS" | "Android" | "Linux" | "Other" | "Unknown";
export type ReplayDeviceClass = "desktop" | "tablet" | "mobile" | "unknown";

export interface ReplayCaptureContext {
  browser: { name: ReplayBrowserName; majorVersion: string | null };
  os: { name: ReplayOsName; majorVersion: string | null };
  deviceClass: ReplayDeviceClass;
  viewport: ReplayViewport | null;
}

function majorVersion(version: string | undefined): string | null {
  const major = version?.split(".", 1)[0];
  return major && /^\d{1,4}$/.test(major) ? major : null;
}

function browserName(name: string | undefined): ReplayBrowserName {
  if (!name) return "Unknown";
  const value = name.toLowerCase();
  if (value.includes("edge")) return "Edge";
  if (value.includes("opera")) return "Opera";
  if (value.includes("firefox")) return "Firefox";
  if (value.includes("chrom")) return "Chrome";
  if (value.includes("safari")) return "Safari";
  return "Other";
}

function osName(name: string | undefined): ReplayOsName {
  if (!name) return "Unknown";
  const value = name.toLowerCase();
  if (value.includes("windows")) return "Windows";
  if (value === "ios") return "iOS";
  if (value.includes("mac")) return "macOS";
  if (value.includes("android")) return "Android";
  if (["linux", "ubuntu", "debian", "fedora", "arch", "mint", "centos", "red hat"].some((n) => value.includes(n))) {
    return "Linux";
  }
  return "Other";
}

function deviceClass(ua: ReplayUserAgent, browser: ReplayBrowserName, os: ReplayOsName): ReplayDeviceClass {
  if (ua.device.type === "mobile") return "mobile";
  if (ua.device.type === "tablet") return "tablet";
  if (ua.device.type) return "unknown";
  return browser === "Unknown" && os === "Unknown" ? "unknown" : "desktop";
}

export function deriveCaptureContext(
  ua: ReplayUserAgent,
  viewport: ReplayViewport | null,
): ReplayCaptureContext {
  const browser = browserName(ua.browser.name);
  const os = osName(ua.os.name);
  return {
    browser: { name: browser, majorVersion: browser === "Unknown" ? null : majorVersion(ua.browser.version) },
    os: { name: os, majorVersion: os === "Unknown" ? null : majorVersion(ua.os.version) },
    deviceClass: deviceClass(ua, browser, os),
    viewport: viewport ? { width: viewport.width, height: viewport.height } : null,
  };
}
