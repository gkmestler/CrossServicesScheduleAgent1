import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";

import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

/**
 * The real authentication check. Middleware only looks for a cookie; this
 * verifies the signature and expiry, and every page and route handler calls it.
 */

export async function hasValidSession(): Promise<boolean> {
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value);
}

/** For server components. Redirects to the login screen when unauthenticated. */
export async function requireSession(): Promise<void> {
  if (!(await hasValidSession())) redirect("/login");
}

/**
 * For route handlers. Returns a 401 response to return early, or null when the
 * request is authenticated.
 */
export async function requireApiSession(): Promise<NextResponse | null> {
  if (await hasValidSession()) return null;
  return NextResponse.json({ error: "Not signed in." }, { status: 401 });
}
