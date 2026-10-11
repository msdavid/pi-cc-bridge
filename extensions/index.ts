import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * pi-cc-bridge extension (thin): supervises the bridge daemon and exposes
 * /cc-bridge. Messaging itself needs nothing here — the daemon registers
 * synthetic peers with pi-intercom's broker, so `claude:*` peers simply appear
 * in every intercom list on this machine.
 *
 * Hardened per critique P0-3/P1-15: the daemon self-locks (O_EXCL, `pid
 * procStart`), so spawning from every pi session is safe — losers exit 0.
 * Liveness is verified against procStart before a pid is trusted or signalled.
 */

const EXTENSION_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function stateDir(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(process.env.HOME ?? "", ".pi", "agent");
  return join(agentDir, "pi-cc-bridge");
}

function lockPath(): string {
  return join(stateDir(), "daemon.lock");
}

/** Only trust a lock pid whose procStart matches the recorded one. */
function daemonPid(): number | undefined {
  try {
    const [p, s] = readFileSync(lockPath(), "utf-8").trim().split(" ");
    const pid = Number(p);
    if (!Number.isFinite(pid)) return undefined;
    process.kill(pid, 0);
    if (s && s !== "unknown") {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
        const real = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
        if (real !== s) return undefined; // pid recycled by another process
      } catch {
        return undefined;
      }
    }
    return pid;
  } catch {
    return undefined;
  }
}

function nodeCommand(): string {
  const exe = process.execPath.split(/[\\/]/).pop() ?? "";
  return /^node(?:js)?(?:\.exe)?$/i.test(exe) ? process.execPath : "node";
}

function daemonEntry(): string {
  const bundled = join(EXTENSION_DIR, "dist", "cli.mjs");
  if (existsSync(bundled)) return bundled;
  const src = join(EXTENSION_DIR, "src", "cli.ts");
  if (!existsSync(src)) return "";
  try {
    createRequire(join(EXTENSION_DIR, "package.json")).resolve("tsx");
    return src;
  } catch {
    return "";
  }
}

function loadConfigEnabled(): boolean {
  try {
    const cfg = JSON.parse(readFileSync(join(stateDir(), "config.json"), "utf-8")) as { enabled?: boolean };
    return cfg.enabled !== false;
  } catch {
    return true;
  }
}

function spawnDaemon(ui: { notify(message: string, type?: "error" | "warning" | "info"): void }): boolean {
  const entry = daemonEntry();
  if (!entry) {
    ui.notify("pi-cc-bridge: daemon entry not found (build missing and no tsx); run `npm i && npm run build`", "error");
    return false;
  }
  if (!loadConfigEnabled()) return false;
  const args = entry.endsWith(".ts")
    ? ["--import", createRequire(join(EXTENSION_DIR, "package.json")).resolve("tsx"), entry]
    : [entry];
  const child = spawn(nodeCommand(), args, {
    detached: true,
    stdio: "ignore",
    cwd: stateDir(),
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  child.unref();
  return true;
}

export default function piCcBridgeExtension(pi: import("@earendil-works/pi-coding-agent").ExtensionAPI) {
  pi.registerCommand("cc-bridge", {
    description: "pi-cc-bridge daemon status; /cc-bridge start or stop to manage it",
    handler: async (args, ctx) => {
      const sub = args?.trim().split(/\s+/)[0];
      const pid = daemonPid();
      if (sub === "start") {
        if (pid) {
          ctx.ui.notify(`pi-cc-bridge daemon already running (pid ${pid})`, "info");
        } else if (spawnDaemon(ctx.ui)) {
          await new Promise(resolve => setTimeout(resolve, 1_500));
          const after = daemonPid();
          ctx.ui.notify(after ? `pi-cc-bridge daemon started (pid ${after})` : "pi-cc-bridge daemon did not start; see daemon.log", after ? "info" : "warning");
        }
        return;
      }
      if (sub === "stop") {
        if (pid) {
          process.kill(pid, "SIGTERM");
          ctx.ui.notify(`pi-cc-bridge daemon (pid ${pid}) stopping`, "info");
        } else {
          ctx.ui.notify("pi-cc-bridge daemon not running", "info");
        }
        return;
      }
      let held = 0;
      try {
        held = readdirSync(join(stateDir(), "held")).filter(f => f.endsWith(".json")).length;
      } catch {
        /* no held dir */
      }
      ctx.ui.notify(
        `pi-cc-bridge daemon: ${pid ? `running (pid ${pid})` : "not running"}\nstate dir: ${stateDir()}\nheld messages: ${held}`,
        "info",
      );
    },
  });

  // Idempotent supervision: the daemon self-locks, so concurrent spawns are
  // harmless; a 60s re-check revives it after crashes/reboots (P0-7).
  const silentUi = { notify: () => {} };
if (!daemonPid() && loadConfigEnabled()) spawnDaemon(silentUi);
setInterval(() => {
  if (!daemonPid() && loadConfigEnabled()) spawnDaemon(silentUi);
}, 60_000).unref();
}
