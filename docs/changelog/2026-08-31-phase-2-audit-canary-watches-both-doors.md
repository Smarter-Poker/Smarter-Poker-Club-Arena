# Phase 2 audit — the canary was watching one door of two

2026-08-31, immediately after #2122 merged. Auditing my own phase 2 before
starting phase 3.

## The gap

A player can be force-sat-out from TWO places in `DisconnectEngine`:

1. `recordConnectedTimeout()` — the CONNECTED AFK ladder, which is where the
   seat-7 player was condemned; and
2. `executeAutoAction(reason: 'timeout')` — the DISCONNECT countdown.

I wired the canary into the first and stopped. That is how a diagnostic ends
up quietly covering half of what it claims to: it would have reported nothing
at all through the second path, while its name and its changelog both promised
to watch every forced sit-out.

Most traffic through door two is a genuinely disconnected player, and the
canary declines to accuse anybody there — it checks `isConnected` itself. The
case that makes it worth wiring is narrower and real: a countdown armed while
the socket was down, firing against a player who has since RECONNECTED and is
sitting right there.

Calling it there can only add evidence, never a false accusation, because the
function decides suspicion for itself.

## The pin

`SilentClientCanary.test.ts` now reads the engine source, splits on every
`sitOut(tableId, playerId, 'forced')` and asserts the canary call immediately
precedes each one. A third sentencing path added later without a canary in
front of it turns this red.

Verified real: removing the second-door call fails the new case and passes
again when restored.

## Verification

- Server: **271 files / 3,081 tests, 0 failures**. `tsc --noEmit` clean.
- Diff is purely additive: +14 engine, +19 test, nothing removed.
