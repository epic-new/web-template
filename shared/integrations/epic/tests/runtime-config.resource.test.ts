import { afterEach, describe, expect, it, vi } from "vitest";

import {
  jsonResponse,
  RUNTIME_CONFIG_URL,
  runtimeConfigFixture,
} from "@/lib/replay/tests/runtime-config.fixture";
import { EpicClient, EpicIntegrationError } from "../epic";
import { RuntimeConfigResource } from "../resources/runtime-config.resource";

const env = {
  EPIC_API_URL: "https://epic.test",
  EPIC_PROJECT_ID: "proj-1",
  EPIC_PUBLISHING_TOKEN: "test-publishing-token",
};

describe("RuntimeConfigResource", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches the policy for the configured credential", async () => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(runtimeConfigFixture({ environment: "preview", configVersion: "preview-v7" })),
    );
    vi.stubGlobal("fetch", upstream);
    const client = EpicClient.fromEnv(env)!;

    const resource = await RuntimeConfigResource.fetch(client, {
      signal: new AbortController().signal,
    });

    expect(resource).toMatchObject({ environment: "preview", configVersion: "preview-v7" });
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe(RUNTIME_CONFIG_URL);
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer test-publishing-token",
    );
    expect(init?.cache).toBe("no-store");
  });

  it("sends a protected Epic's bypass secret only when one is configured", async () => {
    const upstream = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse(runtimeConfigFixture()));
    vi.stubGlobal("fetch", upstream);
    const signal = new AbortController().signal;

    await RuntimeConfigResource.fetch(EpicClient.fromEnv(env)!, { signal });
    await RuntimeConfigResource.fetch(
      EpicClient.fromEnv({ ...env, EPIC_VERCEL_PROTECTION_BYPASS: "bypass-secret" })!,
      { signal },
    );

    const bypassOf = (call: number) =>
      new Headers(upstream.mock.calls[call][1]?.headers).get("x-vercel-protection-bypass");
    expect(bypassOf(0)).toBeNull();
    expect(bypassOf(1)).toBe("bypass-secret");
  });

  it("normalizes upstream failures without leaking the credential", async () => {
    const client = EpicClient.fromEnv(env)!;
    const responses: Array<() => Promise<Response>> = [
      async () => new Response(null, { status: 401 }),
      async () => new Response(null, { status: 503 }),
      async () => {
        throw new TypeError("network down");
      },
      async () => new Response("not json", { status: 200 }),
    ];
    const codes: string[] = [];

    for (const respond of responses) {
      vi.stubGlobal("fetch", vi.fn(respond));
      const error = await RuntimeConfigResource.fetch(client).catch((e) => e);
      expect(error).toBeInstanceOf(EpicIntegrationError);
      codes.push(error.code);
      const rendered = [error.message, JSON.stringify(error.cause ?? null), String(error)].join(" ");
      expect(rendered).not.toContain("test-publishing-token");
    }

    expect(codes).toEqual(["unauthorized", "unavailable", "unavailable", "invalid_response"]);
    expect(JSON.stringify(client)).not.toContain("test-publishing-token");
  });

  it("returns no client when the credential is missing", () => {
    expect(
      EpicClient.fromEnv({ EPIC_API_URL: "https://epic.test", EPIC_PROJECT_ID: "proj-1" }),
    ).toBeNull();
  });
});
