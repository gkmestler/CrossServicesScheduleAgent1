/**
 * Auth bits shared by the edge middleware, the browser and the Node server code.
 *
 * Kept separate from lib/auth.ts on purpose: that module imports node:crypto to
 * sign and verify the session, and the middleware runs on the edge runtime where
 * node:crypto is not available. Importing from here keeps the crypto out of the
 * edge and client bundles.
 */
export const SESSION_COOKIE = "furies_session";

/**
 * Where to send someone after signing in, from the `?next=` the login redirect
 * carries. Only a path on this site is allowed — `//evil.example` starts with a
 * slash but is a protocol-relative URL off to someone else's server.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/")) return "/";
  if (next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}
