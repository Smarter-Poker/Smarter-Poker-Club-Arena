-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_rake_bbj_invariants(integer)'::regprocedure))='1c8bda472ed556ae781c2416ebb0ec94' AND md5(pg_get_functiondef('public.fn_rake_law_violations(interval)'::regprocedure))='6fe1606ee718c52848c28fb1774673ea')
-- 20261015214329_rake_audits_read_the_dealt_roster_rather_than_contribution_c.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

-- Fee-envelope num_players is the signed contribution-key count by the
-- accepted-hand contract. Rake/BBJ eligibility instead uses players dealt.
-- Prefer the immutable hand roster; retain the existing fee-count fallback
-- only when the historical hand roster is unavailable. No money is written.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
DO $guard$ BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL THEN RAISE EXCEPTION 'rake_roster_operator_refused'; END IF;
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL THEN RAISE EXCEPTION 'rake_roster_override_refused'; END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN RAISE EXCEPTION 'rake_roster_freeze_refused'; END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261015214329') THEN RAISE EXCEPTION 'rake_roster_replay_refused'; END IF;
END $guard$;
DO $patch0$
DECLARE sig regprocedure:='public.fn_rake_bbj_invariants(integer)'::regprocedure;
 def text:=pg_get_functiondef(sig); prior jsonb;
 old text:=$old$r.pot_size, r.num_players, r.rake_method, r.player_contributions,$old$;
 new text:=$new$r.pot_size, COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(hh.players) = 'array' THEN hh.players END), r.num_players) AS num_players, r.rake_method, r.player_contributions,$new$;
BEGIN
 IF md5(def)<>'f0cfc5a0b6a7a362e400ee01081804c0' OR (length(def)-length(replace(def,old,'')))/length(old)<>1 THEN RAISE EXCEPTION 'rake_roster_preimage_refused'; END IF;
 SELECT jsonb_build_array(proowner,prosecdef,provolatile,proconfig,proacl) INTO prior FROM pg_proc WHERE oid=sig;
 EXECUTE replace(def,old,new);
 IF md5(pg_get_functiondef(sig))<>'1c8bda472ed556ae781c2416ebb0ec94' THEN RAISE EXCEPTION 'rake_roster_postimage_refused'; END IF;
 IF (SELECT jsonb_build_array(proowner,prosecdef,provolatile,proconfig,proacl) FROM pg_proc WHERE oid=sig) IS DISTINCT FROM prior THEN RAISE EXCEPTION 'rake_roster_security_refused'; END IF;
END $patch0$;
DO $patch1$
DECLARE sig regprocedure:='public.fn_rake_law_violations(interval)'::regprocedure;
 def text:=pg_get_functiondef(sig); prior jsonb;
 old text:=$old$COALESCE(rr.num_players, jsonb_array_length(CASE WHEN jsonb_typeof(hh.players) = 'array' THEN hh.players END)) AS dealt,$old$;
 new text:=$new$COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(hh.players) = 'array' THEN hh.players END), rr.num_players) AS dealt,$new$;
BEGIN
 IF md5(def)<>'a3e1fde3f45140c91640389d419ed553' OR (length(def)-length(replace(def,old,'')))/length(old)<>1 THEN RAISE EXCEPTION 'rake_roster_preimage_refused'; END IF;
 SELECT jsonb_build_array(proowner,prosecdef,provolatile,proconfig,proacl) INTO prior FROM pg_proc WHERE oid=sig;
 EXECUTE replace(def,old,new);
 IF md5(pg_get_functiondef(sig))<>'6fe1606ee718c52848c28fb1774673ea' THEN RAISE EXCEPTION 'rake_roster_postimage_refused'; END IF;
 IF (SELECT jsonb_build_array(proowner,prosecdef,provolatile,proconfig,proacl) FROM pg_proc WHERE oid=sig) IS DISTINCT FROM prior THEN RAISE EXCEPTION 'rake_roster_security_refused'; END IF;
END $patch1$;
COMMIT;
