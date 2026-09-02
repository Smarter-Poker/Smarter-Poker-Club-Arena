# 2026-08-29 — Round 13: a human is never left waiting

Dan, live: "I STILL CAN'T EVEN SIT DOWN AND PLAY, IT NEVER WORKS ... AND THE
SPIN ANIMATION NEVER PLAYS." This round reproduced it from production data,
found the root cause, and shipped the fix.

## What actually happened to Dan, from the ledgers

At 18:06:38Z his buy-in WORKED: 1.00 debited, seat taken on 1 Chip Spin
PLO6 (a held-empty board - his to start). He then sat alone for 24 seconds
while nothing joined, gave up, and his seat was released with a full refund
at 18:07:02. At 18:13:22 - six minutes after he left - three horses filled
that exact game in under a second and played it without him. His seat
purchases across the week show the same split: 6.5s to start when he takes
the LAST seat of a horse-opened game; 100s, 232s, 408s, and once 5.2 HOURS
when he takes the FIRST seat of an empty one.

## Root cause

Zero spins started platform-wide from 17:59 to 18:12 - his attempt sat
inside a dead window. There were 29 such windows in 12 hours (3 to 13.6
minutes each, ~2.5 hours of dead spin pipeline), and they line up with the
day's TWENTY auto-deploys of the Hetzner engine - agents merged server code
roughly every 20 minutes, and every deploy restarts the engine (drain +
boot). During each window no fill loop runs, so a human who sits waits in
silence; the only steady-state fill for a human-seated partial game lived in
discoverTournaments' past-start branch, which is also the loop that takes
longest to matter again after a boot.

Ruled out on the way, each with production evidence: the seat RPC (works,
verified again live), the refund path (clean), the counter sync (counts
seats, correct), the held-empty gate (correctly bypassed at liveCount 1),
horse pool starvation (584 fleet, 295 idle, 0 at capacity), and
min_players/start_time gating (all open).

The wheel "never playing" is downstream: the wheel plays at game START, and
his games never started while he was seated. The reveal machinery itself
(broadcast + row fallback + replay guards) was re-verified sound.

## The fix

1. **Engine - the fast lane owns the human case.** discoverSeatFirstStarts
   (5s cadence, the lightest loop, alive from the first seconds of boot)
   now hands every partially-paid seat-first game to
   `fillHumanSeatFirstGame`: if a HUMAN holds a seat, the remaining seats
   are topped up immediately (Dan's 2026-08-26 rule, "the moment one does,
   topUpWithHorses fills the remaining seats"). Horse-only partials are
   untouched - the horse-opened board's 60-180s human window and the
   held-empty rotation both survive. Per-game 12s throttle; every read
   error-bound; a fill that comes back short raises
   `seat_first_human_waiting` (throttled) so a waiting human is never
   silent again.

2. **Client - the wait is named.** The footer used to read "Waiting For 2
   More Players" identically at second 1 and second 40, so a stalled room
   was indistinguishable from a normal one and leaving was the rational
   move. After 30 STALLED seconds (the timer re-arms on roster movement) it
   now reads "Still Filling Your Game, Your Seat And Chips Are Safe" and
   fires `seat_first_wait_exceeded` once per seat session.

## What this does and does not solve

With the engine healthy, a human's game now fills in ~5-17s worst case
(lane cadence + throttle) instead of whenever the big loop got there. After
a restart, the fast lane recovers humans within seconds of boot rather than
minutes. What NO in-process code can fix is the restart windows themselves:
**twenty engine deploys a day is ~2.5 hours of daily spin downtime**, and
that is a process decision - batching server-code merges into deploy
windows (for example, at most one engine deploy per 30/60 minutes via the
autopilot) would remove most of the dead time. Flagged for Dan; not changed
unilaterally since it lives in estate-level workflow config.

## Verification

- tsc 0 errors client and server; engineStartBudget placement guard green
- 10 new pins in tests/unit/humanIsNeverLeftWaiting.test.ts
- Full suites green (see PR checks)
