import { spawn, ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CcRecord, isTargetableRecord, ownSocketPath, CcPathsOptions } from "./cc/paths.ts";
import { gcOwnStaleRecord, listRecordsSync, procStart, machineIdHash, writeOwnRecord, removeOwnRecord, isPidAlive } from "./cc/registry.ts";
import { startCcInbox, CcInboxServer } from "./cc/inbox.ts";
import { postToCcInbox } from "./cc/poster.ts";
import { ParsedInbound } from "./cc/protocol.ts";
import { BrokerClient, IntercomMessage, BrokerSessionInfo } from "./intercom/client.ts";
import { BridgeConfig, bridgeStateDir, loadConfig } from "./config.ts";

/**
 * The daemon: discovery loop + relay + holder supervision.
 *
 * pi → CC: every live CC session becomes a synthetic intercom peer (own broker
 *   connection, sessionId `cc-<ccSessionId>`, name `claude:<name>`).
 * CC → pi: two paths.
 *   - Native (default): a holder child per live pi session binds its own CC
 *     inbox socket and registry record `pi-<alias>`, so CC addresses pi
 *     sessions directly in /list-agents. Children are dumb socket-holders;
 *     they forward to the daemon over private IPC and the daemon relays via
 *     the sending CC session's own peer connection (correct attribution, no
 *     extra intercom sessions).
 *   - Funnel fallback: the daemon itself masquerades as one CC session
 *     (`peerName`, default "pi-bridge"); messages route via a leading
 *     `To: <alias>` line, `routeTo`, or a single-session roster.
 */

interface Peer {
  cc: CcRecord;
  client: BrokerClient;
  sessionId: string;
  name: string;
}

interface HolderState {
  piSessionId: string;
  alias: string;
  childPid?: number;
  socket?: net.Socket;
  socketPath?: string;
  lastSpawnAt?: number;
  status?: string;
}

const HOLDER_LINE = 10; // \n

export class Bridge {
  private peers = new Map<string, Peer>(); // key: CC sessionId
  private inbox: CcInboxServer | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private roster = new Map<string, BrokerSessionInfo>(); // by session id
  private heldDir: string;
  private holders = new Map<string, HolderState>(); // key: pi session id
  private ipcServer: net.Server | null = null;
  private ipcPath: string;
  private usedHolderNames = new Set<string>();

  constructor(
    readonly config: BridgeConfig,
    private readonly log: (msg: string) => void,
    private readonly paths: CcPathsOptions = {},
  ) {
    this.heldDir = join(bridgeStateDir(config.agentDir), "held");
    mkdirSync(this.heldDir, { recursive: true });
    this.ipcPath = join(bridgeStateDir(config.agentDir), "holders-ipc.sock");
  }

  async start(): Promise<void> {
    const socketPath = ownSocketPath(this.paths);
    gcOwnStaleRecord(socketPath, this.paths);
    this.gcStaleHolderRecords();

    // Masquerade as one CC session so CC can address pi through us (funnel).
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

    if (this.config.nativeEntries) this.startIpcServer();

    this.pollTimer = setInterval(() => this.syncPeers(), this.config.pollMs);
    this.pollTimer.unref?.();
    await this.syncPeers();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const peer of this.peers.values()) peer.client.close();
    this.peers.clear();
    for (const holder of this.holders.values()) this.shutdownHolder(holder);
    this.holders.clear();
    if (this.inbox) await this.inbox.close();
    if (this.ipcServer) {
      await new Promise<void>(done => this.ipcServer!.close(() => done()));
      try {
        unlinkSync(this.ipcPath);
      } catch {
        /* best effort */
      }
      this.ipcServer = null;
    }
    removeOwnRecord(process.pid, this.paths);
    this.log("bridge stopped");
  }

  /** Remove leftover holder/masquerade records from a crashed previous daemon. */
  private gcStaleHolderRecords(): void {
    for (const { record, file } of listRecordsSync(this.paths)) {
      if (record.kind !== "bridge") continue;
      if (record.pid === process.pid) continue;
      if (isPidAlive(record.pid)) continue;
      try {
        unlinkSync(file);
        this.log(`gc stale bridge record: ${file}`);
      } catch {
        /* best effort */
      }
    }
  }

  /** Align synthetic peers with the CC registry. */
  private syncPeers(): void {
    if (this.stopping) return;
    const seen = new Set<string>();
    const usedNames = new Set<string>([this.config.peerName, ...this.usedHolderNames]);
    for (const peer of this.peers.values()) usedNames.add(peer.name);

    for (const { record } of listRecordsSync(this.paths)) {
      if (!isTargetableRecord(record)) continue;
      if (record.pid === process.pid) continue; // our own masquerade record
      if (record.kind === "bridge") continue; // holder records are not CC sessions
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
        for (const session of event.sessions) this.onRosterSession(session);
      });
      client.on("session_joined", event => this.onRosterSession(event.session));
      client.on("session_left", event => {
        this.roster.delete(event.sessionId);
        const holder = this.holders.get(event.sessionId);
        if (holder) {
          this.shutdownHolder(holder);
          this.holders.delete(event.sessionId);
          this.usedHolderNames.delete(holder.alias);
          this.log(`holder retired for departed pi session ${event.sessionId}`);
        }
      });
      client.on("presence_update", event => this.onRosterSession(event.session));

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

    // Periodic roster refresh (broadcast events normally cover this).
    const firstPeer = [...this.peers.values()][0]?.client;
    if (firstPeer) firstPeer.list();
    this.reconcileHolders();
  }

  private onRosterSession(session: BrokerSessionInfo): void {
    this.roster.set(session.id, session);
    const holder = this.holders.get(session.id);
    if (holder) {
      if (session.status !== undefined && session.status !== holder.status) {
        holder.status = session.status;
        holder.socket?.write(`${JSON.stringify({ type: "status", status: session.status })}\n`);
      }
      const wantedName = this.holderNameFor(session);
      if (wantedName && session.name && wantedName !== holder.alias) {
        holder.alias = wantedName;
        holder.socket?.write(`${JSON.stringify({ type: "alias", name: `pi-${wantedName}` })}\n`);
      }
    }
    this.reconcileHolders();
  }

  private holderNameFor(session: BrokerSessionInfo): string | undefined {
    const base = session.name?.trim() || `sid-${session.id.slice(0, 8)}`;
    if (this.holders.get(session.id)?.alias === base) return base;
    if (![...this.holders.values()].some(h => h.alias === base)) return base;
    let n = 2;
    while ([...this.holders.values()].some(h => h.alias === `${base}#${n}`)) n++;
    return `${base}#${n}`;
  }

  /** Spawn/kill holder children so each live pi session has a CC-native entry. */
  private reconcileHolders(): void {
    if (this.stopping || !this.config.nativeEntries) return;
    const wanted = new Set<string>();
    for (const session of this.roster.values()) {
      if (session.id.startsWith("cc-")) continue; // our own synthetic CC peers
      wanted.add(session.id);
    }
    for (const id of wanted) {
      if (this.holders.has(id)) continue;
      if (this.holders.size >= this.config.maxHolders) continue;
      const session = this.roster.get(id)!;
      const last = [...this.holders.values()].find(h => h.piSessionId === id)?.lastSpawnAt;
      if (last && Date.now() - last < 10_000) continue; // spawn cooldown
      this.spawnHolder(session);
    }
  }

  private resolveTsx(): string | undefined {
    try {
      const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
      return createRequire(join(pkgDir, "package.json")).resolve("tsx");
    } catch {
      const sibling = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tsx", "dist", "loader.mjs");
      return existsSync(sibling) ? sibling : undefined;
    }
  }

  private spawnHolder(session: BrokerSessionInfo): void {
    // Prefer the prebuilt plain-JS bundle: no tsx loader in the child (~53MB
    // vs ~82MB RSS, faster spawn). Fall back to tsx when dist/ is absent.
    const bundled = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "holder.mjs");
    const useBundle = existsSync(bundled);
    const tsx = useBundle ? undefined : this.resolveTsx();
    if (!useBundle && !tsx) {
      this.log("holder spawn failed: no dist bundle and tsx loader not resolvable");
      return;
    }
    const aliasBase = this.holderNameFor(session)!;
    const state: HolderState = { piSessionId: session.id, alias: aliasBase, status: session.status, lastSpawnAt: Date.now() };
    this.holders.set(session.id, state);
    const spec = {
      alias: aliasBase,
      piSessionId: session.id,
      parentPid: process.pid,
      ipcPath: this.ipcPath,
      peerPrefix: "pi-",
      sessionsDir: this.paths.ccSessionsDir,
      socketDir: this.paths.socketDir,
    };
    const childPath = useBundle ? bundled : join(dirname(fileURLToPath(import.meta.url)), "..", "src", "holder.ts");
    const childArgs = useBundle ? [childPath, JSON.stringify(spec)] : ["--import", tsx!, childPath, JSON.stringify(spec)];
    const child = spawn(process.execPath, childArgs, {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    state.childPid = child.pid;
    this.usedHolderNames.add(aliasBase);
    child.stderr?.on("data", d => this.log(`holder(${aliasBase}): ${d.toString().trim()}`));
    child.on("exit", code => {
      this.log(`holder ${aliasBase} exited (${code ?? "signal"})`);
      if (!this.stopping && this.roster.has(session.id)) {
        // Crash (not shutdown): retry after the cooldown via reconcile.
        setTimeout(() => {
          if (!this.stopping && this.roster.has(session.id)) this.reconcileHolders();
        }, 11_000);
      }
    });
    this.log(`holder spawning for pi session ${session.name ?? session.id}`);
  }

  private startIpcServer(): void {
    try {
      if (existsSync(this.ipcPath)) unlinkSync(this.ipcPath);
    } catch {
      /* not present */
    }
    this.ipcServer = net.createServer(socket => {
      let buffer = Buffer.alloc(0);
      let holder: HolderState | undefined;
      socket.on("data", chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        let idx: number;
        while ((idx = buffer.indexOf(HOLDER_LINE)) !== -1) {
          const line = buffer.subarray(0, idx).toString("utf-8").trim();
          buffer = buffer.subarray(idx + 1);
          if (!line) continue;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (msg.type === "hello" && typeof msg.piSessionId === "string") {
            holder = this.holders.get(msg.piSessionId);
            if (holder) {
              holder.socket = socket;
              holder.socketPath = typeof msg.socketPath === "string" ? msg.socketPath : undefined;
              // Bring the child up to date immediately.
              const session = this.roster.get(holder.piSessionId);
              if (session?.status) socket.write(`${JSON.stringify({ type: "status", status: session.status })}\n`);
              socket.write(
                `${JSON.stringify({
                  type: "roster",
                  sessions: [...this.roster.values()].filter(s => !s.id.startsWith("cc-")).map(s => ({ id: s.id, name: s.name })),
                })}\n`,
              );
              this.log(`holder hello from ${holder.alias} (pid ${String(msg.pid)})`);
            }
            continue;
          }
          if (!holder) continue;
          if (msg.type === "cc-message") {
            this.relayCcToPi(holder, msg);
          } else if (msg.type === "reply") {
            void this.sendHolderReply(holder, msg);
          }
        }
      });
      socket.on("error", () => socket.destroy());
      socket.on("close", () => {
        if (holder && holder.socket === socket) holder.socket = undefined;
      });
    });
    this.ipcServer.listen(this.ipcPath, () => this.log(`holder IPC at ${this.ipcPath}`));
    this.ipcServer.on("error", error => this.log(`ipc: ${error.message}`));
  }

  /** CC → pi relay with correct attribution via the sending CC session's peer. */
  private relayCcToPi(holder: HolderState, msg: Record<string, unknown>): void {
    const fromSocketRaw = typeof msg.fromSocket === "string" ? msg.fromSocket : undefined;
    const fromSocket = fromSocketRaw?.startsWith("uds:") ? fromSocketRaw.slice(4) : fromSocketRaw;
    const text = typeof msg.text === "string" ? msg.text : "";
    const msgId = typeof msg.msgId === "string" ? msg.msgId : `cc-${randomUUID()}`;
    if (!text) return;

    const peer = fromSocket ? [...this.peers.values()].find(p => p.cc.messagingSocketPath === fromSocket) : undefined;
    const ccName = peer?.cc.name ?? (typeof msg.fromName === "string" ? msg.fromName : undefined) ?? "unknown";
    const client = peer?.client ?? [...this.peers.values()][0]?.client;
    if (!client) {
      this.log(`cc message from ${ccName} dropped: no broker connection`);
      return;
    }
    client.send(holder.piSessionId, {
      id: msgId,
      timestamp: Date.now(),
      content: { text: `Message from Claude Code session ${ccName}:\n${text}` },
    });
    this.log(`cc message from ${ccName} relayed to ${holder.alias} (${holder.piSessionId})`);
  }

  /** Child-initiated reply (e.g. a "list" answer), posted back to the CC sender. */
  private async sendHolderReply(holder: HolderState, msg: Record<string, unknown>): Promise<void> {
    const toSocketRaw = typeof msg.toSocket === "string" ? msg.toSocket : undefined;
    const toSocket = toSocketRaw?.startsWith("uds:") ? toSocketRaw.slice(4) : toSocketRaw;
    if (!toSocket || typeof msg.text !== "string") return;
    try {
      await postToCcInbox({
        socketPath: toSocket,
        senderSocketPath: holder.socketPath ?? ownSocketPath(this.paths),
        senderName: `pi-${holder.alias}`,
        senderMode: "prompting",
        text: msg.text,
        msgId: typeof msg.msgId === "string" ? msg.msgId : `reply-${randomUUID()}`,
      });
      this.log(`holder reply sent to ${toSocket}`);
    } catch (error) {
      this.log(`holder reply failed: ${(error as Error).message}`);
    }
  }

  private shutdownHolder(holder: HolderState): void {
    if (holder.socket) {
      try {
        holder.socket.write(`${JSON.stringify({ type: "shutdown" })}\n`);
      } catch {
        /* best effort */
      }
    }
    if (holder.childPid) {
      try {
        process.kill(holder.childPid, "SIGTERM");
      } catch {
        /* already gone */
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

  /** CC → pi (funnel): a frame arrived on our masqueraded inbox. */
  private async onCcFrame(frame: ParsedInbound): Promise<void> {
    if (frame.kind !== "user") {
      if (frame.kind === "action") this.log(`cc action frame: ${frame.action} (ignored)`);
      else if (frame.kind === "unknown") this.log(`cc line dropped: ${frame.reason}`);
      return;
    }
    const fromName = frame.meta.fromName ?? frame.meta.from ?? "claude-session";
    const query = frame.text.trim().toLowerCase();
    if (query === "list" && frame.meta.from) {
      const names = [...this.roster.values()].filter(s => !s.id.startsWith("cc-")).map(s => `pi-${s.name ?? s.id}`);
      try {
        await postToCcInbox({
          socketPath: frame.meta.from.startsWith("uds:") ? frame.meta.from.slice(4) : frame.meta.from,
          senderSocketPath: ownSocketPath(this.paths),
          senderName: this.config.peerName,
          senderMode: "prompting",
          text: names.length
            ? `Reachable pi sessions (address with a leading "To: <name>" line, or SendMessage the matching pi-* session directly):\n${names.join("\n")}`
            : "No other pi sessions are currently connected to intercom.",
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
    const bare = senderSocket.startsWith("uds:") ? senderSocket.slice(4) : senderSocket;
    for (const peer of this.peers.values()) {
      if (peer.cc.messagingSocketPath === bare) return peer;
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
