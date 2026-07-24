import type { Config } from "drizzle-kit";

/**
 * drizzle-kit runs outside Next.js, so it does not pick up `.env.local` the way
 * `next dev` does — without this it reports an empty `url` even when the file is
 * sitting right there. `process.loadEnvFile` is built into Node 20.12+, so this
 * needs no dotenv dependency.
 *
 * An already-exported DATABASE_URL wins, which is what CI and Vercel rely on.
 */
if (!process.env.DATABASE_URL) {
  for (const file of [".env", ".env.local"]) {
    try {
      process.loadEnvFile(file);
    } catch {
      // Missing file, or a Node too old for loadEnvFile. Fall through to the
      // process environment and let the check below give a useful message.
    }
  }
}

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Put the Supabase pooled connection string " +
      "(Connect > Transaction pooler, port 6543) in .env.local, then run this again.",
  );
}

if (url.includes(":5432")) {
  // Easy mistake to make: the Connect dialog shows the direct connection first,
  // and it is IPv6-only, so it fails from Vercel and from many home networks.
  console.warn(
    "\nWarning: DATABASE_URL points at port 5432 (direct connection). This app " +
      "expects the transaction pooler on port 6543.\n",
  );
}

export default {
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
} satisfies Config;
