import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Resolves `@/foo/bar` to `<project root>/foo/bar`, adding the `.ts` extension
 * (or `/index.ts`) that the TypeScript source omits.
 */
export function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith("@/")) return nextResolve(specifier, context);

  const base = path.join(PROJECT_ROOT, specifier.slice(2));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];

  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) return nextResolve(specifier, context);

  return { url: pathToFileURL(match).href, shortCircuit: true };
}
