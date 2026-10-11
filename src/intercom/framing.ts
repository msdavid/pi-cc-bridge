import { Socket } from "node:net";

/** Length-prefixed JSON framing shared by the broker client (and tests). */
export const MAX_FRAME_BYTES = 1024 * 1024;

export function writeFrame(socket: Socket, msg: unknown): void {
  const json = JSON.stringify(msg);
  const payloadLength = Buffer.byteLength(json, "utf-8");
  const frame = Buffer.allocUnsafe(4 + payloadLength);
  frame.writeUInt32BE(payloadLength, 0);
  frame.write(json, 4, payloadLength, "utf-8");
  socket.write(frame);
}

/** Reassembles 4-byte-BE-length frames across arbitrary chunk boundaries. */
export function createFrameReader(
  onFrame: (raw: string) => void,
  onError: (error: Error) => void,
  maxFrameBytes = MAX_FRAME_BYTES,
): (data: Buffer) => void {
  const header = Buffer.allocUnsafe(4);
  let headerBytes = 0;
  let payload: Buffer | null = null;
  let payloadBytes = 0;
  let payloadLength = 0;

  return (data: Buffer): void => {
    let offset = 0;
    while (offset < data.length) {
      if (headerBytes < 4) {
        const bytes = Math.min(4 - headerBytes, data.length - offset);
        data.copy(header, headerBytes, offset, offset + bytes);
        headerBytes += bytes;
        offset += bytes;
        if (headerBytes < 4) return;
        payloadLength = header.readUInt32BE(0);
        if (payloadLength > maxFrameBytes) {
          headerBytes = 0;
          onError(new Error(`frame length ${payloadLength} exceeds maximum ${maxFrameBytes} bytes`));
          return;
        }
      }
      if (payload === null || payload.length !== payloadLength) {
        payload = Buffer.allocUnsafe(payloadLength);
      }
      const bytes = Math.min(payloadLength - payloadBytes, data.length - offset);
      data.copy(payload, payloadBytes, offset, offset + bytes);
      payloadBytes += bytes;
      offset += bytes;
      if (payloadBytes < payloadLength) return;
      const framePayload = payload;
      headerBytes = 0;
      payload = null;
      payloadBytes = 0;
      payloadLength = 0;
      onFrame(framePayload.toString("utf-8"));
    }
  };
}
