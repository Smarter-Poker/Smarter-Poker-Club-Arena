# 2026-09-10 - the database refuses migrations inside the break window

## What happened

Every hour the platform stands still on a schedule (CLAUDE.md section 13): at
:53 the engine announces the break (`fn_save_engine_maintenance_break`, under
`pg_advisory_xact_lock(530090,1)`), at :55 every table is parked, at ~:57-:58
the deploy restarts the engine, at :00 `fn_thaw_platform` gives the frozen
minutes back and the fleet resumes in waves, at :12 pg_cron grades the break.

Agents kept applying migrations inside that window. Every DDL statement fires
`pgrst_ddl_watch`, PostgREST reloads its whole schema cache (~28 s on this
database), and the DDL holds its locks until it commits. At 23:52:36 UTC on
2026-09-09 a migration landed on top of the :53 announcement, the announcement
failed, and the 00:00 break was cancelled. `ca_ddl_events` shows it was not a
one-off: over ten days, 3,577 reload-triggering statements from `mgmt-api`
alone committed inside :50-:03, plus 135 `CREATE INDEX` and 6 `CREATE POLICY`.

## What changed

The database refuses it now. Two migrations, both applied to production
outside the window (15:44:46 and 16:08:41 UTC):

- `20260910154446_the_database_refuses_migrations_inside_the_break_window`
  - `fn_ca_break_window_refuses_migrations(p_at)`: the window as a pure
    function. NULL when allowed, the reason when not. Minute-of-hour
    [:50, :03) UTC.
  - `fn_ca_break_window_governs(role, application)`: which sessions it applies
    to. A LOGIN role (`session_user`) that is `postgres` or a non-superuser
    member of it, and not `pg_cron`.
  - `fn_ca_break_window_ddl_guard()` on two event triggers,
    `ca_break_window_refuses_ddl` (ddl_command_end) and
    `ca_break_window_refuses_drops` (sql_drop). Inside the window it aborts any
    non-temporary DDL from a governed session. Fails open on its own error.
  - `ca_break_window_migration_overrides`: one row per transaction that used
    the emergency override, with its reason.
- `20260910160841_the_break_window_refusal_names_its_rule_and_explains_list_migrations`
  corrects the refusal's HINT, from what the first window taught: it cited
  "rule 7" (already the 2026-09-08 probe rule; the break-window rule is 8),
  and a refused `list_migrations` is now told what it hit and how to read the
  history without DDL (below).

What a refused agent sees:

    ERROR:  migration refused: 15:52:10 UTC is inside the hourly maintenance break
            window (:50-:03 UTC); apply after :03, or for an emergency fix SET LOCAL
            ca.break_window_migration_override = '<reason>' in the same transaction
    DETAIL: CREATE FUNCTION public.x() was refused and nothing in this transaction
            was applied (login role postgres, application mgmt-api). ...
    HINT:   Apply it once after :03 UTC (never in a retry loop). ...

The emergency override is `SET LOCAL ca.break_window_migration_override =
'<why this cannot wait>'` right after `BEGIN;`. A blank value or a switch
(`on`, `true`, `1`, ...) is refused; it is honoured for that one transaction
(the in-force marker is the transaction id, and a session-level SET is consumed
by the first transaction that uses it, so a pooled connection cannot carry it
into somebody else's migration); every use is recorded with its reason.

## Why an event trigger, and not a trigger on schema_migrations

The obvious guard is a BEFORE INSERT trigger on
`supabase_migrations.schema_migrations`. Measured on production, it would have
been worse than nothing. Comparing the `xmin` of each history row with the
`xmin` of the catalog rows its own migration wrote:

| migration text                       | examples                                                                                           | catalog xmin vs history xmin                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| no BEGIN/COMMIT                      | 20260910051447 (6 pg_proc + 10 pg_class), 20260910035435 (9 pg_proc), 20260910062308               | **equal**: one transaction                     |
| BEGIN/COMMIT (what this repo writes) | 40+ checked, e.g. 20260910145833 (381901597 vs 381901600), 20260910143719 (381583631 vs 381583679) | catalog 3 to 2,359 xids **lower**, never equal |

The postgres log shows the management API's whole statement: `begin; --
apply sql from post body <your sql>; -- track statements in history table
insert into supabase_migrations.schema_migrations ... values
(to_char(current_timestamp, 'YYYYMMDDHH24MISS'), ...); commit;`, one query
string. A migration's own COMMIT ends that transaction, so the history INSERT
runs in a new one (and the version it records is the time it ran, which is why
these files were renamed after applying). For every migration written the way this repo requires, a
schema_migrations trigger would fire after the DDL committed and after
PostgREST was told to reload: it would prevent nothing, and leave the
migration applied but unrecorded, which invites a retry.

An event trigger runs inside the DDL statement's own transaction. When it
raises, the transaction aborts: nothing is kept, the NOTIFY `pgrst_ddl_watch`
queued is discarded, the locks go, and no history row is written, whatever
tool sent the SQL.

## Its first window: two refusals, both `list_migrations`

Between 15:50 and 16:03 UTC the guard refused twice (postgres logs,
sql_state 55000, 15:58:04 and 16:02:40), and `ca_ddl_events` shows nothing
committed in the window but pg_cron's `REFRESH MATERIALIZED VIEW` (5 times,
allowed). Neither refusal was a migration body. Both were the Supabase MCP
(`-- source: POST /mcp`) preparing the history table it reads:

    begin;
    create schema if not exists supabase_migrations;
    create table if not exists supabase_migrations.schema_migrations (...);
    alter table supabase_migrations.schema_migrations add column if not exists statements text[];
    ... four more add column if not exists ...
    commit;

The MCP sends that before `list_migrations` as well as before
`apply_migration`. The five ALTERs change nothing, but each is reported as an
ALTER TABLE, so **every `list_migrations` call reloads PostgREST's whole schema
cache**. `ca_ddl_events`: 1,389 of these bootstraps from `mgmt-api` between
2026-08-31 and 2026-09-10, about 140 a day, 334 inside :50-:03. That is a
reload source nobody had counted, and inside the window it is exactly what the
guard exists to stop, so it stays refused there. Outside the window nothing can
stop it from the database side (the bootstrap is Supabase's), so CLAUDE.md
rule 8 now says: to see what is applied, `SELECT version, name FROM
supabase_migrations.schema_migrations` through `execute_sql`, which reads the
same history with no DDL.

## Who it governs, and why that scope

`ca_ddl_events` (every non-temporary DDL statement since 2026-08-31, with its
application_name): inside :50-:03, every statement from `mgmt-api`,
`Supavisor`, `psql`, the empty name, `chip-std-migrate` and
`chip-std-migrate-split` was an agent's migration. All log in as `postgres`;
the Supabase CLI logs in as `cli_login_postgres`, a member of `postgres`.

Never refused:

- **pg_cron**: its only DDL is `REFRESH MATERIALIZED VIEW` from
  `fn_refresh_active_poker_locations`, 330 times inside the window in three
  days;
- **Supabase's own roles** (`supabase_admin` is a superuser; `supabase_auth_admin`,
  `supabase_storage_admin` and the rest are not members of `postgres`);
- **PostgREST** (`authenticator`): the engine and browsers;
- **temporary objects**, from anyone: probes build their fixtures in `pg_temp`.

Nothing automated applies migrations (no workflow or script here or in the
World Hub does; `applied-migrations-recorded.yml` only reads), so nothing had
to be taught to wait. The refusal says when to come back.

The guard refuses every non-temporary DDL command, not only the tags
`pgrst_ddl_watch` reloads on, because `CREATE INDEX` (SHARE lock) and `CREATE
POLICY` (ACCESS EXCLUSIVE) block writers until commit, and the thaw writes.

## Known limits

- The clock is read at each DDL statement, not at COMMIT. A transaction whose
  last DDL ran at :49:59 and commits later is not caught; the three minutes
  between :50 and :53 are that slack.
- It fails open on its own internal error (WARNING, command proceeds): it sits
  on every DDL statement in a database shared with Supabase's services and the
  World Hub.
- World Hub agents apply migrations to the same database and will get the same
  refusal. The message is self-contained; the World Hub CLAUDE.md does not yet
  mention the window.

## Proof

- `bash scripts/dev/probe-break-window-ddl-guard-pg17.sh` applies both
  migrations to a throwaway PG17 cluster with production's roles and drives the
  real event triggers: 38 checks, covering refusal through every migration
  path, a BEGIN/COMMIT migration rolled back whole (DML included), CREATE
  INDEX, GRANT, DROP via sql_drop, hand-run REFRESH, the MCP history bootstrap
  (with its own HINT); temp objects, pg_cron, `supabase_auth_admin`, the
  superuser and PostgREST allowed; the override (honoured for its whole
  transaction, one record, switch and blank refused, forged marker refused,
  session-level SET consumed); fail-open.
- Production, live: the two refusals above, and nothing but pg_cron committed
  DDL inside its first window.
- Production, by plain SELECT: `fn_ca_break_window_refuses_migrations` returns
  NULL at 14:49:59 and 15:03:00, a refusal at 14:50:00, 14:53:00, 14:59:59,
  15:00:00, 15:02:59 and at 23:52:36 (the incident). `fn_ca_break_window_governs`
  is true for postgres (mgmt-api, psql, Supavisor, empty) and
  cli_login_postgres, false for pg_cron, supabase_admin, supabase_auth_admin,
  supabase_storage_admin, authenticator and service_role. Both event triggers
  are installed, enabled (`O`) and point at the guard.
- No live DDL probe was run: an INSERT into schema_migrations does not reach
  this guard by design, and a DDL probe against production is forbidden
  (section 2 rule 3). The two real refusals made one unnecessary.
- Both migrations confirm the xmin finding on themselves: catalog 382725732 vs
  history 382726380, and guard 383040659 vs history 383040675.

## Pinned

`tests/the-break-clocks-agree.law.test.ts` now pins the window at :50/:03 UTC,
at least three minutes before the :53 announcement and at least two after the
:00 thaw (past the last resume wave), both event triggers, the pg_cron / temp /
login-role scope, CLAUDE.md and the SQL naming the same override, and the
refusal citing the CLAUDE.md rule number the break-window rule actually has.
CLAUDE.md "Production DDL policy" rule 8 is the written rule.
