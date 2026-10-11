import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { startBrokerAt, resolveTsx, waitFor, SKIP, SKIP_REASON } from "./helpers.ts";
import { BrokerClient } from "../src/intercom/client.ts";
import net from "node:net";

/**
 * Lifecycle integration (critic P0-2/P0-3/P1-1):
 *  1. broker restart → peers re-register: the holder vanishes while the broker
 *     is down (peer disconnect → roster cleared) and returns after reconnect.
 *  2. two daemons racing → exactly one survives (O_EXCL lock).
 *  3. holder SIGKILL → respawned with a fresh pid.
 */

const PKG_DIR = new URL("..", import.meta.url).pathname;
const skip = SKIP ? SKIP_REASON : false;

function freshFixture(agentDir: string): { sessionsDir: string; socketDir: string; mySocketPath: string; myServer: net.Server; myLines: string[] } {
  const sessionsDir = join(agentDir, "cc-sessions");
  const socketDir = join(agentDir, "cc-run");
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  const mySocketPath = join(socketDir, `${process.pid}.sock`);
  const myLines: string[] = [];
  const myServer = net.createServer(socket => {
    let buf = Buffer.alloc(0);
    socket.on("data", chunk => {
      buf = Buffer.concat([buf, chunk]);
      let idx: number;
      while ((idx = buf.indexOf(10)) !== -1) {
        const line = buf.subarray(0, idx).toString("utf-8").trim();
        buf = buf.subarray(idx + 1);
        if (line) myLines.push(line);
      }
    });
  });
  writeFileSync(
    join(sessionsDir, `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId: randomUUID(),
      cwd: process.cwd(),
      startedAt: Date.now(),
      procStart: "1",
      version: "2.1.296",
      peerProtocol: 1,
      peerFeatures: ["reply_across_default_dirs"],
      kind: "interactive",
      entrypoint: "cli",
      pidDomain: "linux:test:pid:[test]",
      messagingSocketPath: mySocketPath,
      name: "test-cc",
      nameSource: "user",
      nameSince: Date.now(),
      updatedAt: Date.now(),
      status: "idle",
      statusUpdatedAt: Date.now(),
    }),
  );
  return { sessionsDir, socketDir, mySocketPath, myServer, myLines };
}

function startDaemon(agentDir: string): ChildProcess {
  const tsx = resolveTsx()!;
  return spawn(process.execPath, ["--import", tsx, join(PKG_DIR, "src", "cli.ts")], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, NODE_NO_WARNINGS: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
}

function holderRecordInfo(sessionsDir: string): { file: string; record: Record<string, unknown> } | undefined {
  for (const f of readdirSync(sessionsDir)) {
    try {
      const rec = JSON.parse(readFileSync(join(sessionsDir, f), "utf-8")) as Record<string, unknown>;
      if (rec.name === "pi-planner" && rec.kind === "bridge") return { file: f, record: rec };
    } catch {
      /* torn read */
    }
  }
  return undefined;
}

function registerPlanner(agentDir: string): Promise<BrokerClient> {
  return new Promise(async (resolve, reject) => {
    const client = new BrokerClient(agentDir);
    try {
      await client.connectAndRegister("planner-id", {
        name: "planner",
        cwd: process.cwd(),
        model: "test",
        pid: process.pid,
        startedAt: Date.now(),
        lastActivity: Date.now(),
        status: "busy",
        livenessIntervalMs: 5_000,
      });
      resolve(client);
    } catch (error) {
      reject(error);
    }
  });
}

test("lifecycle: broker restart, double daemon, holder crash", { skip }, async t => {
  const agentDir = mkdtempSync(join(tmpdir(), "ccbridge-life-"));
  const { sessionsDir, mySocketPath, myServer } = freshFixture(agentDir);
  t.after(() => myServer.close());
  const stateDir = join(agentDir, "pi-cc-bridge");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(stateDir, "config.json"),
    JSON.stringify({ enabled: true, pollMs: 250, expose: ["*"], maxHolders: 8, ccSessionsDir: sessionsDir, ccSocketDir: join(agentDir, "cc-run") }),
  );

  let broker = await startBrokerAt(agentDir);

  // Two daemons race: exactly one owns the lock (P0-3).
  const d1 = startDaemon(agentDir);
  const d2 = startDaemon(agentDir);
  t.after(() => {
    for (const d of [d1, d2]) {
      try {
        d.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }
  });
  let exits = 0;
  const onExit = () => exits++;
  d1.on("exit", onExit);
  d2.on("exit", onExit);
  await sleep(2_500);
  const lockPid = Number(readFileSync(join(stateDir, "daemon.lock"), "utf-8").trim().split(" ")[0]);
  const survivors = [d1, d2].filter(d => d.pid === lockPid && d.exitCode === null);
  assert.equal(exits, 1, "exactly one daemon exits under lock contention");
  assert.equal(survivors.length, 1, "lock owner survives");
  const daemon = survivors[0];

  let planner = await registerPlanner(agentDir);
  t.after(() => planner.close());

  // Holder appears for the exposed pi session.
  const firstHolder = await waitFor(() => holderRecordInfo(sessionsDir) !== undefined, 15_000);
  assert.ok(firstHolder, "holder record must exist");
  const initial = holderRecordInfo(sessionsDir)!;

  // ── 3. holder SIGKILL → respawn with a fresh pid (P1-1) ──
  process.kill(Number(initial.record.pid), "SIGKILL");
  const aliveWithPid = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const respawn = await waitFor(() => {
    for (const f of readdirSync(sessionsDir)) {
      try {
        const rec = JSON.parse(readFileSync(join(sessionsDir, f), "utf-8")) as Record<string, unknown>;
        if (rec.name === "pi-planner" && rec.kind === "bridge" && Number(rec.pid) !== Number(initial.record.pid) && aliveWithPid(Number(rec.pid))) {
          return true;
        }
      } catch {
        /* torn read */
      }
    }
    return false;
  }, 20_000);
  assert.ok(respawn, "crashed holder must be respawned with a fresh pid");

  // ── 1. broker restart → holder vanishes while down, returns after reconnect (P0-2) ──
  broker.kill("SIGTERM");
  const gone = await waitFor(() => holderRecordInfo(sessionsDir) === undefined, 10_000);
  assert.ok(gone, "losing the broker must tear down holders (no zombies)");
  broker = await startBrokerAt(agentDir); // restart in place
  t.after(() => broker.kill("SIGTERM"));
  // The planner client must also reconnect to the new broker (sessions do).
  planner.close();
  await registerPlanner(agentDir);
  const back = await waitFor(() => holderRecordInfo(sessionsDir) !== undefined, 20_000);
  assert.ok(back, "peers must re-register and holders return after broker restart");
  assert.ok(daemon.exitCode === null, "daemon must survive a broker outage");
});
