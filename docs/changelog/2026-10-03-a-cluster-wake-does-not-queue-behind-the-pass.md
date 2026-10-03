# A cluster wake does not queue behind the pass (2026-10-03)

Migration: `20261003223747_a_cluster_wake_does_not_queue_behind_the_pass`.
Law: `tests/a-cluster-wake-does-not-queue-behind-the-pass.law.test.ts`
(`docs/laws.d/a-cluster-wake-does-not-queue-behind-the-pass.md`).
Harness: `scripts/ci/test-a-cluster-wake-does-not-queue-behind-the-pass.py`.

## Why (phase 7, availability)

Must-move Clusters are ticked two ways: the engine's 5-second pass
(`fn_cash_clusters_tick_all`, one transaction, 5.5 s budget) and a per-game
wake after a seat change or a hand. The pass keeps every game row it ticked
locked until the whole pass commits, so a wake for one of those games waited
for the rest of the pass.

Production, 21:00-22:40 UTC (`pg_stat_statements` since the 21:00 restart):

| call | calls | mean | max | total |
| --- | --- | --- | --- | --- |
| wake (`fn_cash_cluster_tick`) | 27,682 | 307 ms | 5.8 s | 8,486 s |
| pass (`fn_cash_clusters_tick_all`) | 872 | 2.9 s | 5.8 s | 2,561 s |

A 20-second lock sample at 22:35 found `fn_cash_cluster_tick` waiting on a
`cash_games` row held by `fn_cash_clusters_tick_all` in 55 of 80 readings. Each
wait holds a PostgREST connection and a backend while the game it wants is
already being ticked.

## Change

`fn_cash_cluster_tick` takes its game row with `FOR UPDATE SKIP LOCKED` when
called outside a pass (no `ca.cluster_pass_deadline`), and if somebody holds the
row it returns `{ok: false, reason: 'ticking_elsewhere'}` at once. The next pass
ticks the game again within five seconds, which is no later than the wake would
have finished waiting. Inside a pass the lock is unchanged. The engine needs no
change: `afterGameTick` acts only on `actions` and `seated_total`, and this
answer carries neither. No money moves.

The live body (41,928 characters) was last written by hand-applied substitutions
and is not in this repository as a CREATE statement, so the migration
substitutes one fragment on the md5-pinned live text, requires exactly one
occurrence, checks that the reverse substitution reproduces the pin, and that
privileges did not change. Its NOTICE prints the post-image md5.

## Proof (local PG17, the shipped migration on a stand-in with the same fragment)

| case | result |
| --- | --- |
| substitution applies once, reverse reproduces the pin | ok |
| wake on a held row: `ticking_elsewhere` in 9 ms | ok |
| wake on a free row ticks | ok |
| unknown game is `not_found` | ok |
| inside a pass the tick still waits (lock timeout after 1.2 s) | ok |
| a session whose pass transaction ended is a wake again | ok |

## Applying

The migration text contains `FOR UPDATE`, so the owner applies it with
**Apply Merged Migration**, outside the :50-:03 break window.
