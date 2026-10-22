-- @live-proof: (md5(pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure))='e5065fedd05b476e16bf9a0393f8bc05' AND EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('public.accounting_tournament_fee_sources_standalone_club') AND i.indisvalid))
-- 20261022150614_the_weekly_scheduler_scan_reads_standalone_tournament_earnin.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Job 272 (union-weekly-rakeback-close) gives each tick a 240 s statement and
-- each close attempt a deadline of LEAST(attempt start + 3 min, statement
-- start + 180 s). Everything the tick does before the attempt begins is taken
-- out of the attempt's 3 minutes. Before visiting any scope, the tick's scope
-- scan (fn_process_weekly_accounting_scope, standalone_earned) read the
-- tournament_fee_accrual half of accounting_payable_earning_sources for every
-- standalone fee row ever written: a hash join of 1.7M recognized sources with
-- 625K recognitions, then 1.7M primary-key probes into the 3 GB fee-source
-- table to keep the 303K standalone rows. Measured 2026-10-22: 10.7 s warm,
-- over 100 s cold, and the whole scan 31.6 s under load. That is why Deep
-- Stack Society's week of 2026-10-12 needed 25 attempts from 2026-10-19 to
-- 2026-10-22 06:29 UTC, raising 23 "Weekly club accounting is incomplete"
-- (weekly_scope_time_budget_exhausted) and 23 "A weekly accounting scope did
-- not finish its scheduler visit" (weekly_scope_statement_budget_exhausted,
-- 57014) alerts, and why the 06:40 CT tick on 2026-10-22 was cancelled inside
-- that scan.
--
-- The scan only uses these rows through eligible, as
-- GREATEST(first week, fn_club_settlement_floor_week(club)) for clubs that are
-- not unions. So, per non-union club, read from its own standalone fee rows
-- (the new partial index): a club with any earning before its floor
-- contributes the floor itself, and any other club contributes its earliest
-- earning and earliest finite earning. The predicate is the view branch
-- verbatim. Element-wise, raising an earning below the floor to the floor
-- leaves GREATEST(LEAST(week_start(min finite), min), floor) unchanged, so the
-- eligible scopes, their order and their weeks are the same; checked live
-- before applying: identical scan output, 31.6 s -> 12.2 s without the index.
--
-- The index is built CONCURRENTLY before the transaction (its own statement,
-- no write lock on the fee sources). The function change is an exact,
-- once-only replacement guarded by pre- and post-image md5s.

CREATE INDEX CONCURRENTLY IF NOT EXISTS accounting_tournament_fee_sources_standalone_club
 ON public.accounting_tournament_fee_sources (club_id, tournament_id) WHERE coordinator_union_id IS NULL;

BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $standalone_tournament_scan$
DECLARE def text;sig regprocedure;ix record;
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.role',true),'') IS NOT NULL THEN RAISE EXCEPTION 'standalone_tournament_scan_operator_refused';END IF;
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL OR public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN RAISE EXCEPTION 'standalone_tournament_scan_freeze_or_override_refused';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION 'standalone_tournament_scan_scheduler_owned';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261022150614') THEN RAISE EXCEPTION 'standalone_tournament_scan_history_replay';END IF;
 SELECT i.indisvalid,i.indisready,i.indislive,pg_get_indexdef(i.indexrelid) AS def INTO ix FROM pg_index i
  WHERE i.indexrelid=to_regclass('public.accounting_tournament_fee_sources_standalone_club');
 IF NOT FOUND OR NOT ix.indisvalid OR NOT ix.indisready OR NOT ix.indislive
  OR ix.def IS DISTINCT FROM 'CREATE INDEX accounting_tournament_fee_sources_standalone_club ON public.accounting_tournament_fee_sources USING btree (club_id, tournament_id) WHERE (coordinator_union_id IS NULL)'
 THEN RAISE EXCEPTION 'standalone_tournament_scan_index_missing_or_invalid';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_process_weekly_accounting_scope(uuid,uuid)') AND md5(pg_get_functiondef(p.oid))='63eea798a2390accfd91d68f06dd9958' AND md5(p.prosrc)='3c992f3c461b7cff3b125bfbbd074678' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='v' AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=public']) THEN RAISE EXCEPTION 'standalone_tournament_scan_preimage_authority_refused';END IF;
 sig:='public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure;def:=pg_get_functiondef(sig);
 IF (length(def)-length(replace(def,$old_0$          SELECT s.club_id,s.earned_at FROM public.accounting_payable_earning_sources s
          WHERE s.source_type='tournament_fee_accrual' AND s.coordinator_union_id IS NULL AND s.earned_at<v_to
$old_0$,'')))/length($old_0$          SELECT s.club_id,s.earned_at FROM public.accounting_payable_earning_sources s
          WHERE s.source_type='tournament_fee_accrual' AND s.coordinator_union_id IS NULL AND s.earned_at<v_to
$old_0$)<>1 THEN RAISE EXCEPTION 'standalone_tournament_scan_exact_replacement_refused';END IF;
 def:=replace(def,$old_0$          SELECT s.club_id,s.earned_at FROM public.accounting_payable_earning_sources s
          WHERE s.source_type='tournament_fee_accrual' AND s.coordinator_union_id IS NULL AND s.earned_at<v_to
$old_0$,$new_0$          -- STANDALONE TOURNAMENT EARNINGS ARE READ PER CLUB (20261022150614): this branch
          -- used to read the tournament_fee_accrual half of
          -- accounting_payable_earning_sources for every source row on every tick
          -- (1.7M recognition probes, 10 s warm and over 100 s cold), which spent
          -- the close attempt's own 3-minute budget before the attempt began.
          -- The predicate below is that view branch verbatim, read per club from
          -- the club's own standalone fee rows. Only eligible below reads these
          -- rows, as GREATEST(first week, the club's settlement floor) for clubs
          -- that are not unions, so a club with any such earning before its floor
          -- contributes the floor itself and is not read further; any other club
          -- contributes its earliest earning (and earliest finite one).
          SELECT tc.id AS club_id,te.earned_at FROM public.clubs tc
          CROSS JOIN LATERAL (SELECT public.fn_club_settlement_floor_week(tc.id) AS floor) tf
          CROSS JOIN LATERAL (SELECT CASE WHEN tf.floor IS NOT NULL AND EXISTS(SELECT 1
              FROM (SELECT s.id,s.tournament_id,s.club_id,s.union_id,s.charged_at,s.rake_credit FROM public.accounting_tournament_fee_sources s
                     WHERE s.club_id=tc.id AND s.coordinator_union_id IS NULL OFFSET 0) s
              JOIN public.accounting_tournament_recognized_sources rs ON rs.source_id=s.id AND rs.tournament_id=s.tournament_id
              JOIN public.accounting_tournament_fee_recognitions r ON r.tournament_id=s.tournament_id
              LEFT JOIN public.fn_ca_launch_accounting_club_cutoffs() bd(club_id,cutoff_at) ON bd.club_id=s.club_id
              WHERE (bd.cutoff_at IS NULL OR s.charged_at IS NOT NULL AND isfinite(s.charged_at) AND s.charged_at>=bd.cutoff_at)
                AND (bd.cutoff_at IS NULL OR rs.recognized_at IS NOT NULL AND isfinite(rs.recognized_at) AND rs.recognized_at>=bd.cutoff_at)
                AND rs.disposition='earned' AND r.status='recognized' AND rs.rake_credit=s.rake_credit AND rs.recognized_at=r.recognized_at
                AND NOT s.union_id IS DISTINCT FROM r.union_id AND rs.recognized_at<v_to AND rs.recognized_at<tf.floor)
            THEN tf.floor END AS clamp) tk
          CROSS JOIN LATERAL (
            SELECT tk.clamp AS earned_at WHERE tk.clamp IS NOT NULL
            UNION ALL
            SELECT tm.earned_at FROM (SELECT min(rs.recognized_at) AS m,min(rs.recognized_at) FILTER(WHERE isfinite(rs.recognized_at)) AS mf
              FROM (SELECT s.id,s.tournament_id,s.club_id,s.union_id,s.charged_at,s.rake_credit FROM public.accounting_tournament_fee_sources s
                     WHERE s.club_id=tc.id AND s.coordinator_union_id IS NULL OFFSET 0) s
              JOIN public.accounting_tournament_recognized_sources rs ON rs.source_id=s.id AND rs.tournament_id=s.tournament_id
              JOIN public.accounting_tournament_fee_recognitions r ON r.tournament_id=s.tournament_id
              LEFT JOIN public.fn_ca_launch_accounting_club_cutoffs() bd(club_id,cutoff_at) ON bd.club_id=s.club_id
              WHERE tk.clamp IS NULL AND (bd.cutoff_at IS NULL OR s.charged_at IS NOT NULL AND isfinite(s.charged_at) AND s.charged_at>=bd.cutoff_at)
                AND (bd.cutoff_at IS NULL OR rs.recognized_at IS NOT NULL AND isfinite(rs.recognized_at) AND rs.recognized_at>=bd.cutoff_at)
                AND rs.disposition='earned' AND r.status='recognized' AND rs.rake_credit=s.rake_credit AND rs.recognized_at=r.recognized_at
                AND NOT s.union_id IS DISTINCT FROM r.union_id AND rs.recognized_at<v_to) ta
            CROSS JOIN LATERAL (VALUES(ta.m),(ta.mf)) tm(earned_at) WHERE tm.earned_at IS NOT NULL) te
          WHERE tc.is_union IS NOT TRUE
$new_0$);
 IF md5(def)<>'e5065fedd05b476e16bf9a0393f8bc05' THEN RAISE EXCEPTION 'standalone_tournament_scan_postimage_refused';END IF;
 EXECUTE def;
 IF NOT EXISTS(SELECT FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_process_weekly_accounting_scope(uuid,uuid)') AND md5(pg_get_functiondef(p.oid))='e5065fedd05b476e16bf9a0393f8bc05' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='v' AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=public']) THEN RAISE EXCEPTION 'standalone_tournament_scan_installed_authority_refused';END IF;
END $standalone_tournament_scan$;
COMMIT;
