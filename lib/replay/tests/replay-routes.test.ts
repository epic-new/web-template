import { describe, expect, it } from "vitest";

import { isReplayRouteAllowed, normalizeReplayPath } from "../replay-routes";

describe("normalizeReplayPath", () => {
  it.each([
    ["/styleguide/replay/excluded/?x=1", "/styleguide/replay/excluded"],
    ["//a///b#c", "/a/b"],
    ["/caf%C3%A9", "/café"],
    ["/bad%E0%A4%A", "/bad%E0%A4%A"],
    ["/", "/"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeReplayPath(input)).toBe(expected);
  });
});

describe("isReplayRouteAllowed", () => {
  it("lets exclude win over include", () => {
    expect(isReplayRouteAllowed("/admin/users", { include: ["/admin/*"], exclude: ["/admin/users"] })).toBe(false);
    expect(isReplayRouteAllowed("/admin/roles", { include: ["/admin/*"], exclude: ["/admin/users"] })).toBe(true);
  });

  it("matches a normalized path", () => {
    expect(
      isReplayRouteAllowed("/styleguide/replay/excluded/?x=1", {
        include: [],
        exclude: ["/styleguide/replay/excluded"],
      }),
    ).toBe(false);
  });

  it("allows every route when include is empty", () => {
    expect(isReplayRouteAllowed("/", { include: [], exclude: [] })).toBe(true);
  });

  it("requires an include match when include is set", () => {
    expect(isReplayRouteAllowed("/settings", { include: ["/"], exclude: [] })).toBe(false);
    expect(isReplayRouteAllowed("/settings", { include: ["/*"], exclude: [] })).toBe(true);
  });

  it("matches prefix wildcards on the prefix itself and params on one segment", () => {
    const routes = { include: [], exclude: ["/admin/*", "/users/:id"] };
    expect(isReplayRouteAllowed("/admin", routes)).toBe(false);
    expect(isReplayRouteAllowed("/administrator", routes)).toBe(true);
    expect(isReplayRouteAllowed("/users/42", routes)).toBe(false);
    expect(isReplayRouteAllowed("/users/42/edit", routes)).toBe(true);
  });

  it("always excludes the built-in routes", () => {
    expect(isReplayRouteAllowed("/api/epic/replay/config", { include: [], exclude: [] })).toBe(false);
    expect(isReplayRouteAllowed("/_next/static/x.js", { include: [], exclude: [] })).toBe(false);
  });
});
