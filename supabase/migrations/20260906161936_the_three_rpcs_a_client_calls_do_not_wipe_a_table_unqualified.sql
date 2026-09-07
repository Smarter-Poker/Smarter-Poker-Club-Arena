-- ═══════════════════════════════════════════════════════════════════════════
--  THE THREE RPCs SOMETHING ACTUALLY CALLS DO NOT WIPE A TABLE UNQUALIFIED
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Companion to `20260906161517_an_unqualified_delete_is_refused_where_the_
-- engine_calls_it`, which fixed the one I broke. Sweeping the schema for the
-- same shape found it is not one function. It is ten.
--
-- THE MECHANISM, stated once so nobody has to rediscover it. PostgREST
-- connects as `authenticator`:
--
--     select rolname, rolconfig from pg_roles where rolname='authenticator';
--     -> session_preload_libraries=safeupdate | statement_timeout=5min | ...
--
-- `safeupdate` is loaded per SESSION, at connect time, and raises
-- "DELETE requires a WHERE clause" on any UPDATE or DELETE without one. A
-- `SET ROLE service_role` afterwards does not unload it, so this catches
-- service_role RPCs too - which is exactly how it caught the engine's GTO
-- aggregation driver rather than a browser.
--
-- So an unqualified DELETE inside a function is legal SQL, legal plpgsql, and
-- works perfectly when a migration or pg_cron runs it as `postgres`. It fails
-- ONLY on the path a client or the engine uses. That asymmetry is why ten of
-- these have been sitting here: nothing that ran them noticed, because the
-- things that ran them were not going through PostgREST.
--
-- WHICH TEN, and what was done about each. Reachability is
-- has_function_privilege, callers are `.rpc('<name>'` in Club Arena's src/ and
-- server/src/ and the World Hub's pages/ src/ scripts/ on origin/main:
--
--   FIXED HERE - something calls them through PostgREST today:
--     fn_backfill_bomb_pot_award_units  service_role  server/src/GameServer.ts:2087
--     generate_period_settlements       authenticated src/services/SettlementService.ts, SettlementDashboardPage
--     fn_aggregate_gto_flop             service_role  the GTO aggregation family, same driver shape as v31
--
--   LEFT ALONE, deliberately, and recorded rather than quietly skipped:
--     fn_rake_spec_rebuild_caps            DELETE FROM public.ca_rake_schedule_caps;
--     fn_rebuild_agent_commission_rollup   DELETE FROM public.agent_commission_unsettled_rollup;
--     fn_rebuild_ca_club_commission_daily  DELETE FROM public.ca_club_commission_daily;
--     fn_ca_execute_epoch3_reset           DELETE FROM public.ca_treasury_baseline;  (+ a temp table)
--     fn_union_settle_player_pnl           DELETE FROM _pnl_tmp;
--     fn_renumber_duplicate_places         DELETE FROM _renum_plan;
--     fn_backfill_bomb_multi_winner_units  DELETE FROM zz_bomb_multi;
--
--   None of those has a `.rpc()` caller in either repo; the rebuilds run from
--   pg_cron as `postgres`, where safeupdate is not loaded, so they work today.
--   And the first four wipe a REAL table, not a temp one. Adding `where true`
--   to `DELETE FROM public.ca_treasury_baseline;` would not fix a defect - it
--   would remove the accident that currently stops a treasury-wide wipe from
--   being callable over the API at all. Making a dangerous function reachable
--   is not a repair. If one of them ever needs a client caller, the right
--   change is a scoped predicate written with the caller, not a blanket
--   `where true` added in advance by somebody who is not writing that caller.
--
-- WHY THE THREE ARE SAFE TO FIX. Every one of them deletes a TEMPORARY table
-- it created itself in the same call - `zz_backfill_units`, `_scope_clubs`,
-- `tmp_agg` - as the first step of a rebuild. `where true` is a no-op
-- predicate over exactly the same rows; it changes nothing but the parser's
-- opinion of the statement.
--
-- WHAT I COULD NOT TELL, said plainly rather than implied. I did not prove
-- that `generate_period_settlements` has been failing. `settlement_invoices`
-- has had no row since 2026-08-20 and `settlement_periods` none in seven
-- days, which is consistent with it failing AND with nobody having pressed
-- the button; `ca_settlements` is busy but is written by a different path.
-- The fix is a no-op predicate either way, so it does not need that answer -
-- but the changelog should not claim an outage I have not measured.
--
-- All three are patched IN PLACE from `pg_get_functiondef`, in ONE
-- transaction. One transaction is the production DDL policy in CLAUDE.md
-- section 2: Postgres coalesces the PostgREST schema-reload NOTIFYs inside a
-- transaction, so this is one ~28s reload rather than three.
--
-- THE CLASS is closed by `scripts/ci/check-unqualified-writes.mjs`, which
-- refuses a new one in any migration, so the next person does not need to
-- know that safeupdate exists.
--
-- ROLLBACK: none worth writing. The previous text is the broken one.

BEGIN;

DO $$
DECLARE
  v_target text;
  v_temp   text;
  v_def    text;
  v_new    text;
  v_hits   int;
  v_fixed  int := 0;
  -- function name -> the temp table whose unqualified DELETE is being qualified
  v_pairs  text[][] := ARRAY[
    ARRAY['fn_backfill_bomb_pot_award_units', 'zz_backfill_units'],
    ARRAY['generate_period_settlements',      '_scope_clubs'],
    ARRAY['fn_aggregate_gto_flop',            'tmp_agg']
  ];
  i int;
BEGIN
  FOR i IN 1 .. array_length(v_pairs, 1) LOOP
    v_target := v_pairs[i][1];
    v_temp   := v_pairs[i][2];

    SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_target
    LIMIT 1;

    IF v_def IS NULL THEN
      RAISE EXCEPTION '%() does not exist - re-read this migration before applying it', v_target;
    END IF;

    -- The temp table must be exactly the one named above. If a function has
    -- been rewritten since this was measured, do not guess at it.
    SELECT count(*) INTO v_hits
    FROM regexp_matches(v_def, 'delete\s+from\s+' || v_temp || '\s*;', 'gi');

    IF v_hits = 0 THEN
      RAISE NOTICE '%(): no unqualified `delete from %;` - already fixed or changed, skipping',
        v_target, v_temp;
      CONTINUE;
    END IF;
    IF v_hits > 1 THEN
      RAISE EXCEPTION '%(): % unqualified deletes of %, expected exactly one', v_target, v_hits, v_temp;
    END IF;

    -- It must be a TEMP table the function makes itself. This is the whole
    -- safety argument for the rewrite; if it is not there, stop.
    IF v_def !~* ('create\s+(?:local\s+|global\s+)?temp(?:orary)?\s+table\s+(?:if\s+not\s+exists\s+)?' || v_temp) THEN
      RAISE EXCEPTION
        '%(): % is not created as a temp table inside the function - refusing to qualify a delete against a table I have not read',
        v_target, v_temp;
    END IF;

    v_new := regexp_replace(
      v_def,
      'delete\s+from\s+' || v_temp || '\s*;',
      'delete from ' || v_temp || ' where true;',
      'gi'
    );

    IF v_new = v_def THEN
      RAISE EXCEPTION '%(): the rewrite changed nothing - refusing to report success for a no-op', v_target;
    END IF;

    EXECUTE v_new;
    v_fixed := v_fixed + 1;
  END LOOP;

  RAISE NOTICE 'qualified the unqualified temp-table delete in % function(s)', v_fixed;
END $$;

COMMIT;

-- ── POST-CHECKS ────────────────────────────────────────────────────────────
-- Their own transaction, so they read the functions as they now stand.
DO $$
DECLARE
  r        record;
  v_def    text;
  v_pairs  text[][] := ARRAY[
    ARRAY['fn_backfill_bomb_pot_award_units', 'zz_backfill_units'],
    ARRAY['generate_period_settlements',      '_scope_clubs'],
    ARRAY['fn_aggregate_gto_flop',            'tmp_agg']
  ];
  i int;
BEGIN
  FOR i IN 1 .. array_length(v_pairs, 1) LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_pairs[i][1]
    LIMIT 1;

    IF v_def ~* ('delete\s+from\s+' || v_pairs[i][2] || '\s*;') THEN
      RAISE EXCEPTION 'post-check: %() still holds an unqualified delete of %',
        v_pairs[i][1], v_pairs[i][2];
    END IF;
    IF v_def !~* ('delete\s+from\s+' || v_pairs[i][2] || '\s+where\s+true\s*;') THEN
      RAISE EXCEPTION 'post-check: %() does not hold the qualified delete of %',
        v_pairs[i][1], v_pairs[i][2];
    END IF;
  END LOOP;

  -- And the one this pair of migrations started from, so a later change to
  -- either file cannot leave that one behind.
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'fn_aggregate_gto_v31_next';
  IF v_def ~* 'delete\s+from\s+tmp_agg31\s*;' THEN
    RAISE EXCEPTION 'post-check: fn_aggregate_gto_v31_next regressed to an unqualified delete';
  END IF;

  RAISE NOTICE 'post-checks passed: every temp-table delete on a called RPC is qualified';
END $$;
