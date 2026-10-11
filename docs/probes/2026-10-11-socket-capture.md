# Live captures, 2026-10-11 (CC 2.1.296, Linux, /run/user/1000/cc-socks)

## Direction: external process → CC session inbox (probe 1)

Posted by a plain Python process (not a CC child, no auth token):

{"type":"user","message":{"role":"user","content":"Say PONG if you received this from an external bridge."},"from":"bridge-probe","msg_id":"ccprobe-external-1","priority":"next"}

Result: delivered; CC turn started; assistant replied "PONG" (stream-json output).
No response is written back on the socket (recv timed out after delivery).

## Direction: CC session → masqueraded bridge inbox (probe 2)

Sent by a real CC session ("systemfix-3c") via SendMessage after discovering the
bridge peer "pi-bridge" through a foreign-written registry record:

{"msgV":1,"msg_id":"d2f9384c-b448-4c76-8fb1-24afb084de2f","type":"user","message":{"role":"user","content":"<cross-session-message from=\"uds:/run/user/1000/cc-socks/1920100.sock\" from-name=\"systemfix-3c\" from-mode=\"prompting\">\nBRIDGE-HELLO-42\n</cross-session-message>"},"priority":"next","from":"/run/user/1000/cc-socks/1920100.sock"}

No auth line was sent. No ack was expected; the tool result reported success on write.

## Registry record written by the bridge (accepted by CC discovery)

~/.claude/sessions/<pid>.json with: pid, sessionId (fresh uuid), cwd, startedAt,
procStart (real /proc starttime), version "2.1.296", peerProtocol 1,
peerFeatures ["notify_idle","reply_across_default_dirs","artifact_yield"],
kind "interactive", entrypoint "cli", pidDomain, messagingSocketPath,
name "pi-bridge", nameSource "user", status "idle".

CC's SendMessage preflight verified the socket's peer pid against the record
(expectPeerPid/expectPeerProcStart) — the bridge binds from its own pid.
