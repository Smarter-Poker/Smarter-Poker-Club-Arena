-- @live-proof: (SELECT position('fn_ca_launch_accounting_club_cutoffs' IN pg_get_viewdef('public.accounting_payable_earning_sources'::regclass))>0 AND position('fn_ca_launch_accounting_accepts' IN pg_get_viewdef('public.accounting_payable_earning_sources'::regclass))=0)
-- 20261015094219_payable_earning_sources_read_their_cutoff_once.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- public.accounting_payable_earning_sources is the rake ledger every weekly
-- close reads: the scheduler's scope selection, the union P&L's club rows, the
-- earned plan. It decided whether each source is inside its club's launch
-- accounting cutoff by calling fn_ca_launch_accounting_accepts once per row
-- (twice per tournament row). That function is SECURITY DEFINER, so the planner
-- can never inline it: every row paid a function call and a lookup of
-- ca_launch_accounting_boundaries.
--
-- Measured on 2026-10-15 (Midway Union, 5.8 M cash and 1.2 M tournament source
-- rows): one day of the union's sources took 25.1 s, its whole week about
-- 175 s, and the scheduler's standalone scope selection 40.4 s on every
-- 5-minute tick. With a 240 s tick (20261012134146) the original week
-- (2026-10-05 -> 2026-10-12) could never be closed: the club P&L step alone is
-- longer than the tick, so every attempt was cancelled and rolled back.
--
-- The root fix is the view. The active cutoffs are read once per query through
-- fn_ca_launch_accounting_club_cutoffs() (SECURITY DEFINER, the same reader the
-- per-row helper used, so the invoker view still never needs SELECT on the
-- boundaries table) and joined. The predicate is the helper's own, verbatim:
-- no active boundary, or a NULL cutoff, accepts the row; otherwise the time
-- must be non-NULL, finite and at or after the cutoff. ca_launch_accounting_one_active
-- (UNIQUE (scope_kind, scope_id) WHERE undone_at IS NULL) guarantees at most one
-- cutoff per club, so the join cannot duplicate a row.
--
-- Proved in production by self-aborting trials with the successor built in
-- pg_temp: Midway's 2026-10-11 day, 339,603 rows, identical sum and identical
-- md5 over every (type, id, earned_at, rake, contract); the whole week 16.5 s
-- (was ~175 s) with the same 2,425,384.33 the certified earned plan carries;
-- with a cutoff inserted for Club JAQK at 2026-10-11 12:00 inside the trial,
-- 4,573 rows became the same 2,176 rows on both sides with identical md5.
--
-- Columns, types, order, security_invoker and grants are unchanged and
-- asserted. No row, certificate or money is written.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
SET LOCAL search_path=public;
DO $guard$BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL THEN RAISE EXCEPTION 'payable_cutoff_operator_refused' USING ERRCODE='42501';END IF;
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL THEN RAISE EXCEPTION 'payable_cutoff_override_refused';END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN RAISE EXCEPTION 'payable_cutoff_freeze_refused';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261015094219') THEN RAISE EXCEPTION 'payable_cutoff_history_replay';END IF;
 IF md5(pg_get_viewdef('public.accounting_payable_earning_sources'::regclass))<>'a6fc7948eac00658f2302ad19833719f' THEN RAISE EXCEPTION 'payable_cutoff_preimage_refused';END IF;
 IF to_regprocedure('public.fn_ca_launch_accounting_club_cutoffs()') IS NOT NULL THEN RAISE EXCEPTION 'payable_cutoff_reader_exists';END IF;
 IF NOT EXISTS(SELECT FROM pg_indexes WHERE schemaname='public' AND indexname='ca_launch_accounting_one_active'
   AND indexdef='CREATE UNIQUE INDEX ca_launch_accounting_one_active ON public.ca_launch_accounting_boundaries USING btree (scope_kind, scope_id) WHERE (undone_at IS NULL)') THEN
  RAISE EXCEPTION 'payable_cutoff_one_active_refused';END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_ca_launch_accounting_accepts(uuid,timestamptz)'::regprocedure) IS DISTINCT FROM
    md5(E'\n SELECT CASE WHEN b.cutoff IS NULL THEN true ELSE p_earned_at IS NOT NULL AND isfinite(p_earned_at) AND p_earned_at>=b.cutoff END\n FROM (SELECT public.fn_ca_launch_accounting_cutoff(''club'',p_club_id) cutoff)b\n')
 THEN RAISE EXCEPTION 'payable_cutoff_helper_drifted';END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_ca_launch_accounting_cutoff(text,uuid)'::regprocedure) IS DISTINCT FROM
    md5(E'\n SELECT cutoff_at FROM public.ca_launch_accounting_boundaries WHERE scope_kind=p_kind AND scope_id=p_id AND undone_at IS NULL\n')
 THEN RAISE EXCEPTION 'payable_cutoff_reader_drifted';END IF;
END $guard$;

CREATE TEMP TABLE zz_payable_before ON COMMIT DROP AS
 SELECT (SELECT string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod),',' ORDER BY a.attnum)
           FROM pg_attribute a WHERE a.attrelid='public.accounting_payable_earning_sources'::regclass AND a.attnum>0 AND NOT a.attisdropped) cols,
        (SELECT array_to_string(c.reloptions,',')||'|'||c.relacl::text||'|'||c.relowner::regrole FROM pg_class c
          WHERE c.oid='public.accounting_payable_earning_sources'::regclass) meta;

CREATE FUNCTION public.fn_ca_launch_accounting_club_cutoffs()
 RETURNS TABLE(club_id uuid, cutoff_at timestamptz)
 LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
 ROWS 10
AS $fn$
 SELECT b.scope_id, b.cutoff_at FROM public.ca_launch_accounting_boundaries b
  WHERE b.scope_kind='club' AND b.undone_at IS NULL
$fn$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_accounting_club_cutoffs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_launch_accounting_club_cutoffs() TO service_role;
COMMENT ON FUNCTION public.fn_ca_launch_accounting_club_cutoffs() IS
 'The active club launch accounting cutoffs, read once per query by accounting_payable_earning_sources (20261015094219).';

CREATE OR REPLACE VIEW public.accounting_payable_earning_sources WITH (security_invoker=true) AS
 SELECT 'cash_rake_accrual'::text AS source_type,
    s.id AS source_id,
    s.rake_record_id,
    NULL::uuid AS tournament_id,
    s.player_id,
    s.club_id,
    s.union_id,
    s.coordinator_union_id,
    s.earned_at,
    s.rake_credit,
    s.contract
   FROM public.accounting_cash_rake_sources s
     LEFT JOIN public.fn_ca_launch_accounting_club_cutoffs() bd ON bd.club_id = s.club_id
  WHERE (bd.cutoff_at IS NULL OR (s.earned_at IS NOT NULL AND isfinite(s.earned_at) AND s.earned_at >= bd.cutoff_at))
UNION ALL
 SELECT 'tournament_fee_accrual'::text AS source_type,
    s.id AS source_id,
    s.rake_record_id,
    s.tournament_id,
    s.player_id,
    s.club_id,
    s.union_id,
    s.coordinator_union_id,
    rs.recognized_at AS earned_at,
    s.rake_credit,
    s.contract
   FROM public.accounting_tournament_fee_sources s
     JOIN public.accounting_tournament_recognized_sources rs ON rs.source_id = s.id AND rs.tournament_id = s.tournament_id
     JOIN public.accounting_tournament_fee_recognitions r ON r.tournament_id = s.tournament_id
     LEFT JOIN public.fn_ca_launch_accounting_club_cutoffs() bd ON bd.club_id = s.club_id
  WHERE (bd.cutoff_at IS NULL OR (s.charged_at IS NOT NULL AND isfinite(s.charged_at) AND s.charged_at >= bd.cutoff_at))
    AND (bd.cutoff_at IS NULL OR (rs.recognized_at IS NOT NULL AND isfinite(rs.recognized_at) AND rs.recognized_at >= bd.cutoff_at))
    AND rs.disposition = 'earned'::text AND r.status = 'recognized'::text AND rs.rake_credit = s.rake_credit
    AND rs.recognized_at = r.recognized_at AND NOT (s.union_id IS DISTINCT FROM r.union_id);

DO $post$BEGIN
 IF (SELECT string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod),',' ORDER BY a.attnum)
       FROM pg_attribute a WHERE a.attrelid='public.accounting_payable_earning_sources'::regclass AND a.attnum>0 AND NOT a.attisdropped)
    IS DISTINCT FROM (SELECT cols FROM zz_payable_before) THEN RAISE EXCEPTION 'payable_cutoff_columns_refused';END IF;
 IF (SELECT array_to_string(c.reloptions,',')||'|'||c.relacl::text||'|'||c.relowner::regrole FROM pg_class c
      WHERE c.oid='public.accounting_payable_earning_sources'::regclass) IS DISTINCT FROM (SELECT meta FROM zz_payable_before)
 THEN RAISE EXCEPTION 'payable_cutoff_security_refused';END IF;
 IF position('fn_ca_launch_accounting_accepts' IN pg_get_viewdef('public.accounting_payable_earning_sources'::regclass))>0
    OR position('fn_ca_launch_accounting_club_cutoffs' IN pg_get_viewdef('public.accounting_payable_earning_sources'::regclass))=0
 THEN RAISE EXCEPTION 'payable_cutoff_postimage_refused';END IF;
END $post$;

COMMIT;
