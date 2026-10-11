# pi-cc-bridge — Design

Bridge **pi-intercom** (pi sessions) and **Claude Code cross-session messaging** (CC sessions)
so both sides appear as native peers to each other.

- pi direction: a companion daemon registers synthetic pi-intercom peer sessions, one per live
  Claude Code session. pi sessions message `claude:<name>` through pi-intercom as usual.
- CC direction: the same daemon masquerades as a Claude Code session (registry record + inbox
  socket), so CC sessions see `pi-bridge` in `/list-agents` and `SendMessage` to it natively.

Both transports were verified live on Claude Code 2.1.296 / pi-intercom 0.17.0
(probes archived in `docs/probes/`, fixtures used by `test/`).

## Architecture

```
pi sessions ⇄ pi-intercom broker ⇄ [pi-cc-bridge daemon] ⇄ CC inbox sockets
                      (one broker connection         ⇄ CC sessions registry (~/.claude/sessions)
                       per synthetic peer)
```

The daemon is a standalone process (spawned and supervised by the pi extension, like
pi-intercom's broker). It owns:

1. **Discovery loop** — polls the CC sessions registry, creates/updates/retires one broker
   connection + synthetic intercom session per live CC session.
2. **CC-facing endpoint** — binds one inbox socket + writes one registry record, named
   `peerName` (default `pi-bridge`), that CC sessions can address.
3. **Relay** — moves text between the two transports with the envelopes below.

## Claude Code protocol (captured from 2.1.296)

### Peer discovery

Each live CC session writes `~/.claude/sessions/<pid>.json` (also honors `CLAUDE_CONFIG_DIR`),
plus a `~/.claude/sessions/<pid>.<sha256(socketPath)>.key` auth file:

```json
{
  "pid": 4009,
  "sessionId": "41f88b21-ee42-406e-bacd-f0efedc4a15b",
  "cwd": "/home/mauro/projects/lynx-2.0",
  "startedAt": 1791666925609,
  "procStart": "2003",
  "version": "2.1.296",
  "peerProtocol": 1,
  "peerFeatures": ["notify_idle", "reply_across_default_dirs", "artifact_yield"],
  "kind": "interactive",
  "entrypoint": "cli",
  "pidDomain": "linux:<machine-hash>:pid:[<pid-ns-inode>]",
  "messagingSocketPath": "/run/user/1000/cc-socks/4009.sock",
  "name": "wave-1",
  "nameSource": "user",
  "nameSince": 1791666925754,
  "updatedAt": 1791693631983,
  "status": "busy",
  "statusUpdatedAt": 1791693631983
}
```

Socket path: `$XDG_RUNTIME_DIR/cc-socks/<pid>.sock` (fallback `/tmp/cc-socks-<uid>/<pid>.sock`;
`/run/user/<uid>/cc-socks/` is on CC's default-dirs allowlist, alongside `/tmp/cc-socks*`).

Listing = read the registry + liveness-check records. When CC sends to a peer it preflights
the socket's peer pid against the record (`expectPeerPid`, `expectPeerProcStart`,
`noFollowSymlink`) — so a masquerading bridge binds its own socket from its own pid and writes
its own record, self-consistent by construction.

### Inbound line (what a CC session's inbox accepts)

Newline-delimited JSON on the socket. First line may be an auth line
`{"type":"auth","token":"…"}` — optional on Linux (socket perms gate it), required on Windows.
Silent connections are dropped after 30 s. Then user lines:

```json
{
  "msgV": 1,
  "msg_id": "<unique id>",
  "type": "user",
  "message": {"role": "user", "content": "<cross-session-message from=\"uds:<sender-socket>\" from-name=\"<sender-name>\" from-mode=\"prompting\">\n<text>\n</cross-session-message>"},
  "priority": "next",
  "from": "<sender-socket-path>"
}
```

Observed sender behavior (mirror probe):

- `from` = the sender's own socket path; sender name/mode ride inside the
  `<cross-session-message …>` wrapper (`from-mode` is the permission-class self-ID:
  `prompting` vs bypass). `msgV: 1`.
- Optional `session_id` field must equal the receiving session's own id when present.
- No auth line is sent on Linux; no ack is written back; fire-and-forget.
- Other frames: `{"action":"notify_when_idle","from":…,"msg_id":…,"from_mode":…}`,
  `peer_idle_notice`, `type:"control"` (SDK control protocol), artifact-yield actions.

Malformed lines are dropped with logged reasons ("without valid type field",
"session_id mismatch (got …, expected …)").

### Deliver

Message is delivered **between tool calls** of an active turn, or starts a new turn if idle.
Plain text only; `@` file mentions carry nothing; commands arrive as inert text.

### Inbound controls (trust)

`crossSessionInbound`: `accept` / `hold` / `refuse`; per-message default from the two sessions'
permission-mode classes (bypass ↔ bypass delivers; anything else holds bypass senders,
delivering senders with prompting class to prompting receivers). Held messages surface an
approval dialog (`dialogExpiry`, 5 min default, 100 held max). Size cap ≈1 M chars; bursts and
loops are rate-limited (drop identical repeats, queue ≤ 50).

Recommendation for CC worker sessions that should accept pi traffic unattended:
`claude -p … --settings '{"crossSessionInbound":"accept"}'` or set it in the CC session.

## pi-intercom protocol (broker 0.17.0)

- Endpoint: `~/.pi/agent/intercom/broker.sock` (Unix), `broker.port.json` (Windows TCP).
- Frames: 4-byte big-endian length + JSON payload (see pi-intercom `broker/framing.ts`).
- Client flow: `{type:"register", sessionId, session}` → `{type:"registered", sessionId,
  features}`; `{type:"list", requestId}` → `{type:"sessions",…}`; `{type:"send", to, message}`;
  inbound `{type:"message", from, message}`; receipts
  `{type:"message_receipt", receipt:{messageId,status:"receiver_received"}}`;
  heartbeat = any frame ≥ `livenessIntervalMs` (send `{type:"presence"}`).
- `sessionId`: any non-empty string (`cc-<ccSessionId>` for synthetic peers; stable across
  daemon restarts; a dead previous holder is evicted automatically).
- `SessionRegistration` requires `cwd`, `model`, `pid`, `startedAt`, `lastActivity`
  (strings/numbers), optional `name`, `status`, `acknowledgesReceipts`, `livenessIntervalMs`.
- One registered session per connection (`currentKey`), so the daemon opens one broker
  connection per CC peer — that is what makes inbound `from` correct.

## Identity mapping

| CC concept | Bridge representation |
|---|---|
| CC session record `<pid>.json` | Synthetic intercom session `cc-<sessionId>`, name `claude:<name>` (fallback `claude-pid-<pid>`; `#<pid>` suffix on name collisions) |
| CC `status` | intercom presence `status` (idle/busy) |
| CC→pi message | relayed by the *sender peer's* connection, so pi sees `from = claude:<name>` |
| pi→CC message | `from-name = peerName` (`pi-bridge`), `from-mode = prompting` |
| pi→CC text | wrapped in `<cross-session-message>` exactly like a native CC sender |
| CC→pi text | wrapper stripped, replaced with a `Message from Claude Code session <name>` prefix |

### CC → pi routing — native entries (default)

With `nativeEntries: true` the daemon spawns one **holder child** per live pi session.
Each child binds its own CC inbox socket and writes its own registry record named
`pi-<alias>`, so `/list-agents` shows every pi session natively and CC `SendMessage`s it
directly — no `To:` header needed. Holder records carry `kind: "bridge"` and mirror the
pi session's status (busy/idle) and alias renames, pushed from the daemon over private
IPC (`~/.pi/agent/pi-cc-bridge/holders-ipc.sock`).

Children are deliberately dumb socket-holders with **no broker connection**: they forward
frames to the daemon, which relays via the *sending CC session's own* synthetic peer
connection — attribution stays `Message from Claude Code session <name>` and no extra
intercom sessions are created. A watchdog makes children self-clean (registry record +
socket) if the daemon dies. Prebuilt bundle `dist/holder.mjs` (plain node, ~53 MB RSS)
is preferred over the tsx fallback (~82 MB); `npm run build` regenerates it,
`prepublishOnly` enforces it.

Routing inside a holder entry: a `To: <alias>` header is honored for cross-routing;
otherwise the message belongs to that pi session. `list` replies with the roster.
Unroutable funnel messages are held in `~/.pi/agent/pi-cc-bridge/held/` — never guessed.

### Funnel fallback (kept for compatibility)

The masquerade record `peerName` (default `pi-bridge`) remains: `SendMessage` to it with a
leading `To: <alias>` line, or `routeTo` in config, or — when exactly one other pi session
is connected — that session.

## Runtime layout

```
~/.pi/agent/pi-cc-bridge/
├── config.json        # { enabled, peerName, pollMs, routeTo, logLevel, ccSessionsDir? }
├── daemon.pid
├── daemon.log
└── held/              # unroutable CC messages
```

Signal handling: SIGTERM/SIGINT → remove own CC registry record + socket, unregister broker
sessions, exit. Startup GC: remove a leftover record whose `messagingSocketPath` is our own
path and whose pid is dead (our previous incarnation only — never other sessions' records).

## Claude Code side (plugin)

`claude-plugin/` is a standard CC plugin (manifest `.claude-plugin/plugin.json`, skill
`skills/pi-bridge/SKILL.md`). It carries no protocol code — CC's native cross-session
messaging already speaks to the bridge — only awareness:

- how to discover pi sessions (`/list-agents`, `@pi-bridge` mention),
- the `To: <alias>` routing convention and reply etiquette,
- notes on held-message semantics and `crossSessionInbound`.

Install: `/plugin marketplace add <path-or-repo>` then install `pi-cc-bridge`; or load in
place with `claude --plugin-dir <path>/claude-plugin`. `claude plugin validate` must pass.

## Version gating

Gate on the registry record's `peerProtocol` (currently `1`) and `peerFeatures`, not on
`version` strings. Records with an unsupported `peerProtocol` are skipped with a warning.
CC releases weekly; the wire shapes here are pinned by fixtures from a live 2.1.296 capture.

## Upstream asks (pi-intercom, nicobailon)

Small, additive PRs rather than a fork:

1. A documented **external-peer registration flag** so the overlay/UI can badge bridge peers
   (e.g. `external: true`) instead of them looking like pi sessions.
2. Optional delivery detail for "handed to external transport".

Both are cosmetic; the current registration format works unmodified today.

## Security notes

- All transports are same-uid local IPC; no network exposure anywhere.
- The bridge never touches CC `.key` auth files (Linux external sends don't need them) and
  never writes other sessions' registry records.
- CC→pi messages start agent turns in pi: `routeTo` + the `To:` header are the deliberate
  trust boundary; unroutable messages are held, not delivered.
- pi→CC messages inherit CC's inbound controls verbatim (a bypass-mode CC session will hold
  `prompting`-class senders for user approval — by design).
