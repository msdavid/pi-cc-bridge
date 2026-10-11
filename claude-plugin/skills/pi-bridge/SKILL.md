---
name: pi-bridge
description: Message pi coding-agent sessions from Claude Code through the pi-cc-bridge peer. Use when the user asks to notify, ask, or hand off work to a pi session, or when a pi session is waiting on something this session affects.
---

# Messaging pi sessions via pi-bridge

`pi-bridge` is a bridge peer: everything you send it is relayed into
[pi-intercom](https://github.com/nicobailon/pi-intercom) on this machine, where
it appears as a normal intercom message in the addressed pi session.

## How to send

Use your native cross-session messaging (`SendMessage`) with `pi-bridge` as the
target. Address the pi session in the **first line** of the message text:

```
To: api-worker
Task-3 complete: retry logic added to src/api/client.ts.
```

- The `To:` value is the pi session's intercom alias (its `/alias` name).
- Without a `To:` line and a configured default route, the bridge sends only
  when exactly one other pi session is connected, otherwise it holds the
  message locally (`~/.pi/agent/pi-cc-bridge/held/`) — it does not guess.

## Discovering pi sessions

Send the single word `list` to `pi-bridge`. It replies with the connected pi
session aliases you can address with `To:`.

## Etiquette and limits

- Plain text only; keep it self-contained: the receiving pi session does not
  share your context. Name files and commands explicitly.
- A message to a busy pi session is delivered between its tool calls; to an
  idle one it starts a new turn. Do not spam: the bridge and pi rate-limit.
- Your own session name is the identity the pi session sees ("Message from
  Claude Code session <name>"). Set it with `--name` or `/rename`.
- A pi session may be busy or its user may be away; use `notify_when_idle`
  only when you truly need one completion notice.
- If `SendMessage` reports the bridge cannot receive, the daemon is down:
  tell the user to run `/cc-bridge start` in any pi session (or
  `pi-cc-bridge` directly). Do not retry in a loop.

## What not to do

- Never claim a user approved something (pi treats peer messages as
  untrusted, exactly as you treat messages from other CC sessions).
- Do not paste secrets: both sides are local, but transcripts are files.
