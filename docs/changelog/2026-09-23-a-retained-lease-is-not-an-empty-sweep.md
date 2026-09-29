# A retained lease is not an empty sweep

2026-09-23. Forty-eight dead tournament leases, the oldest unrenewed for 47.6
hours, were being kept on purpose by an hourly job that had no way to say so.

## What was measured

Read from production at 2026-09-23 20:55 UTC:

| reading                                                     | value      |
| ----------------------------------------------------------- | ---------- |
| `engine_tournament_leases` rows                             | 423        |
| past the reaper's one-hour cutoff                           | 48         |
| oldest, `heartbeat_at` frozen at 2026-09-21 21:19:22 UTC    | 47.6 hours |
| retained by `f06_lease_has_pending_custody`                 | 48 of 48   |
| retained by an `f06_operations` row short of `acknowledged` | 48 of 48   |
| also retained by a permit still `reserved`                  | 13 of 48   |
| still naming the live instance `1-3846b8bb` as holder       | 48 of 48   |
| tournaments still `RUNNING`                                 | 48 of 48   |
| `engine_table_leases` past the cutoff                       | 0          |
| deleted by the hourly reaper in two days                    | 0          |
| said about it, anywhere                                     | nothing    |

## Why the holder is dead, and why the lease is kept

`GameServer.stopTournamentManagerIfOwned` releases a lease only inside
`if (stopped && leaseGeneration)`. A manager whose stop refuses - and
`stopOwnedTournamentManager` refuses while the manager still holds unresolved
F06 custody - keeps its slot, keeps its lease, and stops being heartbeated,
because `renewVerifiedTournamentManagerLeaseProofs` only batches managers that
still prove current lease authority. `heartbeat_tournament_leases_v4` then
refuses to renew anything older than 30 seconds, so the row freezes at the
second its manager died.

The reaper is the one thing that would have removed it at +1 hour, and since
migration 20260919024039 it deliberately does not:

```sql
IF NOT smarter_private.f06_lease_has_pending_custody(candidate.tournament_id,NULL) THEN
  DELETE FROM public.engine_tournament_leases ...
END IF;
```

**That rule is correct and is not changed here.** "Expired authority is not
disposable custody"; an unresolved original's evidence is not housekeeping's to
erase.

## What was actually defective

The `IF` has no `ELSE`, and the function's return shape has no word for a
retention. `RETURNS TABLE(table_leases_deleted, tournament_leases_deleted)`
means a pass that kept forty-eight dead leases and a pass with nothing to do
both return two zeroes - and `GameServer.reapDeadLeases` logs only a non-zero
deletion. Retention was folded into silence. That is the outcome CLAUDE.md
10.86 rule 1 exists to forbid, and it is why nobody noticed for two days.

## What changed

`supabase/migrations/20260923213812_a_retained_lease_is_not_an_empty_sweep.sql`
pins the exact installed body (md5 `7501ae6661f48127f91d85d1fb0c9c9f`) as its
precondition and gives the function three more output columns:
`table_leases_retained`, `tournament_leases_retained` and
`oldest_retained_seconds`. Both custody guards, both delete predicates, the
600-second age floor, `FOR UPDATE ... SKIP LOCKED` and the `NOWAIT` fence are
byte-identical. A row the call could not lock is NOT counted as retained: that
is a row it could not read, and calling it "kept" would be the same conflation
one level down.

`GameServer.reapDeadLeases` reads the three columns into
`leaseCustodyRetention`, publishes it on `/health` as `leaseCustodyRetained`,
and logs what was kept and how old the oldest is. **A reaper that does not
publish the counts leaves the field null, which is UNKNOWN and is not zero** -
reporting a predecessor's silence as a clean board is the defect itself.

## What this does NOT do

It does not reclaim a lease, it does not delete one, it does not repair
anything, and it is not a cron, a sweep or a back-pay job. The forty-eight dead
rows are reclaimed by a successor engine through
`claim_tournament_lease_v2`'s stale-takeover clause, which was verified
available for all forty-eight on the same reading:
`smarter_private.f06_generation_aborted` answered false for a fresh generation
on every one of them, so a new instance takes each over with a new generation.

The reason no successor has come is the subject of the other change shipped
today: the engine could not be replaced at all. See
`docs/changelog/2026-09-23-the-fix-for-the-wedge-was-behind-the-wedge.md`.
The unresolved F06 custody that refuses the stop, that retains the lease, and
that held the restart certificate shut is one cause with three faces.

## Applied and verified in production

Applied at 2026-09-23 22:04 UTC, outside the :50-:03 break window, in one
transaction, recorded in `supabase_migrations.schema_migrations` as
`20260923213812`. After the apply, read back from `pg_proc`:

```
returns  TABLE(table_leases_deleted integer, tournament_leases_deleted integer,
               table_leases_retained integer, tournament_leases_retained integer,
               oldest_retained_seconds integer)
owner    postgres
config   {search_path=public}
acl      {postgres=X/postgres,service_role=X/postgres}
```

Owner, search path and grants are unchanged. A read-only rehearsal of the new
counters against the live table, without calling the function (it deletes, and
the engine's own hourly tick is when it should run):

```
would_report_tournaments_retained         48
would_report_tournaments_deleted           0
would_report_oldest_retained_seconds  175499   (48.7 hours)
```

That is the silence of the last two days, with a number on it.

## Pins, and the mutation test

`server/src/F06LeaseReaperOwnership.test.ts`, six mutations against 10 tests:

| mutation                             | red |
| ------------------------------------ | --- |
| an absent count reads as zero        | 1   |
| the retention is kept silent         | 1   |
| an increment escapes its ELSE branch | 1   |
| the preimage pin dropped             | 1   |
| a custody guard inverted             | 1   |
| the lock-skip branch starts counting | 3   |

Baseline 10 of 10 green.
