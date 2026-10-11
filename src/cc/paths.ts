import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Filesystem layout of Claude Code's messaging surface, as captured on 2.1.296.
 * Socket: $XDG_RUNTIME_DIR/cc-socks/<pid>.sock (fallback /tmp/cc-socks-<uid>/).
 * Registry: <claude-config-dir>/sessions/<pid>.json (+ <pid>.<sha256(path)>.key).
 */

export interface CcPathsOptions {
  /** Override for the CC sessions registry dir (tests). Defaults under CLAUDE_CONFIG_DIR or ~/.claude. */
  ccSessionsDir?: string;
  /** Override for the runtime socket dir (tests). Defaults to XDG_RUNTIME_DIR. */
  socketDir?: string;
}

function claudeConfigDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (configured) return configured;
  return join(homedir(), ".claude");
}

export function ccSessionsDir(options: CcPathsOptions = {}): string {
  if (options.ccSessionsDir?.trim()) return options.ccSessionsDir;
  return join(claudeConfigDir(), "sessions");
}

export function ccSocketDir(options: CcPathsOptions = {}): string {
  if (options.socketDir?.trim()) return options.socketDir;
  const runtime = process.env.XDG_RUNTIME_DIR?.trim();
  if (runtime) return join(runtime, "cc-socks");
  return `/tmp/cc-socks-${process.getuid?.() ?? 0}`;
}

/** The socket path this process would own: <socketDir>/<pid>.sock. */
export function ownSocketPath(options: CcPathsOptions = {}): string {
  return join(ccSocketDir(options), `${process.pid}.sock`);
}

export interface CcRecord {
  pid: number;
  sessionId: string;
  cwd?: string;
  startedAt?: number;
  procStart?: string;
  version?: string;
  peerProtocol?: number;
  peerFeatures?: string[];
  kind?: string;
  entrypoint?: string;
  pidDomain?: string;
  messagingSocketPath: string;
  name?: string;
  nameSource?: string;
  nameSince?: number;
  updatedAt?: number;
  status?: string;
  statusUpdatedAt?: number;
}

export const SUPPORTED_PEER_PROTOCOL = 1;

/** True when a registry record names a socket this daemon can plausibly target. */
export function isTargetableRecord(record: CcRecord): boolean {
  if (typeof record.pid !== "number" || record.pid <= 0) return false;
  if (typeof record.messagingSocketPath !== "string" || record.messagingSocketPath.length === 0) return false;
  if (record.peerProtocol !== undefined && record.peerProtocol !== SUPPORTED_PEER_PROTOCOL) return false;
  return true;
}
