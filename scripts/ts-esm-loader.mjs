/**
 * Minimal ESM custom loader for the differential harness.
 *
 * Node's --experimental-strip-types resolves .ts files by absolute URL but
 * does NOT add .ts to extensionless relative imports emitted by TypeScript
 * source (e.g. `import ... from "./modelCapabilities"`). This loader patches
 * that gap: when a relative import has no extension and a same-named .ts file
 * exists on disk, it rewrites the specifier to the .ts URL before resolution.
 *
 * Usage: node --experimental-strip-types --loader scripts/ts-esm-loader.mjs <script>
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname, extname } from "node:path";

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && !extname(specifier)) {
    const parentDir = context.parentURL
      ? dirname(fileURLToPath(context.parentURL))
      : process.cwd();
    const candidate = join(parentDir, specifier + ".ts");
    if (existsSync(candidate)) {
      return nextResolve(pathToFileURL(candidate).href, context);
    }
  }
  return nextResolve(specifier, context);
}
