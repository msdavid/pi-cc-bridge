import net from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { parseInboundLine, ParsedInbound } from "./protocol.ts";

/**
 * A Claude-Code-compatible inbox socket server: accepts newline-delimited JSON
 * lines exactly like a CC session's inbox (auth line optional on this platform,
 * 30 s silence timeout) and hands parsed frames to the caller.
 */

export interface CcInboxOptions {
  socketPath: string;
  /** Silence timeout before dropping a connection that sent no complete line. */
  lineTimeoutMs?: number;
  onFrame: (frame: ParsedInbound) => void;
  onError?: (error: Error) => void;
}

export interface CcInboxServer {
  path: string;
  close: () => Promise<void>;
}

const LINE_SPLIT = 10; // \n

/** Connect-probe helper: resolves true when something answers the socket. */
function probeSocket(path: string, timeoutMs = 500): Promise<boolean> {
  return new Promise(resolve => {
    const probe = net.createConnection(path);
    const settle = (value: boolean) => {
      probe.destroy();
      resolve(value);
    };
    probe.once("connect", () => settle(true));
    probe.once("error", () => settle(false));
    probe.setTimeout(timeoutMs, () => settle(false));
  });
}

export async function startCcInbox(options: CcInboxOptions): Promise<CcInboxServer> {
  const { socketPath, onFrame, onError } = options;
  const lineTimeoutMs = options.lineTimeoutMs ?? 30_000;

  if (existsSync(socketPath) && (await probeSocket(socketPath))) {
    const error = new Error(`inbox socket ${socketPath} is already served`);
    onError?.(error);
    throw error;
  }

  return await new Promise((resolve, reject) => {
    const server = net.createServer(socket => {
      let buffer = Buffer.alloc(0);
      // On Linux the auth line is optional; CC may still send one first. We
      // accept either (socket permissions are the gate), mirroring CC.
      let authed = true;

      let silence: NodeJS.Timeout | undefined;
      const disarmSilence = () => {
        if (silence) clearTimeout(silence);
      };
      const armSilence = () => {
        disarmSilence();
        silence = setTimeout(() => socket.destroy(), lineTimeoutMs);
        silence.unref?.();
      };
      armSilence();

      socket.on("data", chunk => {
        armSilence();
        buffer = Buffer.concat([buffer, chunk]);
        let idx: number;
        while ((idx = buffer.indexOf(LINE_SPLIT)) !== -1) {
          const lineBytes = buffer.subarray(0, idx);
          buffer = buffer.subarray(idx + 1);
          const line = lineBytes.toString("utf-8").trim();
          if (!line) continue;
          if (!authed) {
            const parsed = parseInboundLine(line);
            if (parsed.kind === "auth") {
              authed = true;
              continue;
            }
            onError?.(new Error("dropped frame from unauthenticated connection"));
            socket.destroy();
            return;
          }
          onFrame(parseInboundLine(line));
        }
      });
      socket.on("error", error => onError?.(error));
      socket.on("close", disarmSilence);
    });

    server.once("error", (error: Error) => {
      onError?.(error);
      reject(error);
    });
    try {
      unlinkSync(socketPath);
    } catch {
      /* not present */
    }
    server.listen(socketPath, () => {
      server.removeAllListeners("error");
      server.on("error", error => onError?.(error));
      resolve({
        path: socketPath,
        close: () =>
          new Promise<void>(done => {
            server.close(() => {
              try {
                unlinkSync(socketPath);
              } catch {
                /* best effort */
              }
              done();
            });
          }),
      });
    });
  });
}
