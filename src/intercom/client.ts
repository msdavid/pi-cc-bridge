import net, { Socket } from "node:net";
import { EventEmitter } from "node:events";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Minimal pi-intercom broker client (protocol "pi-intercom" v1, as shipped in
 * pi-intercom 0.17.0): newline-free length-prefixed JSON frames
 * (4-byte big-endian length + payload), one registered session per connection.
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

export type BrokerEvent =
  | { type: "registered"; sessionId: string; features?: string[] }
  | { type: "sessions"; requestId: string; sessions: BrokerSessionInfo[] }
  | { type: "message"; from: BrokerSessionInfo; message: IntercomMessage }
  | { type: "delivered"; messageId: string }
  | { type: "delivery_failed"; messageId: string; reason: string }
  | { type: "session_joined"; session: BrokerSessionInfo }
  | { type: "session_left"; sessionId: string }
  | { type: "presence_update"; session: BrokerSessionInfo }
  | { type: "error"; error: string; code?: string };

const MAX_FRAME_BYTES = 1024 * 1024;

function writeFrame(socket: Socket, msg: unknown): void {
  const json = JSON.stringify(msg);
  const payloadLength = Buffer.byteLength(json, "utf-8");
  const frame = Buffer.allocUnsafe(4 + payloadLength);
  frame.writeUInt32BE(payloadLength, 0);
  frame.write(json, 4, payloadLength, "utf-8");
  socket.write(frame);
}

/** Broker connect target: Unix socket preferred, TCP fallback (Windows). */
export function brokerConnectTarget(agentDir: string): { kind: "unix"; path: string } | { kind: "tcp"; host: string; port: number } {
  const intercomDir = join(agentDir, "intercom");
  const sock = join(intercomDir, "broker.sock");
  if (existsSync(sock)) return { kind: "unix", path: sock };
  const portFile = join(intercomDir, "broker.port.json");
  try {
    const parsed = JSON.parse(readFileSync(portFile, "utf-8"));
    if (parsed?.transport === "tcp" && parsed.host === "127.0.0.1" && typeof parsed.port === "number") {
      return { kind: "tcp", host: parsed.host, port: parsed.port };
    }
  } catch {
    /* fallthrough */
  }
  throw new Error(`no pi-intercom broker endpoint found under ${intercomDir}`);
}

export class BrokerClient extends EventEmitter {
  private socket: Socket | null = null;
  private header = Buffer.allocUnsafe(4);
  private headerBytes = 0;
  private payload: Buffer | null = null;
  private payloadBytes = 0;
  private payloadLength = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private registered = false;
  listSeq = 0;

  constructor(
    private readonly agentDir: string,
    private readonly log: (msg: string) => void = () => {},
  ) {
    super();
  }

  async connectAndRegister(sessionId: string, session: SessionRegistration): Promise<void> {
    const target = brokerConnectTarget(this.agentDir);
    await new Promise<void>((resolve, reject) => {
      const socket =
        target.kind === "unix" ? net.createConnection(target.path) : net.createConnection(target.port, target.host);
      this.socket = socket;
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.setNoDelay(true);
        socket.on("data", chunk => this.onData(chunk));
        writeFrame(socket, {
          type: "register",
          sessionId,
          session,
        });
        resolve();
      });
    });
    const interval = session.livenessIntervalMs ?? 10_000;
    this.heartbeat = setInterval(() => this.presence(), Math.max(1_000, interval - 1_000));
    this.heartbeat.unref?.();
  }

  private onData(data: Buffer): void {
    let offset = 0;
    while (offset < data.length) {
      if (this.headerBytes < 4) {
        const bytes = Math.min(4 - this.headerBytes, data.length - offset);
        data.copy(this.header, this.headerBytes, offset, offset + bytes);
        this.headerBytes += bytes;
        offset += bytes;
        if (this.headerBytes < 4) return;
        this.payloadLength = this.header.readUInt32BE(0);
        if (this.payloadLength > MAX_FRAME_BYTES) {
          this.emit("broker_error", new Error(`frame too large: ${this.payloadLength}`));
          this.close();
          return;
        }
      }
      if (this.payload === null || this.payload.length !== this.payloadLength) {
        this.payload = Buffer.allocUnsafe(this.payloadLength);
      }
      const bytes = Math.min(this.payloadLength - this.payloadBytes, data.length - offset);
      data.copy(this.payload, this.payloadBytes, offset, offset + bytes);
      this.payloadBytes += bytes;
      offset += bytes;
      if (this.payloadBytes < this.payloadLength) return;
      const framePayload = this.payload;
      this.headerBytes = 0;
      this.payload = null;
      this.payloadBytes = 0;
      this.payloadLength = 0;
      this.handleFrame(framePayload.toString("utf-8"));
    }
  }

  private handleFrame(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch (error) {
      this.emit("broker_error", new Error(`bad broker frame: ${(error as Error).message}`));
      return;
    }
    const event = msg as BrokerEvent;
    if (event && typeof event === "object" && "type" in event) {
      if (event.type === "registered") this.registered = true;
      if (event.type === "error") this.log(`broker error: ${event.error}${event.code ? ` (${event.code})` : ""}`);
      this.emit(event.type, event);
    }
  }

  get isRegistered(): boolean {
    return this.registered;
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
    if (!this.socket) throw new Error("broker client not connected");
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
