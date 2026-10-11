/**
 * Claude Code cross-session messaging line envelopes, captured live on 2.1.296.
 *
 * Inbound (what a CC inbox accepts; also what CC sends us when it delivers):
 *   {"msgV":1,"msg_id":"<uuid>","type":"user","message":{"role":"user",
 *    "content":"<cross-session-message from=\"uds:<socket>\" from-name=\"<name>\"
 *    from-mode=\"prompting\">\n<text>\n</cross-session-message>"},
 *    "priority":"next","from":"<sender-socket-path>"}
 *
 * Auth line (optional on Linux): {"type":"auth","token":"<token>"} as the first line.
 * Action frames: {"action":"notify_when_idle","from":…,"msg_id":…,"from_mode":…}.
 */

export const CROSS_SESSION_TAG = "cross-session-message";
const MAX_LINE_BYTES = 1024 * 1024; // CC refuses serialized messages over ~1M chars
const MAX_MSG_ID = 128;
let idCounter = 0;

export interface CcUserLine {
  type: "user";
  msg_id: string;
  message: { role: "user"; content: string };
  from?: string;
  priority?: "now" | "next";
  /** Present on CC-originated sends; must match the receiving session when present. */
  session_id?: string;
  msgV?: number;
}

export interface CrossSessionMeta {
  from?: string;
  fromName?: string;
  fromMode?: string;
}

export type ParsedInbound =
  | { kind: "user"; line: CcUserLine; text: string; meta: CrossSessionMeta }
  | { kind: "action"; action: string; raw: Record<string, unknown> }
  | { kind: "auth"; raw: Record<string, unknown> }
  | { kind: "unknown"; reason: string; raw?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse one socket line as CC's inbox would. Never throws. */
export function parseInboundLine(line: string): ParsedInbound {
  if (Buffer.byteLength(line, "utf-8") > MAX_LINE_BYTES) {
    return { kind: "unknown", reason: "line exceeds size cap" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { kind: "unknown", reason: "not JSON" };
  }
  if (!isRecord(raw)) return { kind: "unknown", reason: "not an object" };
  if (raw.action !== undefined && typeof raw.action === "string") {
    return { kind: "action", action: raw.action, raw };
  }
  if (typeof raw.type !== "string") {
    return { kind: "unknown", reason: "without valid type field", raw };
  }
  if (raw.type === "auth") {
    return { kind: "auth", raw };
  }
  if (raw.type !== "user") {
    return { kind: "unknown", reason: `unsupported type ${raw.type}`, raw };
  }
  const message = isRecord(raw.message) ? raw.message : undefined;
  const content = message?.content;
  if (typeof content !== "string" || content.length === 0) {
    return { kind: "unknown", reason: "user message with missing or non-string content" };
  }
  const candidate = [raw.msg_id, raw.uuid].find(
    (v): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_MSG_ID,
  );
  // CC accepts a missing id (it synthesizes one); we synthesize a local id too.
  const msgId = candidate ?? `gen-${Date.now().toString(36)}-${(idCounter = (idCounter + 1) % 1e6).toString(36)}`;
  if (raw.priority !== undefined && raw.priority !== "now" && raw.priority !== "next") {
    return { kind: "unknown", reason: `unsupported priority ${String(raw.priority)}` };
  }
  const meta = unwrapCrossSessionMessage(content);
  const parsed: CcUserLine = {
    type: "user",
    msg_id: msgId,
    message: { role: "user", content },
    ...(typeof raw.from === "string" ? { from: raw.from } : {}),
    ...(raw.priority === "now" || raw.priority === "next" ? { priority: raw.priority } : {}),
    ...(typeof raw.session_id === "string" ? { session_id: raw.session_id } : {}),
    ...(typeof raw.msgV === "number" ? { msgV: raw.msgV } : {}),
  };
  return { kind: "user", line: parsed, text: meta.text, meta: meta.meta };
}

/** Split `<cross-session-message …>\n<text>\n</cross-session-message>` — or return text as-is. */
export function unwrapCrossSessionMessage(content: string): { text: string; meta: CrossSessionMeta } {
  const openTag = `<${CROSS_SESSION_TAG}`;
  if (!content.startsWith(openTag)) {
    return { text: content, meta: {} as CrossSessionMeta };
  }
  const closeTag = `</${CROSS_SESSION_TAG}>`;
  const gt = content.indexOf(">", openTag.length);
  if (gt === -1) return { text: content, meta: {} };
  const end = content.lastIndexOf(closeTag);
  if (end === -1 || end < gt) return { text: content, meta: {} as CrossSessionMeta };
  const header = content.slice(openTag.length, gt);
  const body = content.slice(gt + 1, end);
  const meta: CrossSessionMeta = {};
  const unescape = (v: string) => v.replace(/&(amp|quot|lt);/g, (_, e) => (e === "amp" ? "&" : e === "quot" ? '"' : "<"));
  for (const key of ["from", "from-name", "from-mode"] as const) {
    const match = header.match(new RegExp(`${key}="([^"]*)"`));
    if (match) {
      const value = unescape(match[1]);
      if (key === "from") meta.from = value;
      else if (key === "from-name") meta.fromName = value;
      else meta.fromMode = value;
    }
  }
  return { text: body.replace(/^\n/, "").replace(/\n$/, ""), meta };
}

/** Build the exact line shape CC writes when a session sends to a peer. */
export function buildOutboundLine(params: {
  senderSocketPath: string;
  senderName: string;
  senderMode?: string;
  text: string;
  msgId: string;
  targetSessionId?: string;
  priority?: "now" | "next";
}): string {
  const header = [
    `from="uds:${params.senderSocketPath}"`,
    `from-name="${escapeAttr(params.senderName)}"`,
    `from-mode="${escapeAttr(params.senderMode ?? "prompting")}"`,
  ].join(" ");
  const content = `<${CROSS_SESSION_TAG} ${header}>\n${params.text}\n</${CROSS_SESSION_TAG}>`;
  const line: CcUserLine & { msgV: number } = {
    msgV: 1,
    msg_id: params.msgId,
    type: "user",
    message: { role: "user", content },
    priority: params.priority ?? "next",
    from: params.senderSocketPath,
    ...(params.targetSessionId ? { session_id: params.targetSessionId } : {}),
  };
  return JSON.stringify(line);
}

export function buildAuthLine(token: string): string {
  return JSON.stringify({ type: "auth", token });
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&' + 'amp;')
    .replace(/"/g, '&' + 'quot;')
    .replace(/</g, '&' + 'lt;');
}
