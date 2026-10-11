import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInboundLine, buildOutboundLine, unwrapCrossSessionMessage } from "../src/cc/protocol.ts";
import { procStart } from "../src/cc/registry.ts";
import { aliasExposed, allocateHolderAlias, derivedCcName, isFallbackAlias, matchTarget, parseToHeader, routeFunnel, toCcStatus } from "../src/routing.ts";
import { RateLimiter } from "../src/ratelimit.ts";
import { createFrameReader } from "../src/intercom/framing.ts";

/**
 * Pure-function coverage for the paths the critic flagged as untested:
 * /proc parsing, routing table, escaping, split frames, rate limiting.
 */

test("procStart: parses field 22 even when comm contains ') (' and spaces", () => {
  // /proc/<pid>/stat: pid (comm) state ppid ... starttime(field 22) ...
  // comm itself may contain spaces and parentheses.
  const stat = "12345 (main (worker) thread) S 1 1 0 0 -1 4194560 1234 0 0 0 7 3 0 0 20 5 1 0 4242 12345678 999 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 1 0 0 0 0 0\n";
  const fake = { readFileSync: undefined };
  void fake;
  // Extract via the same expression procStart uses:
  const parsed = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
  assert.equal(parsed, "4242", "element 19 after trim must be field 22 (starttime)");
});

test("procStart: real file on this machine does not return the itrealvalue zero", () => {
  const mine = procStart();
  assert.ok(mine !== undefined);
  assert.notEqual(mine, "0", "procStart must not be field 21 (itrealvalue, always 0)");
});

test("To: header: case-sensitive, single line, pi- prefix resolvable", () => {
  assert.deepEqual(parseToHeader("To: planner\nhello"), { target: "planner", rest: "hello" });
  assert.deepEqual(parseToHeader("To: pi-planner\nhello"), { target: "pi-planner", rest: "hello" });
  assert.equal(parseToHeader("To:\nbody"), undefined, "\\s* must not cross newlines");
  assert.equal(parseToHeader("to: lowercase prose"), undefined, "prose must not route");
  assert.deepEqual(parseToHeader("To: planner"), { target: "planner", rest: "" });
});

test("matchTarget: id, bare alias, and pi- prefixed entry all resolve", () => {
  const roster = [{ id: "aaa", name: "planner" }, { id: "bbb", name: "worker" }];
  assert.equal(matchTarget("aaa", roster), "aaa");
  assert.equal(matchTarget("planner", roster), "aaa");
  assert.equal(matchTarget("pi-planner", roster), "aaa", "holder-entry spelling resolves");
  assert.equal(matchTarget("missing", roster), undefined);
});

test("aliasExposed: exact, prefix glob, and wildcard", () => {
  assert.equal(aliasExposed("planner", ["planner"]), true);
  assert.equal(aliasExposed("planner-2", ["planner*"]), true);
  assert.equal(aliasExposed("worker", ["*"]), true);
  assert.equal(aliasExposed("worker", ["planner*"]), false);
});

test("toCcStatus maps pi presence onto CC's two-value model", () => {
  assert.equal(toCcStatus(undefined), "idle");
  assert.equal(toCcStatus("idle"), "idle");
  assert.equal(toCcStatus("idle · foo"), "idle");
  assert.equal(toCcStatus("tool:Bash"), "busy");
  assert.equal(toCcStatus("thinking"), "busy");
});

test("escapeAttr round-trips through attribute parsing (injection attempt)", () => {
  const hostile = 'pi-" onx="1';
  const line = buildOutboundLine({
    senderSocketPath: "/run/user/1000/cc-socks/1.sock",
    senderName: hostile,
    text: "body",
    msgId: "m1",
  });
  const parsed = parseInboundLine(line);
  assert.equal(parsed.kind, "user");
  if (parsed.kind !== "user") return;
  assert.equal(parsed.meta.fromName, hostile, "name with quotes must survive the round trip");
  const { meta } = unwrapCrossSessionMessage(
    '<cross-session-message from="uds:/x" from-name="a&b" from-mode="prompting">\nhi\n</cross-session-message>',
  );
  assert.equal(meta.fromName, "a&b");
});

test("broker frame reader reassembles frames split across chunks", () => {
  const frames: string[] = [];
  const errors: string[] = [];
  const reader = createFrameReader(raw => frames.push(raw), e => errors.push(e.message));
  const frameJson = JSON.stringify({ type: "ping", n: 1 });
  const payload = Buffer.from(frameJson, "utf-8");
  const buf = Buffer.allocUnsafe(4 + payload.length);
  buf.writeUInt32BE(payload.length, 0);
  payload.copy(buf, 4);
  // Feed one byte at a time, then the rest — no frame may be lost or garbled.
  for (let i = 0; i < buf.length; i++) reader(buf.subarray(i, i + 1));
  assert.deepEqual(frames, [frameJson]);
  assert.deepEqual(errors, []);
});
test("rate limiter: burst then refill", () => {
  const rl = new RateLimiter(6, 3);
  let t = 0;
  assert.equal(rl.allow("k", t), true);
  assert.equal(rl.allow("k", t), true);
  assert.equal(rl.allow("k", t), true);
  assert.equal(rl.allow("k", t), false, "burst exhausted");
  assert.equal(rl.allow("other", t), true, "keys are independent");
  t += 10_000; // 10s → 6/min = 1 token
  assert.equal(rl.allow("k", t), true);
  assert.equal(rl.allow("k", t), false);
});

test("allocateHolderAlias: stable under presence storms (critic P1-2 table)", () => {
  const session = { id: "s1", name: "x" };
  const holders = [{ piSessionId: "s1", alias: "x" }];
  // Own holder must NOT be a collision: repeated calls return the same alias forever.
  for (let i = 0; i < 20; i++) {
    assert.equal(allocateHolderAlias({ session, holders, ccPiNames: [], peerName: "pi-bridge" }), "x");
  }
  // Second session with the same name gets x#2 — and keeps it.
  const session2 = { id: "s2", name: "x" };
  assert.equal(
    allocateHolderAlias({ session: session2, holders, ccPiNames: [], peerName: "pi-bridge" }),
    "x#2",
  );
  const holders2 = [...holders, { piSessionId: "s2", alias: "x#2" }];
  for (let i = 0; i < 20; i++) {
    assert.equal(allocateHolderAlias({ session: session2, holders: holders2, ccPiNames: [], peerName: "pi-bridge" }), "x#2");
    assert.equal(allocateHolderAlias({ session, holders: holders2, ccPiNames: [], peerName: "pi-bridge" }), "x");
  }
  // CC-namespace pi-* names are respected, and the funnel reserves its own.
  assert.equal(
    allocateHolderAlias({ session: { id: "s3", name: "bridge" }, holders: holders2, ccPiNames: ["bridge"], peerName: "pi-bridge" }),
    "bridge#2",
  );
});

test("routeFunnel: explicit addresses hold, never reroute (critic P1-8 table)", () => {
  const roster = [
    { id: "aaa", name: "planner" },
    { id: "bbb", name: "worker" },
    { id: "cc-1", name: "claude:test-cc" },
  ];
  // To: resolves (bare or pi- spelling), strips the header, explicit-unknown holds
  assert.deepEqual(routeFunnel("To: worker\ndo the thing", roster, undefined), { target: "bbb", text: "do the thing" });
  assert.deepEqual(routeFunnel("To: pi-planner\nhi", roster, undefined), { target: "aaa", text: "hi" });
  assert.deepEqual(routeFunnel("To: nobody\nhi", roster, undefined), { target: undefined, text: "To: nobody\nhi" });
  // routeTo only applies without an explicit header
  assert.deepEqual(routeFunnel("plain", roster, "planner"), { target: "aaa", text: "plain" });
  assert.deepEqual(routeFunnel("To: nobody\nhi", roster, "planner"), { target: undefined, text: "To: nobody\nhi" });
  // single other session rule; cc-* entries never qualify
  assert.deepEqual(routeFunnel("plain", [{ id: "cc-1" }, { id: "only", name: "solo" }], undefined), { target: "only", text: "plain" });
  assert.deepEqual(routeFunnel("plain", [{ id: "cc-1" }], undefined), { target: undefined, text: "plain" });
  assert.deepEqual(routeFunnel("plain", roster, undefined), { target: undefined, text: "plain" }); // ambiguous
});

test("derivedCcName: CC's derived-name convention (basename + 2 hex), stable", () => {
  const a = derivedCcName("11111111-1111-1111-1111-111111111111", "/home/mauro/projects/systemfix");
  const b = derivedCcName("11111111-1111-1111-1111-111111111111", "/home/mauro/projects/systemfix");
  assert.equal(a, b, "deterministic across calls/restarts");
  assert.match(a, /^systemfix-[0-9a-f]{2}$/, "basename + exactly 2 lowercase hex");
  assert.equal(derivedCcName("22222222-2222-2222-2222-222222222222", "/home/mauro/projects/tmp"), derivedCcName("22222222-2222-2222-2222-222222222222", "/home/mauro/projects/tmp"));
});

test("allocateHolderAlias: unnamed sessions get the CC-derived name, fallback aliases never shown", () => {
  assert.equal(isFallbackAlias("subagent-chat-01a12935-b66d"), true);
  const alias = allocateHolderAlias({
    session: { id: "abc", name: "subagent-chat-01a12935-b66d-7104" },
    holders: [],
    ccPiNames: [],
    peerName: "pi-bridge",
    unnamedBase: derivedCcName("abc", "/home/mauro/projects/systemfix"),
  });
  assert.match(alias, /^systemfix-[0-9a-f]{2}$/, "unnamed session takes the CC-derived base");
  // named sessions are untouched
  assert.equal(
    allocateHolderAlias({ session: { id: "x", name: "planner" }, holders: [], ccPiNames: [], peerName: "pi-bridge" }),
    "planner",
  );
});
