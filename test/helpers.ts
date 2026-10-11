import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Portable broker test harness (P1-16). Resolution order for pi-intercom:
 * 1. PI_INTERCOM_DIR env override
 * 2. createRequire resolution (when installed as a devDependency)
 * 3. the standard global pi tree
 * Integration suites skip when absent — unless PI_CC_BRIDGE_STRICT=1 (CI
 * refuses to pass vacuously).
 */

const req = createRequire(import.meta.url);

export function piIntercomDir(): string | undefined {
  const env = process.env.PI_INTERCOM_DIR?.trim();
  if (env) return env;
  try {
    return dirname(req.resolve("pi-intercom/package.json"));
  } catch {
    const standard = join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-intercom");
    return existsSync(standard) ? standard : undefined;
  }
}

export const BROKER_ENTRY = join(piIntercomDir() ?? "", "broker", "broker.ts");
export const SKIP = !existsSync(BROKER_ENTRY);
export const SKIP_REASON: string | boolean = SKIP
  ? process.env.PI_CC_BRIDGE_STRICT === "1"
    ? "pi-intercom broker not found; refusing to skip in strict mode"
    : true
  : false;

export function resolveTsx(): string | undefined {
  try {
    return req.resolve("tsx");
  } catch {
    const sibling = join(piIntercomDir() ?? "", "..", "tsx", "dist", "loader.mjs");
    return existsSync(sibling) ? sibling : undefined;
  }
}

export interface IsolatedBroker {
  agentDir: string;
  stop: () => void;
}

/** Spawn a pi-intercom broker bound to a given agent dir (creates the socket there). */
export async function startBrokerAt(agentDir: string): Promise<ReturnType<typeof spawn>> {
  const tsx = resolveTsx();
  if (!tsx) throw new Error("tsx loader not found");
  const child = spawn(process.execPath, ["--import", tsx, BROKER_ENTRY], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, NODE_NO_WARNINGS: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const sock = join(agentDir, "intercom", "broker.sock");
  for (let i = 0; i < 100 && !existsSync(sock); i++) await sleep(100);
  if (!existsSync(sock)) throw new Error(`broker did not create ${sock}`);
  return child;
}

/** Spawn a real (isolated) pi-intercom broker under a temp agent dir. */
export async function startIsolatedBroker(): Promise<IsolatedBroker> {
  const agentDir = mkdtempSync(join(tmpdir(), "ccbridge-test-"));
  const child = await startBrokerAt(agentDir);
  return { agentDir, stop: () => child.kill("SIGTERM") };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 10_000, stepMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}
