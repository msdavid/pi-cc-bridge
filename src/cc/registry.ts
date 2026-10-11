import { readFileSync, readdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { CcRecord, ccSessionsDir, CcPathsOptions } from "./paths.ts";

/**
 * Reader/writer for Claude Code's sessions registry (<sessionsDir>/<pid>.json).
 * The daemon writes exactly one record — its own — and only ever removes records
 * whose messagingSocketPath equals its own socket path (its previous incarnation).
 */

export function readRecordFile(path: string): CcRecord | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof raw?.pid !== "number" || typeof raw?.messagingSocketPath !== "string") return undefined;
    return raw as CcRecord;
  } catch {
    return undefined;
  }
}

export function listRecordsSync(options: CcPathsOptions = {}): { record: CcRecord; file: string }[] {
  const dir = ccSessionsDir(options);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: { record: CcRecord; file: string }[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const record = readRecordFile(`${dir}/${n}`);
    if (record) out.push({ record, file: `${dir}/${n}` });
  }
  return out;
}

/** /proc/<pid>/stat field 22 (starttime), as CC records it (pages since boot). */
export function procStart(pid: number = process.pid): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    return stat.slice(stat.lastIndexOf(")") + 1).split(/\s+/)[19];
  } catch {
    return undefined;
  }
}

/** CC-style pid namespace id from /proc/self/ns/pid ("pid:[4026531836]"). */
export function procNsPid(): string | undefined {
  try {
    return readFileSync("/proc/self/ns/pid", "utf-8").trim();
  } catch {
    return undefined;
  }
}

export function machineIdHash(): string | undefined {
  try {
    return createHash("md5").update(readFileSync("/etc/machine-id", "utf-8").trim()).digest("hex");
  } catch {
    return undefined;
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function writeOwnRecord(record: CcRecord, options: CcPathsOptions = {}): string {
  const dir = ccSessionsDir(options);
  const file = `${dir}/${record.pid}.json`;
  writeFileSync(file, JSON.stringify({ ...record, updatedAt: Date.now() }));
  return file;
}

/** Remove our previous incarnation's record: matching socket path, dead pid. */
export function gcOwnStaleRecord(ownSocketPath: string, options: CcPathsOptions = {}): void {
  for (const { record, file } of listRecordsSync(options)) {
    if (record.messagingSocketPath !== ownSocketPath) continue;
    if (record.pid === process.pid) continue;
    if (isPidAlive(record.pid)) continue;
    try {
      unlinkSync(file);
    } catch {
      /* best effort */
    }
  }
}

export function removeOwnRecord(pid: number = process.pid, options: CcPathsOptions = {}): void {
  const file = `${ccSessionsDir(options)}/${pid}.json`;
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {
    /* best effort */
  }
}
