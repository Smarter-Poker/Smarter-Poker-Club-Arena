# A long outside snapshot does not stall the tables (2026-10-06)

Migration: `20261006170925_a_long_outside_snapshot_does_not_stall_the_tables` (owner approved 2026-10-07; see "Applying").
Law: `tests/a-long-outside-snapshot-does-not-stall-the-tables.law.test.ts`
(`docs/laws.d/a-long-outside-snapshot-does-not-stall-the-tables.md`).
Harness: `scripts/ci/test-a-long-outside-snapshot-does-not-stall-the-tables.py`.

## The incident, 06:09-06:19 UTC

When late registration closed on the "Midnight Free Buy" (346 players) and the
"$100 Freeroll 12:00 AM" (359), both run by Midway Union, hand settlement
stopped keeping up. In 06:00-06:22 the logs recorded 1,069 statement timeouts
and 272 lock timeouts. `fn_ca_commit_hand_submission` averaged 130-150 ms before
06:00, then 4.1 s, 8.8 s, 5.6 s and 7.1 s at 06:10-06:13 with 125-311 HTTP 5xx a
minute. It was back to 389 ms at 06:19 and 132 ms at 06:20.
`ClubArenaEngineKillStorm` fired at 06:12.

## What actually held things up

**The cause was an outside session, not late registration.** Supavisor logs
show a session-mode login as `postgres` at 05:46:46. Its application name was
`club-arena-isolated-recovery-01a10ca0`, it came from an outside address, and
its backend pid was 1953237. It was a full data export (pg_dump-shaped). The
Postgres log names pid 1953237 as the holder of `supabase_migrations.schema_migrations`
from 06:08 onward. Its last statement was `COPY public.cash_hand_participant_manifests
(...) TO stdout`, cancelled by the client at 06:19:13. The jam ended in that
same minute. The session's address matches the one that ran
`club-arena-isolated-recovery` logins at 05:43-06:39 and 14:04. That fits the
recovery-drill work recorded in `2026-10-06-recovery-configuration-and-drill-boundary.md`.

One snapshot held for 32 minutes pins the xmin horizon for the whole database,
so no update made after 05:46 could be cleaned up. Settlement rewrites the same
few rows every hand: `tournament_players.chips`, `table_seats.stack`, and the
single `clubs` row (Midway Union) that `fn_guard_retired_club_mutation` locks
`FOR KEY SHARE` once per row written. Every one of those versions stayed
visible to the pinned snapshot. Each lookup then had to walk a longer and
longer chain, much of it resolved through the MultiXact store
(`multixact_member_buffers` is 256 kB, with 640 M member block reads since the
04 Oct restart).

The evidence that this was slow reads and not lock waits:

| fact                                                                                                                                                                                                    | number                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| statement timeouts inside settlement (`fn_ca_settle_hand_stacks_absolute` lines 591, 579, 569, 229, 220; `..._before_lease_generation` lines 206, 102; the retired-club guard lines 114/120 under them) | 1,010 of 1,069                            |
| lock waits logged inside any of those statements                                                                                                                                                        | 0                                         |
| the line-579 count/array_agg on the Midnight Free Buy today, horizon not pinned                                                                                                                         | 12 ms                                     |
| lane waits on T(Midnight Free Buy), shared / exclusive                                                                                                                                                  | 299 / 47                                  |
| lane waits on T($100 Freeroll), shared / exclusive                                                                                                                                                      | 121 / 29                                  |
| longest lane wait acquired                                                                                                                                                                              | ~8 s (the service_role statement_timeout) |

The tournament lane (from 20261003230910) behaved as designed. Hand calls held
T(id) shared, but each one took seconds instead of milliseconds. An exclusive
authority (`fn_f06_discover_breaks`, eliminations, moves, rebuys,
`fn_publish_tournament_blind_level`) waited for those slow holders, and new
shared requests queued behind the waiting exclusive one. The other timeouts
and lock timeouts were downstream of the same slowness:

- the spin and seat-first `spin_bonus_pools FOR UPDATE` waits (on Midway's row);
- `fn_ensure_late_registration_capacity`'s `tournaments FOR UPDATE`;
- `tournament_launch_receipts` locks.

The export's table locks also queued three mgmt-api `schema_migrations` ALTERs
(06:08, 06:11, 06:18), and engine startup reads of `fn_ca_applied_migrations`
timed out behind them.

## Why late registration is not the cause

- 2026-10-04 06:00: the same two events closed late registration with 392 and
  389 players. 7 statement timeouts in 06:00-06:30.
- 2026-10-05 06:00: 348 and 359 players. 21 statement timeouts.
- 2026-10-06 11:57: the 397-player "$100 Freeroll 6:00 AM". None.
- 2026-10-05 22:12-22:35 had the same signature (lane waits, then settlement
  statement timeouts, then lock timeouts) with no late-registration close. The
  holders there were a psql `UPDATE public.tournaments ...` that ran 861,713 ms
  from 22:06:55, plus five `pg_dump` sessions from the owner's address between
  22:15 and 22:54.

No index is missing. The count uses `tournament_players_tournament_id_user_id_key`
(index-only scan). The triggers on `tournament_players` are cheap until the
version chains grow.

## Change

`public.fn_ca_bound_outside_snapshots(p_max_age interval DEFAULT '5 minutes')`
runs every minute from pg_cron (`ca-bound-outside-snapshots-1m`). It looks for
client backends that match all of these:

- the role is not a superuser, and is either `postgres` (or a member of it) or
  `supabase_read_only_user`;
- the session holds a snapshot or a transaction id;
- its transaction started more than `p_max_age` ago.

For each match it does one thing:

- a running statement is cancelled, so its transaction rolls back and the
  connection stays open;
- an idle-in-transaction session is terminated, because a cancel cannot reach
  it.

Each action is written to `smarter_private.ca_long_snapshot_cancellations`
(which has no foreign key) and to the server log as
`CA_OUTSIDE_SNAPSHOT_BOUNDED`.

These are spared:

- by application name: `pg_cron`, `mgmt-api`, `apply-recorded-migration`,
  `antigravity-sql-push:*`;
- by construction, because they are not postgres members: PostgREST
  (authenticator), the engine heartbeat login, and every superuser.

**Why five minutes.** The weekly accounting cron holds its horizon for 2-4
minutes every 5 minutes all day, and the tables keep up (7-21 timeouts per half
hour). Both jams began within minutes of the horizon being pinned. The longest
non-cron, non-applier postgres transaction in 48 hours was the 861 s psql
UPDATE, and that was itself one of the two causes.

**Why a schedule and not a setting.** The exporter and pg_cron log in as the
same role. A role-level `transaction_timeout` would kill the weekly close.
pg_dump zeroes `statement_timeout`, `lock_timeout` and
`idle_in_transaction_session_timeout` when it connects (read from the PG16
binary; PG17's also zeroes `transaction_timeout` per upstream, which was not
verified here). No GUC can bound an export. Only a signal from another backend
can.

No money moves and no money path changes. Chips are untouched. The function
takes no lock on a hot table.

## Proof

PG16 disposable cluster laid out like production: a superuser that is not
`postgres`, a non-superuser `postgres` holding `pg_signal_backend` and
`pg_read_all_stats`, and a stand-in for `cron.schedule`. The shipped file is
applied unchanged. 23 of 23 checks pass:

| case                                                                                                                                                      | result          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| applies as non-superuser postgres; one active every-minute job                                                                                            | ok              |
| no API role can execute it or read its log; bounds outside 1 s-30 min refused                                                                             | ok              |
| with an outside REPEATABLE READ snapshot open, VACUUM keeps all 200 dead versions of a hot row                                                            | ok (the defect) |
| one call cancels the exporter, terminates an idle holder, bounds the read-only reader                                                                     | ok              |
| after it, VACUUM removes every dead version                                                                                                               | ok              |
| pg_cron, mgmt-api, apply-recorded-migration, antigravity-sql-push, PostgREST, a superuser, a no-snapshot session and a younger transaction are left alone | ok              |
| one log row per action                                                                                                                                    | ok              |

`npx vitest run` for this law, `law-registry`, `no-band-aids`,
`migrationVersionUniqueness`, `a-retired-compensation-job-is-never-scheduled-again`
and `a-scheduled-job-does-only-the-work-it-finds`: 867 of 867 pass.

## Applying

**Approved by the owner on 2026-10-07 at 06:20 America/Chicago, verbatim: "EVERYTHING IS APPROVED. YES".**
`docs/agent-policy/HARDENING.md` requires task-specific instruction for new
scheduled functionality, and this is a one-minute job that can cancel an
interactive or dashboard session. Apply it outside the :50-:03
break window. It contains no row-lock clauses.

Read back after install:

```sql
SELECT (SELECT count(*) FROM cron.job WHERE jobname = 'ca-bound-outside-snapshots-1m' AND active AND schedule = '* * * * *') = 1 AS scheduled,
       to_regprocedure('public.fn_ca_bound_outside_snapshots(interval)') IS NOT NULL AS installed,
       NOT has_function_privilege('service_role', 'public.fn_ca_bound_outside_snapshots(interval)', 'EXECUTE') AS closed;
SELECT * FROM smarter_private.ca_long_snapshot_cancellations ORDER BY acted_at DESC LIMIT 20;
```

Whether or not it is approved, the operating rule stands. A full export, a
long psql statement or a dashboard query against production must not run while
tables deal. Exports belong on an isolated restored copy, which is
`docs/dr/RESTORE-RUNBOOK.md` scenario B step 3.

## Not done

- **No engine change.** The engine recovered once the snapshot was released.
  The PR 6286 and 6287 recovery work is unchanged.
- **The lane shape is unchanged.** Settlement and table breaks do share one
  tournament lane. But with the horizon free, the lane waits on 10-04 and 10-05
  at the same close were seconds, not minutes.
- **The per-row `clubs FOR KEY SHARE` in `fn_guard_retired_club_mutation` is
  unchanged.** It makes every hot write create a MultiXact on one club row,
  which multiplies the cost of a pinned horizon. Taking it once per statement,
  not once per row, is a separate change to a retirement safety guard and was
  not needed to stop this incident.
