import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** True only for a real file — a directory of the same name must not match. */
function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolves `@/foo/bar` to `<project root>/foo/bar`, adding the `.ts` extension
 * (or `/index.ts`) that the TypeScript source omits.
 *
 * The file check matters for a directory import like `@/lib/geo`: the bare path
 * exists, so an existence test picks the directory and Node then fails trying to
 * read it as source.
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

  const match = candidates.find(isFile);
  if (!match) return nextResolve(specifier, context);

  return { url: pathToFileURL(match).href, shortCircuit: true };
}
