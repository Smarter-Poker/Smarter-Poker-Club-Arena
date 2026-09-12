-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260911004421; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260911004421   (the stamp IS the apply time, UTC: 2026-09-11 00:44:21)
--   name        the_games_grants_say_what_they_mean
--   created_by  (not recorded)
--   statements  1 statement(s), 6207 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260911004421 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     DROP           FUNCTION public.fn_diamond_game_promo_lock
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- 20260911004421_the_games_grants_say_what_they_mean.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  THE DIAMOND GAMES' DOORS SAY WHO MAY KNOCK
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The 2026-09-11 audit read the ACLs rather than the grant statements, and
-- found that several of these doors are executable by PUBLIC, and so by anon:
--
--   fn_wheel_spin      =X/postgres  (that leading `=` is PUBLIC)
--   fn_plinko_drop     =X/postgres | anon=X/postgres
--   fn_crash_start, fn_wheel_commit, fn_wheel_state, fn_wheel_history,
--   fn_wheel_metrics, fn_wheel_set_config: the same.
--
-- Postgres grants EXECUTE to PUBLIC by default on CREATE FUNCTION, and a
-- migration that only ever GRANTs never takes that away. The platform's
-- autorevoke event trigger strips it from anything created after it, which is
-- why the doors written this week are clean and the ones written before it are
-- not.
--
-- NOTHING WAS REACHABLE. Every one of these refuses a caller with no account
-- on its own terms - "Sign In To Spin", a can-operate check, or a WHERE
-- user_id = auth.uid() that matches nothing when auth.uid() is NULL - which is
-- why this is a tightening and not an incident. It is worth doing anyway, and
-- not only for tidiness: check-definer-authorization exists precisely to stop
-- a SECURITY DEFINER function a browser can reach without an account, it
-- blocked this branch for exactly that shape two hours ago, and it can only
-- see the migrations in a diff. The shape it was built to catch was sitting in
-- the ACLs of the doors either side of the one it caught.
--
-- WHAT IS DELIBERATELY LEFT OPEN. fn_crash_point_cents, fn_crash_multiplier_cents,
-- fn_plinko_table_audit, fn_wheel_segments_audit and fn_wheel_host are pure
-- functions over public inputs: they are how a player verifies a round they
-- were shown, and a verifier that needs an account is not a verifier. They
-- read no identity and return nothing about anybody.
--
-- Also retires fn_diamond_game_promo_lock, superseded by
-- fn_diamond_game_cover_lock when the bank came in behind the promo wallet.
-- Nothing calls it.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ── 1. the doors that read who is calling are not open to nobody ──────────

REVOKE ALL ON FUNCTION public.fn_wheel_spin(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_plinko_drop(uuid, uuid, text, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_crash_start(uuid, uuid, text, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_wheel_commit() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_wheel_state(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_wheel_history(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_wheel_metrics(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_wheel_set_config(uuid, jsonb) FROM PUBLIC, anon;

-- Restated, because REVOKE ALL takes the grant these roles are meant to keep
-- along with the one they are not.
GRANT EXECUTE ON FUNCTION public.fn_wheel_spin(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_plinko_drop(uuid, uuid, text, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_crash_start(uuid, uuid, text, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_wheel_commit() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_wheel_state(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_wheel_history(uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_wheel_metrics(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_wheel_set_config(uuid, jsonb) TO authenticated, service_role;

-- ── 2. the lock the cover lock replaced ───────────────────────────────────
DROP FUNCTION IF EXISTS public.fn_diamond_game_promo_lock(uuid, text);

-- ── 3. the migration refuses to commit unless it did what it says ────────

DO $$
DECLARE v_name text; v_open text[] := '{}';
BEGIN
  FOR v_name IN SELECT unnest(ARRAY[
      'fn_wheel_spin', 'fn_plinko_drop', 'fn_crash_start', 'fn_wheel_commit',
      'fn_wheel_state', 'fn_wheel_history', 'fn_wheel_metrics', 'fn_wheel_set_config'])
  LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = v_name
                  AND has_function_privilege('anon', p.oid, 'EXECUTE')) THEN
      v_open := v_open || v_name;
    END IF;
    -- And the role that is meant to reach it still can.
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = v_name
                      AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) THEN
      RAISE EXCEPTION 'the grants say what they mean: % lost its grant to authenticated', v_name;
    END IF;
  END LOOP;
  IF array_length(v_open, 1) > 0 THEN
    RAISE EXCEPTION 'the grants say what they mean: % is still executable by anon', array_to_string(v_open, ', ');
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'fn_diamond_game_promo_lock') THEN
    RAISE EXCEPTION 'fn_diamond_game_promo_lock is still here';
  END IF;

  -- The verifier stays open on purpose; if this ever fails, somebody closed a
  -- door that is supposed to answer a player who is not signed in.
  IF NOT has_function_privilege('anon', 'public.fn_crash_point_cents(numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the fairness verifier is no longer reachable without an account';
  END IF;
END $$;

COMMIT;
