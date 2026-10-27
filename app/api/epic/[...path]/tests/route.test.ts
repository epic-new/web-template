import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ user: null as { id: string } | null }));
vi.mock("@/lib/auth", () => ({ getUser: async () => ({ user: session.user }) }));

import { DELETE, GET, POST } from "../route";

/**
 * The app's pipe to Epic, against a real local server standing in for Epic:
 * what reaches it, what the page gets back, and what never leaves the app.
 */

const APP = "http://localhost:8080";
const SECRET = "x".repeat(32);

type Received = { method: string; url: string; headers: IncomingHttpHeaders; body: string };
let epic: Server;
let received: Received[] = [];
let answer = { status: 200, body: '{"ok":true}' };

beforeAll(async () => {
  epic = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({ method: request.method!, url: request.url!, headers: request.headers, body: Buffer.concat(chunks).toString() });
      response.writeHead(answer.status, { "content-type": "application/json", "retry-after": "7", "set-cookie": "epic=1" });
      response.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => epic.listen(0, "127.0.0.1", resolve));
});

afterAll(() => new Promise<void>((resolve) => epic.close(() => resolve())));

beforeEach(() => {
  received = [];
  answer = { status: 200, body: '{"ok":true}' };
  session.user = null;
  vi.stubEnv("EPIC_API_URL", `http://127.0.0.1:${(epic.address() as AddressInfo).port}`);
  vi.stubEnv("EPIC_PUBLISHING_TOKEN", "epr_test");
  vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
  vi.stubEnv("NEXT_PUBLIC_BASE_URL", APP);
  vi.stubEnv("EPIC_REPLAY_ANONYMOUS_CAPTURE", "");
  vi.stubEnv("EPIC_REPLAY_ANONYMOUS_REPORTING", "");
});

function call(method: "GET" | "POST" | "DELETE", path: string, init: { body?: string; headers?: Record<string, string> } = {}) {
  const request = new NextRequest(`${APP}/api/epic/${path}`, {
    method,
    headers: { ...(method === "GET" ? {} : { origin: APP, "content-type": "application/json" }), ...init.headers },
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  const context = { params: Promise.resolve({ path: path.split("/") }) };
  return (method === "GET" ? GET : method === "POST" ? POST : DELETE)(request, context);
}

describe("/api/epic/[...path]", () => {
  it("forwards what the page sent, as sent, with the credential and the person's pseudonym", async () => {
    session.user = { id: "user-1" };

    const response = await call("POST", "telemetry", {
      body: '{"resourceLogs":[]}',
      headers: { "user-agent": "Mozilla/5.0 Test", cookie: "sandbox-auth.session_token=secret" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("retry-after")).toBe("7");
    expect(response.headers.get("set-cookie")).toBeNull();
    const [forwarded] = received;
    expect(forwarded).toMatchObject({ method: "POST", url: "/api/replay/v1/relay/telemetry", body: '{"resourceLogs":[]}' });
    expect(forwarded!.headers.authorization).toBe("Bearer epr_test");
    expect(forwarded!.headers["x-epic-subject"]).toMatch(/^sub_[A-Za-z0-9_-]{43}$/);
    expect(forwarded!.headers["x-epic-subject-kind"]).toBe("user");
    expect(forwarded!.headers["x-epic-user-agent"]).toBe("Mozilla/5.0 Test");
    expect(JSON.stringify(forwarded!.headers)).not.toContain("user-1");
    expect(forwarded!.headers.cookie).toBeUndefined();
  });

  it("passes Epic's refusal through to the page", async () => {
    session.user = { id: "user-1" };
    answer = { status: 429, body: '{"code":"rate_limited"}' };

    const response = await call("POST", "telemetry", { body: "{}" });

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ code: "rate_limited" });
  });

  it("forwards a read of any path without a subject when nobody is signed in", async () => {
    const response = await call("GET", "config");

    expect(response.status).toBe(200);
    expect(received[0]!.url).toBe("/api/replay/v1/relay/config");
    expect(received[0]!.headers["x-epic-subject"]).toBeUndefined();
  });

  it("refuses a write from another site without calling Epic", async () => {
    session.user = { id: "user-1" };

    const response = await call("POST", "telemetry", { body: "{}", headers: { origin: "https://evil.example" } });

    expect(response.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it("refuses a body over the cap without calling Epic", async () => {
    const response = await call("POST", "telemetry", {
      body: "x",
      headers: { "content-length": String(5 * 1024 * 1024) },
    });

    expect(response.status).toBe(413);
    expect(received).toHaveLength(0);
  });

  it("answers not_configured and calls nobody when the deployment is not registered", async () => {
    vi.stubEnv("EPIC_PUBLISHING_TOKEN", "");

    const response = await call("GET", "config");

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "not_configured" });
  });

  describe("identity", () => {
    it("names a signed-in person without a cookie", async () => {
      session.user = { id: "user-1" };

      const response = await call("POST", "identity", { body: "{}" });

      expect(await response.json()).toEqual({ contractVersion: 1, kind: "user", anonymous: [] });
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(received).toHaveLength(0);
    });

    it("mints a visitor only where this deployment allows it, and the visitor is then forwarded", async () => {
      expect(await (await call("POST", "identity", { body: "{}" })).json()).toMatchObject({ kind: null });

      vi.stubEnv("EPIC_REPLAY_ANONYMOUS_REPORTING", "allow");
      const minted = await call("POST", "identity", { body: "{}" });
      expect(await minted.json()).toEqual({ contractVersion: 1, kind: "visitor", anonymous: ["report"] });
      const cookie = minted.headers.get("set-cookie")!;
      expect(cookie).toMatch(/^epic_replay_visitor=[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]+; Path=\/api\/epic;/);

      await call("POST", "reports", { body: "{}", headers: { cookie: cookie.split(";")[0]! } });
      expect(received[0]!.headers["x-epic-subject-kind"]).toBe("visitor");
      expect(received[0]!.headers["x-epic-anonymous"]).toBe("report");
    });

    it("ignores a visitor cookie it did not sign", async () => {
      vi.stubEnv("EPIC_REPLAY_ANONYMOUS_CAPTURE", "allow");

      await call("POST", "telemetry", { body: "{}", headers: { cookie: `epic_replay_visitor=${"a".repeat(43)}.forged` } });

      expect(received[0]!.headers["x-epic-subject"]).toBeUndefined();
    });

    it("forgets the visitor on DELETE", async () => {
      const response = await call("DELETE", "identity");

      expect(response.headers.get("set-cookie")).toMatch(/^epic_replay_visitor=; .*Max-Age=0/);
    });
  });
});
