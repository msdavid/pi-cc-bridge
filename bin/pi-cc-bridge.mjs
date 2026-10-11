#!/usr/bin/env node
/** Launcher: run the TypeScript daemon via the tsx loader resolved from this
 * package's node_modules (same approach pi-intercom uses for its broker). */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromPkg = createRequire(join(pkgDir, "package.json"));

let loader;
try {
  loader = requireFromPkg.resolve("tsx");
} catch {
  const sibling = join(pkgDir, "..", "tsx", "dist", "loader.mjs");
  loader = sibling;
}

const child = spawn(
  process.execPath,
  ["--import", loader, join(pkgDir, "src", "cli.ts"), ...process.argv.slice(2)],
  { stdio: "inherit" },
);
child.on("exit", code => process.exit(code ?? 1));
