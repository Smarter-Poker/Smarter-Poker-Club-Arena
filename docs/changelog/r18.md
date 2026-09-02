# Round 18 — the wheel fires on the draw, and a spin that is over now ends

2026-08-30. Dan: _"CHECK FOR ANY AND ALL BUGS, GAPS, STUBS, ERRORS, REGRESSIONS
OR WIRING ISSUES ANYWHERE AND EVERYWHERE. MAKE SURE IT WORKS FASTER... AS SOON
AS THE 3RD SEAT IS 'PAID FOR' THE ANIMATION SHOULD START AS SOON AS POSSIBLE."_

## 1. The wheel now fires on the draw

Measured after round 16 — 229 spins, third paid seat to `started_at`:

| min   | p25   | p50       | p90   |
| ----- | ----- | --------- | ----- |
| 1.57s | 2.72s | **3.02s** | 4.70s |

Round 15 was p50 5.4s, so the one-second lane took ~2.4s out of it. What
remained was the start **work**, and the broadcast sat at the _end_ of it —
behind `fn_spin_settle_game`, the spin row write, a roster read plus a
per-player update per seat, the stack credit, and the table build.

**None of that is a precondition for showing three players a spinning wheel.**
The draw is. Every number the packet carries — multiplier, buy-in, prize pool —
is known the instant the draw resolves; the pool is computed locally from the
first two, on the line above. That work is a precondition for **dealing**, and
dealing is already held for `spinRevealToDealMs` (16.6s), which is far longer
than the work takes.

So the reveal goes out on the draw and the bookkeeping runs underneath it,
inside a hold that was always there. The table ids come free off the
paid-entry roster read — one extra column, no new round trip, because a
seat-first player is already sitting at that table before the game starts.

Two things make it safe, both pinned:

- **Once public, the moment does not move.** `resolveSpinReveal` is frozen by
  `spinRevealEmitted`, so the later pass cannot re-anchor wheels that are
  already turning on those exact numbers.
- **The hold is one-sided.** `Math.max(holdUntil, now + spinPostRevealMs())` —
  extended, never shortened. A client may finish early and wait ("faster than
  the budget is allowed"); it must never be dealt over. This replaces the
  re-anchor as the protection against a pathologically slow start.

## 2. A spin that is over must end — 1,378 chips were stranded

Found by sweeping production, not by reading code. **Every** RUNNING spin older
than five minutes was stuck — nine of nine:

- live stacks **≤ 1** on all nine (a winner _is_ determinable)
- no hand dealt for **17 to 508 minutes**
- **1,378 chips** of `prize_pool` unpaid (1,093 when first measured, still
  climbing)
- average **147 minutes** stuck, worst **8.5 hours**

A healthy spin never appears in that query — it finishes in minutes — so the
shape had zero false positives across the entire live board.

**Cause.** Players leave the felt (`table_seats.left_at` set) while
`tournament_players.status` stays `playing`. The engine counts someone who is
gone as still in the game, waits for an action that never comes, and never
reaches the "one player left" that would finish it. The chips sit on the table
and the prize sits unpaid.

**Why the existing sweep missed it.** There is one, and it is startup-only with
a **twelve hour** threshold plus a no-hands-in-the-last-hour test. Twelve hours
is a fair floor for an MTT and meaningless for a format built to last minutes.

**Fix.** `finishSeatFirstGamesThatAreOver`, once a minute, three conditions that
must all hold — started > 5 min, no hand for > 3 min, ≤ 1 live stack. Each is
wide of a healthy game and it is their conjunction that makes it safe. The row
is CAS-claimed (`RUNNING` → `COMPLETING`) so a live engine mid-finish always
wins the race, then handed to the existing `recoverStuckCompletingTournaments`,
which ranks the remaining players by chips, assigns places and pays the
structure. It never cancels — Dan 2026-08-19, "TOURNAMENTS RUN. THEY DO NOT
CANCEL."

## The sweep

Every guard the repo owns, run across everything:

| check                           | result                                 |
| ------------------------------- | -------------------------------------- |
| check-horses-are-players        | OK — 9 exclusions, all justified       |
| check-seat-law-parity           | OK — client and server agree           |
| check-bus-wiring                | OK — 79 listened / 140 emitted         |
| check-route-targets             | OK — 124 routes / 64 navigates         |
| check-stranded-writers          | OK — 129 tables, 0 stranded            |
| check-maybe-single              | clean                                  |
| check-discarded-read-then-write | clean — 1,026 files                    |
| check-esm-require               | clean                                  |
| check-no-orphaned-work          | OK — 6 protected commits still on main |

No stubs or TODOs anywhere in the spin path (the greps hit input placeholders
and prose only).

**Live data, 24 hours.** Money is exact: 1,316 completed spins,
**90,107 chips of pools, 90,107 paid**. Zero on every integrity check —
completed-without-a-multiplier, completed-without-a-winner, completed-but-
unpaid, open tables on finished spins.

**Duplicate tables: investigated, not a bug.** 29 of 1,306 spins carried more
than one table row, but **0 had more than one OPEN table** — the recycler
closes them, and 25 of 29 completed normally. The 4 that did not were the stuck
games above, which is the defect already fixed. Worth recording so nobody
chases it again.

## Verification

- `npx tsc --noEmit` — client 0, server 0
- client vitest **632 files / 9,381 tests** green
- server vitest **236 files / 2,649 tests** green
- run serially, never in parallel
- new pins: `TheWheelFiresOnTheDraw` (10), `ASpinThatIsOverMustEnd` (10)

`sharedSpinReveal` and `spinPostReveal` both pinned the old `holdUntil`
expression handed to the engine. Both were updated in the same commit per
section 8 — keeping the invariant they exist for (the hold is the DEAL time,
never the wheel time) and adding the one-sidedness that is now load-bearing.

## Deploy note

Merged as `b35cb0c120` with CI green. The engine deploy deferred twice on the
**drain gate** ("hands are still in flight", then a human seated). That is the
gate doing its job and it was left alone rather than forced: a forced restart
voids a live hand, and CLAUDE.md 10.5 is explicit that hands are protected on
every restart path. It lands on the next clear window; the changes are
server-side, so nothing is visible until it does.
