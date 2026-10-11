import net from "node:net";
import { existsSync, mkdirSync, unlinkSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseInboundLine, ParsedInbound } from "./cc/protocol.ts";
import { CcRecord, ownSocketPath, CcPathsOptions, BRIDGE_OWNER } from "./cc/paths.ts";
import { machineIdHash, procStart, procNsPid, writeOwnRecord, removeOwnRecord, listRecordsSync, pidDomainFor } from "./cc/registry.ts";

/**
 * Holder child: one per live pi session. Binds a CC-compatible inbox socket and
 * writes a registry record named `pi-<peerPrefix><alias>` so Claude Code sees
 * (and addresses) each pi session natively in /list-agents.
 *
 * The child holds no broker connection: it forwards EVERY user frame to the
 * parent daemon over private IPC (the daemon owns routing, `list`, and `To:`),
 * and the parent relays via the sending CC session's own synthetic peer
 * connection — attribution stays correct and no extra intercom sessions are
 * created. Status/alias updates arrive on the same IPC socket; a watchdog
 * makes the child clean up and exit if the parent dies.
 */

const LINE = 10; // \n
const MAX_LINE_BYTES = 1024 * 1024;

export interface HolderArgs {
  alias: string;
  piSessionId: string;
  parentPid: number;
  ipcPath: string;
  peerPrefix: string;
  heldDir?: string;
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
    heldDir: typeof raw.heldDir === "string" ? raw.heldDir : undefined,
    sessionsDir: raw.sessionsDir,
    socketDir: raw.socketDir,
  };
}

export class Holder {
  private readonly paths: CcPathsOptions;
  private socketPath: string;
  private record: CcRecord;
  private name: string;
  private server: net.Server | null = null;
  private parent: net.Socket | null = null;
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
      peerFeatures: ["reply_across_default_dirs"], // notify_idle advertised only once implemented (P1-10)
      kind: "bridge",
      entrypoint: "cli",
      pidDomain: pidDomainFor(listRecordsSync(this.paths)),
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
    // Bind first, then publish the record: CC preflights the socket's peer pid,
    // so the record must never name a socket that is not listening yet (P3-7).
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
    writeOwnRecord(this.record, this.paths);
    await this.connectParent();
    this.watchParent();
    this.log(`holder ${this.name} up (pid ${process.pid}, socket ${this.socketPath})`);
  }

  private serveInbox(socket: net.Socket): void {
    let buffer = Buffer.alloc(0);
    let silence: NodeJS.Timeout | undefined;
    const armSilence = () => {
      if (silence) clearTimeout(silence);
      silence = setTimeout(() => socket.destroy(), 30_000); // CC drops silent conns too
      silence.unref?.();
    };
    armSilence();
    socket.on("data", chunk => {
      armSilence();
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_LINE_BYTES) {
        this.log("inbox line exceeds cap; dropping connection");
        socket.destroy();
        buffer = Buffer.alloc(0);
        return;
      }
      let idx: number;
      while ((idx = buffer.indexOf(LINE)) !== -1) {
        const line = buffer.subarray(0, idx).toString("utf-8").trim();
        buffer = buffer.subarray(idx + 1);
        if (line) this.onCcFrame(parseInboundLine(line));
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => silence && clearTimeout(silence));
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
    parent.on("close", () => {
      this.parent = null;
      // Parent link lost (crash or pid reuse): exit and let it respawn us.
      // The 5s poll stays only as a backstop for lost close events (P3-6).
      if (!this.stopped) void this.stop().then(() => process.exit(0));
    });
    this.send({
      type: "hello",
      pid: process.pid,
      alias: this.args.alias,
      piSessionId: this.args.piSessionId,
      name: this.name,
      socketPath: this.socketPath, // the daemon needs the real reply socket (P0-4)
    });
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
      case "shutdown": {
        void this.stop();
        break;
      }
    }
  }

  private send(msg: unknown): boolean {
    if (!this.parent || this.parent.destroyed) {
      this.spool(msg);
      return false;
    }
    try {
      this.parent.write(JSON.stringify(msg) + "\n");
      return true;
    } catch {
      this.spool(msg);
      return false;
    }
  }

  /** Parent link down: never lose CC traffic — spool locally. (P1-7) */
  private spool(msg: unknown): void {
    if (!this.args.heldDir) return;
    try {
      mkdirSync(this.args.heldDir, { recursive: true, mode: 0o700 });
      const file = join(this.args.heldDir, `holder-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`);
      writeFileSync(file, JSON.stringify(msg, null, 2), { flag: "wx", mode: 0o600 });
      appendFileSync(join(this.args.heldDir, "holder.log"), `${new Date().toISOString()} spooled ${file}\n`);
      this.log(`parent link down; spooled to ${file}`);
    } catch (error) {
      this.log(`spool failed: ${(error as Error).message}`);
    }
  }

  /** CC → pi: parse the inbound line and hand it to the parent for ALL decisions. */
  private onCcFrame(frame: ParsedInbound): void {
    if (frame.kind !== "user") {
      if (frame.kind === "action") this.log(`action frame ${frame.action} (ignored)`);
      else if (frame.kind === "unknown") this.log(`dropped line: ${frame.reason}`);
      return;
    }
    this.send({
      type: "cc-message",
      fromSocket: frame.line.from ?? frame.meta.from, // structured field first (P1-4)
      fromName: frame.meta.fromName,
      fromMode: frame.meta.fromMode, // the daemon enforces its own inbound policy (P1-13)
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
  process.on("uncaughtException", error => {
    log(`uncaught: ${error.stack ?? error.message}; exiting for respawn`);
    void holder.stop().then(() => process.exit(1));
  });
}
