import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PI_INTERCOM_DIR = "/home/mauro/.pi/agent/npm/node_modules/pi-intercom";
export const BROKER_ENTRY = join(PI_INTERCOM_DIR, "broker", "broker.ts");

export function resolveTsx(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require.resolve("tsx");
  } catch {
    const sibling = join(PI_INTERCOM_DIR, "..", "tsx", "dist", "loader.mjs");
    return existsSync(sibling) ? sibling : undefined;
  }
}

export interface IsolatedBroker {
  agentDir: string;
  stop: () => void;
}

/** Spawn a real (isolated) pi-intercom broker under a temp agent dir. */
export async function startIsolatedBroker(): Promise<IsolatedBroker> {
  const agentDir = mkdtempSync(join(tmpdir(), "ccbridge-test-"));
  const tsx = resolveTsx();
  if (!tsx) throw new Error("tsx loader not found");
  const child = spawn(process.execPath, ["--import", tsx, BROKER_ENTRY], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, NODE_NO_WARNINGS: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const sock = join(agentDir, "intercom", "broker.sock");
  for (let i = 0; i < 100 && !existsSync(sock); i++) await sleep(100);
  if (!existsSync(sock)) throw new Error(`broker did not create ${sock}`);
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
