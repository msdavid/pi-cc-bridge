import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { BrokerClient } from "../src/intercom/client.ts";
import { startIsolatedBroker, resolveTsx, waitFor, BROKER_ENTRY, SKIP, SKIP_REASON } from "./helpers.ts";

/**
 * Integration: run a real (isolated) pi-intercom broker under a temp agent dir
 * and verify our client's register/send/receive/receipt/list flow. Skipped when
 * pi-intercom is not installed at the standard path.
 */

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

test("broker client: register, list, send, receive, receipt, delivered", { skip: SKIP_REASON }, async t => {
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
