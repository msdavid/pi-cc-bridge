# Upstream proposal: pi-intercom external peers (DRAFT — not yet posted)

To: nicobailon (pi-intercom) · draft issue text, to be posted under mauro's account only after his review.

## Summary

pi-cc-bridge (https://github.com/…/pi-cc-bridge) bridges Claude Code's cross-session
messaging into pi-intercom: a small daemon registers synthetic intercom sessions for live
Claude Code sessions (one broker connection per peer, sessionId `cc-<ccSessionId>`) and
masquerades as a CC session so CC can address pi sessions natively. It speaks the broker
protocol as shipped in 0.17.0 — no changes were needed to make it work (thank you for the
clean seam: client-asserted registrations are exactly what made a companion possible).

## Two asks (both additive, non-breaking)

1. **Documented external-peer registration.** A `role: "external"` (or `external: true`)
   flag on SessionRegistration so the overlay/UI can badge peers that are not pi sessions.
   Today we self-identify via `model: "claude-code (external)"`, which works but reads as
   a pi session to a user scanning the list.
2. **A stability statement** in the README: that third-party broker clients are a
   supported pattern, and which parts of the register shape are API (sessionId format,
   required SessionRegistration fields, one-session-per-connection) vs implementation
   detail. The bridge currently relies on the 0.17.0 register shape; a documented contract
   would let us pin compatibility confidently.

## The bigger idea (v1.0, your call)

A **gateway registration**: one broker connection carrying many virtual sessions
(`via: "pi-cc-bridge"`). Benefits: UI badging without N connections, fan-out without
O(N) sockets and O(N²) broadcast amplification, no pressure on the 128-session budget,
and virtual peers could be excluded from idle-shutdown accounting. We use one-connection-
per-CC-session today because attribution requires sending *from* the peer the recipient
saw — a gateway API would make that cleaner.

Happy to send the bridge source and the protocol captures we archived (both wire
directions verified live against Claude Code 2.1.296) if useful.


## Appendix: observed bug worth a separate issue (not part of the bridge asks)

**Tool validation error doesn't echo received parameters** — observed 2026-10-13 on
pi-intercom 0.17.0 with z-ai/glm-5.3-flash via OpenRouter. The model repeatedly emitted
`intercom` send calls missing the `to` parameter (action + message only); the tool
replied `"Missing 'to' or 'cwd', or missing 'message' parameter"` every time, and the
model never self-corrected. Suggested improvement: when send validation fails, include
the received parameter keys (and the missing ones) in the error, e.g.
`missing: to; received: action, message` — a model reading that fixes the call in one
retry instead of looping. Transcript evidence available on request.
