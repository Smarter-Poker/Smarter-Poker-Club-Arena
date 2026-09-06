# The seat guard is armed

**2026-09-06.** `fn_ca_guard_seat_creation` stopped watching and started
refusing. Chips reach a `table_seats` row through the engine or through one of
five declared money paths, or they do not reach it at all.

Migration: `supabase/migrations/20260906102549_the_seat_guard_is_armed.sql`
(applied to production and stamped in `supabase_migrations.schema_migrations`
as version `20260906102549` before this branch was opened).
Law: `tests/theSeatGuardIsArmed.law.test.ts`, registered in
`docs/laws.d/tests-theSeatGuardIsArmed.md`.

## What it refuses

A `table_seats` row that APPEARS (INSERT with `left_at` NULL) or COMES BACK TO
LIFE (`left_at` NOT NULL -> NULL) carrying `stack > 0`, when the caller is
neither

- the engine - `fn_caller_is_engine()`: `service_role`, or a session with no
  JWT at all (psql, pg_cron, a migration) - nor
- a money RPC that has debited a wallet or a treasury and says so through
  `app.money_path`: `atomic_table_buyin`, `fn_take_seat_and_buy_in`,
  `fn_seat_horse_in_seat_first_game`, `fn_seat_late_registrant`,
  `fn_horse_seat_from_treasury`.

Anything else put chips on the felt without taking them from anywhere, which is
a mint.

It does not touch top-ups or add-ons. `v_creating` is deliberately scoped to a
seat ARRIVING; chips added to a seat already seated are a different control,
and the exit side of that control is `ca_seat_stack_exits` and
`fn_unaccounted_seat_exits` (CLAUDE.md 11.5).

## Why now: two quotes and one number

The guard was attached in DRY RUN form on 2026-09-02 under Dan's instruction of
that day:

> anything HIGH RISK for breaking live play is not enforced

and the dry-run body wrote its own arming condition into its comment:

> swap it back in only after `ca_seat_guard_dryrun` has stayed empty for 24
> hours

On 2026-09-06 Dan returned the decision:

> THIS IS ON YOU TO DECIDE

Decided: arm it. The condition was met by four orders of magnitude. Read on
production immediately before applying:

| measurement                           | value                                 |
| ------------------------------------- | ------------------------------------- |
| `trg_ca_guard_seat_creation`          | enabled (`tgenabled` = 'O')           |
| trigger definition                    | `BEFORE INSERT OR UPDATE OF left_at`  |
| seats created since the dry run began | 170,942                               |
| seats created in the last 24h         | 41,696, of which 14,542 carried chips |
| rows in `ca_seat_guard_dryrun`        | 0                                     |

**An empty log proves nothing on its own.** A disabled trigger writes no rows
either, and a guard that reads as armed while being unreachable is the exact
failure `aClosedTableOwnsNoMainIndex` was written about a day earlier. So the
trigger was read as enabled and the traffic through it was counted FIRST; the
zero is a zero out of 170,942 chances to be non-zero, not a zero out of none.

## Probed rolled back against production before applying

Four cases, one self-aborting `DO` block per CLAUDE.md 11.5 rule 1 (a
transaction does not span two Supabase MCP calls, so the probe ends by raising
and the raise is the success case):

1. a declared money path still seats normally - **passed**
2. **the engine, with no JWT at all, is never refused** - passed. This is the
   case that would have been a live outage rather than a bug report, and it is
   why `fn_caller_is_engine()` is consulted before the allowlist.
3. a zero-stack seat (a sit-out placeholder) is untouched - passed
4. an undeclared browser caller with 999 chips is REFUSED - passed:

   ```
   SEAT_NOT_FUNDED: chips may only reach a seat through the engine or a
   declared money path (path=none, jwt_role=authenticated, app=probe-browser,
   table=58b2c844-..., seat=10, stack=999.00)
   ```

A fifth case, looping all five sanctioned paths in one block, failed on the
probe's OWN seat-number collision rather than on the guard. Case 1 covers the
mechanism, and the migration's `$post$` block asserts all five path literals
survive the swap inside the same transaction that performs it, so the loop was
not re-run.

## The design correction: a refusal cannot log itself

The first draft of the armed body LOGGED the refusal into
`ca_seat_guard_dryrun` and then raised, so that a refused seat would name its
own caller in a queryable table. Probed rolled back, the log count went
**0 -> 0**.

**A RAISE inside a BEFORE trigger aborts the statement, and the trigger's own
INSERT is part of that statement, so the row never survives.** Persisting it
would need an autonomous transaction (dblink or pg_background), which is a lot
of new machinery in a money path for a record we already have.

So the logging was removed and the evidence now travels in the ERROR ITSELF -
declared path, JWT role, application name, table, seat, stack - which reaches
the caller AND the Postgres error log. That log is a proven surface: it is
where 10,577 FOUR TABLE LIMIT refusals were counted on 2026-09-06.

`tests/theSeatGuardIsArmed.law.test.ts` pins the absence of that INSERT and the
shape of the message, because the message is now the only place the evidence
exists. The migration's `$post$` block asserts the same thing in the database.

## Verified live, 20 seconds after arming

| measurement                          | value |
| ------------------------------------ | ----- |
| seats created in the following 2 min | 31    |
| of those, carrying chips             | 31    |
| all allowed                          | yes   |
| hands dealt in the same window       | 889   |
| players seated                       | 134   |
| controller tick errors               | 0     |
| rows in `ca_seat_guard_dryrun`       | 0     |

Every seat created in the first two minutes carried chips and every one was
allowed, which is the same population the dry run had been measuring.

## How to watch it

The Postgres error log, filtered to `SEAT_NOT_FUNDED`.

- **Any hit is a refused seat, and it names its own caller** - the declared
  path, the JWT role and the application name are in the message.
- **Silence is the guard working.** There is no table to check any more, and
  `ca_seat_guard_dryrun` staying at 0 no longer means anything about the armed
  guard: it is the dry run's evidence, kept so the guard can be re-pointed at
  it if it is ever put back into observation mode.

## How to undo it, in one statement

If a real seat creator turns out to be missing from the allowlist:

1. **Add the missing path to the allowlist.** This is the correct fix in almost
   every case - the caller genuinely moved money and simply never declared
   `app.money_path`. Confirm it debits a wallet or a treasury before adding it.
2. **Or re-apply the dry-run body.** It is the `CREATE OR REPLACE FUNCTION`
   block in
   `supabase/migrations/20260902174600_the_seat_guard_watches_before_it_refuses.sql`,
   which is stamped in the ledger under version `20260902184321` (the file name
   and the ledger version differ; grep the file name, not the version, or you
   will find nothing). Re-applying it returns the guard to observation mode
   without touching the trigger.

Either way the trigger itself is not touched. This migration replaced a
function body only: one transaction, no table lock, no trigger DDL, so it could
not deadlock against the cluster tick the way a `public.tables` trigger change
did on 2026-09-05.

## Two things left as they are, recorded so they are not mistaken for defects

**1. A stale sentence inside the shipped function body.** The armed body's own
block comment still says "It LOGS the refusal before raising it" - a leftover
from the first draft, contradicted by the code three lines below it, by the
migration header, and by this file. It is a comment in `prosrc`, so correcting
it means another `CREATE OR REPLACE` and therefore another ~28-second PostgREST
schema-cache reload during live play (CLAUDE.md section 2), which is not worth
buying on its own. **Fold the correction into the next change to this function,
whatever that change is.** Until then, the trap it sets is real and specific:
an agent who reads that sentence will go looking for refusals in
`ca_seat_guard_dryrun`, find it empty, and conclude the guard is not firing.
The section above says where to look instead.

**2. A ledger row whose file was never committed.** Version `20260904183500`,
`ca_the_seat_guard_sees_a_revived_seat`, is stamped in production and its
`statements` are a single comment pointing at
`supabase/migrations/20260904183500_ca_the_seat_guard_sees_a_revived_seat.sql`.
That file is not in this tree, not on `origin/main`, and `git log --all
--diff-filter=A` finds no commit on any ref that ever added it. The BEHAVIOUR
it names is not missing - the revival arm of `v_creating` is in the committed
`20260902174600` file and in the armed body, and this law pins it - but the
file is. Noted for the migration-ledger pass rather than repaired here.

## Files

- `supabase/migrations/20260906102549_the_seat_guard_is_armed.sql` (applied)
- `tests/theSeatGuardIsArmed.law.test.ts`
- `docs/laws.d/tests-theSeatGuardIsArmed.md`
- this file

Nothing was added to `scripts/ci/schema-manifest.d/`: the migration creates no
new object. It replaces the body of a function that already exists, and both
`fn_ca_guard_seat_creation` and `ca_seat_guard_dryrun` are already present in
`scripts/ci/supabase-schema-manifest.json`, so `check-migrations-applied.mjs`
resolves every name this migration declares against the base snapshot.
