# A Horse Claim Never Waits On A Player Lock

## What Production Showed

`DatabaseDeadlocksElevated` fired on 2026-10-15 at 00:13 UTC. In `postgres_logs` from 00:03 to 00:15, 14 of the 16 deadlock reports name the pg_cron run `SELECT public.fn_ca_horse_claim_due(500)`. Each one is waiting on a horse's `profiles` row, or on that horse's daily-missions advisory lock, inside `claim_daily_challenge_serialized_body`, `fn_lock_daily_mission_user` or `add_diamonds_to_balance`. The other side of every cycle is the engine's `fn_credit_agent_commissions_batch -> fn_process_cash_accounting_source -> apply_rakeback_player_stats`, whose trigger `fn_sync_profile_total_hands` updates `profiles.total_hands_played` for every player of a hand, in hand order. Horses are players (CLAUDE.md 10.5), so both write the same rows.

## Root Cause

`fn_ca_horse_claim_due` runs as one transaction. It claims up to 500 rewards for up to 45 seconds, and every horse it has paid keeps its advisory lock and its `profiles` row locked until the run ends. Then it took the next horse's locks by waiting. A run holding horse A and waiting for horse B ran into a hand holding B and waiting for A. Postgres cancelled one side. Either a commission batch lost its work, or the claim's subtransaction was filed as `CH3:horse_claim_failed` and deferred for ten minutes. In that second case the run kept every lock it already held and moved on, so the cycles kept repeating through the minute.

The challenge rows themselves were already safe after the 2026-09-24 fix, which locks them in primary key order with SKIP LOCKED. The player locks behind them were not.

## Fix

Migration `20261015032612_a_horse_claim_never_waits_on_a_player_lock` makes one edit inside the claim loop. The edit is a pinned-preimage substitution (live md5 `57b62c37...`, derived postimage `4207064f...`). Before each claim, the run takes the horse's two player locks without waiting, in the same order `fn_lock_daily_mission_user` takes them:

1. `pg_try_advisory_xact_lock` on the daily-missions key.
2. The `profiles` row `FOR UPDATE SKIP LOCKED`. This is the strongest mode any step of the claim takes, so no step inside the claim has to upgrade its lock and wait behind another writer's KEY SHARE.

If someone else holds either lock at that instant, the row is left exactly as it is. It is not claimed, not deferred and not counted, and a minute later it is still the oldest reward owed. A run that never waits on a player lock cannot be one side of a cycle through one.

## Money

Each claim pays exactly what it paid before. The rows, the claim body, the references, the refusal handling and the deferral handling are all unchanged. The only change is when a row is attempted:

- **Nobody is paid twice.** The claim body still locks the row and refuses one that is already claimed.
- **Nobody is skipped.** A skipped row stays completed, unclaimed and undeferred, so the next run chooses it again.

## Pinned

`scripts/ci/test-horse-claim-lock-order.py` runs on native PostgreSQL, through `.github/workflows/horse-claim-lock-order.yml`. It loads the exact production text and drives both production schedules with two real sessions:

- **Against the production text:** the engine's profile writer, and a daily-missions path that holds the advisory lock first. Both schedules deadlock, and the cancelled side loses its work.
- **Against the migration:** the same schedules never deadlock and the run never waits. The busy horse is paid by the next run, and every reward is credited exactly once.

## The Net

`DatabaseDeadlocksElevated` stays in place. After this change, it is expected to stop naming `fn_ca_horse_claim_due`.
