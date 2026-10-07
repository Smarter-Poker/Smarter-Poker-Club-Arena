-- 20261006170925_a_long_outside_snapshot_does_not_stall_the_tables.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A LONG OUTSIDE SNAPSHOT DOES NOT STALL THE TABLES. Full account:
-- docs/changelog/2026-10-06-a-long-outside-snapshot-does-not-stall-the-tables.md.
--
-- WHAT HAPPENED (production logs, 2026-10-06; every number below was read,
-- not estimated)
--
-- 05:46:46 UTC a session logged in as `postgres` through Supavisor (session
-- mode, application "club-arena-isolated-recovery-01a10ca0", an outside
-- address, backend pid 1953237) and began a full data export: it held
-- ACCESS SHARE on supabase_migrations.schema_migrations from at least 06:08
-- and was still running `COPY public.cash_hand_participant_manifests (...)
-- TO stdout` when it was cancelled at 06:19:13 ("canceling statement due to
-- user request"). One REPEATABLE READ snapshot, held for 32 minutes, pinned
-- the xmin horizon for the whole database.
--
-- With the horizon pinned nothing the tables write can be pruned. The hot rows
-- (tournament_players chips, table_seats stacks, the one clubs row that owns
-- all three big tournaments, "Midway Union") collect a version per hand, and
-- each superseded version carries a MultiXact xmax from the per-row
-- `clubs ... FOR KEY SHARE` in fn_guard_retired_club_mutation. Every visibility
-- check walks that chain through the MultiXact SLRU (multixact_member_buffers
-- is 256kB; 640M member block reads since 2026-10-04). Hand settlement became
-- CPU/IO-bound, NOT lock-bound:
--   - 1,010 of the 1,069 statement timeouts 06:00-06:22 are inside
--     fn_ca_settle_hand_stacks_absolute / ..._before_lease_generation: line 591
--     (the final-sync EXISTS, 292), line 579 (the count/array_agg, 225), line
--     206 (UPDATE tournament_players, 157), the retired-club guard's clubs
--     lookups (line 114 FOR KEY SHARE, line 120 EXISTS), all at the 8 s
--     service_role statement_timeout;
--   - ZERO lock waits were logged inside any of those statements;
--   - one sample of the same count today, with no pinned horizon: 12 ms.
-- Slow SHARED holders of each tournament lane T(id) then made the EXCLUSIVE
-- authorities (fn_f06_discover_breaks, eliminations, moves, rebuys,
-- fn_publish_tournament_blind_level, seat acquisition) queue, and new shared
-- requests queued behind the waiting exclusive one: 299 shared + 47 exclusive
-- waits on T(Midnight Free Buy), 121 + 29 on T($100 Freeroll), every one
-- capped near 8 s. fn_ca_commit_hand_submission averaged 130-150 ms before
-- 06:00, 4.1-8.8 s at 06:10-06:13 with 125-311 HTTP 5xx a minute, 389 ms at
-- 06:19 and 132 ms at 06:20: the jam ended the minute the export was cancelled.
-- The export's table locks also queued three mgmt-api schema_migrations ALTERs
-- (06:08, 06:11, 06:18), and engine startup reads of fn_ca_applied_migrations
-- timed out behind them (ClubArenaEngineKillStorm fired 06:12).
--
-- Late registration closing is NOT the cause. The same two events closed late
-- registration at 06:00 on 2026-10-04 (392 + 389 players) and 2026-10-05
-- (348 + 359) with 7 and 21 statement timeouts in 06:00-06:30; the 397-player
-- "$100 Freeroll 6:00 AM" closed at 11:57 today with none. The 2026-10-05
-- 22:12-22:35 jam had the same statement-timeout signature and the same cause:
-- a psql `UPDATE public.tournaments ...` that ran 861,713 ms from 22:06:55
-- plus five pg_dump runs from the owner's address between 22:15 and 22:54.
--
-- WHAT THIS DOES
--
-- periodic-work: bounding how long an outside session may hold a snapshot IS
-- the product. Postgres cannot express it declaratively here: the offending
-- sessions log in as the same role as pg_cron (postgres), whose own jobs run
-- for minutes by design, so a role-level transaction_timeout would kill the
-- weekly accounting close; and pg_dump zeroes statement_timeout, lock_timeout
-- and idle_in_transaction_session_timeout on connect (read from the PG16
-- binary; PG17's also zeroes transaction_timeout per upstream, not verified
-- here), so no GUC set at role, database or login level can bound an export.
-- Only a signal from another backend can. This repairs no data and compensates for no writer.
--
-- POLICY GATE (closed): docs/agent-policy/HARDENING.md requires explicit
-- task-specific owner instruction for new scheduled functionality. The owner,
-- Dan, gave it on 2026-10-07 at 06:20 America/Chicago, after being told
-- exactly what the one-minute job below does, verbatim:
-- "EVERYTHING IS APPROVED. YES". The reasons and the alternatives considered
-- are in the changelog.
--
-- Once a minute, public.fn_ca_bound_outside_snapshots() looks for client
-- backends that log in as postgres or a member of it, or as the dashboard's
-- supabase_read_only_user (never a superuser, so Supabase's own
-- supabase_admin work is never touched), hold a snapshot or a
-- transaction id, and whose transaction started more than five minutes ago.
-- pg_cron sessions and the migration appliers (mgmt-api, the dispatch-only
-- apply-recorded-migration installer and the owner's antigravity-sql-push:*
-- tool; migrations carry their own SET LOCAL statement_timeout, three of them
-- 840 s) are exempt by application name. PostgREST (authenticator),
-- the engine's lease heartbeat login and every other non-member role are
-- outside the filter by construction. A running statement is cancelled
-- (pg_cancel_backend: its transaction rolls back, the connection stays);
-- an idle-in-transaction session is terminated (a cancel cannot reach it).
-- Every action is written to smarter_private.ca_long_snapshot_cancellations
-- and to the server log. A full export must run against a restored copy,
-- not the primary while tables deal.
--
-- Why five minutes: both jams developed within minutes of the horizon being
-- pinned (2026-10-05: lane waits from 22:11, five minutes after the psql
-- UPDATE began; 2026-10-06: settlement slowing from 06:02 once hands resumed
-- after the :53-:00 break). The weekly accounting cron runs for 2-4 minutes
-- every 5 minutes all day and the tables kept up (7-21 timeouts per 30 min),
-- so a horizon held under five minutes is measured to be tolerated. The
-- longest non-cron, non-applier postgres transaction in the last 48 hours was
-- that 861 s psql UPDATE, which was itself one of the two causes.
--
-- No money moves and no money path changes. No hot-table lock is taken: the
-- function reads pg_stat_activity and writes only its own log table, which has
-- no foreign key. postgres holds pg_signal_backend and pg_read_all_stats
-- (read on production 2026-10-06) and cannot signal a superuser backend.
--
-- @live-proof: (SELECT count(*) = 1 FROM cron.job WHERE jobname = 'ca-bound-outside-snapshots-1m' AND active AND schedule = '* * * * *') AND to_regprocedure('public.fn_ca_bound_outside_snapshots(interval)') IS NOT NULL AND to_regclass('smarter_private.ca_long_snapshot_cancellations') IS NOT NULL

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS smarter_private.ca_long_snapshot_cancellations (
  id bigserial PRIMARY KEY,
  acted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  pid integer NOT NULL,
  role_name text NOT NULL,
  application_name text NOT NULL,
  client_addr inet,
  backend_start timestamptz,
  xact_start timestamptz NOT NULL,
  held interval NOT NULL,
  state text,
  action text NOT NULL CHECK (action IN ('cancel', 'terminate')),
  signalled boolean NOT NULL,
  query_head text
);

REVOKE ALL ON TABLE smarter_private.ca_long_snapshot_cancellations FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE smarter_private.ca_long_snapshot_cancellations_id_seq FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE smarter_private.ca_long_snapshot_cancellations IS
  'One row per outside session fn_ca_bound_outside_snapshots cancelled or terminated for holding a snapshot past its bound (20261006170925 a_long_outside_snapshot_does_not_stall_the_tables).';

CREATE OR REPLACE FUNCTION public.fn_ca_bound_outside_snapshots(p_max_age interval DEFAULT interval '5 minutes')
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public'
SET statement_timeout TO '20s'
AS $function$
DECLARE
  r record;
  v_action text;
  v_signalled boolean;
  v_acted jsonb := '[]'::jsonb;
BEGIN
  /* A LONG OUTSIDE SNAPSHOT DOES NOT STALL THE TABLES (2026-10-06). A
     snapshot held for 32 minutes by an export pinned the xmin horizon and
     stalled every tournament table's hand settlement. Outside sessions that
     log in as postgres (or a member of it, or supabase_read_only_user) may
     hold a snapshot for at most
     p_max_age; pg_cron and the migration appliers are exempt. */
  IF p_max_age IS NULL OR p_max_age < interval '1 second' OR p_max_age > interval '30 minutes' THEN
    RAISE EXCEPTION 'CA_SNAPSHOT_BOUND_OUT_OF_RANGE: %', p_max_age USING ERRCODE = '22023';
  END IF;

  FOR r IN
    SELECT a.pid,
           a.usename::text AS role_name,
           coalesce(a.application_name, '') AS app,
           a.client_addr,
           a.backend_start,
           a.xact_start,
           clock_timestamp() - a.xact_start AS held,
           a.state,
           left(coalesce(a.query, ''), 160) AS query_head
      FROM pg_stat_activity a
      JOIN pg_roles ro ON ro.oid = a.usesysid
     WHERE a.backend_type = 'client backend'
       AND a.pid <> pg_backend_pid()
       AND a.xact_start IS NOT NULL
       AND a.xact_start < clock_timestamp() - p_max_age
       AND (a.backend_xmin IS NOT NULL OR a.backend_xid IS NOT NULL)
       AND NOT ro.rolsuper
       AND (pg_has_role(ro.oid, 'postgres', 'MEMBER') OR ro.rolname = 'supabase_read_only_user')
       AND coalesce(a.application_name, '') NOT IN ('pg_cron', 'mgmt-api', 'apply-recorded-migration')
       AND coalesce(a.application_name, '') NOT LIKE 'antigravity-sql-push:%'
     ORDER BY a.xact_start, a.pid
  LOOP
    v_action := CASE WHEN r.state LIKE 'idle in transaction%' THEN 'terminate' ELSE 'cancel' END;
    v_signalled := CASE WHEN v_action = 'terminate' THEN pg_terminate_backend(r.pid)
                        ELSE pg_cancel_backend(r.pid) END;
    INSERT INTO smarter_private.ca_long_snapshot_cancellations
      (pid, role_name, application_name, client_addr, backend_start, xact_start, held, state, action, signalled, query_head)
    VALUES
      (r.pid, r.role_name, r.app, r.client_addr, r.backend_start, r.xact_start, r.held, r.state, v_action, v_signalled, r.query_head);
    RAISE LOG 'CA_OUTSIDE_SNAPSHOT_BOUNDED: % pid % (role %, application "%") held a snapshot for % (bound %)',
      v_action, r.pid, r.role_name, r.app, r.held, p_max_age;
    v_acted := v_acted || jsonb_build_object('pid', r.pid, 'application_name', r.app, 'action', v_action,
                                             'signalled', v_signalled, 'held', r.held::text);
  END LOOP;

  RETURN jsonb_build_object('bound', p_max_age::text, 'acted', jsonb_array_length(v_acted), 'sessions', v_acted);
END
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_bound_outside_snapshots(interval) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.fn_ca_bound_outside_snapshots(interval) IS
  'Cancels (or, when idle in transaction, terminates) a non-superuser postgres-member or supabase_read_only_user client session other than pg_cron and the migration appliers (mgmt-api, apply-recorded-migration, antigravity-sql-push:*) whose snapshot is older than p_max_age, and records it in smarter_private.ca_long_snapshot_cancellations (20261006170925 a_long_outside_snapshot_does_not_stall_the_tables).';

SELECT cron.schedule(
  'ca-bound-outside-snapshots-1m',
  '* * * * *',
  $cron$ SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-bound-outside-snapshots-1m'))
           THEN (SELECT public.fn_ca_bound_outside_snapshots()::text) ELSE 'skipped: overlap' END; $cron$
);

DO $assert$
BEGIN
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'ca-bound-outside-snapshots-1m' AND active) <> 1 THEN
    RAISE EXCEPTION 'ca-bound-outside-snapshots-1m is not scheduled exactly once';
  END IF;
  IF has_function_privilege('anon', 'public.fn_ca_bound_outside_snapshots(interval)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_bound_outside_snapshots(interval)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.fn_ca_bound_outside_snapshots(interval)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_ca_bound_outside_snapshots is executable by an API role';
  END IF;
  IF has_table_privilege('anon', 'smarter_private.ca_long_snapshot_cancellations', 'SELECT')
     OR has_table_privilege('authenticated', 'smarter_private.ca_long_snapshot_cancellations', 'SELECT')
     OR has_table_privilege('service_role', 'smarter_private.ca_long_snapshot_cancellations', 'SELECT') THEN
    RAISE EXCEPTION 'ca_long_snapshot_cancellations is readable by an API role';
  END IF;
END
$assert$;

COMMIT;
