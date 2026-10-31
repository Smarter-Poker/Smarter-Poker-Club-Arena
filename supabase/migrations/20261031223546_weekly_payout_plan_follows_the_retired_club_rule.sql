-- Version reserved by scripts/reserve-migration-version.sh against protected main and worktrees.
-- 20261031202949 (a retired club opens no empty accounting week) changed the
-- original scheduler public.fn_process_weekly_accounting_scope. The owned
-- weekly payout's scope plan, smarter_private.weekly_payout_eligible_scopes,
-- is that scheduler's eligible-scope selection verbatim and refuses to run when
-- the original's md5 is not the one it mirrors, so since that install EVERY
-- owned payout preparation raises weekly_payout_original_scope_authority_changed:
-- Monday 2026-11-02 would pay nobody (observed read-only 2026-10-31 22:33Z).
-- This forwards the SAME one-anchor change (byte-identical replacement text) into
-- the mirror and re-pins it to the original's new md5, so the owned plan again
-- equals the original selection: retired Lightning Internal Pilot, whose books
-- are finished, is no longer owed; an unfinished or still-earning retired club
-- stays owed. No rate, ledger, receipt, report, money or schedule change.
-- @live-proof: md5(pg_get_functiondef('smarter_private.weekly_payout_eligible_scopes(timestamp with time zone,timestamp with time zone)'::regprocedure))='f28a58c12720f40e354ddb3cf1c73677'
BEGIN;
SET LOCAL transaction_timeout='15s';
SET LOCAL statement_timeout='5s';
SET LOCAL lock_timeout='1s';
SET LOCAL search_path=pg_catalog,public;
SET LOCAL timezone='UTC';
DO $weekly_payout_plan_retired_rule$
DECLARE
 v_target constant regprocedure:='smarter_private.weekly_payout_eligible_scopes(timestamp with time zone,timestamp with time zone)'::regprocedure;
 v_anchor constant text:=E'FROM standalone_work w JOIN public.clubs c ON c.id=w.club_id\n           WHERE c.is_union IS NOT TRUE AND GREATEST(';
 v_replacement constant text:=E'FROM standalone_work w JOIN public.clubs c ON c.id=w.club_id\n           WHERE c.is_union IS NOT TRUE\n            -- A RETIRED CLUB OPENS NO EMPTY WEEK (20261031): once its last close is\n            -- complete and nothing has been earned since, its books are finished.\n            -- The retirement guard refuses a new settlement period for it anyway.\n            AND NOT (c.lifecycle_status=''retired''\n              AND NOT EXISTS(SELECT 1 FROM public.union_accounting_runs rq WHERE rq.standalone_club_id=c.id AND rq.status<>''complete'')\n              AND NOT EXISTS(SELECT 1 FROM public.accounting_cash_rake_sources rs WHERE rs.club_id=c.id\n                AND rs.earned_at>=COALESCE((SELECT max(rq.period_end) FROM public.union_accounting_runs rq WHERE rq.standalone_club_id=c.id AND rq.status=''complete''),''-infinity''::timestamptz))\n              AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources ts WHERE ts.club_id=c.id\n                AND ts.charged_at>=COALESCE((SELECT max(rq.period_end) FROM public.union_accounting_runs rq WHERE rq.standalone_club_id=c.id AND rq.status=''complete''),''-infinity''::timestamptz)))\n            AND GREATEST(';
 v_def text;v_patched text;v_before jsonb;v_after jsonb;
BEGIN
 IF session_user<>'postgres' OR current_user<>'postgres'
  OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL
  OR public.fn_platform_frozen() IS DISTINCT FROM false THEN
  RAISE EXCEPTION 'weekly_payout_plan_retired_rule_operator_or_freeze_refused';
 END IF;
 IF md5(pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure)) IS DISTINCT FROM '023efba44914bad5d05e2538e951e59f'
  OR position(v_replacement IN pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure))=0
  OR md5(pg_get_functiondef(v_target)) IS DISTINCT FROM 'c2268481918932ae2d8be5a5acf72e9a'
 THEN RAISE EXCEPTION 'weekly_payout_plan_retired_rule_original_changed' USING ERRCODE='55000';END IF;
 SELECT pg_get_functiondef(p.oid),jsonb_build_object('owner',p.proowner,'acl',p.proacl,'secdef',p.prosecdef,'cfg',p.proconfig,'vol',p.provolatile)
  INTO v_def,v_before FROM pg_proc p WHERE p.oid=v_target;
 IF (length(v_def)-length(replace(v_def,v_anchor,'')))/length(v_anchor)<>1
  OR (length(v_def)-length(replace(v_def,'''e4f6b4adc2f43ccd2b7ecd90f2434538''','')))/34<>1
 THEN RAISE EXCEPTION 'weekly_payout_plan_retired_rule_anchor_changed' USING ERRCODE='55000';END IF;
 v_patched:=replace(replace(v_def,v_anchor,v_replacement),'''e4f6b4adc2f43ccd2b7ecd90f2434538''','''023efba44914bad5d05e2538e951e59f''');
 EXECUTE v_patched;
 SELECT jsonb_build_object('owner',p.proowner,'acl',p.proacl,'secdef',p.prosecdef,'cfg',p.proconfig,'vol',p.provolatile)
  INTO v_after FROM pg_proc p WHERE p.oid=v_target;
 IF v_after IS DISTINCT FROM v_before OR pg_get_functiondef(v_target)<>v_patched
  OR md5(pg_get_functiondef(v_target)) IS DISTINCT FROM 'f28a58c12720f40e354ddb3cf1c73677'
 THEN RAISE EXCEPTION 'weekly_payout_plan_retired_rule_install_mismatch';END IF;
END $weekly_payout_plan_retired_rule$;
COMMIT;
