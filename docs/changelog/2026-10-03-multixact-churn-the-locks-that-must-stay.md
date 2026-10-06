# Multixact SLRU churn: where it comes from, and the lock that must stay

2026-10-03. Production `kuklfnapbkmacvwxktbh`, PG 17.6.1, `shared_buffers` 8 GB.

The primary is starving on multixact SLRU contention. This entry records what
was MEASURED, so the next agent does not re-derive it, and so nobody removes
the one lock that looks redundant and is not.

## The shape of the problem

`multixact_member_buffers` = 32 blocks and `multixact_offset_buffers` = 16,
both `source=default`, both at their hard-coded `boot_val`. PG 17 auto-sizes
`transaction_buffers`, `subtransaction_buffers` and `commit_timestamp_buffers`
from `shared_buffers` (all three sit at 1024 and miss 0.02%) and does NOT
auto-size multixact. `ALTER SYSTEM` returns `42501`; neither GUC is on
Supabase's 24-parameter override allowlist. The knob is closed.

So the only lever available in this repo is the churn that fills it.

## Baseline, and why a single before/after proves nothing

Three 20-second samples, `pg_stat_clear_snapshot()` between reads (without it
the delta is a silent zero):

| sample | member reads/s | member miss | offset reads/s | offset miss | multixacts/s | members/s |
| ------ | -------------- | ----------- | -------------- | ----------- | ------------ | --------- |
| 1      | 2,404          | 16.67%      | 1,387          | 9.63%       | 307          | 736       |
| 2      | 10,794         | 49.96%      | 9,690          | 44.85%      | 205          | 2,863     |
| 3      | 10,683         | 53.83%      | 9,240          | 46.58%      | 717          | 9,489     |

Earlier samples in the same hour ran to 64.40% miss at 7,084 reads/s and down
to 17.67% at 4,370 reads/s. **The workload swings more than fourfold within
minutes.** Any change worth under about 30% cannot be demonstrated by
sampling production before and after. Say so rather than claiming a win.

Creation rate is derived from `blks_zeroed`, which is the only live counter
for it: an offset page holds 2048 offsets, a member page 1636 members.
`pg_control_checkpoint()` is useless here because it only advances at a
checkpoint.

## The ratio is the finding

At 205 to 717 multixacts created per second against roughly 11,000 member
lookups per second, each multixact is examined on the order of 50 times
before it stops mattering. The cost is dominated by EXAMINING tuples that
already carry a multixact `xmax`, not by creating new ones.

## Which relations actually carry them (measured, with a control)

`pageinspect` is not installed, and installing an extension to probe
production is the DDL probe section 2 rule 3 forbids. So attribution was
measured behaviourally instead: sample the SLRU read rate idle, then sample
it again for the same duration while scanning one table in a tight loop, and
attribute the excess.

| table                    | rows  | member reads per scan | per row scanned |
| ------------------------ | ----- | --------------------- | --------------- |
| `public.clubs`           | 8     | 2.17                  | **0.271**       |
| `public.club_members`    | many  | 90.4                  | -               |
| `public.profiles`        | 1,684 | 8.19                  | 0.005           |
| `auth.users`             | 1,688 | 7.84                  | 0.005           |
| `public.feature_pricing` | 68    | **0.00** (control)    | 0.000           |

The `feature_pricing` control is the one that makes the rest trustworthy:
20,000 scans of it added nothing at all. That also confirms the 5,382 ms this
2-page, all-visible config table took is collateral damage from the global
SLRU lock, not a property of the table.

`clubs` is the densest carrier by two orders of magnitude per row. Eight rows,
290,824 updates, and an FK target for `agent_commissions` (14.6 M rows) and
`chip_ledger` (8.6 M rows). Every writer to those children takes
`FOR KEY SHARE` on one of eight parent rows while those same rows are being
updated, so a multixact is present on essentially every one of them at all
times, and every reader of `clubs` pays to resolve it.

## VACUUM FREEZE does not help. Measured, not assumed.

`relminmxid_age` is 17 M to 34 M on the large tables and
`vacuum_multixact_freeze_min_age` is 5 M, which looks like a freezing gap.
It is not one. `VACUUM (FREEZE) public.profiles` was run and the attribution
probe re-run immediately: cost per scan did not improve.

A multixact `xmax` can only be replaced once its members are no longer
running. These rows are under continuous concurrent locking, so there is
always a live member and there is nothing freezable. Per-table
`vacuum_multixact_freeze_min_age` tuning would be cargo cult here. Do not
ship it.

## fn_lock_daily_mission_user: the row lock is LOAD-BEARING. Do not remove it.

The function takes `pg_advisory_xact_lock` on the player key and then

    PERFORM 1 FROM public.profiles WHERE id = p_user_id FOR NO KEY UPDATE;

It reads no column. All 18 callers go through it, and none of them updates
`profiles`. The hottest caller,
`fn_drain_daily_challenge_event_outbox_user`, has already taken the SAME
advisory key itself before calling it. So for mutual exclusion the row lock
is genuinely redundant, which is why it reads as removable, and roughly 620
tuple locks a minute on a 1,599-row hot table is a real multixact
contribution.

**It is still load-bearing, as a lock-ordering anchor.** The cycle it
prevents:

- `trg_daily_challenge_revision_from_diamonds` fires `AFTER UPDATE OF diamonds
ON public.profiles`, and `bump_daily_challenge_dashboard_revision` does an
  `INSERT ... ON CONFLICT (user_id) DO UPDATE` on
  `daily_challenge_dashboard_revisions`. That trigger does NOT take the daily
  missions mutex. So any money path that spends or awards diamonds holds
  `profiles(u)` and then acquires `revision(u)`.
- `get_daily_challenge_dashboard_v2_serialized_body`, which is the live
  dashboard path (`get_daily_challenge_dashboard_v3` delegates to v2), takes
  `revision(u)` with `FOR UPDATE` and then reads on.

Without the pre-lock a dashboard load would hold `revision(u)` and then want
`profiles(u)`, while a concurrent diamond spend holds `profiles(u)` and wants
`revision(u)`. That is a deadlock between a diamond spend and a dashboard
load for the same player. The pre-lock forces every daily missions
transaction to take `profiles(u)` first, which is exactly what the
2026-09-06 migration comment means by "advisory player lock -> profile ->
subsystem rows -> revision cursor".

`FOR NO KEY UPDATE` is also already the minimal mode that works.
`FOR KEY SHARE` does not conflict with the `FOR NO KEY UPDATE` a diamonds
update takes, so the daily missions transaction would not block, would take
the revision row, and would deadlock on its own later upgrade.

The previous agent declined to remove this lock without finishing the
analysis. The analysis is finished and the answer is that it must stay.

Checked and cleared along the way: `cleanup_reserved_certification_account`
and `fn_sweep_test_account_after_audit_archive` look like they lock
`profiles` before touching `daily_challenge_*`, but their `FOR UPDATE` is on
`auth.users` and their `profiles` access is a plain `EXISTS`. The diamonds
trigger is already scoped as tightly as it can be
(`UPDATE OF diamonds ... WHEN (old.diamonds IS DISTINCT FROM new.diamonds)`).
`get_daily_challenge_dashboard` v1 is a pure read holding the mutex, but the
client only calls v3, so changing v1 buys nothing.

## What remains, honestly

The dominant producer is concurrent `FOR KEY SHARE` from foreign keys on
very low cardinality parents (`clubs` 8 rows, `auth.users` 1,688) driven by
tables with 11 M to 15 M inserts. Reaching it needs one of:

1. `multixact_member_buffers` and `multixact_offset_buffers`, which requires
   Supabase to add them to the override allowlist or set them directly. This
   is an upstream PG 17 gap, not a Supabase misconfiguration, and it is the
   only lever that addresses the bulk.
2. Foreign key changes on the hot parents, which remove a real guarantee to
   hide a symptom and are ruled out.

`auth.users` is owned by `supabase_auth_admin`, so even its storage
parameters are out of reach. `public.clubs`, `public.profiles` and
`public.club_members` are owned by `postgres`, but as shown above there is no
vacuum parameter on them worth setting.

No migration was shipped from this session, because every candidate was
either proven unsafe (the daily missions row lock) or proven ineffective
(freeze tuning), and shipping one anyway to show a diff would be the band aid
10.11 and 10.12 forbid.

## The harness

`scripts/dev/probe-multixact-slru.sql` holds the three probes used here,
single-call and bounded, with the traps written down: the per-transaction
stats snapshot, `blks_zeroed` as the only live creation counter, and the fact
that a `DO` block's `RAISE NOTICE` does not come back through the Supabase MCP
so a probe has to RETURN rows.

## Found on the way: public.clubs is 1300x bloated, and it is not a multixact fix

Not the multixact problem, but measured in the same session and worth a
maintenance window on its own.

`public.clubs` holds **5 live rows totalling 4.6 kB of data in 756 pages
(6,048 kB)**. With 5 rows the planner will always seqscan it, so every read
of the hottest configuration table in the database walks 756 pages to return
5 rows. It is the FK target of `agent_commissions` (14.6 M rows) and
`chip_ledger` (8.6 M), so a great many transactions touch it.

Normalised against its peers, it is alone in this:

| table                                        | pages | live rows | pages per live row |
| -------------------------------------------- | ----- | --------- | ------------------ |
| `public.clubs`                               | 756   | 5 to 10   | **75.60**          |
| `public.profiles`                            | 2,134 | 2,952     | 0.72               |
| `public.daily_challenge_dashboard_revisions` | 218   | 1,527     | 0.14               |
| `public.club_members`                        | 203   | 1,929     | 0.11               |
| `auth.users`                                 | 119   | 1,692     | 0.07               |
| `public.feature_pricing`                     | 2     | 68        | 0.03               |

`n_dead_tup` is 50 and autovacuum has run 2,647 times, so this is not dead
tuples. It is 290,824 updates worth of free space that plain VACUUM cannot
return, with the 5 live rows scattered across the page range so there are no
trailing empty pages to truncate. That is why 2,647 autovacuums have not
shrunk it.

**This would NOT reduce multixact lookups.** Those are per row, and there are
only 5 rows. It would cut the buffer traffic and the scan time of every
`clubs` read, which shortens the transactions that hold `FOR KEY SHARE` on
those rows, so the benefit to multixact pressure is indirect and second
order. Do not sell it as the fix.

**Do not VACUUM FULL it ad hoc.** It needs ACCESS EXCLUSIVE, and taking a
strong lock on a hot FK parent is the exact shape of the 2026-09-08
four-minute outage in section 2 rule 7: every writer to `clubs` queues behind
it. The actual rewrite is 4.6 kB and takes no time at all; the danger is
entirely the lock queue. The right place is inside the hourly :55 break,
where the platform is already frozen and nothing is writing money or seats,
with `lock_timeout` set so it abandons rather than queues. VACUUM FULL is not
DDL, so the `:50-:03` migration refusal does not apply to it.

Left alone this session. It is a maintenance-window job, not a multixact fix,
and this was a multixact investigation.
