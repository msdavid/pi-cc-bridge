import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, appendFileSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CcRecord, isTargetableRecord, ownSocketPath, CcPathsOptions } from "./cc/paths.ts";
import { gcOwnStaleRecord, listRecordsSync, procStart, machineIdHash, writeOwnRecord, removeOwnRecord, isPidAlive } from "./cc/registry.ts";
import { startCcInbox, CcInboxServer } from "./cc/inbox.ts";
import { postToCcInbox } from "./cc/poster.ts";
import { ParsedInbound } from "./cc/protocol.ts";
import { BrokerClient, IntercomMessage, BrokerSessionInfo } from "./intercom/client.ts";
import { BridgeConfig, bridgeStateDir, loadConfig } from "./config.ts";

/**
 * The daemon: discovery loop + relay.
 *
 * - Every live CC session becomes a synthetic intercom peer (own broker
 *   connection, sessionId `cc-<ccSessionId>`, name `claude:<name>`).
 * - The daemon itself masquerades as ONE CC session (peerName, default
 *   "pi-bridge") so CC sessions can SendMessage into pi.
 */

interface Peer {
  cc: CcRecord;
  client: BrokerClient;
  sessionId: string;
  name: string;
}

export class Bridge {
  private peers = new Map<string, Peer>(); // key: CC sessionId
  private inbox: CcInboxServer | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private roster = new Map<string, BrokerSessionInfo>(); // by session id
  private heldDir: string;

  constructor(
    readonly config: BridgeConfig,
    private readonly log: (msg: string) => void,
    private readonly paths: CcPathsOptions = {},
  ) {
    this.heldDir = join(bridgeStateDir(config.agentDir), "held");
    mkdirSync(this.heldDir, { recursive: true });
  }

  async start(): Promise<void> {
    const socketPath = ownSocketPath(this.paths);
    gcOwnStaleRecord(socketPath, this.paths);

    // Masquerade as one CC session so CC can address pi through us.
    const record: CcRecord = {
      pid: process.pid,
      sessionId: randomUUID(),
      cwd: process.cwd(),
      startedAt: Date.now(),
      procStart: procStart(),
      version: "bridge",
      peerProtocol: 1,
      peerFeatures: ["notify_idle", "reply_across_default_dirs"],
      kind: "bridge",
      entrypoint: "cli",
      pidDomain: `linux:${machineIdHash() ?? "unknown"}:pid:[unknown]`,
      messagingSocketPath: socketPath,
      name: this.config.peerName,
      nameSource: "user",
      nameSince: Date.now(),
      updatedAt: Date.now(),
      status: "idle",
      statusUpdatedAt: Date.now(),
    };
    writeOwnRecord(record, this.paths);
    this.inbox = await startCcInbox({
      socketPath,
      onFrame: frame => void this.onCcFrame(frame),
      onError: error => this.log(`inbox: ${error.message}`),
    });
    this.log(`bridge inbox at ${socketPath}, registry record written`);

    this.pollTimer = setInterval(() => this.syncPeers(), this.config.pollMs);
    this.pollTimer.unref?.();
    await this.syncPeers();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const peer of this.peers.values()) peer.client.close();
    this.peers.clear();
    if (this.inbox) await this.inbox.close();
    removeOwnRecord(process.pid, this.paths);
    this.log("bridge stopped");
  }

  /** Align synthetic peers with the CC registry. */
  private syncPeers(): void {
    if (this.stopping) return;
    const seen = new Set<string>();
    const usedNames = new Set<string>([this.config.peerName]);
    for (const peer of this.peers.values()) usedNames.add(peer.name);

    for (const { record } of listRecordsSync(this.paths)) {
      if (!isTargetableRecord(record)) continue;
      if (record.pid === process.pid) continue; // our own masquerade record
      if (!isPidAlive(record.pid)) continue;
      seen.add(record.sessionId);

      const existing = this.peers.get(record.sessionId);
      if (existing) {
        if (record.status && record.status !== existing.cc.status) {
          existing.cc = record;
          existing.client.presence(record.status);
        }
        continue;
      }

      const baseName = record.name?.trim() ? `claude:${record.name.trim()}` : `claude-pid-${record.pid}`;
      let name = baseName;
      let suffix = 0;
      while (usedNames.has(name)) name = `${baseName}#${++suffix}`;
      usedNames.add(name);

      const sessionId = `cc-${record.sessionId}`;
      const client = new BrokerClient(this.agentDir(), m => this.log(m));
      client.on("error", (error: Error) => this.log(`peer ${name}: ${error.message}`));
      client.on("message", event => void this.onPiToCc(name, record, event, client));
      client.on("registered", () => {
        this.log(`peer registered: ${name} (${sessionId})`);
        client.list();
      });
      client.on("sessions", event => {
        for (const session of event.sessions) this.roster.set(session.id, session);
      });
      client.on("session_joined", event => this.roster.set(event.session.id, event.session));
      client.on("session_left", event => this.roster.delete(event.sessionId));
      client.on("presence_update", event => this.roster.set(event.session.id, event.session));

      client
        .connectAndRegister(sessionId, {
          name,
          cwd: record.cwd ?? process.cwd(),
          model: "claude-code (external)",
          pid: process.pid,
          startedAt: record.startedAt ?? Date.now(),
          lastActivity: Date.now(),
          status: record.status ?? "idle",
          acknowledgesReceipts: true,
          livenessIntervalMs: 10_000,
        })
        .then(() => {
          this.peers.set(record.sessionId, { cc: record, client, sessionId, name });
        })
        .catch(error => this.log(`peer ${name} register failed: ${(error as Error).message}`));
    }

    for (const [ccSessionId, peer] of this.peers) {
      if (!seen.has(ccSessionId)) {
        peer.client.close();
        this.peers.delete(ccSessionId);
        this.log(`peer retired: ${peer.name}`);
      }
    }
  }

  /** pi → CC: an intercom message arrived for one of our synthetic peers. */
  private async onPiToCc(
    name: string,
    cc: CcRecord,
    event: { from: unknown; message: IntercomMessage },
    client: BrokerClient,
  ): Promise<void> {
    try {
      await postToCcInbox({
        socketPath: cc.messagingSocketPath,
        senderSocketPath: ownSocketPath(this.paths),
        senderName: name.replace(/^claude:/, "pi:"),
        senderMode: "prompting",
        text: event.message.content.text,
        msgId: event.message.id,
      });
      client.receipt(event.message.id);
      this.log(`pi message ${event.message.id} handed to ${name}`);
    } catch (error) {
      this.log(`post to ${name} failed: ${(error as Error).message}`);
    }
  }

  private async onCcFrame(frame: ParsedInbound): Promise<void> {
    if (frame.kind !== "user") {
      if (frame.kind === "action") this.log(`cc action frame: ${frame.action} (ignored)`);
      else if (frame.kind === "unknown") this.log(`cc line dropped: ${frame.reason}`);
      return;
    }
    const fromName = frame.meta.fromName ?? frame.meta.from ?? "claude-session";
    const query = frame.text.trim().toLowerCase();
    if (query === "list" && frame.meta.from) {
      const names = [...this.roster.values()].filter(s => !s.id.startsWith("cc-")).map(s => s.name ?? s.id);
      try {
        await postToCcInbox({
          socketPath: frame.meta.from.startsWith("uds:") ? frame.meta.from.slice(4) : frame.meta.from,
          senderSocketPath: ownSocketPath(this.paths),
          senderName: this.config.peerName,
          senderMode: "prompting",
          text: names.length ? `Reachable pi sessions (address with a leading "To: <name>" line):\n${names.map(n => `- ${n}`).join("\n")}` : "No other pi sessions are currently connected to intercom.",
          msgId: `list-${frame.line.msg_id}`.slice(0, 128),
        });
        this.log(`list query from ${fromName} answered with ${names.length} sessions`);
      } catch (error) {
        this.log(`list reply to ${fromName} failed: ${(error as Error).message}`);
      }
      return;
    }
    const { target, text } = this.resolveRoute(frame.text);
    if (!target) {
      const file = join(this.heldDir, `${Date.now()}-${frame.line.msg_id}.json`);
      writeFileSync(file, JSON.stringify({ fromName, text, receivedAt: Date.now() }, null, 2));
      this.log(`cc message from ${fromName} held (no route): ${file}`);
      return;
    }
    const peer = this.findPeerBySender(frame.meta.from);
    const client = peer?.client ?? [...this.peers.values()][0]?.client;
    if (!client) {
      this.log(`cc message from ${fromName} dropped: no broker connection`);
      return;
    }
    client.send(target, {
      id: frame.line.msg_id,
      timestamp: Date.now(),
      content: { text: `Message from Claude Code session ${fromName}:\n${text}` },
    });
    this.log(`cc message from ${fromName} relayed to ${target}`);
  }

  /** Route resolution: `To:` header → config.routeTo → single other session. */
  private resolveRoute(text: string): { target?: string; text: string } {
    let rest = text;
    const match = text.match(/^To:\s*(\S+)\s*\n?/i);
    if (match) {
      rest = text.slice(match[0].length);
      const hit = this.resolveTarget(match[1]);
      if (hit) return { target: hit, text: rest };
    }
    if (this.config.routeTo) {
      const hit = this.resolveTarget(this.config.routeTo);
      if (hit) return { target: hit, text: rest };
    }
    const others = [...this.roster.values()].filter(s => !s.id.startsWith("cc-"));
    return { target: others.length === 1 ? others[0].id : undefined, text: rest };
  }

  private resolveTarget(wanted: string): string | undefined {
    const lower = wanted.toLowerCase();
    for (const session of this.roster.values()) {
      if (session.name?.toLowerCase() === lower || session.id.toLowerCase() === lower) return session.id;
    }
    return undefined;
  }

  private findPeerBySender(senderSocket: string | undefined): Peer | undefined {
    if (!senderSocket) return undefined;
    for (const peer of this.peers.values()) {
      if (peer.cc.messagingSocketPath === senderSocket) return peer;
    }
    return undefined;
  }

  private agentDir(): string {
    return (
      this.config.agentDir?.trim() ||
      process.env.PI_CODING_AGENT_DIR?.trim() ||
      join(process.env.HOME ?? "", ".pi", "agent")
    );
  }
}

/** CLI entry: run the bridge until signalled. */
export async function runDaemon(argv: string[] = process.argv.slice(2)): Promise<void> {
  const stateDir = bridgeStateDir(argv[0]);
  const config = loadConfig(stateDir);
  const logFile = join(stateDir, "daemon.log");
  const log = (msg: string) => {
    const line = `${new Date().toISOString()} ${msg}`;
    if (config.logLevel !== "quiet") process.stdout.write(`${line}\n`);
    try {
      appendFileSync(logFile, `${line}\n`);
    } catch {
      /* best effort */
    }
  };

  const pidFile = join(stateDir, "daemon.pid");
  try {
    const existing = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    if (Number.isFinite(existing) && existing !== process.pid && isPidAlive(existing)) {
      log(`daemon already running as pid ${existing}; exiting`);
      process.exit(0);
    }
  } catch {
    /* no pid file */
  }
  writeFileSync(pidFile, String(process.pid));

  if (!config.enabled) {
    log("disabled in config; exiting");
    process.exit(0);
  }

  const bridge = new Bridge(config, log, {
    ccSessionsDir: config.ccSessionsDir,
    socketDir: config.ccSocketDir,
  });
  const shutdown = (signal: string) => {
    log(`received ${signal}`);
    void bridge.stop().then(() => {
      try {
        unlinkSync(pidFile);
      } catch {
        /* best effort */
      }
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("uncaughtException", error => log(`uncaught: ${error.stack ?? error.message}`));

  try {
    await bridge.start();
    log("bridge running");
  } catch (error) {
    log(`start failed: ${(error as Error).message}`);
    process.exit(1);
  }
}
