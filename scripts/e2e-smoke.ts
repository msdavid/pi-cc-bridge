/**
 * Full-loop smoke (manual): isolated pi-intercom broker + pi-cc-bridge daemon +
 * a throwaway `claude -p` session. Verifies BOTH relay directions:
 *
 *   CC → pi : CC probe SendMessage → daemon inbox → routed to synthetic target
 *   pi → CC : synthetic target → daemon → CC probe socket → CC acknowledges
 *
 * Nothing touches the user's real pi sessions; the only real-filesystem writes
 * are the daemon's masquerade record in ~/.claude/sessions (removed on stop)
 * and the throwaway CC session's own record.
 *
 * Run: npx tsx scripts/e2e-smoke.ts
 */

import { spawn, ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";

const PI_INTERCOM_DIR = "/home/mauro/.pi/agent/npm/node_modules/pi-intercom";
const PKG_DIR = new URL("..", import.meta.url).pathname;
const requireFromPkg = createRequire(join(PKG_DIR, "package.json"));
const tsx = requireFromPkg.resolve("tsx");
const TOKEN_CC_TO_PI = "E2E-HELLO-CC-TO-PI";
const TOKEN_PI_TO_CC = "E2E-ACK-P2C-77";
const PEER = "pi-bridge";
const TARGET = "e2e-target";
const PROBE_NAME = `ccbridge-probe-${process.pid.toString(36)}`;

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  const agentDir = mkdtempSync(join(tmpdir(), "ccbridge-e2e-"));
  const stateDir = join(agentDir, "pi-cc-bridge");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "config.json"),
    JSON.stringify({ enabled: true, peerName: PEER, pollMs: 500, logLevel: "normal" }),
  );

  // 1. isolated broker
  const broker = spawn(process.execPath, ["--import", tsx, join(PI_INTERCOM_DIR, "broker", "broker.ts")], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, NODE_NO_WARNINGS: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const brokerSock = join(agentDir, "intercom", "broker.sock");
  for (let i = 0; i < 100 && !existsSync(brokerSock); i++) await sleep(100);
  check("broker up", existsSync(brokerSock));

  // 2. daemon
  const daemon = spawn(process.execPath, ["--import", tsx, join(PKG_DIR, "src", "cli.ts")], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, NODE_NO_WARNINGS: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const daemonOut: string[] = [];
  daemon.stderr?.on("data", d => daemonOut.push(d.toString()));
  // wait for the daemon's masquerade record (written to the REAL sessions dir)
  const realSessions = "/home/mauro/.claude/sessions";
  let daemonPidFile = "";
  for (let i = 0; i < 50; i++) {
    try {
      daemonPidFile = readFileSync(join(stateDir, "daemon.pid"), "utf-8").trim();
      if (daemonPidFile && existsSync(join(realSessions, `${daemonPidFile}.json`))) break;
    } catch {
      /* not yet */
    }
    await sleep(100);
  }
  check("daemon up + masquerade record", Boolean(daemonPidFile) && existsSync(join(realSessions, `${daemonPidFile}.json`)));

  // 3. synthetic pi target on the isolated broker
  const { BrokerClient } = await import("../src/intercom/client.ts");
  const target = new BrokerClient(agentDir);
  const fromCc = new Promise<string>(resolve => {
    target.on("message", event => resolve(event.message.content.text));
  });
  await target.connectAndRegister(TARGET, {
    name: TARGET,
    cwd: process.cwd(),
    model: "e2e",
    pid: process.pid,
    startedAt: Date.now(),
    lastActivity: Date.now(),
    acknowledgesReceipts: true,
    livenessIntervalMs: 5_000,
  });

  // 4. CC probe session
  const prompt =
    `Send the message "${TOKEN_CC_TO_PI}" to the session named "${PEER}" using cross-session messaging. ` +
    `The message text must start with a line "To: ${TARGET}". After sending, reply READY. ` +
    `Afterwards, if you receive a message containing "${TOKEN_PI_TO_CC}", send back the text "ACK ${TOKEN_PI_TO_CC}" to "${PEER}" with the same "To: ${TARGET}" first line, then reply FINISHED.`;
  const cc = spawn(
    "claude",
    ["-p", "--name", PROBE_NAME, "--model", "haiku", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--allowedTools", "ListAgents,SendMessage"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const ccOut: string[] = [];
  cc.stdout?.on("data", d => ccOut.push(d.toString()));
  cc.stdin?.write(JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n");
  cc.stdin?.end();

  // Phase A: CC → pi
  let phaseA: string | null = null;
  for (let i = 0; i < 120; i++) {
    const winner = await Promise.race([fromCc, sleep(1_000).then(() => null)]);
    if (winner && winner.includes(TOKEN_CC_TO_PI)) {
      phaseA = winner;
      break;
    }
    if (winner) continue; // some other message; keep waiting
  }
  check("CC → pi relay", Boolean(phaseA), phaseA?.slice(0, 160));

  // Phase B: pi → CC. The daemon should have registered claude:<name> for the probe.
  let phaseB: string | null = null;
  let phaseBSent = false;
  for (let i = 0; i < 30; i++) {
    const out = ccOut.join("");
    if (out.includes("ACK") && out.includes(TOKEN_PI_TO_CC)) {
      phaseB = out;
      break;
    }
    // send via target to the probe's synthetic peer once it exists
    const rosterText = await new Promise<string>(resolve => {
      const id = target.list();
      const handler = (event: { requestId: string; sessions: { id: string; name?: string }[] }) => {
        if (event.requestId !== id) return;
        target.off("sessions", handler);
        resolve(JSON.stringify(event.sessions.map(s => ({ id: s.id, name: s.name }))));
      };
      target.on("sessions", handler);
      setTimeout(() => resolve("[]"), 2_000);
    });
    const probePeer = JSON.parse(rosterText).find((s: { id: string; name?: string }) => s.name === `claude:${PROBE_NAME}`);
    if (probePeer && !phaseBSent) {
      target.send(probePeer.id, { id: `e2e-${TOKEN_PI_TO_CC}`, timestamp: Date.now(), content: { text: `${TOKEN_PI_TO_CC}: please acknowledge` } });
      phaseBSent = true;
    }
    await sleep(1_000);
  }
  check("pi → CC relay + CC ack", Boolean(phaseB));

  // 5. cleanup + verify
  const recordBefore = existsSync(join(realSessions, `${daemonPidFile}.json`));
  daemon.kill("SIGTERM");
  const broker2 = broker;
  await sleep(1_500);
  const recordAfter = existsSync(join(realSessions, `${daemonPidFile}.json`));
  check("masquerade record cleaned up", recordBefore && !recordAfter);
  broker2.kill("SIGTERM");
  cc.kill("SIGKILL");
  console.log(`\ndaemon log tail:\n${daemonOut.join("") || "(stderr empty)"}\n${readFileSync(join(stateDir, "daemon.log"), "utf-8").split("\n").slice(-8).join("\n")}`);
  process.exit(failures ? 1 : 0);
}

main().catch(error => {
  console.error("smoke crashed:", error);
  process.exit(1);
});
