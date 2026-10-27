import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { cache } from "react";
import { headers } from "next/headers";
import { admin } from "better-auth/plugins";
import { magicLink } from "better-auth/plugins";
import {
  BETTER_AUTH_COOKIE_PREFIX,
  betterAuthCookieNames,
  readBetterAuthCookie,
} from "./provider-cookies";
import { envList } from "@/lib/env-list";

const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:8080";

// The iframe preview is served cross-site over the HTTPS proxy domain, which
// requires Secure + SameSite=None + Partitioned cookies. But the verify phase
// (and any localhost run) drives the app over http://localhost, where Chromium
// silently drops Secure cookies — so sign-in "succeeds" but no session cookie
// sticks and every protected page bounces to /signin. Gate the cookie hardening
// on whether we're actually in a secure (https) context so localhost auth works.
const isSecureContext = baseUrl.startsWith("https://");

export const auth = betterAuth({
  plugins: [
    admin({
      defaultRole: "user",
    }),
    magicLink({
      expiresIn: 3600,
      sendMagicLink: async () => {},
    }),
    ...(process.env.NODE_ENV === "test" ? [] : [nextCookies()]),
  ],
  database: drizzleAdapter(db, {
    provider: "sqlite",
    schema,
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    sendEmailVerificationOnSignUp: false,
  },
  user: {
    additionalFields: {},
  },
  // Where this app is served from is always trusted. Any other origin — the
  // host that frames a preview, for instance — is the environment's to name:
  // Epic sets BETTER_AUTH_TRUSTED_ORIGINS on the machines it runs, so its
  // domains are never frozen into the code. Passed here explicitly because
  // Better Auth reads the variable on init but drops it on the request path.
  trustedOrigins: [
    baseUrl,
    ...envList("BETTER_AUTH_TRUSTED_ORIGINS"),
    "http://localhost:3000",
  ],
  trustedProxyHeaders: true,
  advanced: {
    cookiePrefix: BETTER_AUTH_COOKIE_PREFIX,
    useSecureCookies: isSecureContext,
    defaultCookieAttributes: isSecureContext
      ? {
          sameSite: "none",
          secure: true,
          partitioned: true,
        }
      : {
          sameSite: "lax",
          secure: false,
        },
  },

  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: baseUrl,
});

export const getUser = cache(async () => {
  const requestHeaders = await headers();
  const sessionResponse = await auth.api.getSession({
    headers: requestHeaders,
  });

  if (!sessionResponse || !sessionResponse.user) {
    return {
      user: null,
      sessionToken: null,
      isImpersonating: false,
      impersonatedBy: null,
      impersonationCredential: null,
    };
  }

  // Better Auth getSession returns: { user, session: { id, token, expiresAt, impersonatedBy, ... } }
  // impersonatedBy is stored in session.impersonatedBy
  const sessionData = sessionResponse.session as {
    impersonatedBy?: string | null;
  } & typeof sessionResponse.session;

  // Check impersonatedBy directly from session
  const impersonatedBy = sessionData?.impersonatedBy || null;
  const isImpersonating = !!impersonatedBy;

  return {
    user: sessionResponse.user,
    sessionToken: sessionResponse.session.token,
    isImpersonating,
    impersonatedBy,
    impersonationCredential: readBetterAuthCookie(
      requestHeaders,
      betterAuthCookieNames.adminSession,
    ),
  };
});
