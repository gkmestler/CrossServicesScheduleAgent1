/**
 * Turning a thrown error into something the scheduler can act on.
 *
 * Route handlers that throw return an HTML 500, which the client cannot parse,
 * so the UI ends up showing a useless "that did not work". These helpers make
 * every failure come back as JSON with a message that names the actual cause —
 * without leaking a connection string, an API key, or a door code on the way.
 */

/** Strips anything credential-shaped out of a message bound for the browser. */
export function toSafeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[connection string]")
    .replace(/\bsk-ant-[A-Za-z0-9_-]+/g, "[Anthropic key]")
    .replace(/\bAIza[A-Za-z0-9_-]+/g, "[Google key]")
    .replace(/\b\d{4,6}\b(?=\s*$)/g, "[redacted]")
    .trim();
}

/**
 * Recognises the handful of failures that actually happen during setup and says
 * what to do about them, rather than surfacing raw driver text.
 */
export function describeFailure(error: unknown): string {
  const message = toSafeMessage(error);

  // Missing tables — the most likely first-deploy failure by far. `db:push`
  // runs from a laptop, so it is easy to set DATABASE_URL in Vercel and forget
  // that nothing has created the schema yet.
  if (/relation .* does not exist|no such table|undefined_table/i.test(message)) {
    return (
      "The database is reachable but its tables have not been created yet. " +
      "Run `npm run db:push` locally with DATABASE_URL set to the same Supabase " +
      "connection string, then try again."
    );
  }

  if (/DATABASE_URL is not set/i.test(message)) return message;

  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    return (
      "The database host could not be found. Check DATABASE_URL — it should be the " +
      "Supabase transaction pooler string on port 6543, not the direct connection."
    );
  }

  if (/ECONNREFUSED|ETIMEDOUT|CONNECT_TIMEOUT|Connection terminated/i.test(message)) {
    return (
      "Could not reach the database. If the Supabase project has been idle for a week " +
      "it will have paused itself — open the Supabase dashboard and resume it, then try again."
    );
  }

  if (/password authentication failed|SASL|28P01/i.test(message)) {
    return (
      "The database rejected the password in DATABASE_URL. If it was recently reset, " +
      "update the connection string in Vercel and redeploy."
    );
  }

  if (/Tenant or user not found|XX000/i.test(message)) {
    return (
      "Supabase rejected the connection. The pooler username must include the project " +
      "reference — it looks like `postgres.abcdefgh`, not plain `postgres`."
    );
  }

  return message || "Something went wrong.";
}

/**
 * One place to turn a caught error into the JSON the client expects.
 *
 * Uses the standard `Response.json` rather than NextResponse so this module has
 * no framework import and the message logic above stays unit-testable.
 */
export function failure(error: unknown, status = 500): Response {
  // Server-side detail stays in the platform logs; the browser gets the summary.
  console.error("[route error]", toSafeMessage(error));
  return Response.json({ error: describeFailure(error) }, { status });
}
