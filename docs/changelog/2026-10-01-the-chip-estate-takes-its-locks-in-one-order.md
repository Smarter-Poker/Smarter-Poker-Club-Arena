# The chip estate takes its locks in one order

2026-10-01. Migration `20261001000000_the_chip_estate_takes_its_locks_in_one_order`
(applied with `apply.sh` at 00:05 UTC after `REHEARSAL OK`). Evidence, numbers and the
isolated reproductions: `docs/evidence/chip-deadlocks-2026-10-01.md`.

## Why

Production logged 3,605 deadlocks in the 24 hours to 2026-09-30 23:16 UTC - over the
`DatabaseDeadlocksElevated` line in most minutes of the day. Every one is in the Postgres log
(`log_lock_waits` is on, so a deadlock that a function catches is logged too). Ranked by what the
chosen victim was waiting for, five pairs make up 98% of them:

| rank | rows                                                            | the two paths                                                          | deadlocks / 24 h |
| ---- | --------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------- |
| 1    | `agent_commission_unsettled_rollup`, `ca_club_commission_daily` | cash accrual batch x tournament finish                                 | 1,111            |
| 2    | `player_stats`                                                  | cash accrual batch x the hand's stats projection and promo playthrough | 961              |
| 3    | `vip_points_carry`, `club_wallets`, `ca_club_rake_daily`        | tournament finish x a raked hand's post-commit obligations             | 837              |
| 4    | `profiles` (through the `player_stats` trigger)                 | tournament finish (and the batch) x the horse claims                   | 346              |
| 5    | `horse_mind_pairs`, `_stats`, `_stats_scoped`                   | horse-mind flush x horse-mind flush                                    | 271              |

## What changed

One order for every chip door: lanes and scopes (now including a per-club commission key), the
tournament row, the banks (`club_wallets`, `union_wallets`, `clubs`), the club-day rollups under
their bank or key, then player rows in player order. Pairs 1, 3, 4 and 5 now follow it:

- `atomic_distribute_rake` locks the club wallet before inserting the rake record, whose triggers
  take the players' VIP carry and the club's day rake rows - the order a tournament finish
  already uses.
- `trg_agent_commission_rollup_insert` takes `agent-commission:<club>` (an advisory key), in club
  order, before its rollup rows; `fn_credit_agent_commissions_batch` and
  `fn_retry_cash_accounting_sources` take every key they will need before their first item.
- `fn_sync_profile_total_hands` does not rewrite a profile when the `player_stats` UPDATE left
  `hands_played` unchanged (a finish's rake recognition writes `+0` for every entrant).
- `upsert_horse_mind_pairs`, `_stats` and `_stats_scoped` walk their input in key order; repeats
  of one key keep their input order, so every value comes out the same.

Each is an asserted substitution over the pinned live text (md5 before and after, reverse proved,
owner and grants unchanged). No amount, receipt, refusal or grant changes.

## Not changed: pair 2 (PR #5542)

PR #5542 orders Projection 2 of `fn_project_hand_side_effects_after_post_commit_20260908`. It is a
draft whose owner has been inactive since 2026-09-28, and it cannot land as written: it redefines
the function with its 2026-09-28 body and would drop Projection 4b (`20260930043000`). It would
also not end the pair: the cash accrual batch is one transaction over about 31 hands, so it keeps
earlier hands' rows while taking later ones, and the isolated reproduction deadlocks with the PR's
`ORDER BY` in place. The pair needs the batch's transaction shortened; that is reported, not done.

## Proof

`scripts/qualification/chip-deadlocks.py` builds its own PostgreSQL 17 cluster, loads production's
26 bodies (md5-pinned; it refuses to run otherwise) and reproduces each pair with real concurrent
sessions: every fixed pair deadlocks on the live bodies and none after the migration's own
substitution block runs. `tests/the-chip-estate-takes-its-locks-in-one-order.law.test.ts` pins the
migration.
