# Lightning: New Players Are Always the Big Blind First

Dan, 2026-10-24, verbatim: "NEW PLAYERS SHOULD ALWAYS BE BB FIRST."

## What Production Showed

In the three hours before 19:00 UTC, 359 new Lightning pool slots were dealt their first hand. 337 were the big blind, 18 the small blind and 4 held no blind. Every exception was a pass where two or more never-dealt players were formed together, and only one of them could be the big blind.

## Why It Happened

Three causes, all in `fn_lightning_match_plan`, the live matcher:

1. **The rule was off.** `fn_lightning_config` defaulted `first_entry_rule` to `any_seat`, and no live Lightning game names the key, so the plan's first-entry block never ran. The 337 were the big blind only because `fn_lightning_blind_order` ranks `last_bb_at` NULLS FIRST: a newcomer is usually first in line, and when two arrived together the second was next in blind order and became the small blind.
2. **"Newcomer" meant the wrong thing.** It was "no `lightning_blind_ledger` row in this Cluster, ever", not "new to this sitting", so a player returning to the pool kept their old ledger row and was never held.
3. **Even when on, the rule gave way.** It held a newcomer only while holding cost the pass no hand (`v_g2 = v_g`). Twelve legal players with four newcomers dealt two of them outside the big blind.

## The Fix

Migration `20261024195059_lightning_new_players_are_always_the_big_blind_first.sql`, md5-guarded text replacements of three live definitions in one short transaction (`lock_timeout` 1s, `statement_timeout` 8s), no new objects:

- `fn_lightning_config`: `first_entry_rule` is `big_blind` always. A ruleset that names anything else, `any_seat` included, is listed under `invalid` with reason `first_entry_is_always_big_blind`, and `big_blind` is used, so the config reports what the plan does.
- `fn_lightning_match_plan`: a newcomer is a pool slot that has never been the big blind (`lightning_pool_slot.last_bb_at IS NULL`, the key the blind order already ranks first). A newcomer who is not one of the pass's big blinds is held (`WAITING_FOR_BB` / `FIRST_ENTRY_WAITS_FOR_BB`) even when that costs the pass a hand. Holding shrinks the pass, so the big blinds are taken again and a newcomer pushed out of them is held too, until nothing changes. The single exception is a hold that would leave the pass no hand at all: a pool of only newcomers still deals, so the pool never deadlocks.
- `fn_lightning_matcher_snapshot`: its `newcomer` is the same `last_bb_at IS NULL`.

The engine's TypeScript port, `server/src/lightning/LightningMatcherModel.ts`, runs the same loop line for line (`isLightningNewcomer` reads `lastBbAtMs`, never the stored flag), `lightningMatcherParams` returns `big_blind` whatever the row says, and `LIGHTNING_MATCHER_PARAM_DEFAULTS` and the simulator default to `big_blind`. The simulator keeps `any_seat` only as an offline what-if.

A held newcomer is first in blind order (`last_bb_at` NULLS FIRST, then the slot's age), so they are the next pass's big blind; nobody waits behind a queue that does not move. A player with an unresolved big blind still outranks them. Horses are players (CLAUDE.md 10.5): nothing reads a horse marker. No money, seat or ledger row is written.

## What It Costs

With five or more players who have already been the big blind, no newcomer is ever dealt off the big blind. The cost is throughput in the rare pass where several newcomers arrive together: twelve legal with four newcomers now deals one hand of six instead of two, and the three held newcomers are first in line for the big blinds that follow. A pass of six with two newcomers deals five-handed (after the existing three-second five-player wait) and the second newcomer is the next big blind.

## Decision on an Explicit `any_seat`

Dan's word is "ALWAYS", and no pinned contract requires the rule to be switchable, so an explicit `any_seat` is not honoured. The historical native harness (`scripts/dev/test-lightning-phase6-matcher.sh`) still exercises `any_seat` on its own fixed migration chain, which ends before this migration.

## Proof

- A rolled-back probe on production (one `DO` block ending in `RAISE EXCEPTION`, `REPEATABLE READ` so every plan read one snapshot) built the three replaced definitions into `pg_temp` and ran them beside the live ones for all 17 Lightning Clusters: plans identical where the pool held no newcomer, the config returns `big_blind` with no `invalid` entry by default and lists an explicit `any_seat` as `first_entry_is_always_big_blind`, every other config key unchanged, and the snapshot's `newcomer` agrees with `lastBbAtMs` for every player.
- `server/src/lightning/ANewPlayersFirstLightningHandIsTheBigBlind.law.test.ts` pins the behaviour on every matcher version and the SQL text.
- `scripts/dev/test-lightning-matcher-parity.sh` installs this migration on the exact production preimages after `20261023230001`, so the port is compared with today's SQL rule on PostgreSQL 17 in CI.

## Delivery

The migration applies through the normal Apply Merged Migration path. The TypeScript port is engine code (`server/src`) and ships with the next daily 04:00 America/Chicago engine release; until then the live SQL plan already holds newcomers and the shadow comparison's `m1-port` runs the previous rule, so an A/A calibration gap in that window is expected and is not a matcher defect.
