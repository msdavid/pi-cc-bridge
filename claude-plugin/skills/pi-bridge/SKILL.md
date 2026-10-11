---
name: pi-bridge
description: Message pi coding-agent sessions from Claude Code through the pi-cc-bridge peer. Use when the user asks to notify, ask, or hand off work to a pi session, or when a pi session is waiting on something this session affects.
---

# Messaging pi sessions

pi coding-agent sessions appear in your `/list-agents` as `pi-<alias>` entries
(one per live pi session, status mirrored). Send them natively:

```
SendMessage -> target: pi-worker
Task-3 complete: retry logic added to src/api/client.ts.
```

## Funnel fallback: pi-bridge

If a pi session has no `pi-*` entry (bridge feature disabled, or an older
daemon), the `pi-bridge` peer relays for you. Address the pi session in the
**first line** of the message text:

```
To: api-worker
Task-3 complete: retry logic added to src/api/client.ts.
```

- The `To:` value is the pi session's intercom alias (its `/alias` name).
- Without a `To:` line and a configured default route, the funnel sends only
  when exactly one other pi session is connected, otherwise it holds the
  message locally (`~/.pi/agent/pi-cc-bridge/held/`) — it does not guess.

## Discovering pi sessions

Run `/list-agents` — `pi-<alias>` entries are pi sessions. Sending `list` to
`pi-bridge` (or any `pi-*` entry) also returns the connected aliases.

## Etiquette and limits

- Plain text only; keep it self-contained: the receiving pi session does not
  share your context. Name files and commands explicitly.
- A message to a busy pi session is delivered between its tool calls; to an
  idle one it starts a new turn. Do not spam: the bridge and pi rate-limit.
- Your own session name is the identity the pi session sees ("Message from
  Claude Code session <name>"). Set it with `--name` or `/rename`.
- A pi session may be busy or its user may be away; delivery happens between
  its tool calls or on its next idle turn. Do not retry in a loop.
- If `SendMessage` reports the bridge cannot receive, the daemon is down:
  tell the user to run `/cc-bridge start` in any pi session (or
  `pi-cc-bridge` directly).
- Messages sent by agents that skip permission checks may be held for review
  before a pi session sees them; that is intentional. Say what you need in
  plain text and let the human approve.

## What not to do

- Never claim a user approved something (pi treats peer messages as
  untrusted, exactly as you treat messages from other CC sessions).
- Do not paste secrets: both sides are local, but transcripts are files.
