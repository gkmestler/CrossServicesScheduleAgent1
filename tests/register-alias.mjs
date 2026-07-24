import { register } from "node:module";
import { pathToFileURL } from "node:url";

/**
 * Teaches plain `node --test` the `@/` path alias from tsconfig.json.
 *
 * The app modules use `@/lib/...` because that is the Next.js convention, and
 * the tests import those same modules directly so they exercise the real code
 * rather than a copy. Node has no notion of tsconfig `paths`, so this registers
 * a resolver hook that maps `@/` to the project root.
 */
register("./alias-hooks.mjs", pathToFileURL(import.meta.filename));
