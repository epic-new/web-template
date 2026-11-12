import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config, proxy } from "./proxy";

const runsProxy = (path: string) =>
  unstable_doesMiddlewareMatch({ config, url: `http://localhost${path}` });

describe("proxy", () => {
  it("lets the Workflow runtime call the app without a session", () => {
    expect(runsProxy("/.well-known/workflow/v1/flow")).toBe(false);
    expect(runsProxy("/.well-known/workflow/v1/step")).toBe(false);
  });

  it("still sends the rest of /.well-known/ and pages to sign-in", async () => {
    expect(runsProxy("/.well-known/anything-else")).toBe(true);
    expect(runsProxy("/")).toBe(true);
    expect(runsProxy("/settings")).toBe(true);

    const response = await proxy(
      new NextRequest("http://localhost/.well-known/anything-else")
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost/auth/signin?redirectTo=%2F.well-known%2Fanything-else"
    );
  });
});
