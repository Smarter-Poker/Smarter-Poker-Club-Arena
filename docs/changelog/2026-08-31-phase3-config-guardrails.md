# 2026-08-31 -- Phase 3 of 7: config guardrails

Merged as PR #2270 (`216f949e`). Hetzner engine deploy for that commit finished
19:11 UTC. The rake constraint was applied to production before the code merged
and probed inside a rolled-back block.

## headsUpSpec.ts

The Spin has had `spinSpec.ts` since it was built; the 2-max duel -- about
11,000 games a week -- had nothing. Its truth was spread across
`SNG_BOARD_SHAPES` (seats and both stacks), a second hand-typed copy of the
blind ladder, `buyIn.ts` (the rake), a payout array written inline three deep in
a `flatMap`, and a JSON blob inside a migration. Nothing asserted they agreed.

`src/config/headsUpSpec.ts` and its byte-identical server mirror now hold seats,
stacks, the twelve-level ladder and its three-minute clock, the 5% rake,
winner-take-all, the buy-in rungs, the variants, and the break ruling. The board
reads it; `tests/config/headsUpSpec.test.ts` fails on a one-character drift
between the copies, the same guard that has kept spinSpec honest.

## The headline, which was not a heads-up bug

`ScheduledTournamentService` could stamp `tournament_type = 'SPIN'` on a row
built from any named blind preset. One active schedule does exactly that --
"Spin Royale", every 30 minutes, `blindPreset: "HYPER_TURBO"` -- an MTT ladder
opening at 50/100 with a 15 ante. A Spin's stack is written at DRAW time from
`SPIN_TIERS`, so the draw handed those games a 300-chip stack against a 100 big
blind. Measured across every completed Spin Royale over three days:

    96 of 96 games opened at big blind 100
    average starting depth  3.7 big blinds    (a spec Spin opens at 15-19)
    average length          12.7 hands        (a spec Spin plays 49.8)

Charged as a Spin, booked against the Spin reserve pool, paid on the Spin
multiplier table. The row was being corrected at start -- every one of them
carries the spec ladder in `blind_structure` -- but the TABLE is built from
`blind_structure[0]` before that rewrite lands, so the correction never reached
the felt. Creation is the only place this can be fixed, and it is fixed there:
a row typed SPIN gets spinSpec's twelve rows, no ante, and `SPIN_SEATS`.

## Also closed

- `tournaments_heads_up_rake_within_5_pct` (NOT VALID). The DB capped every
  shape at a flat 10% while a duel pays 5%. History, last seven days: 1,378 duel
  rows at 10%, 456 at 8%, 7 at 6.67% -- all on or before 2026-08-25, none since.
  Historical rows are left exactly as they are; rewriting settled money to
  satisfy a new constraint would be worse than an honest record.
- The restart-clone fee re-cut floored at a hardcoded `0.1`, so a legacy
  heads-up row was re-cut at ten percent. It asks `rakeRateFor` now.
- `BLIND_STRUCTURES.SPIN` deleted: five levels, a two-minute clock, and blinds
  that contradicted spinSpec from level 3 up (25/50 where the spec says 20/40).
- The lobby called anything up to ten seats seat-first; the server and
  `fn_take_seat_and_buy_in` mean `variant='spin' or max_players<=2`.
  `isSeatFirstTournament` says the same thing now. No such row exists today,
  which is exactly why it was worth pinning.
- Scheduled Spins and duels are written `synchronized_breaks = false`, matching
  the engine that has always refused the break on format.
- `predictButtonSeat` derives the heads-up button from the last big blind, so
  the wait-for-BB gate and the deal stop walking different rotations (carried
  from the Phase 2 audit).

## What did NOT change

The duel's ladder numbers are identical to what the board already ran -- the
spec adopted them rather than replacing them -- so there is no observable change
to duels in production, and that is the intended outcome. The observable changes
are the scheduled Spin, the rake constraint and the seat count.
