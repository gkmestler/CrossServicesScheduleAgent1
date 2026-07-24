import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import postgres from "postgres";

/**
 * Applies the SQL migrations in drizzle/ and records what has run.
 *
 * This exists because `drizzle-kit push` introspects the whole database first,
 * and its 0.31 introspection crashes on constraints present in a stock Supabase
 * project ("Cannot read properties of undefined (reading 'replace')"). That is a
 * tooling bug, not a problem with the schema.
 *
 * Running the committed SQL is the better default for this app regardless:
 * `push` diffs live state and can decide to drop something, whereas this only
 * ever applies files that are in the repo and reviewable in a diff.
 */

if (!process.env.DATABASE_URL) {
  for (const file of [".env", ".env.local"]) {
    try {
      process.loadEnvFile(file);
    } catch {
      // Not present, or a Node too old for loadEnvFile.
    }
  }
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(
    "\nDATABASE_URL is not set. Put the Supabase pooled connection string " +
      "(Connect > Transaction pooler, port 6543) in .env.local, then run this again.\n",
  );
  process.exit(1);
}

const MIGRATIONS_DIR = path.join(process.cwd(), "drizzle");

async function main() {
  const sql = postgres(url!, { prepare: false, max: 1, onnotice: () => {} });

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS _migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;

    const applied = new Set(
      (await sql<{ name: string }[]>`SELECT name FROM _migrations`).map((row) => row.name),
    );

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    if (files.length === 0) {
      console.error("No .sql files in drizzle/. Run `npm run db:generate` first.");
      process.exit(1);
    }

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  skip  ${file} (already applied)`);
        continue;
      }

      const contents = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      // drizzle-kit separates statements with this marker.
      const statements = contents
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter(Boolean);

      // All or nothing: a half-applied schema is worse than none.
      await sql.begin(async (tx) => {
        for (const statement of statements) {
          await tx.unsafe(statement);
        }
        await tx`INSERT INTO _migrations (name) VALUES (${file})`;
      });

      console.log(`  ok    ${file} (${statements.length} statements)`);
      ran += 1;
    }

    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;

    console.log(
      ran === 0
        ? "\nNothing to apply — the schema is already up to date."
        : `\nApplied ${ran} migration${ran === 1 ? "" : "s"}.`,
    );
    console.log(`Tables now in public: ${tables.map((t) => t.table_name).join(", ")}\n`);
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  // Never print the connection string — it carries the database password.
  const message = error instanceof Error ? error.message : String(error);
  console.error("\nMigration failed:", message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[connection string]"));
  process.exit(1);
});
