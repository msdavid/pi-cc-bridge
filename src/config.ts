import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BridgeConfig {
  /** Master switch; the extension does not start the daemon when false. */
  enabled: boolean;
  /** Name CC sessions use to address the bridge (also the registry record name). */
  peerName: string;
  /** Registry poll interval for CC session discovery. */
  pollMs: number;
  /** Pi session (alias or name) that receives CC messages without a `To:` header. */
  routeTo?: string;
  /** Spawn one holder child per live pi session so CC sees `pi-<alias>` natively. */
  nativeEntries: boolean;
  /** Upper bound on concurrent holder children (safety). */
  maxHolders: number;
  /** Daemon log verbosity. */
  logLevel: "quiet" | "normal" | "debug";
  /** Overrides (tests). */
  agentDir?: string;
  ccSessionsDir?: string;
  ccSocketDir?: string;
}

export const DEFAULT_CONFIG: BridgeConfig = {
  enabled: true,
  peerName: "pi-bridge",
  pollMs: 2_000,
  nativeEntries: true,
  maxHolders: 16,
  logLevel: "normal",
};

export function bridgeStateDir(agentDirOverride?: string): string {
  const agentDir = agentDirOverride?.trim() || process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  const dir = join(agentDir, "pi-cc-bridge");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function loadConfig(stateDir: string): BridgeConfig {
  const file = join(stateDir, "config.json");
  if (!existsSync(file)) return { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    return {
      ...DEFAULT_CONFIG,
      ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
      ...(typeof raw.peerName === "string" && raw.peerName.trim() ? { peerName: raw.peerName.trim() } : {}),
      ...(Number.isFinite(raw.pollMs) && raw.pollMs >= 250 ? { pollMs: raw.pollMs } : {}),
      ...(typeof raw.routeTo === "string" && raw.routeTo.trim() ? { routeTo: raw.routeTo.trim() } : { routeTo: undefined }),
      ...(typeof raw.nativeEntries === "boolean" ? { nativeEntries: raw.nativeEntries } : {}),
      ...(Number.isFinite(raw.maxHolders) && raw.maxHolders >= 0 ? { maxHolders: raw.maxHolders } : {}),
      ...(raw.logLevel === "quiet" || raw.logLevel === "normal" || raw.logLevel === "debug" ? { logLevel: raw.logLevel } : {}),
      ...(typeof raw.agentDir === "string" ? { agentDir: raw.agentDir } : {}),
      ...(typeof raw.ccSessionsDir === "string" ? { ccSessionsDir: raw.ccSessionsDir } : {}),
      ...(typeof raw.ccSocketDir === "string" ? { ccSocketDir: raw.ccSocketDir } : {}),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
