# A Seat-First Fill Brings Spares

**Date:** 2026-09-03
**Scope:** `server/src/services/TournamentRecurringService.ts` — the seat-first
branch of `topUpWithHorses`, plus two new pure helpers and their pins.

## How it was found

Dan asked whether the club programme shipped in #2878 was actually working. The
tournament tables say yes — 37 Spins running in Deep Stack Society, 27 in Midway
Union, satellite heads-up games live in both. The engine log says something else.
One hour of `docker logs club-arena-engine`:

```
    247  [TournamentRecurring] seat-first fill added nobody to <id>
     98  [TournamentRecurring.seat_first_seat_rpc_failed]
     89  of those 98 were FOUR TABLE LIMIT
```

Every one of the 247 lines had the same shape:

```
seat-first fill added nobody to f8124b9e from 0 own registrant(s)
  + 1 free horse(s) - shortfall 1
```

One empty seat. One candidate. Refused. Seat still empty — 247 times an hour, on
the boards Dan opened to get horses playing.

## Why one candidate is not enough

`seatFirstFillOrder(shortfall, own, pool)` takes `want` candidates for `want`
seats, so the fill asked `pickFreeHorses` for exactly the shortfall. That is only
correct if every candidate can be seated, and one of them routinely cannot.

`pickFreeHorses` excludes horses at the four-game cap, but it reads that busy set
**before** the claim and never atomically with it — its own comment says so —
while `topUpPartialSeatFirst`, the recurring pass and the scheduler all run the
same five-second tick. Two callers pick the same horse; the first claim takes it
to four games, and `fn_enforce_booking_game_cap` refuses the second with 23514.

The fleet makes that race the normal case, not a rare one. Measured live:

| concurrent games |  horses |
| ---------------- | ------: |
| 0                |       2 |
| 1                |     199 |
| 2                |     139 |
| 3                |     247 |
| **4 (capped)**   | **413** |

41% of the fleet is already unpickable and another 25% is a single claim from
being refused. With one candidate per seat, losing that race _is_ an empty seat.

## What changed

1. **Bring spares.** `seatFirstCandidateCount(shortfall)` asks for three
   candidates per seat, minimum three, and the pool is sized from that rather
   than from the shortfall. `registerHorses` in this same file already sizes its
   fetch as `count + busy.size` and calls that the convention this file settled
   on; the seat-first path had drifted from it. Slack is cheap — an unused
   candidate is an unclaimed id, and `pickFreeHorses` still applies the club
   scope and the cash-room reserve before it slices.

2. **Stop at the seats.** With more candidates than seats the loop needs an exit
   that is not a refusal: `if (added >= shortfall) break`. A three-handed Spin
   must never take a fourth.

3. **The cap is a rule, not a fault.** `isExpectedSeatRefusal` classifies
   `FOUR TABLE LIMIT`, `TABLE_CAP_REACHED`, `Player already seated` and
   `duplicate key` as ordinary outcomes. `HorseFleetManager.seatHorse` learned
   this on 2026-08-31 after 57 reports in a ten-minute window; the seat-first
   fill never did, and its 89 reports an hour were burying the three genuine
   refusals sitting beside them. **Every other refusal is still reported,
   unchanged** — the pins assert that the filter guards the report rather than
   replacing it.

## The pin that had to change, and why that is not a loosening

`seatFirstFillOrder.test.ts` forbade the word `break` anywhere in the seating
loop — the 2026-08-24 rule that one rejected horse must not halt the whole game.
That regex was a sound proxy while the candidate list was exactly the shortfall,
because then every exit was an exit on a refusal. It no longer is. The pin now
states the rule instead of the keyword: at most one `break`, and if present it
must be the `added >= shortfall` guard; the refusal branch must still be a
`continue`. Three further pins were added — that the pool is sized from the
padded count, that the full-seats guard exists, and that the report survives for
every refusal that is not on the expected list.

## Verification

- 12 new pins in `oneCandidatePerSeatIsABet.test.ts`, including a reduction of
  the loop's arithmetic showing the old one-per-seat shape seating **nobody**
  where the new one seats the player.
- `seatFirstFillOrder.test.ts` 17 pins green, its pure-function contract
  untouched.
- Server suite green on a clean checkout of main, typecheck clean.

## What this does not fix

The load map and `fn_concurrent_game_load` can still disagree for a moment;
nothing here makes the claim atomic. Slack absorbs the race rather than removing
it, which is the same trade `pickFreeHorses` already documents for its shuffle.
The 413 horses genuinely at four games are a capacity question, not a bug.
