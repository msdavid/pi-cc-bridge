/**
 * Pure routing helpers, extracted so the funnel/holder addressing rules are
 * table-testable (P1-8, P1-16).
 */

export interface RosterEntryLike {
  id: string;
  name?: string;
}

/**
 * Parse a leading `To: <target>` header. Case-SENSITIVE (prose starting "to:"
 * must not route), single line only, and the target may be a bare alias or a
 * `pi-<alias>` entry name. Returns undefined when absent.
 */
export function parseToHeader(text: string): { target: string; rest: string } | undefined {
  const m = text.match(/^To:[ \t]*(\S+)[ \t]*(?:\r?\n|$)/);
  if (!m) return undefined;
  return { target: m[1], rest: text.slice(m[0].length) };
}

/**
 * Resolve an address against the roster. Accepts: broker session id, intercom
 * alias (session.name), and `pi-<alias>` (holder entry spelling). Case-
 * insensitive. Returns the session id.
 */
export function matchTarget(wanted: string, roster: Iterable<RosterEntryLike>): string | undefined {
  const lower = wanted.toLowerCase();
  const bare = lower.startsWith("pi-") ? lower.slice(3) : lower;
  for (const session of roster) {
    const name = session.name?.toLowerCase();
    if (session.id.toLowerCase() === lower || name === lower || name === bare) return session.id;
  }
  return undefined;
}

/** Glob-ish alias matching for `expose` config entries ("*" and prefix*). */
export function aliasExposed(alias: string, patterns: string[]): boolean {
  return patterns.some(p => (p === "*" ? true : p.endsWith("*") ? alias.startsWith(p.slice(0, -1)) : p === alias));
}

/** Map a raw pi presence status onto CC's two-value record status. (P1-5) */
export function toCcStatus(status: string | undefined): "idle" | "busy" {
  if (!status || status === "idle" || status.startsWith("idle")) return "idle";
  return "busy";
}

/**
 * Stable holder-alias allocation (P1-2): a session keeps its alias across
 * presence storms, the session's own holder never counts as a collision, and
 * CC-namespace `pi-*` names are respected. Suffixes start at #2.
 */
export function allocateHolderAlias(params: {
  session: { id: string; name?: string };
  holders: { piSessionId: string; alias: string }[];
  ccPiNames: string[]; // bare aliases claimed by CC-namespace `pi-*` records
  peerName: string; // funnel name, e.g. "pi-bridge"
}): string {
  const base = (params.session.name?.trim() || `sid-${params.session.id.slice(0, 8)}`).replace(/[^\w.-]/g, "-");
  const taken = new Set<string>([
    ...params.holders.filter(h => h.piSessionId !== params.session.id).map(h => h.alias),
    ...params.ccPiNames,
    params.peerName.replace(/^pi-/, ""),
  ]);
  const current = params.holders.find(h => h.piSessionId === params.session.id)?.alias;
  if (current && (current === base || current.startsWith(`${base}#`)) && !taken.has(current)) return current;
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}#${n}`)) n++;
  return `${base}#${n}`;
}

/**
 * Funnel routing (P1-8): explicit `To:` header (case-sensitive, single line)
 * resolves or HOLDS — an explicit address never reroutes. Then `routeTo`, then
 * a single other non-CC session. ccPrefix = the synthetic-peer id prefix.
 */
export function routeFunnel(
  text: string,
  roster: Iterable<RosterEntryLike>,
  routeTo: string | undefined,
  ccPrefix = "cc-",
): { target?: string; text: string } {
  const sessions = [...roster];
  const parsed = parseToHeader(text);
  if (parsed) {
    const hit = matchTarget(parsed.target, sessions);
    if (!hit) return { target: undefined, text };
    return { target: hit, text: parsed.rest };
  }
  if (routeTo) {
    const hit = matchTarget(routeTo, sessions);
    if (hit) return { target: hit, text };
  }
  const others = sessions.filter(s => !s.id.startsWith(ccPrefix));
  return { target: others.length === 1 ? others[0].id : undefined, text };
}
