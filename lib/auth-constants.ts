/**
 * Constants shared by the edge middleware and the Node server code.
 *
 * Kept separate from lib/auth.ts on purpose: that module imports node:crypto to
 * sign and verify the session, and the middleware runs on the edge runtime where
 * node:crypto is not available. Importing the cookie name from here keeps the
 * crypto out of the edge bundle.
 */
export const SESSION_COOKIE = "furies_session";
