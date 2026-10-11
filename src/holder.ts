import net from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { parseInboundLine, ParsedInbound } from "./cc/protocol.ts";
import { CcRecord, ownSocketPath, CcPathsOptions } from "./cc/paths.ts";
import { machineIdHash, procStart, procNsPid, writeOwnRecord, removeOwnRecord } from "./cc/registry.ts";

/**
 * Holder child: one per live pi session. Binds a CC-compatible inbox socket and
 * writes a registry record named `pi-<peerPrefix><alias>` so Claude Code sees
 * (and addresses) each pi session natively in /list-agents.
 *
 * The child holds no broker connection: it forwards CC messages to the parent
 * daemon over a private IPC socket, and the parent relays them via the sending
 * CC session's own synthetic peer connection — attribution stays correct
 * ("Message from Claude Code session <name>") and no extra intercom sessions
 * are created. Status/alias/roster updates arrive on the same IPC socket; a
 * watchdog makes the child clean up and exit if the parent dies.
 */

const LINE = 10; // \n

export interface HolderArgs {
  alias: string;
  piSessionId: string;
  parentPid: number;
  ipcPath: string;
  peerPrefix: string;
  sessionsDir?: string;
  socketDir?: string;
}

export function parseHolderArgs(argv: string[]): HolderArgs {
  const raw = JSON.parse(argv[2] ?? "{}") as Partial<HolderArgs>;
  if (typeof raw.alias !== "string" || !raw.alias || typeof raw.piSessionId !== "string" || !raw.piSessionId) {
    throw new Error("holder requires alias and piSessionId");
  }
  if (typeof raw.parentPid !== "number" || typeof raw.ipcPath !== "string") {
    throw new Error("holder requires parentPid and ipcPath");
  }
  return {
    alias: raw.alias,
    piSessionId: raw.piSessionId,
    parentPid: raw.parentPid,
    ipcPath: raw.ipcPath,
    peerPrefix: typeof raw.peerPrefix === "string" && raw.peerPrefix ? raw.peerPrefix : "pi-",
    sessionsDir: raw.sessionsDir,
    socketDir: raw.socketDir,
  };
}

export interface RosterEntry {
  id: string;
  name?: string;
}

export class Holder {
  private readonly paths: CcPathsOptions;
  private socketPath: string;
  private record: CcRecord;
  private name: string;
  private server: net.Server | null = null;
  private parent: net.Socket | null = null;
  private roster: RosterEntry[] = [];
  private stopped = false;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly args: HolderArgs,
    log: (msg: string) => void = () => {},
  ) {
    this.paths = { ccSessionsDir: args.sessionsDir, socketDir: args.socketDir };
    this.socketPath = ownSocketPath(this.paths);
    this.name = `${args.peerPrefix}${args.alias}`;
    this.log = log;
    const ts = Date.now();
    this.record = {
      pid: process.pid,
      sessionId: crypto.randomUUID(),
      cwd: process.cwd(),
      startedAt: ts,
      procStart: procStart(),
      version: "bridge",
      peerProtocol: 1,
      peerFeatures: ["notify_idle", "reply_across_default_dirs"],
      kind: "bridge",
      entrypoint: "cli",
      pidDomain: `linux:${machineIdHash() ?? "unknown"}:pid:[${procNsPid() ?? "unknown"}]`,
      messagingSocketPath: this.socketPath,
      name: this.name,
      nameSource: "user",
      nameSince: ts,
      updatedAt: ts,
      status: "idle",
      statusUpdatedAt: ts,
    };
  }

  get name$(): string {
    return this.name;
  }

  get socketPath$(): string {
    return this.socketPath;
  }

  async start(): Promise<void> {
    writeOwnRecord(this.record, this.paths);
    this.server = net.createServer(socket => this.serveInbox(socket));
    try {
      if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    } catch {
      /* not present */
    }
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => resolve());
    });
    await this.connectParent();
    this.watchParent();
    this.log(`holder ${this.name} up (pid ${process.pid}, socket ${this.socketPath})`);
  }

  private serveInbox(socket: net.Socket): void {
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      let idx: number;
      while ((idx = buffer.indexOf(LINE)) !== -1) {
        const line = buffer.subarray(0, idx).toString("utf-8").trim();
        buffer = buffer.subarray(idx + 1);
        if (line) this.onCcFrame(parseInboundLine(line));
      }
    });
    socket.on("error", () => socket.destroy());
  }

  private async connectParent(): Promise<void> {
    // The parent may still be binding its IPC socket when we spawn; retry briefly.
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 10 && !this.stopped; attempt++) {
      try {
        const parent = net.createConnection(this.args.ipcPath);
        this.parent = parent;
        await new Promise<void>((resolve, reject) => {
          parent.once("connect", resolve);
          parent.once("error", reject);
        });
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error as Error;
        this.parent = null;
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
    if (!this.parent) throw lastError ?? new Error("parent IPC unavailable");
    const parent = this.parent;
    parent.setNoDelay(true);
    let buffer = Buffer.alloc(0);
    parent.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      let idx: number;
      while ((idx = buffer.indexOf(LINE)) !== -1) {
        const line = buffer.subarray(0, idx).toString("utf-8").trim();
        buffer = buffer.subarray(idx + 1);
        if (line) this.onParentLine(line);
      }
    });
    parent.on("error", error => this.log(`parent link: ${error.message}`));
    this.send({ type: "hello", pid: process.pid, alias: this.args.alias, piSessionId: this.args.piSessionId, name: this.name });
  }

  private onParentLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (msg.type) {
      case "status": {
        if (typeof msg.status === "string" && msg.status !== this.record.status) {
          this.record.status = msg.status;
          this.record.statusUpdatedAt = Date.now();
          writeOwnRecord(this.record, this.paths);
        }
        break;
      }
      case "alias": {
        if (typeof msg.name === "string" && msg.name && msg.name !== this.name) {
          this.name = msg.name;
          this.record.name = this.name;
          this.record.nameSince = Date.now();
          writeOwnRecord(this.record, this.paths);
          this.log(`renamed to ${this.name}`);
        }
        break;
      }
      case "roster": {
        if (Array.isArray(msg.sessions)) {
          this.roster = msg.sessions as RosterEntry[];
        }
        break;
      }
      case "shutdown": {
        void this.stop();
        break;
      }
    }
  }

  private send(msg: unknown): void {
    try {
      this.parent?.write(JSON.stringify(msg) + "\n");
    } catch {
      /* parent link down; watchdog reaps us */
    }
  }

  /** CC → pi: parse the inbound line and hand it to the parent for relay. */
  private onCcFrame(frame: ParsedInbound): void {
    if (frame.kind !== "user") {
      if (frame.kind === "action") this.log(`action frame ${frame.action} (ignored)`);
      else if (frame.kind === "unknown") this.log(`dropped line: ${frame.reason}`);
      return;
    }
    const query = frame.text.trim().toLowerCase();
    if (query === "list") {
      const names = this.roster.map(s => s.name ?? s.id);
      this.send({
        type: "reply",
        toSocket: frame.meta.from,
        text: names.length
          ? `Reachable pi sessions (you can SendMessage any of these directly):\n${names.map(n => `- ${n}`).join("\n")}`
          : "No other pi sessions are currently connected to intercom.",
        msgId: `list-${frame.line.msg_id}`.slice(0, 128),
      });
      return;
    }
    this.send({
      type: "cc-message",
      fromSocket: frame.meta.from,
      fromName: frame.meta.fromName,
      text: frame.text,
      msgId: frame.line.msg_id,
    });
  }

  private watchParent(): void {
    const timer = setInterval(() => {
      if (this.stopped) return;
      try {
        process.kill(this.args.parentPid, 0);
      } catch {
        this.log("parent died; cleaning up");
        void this.stop().then(() => process.exit(0));
      }
    }, 5_000);
    timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.parent?.destroy();
    this.parent = null;
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>(done => server.close(() => done()));
      try {
        if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
      } catch {
        /* best effort */
      }
    }
    removeOwnRecord(process.pid, this.paths);
    this.log(`holder ${this.name} stopped`);
  }
}

if (/holder\.(ts|mjs)$/.test(process.argv[1] ?? "")) {
  const log = (msg: string) => process.stdout.write(`${new Date().toISOString()} holder: ${msg}\n`);
  const holder = new Holder(parseHolderArgs(process.argv), log);
  holder.start().catch(async error => {
    log(`start failed: ${(error as Error).message}`);
    await holder.stop(); // never leave a registry record or socket behind
    process.exit(1);
  });
  const shutdown = () => {
    void holder.stop().then(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
