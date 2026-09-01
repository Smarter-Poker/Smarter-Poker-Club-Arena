# A place pays once, and a finisher places once

Fourteen criticals arrived together at 12:20-13:14 UTC from four detectors that
came online the same day. They turned out to be three unrelated stories, and the
most useful thing about all three is how little of the money was real.

## 1. Paid places with nobody in them — extinct since July

Nine events "left paid place(s) with nobody in them". The positions are the
tell: a 10-row field carries ten _distinct_ positions whose maximum is 11, 12 or 13. The finishers were ranked out of a ladder deeper than the field that
survives in `tournament_players`, so the vacant places are the numbers nobody
was left holding.

Not a re-entry artefact — every one has `is_rebuy false`, `is_reentry false`,
zero rebuys. Not a payment either: these events have **no `tournament_buyin`
wallet transactions at all**, because they predate the current accounting.

| month         |  completed | gapped |  share |
| ------------- | ---------: | -----: | -----: |
| May 2026      |         36 |     29 | 80.56% |
| June          |        458 |     85 | 18.56% |
| July          |        484 |      9 |  1.86% |
| **August**    | **45,424** |  **0** | **0%** |
| **September** |  **2,710** |  **0** | **0%** |

Nothing to fix in current code, and nobody identifiable to pay — the detector
says as much itself. Resolved with the measurement, left as evidence.

## 2. Winners paid twice — real, but into a dead pool

23 finishers were genuinely credited twice, always the same shape:

```
19:25:10  "Tournament prize: position 6"       60.00
19:25:26  "Tournament winner prize: 1st place" 300.00
```

Sixteen seconds apart, from the two payout paths in
`TournamentManagerEliminations.ts`. June 1, July 2, August 20, September 0.
Total **394.30**, newest 2026-08-20, all 23 horses, no human overpaid.

**No money is owed and none was moved.** Every one of those credits landed in
the legacy `public.wallets` pool rather than a club wallet — `balance_after` on
each transaction matches that row, and not one has a `chip_ledger` entry.
CLAUDE.md 11.5 records that pool as frozen since 2026-08-21 with nothing reading
it. Clawing 394.30 out of live club wallets would have taken real chips from
players who never received spendable ones.

### The prevention that was missing

Two engine fixes already narrowed this: 2026-07-28 gave the winner path and the
stuck-`COMPLETING` watchdog one shared key, and 2026-08-28 moved both paths from
a user-scoped key to a **place-scoped** one, so a place cannot be paid twice to
two different people.

Place-scoping cannot close this case. Place 6 and place 1 are different places,
so different keys, and the same player collects both — the engine paid place 6
believing that was the finish, and it was not wrong at the time.

So the other half of the invariant now lives in the one funnel both paths call:
**a player may hold one structure place prize per tournament.** A second is
refused and alerted rather than paid.

Scoped on evidence, not instinct: the predicate matches only
`tourney:<id>:prize:place:<n>`. 13,080 such keys exist and **not one** user
holds two in the same tournament, so it refuses nothing that happens today. The
tempting broader predicate (`tourney:<id>:prize:%`) would have refused **9,453**
legitimate second credits — heads-up shortfall top-ups keyed
`...:prize:<user>:hu_shortfall` are a real second prize to the same player. That
predicate was measured and rejected.

Probed rolled back first: same key returns true (the idempotency store handles
that a layer down), a different place for the same player returns false.

## 3. The sweep outgrew its own limits

`fn_tournament_payout_sweep` limits the SCAN, so a limit under the window's
population silently shrinks the window — and it orders newest-first, so what
falls off is the oldest, which is exactly what a deep pass exists to reach.

| window  | population |  limit | covered                                                      |
| ------- | ---------: | -----: | ------------------------------------------------------------ |
| 2 days  |      7,020 |  6,000 | no — already raised to 20,000 in merged code awaiting deploy |
| 7 days  |     30,878 | 40,000 | yes (`ca-payout-sweep-hourly`)                               |
| 30 days |     48,093 | 40,000 | **no — 8,093 short**                                         |

The 30-day figure was 35,220 when 40,000 was chosen on 2026-08-27. Both 30-day
callers are raised to 150,000 — the engine's `PAYOUT_SWEEP_DEEP_LIMIT` here, and
both `pg_cron` jobs in the accompanying migration.

Worth being exact about the impact rather than claiming more than the evidence
supports: **nothing was missed.** The hourly 7-day pass applies and fully covers
its window, so every event is reconciled repeatedly while it is fresh, and the
tail the 30-day passes could not reach had already been swept many times before
it aged that far. The hole was in the guarantee, not yet in the money.

## The 0.02

One player short across 34,078 paid places in seven days, by two cents, and that
prize also landed in the frozen pool. Recorded, not paid — crediting a live club
wallet would create two real chips to settle a debt denominated in dead ones.

## Result

Fourteen blocking incidents to zero. `tsc --noEmit` clean on the server project.
