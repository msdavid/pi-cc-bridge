# pi-cc-bridge

Bridge [pi-intercom](https://github.com/nicobailon/pi-intercom) and
[Claude Code cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging):
pi sessions and Claude Code sessions appear as native peers to each other.

```
pi sessions ⇄ pi-intercom broker ⇄ [pi-cc-bridge daemon] ⇄ CC inbox sockets ⇄ CC sessions
```

- **From pi**: every live Claude Code session shows up in `intercom list` as a
  `claude:<name>` peer. Message it with the ordinary intercom tool.
- **From Claude Code**: every live pi session shows up in `/list-agents` as a
  `pi-<alias>` session (status mirrored). `SendMessage` it directly — or use
  the `pi-bridge` funnel with a `To: <pi-alias>` first line (or send `list`
  to discover pi sessions).

Both wire directions were verified live against Claude Code 2.1.296 and
pi-intercom 0.17.0; see `docs/DESIGN.md` for the captured protocol and
`docs/probes/` for the probe transcripts.

## Install (pi package)

```bash
pi install npm:pi-cc-bridge     # once published
# or locally:
pi install git:file:///home/mauro/projects/pi-cc-bridge
```

Then restart pi. The extension starts the daemon (idempotent, one per machine)
and adds `/cc-bridge [status|start|stop]`.

## Install the Claude Code side (optional but recommended)

The plugin only adds awareness (a skill); the messaging protocol needs nothing
from CC. Either load it in place:

```bash
claude --plugin-dir ~/projects/pi-cc-bridge/claude-plugin
```

or copy it into CC's plugin location, or add this repo as a marketplace:

```
/plugin marketplace add ~/projects/pi-cc-bridge/claude-plugin
/plugin install pi-cc-bridge@pi-cc-bridge
```

Validate: `claude plugin validate ~/projects/pi-cc-bridge/claude-plugin`.

## Configuration

`~/.pi/agent/pi-cc-bridge/config.json` (all optional):

```json
{
  "enabled": true,
  "peerName": "pi-bridge",
  "pollMs": 2000,
  "routeTo": "planner",
  "logLevel": "normal"
}
```

- `routeTo`: pi session alias that receives CC messages lacking a `To:` header.
- Messages that resolve to no route are held in `~/.pi/agent/pi-cc-bridge/held/`,
  never guessed.

## Running the daemon manually

```bash
npm install
npm run build        # dist/holder.mjs — plain-node holder children (~53MB vs ~82MB)
npm start            # or: bin/pi-cc-bridge.mjs
```

## Tests

```bash
npm run typecheck
npm test             # protocol fixtures from live captures + broker client integration
```

## Security & trust

Same-uid local IPC only; no network exposure.

- **pi → CC**: pi sessions are declared `bypass`-class (`piSenderMode`), because pi has no
  approval gate by default — so prompting-mode CC sessions hold pi messages for approval,
  exactly as CC would for any bypass sender.
- **CC → pi**: bypass-class CC senders are held (`ccInbound: "hold-bypass"`).
- **Exposure is opt-in**: `expose` (default `[]`) chooses which pi sessions appear in CC's
  `/list-agents` up front; every pi session that messages CC first gets an entry lazily.
- **Rate limits** per direction pair; excess is held.
- Anything unroutable, failed, or rate-limited lands in `~/.pi/agent/pi-cc-bridge/held/` —
  never silently dropped, never guessed.

See `docs/DESIGN.md` for the full model.

## Status

MVP. Known limits: CC session renames while the daemon runs are not re-synced;
cross-machine CC messaging (Remote Control relay) is out of scope; the pi→CC
direction inherits CC's inbound controls verbatim (bypass-mode CC sessions
will hold `prompting`-class messages for user approval — set
`crossSessionInbound: "accept"` on unattended CC workers).
