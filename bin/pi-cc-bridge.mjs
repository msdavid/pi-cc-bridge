#!/usr/bin/env node
/** Launcher: prefer the prebuilt daemon bundle (plain node, no tsx); fall
 * back to the TypeScript entry under tsx when dist/ is absent (source checkouts). */
import { spawn } from "node:child_process";
import { existsSync, createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundled = join(pkgDir, "dist", "cli.mjs");

let child;
if (existsSync(bundled)) {
  child = spawn(process.execPath, [bundled, ...process.argv.slice(2)], { stdio: "inherit" });
} else {
  const requireFromPkg = createRequire(join(pkgDir, "package.json"));
  const loader = requireFromPkg.resolve("tsx");
  child = spawn(process.execPath, ["--import", loader, join(pkgDir, "src", "cli.ts"), ...process.argv.slice(2)], { stdio: "inherit" });
}
child.on("exit", code => process.exit(code ?? 1));
