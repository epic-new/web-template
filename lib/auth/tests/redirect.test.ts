import { describe, expect, it } from "vitest";

import { safeRedirectPath, untilRedirect } from "../redirect";

describe("safeRedirectPath", () => {
  it("preserves internal paths with query strings and fragments", () => {
    expect(safeRedirectPath("/projects?page=2#active", "/")).toBe(
      "/projects?page=2#active",
    );
  });

  it.each([
    "https://example.com",
    "//example.com",
    "/\\example.com",
    "/%5Cexample.com",
    "/%2F%2Fexample.com",
  ])("replaces unsafe redirect %s with the fallback", (value) => {
    expect(safeRedirectPath(value, "/auth/signin")).toBe("/auth/signin");
  });
});

describe("untilRedirect", () => {
  it("resolves to null when the action redirects", async () => {
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/home;307;",
    });
    await expect(untilRedirect(Promise.reject(redirect))).resolves.toBeNull();
  });

  it("passes a returned result through", async () => {
    await expect(untilRedirect(Promise.resolve({ error: "Invalid" }))).resolves.toEqual({ error: "Invalid" });
  });

  it("rethrows any other error", async () => {
    await expect(untilRedirect(Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  });
});
