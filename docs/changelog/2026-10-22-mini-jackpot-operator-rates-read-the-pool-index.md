# The Mini Jackpot Operator Rates Read The Pool Index

Date: 2026-10-22

## What Was Slow

Live PostgREST transactions (usename `authenticator`) were sampled every 200 ms
for 30 s on production for transactions older than 200 ms holding a lock on
`public.tables`, `public.hand_history` or `public.clubs`. After
`fn_horse_committed_observation_snapshot` (fixed in PR #7669), the next long
holder was `fn_bbj_mini_for_club`:

| Measurement (2026-10-22 04:05-04:20 UTC)            | Result                                  |
| --------------------------------------------------- | --------------------------------------- |
| 150 samples, any lock on the three tables           | present in 40, up to 3.4 s per txn      |
| `pg_stat_statements` (authenticator)                | 51,774 calls, mean 897 ms, max 7,464 ms |
| Production call, Midway Union operator claims       | 3,155-3,631 ms                          |
| Production call, player claims                      | 7-29 ms                                 |

## Why

Only club staff pay for the rate window (in/out per day, runway). The income
side summed seven days of contributions through
`ca_launch_bbj_reporting_contributions`, whose launch-reset filter joins every
contribution to its pool's reset start by `jsonb_build_object('id', pool_id)`.
No index can bound that key, so all ~480,000 rows of the Midway pool's window
were hashed and filtered; when the planner merge-joined the pool CTE it also
sorted them to disk first (`EXPLAIN ANALYZE`: 1,392 ms and a 19 MB external
sort for the one sum). The function read the view twice more for winners.

## The Fix

Migration `20261022041710_the_mini_jackpot_operator_rates_read_contributions_by_pool_i.sql`:
the pool's reporting start is read once in the `pool` CTE with the same
function the reporting views are built from (`fn_ca_launch_bbj_reporting_start`,
`-infinity` when the pool was never reset), and every sum, count and max reads
`bbj_contributions` / `bbj_winners` directly with `created_at >= start_at` as an
index bound. Same predicate, same rows, same numbers. CREATE OR REPLACE only,
preimage md5 guarded (`83308728ca2f8033dbf967a1f485f09b`), grants unchanged,
the operator gate on every rate column unchanged, the views untouched.

## Proof Before Shipping

- Production, read-only, one call: the new body against the live function for
  every club with an active owner/admin (operator claims) plus five player
  calls. Every field equal except the live backup balance, which moved by
  cents between the two reads. Operator calls 3,155-3,252 ms became 294-296 ms;
  player calls unchanged.
- Native PostgreSQL (`scripts/ci/test-bbj-mini-operator-rates.py`, CI shard 4):
  installs the exact predecessor (md5 checked), seeds a union pool, a pool with
  an executed launch reset inside the 7-day window, a superseded reset and an
  unrelated pool, then compares every returned row for 11 caller/club pairs
  (owner, admin, member, suspended manager, anonymous, wrong club) between the
  old and new definitions in one snapshot, after install and after replay.
  Non-operators must still get NULL rates; the income plan must be an index
  scan of `idx_bbj_contrib_pool_created` bounded by the reset start, with no
  hash, sort or jsonb key.

## After Install

Recorded in the PR once the migration is installed.
