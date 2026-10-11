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
