import net, { Socket } from "node:net";
import { EventEmitter } from "node:events";
import { readFileSync, existsSync } from "node:fs";
import { writeFrame, createFrameReader } from "./framing.ts";
import { join } from "node:path";

/**
 * Minimal pi-intercom broker client (protocol "pi-intercom" v1, as shipped in
 * pi-intercom 0.17.0): length-prefixed JSON frames (4-byte big-endian length +
 * payload), one registered session per connection.
 *
 * Lifecycle (P0-2): connectAndRegister resolves only on the broker's
 * `registered` frame (bounded by a timeout) and rejects on error frames or a
 * socket close. Afterwards, `close`/`error` emit `disconnected` — the owner
 * decides on reconnection. rawSend throws when not connected instead of
 * dropping frames silently.
 */

export const INTERCOM_PROTOCOL_NAME = "pi-intercom";
export const INTERCOM_PROTOCOL_VERSION = 1;

export interface SessionRegistration {
  name?: string;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
  acknowledgesReceipts?: boolean;
  livenessIntervalMs?: number;
}

export interface IntercomMessage {
  id: string;
  timestamp: number;
  replyTo?: string;
  expectsReply?: boolean;
  content: { text: string };
}

export interface BrokerSessionInfo {
  id: string;
  name?: string;
  cwd: string;
  model: string;
  pid: number;
  status?: string;
}

export interface MessageReceiptFrame {
  messageId: string;
  status: string;
  timestamp: number;
  detail?: string;
}

export type BrokerEvent =
  | { type: "registered"; sessionId: string; features?: string[] }
  | { type: "sessions"; requestId: string; sessions: BrokerSessionInfo[] }
  | { type: "message"; from: BrokerSessionInfo; message: IntercomMessage }
  | { type: "delivered"; messageId: string }
  | { type: "delivery_failed"; messageId: string; reason: string }
  | { type: "message_receipt"; from: BrokerSessionInfo; receipt: MessageReceiptFrame }
  | { type: "session_joined"; session: BrokerSessionInfo }
  | { type: "session_left"; sessionId: string }
  | { type: "presence_update"; session: BrokerSessionInfo }
  | { type: "error"; error: string; code?: string };

/** Broker connect target: the Unix socket. This package requires /proc and
 * /etc/machine-id (see package.json "os"), so the broker's TCP fallback
 * (Windows) is out of scope — and it would need a stateId on register (P3-4). */
export function brokerConnectTarget(agentDir: string): { kind: "unix"; path: string } {
  const intercomDir = join(agentDir, "intercom");
  const sock = join(intercomDir, "broker.sock");
  if (existsSync(sock)) return { kind: "unix", path: sock };
  throw new Error(`no pi-intercom broker endpoint found under ${intercomDir}`);
}

export class BrokerClient extends EventEmitter {
  private socket: Socket | null = null;
  private onData: ((data: Buffer) => void) | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private registered = false;
  private heartbeatIntervalMs = 10_000;
  listSeq = 0;

  constructor(
    private readonly agentDir: string,
    private readonly log: (msg: string) => void = () => {},
  ) {
    super();
  }

  get isRegistered(): boolean {
    return this.registered;
  }

  get isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  /**
   * Connect + register. Resolves on the `registered` frame; rejects on error
   * frames, socket close, or timeout. Safe to await: no partial state is left
   * behind on failure (socket destroyed by the caller on rejection).
   */
  async connectAndRegister(sessionId: string, session: SessionRegistration, timeoutMs = 5_000): Promise<void> {
    if (this.socket) throw new Error("broker client already connected");
    this.heartbeatIntervalMs = session.livenessIntervalMs ?? 10_000;
    const target = brokerConnectTarget(this.agentDir);
    const socket = net.createConnection(target.path);
    this.socket = socket;
    socket.setNoDelay(true);
    this.onData = createFrameReader(raw => this.handleFrame(raw), error => {
      this.emit("error", { type: "error", error: error.message, code: "E_FRAME" });
      this.close();
    });
    socket.on("data", chunk => this.handleSocketData(chunk));
    socket.on("error", error => this.log(`broker socket: ${error.message}`));
    socket.on("close", () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      this.socket = null;
      this.registered = false;
      this.emit("disconnected");
    });

    await new Promise<void>((resolve, reject) => {
      const ok = (event: { type: string }) => {
        if (event.type !== "registered") return;
        cleanup();
        resolve();
      };
      const bad = (event: { type: string; error?: string; code?: string }) => {
        if (event.type !== "error") return;
        cleanup();
        reject(new Error(`${event.code ?? "E_BROKER"}: ${event.error ?? "broker error"}`));
      };
      const closed = () => {
        cleanup();
        reject(new Error("broker closed during register"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("broker register timeout"));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off("registered", ok);
        this.off("error", bad);
        socket.off("close", closed);
      };
      this.on("registered", ok);
      this.on("error", bad);
      socket.once("close", closed);
      socket.once("connect", () => writeFrame(socket, { type: "register", sessionId, session }));
    });

    this.heartbeat = setInterval(() => this.presence(), Math.max(1_000, this.heartbeatIntervalMs - 1_000));
    this.heartbeat.unref?.();
  }

  private handleSocketData(data: Buffer): void {
    this.onData?.(data);
  }

  private handleFrame(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch (error) {
      this.emit("error", { type: "error", error: `bad broker frame: ${(error as Error).message}`, code: "E_FRAME" });
      return;
    }
    const event = msg as BrokerEvent;
    if (event && typeof event === "object" && "type" in event) {
      if (event.type === "registered") this.registered = true;
      if (event.type === "error") this.log(`broker error: ${event.error}${event.code ? ` (${event.code})` : ""}`);
      this.emit(event.type, event);
    }
  }

  send(to: string, message: IntercomMessage): void {
    this.rawSend({ type: "send", to, message });
  }

  list(): string {
    const requestId = `list-${++this.listSeq}-${Date.now()}`;
    this.rawSend({ type: "list", requestId });
    return requestId;
  }

  receipt(messageId: string, status: "receiver_received" = "receiver_received"): void {
    this.rawSend({ type: "message_receipt", receipt: { messageId, status, timestamp: Date.now() } });
  }

  presence(status?: string): void {
    this.rawSend(status === undefined ? { type: "presence" } : { type: "presence", status });
  }

  unregister(): void {
    if (this.socket) this.rawSend({ type: "unregister" });
  }

  private rawSend(msg: unknown): void {
    if (!this.socket || this.socket.destroyed) throw new Error("broker client not connected");
    writeFrame(this.socket, msg);
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.socket) {
      try {
        if (this.registered) this.unregister();
      } catch {
        /* best effort */
      }
      this.socket.destroy();
      this.socket = null;
    }
    this.registered = false;
  }
}
