import { readFileSync, readdirSync, writeFileSync, unlinkSync, existsSync, renameSync, readlinkSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { CcRecord, ccSessionsDir, CcPathsOptions, BRIDGE_OWNER } from "./paths.ts";

/**
 * Reader/writer for Claude Code's sessions registry (<sessionsDir>/<pid>.json).
 *
 * The daemon and holders write exactly one record each — their own — marked
 * with `bridgeOwner`. Removal is limited to bridgeOwner records with dead pids
 * (our own previous incarnations) — never other sessions' records. (P0-1)
 */

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Strict-ish record validation: one bad record must never break the poll (P1-6). */
export function readRecordFile(path: string): CcRecord | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    if (typeof raw?.pid !== "number" || raw.pid <= 0) return undefined;
    if (typeof raw?.messagingSocketPath !== "string" || raw.messagingSocketPath.length === 0) return undefined;
    if (typeof raw?.sessionId !== "string" || raw.sessionId.length === 0) return undefined;
    return {
      ...(raw as unknown as CcRecord),
      name: str(raw.name),
      status: str(raw.status),
      kind: str(raw.kind),
      cwd: str(raw.cwd),
      procStart: str(raw.procStart),
      version: str(raw.version),
      pidDomain: str(raw.pidDomain),
      entrypoint: str(raw.entrypoint),
    };
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
    try {
      const record = readRecordFile(`${dir}/${n}`);
      if (record) out.push({ record, file: `${dir}/${n}` });
    } catch {
      /* per-record isolation */
    }
  }
  return out;
}

/**
 * /proc/<pid>/stat field 22 (starttime, pages since boot), as CC records it.
 * After "(comm)" the remainder begins with the field-3 separator; a leading
 * space would make element 0 empty and shift every index — trim first.
 * (P0-1: the missing trim made this return field 21, `itrealvalue`, always "0".)
 */
export function procStart(pid: number = process.pid): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    return stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
  } catch {
    return undefined;
  }
}

/**
 * CC-style pid namespace id, read via readlink (nsfs magic links fail on
 * read() with EINVAL). Returns e.g. "pid:[4026531836]".
 */
export function procNsPid(): string | undefined {
  try {
    return readlinkSync("/proc/self/ns/pid");
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

/**
 * pidDomain for records we write. Prefer a live CC record's pidDomain verbatim
 * — same machine, same pid namespace — and only compute a fallback otherwise.
 */
export function pidDomainFor(records: { record: CcRecord }[]): string {
  const ns = procNsPid();
  const live = records.find(
    r => r.record.kind !== "bridge" && typeof r.record.pidDomain === "string" && r.record.pidDomain.endsWith(`:pid:[${ns ?? ""}]`),
  );
  if (live?.record.pidDomain) return live.record.pidDomain;
  return `linux:${machineIdHash() ?? "unknown"}:pid:[${ns ?? "unknown"}]`;
}

/**
 * Drift self-check: recompute procStart for a live CC session and compare with
 * the value CC itself wrote. Warns the moment our parsing or the kernel field
 * layout drifts (P0-1).
 */
export function selfCheckProcStart(records: { record: CcRecord }[], log: (m: string) => void): void {
  const cc = records.find(r => r.record.kind !== "bridge" && typeof r.record.pid === "number" && isPidAlive(r.record.pid));
  if (!cc?.record.procStart) return;
  const ours = procStart(cc.record.pid);
  if (ours !== undefined && ours !== cc.record.procStart) {
    log(`WARN procStart drift: CC wrote ${cc.record.procStart}, we compute ${ours} for pid ${cc.record.pid} — record identity is untrustworthy`);
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

/**
 * Atomic record write: write a temp file whose name must NOT end in .json (CC
 * reads *.json), then rename over the target. Torn reads become impossible.
 */
export function writeOwnRecord(record: CcRecord, options: CcPathsOptions = {}): string {
  const dir = ccSessionsDir(options);
  const marked = { ...record, bridgeOwner: BRIDGE_OWNER, updatedAt: Date.now() };
  const tmp = join(dir, `.${record.pid}.${process.pid}.tmp`);
  const file = `${dir}/${record.pid}.json`;
  writeFileSync(tmp, JSON.stringify(marked), { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

/** Remove records we own (bridgeOwner) whose pid is dead — crashed previous runs. */
export function gcOwnStaleRecords(ownPid: number = process.pid, options: CcPathsOptions = {}): void {
  for (const { record, file } of listRecordsSync(options)) {
    if (record.bridgeOwner !== BRIDGE_OWNER) continue;
    if (record.pid === ownPid) continue;
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

export function statDirMode(path: string): number | undefined {
  try {
    return lstatSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
}

export function dirOf(file: string): string {
  return dirname(file);
}
