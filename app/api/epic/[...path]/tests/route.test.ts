import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ user: null as { id: string } | null }));
vi.mock("@/lib/auth", () => ({ getUser: async () => ({ user: session.user }) }));

import { GET, POST } from "../route";

/**
 * The app's pipe to Epic, against a real local server standing in for Epic:
 * what reaches it, what the page gets back, and what never leaves the app.
 */

const APP = "http://localhost:8080";

type Received = { method: string; url: string; headers: IncomingHttpHeaders; body: string };
let epic: Server;
let received: Received[] = [];

beforeAll(async () => {
  epic = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({ method: request.method!, url: request.url!, headers: request.headers, body: Buffer.concat(chunks).toString() });
      response.writeHead(200, { "content-type": "application/json", "retry-after": "7", "set-cookie": "epic=1" });
      response.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => epic.listen(0, "127.0.0.1", resolve));
});

afterAll(() => new Promise<void>((resolve) => epic.close(() => resolve())));

beforeEach(() => {
  received = [];
  session.user = null;
  vi.stubEnv("EPIC_API_URL", `http://127.0.0.1:${(epic.address() as AddressInfo).port}`);
  vi.stubEnv("EPIC_PUBLISHING_TOKEN", "epr_test");
  vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(32));
  vi.stubEnv("NEXT_PUBLIC_BASE_URL", APP);
});

function call(method: "GET" | "POST", path: string, headers: Record<string, string> = {}) {
  const request = new NextRequest(`${APP}/api/epic/${path}`, {
    method,
    headers: { ...(method === "POST" ? { "sec-fetch-site": "same-origin", "content-type": "application/json" } : {}), ...headers },
    ...(method === "POST" ? { body: "{}" } : {}),
  });
  return (method === "GET" ? GET : POST)(request, { params: Promise.resolve({ path: path.split("/") }) });
}

describe("/api/epic/[...path]", () => {
  it("forwards the request with the credential and a pseudonym, and nothing that locates the person", async () => {
    session.user = { id: "user-1" };

    const response = await call("POST", "telemetry", {
      "user-agent": "Mozilla/5.0 Test",
      cookie: "session=secret",
      "x-vercel-ip-country": "BR",
      "x-forwarded-for": "203.0.113.9",
      "x-vercel-oidc-token": "secret",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(response.headers.get("set-cookie")).toBeNull();
    const [forwarded] = received;
    expect(forwarded).toMatchObject({ method: "POST", url: "/api/replay/v1/relay/telemetry", body: "{}" });
    expect(forwarded!.headers).toMatchObject({
      authorization: "Bearer epr_test",
      "x-epic-pipe": "2",
      "x-epic-subject-kind": "user",
      "x-epic-fwd-user-agent": "Mozilla/5.0 Test",
      "x-epic-fwd-x-vercel-ip-country": "BR",
    });
    expect(forwarded!.headers["x-epic-subject"]).toMatch(/^sub_[A-Za-z0-9_-]{43}$/);
    const sent = JSON.stringify(forwarded!.headers);
    for (const leaked of ["user-1", "secret", "203.0.113.9"]) expect(sent).not.toContain(leaked);
  });

  it("refuses a write from another site without calling Epic", async () => {
    const response = await call("POST", "telemetry", { "sec-fetch-site": "cross-site" });

    expect(response.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it("answers not_configured and calls nobody when the deployment is not registered", async () => {
    vi.stubEnv("EPIC_PUBLISHING_TOKEN", "");

    expect((await call("GET", "config")).status).toBe(503);
    expect(received).toHaveLength(0);
  });

  it("names a visitor only once the runtime asks, then by the cookie it set", async () => {
    await call("POST", "identity");
    expect(received[0]!.headers["x-epic-subject"]).toBeUndefined();

    const minted = await call("POST", "identity", { "x-epic-visitor": "mint" });
    const cookie = minted.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^epic_replay_visitor=[\w-]{43}; Path=\/api\/epic; .*HttpOnly/);

    await call("POST", "reports", { cookie: cookie.split(";")[0]! });
    expect(received[1]!.headers["x-epic-subject-kind"]).toBe("visitor");
    expect(received[2]!.headers["x-epic-subject"]).toBe(received[1]!.headers["x-epic-subject"]);
  });
});
