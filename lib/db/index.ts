import { FileStore } from "@/lib/db/file-store";
import { PostgresStore } from "@/lib/db/pg-store";
import type { Store } from "@/lib/db/store";

/**
 * Picks the storage backend.
 *
 * Postgres (Supabase, used purely as a Postgres host) whenever DATABASE_URL is
 * set — that is the production path and what schema.ts describes. Without it, a
 * local JSON file, so a fresh clone runs `npm run dev` and works end to end with
 * no infrastructure at all. The UI says which one is active, so "where did my
 * data go" is never a mystery.
 *
 * The postgres client itself is constructed lazily inside PostgresStore, so
 * importing this module never opens a connection.
 */

let instance: Store | null = null;

export function getStore(): Store {
  if (instance) return instance;

  if (process.env.DATABASE_URL) {
    instance = new PostgresStore();
    return instance;
  }

  // The file store writes to disk, and a deployed serverless filesystem is
  // read-only (and per-invocation besides, so anything written would vanish
  // between requests). Fail loudly here rather than letting the scheduler
  // upload an export and get an unexplained ENOENT halfway through.
  if (process.env.VERCEL) {
    throw new Error(
      "DATABASE_URL is not set on this deployment. Add the Supabase pooled connection string " +
        "(Connect > Transaction pooler, port 6543) in Project Settings > Environment Variables, " +
        "then redeploy. The local JSON file store cannot be used on Vercel.",
    );
  }

  instance = new FileStore();
  return instance;
}

export type { Store };
