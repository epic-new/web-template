import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // The old /home route is now the root Home page.
  if (pathname === "/home") {
    return NextResponse.redirect(new URL("/", request.url));
  }

  // Pages that guard themselves. "/" is the authenticated Home page, so it is
  // intentionally not here; static files never reach this function (see the
  // matcher).
  if (pathname.startsWith("/admin") || pathname.startsWith("/playground")) {
    return NextResponse.next();
  }

  const sessionCookie = getSessionCookie(request, {
    cookiePrefix: "sandbox-auth",
  });

  // THIS IS NOT SECURE!
  // This is the recommended approach to optimistically redirect users
  // We recommend handling auth checks in each page/route
  if (!sessionCookie) {
    const redirectUrl = new URL("/auth/signin", request.url);
    redirectUrl.searchParams.set(
      "redirectTo",
      request.nextUrl.pathname + request.nextUrl.search
    );
    return NextResponse.redirect(redirectUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Every path except:
     * - /auth and /api, which are public or authenticate themselves
     * - /_next, Next's own assets
     * - a file: any path whose last segment has an extension. Next serves
     *   `public/logo.png` at `/logo.png`, never under `/public`, so an image,
     *   font or download in `public/` would otherwise need a session.
     */
    "/((?!auth|api|_next/|.*\\.[\\w]+$).*)",
  ],
};
