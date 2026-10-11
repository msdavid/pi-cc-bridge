import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { startIsolatedBroker, resolveTsx, waitFor, BROKER_ENTRY, SKIP, SKIP_REASON } from "./helpers.ts";
import { BrokerClient } from "../src/intercom/client.ts";
import { buildOutboundLine } from "../src/cc/protocol.ts";

/**
 * Native-entries integration: a fully SYNTHETIC CC↔pi loop.
 *
 * The test process fakes one CC session (registry record + inbox socket), a
 * fake pi session "planner" registers on the isolated broker, and the daemon
 * under test must:
 *   1. discover the fake CC session and register peer claude:test-cc,
 *   2. spawn a holder child that exposes pi-planner in the CC registry,
 *   3. relay CC → pi with attribution (fake CC posts to the holder socket),
 *   4. relay pi → CC (planner sends to claude:test-cc; daemon posts to the
 *      fake CC socket).
 *
 * Skipped when pi-intercom is not installed at the standard path.
 */

const PKG_DIR = new URL("..", import.meta.url).pathname;

interface Fixture {
  agentDir: string;
  sessionsDir: string;
  socketDir: string;
  mySocketPath: string;
  myServer: net.Server;
  myLines: string[];
  cleanup: () => void;
}

async function setupFixture(): Promise<Fixture> {
  const { agentDir, stop: stopBroker } = await startIsolatedBroker();
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
    socket.on("error", () => socket.destroy());
  });
  await new Promise<void>(resolve => myServer.listen(mySocketPath, () => resolve()));

  // Fake CC session record: the daemon must treat this test process as a CC session.
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
      peerFeatures: ["notify_idle", "reply_across_default_dirs", "artifact_yield"],
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

  const stateDir = join(agentDir, "pi-cc-bridge");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "config.json"),
    JSON.stringify({ enabled: true, pollMs: 250, expose: ["*"], maxHolders: 8, ccSessionsDir: sessionsDir }),
  );
  // socketDir override goes through the same key the config loader reads:
  const cfg = JSON.parse(readFileSync(join(stateDir, "config.json"), "utf-8"));
  cfg.ccSocketDir = socketDir;
  writeFileSync(join(stateDir, "config.json"), JSON.stringify(cfg));

  const cleanup = () => {
    try {
      unlinkSync(join(sessionsDir, `${process.pid}.json`));
    } catch {
      /* already gone */
    }
    myServer.close();
    stopBroker();
    rmSync(agentDir, { recursive: true, force: true }); // P3-9: no test temp leaks
  };
  return { agentDir, sessionsDir, socketDir, mySocketPath, myServer, myLines, cleanup };
}

function startDaemon(agentDir: string): ReturnType<typeof spawn> {
  const tsx = resolveTsx();
  if (!tsx) throw new Error("tsx loader not found");
  return spawn(process.execPath, ["--import", tsx, join(PKG_DIR, "src", "cli.ts")], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, NODE_NO_WARNINGS: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
}

test("native entries: holder child exposes pi sessions to CC; both relays work", { skip: SKIP_REASON }, async t => {
  const fixture = await setupFixture();
  t.after(() => fixture.cleanup());

  // Fake pi session on the isolated broker.
  const planner = new BrokerClient(fixture.agentDir);
  t.after(() => planner.close());
  const fromCc = new Promise<{ text: string; fromId: string }>(resolve => {
    planner.on("message", event => {
      resolve({ text: event.message.content.text, fromId: event.from.id });
      planner.receipt(event.message.id);
    });
  });
  await planner.connectAndRegister("planner-id", {
    name: "planner",
    cwd: process.cwd(),
    model: "test",
    pid: process.pid,
    startedAt: Date.now(),
    lastActivity: Date.now(),
    status: "busy",
    livenessIntervalMs: 5_000,
  });

  // Daemon under test.
  const daemon = startDaemon(fixture.agentDir);
  t.after(() => {
    try {
      daemon.kill("SIGTERM");
    } catch {
      /* gone */
    }
  });

  // 1. masquerade record appears
  const masqueradeOk = await waitFor(() => existsSync(join(fixture.sessionsDir, readDaemonPid(fixture.agentDir) + ".json")));
  assert.ok(masqueradeOk, "daemon masquerade record must exist");

  // 2. holder record for pi-planner appears
  const holderOk = await waitFor(() => readHolderPidFor(fixture.agentDir, "pi-planner") !== undefined, 15_000);
  assert.ok(holderOk, "holder record pi-planner must exist");
  const holderRecord = join(fixture.sessionsDir, `${readHolderPidFor(fixture.agentDir, "pi-planner")!}.json`);
  const holderRecordJson = JSON.parse(readFileSync(holderRecord, "utf-8"));
  assert.equal(holderRecordJson.name, "pi-planner");
  assert.equal(holderRecordJson.status, "busy"); // mirrored from planner's registration
  assert.notEqual(holderRecordJson.procStart, "0", "procStart must be the real field 22, not itrealvalue");
  assert.equal(holderRecordJson.bridgeOwner, "pi-cc-bridge");
  const holderSocket = holderRecordJson.messagingSocketPath as string;
  assert.ok(existsSync(holderSocket), "holder socket must exist");

  // 3. CC → pi relay: post as the fake CC session to the holder socket.
  const ccLine = buildOutboundLine({
    senderSocketPath: fixture.mySocketPath,
    senderName: "test-cc",
    senderMode: "prompting",
    text: "NATIVE-CC-TO-PI-1",
    msgId: "native-1",
  });
  await new Promise<void>((resolve, reject) => {
    const s = net.createConnection(holderSocket);
    s.on("connect", () => {
      s.write(ccLine + "\n");
      setTimeout(() => {
        s.end();
        resolve();
      }, 300);
    });
    s.on("error", reject);
  });
  const got = await Promise.race([fromCc, sleep(10_000).then(() => null)]);
  assert.ok(got, "planner must receive the relayed CC message");
  assert.equal(got.fromId, "cc-" + JSON.parse(readFileSync(join(fixture.sessionsDir, `${process.pid}.json`), "utf-8")).sessionId);
  assert.match(got.text, /Message from Claude Code session test-cc:\nNATIVE-CC-TO-PI-1/);

  // 4. pi → CC relay: planner sends to the synthetic peer by name.
  planner.send("claude:test-cc", { id: "native-2", timestamp: Date.now(), content: { text: "NATIVE-PI-TO-CC-1" } });
  const ccGot = await waitFor(() => fixture.myLines.some(l => l.includes("NATIVE-PI-TO-CC-1")), 10_000);
  assert.ok(ccGot, "fake CC socket must receive the pi message");
  const inbound = JSON.parse(fixture.myLines.find(l => l.includes("NATIVE-PI-TO-CC-1"))!);
  assert.equal(inbound.type, "user");
  assert.match(inbound.message.content, /from-name="pi-planner"/, "sender identity must be the pi session's holder entry");
  assert.equal(inbound.from, holderSocket, "sender socket must be the holder's socket so replies route back");

  // 5. cleanup: daemon SIGTERM removes holder record + socket.
  const holderPid = holderRecordJson.pid;
  daemon.kill("SIGTERM");
  const cleaned = await waitFor(() => !existsSync(holderRecord) && !existsSync(holderSocket) && !isAlive(holderPid), 10_000);
  assert.ok(cleaned, "holder record, socket, and process must be cleaned up");
});

function readDaemonPid(agentDir: string): string {
  try {
    return readFileSync(join(agentDir, "pi-cc-bridge", "daemon.lock"), "utf-8").trim().split(" ")[0];
  } catch {
    return "0";
  }
}

function readHolderPidFor(agentDir: string, name: string): string | undefined {
  const dir = join(agentDir, "cc-sessions");
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const rec = JSON.parse(readFileSync(join(dir, file), "utf-8"));
      if (rec.name === name) return file.replace(/\.json$/, "");
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
