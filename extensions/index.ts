import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * pi-cc-bridge extension (thin): supervises the bridge daemon and exposes
 * /cc-bridge. Messaging itself needs nothing here — the daemon registers
 * synthetic peers with pi-intercom's broker, so `claude:*` peers simply appear
 * in every intercom list on this machine.
 */

const EXTENSION_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function stateDir(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(process.env.HOME ?? "", ".pi", "agent");
  return join(agentDir, "pi-cc-bridge");
}

function daemonPid(): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(join(stateDir(), "daemon.pid"), "utf-8").trim(), 10);
    if (!Number.isFinite(pid)) return undefined;
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

function resolveTsxLoader(): string | undefined {
  try {
    return createRequire(join(EXTENSION_DIR, "package.json")).resolve("tsx");
  } catch {
    const sibling = join(EXTENSION_DIR, "..", "tsx", "dist", "loader.mjs");
    return existsSync(sibling) ? sibling : join(EXTENSION_DIR, "node_modules", "tsx", "dist", "loader.mjs");
  }
}

function spawnDaemon(): boolean {
  if (daemonPid()) return true;
  const loader = resolveTsxLoader();
  if (!loader) return false;
  const child = spawn(process.execPath, ["--import", loader, join(EXTENSION_DIR, "src", "cli.ts")], {
    detached: true,
    stdio: "ignore",
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
        if (spawnDaemon()) {
          await new Promise(resolve => setTimeout(resolve, 1_500));
          const after = daemonPid();
          ctx.ui.notify(after ? `pi-cc-bridge daemon started (pid ${after})` : "pi-cc-bridge daemon did not start; see daemon.log", after ? "info" : "warning");
        } else {
          ctx.ui.notify("pi-cc-bridge: could not start (tsx loader missing?)", "error");
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
      ctx.ui.notify(`pi-cc-bridge daemon: ${pid ? `running (pid ${pid})` : "not running"}\nstate dir: ${stateDir()}`, "info");
    },
  });

  // Idempotent auto-start: the daemon exits itself if another instance holds
  // the pid, so every pi session loading this extension is safe.
  if (!daemonPid()) spawnDaemon();
}
