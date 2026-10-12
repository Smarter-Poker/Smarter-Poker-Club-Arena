# The engine and the settler agree on every Diamond hand (2026-10-06)

## Why

Dan, 2026-10-06: let him know when horses are added and fully integrated, and
prove the engine fix first, before starting cash games.

The "engine fix" is the pair of changes that let a Diamond cash hand settle
once the arena opens:

- the settler (`fn_poker_diamond_settle_cash_hand`, migration
  `20261005183028`) recomputes every rake from the owner's published economics
  and refuses a hand that arrives without `contributed`, `dealt_in` and
  `hand_saw_flop`;
- the engine sends those three facts (#6268) and prices the rake from the same
  economics (#6288). Both are on the live engine (`9fdbf692` contains #6288).

Each side had been tested alone: the settler against hand-written payloads
(`run-diamond-cash-rake.py`), the engine with the database mocked
(`server/src/engine/ADiamondCashHand*.test.ts`). Nothing had ever handed a
payload the ENGINE produced to the settler PRODUCTION runs, and no Diamond cash
hand has ever been dealt on production. Opening cash games would have made the
first live hand the first time the two met.

## What this adds

`tests/sql/run-diamond-engine-hand-proof.py` with
`tests/sql/diamond-engine-hand-proof-driver.ts`, run by the accounting job
through `scripts/ci/run-diamond-sql-acceptance.py` on every change.

On its own isolated PostgreSQL 17 cluster (no TCP listener, no credential,
nothing read from the environment but `PG_BIN`), reusing the rake harness's
fixture world - the Diamond Arena, a 10/20 table, four funded seats, one of
them a horse:

1. The settler under test is fingerprinted against production's
   (`md5(pg_get_functiondef(...)) = 500b74f93049e7bc85a21676e3416edb`, read
   2026-10-06), and the published 10/20 rake answers are asserted equal to
   production's: 10 percent, 5 heads-up, 10 three-handed, caps 300 / 150 /
   300, no flop no drop, rounding down, minimum pot 0.
2. The engine's own `HandController` deals real hands - a four-way showdown, a
   fold to the big blind, a preflop raise that wins uncontested, an all-in to
   the cap, and more showdowns - with the schedule resolved from the same
   `ca_diamond_economics` rows the settler reads. The payload is composed with
   the engine's own `captureHandSeatGenerations`, `handStackBefore`,
   `requireHandSeatGeneration` and `diamondCashRakeFactsFor`, in the shape
   `ServerTableEngineSettlement` sends (pinned against that source, so the
   proof refuses to pass if the engine's composition changes).
3. Every hand is ACCEPTED by the settler, banks exactly the engine's rake,
   lands every seat on the engine's stack, attributes rake to the horse like
   the people (CLAUDE.md 10.5), and closes the Diamond identity. Custody ends at
   the 6,000 seeded less exactly the rake taken, all of it in the accrual.
4. Redelivering every hand moves nothing twice.
5. A conserving hand that claims one Diamond more rake than the settings price
   is REFUSED by the rake recompute itself (`diamond_cash_rake_disagrees`), so a
   pass cannot come from a settler that accepts anything.

## Measured

Run eleven times locally on PostgreSQL 17.10, each with fresh decks. Every run
passed (55 to 63 checks, depending on how many hands the all-in left
playable). A typical run: pots of 80 (rake 8), 20 and 50 with no flop (rake 0),
an all-in pot of 3,890 capped at 300, and a heads-up pot of 40 at the
heads-up 5 percent (rake 2).

One run found a defect in the proof itself, not the settler: the all-in left a
single funded player, and the wrong-rake case was built on zero-stack seats,
so it was refused for that instead. The wrong-rake case now runs right after
the first raked hand, while every seat is funded, and requires the refusal to
be the rake check by name.

## What this is not

An isolated proof, not a production certificate. It says the live engine and
production's settler agree hand for hand on production's code and published
numbers. Cash games stay closed; opening them is Dan's decision.
