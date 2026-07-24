import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE } from "@/lib/auth-constants";

/**
 * Cheap routing gate only.
 *
 * Middleware runs on the edge runtime, which cannot verify the HMAC (node:crypto
 * is not available there), so this checks nothing more than whether a session
 * cookie exists. The real check is `requireSession()` in lib/session.ts, which
 * every page and route handler calls server-side. A forged cookie gets past this
 * redirect and is then rejected there.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasCookie = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  if (pathname === "/login") {
    if (hasCookie) return NextResponse.redirect(new URL("/", request.url));
    return NextResponse.next();
  }

  if (!hasCookie) {
    const url = new URL("/login", request.url);
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Everything except Next internals, the login API and static files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/auth).*)"],
};
