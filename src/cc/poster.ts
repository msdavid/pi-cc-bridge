import net from "node:net";
import { buildAuthLine, buildOutboundLine } from "./protocol.ts";

/**
 * Post a user line into a CC session's inbox socket, mirroring what a native CC
 * sender does: connect, (optionally) authenticate, write one complete line, and
 * disconnect. CC processes the line between tool calls or on the next idle turn;
 * no ack is written back (verified live on 2.1.296).
 */

export interface PostOptions {
  socketPath: string;
  senderSocketPath: string;
  senderName: string;
  senderMode?: string;
  text: string;
  msgId: string;
  targetSessionId?: string;
  authToken?: string;
  priority?: "now" | "next";
  /** How long to hold the connection open after the write. */
  settleMs?: number;
  connectTimeoutMs?: number;
}

export async function postToCcInbox(options: PostOptions): Promise<void> {
  const line = buildOutboundLine({
    senderSocketPath: options.senderSocketPath,
    senderName: options.senderName,
    senderMode: options.senderMode,
    text: options.text,
    msgId: options.msgId,
    targetSessionId: options.targetSessionId,
    priority: options.priority,
  });
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(options.socketPath);
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(options.connectTimeoutMs ?? 5_000, () => fail(new Error("connect timeout")));
    socket.once("connect", () => {
      socket.setTimeout(0);
      const authLine = options.authToken ? buildAuthLine(options.authToken) : undefined;
      socket.write((authLine ? `${authLine}\n` : "") + line + "\n", "utf-8", () => {
        // Keep the connection briefly so a slow reader drains the buffer, then close.
        setTimeout(() => {
          socket.end();
          resolve();
        }, options.settleMs ?? 250);
      });
    });
    socket.once("error", fail);
  });
}
