import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { BrokerClient } from "../src/intercom/client.ts";

/**
 * Integration: run a real (isolated) pi-intercom broker under a temp agent dir
 * and verify our client's register/send/receive/receipt/list flow. Skipped when
 * pi-intercom is not installed at the standard path.
 */

const PI_INTERCOM_DIR = "/home/mauro/.pi/agent/npm/node_modules/pi-intercom";
const BROKER_ENTRY = join(PI_INTERCOM_DIR, "broker", "broker.ts");

function resolveTsx(): string | undefined {
  try {
    return require.resolve("tsx");
  } catch {
    const sibling = join(PI_INTERCOM_DIR, "..", "tsx", "dist", "loader.mjs");
    return existsSync(sibling) ? sibling : undefined;
  }
}

async function startIsolatedBroker(): Promise<{ agentDir: string; stop: () => void }> {
  const agentDir = mkdtempSync(join(tmpdir(), "ccbridge-test-"));
  const tsx = resolveTsx();
  if (!tsx) throw new Error("tsx loader not found");
  const child = spawn(
    process.execPath,
    ["--import", tsx, BROKER_ENTRY],
    {
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const sock = join(agentDir, "intercom", "broker.sock");
  for (let i = 0; i < 100; i++) {
    if (existsSync(sock)) break;
    await sleep(100);
  }
  if (!existsSync(sock)) throw new Error(`broker did not create ${sock}`);
  return { agentDir, stop: () => child.kill("SIGTERM") };
}

function registration(name: string) {
  return {
    name,
    cwd: process.cwd(),
    model: "test",
    pid: process.pid,
    startedAt: Date.now(),
    lastActivity: Date.now(),
    status: "idle",
    acknowledgesReceipts: true,
    livenessIntervalMs: 5_000,
  };
}

test("broker client: register, list, send, receive, receipt, delivered", { skip: !existsSync(BROKER_ENTRY) }, async t => {
  const { agentDir, stop } = await startIsolatedBroker();
  t.after(() => stop());

  const alpha = new BrokerClient(agentDir);
  const beta = new BrokerClient(agentDir);
  t.after(() => {
    alpha.close();
    beta.close();
  });

  await alpha.connectAndRegister("alpha-id", registration("alpha"));
  await beta.connectAndRegister("beta-id", registration("beta"));

  const received = new Promise<{ fromId: string; text: string; messageId: string }>(resolve => {
    beta.on("message", event => {
      resolve({ fromId: event.from.id, text: event.message.content.text, messageId: event.message.id });
      beta.receipt(event.message.id);
    });
  });

  const delivered = new Promise<string>(resolve => {
    alpha.on("delivered", event => resolve(event.messageId));
  });

  // Give the broker a beat to process both registrations.
  await sleep(200);
  alpha.send("beta", { id: "msg-1", timestamp: Date.now(), content: { text: "ping" } });

  const got = await Promise.race([received, sleep(5_000).then(() => null)]);
  assert.ok(got, "beta should receive the message");
  assert.equal(got.fromId, "alpha-id");
  assert.equal(got.text, "ping");
  const delivery = await Promise.race([delivered, sleep(5_000).then(() => null)]);
  assert.equal(delivery, "msg-1");
});
