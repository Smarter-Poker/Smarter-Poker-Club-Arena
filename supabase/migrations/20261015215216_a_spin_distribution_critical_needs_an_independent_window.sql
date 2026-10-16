-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_spin_fairness_check(integer)'::regprocedure))='7124884d909fa278904c724a8f846f50')
-- 20261015215216_a_spin_distribution_critical_needs_an_independent_window.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

-- Statistical critical escalation needs a disjoint preceding window at
-- its own p<0.001 threshold. The existing warning confirmation is unchanged.
-- Off-ladder draws and |z|>4 expectation drift remain immediately critical.
-- A single unconfirmed crossing stays visible in the returned context.
-- This migration changes no draw, reserve, wallet, tier or alert row.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
DO $patch$
DECLARE sig regprocedure:='public.fn_spin_fairness_check(integer)'::regprocedure;
 def text:=pg_get_functiondef(sig); prior jsonb;
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL THEN RAISE EXCEPTION 'spin_confirmation_operator_refused'; END IF;
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL THEN RAISE EXCEPTION 'spin_confirmation_override_refused'; END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN RAISE EXCEPTION 'spin_confirmation_freeze_refused'; END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261015215216') THEN RAISE EXCEPTION 'spin_confirmation_replay_refused'; END IF;
 IF md5(def)<>'f481e023244f76359626544c661f9c0f' THEN RAISE EXCEPTION 'spin_confirmation_preimage_refused'; END IF;
 SELECT jsonb_build_array(proowner,prosecdef,provolatile,proconfig,proacl) INTO prior FROM pg_proc WHERE oid=sig;
 IF (length(def)-length(replace(def,$o$  v_prev_crit   numeric;
  v_confirmed   boolean := false;$o$,'')))/length($o$  v_prev_crit   numeric;
  v_confirmed   boolean := false;$o$)<>1 THEN RAISE EXCEPTION 'spin_confirmation_anchor_0_refused'; END IF;
 def:=replace(def,$o$  v_prev_crit   numeric;
  v_confirmed   boolean := false;$o$,$n$  v_prev_crit   numeric;
  v_prev_crit_001 numeric;
  v_confirmed   boolean := false;
  v_critical_confirmed boolean := false;$n$);
 IF (length(def)-length(replace(def,$o$        v_confirmed := v_prev_chi > v_prev_crit;$o$,'')))/length($o$        v_confirmed := v_prev_chi > v_prev_crit;$o$)<>1 THEN RAISE EXCEPTION 'spin_confirmation_anchor_1_refused'; END IF;
 def:=replace(def,$o$        v_confirmed := v_prev_chi > v_prev_crit;$o$,$n$        v_confirmed := v_prev_chi > v_prev_crit;
        -- The independent window must cross the same critical line, using
        -- its own pooled degrees of freedom. No overlapping observations.
        v_prev_crit_001 := (ARRAY[10.828, 13.816, 16.266, 18.467, 20.515,
                                  22.458, 24.322, 26.125])[LEAST(GREATEST(v_prev_cells - 1, 1), 8)];
        v_critical_confirmed := v_prev_chi > v_prev_crit_001;$n$);
 IF (length(def)-length(replace(def,$o$  ELSIF v_n >= 2000 AND v_chi > v_crit_001 THEN$o$,'')))/length($o$  ELSIF v_n >= 2000 AND v_chi > v_crit_001 THEN$o$)<>1 THEN RAISE EXCEPTION 'spin_confirmation_anchor_2_refused'; END IF;
 def:=replace(def,$o$  ELSIF v_n >= 2000 AND v_chi > v_crit_001 THEN$o$,$n$  ELSIF v_n >= 2000 AND v_chi > v_crit_001 AND v_critical_confirmed THEN$n$);
 IF (length(def)-length(replace(def,$o$    'prior_window_confirms',   v_confirmed,$o$,'')))/length($o$    'prior_window_confirms',   v_confirmed,$o$)<>1 THEN RAISE EXCEPTION 'spin_confirmation_anchor_3_refused'; END IF;
 def:=replace(def,$o$    'prior_window_confirms',   v_confirmed,$o$,$n$    'prior_window_confirms',   v_confirmed,
    'prior_window_crit_p001',   v_prev_crit_001,
    'prior_window_confirms_critical', v_critical_confirmed,
    'current_window_critical', COALESCE(v_n >= 2000 AND v_chi > v_crit_001, false),$n$);
 EXECUTE def;
 IF md5(pg_get_functiondef(sig))<>'7124884d909fa278904c724a8f846f50' THEN RAISE EXCEPTION 'spin_confirmation_postimage_refused'; END IF;
 IF (SELECT jsonb_build_array(proowner,prosecdef,provolatile,proconfig,proacl) FROM pg_proc WHERE oid=sig) IS DISTINCT FROM prior THEN RAISE EXCEPTION 'spin_confirmation_security_refused'; END IF;
END $patch$;
COMMIT;
