import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // The old /home route is now the root Home page.
  if (pathname === "/home") {
    return NextResponse.redirect(new URL("/", request.url));
  }

  // Skip middleware for public paths. NOTE: "/" is the authenticated Home
  // page now (the public landing page was removed), so it is intentionally
  // NOT excluded here.
  if (
    pathname.startsWith("/auth") ||
    pathname.startsWith("/api") ||
    pathname.startsWith("/admin") ||
    pathname.startsWith("/playground") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/public") ||
    pathname === "/favicon.ico"
  ) {
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
     * Match all request paths (including the root Home page "/") except for:
     * - /auth (authentication pages)
     * - /api (API routes)
     * - /_next/static (static files)
     * - /_next/image (image optimization files)
     * - /favicon.ico (favicon file)
     * - /public (public files)
     * - a file: any path whose last segment has an extension. Next serves
     *   `public/logo.png` at `/logo.png`, never under `/public`, so an image,
     *   font or download in `public/` would otherwise need a session.
     */
    "/((?!auth|api|_next/static|_next/image|favicon.ico|public|.*\\.[\\w]+$).*)",
  ],
};
