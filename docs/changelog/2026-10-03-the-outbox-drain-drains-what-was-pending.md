# The outbox drain drains what was pending (2026-10-03)

The primary was read-I/O saturated and the engine's hand-commit RPCs were being
killed by the `authenticated` 8 s `statement_timeout`. This is what I measured,
what I changed, and the one thing that is not a code defect at all.

All numbers below were read on production (`kuklfnapbkmacvwxktbh`) between
01:22 and 01:55 UTC on 2026-10-03, from `cron.job_run_details`,
`pg_stat_statements`, `pg_stat_slru`, 0.1 s `pg_stat_activity` sampling,
`pg_stat_user_tables`/`pg_class`, and rolled-back probes (CLAUDE.md 11.5: one
call, one `DO` block, ending in `RAISE EXCEPTION`).

## The symptom was still live, and chronic

Statement timeouts (57014) per 30 minutes, from `postgres_logs`, across the
whole day to 01:30 UTC: **338 to 3,314 per bucket, every bucket**. The last
complete bucket before the change (01:00-01:30 UTC) was **777**. This was not a
spike that had passed.

## What was actually starving everyone: the multixact SLRU

Sampling the drain backends every 100 ms for 32 s (1,600 samples, 5 pids):
75.6% on CPU, **13.9% on multixact SLRU buffer locks**
(`MultiXactMemberBuffer` 111, `MultiXactOffsetBuffer` 37,
`MultiXactMemberSLRU` 34, `MultiXactOffsetSLRU` 31, `MultiXactGen` 10), 5.1%
`DataFileRead`, 2.3% `Lock/transactionid`, 1.3% `IO/SlruRead`.

`pg_stat_slru` over 20 s (reading it twice in one transaction returns one
cached snapshot - `pg_stat_clear_snapshot()` between reads is required, or the
delta is a silent zero):

| SLRU | buffers | hits | reads | miss rate | reads/s |
| --- | --- | --- | --- | --- | --- |
| `transaction` (CLOG) | 1024 (8 MB) | 563,625 | 0 | **0%** | 0 |
| `subtransaction` | 1024 (8 MB) | 141,005 | 0 | **0%** | 0 |
| `multixact_offset` | **16 (128 kB)** | 69,271 | 11,793 | **14.6%** | 589 |
| `multixact_member` | **32 (256 kB)** | 63,016 | 18,646 | **22.8%** | 931 |

`transaction_buffers` and `subtransaction_buffers` have been raised to 1024
blocks and miss nothing. The two multixact SLRUs are still at their
compiled-in defaults (`boot_val` 16 and 32) and are doing **1,520 block reads
a second** between them. SLRU buffer locks are global: every backend that
touches a tuple whose `xmax` is a multixact queues on them. That is why, in one
second at 21:44:31 the day before, `/rest/v1/tables` took 11,154 ms,
`table_seats` 11,671 ms, `chip_ledger` 10,980 ms and `feature_pricing` - two
pages, 100% all-visible, 68 rows - took 5,382 ms. It is also why
`fn_cashier_statement_totals` is ~90 ms warm and ~20 s cold on tables that are
99.6% (`chip_ledger`) and 97.3% (`chip_transactions`) all-visible.

**The cashier's cost is not a vacuum problem and not an index problem.**
`chip_ledger` is `relallvisible` 488,650 of `relpages` 490,725 with 0.05% dead
tuples and was autovacuumed 23 minutes before I looked. Its indexes are already
correct and narrow. The visibility-map heap fetches reported on 2026-10-02 were
a cold buffer cache under a global stall, not stale visibility information.

The multixacts come from foreign-key `FOR KEY SHARE` locks taken on very few
parent rows by very many child writes: `daily_challenge_event_outbox`,
`daily_challenge_progress_events` and `ca_hand_facts` each hold ~11.4-11.7 M
inserts referencing `auth.users` (**1,602 rows**); `agent_commissions` holds
3.33 M inserts referencing `clubs` (**6 rows**) and another 3.33 M referencing
`auth.users`; `chip_ledger` 1.88 M referencing `auth.users`.

I looked for redundancy to remove and did not find enough of it to matter.
There are ~180 column pairs carrying both a `-> auth.users` and a
`-> public.profiles` foreign key, which is genuinely duplicated work since
`profiles.id -> users.id` makes the first transitively implied - but almost all
of them have **zero** write traffic. The hot ones are `user_daily_challenges`
(43 k inserts), `diamond_transactions` (832 k) and `wallet_transactions`
(372 k), and an UPDATE only rechecks a foreign key when the referencing column
changes, which `user_id` does not. The dominant producers are **single,
non-redundant** foreign keys. Dropping those would be removing a real
referential guarantee to make a symptom go away, which CLAUDE.md forbids and
which is not mine to decide unilaterally.

**So the proportionate fix for the SLRU thrash is capacity, not code, and it is
reported rather than worked around:** `multixact_member_buffers` and
`multixact_offset_buffers` are PostgreSQL 17 GUCs (this server is 17.6.1) with
`context = postmaster`, so raising them - to the order of the 1024 blocks the
other two SLRUs already have - needs a restart in a maintenance window. The
evidence that this is the right lever is the table above: the two caches that
were sized miss nothing, the two left at default miss 15-23%.

## The code defect I did fix

`sp_drain_daily_challenge_event_outbox` runs on four shards every minute under
a 45-second budget. Its loop has exactly one early exit - the shard picker
finding nothing:

```
WHILE v_seen < p_limit AND clock_timestamp() < v_deadline LOOP
  ... pick one user ...
  EXIT WHEN v_user_id IS NULL;
  v_result := fn_drain_daily_challenge_event_outbox_user(...);
  COMMIT AND CHAIN;
  EXIT WHEN (v_result ->> 'seen')::integer = 0;
END LOOP;
```

Daily Missions events arrive continuously at ~7 a second - the live outbox held
423 rows and **none older than 60 s**, so it is not backlogged, it is being fed.
The picker therefore almost always finds another row, and the run keeps going
until its budget runs out. Over three hours, 720 runs:

| | value |
| --- | --- |
| average duration | **17.13 s** |
| runs over 10 s | 492 of 720 |
| runs over 30 s | 121 |
| runs at the 45 s ceiling | 89 |
| **cores of the primary held continuously** | **1.135** |
| `pg_stat_statements` mean / calls | 11,185 ms over 24,479 |
| share of all database time | **5.73%** |
| `shared_blks_read` | 13.1 M |

The work it exists to do is **2.9 seconds**. A rolled-back probe replaying the
exact loop for shard 0 drained the shard dry in 2,875 ms: 155 iterations, 307
events, every one booked, picker returned NULL. The other ~14 seconds per run
is the loop chasing arrivals. It is a drain that never finishes draining.

The shape of that chase costs a second time. Each iteration is one player in one
transaction: two `set_config` calls, `pg_try_advisory_xact_lock`,
`fn_lock_daily_mission_user` (advisory lock plus `profiles ... FOR NO KEY
UPDATE`, which takes a tuple lock and dirties a `profiles` heap page), the
per-player SELECT, then `COMMIT AND CHAIN`. Measured **1.98 events per
iteration** - that whole transaction bought about two events. Taking arrivals as
they dribble in is what makes the ratio that bad: a player whose second event
lands ten seconds after the first is drained twice, in two transactions. The
bloat shows where the bill landed:

- `profiles`: 1,599 live rows, 994 dead (**38.33%**), 2,134 pages for 17 MB,
  **autovacuumed 3,887 times**.
- `daily_challenge_event_outbox`: 323 live rows, 9,672 dead (**96.77%**), 453
  pages, **autovacuumed 4,993 times**, `relallvisible` 141 of 453.

### The change

A drain drains what was pending when it started. The picker gains
`o.created_at <= $1`, bound to the run's own entry instant - already in scope
with no new variable, because `v_deadline` is `clock_timestamp() + c_budget`,
so `v_deadline - c_budget` is that instant exactly.

Rolled-back probe, same shard, same minute, both terminating on an exhausted
picker:

| | iterations | events | booked | skipped | elapsed | events/iter |
| --- | --- | --- | --- | --- | --- | --- |
| as it ran | 155 | 307 | 307 | 0 | 2,875 ms | 1.98 |
| with the watermark | 198 | 577 | 577 | 0 | 6,443 ms | **2.91** |

47% more events per transaction is 47% fewer advisory locks, `profiles` tuple
locks and commits for the same events - and the run **ends** instead of running
to budget.

Nothing is stranded: `created_at` is the row's own creation instant, so a row
deferred by this run's watermark is at or before every later run's watermark,
and the jobs run every minute. A row backed off by the contention handler keeps
its original `created_at` and returns as soon as `next_attempt_at` allows.
Ordering, per-player serialisation, the 35-day dead-letter branch, the backoff
and the 5,000-row `p_limit` are untouched.

The cost is latency: an event arriving mid-run waits for the next minute's run
instead of joining the one in flight. Bounded by the one-minute schedule, on a
missions progress bar.

### How the migration is pinned

`20261003014941_the_outbox_drain_drains_what_was_pending.sql` is one
transaction with `lock_timeout = '2s'`, following the asserted-substitution
pattern of `20261001010106`. Both hashes are pinned and **neither needed a DDL
probe** (CLAUDE.md section 2 rule 3): `pg_get_functiondef` rebuilds the header
from `pg_proc` and emits `prosrc` verbatim, and this substitution only changes
text inside the body, so `md5(replace(live_def, old, new))` is the hash the
replaced procedure will report. Derived read-only:
`61635cfbedf05addc77a53c781963b68` -> `8d827eb13fb07f3d212ff3af839819f6`.
The transaction also requires the clause to occur exactly once, asserts the
reverse substitution reproduces the pinned text byte for byte, asserts owner,
`SECURITY` and grants did not move, and asserts the four per-minute `postgres`
shard jobs are still the only caller.

## Not changed, deliberately

No timeout (the `authenticator` 5 min and `service_role` 8 s settings of the
PGRST002 policy stand), no `lock_timeout` for any role, no grant, no schedule,
no index, nothing on the hand path, and `fn_ca_horse_claim_due`'s lock span. No
detector, sweep, repair job or reconciler was added (CLAUDE.md 10.11, 10.12);
the one change edits the line that produced the wrong outcome.

## Also measured, owned elsewhere, reported not touched

Background cron work on the primary in the hour to 01:28 UTC, beyond the drain's
3,298 s:

| job | runs | total s | note |
| --- | --- | --- | --- |
| `ca-cash-pot-conservation-hourly` | 1 | 600.0 | hit its 600 s `statement_timeout` and failed |
| `ca-stats-witness-audit-15m` | 4 | 555.5 | max 259.8 s |
| `ca-conservation-sweep-hourly` | 1 | 376.1 | |
| `ca-horse-claim-due-minute` | 60 | 350.7 | holds the same per-player key the drain wants |
| `ca-ratchet-watch-hourly` | 1 | 310.5 | failed |
| `rake-bbj-invariant-audit-hourly` | 1 | 286.4 | |
| `sp_prune_hand_history_10m` | 6 | 230.4 | |
| `hand-history-compact-vacuum` | 6 | 201.7 | |

Those audits total roughly another 1.9 cores of primary time per hour. They are
existing nets, several of them already timing out, and shrinking or moving them
is a separate piece of work with its own owner - not folded into this repair.
