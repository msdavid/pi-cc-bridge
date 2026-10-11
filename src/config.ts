import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BridgeConfig {
  /** Master switch; the extension does not start the daemon when false. */
  enabled: boolean;
  /** Funnel name CC sessions can address (masquerade record). */
  peerName: string;
  /** Registry poll interval for CC session discovery. */
  pollMs: number;
  /** Pi session (alias or name) that receives funnel messages without a `To:` header. */
  routeTo?: string;

  /**
   * Permission class pi senders declare to CC (CC's hold matrix keys on this).
   * pi has no approval gate by default, so pi sessions are bypass-class.
   * "prompting" asserts a gate exists — an explicit operator opt-in. (P0-6)
   */
  piSenderMode: "bypass" | "prompting";
  /**
   * What the bridge does with inbound CC messages whose sender claims
   * bypass-permissions. Default: hold (CC would hold such senders itself).
   * "accept" delivers everything — explicit operator trust. (P1-13)
   */
  ccInbound: "hold-bypass" | "accept";
  /**
   * Which pi sessions get a CC-native `pi-<alias>` entry at all (globs over
   * intercom aliases, "*" = all). Default []: pi sessions become CC-addressable
   * lazily, on their first outbound message (contact-driven), so the reply
   * path always exists while cold discovery stays opt-in. (P1-13, disagreement)
   */
  expose: string[];
  /** Hard cap on mirrored CC peers (broker has a 128-session budget). (P1-14) */
  maxPeers: number;
  /** Hard cap on holder children. */
  maxHolders: number;
  /** Token-bucket rate limit per direction pair; excess is held, not dropped. (P1-12) */
  relayPerMin: number;
  relayBurst: number;

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
  piSenderMode: "bypass",
  ccInbound: "hold-bypass",
  expose: [],
  maxPeers: 32,
  maxHolders: 16,
  relayPerMin: 6,
  relayBurst: 3,
  logLevel: "normal",
};

export function bridgeStateDir(agentDirOverride?: string): string {
  const agentDir = agentDirOverride?.trim() || process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  const dir = join(agentDir, "pi-cc-bridge");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every(x => typeof x === "string") ? (v as string[]) : undefined;
}

export function loadConfig(stateDir: string): BridgeConfig {
  const file = join(stateDir, "config.json");
  if (!existsSync(file)) return { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    return {
      ...DEFAULT_CONFIG,
      ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
      ...(typeof raw.peerName === "string" && raw.peerName.trim() ? { peerName: raw.peerName.trim() } : {}),
      ...(typeof raw.pollMs === "number" && Number.isFinite(raw.pollMs) && raw.pollMs >= 250 ? { pollMs: raw.pollMs } : {}),
      ...(typeof raw.routeTo === "string" && raw.routeTo.trim() ? { routeTo: raw.routeTo.trim() } : { routeTo: undefined }),
      ...(raw.piSenderMode === "bypass" || raw.piSenderMode === "prompting" ? { piSenderMode: raw.piSenderMode } : {}),
      ...(raw.ccInbound === "hold-bypass" || raw.ccInbound === "accept" ? { ccInbound: raw.ccInbound } : {}),
      ...(strArray(raw.expose) ? { expose: strArray(raw.expose)! } : {}),
      ...(typeof raw.maxPeers === "number" && Number.isFinite(raw.maxPeers) && raw.maxPeers >= 1 ? { maxPeers: Math.floor(raw.maxPeers) } : {}),
      ...(typeof raw.maxHolders === "number" && Number.isFinite(raw.maxHolders) && raw.maxHolders >= 0 ? { maxHolders: Math.floor(raw.maxHolders) } : {}),
      ...(typeof raw.relayPerMin === "number" && Number.isFinite(raw.relayPerMin) && raw.relayPerMin > 0 ? { relayPerMin: raw.relayPerMin } : {}),
      ...(typeof raw.relayBurst === "number" && Number.isFinite(raw.relayBurst) && raw.relayBurst >= 0 ? { relayBurst: raw.relayBurst } : {}),
      ...(raw.logLevel === "quiet" || raw.logLevel === "normal" || raw.logLevel === "debug" ? { logLevel: raw.logLevel } : {}),
      ...(typeof raw.agentDir === "string" ? { agentDir: raw.agentDir } : {}),
      ...(typeof raw.ccSessionsDir === "string" ? { ccSessionsDir: raw.ccSessionsDir } : {}),
      ...(typeof raw.ccSocketDir === "string" ? { ccSocketDir: raw.ccSocketDir } : {}),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
