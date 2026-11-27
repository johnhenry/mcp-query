import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when the module at `metaUrl` is the script Node was started with.
 *
 * Compares real paths: an installed bin (`node_modules/.bin/<name>`, what `npx` and a global
 * install run) is a symlink, so comparing `import.meta.url` with `process.argv[1]` as strings
 * never matches there and the CLI would exit silently without doing anything.
 */
export function isEntryPoint(metaUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}
