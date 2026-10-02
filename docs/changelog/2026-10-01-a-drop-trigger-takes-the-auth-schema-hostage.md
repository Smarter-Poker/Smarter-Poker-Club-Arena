# A `DROP TRIGGER IF EXISTS` takes the auth schema hostage (2026-10-01)

**What happened.** The first apply of
`20261001160611_a_balance_never_moves_without_its_ledger_row.sql`
(`apply-merged-migration` run 36918874377, 20:04:43 UTC) died with `40P01
deadlock detected` after 6.3 s and rolled back. The server log shows the
applier acquiring `AccessExclusiveLock` on `public.club_members` after 2.9 s at
the head of a twelve-deep queue of live hand commits, then asking for
`AccessExclusiveLock` on `auth.users`, which fourteen live sessions held through
foreign-key checks; one of them (`fn_ca_process_hand_post_commit_obligations`,
waiting on `club_members` behind us) closed the cycle. Nothing in the file names
`auth.users`, and core Postgres takes only `ShareRowExclusiveLock` for `CREATE
TRIGGER` and `AccessShareLock` for a `DROP TRIGGER IF EXISTS` whose trigger is
absent (`REL_17_STABLE` `objectaddress.c:1437`, `trigger.c:211`).

**Cause, measured.** A rolled-back `DO` block on a cold table
(`venue_game_alerts`, 0 rows, 0 writes) read `pg_locks` for its own backend after
each statement:

| statement                                 | locks taken                                                                                                                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMMENT ON TABLE`                        | `ShareUpdateExclusiveLock` on the table                                                                                                                                                                                               |
| `CREATE TRIGGER`                          | `ShareRowExclusiveLock` on the table                                                                                                                                                                                                  |
| `CREATE CONSTRAINT TRIGGER`               | `ShareRowExclusiveLock` on the table                                                                                                                                                                                                  |
| `DROP TRIGGER IF EXISTS` (trigger absent) | `AccessExclusiveLock` on the table **and on all 24 tables in `supautils.drop_trigger_grants`** - every `auth.*`, `storage.*` and `realtime.*` table, `auth.users`, `auth.sessions`, `auth.refresh_tokens`, `storage.objects` included |
| `DROP POLICY IF EXISTS` (policy absent)   | lock timeout at 500 ms waiting for the same class of lock (`supautils.policy_grants`)                                                                                                                                                 |

Supabase's `supautils` hook lets `postgres` (not a superuser here) drop triggers
and policies on tables it does not own by locking the whole granted set, and it
does so on every `DROP TRIGGER`/`DROP POLICY` by that role, whether or not the
object exists, holding the locks until commit. Inside a migration that then
touches hot tables, that is a deadlock with the next hand commit, and while it
is held it stops every login, token refresh and storage read on the platform.

**Fix.** The fourteen `DROP TRIGGER IF EXISTS` lines are removed from the
migration (none of those triggers exists anywhere the file can be applied:
production read 19:59 UTC, zero; the CI harness starts empty; the applier
refuses an already-recorded version), and a `DO` block before section 6 refuses
by name if any of them is already present. The file still installs in one
transaction with the same triggers, the same refusal name and the same `observe`
mode; every law pin on it is unchanged.

**Rule for every later migration on this database.** Never write `DROP
TRIGGER` or `DROP POLICY` against a hot table while hands are being dealt. To
replace a trigger, `CREATE OR REPLACE TRIGGER` takes the ordinary
`ShareRowExclusiveLock`. The welcome-package apply that failed three times
today (`20261001154709`, `40P01` on `ShareRowExclusiveLock` of `clubs`) is the
ordinary multi-table ordering deadlock, not this hook; it is another agent's
file and is left to them.

## Addendum, 21:39 UTC: the seven locks are taken together

With the DROPs gone, the second apply (run 36929916516) took no
AccessExclusiveLock anywhere and still deadlocked - on `ShareRowExclusiveLock`
for `chip_ledger`, the seventh table, held by a 28-second tournament RPC that
needed one of the six tables `CREATE TRIGGER` had already locked one statement
at a time. That is the ordinary ordering deadlock (the welcome-package file hit
the same class three times today), and Postgres picks the victim by who
notices first, so a live hand commit is as likely to die as the migration.

The file now takes all seven `ShareRowExclusiveLock`s in one `LOCK TABLE`
statement before any DDL, under a 250 ms `lock_timeout`, inside a `DO` block
that rolls the partial set back on `lock_not_available` and tries again after
100 ms (at most 240 tries). Nothing ever waits on the migration for longer than
250 ms - under `deadlock_timeout` (1 s) - so no live transaction can be chosen
as a deadlock victim because of it, and the `CREATE TRIGGER` statements find
their locks already held. Same triggers, same refusal, same `observe` mode.
