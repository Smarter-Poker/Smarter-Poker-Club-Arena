# A Spin Pays The Ladder The Wheel Drew

2026-09-02. Dan's call on issue #2648: pay it back, then fix it at the root so
it cannot happen again. Paid, root-caused, guarded, and audited for siblings.

## What was owed, measured rather than accepted

The issue said 68 games and 1,432.00 chips over the last 30 days. Measured over
all time against the SPIN_TIERS ladder:

| multiplier | games | places owed         | chips    |
| ---------- | ----- | ------------------- | -------- |
| 10x        | 86    | 2nd (20%)           | 1,698.00 |
| 25x        | 4     | 2nd (12%), 3rd (8%) | 120.00   |
| 100x       | 1     | 2nd (12%), 3rd (8%) | 20.00    |

**92 games, 97 payments, 1,838.00 owed at first count and 1,878.00 by the time
it was paid** - the set grew while I was measuring it, which was the first
clue that this was not purely historical. The issue's window started
2026-08-03; the first occurrence is 2026-06-10.

All 97 payees are horses. They paid the same buy-in from the same wallet and
they were paid the same, with no `is_horse` branch anywhere in the migration
(CLAUDE.md 10.5).

**First place keeps its overpayment.** The reconciler reports `overpaid` and
performs no clawback. Dan asked for the shortfall to be paid, not for money to
be taken off winners.

## It was not one bug. It was two, with twelve good days between them

Per-day, 10x games paying second place correctly:

| period                       | games    | correct  |
| ---------------------------- | -------- | -------- |
| 2026-06-10 -> 2026-08-20     | 60       | 0%       |
| **2026-08-21 -> 2026-09-01** | **~240** | **100%** |
| 2026-09-02 04:13 onward      | 33       | 0%       |

The middle band is the whole story. This was fixed, worked perfectly for twelve
days, and **regressed at 04:13 on the day it was being paid back**. Anyone
back-paying without noticing that would have paid a moving target and left the
cause running.

The two causes, one column:

1. **June to August:** the engine's cache dropped `payout_structure` from the
   Spin draw patch, so a started Spin ran on the pre-draw placeholder. Fixed in
   code by #2645.
2. **2026-09-02:** `fn_ca_fund_overlay_on_lock` rewrote the ladder from the
   SIZE OF THE FIELD - "pay the top N% of entrants" - which on three seats
   rounds to one place and silently replaced every high multiplier with
   winner-take-all. That trigger now skips Spins.

The two eras are even visible in the column: the old one holds compact JSON,
the new one holds `100.0000000000000000`, the signature of a number formatted
by Postgres rather than written by the engine.

## Why nobody noticed for eleven hours

This is the part worth keeping.

`fn_tournament_payout_reconcile` is the estate's payout auditor, and it reads
`tournaments.payout_structure` as its **source of truth**. With the column
overwritten it computed "expected = 100% to place 1", saw place 1 paid in full,
and returned `clean: true` on a game that had just short-changed two players. I
confirmed this on a real underpaid game before touching anything:

    {"ok": true, "clean": true, "paid_places": 1,
     "total_expected": 200, "total_paid_to_known_holders": 200}

The corruption made itself invisible to the one check built to catch it. A
guard on the payout was never going to be enough; the guard has to be on the
ladder, because everything downstream believes it.

## What was done

**Paid.** `tournament_payouts` source `reconcile`: 97 payments, 1,878.00 chips,
92 games, 69 players, through the existing idempotent credit path rather than a
direct balance write.

**Ladders restored.** 95 completed Spins, then 139 cancelled ones. The
cancelled games pay no prize and were money-neutral, but a drift check that
permanently reports 139 benign rows is a check people learn to ignore.
`fn_spin_ladder_drift_check` now returns **0 all-time** and that number means
something.

**A constraint that blocked its own repair.** `tournaments_spin_no_extra_rake`
asserted "no fee on a Spin" with no date clause, while its sibling
`tournaments_spin_has_no_fee` grandfathers rows created before 2026-08-21. Both
are `NOT VALID`, so neither ever checked the 7,120 historical rows on the way
in - the second only ever fired on somebody trying to FIX one, and it blocked
this repair. Aligned with its sibling. Zero Spins created after the cutoff
carry a fee, so the forward guarantee is untouched.

**The root-cause guard.** `public.spin_payout_ladder` is now the ladder written
down where the SQL auditor can read it, and
`zzz_spin_ladder_is_the_drawn_one` restores it on any write that disagrees.

It **normalises rather than refuses**, for the reason the seat-exit trigger
already records: a guard that can refuse is a guard that can strand a game.
Raising here would stop a Spin starting, which is worse than the fault being
prevented. It corrects the row and files a critical alert, so the money is
right either way and the defect is loud.

Its name begins `zzz` on purpose. Postgres fires BEFORE triggers in
alphabetical order and the trigger that caused this is
`zz_ca_fund_overlay_on_lock`, so the guard has to sort after it. Rename either
without the other and the guard runs first, corrects nothing, and the hole
re-opens silently.

## The audit for siblings

A first sweep comparing `prize_pool` against `sum(tournament_players.prize)`
suggested ~14,200 chips underpaid across 40 non-Spin games. **That was a false
signal and worth recording as one.** `tournament_players.prize` is a display
column, not the payment record; `tournament_payouts` is. Running the reconciler
across the same 40 games returned **0.39 chips** genuinely owed.

Restricted to the window where payout records are complete (from 2026-08-31,
when the table begins):

| type | seats | mismatches | anyone underpaid                       |
| ---- | ----- | ---------- | -------------------------------------- |
| SPIN | 7,075 | 0          | no                                     |
| SNG  | 5,464 | 0          | no                                     |
| MTT  | 951   | 47         | no - paid 3,472.29 MORE than displayed |

**Nobody is underpaid anywhere.** The MTT gap is the `prize` column
under-reporting money that was actually paid, which is a display defect and is
left recorded here rather than repaired by guesswork.

## Still open, and deliberately not decided here

Three June Spins (10x, 10-chip pools) have three players each and **no player
recorded at position 2 at all** - a separate ranking defect. 2.00 chips apiece,
6.00 total, owed to nobody identifiable. The reconciler flags these
`no_finisher_recorded` - "needs a human decision" - and that is where they stay.

## Verified

- Probed inside a rolled-back transaction first (CLAUDE.md 11.5) and the probe
  agreed with an independent SQL measurement to the cent: 1,878.00.
- Migration aborts on any reconciler issue other than `overpaid` and
  `no_finisher_recorded`, and on any total above a 4,000 sanity ceiling.
- Guard proven live: wrote `[{"place":1,"percentage":100}]` to a 10x game and
  read back `[{"place":1,"percentage":80},{"place":2,"percentage":20}]`, rolled
  back.
- `tests/the-spin-ladder-is-one-ladder.law.test.ts`: 8 pins, and three
  mutations verified red - drifting the database ladder from `SPIN_TIERS`,
  renaming the guard so it sorts before the offender, and making it refuse
  instead of normalise.
