#!/usr/bin/env python3
"""Assembles the weekly-close-scale migration from build.py's new/ bodies.
Usage: gen-migration.py <migration path> [postimage.json]"""
from pathlib import Path
import hashlib, json, sys
here = Path(__file__).resolve().parent
pre, new = here / 'preimage', here / 'new'
PRE = {  # md5(pg_get_functiondef) read from production 2026-09-28
 'fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone)': ('fn_settle_accounting_commission_stage', '58b9c7c7241fa7ef596a7b1da3b9264b'),
 'fn_settle_accounting_rakeback_stage(text,uuid,timestamp with time zone,timestamp with time zone)': ('fn_settle_accounting_rakeback_stage', 'f47ac7383ea3bfaf384642a6ba4fb885'),
 'fn_club_weekly_accounting_summary(uuid)': ('fn_club_weekly_accounting_summary', '15dad1cd6be1f299e684068e4655bd3a'),
 'fn_assert_cash_commission_period(uuid,uuid,timestamp with time zone,timestamp with time zone)': ('fn_assert_cash_commission_period', '1c3c3889e97e6dd500afbace341ba0c8'),
 'fn_accounting_union_earned_plan(uuid,timestamp with time zone,timestamp with time zone)': ('fn_accounting_union_earned_plan', 'c4e909aebc4228ff1d93695ed92f0368'),
 'fn_process_weekly_accounting_scope(uuid,uuid)': ('fn_process_weekly_accounting_scope', 'fe62d1a4a7ecb63873b826426be031ff'),
 'fn_union_settlement_cascade(uuid,timestamp with time zone,timestamp with time zone)': ('fn_union_settlement_cascade', '5d0eb7a8188042a1a4c23aaa90656bfd'),
}
for sig, (name, h) in PRE.items():
    got = hashlib.md5(((pre / f'{name}.sql').read_text().rstrip('\n')+'\n').encode()).hexdigest()
    if got != h:
        sys.exit(f'captured preimage file {name} md5 {got} != production {h}')
post = json.loads(Path(sys.argv[2]).read_text()) if len(sys.argv) > 2 else {}

def body(name):
    return (new / f'{name}.sql').read_text().rstrip('\n') + ';\n'

CRON_OLD = "SET statement_timeout='2400s'; SELECT public.fn_union_settlement_cascade_due();"
CRON_NEW = "SET statement_timeout='1200s'; SET app.weekly_accounting_attempt_budget='1'; SELECT public.fn_union_settlement_cascade_due();"

COORD_PATCHES = [
 ("      -- Keep a refused preparation request durable outside the wallet rollback.\n",
  "      PERFORM public.fn_weekly_accounting_attempt_begin(true);\n      -- Keep a refused preparation request durable outside the wallet rollback.\n"),
 ("          v_result:=public.fn_union_settlement_cascade(v_union.id,v_from,v_end);\n",
  "          PERFORM public.fn_weekly_accounting_deadline_check();\n          v_result:=public.fn_union_settlement_cascade(v_union.id,v_from,v_end);\n          PERFORM public.fn_weekly_accounting_deadline_check();\n"),
 ("      IF v_result->>'success'='true' THEN v_result:=v_result||jsonb_build_object('accounting_version',3); END IF;\n",
  "      PERFORM public.fn_weekly_accounting_attempt_end();\n      IF v_result->>'success'='true' THEN v_result:=v_result||jsonb_build_object('accounting_version',3); END IF;\n"),
 ("        BEGIN v_preparation:=public.fn_prepare_accounting_week(NULL,v_club.id,v_from,v_end);\n",
  "        PERFORM public.fn_weekly_accounting_attempt_begin(false);\n        BEGIN v_preparation:=public.fn_prepare_accounting_week(NULL,v_club.id,v_from,v_end);\n"),
 ("          v_stage2:=public.fn_settle_accounting_commission_stage('club',v_club.id,v_from,v_end);\n          v_stage3:=public.fn_settle_accounting_rakeback_stage('club',v_club.id,v_from,v_end);\n",
  "          PERFORM public.fn_weekly_accounting_deadline_check();\n          v_stage2:=public.fn_settle_accounting_commission_stage('club',v_club.id,v_from,v_end);\n          PERFORM public.fn_weekly_accounting_deadline_check();\n          v_stage3:=public.fn_settle_accounting_rakeback_stage('club',v_club.id,v_from,v_end);\n          PERFORM public.fn_weekly_accounting_deadline_check();\n"),
 ("          v_statements:=public.fn_issue_scope_weekly_accounting('club',v_club.id,v_from,v_end);\n",
  "          PERFORM public.fn_weekly_accounting_deadline_check();\n          v_statements:=public.fn_issue_scope_weekly_accounting('club',v_club.id,v_from,v_end);\n          PERFORM public.fn_weekly_accounting_deadline_check();\n"),
 ("        UPDATE public.union_accounting_runs SET status=CASE WHEN v_result->>'success'='true' THEN 'complete' ELSE 'failed' END,\n          finished_at=clock_timestamp(),result=v_result WHERE standalone_club_id=v_club.id",
  "        PERFORM public.fn_weekly_accounting_attempt_end();\n        UPDATE public.union_accounting_runs SET status=CASE WHEN v_result->>'success'='true' THEN 'complete' ELSE 'failed' END,\n          finished_at=clock_timestamp(),result=v_result WHERE standalone_club_id=v_club.id"),
]
CASCADE_PATCHES = [
 ("  v_r1 := public.fn_union_weekly_rakeback_close(p_union_id, v_from, v_to);\n",
  "  PERFORM public.fn_weekly_accounting_deadline_check();\n  v_r1 := public.fn_union_weekly_rakeback_close(p_union_id, v_from, v_to);\n"),
 ("  v_r2 := public.fn_settle_round2_club_to_agents(p_union_id, v_from, v_to);\n",
  "  PERFORM public.fn_weekly_accounting_deadline_check();\n  v_r2 := public.fn_settle_round2_club_to_agents(p_union_id, v_from, v_to);\n"),
 ("  v_r3 := public.fn_settle_round3_agents_to_players(p_union_id, v_from, v_to);\n",
  "  PERFORM public.fn_weekly_accounting_deadline_check();\n  v_r3 := public.fn_settle_round3_agents_to_players(p_union_id, v_from, v_to);\n"),
 ("  IF public.fn_union_setting(p_union_id, 'weekly_invoices_enabled', 1) <> 1 THEN\n",
  "  PERFORM public.fn_weekly_accounting_deadline_check();\n  IF public.fn_union_setting(p_union_id, 'weekly_invoices_enabled', 1) <> 1 THEN\n"),
 ("  FOR v_credit_club IN SELECT club_id FROM public.fn_accounting_week_clubs(p_union_id,NULL,v_from,v_to) ORDER BY club_id LOOP\n",
  "  PERFORM public.fn_weekly_accounting_deadline_check();\n  FOR v_credit_club IN SELECT club_id FROM public.fn_accounting_week_clubs(p_union_id,NULL,v_from,v_to) ORDER BY club_id LOOP\n"),
 ("  v_club_statements:=public.fn_issue_club_weekly_accounting(p_union_id,v_from,v_to);\n",
  "  v_club_statements:=public.fn_issue_club_weekly_accounting(p_union_id,v_from,v_to);\n  PERFORM public.fn_weekly_accounting_deadline_check();\n"),
]
def sqlq(s):  # dollar-quote-free literal
    return "'" + s.replace("'", "''") + "'"
def patch_block(sig, patches):
    lines = [f" src:=pg_get_functiondef('public.{sig}'::regprocedure);"]
    for needle, repl in patches:
        lines.append(f" needle:={sqlq(needle)};")
        lines.append(" IF (length(src)-length(replace(src,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'patch needle not unique in %: %',"
                     + sqlq(sig) + ",left(needle,80); END IF;")
        lines.append(f" src:=replace(src,needle,{sqlq(repl)});")
    lines.append(" EXECUTE src;")
    return '\n'.join(lines)

pre_checks = '\n'.join(
 f"  IF md5(pg_get_functiondef('public.{sig}'::regprocedure)) IS DISTINCT FROM '{h}' THEN RAISE EXCEPTION 'preimage mismatch: {name}' USING ERRCODE='55000'; END IF;"
 for sig, (name, h) in PRE.items())
post_checks = '\n'.join(
 f"  IF md5(pg_get_functiondef('public.{sig}'::regprocedure)) IS DISTINCT FROM '{h}' THEN RAISE EXCEPTION 'postimage mismatch: {sig}' USING ERRCODE='55000'; END IF;"
 for sig, h in sorted(post.items())) or "  RAISE EXCEPTION 'postimage digests not generated yet';"

ACL = {  # proacl read from production 2026-09-28; the new functions: owner only
 'fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone)': '{postgres=X/postgres}',
 'fn_settle_accounting_rakeback_stage(text,uuid,timestamp with time zone,timestamp with time zone)': '{postgres=X/postgres}',
 'fn_accounting_union_earned_plan(uuid,timestamp with time zone,timestamp with time zone)': '{postgres=X/postgres}',
 'fn_process_weekly_accounting_scope(uuid,uuid)': '{postgres=X/postgres}',
 'fn_union_settlement_cascade(uuid,timestamp with time zone,timestamp with time zone)': '{postgres=X/postgres}',
 'fn_assert_cash_commission_period(uuid,uuid,timestamp with time zone,timestamp with time zone)': '{postgres=X/postgres,service_role=X/postgres}',
 'fn_club_weekly_accounting_summary(uuid)': '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}',
 'fn_settle_accounting_commission_stage_v3(text,uuid,timestamp with time zone,timestamp with time zone)': '{postgres=X/postgres}',
 'fn_accounting_union_earned_plan_v3(uuid,timestamp with time zone,timestamp with time zone)': '{postgres=X/postgres}',
 'fn_weekly_accounting_attempt_begin(boolean)': '{postgres=X/postgres}',
 'fn_weekly_accounting_deadline_check()': '{postgres=X/postgres}',
 'fn_weekly_accounting_attempt_end()': '{postgres=X/postgres}',
}
acl_checks = '\n'.join(
 f"  IF (SELECT proacl::text FROM pg_proc WHERE oid='public.{sig}'::regprocedure) IS DISTINCT FROM '{acl}' THEN RAISE EXCEPTION 'access mismatch: {sig}' USING ERRCODE='55000'; END IF;"
 for sig, acl in ACL.items())

out = f"""-- A WEEKLY CLOSE PROVES EACH BOOK ONCE AND NEVER HOLDS A LONG TRANSACTION (2026-09-28).
--
-- WHAT WAS SLOW (measured read-only on production 2026-09-28, week 2026-09-21)
-- Deep Stack Society's exact-scope close ran 47 minutes in one transaction and
-- was cancelled. Its sources: 599k (544k cash, 55k tournament) with 1.44M tiers,
-- 197,135 private cash deposits, ~382 player periods. Page reads from disk cost
-- about 17 ms each on this instance, so every per-row lookup is the cost:
--  * statement (fn_club_weekly_accounting_summary): the private-deposit loop
--    asked the sources twice per deposit; the second query's CASE key sent
--    PL/pgSQL to a generic plan that walks the club's whole source history:
--    233 ms per deposit measured, 197,135 deposits = about 13 hours. Its
--    transfer read was a parallel scan of all 3 GB of chip_ledger.
--  * round 2 (fn_settle_accounting_commission_stage): two agent_commissions
--    index probes per tier (1.44M tiers, 0.83 ms per tier measured, ~20 min),
--    a per-row source probe for every commission row of the week (~3 min), a
--    600k-iteration PL/pgSQL tier loop and a 660 MB temp copy of contracts.
--  * round 3 (fn_settle_accounting_rakeback_stage): one view probe per
--    certificate allocation (~600k; 2.5 ms cold, 0.3 ms warm per allocation).
--  * a union close proves fn_accounting_union_earned_plan up to nine times in
--    one transaction (its agreement pass alone exceeds 45 s warm at Midway).
--  * fn_assert_cash_commission_period called the ghost-twin function for every
--    linked week record.
--
-- WHAT CHANGES (same ledger rows, invoices, receipts, results and refusals)
--  * Each of those proofs is read as sets; every original test is evaluated
--    unchanged on the same rows. Round 2 and round 3 keep their original
--    bodies (round 2 as fn_settle_accounting_commission_stage_v3, round 3 as
--    its unchanged loop) and hand any refusal, or anything the set path cannot
--    read, to them, so an invalid book fails exactly as it always failed.
--  * The statement lists its private bank ledger ids in deposit order (type,
--    banked time, key); the original order was whatever its loop's plan read.
--  * Inside a union close the earned plan is proved once per transaction.
--  * STEP 1: a small partial index of the rakeback/commission legs of
--    chip_ledger for the statement's two ledger reads.
--  * Safety: every close attempt carries a deadline (default 8 minutes,
--    app.weekly_accounting_scope_budget); between stages a close past it ends
--    cleanly (weekly_scope_time_budget_exhausted), its run row failed, nothing
--    posted. The cron close runs at most one close attempt per tick with a
--    20-minute statement budget, so one transaction never holds two books.
--
-- Measurements and the apply procedure: the pull request of fix/weekly-close-scale.
-- Native qualification: scripts/dev/test-weekly-close-scale.sh.

-- ============================================================================
-- STEP 1 - OUTSIDE ANY TRANSACTION
-- ============================================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS chip_ledger_accounting_payout_legs
  ON public.chip_ledger (club_id, created_at) WHERE category IN ('rakeback','commission');

-- ============================================================================
-- STEP 2 - ONE TRANSACTION
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $pre$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid
    WHERE c.relname='chip_ledger_accounting_payout_legs' AND c.relnamespace='public'::regnamespace AND i.indisvalid AND i.indisready) THEN
    RAISE EXCEPTION 'STEP 1 index chip_ledger_accounting_payout_legs missing or INVALID: DROP INDEX CONCURRENTLY IF EXISTS it and re-run STEP 1' USING ERRCODE='55000';
  END IF;
{pre_checks}
  IF to_regprocedure('public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamp with time zone,timestamp with time zone)') IS NOT NULL
   OR to_regprocedure('public.fn_accounting_union_earned_plan_v3(uuid,timestamp with time zone,timestamp with time zone)') IS NOT NULL
   OR to_regprocedure('public.fn_weekly_accounting_deadline_check()') IS NOT NULL THEN
    RAISE EXCEPTION 'weekly close scale objects already present' USING ERRCODE='55000';
  END IF;
END $pre$;

COMMENT ON INDEX public.chip_ledger_accounting_payout_legs IS
 'The rakeback and commission legs of a club, for the weekly statement (fn_club_weekly_accounting_summary) instead of a scan of all of chip_ledger. Do not drop it.';

-- The original round 2, byte-for-byte under a new name: the answer to every
-- book the set path refuses or cannot read.
{body('fn_settle_accounting_commission_stage_v3')}
{body('fn_settle_accounting_commission_stage')}
{body('fn_settle_accounting_rakeback_stage')}
{body('fn_club_weekly_accounting_summary')}
{body('fn_assert_cash_commission_period')}
-- The original earned plan, byte-for-byte under a new name.
{body('fn_accounting_union_earned_plan_v3')}
{body('fn_accounting_union_earned_plan')}
CREATE FUNCTION public.fn_weekly_accounting_attempt_begin(p_memo boolean) RETURNS void
 LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
 -- One close attempt of one book: its deadline, and (for a union) the
 -- earned-plan memo, both transaction-local and cleared by attempt_end.
 PERFORM set_config('app.weekly_accounting_scope_deadline',
  (clock_timestamp()+COALESCE(NULLIF(current_setting('app.weekly_accounting_scope_budget',true),''),'8 minutes')::interval)::text,true);
 PERFORM set_config('app.accounting_close_memo',CASE WHEN p_memo THEN 'on' ELSE '' END,true);
 PERFORM set_config('app.accounting_earned_plan_memo','',true);
END $function$;
CREATE FUNCTION public.fn_weekly_accounting_deadline_check() RETURNS void
 LANGUAGE plpgsql SET search_path TO 'public' AS $function$
DECLARE deadline text:=current_setting('app.weekly_accounting_scope_deadline',true);
BEGIN
 IF deadline IS NOT NULL AND deadline<>'' AND clock_timestamp()>deadline::timestamptz THEN
  RAISE EXCEPTION 'weekly_scope_time_budget_exhausted' USING DETAIL=jsonb_build_object('deadline',deadline,
   'budget',COALESCE(NULLIF(current_setting('app.weekly_accounting_scope_budget',true),''),'8 minutes'),'at',clock_timestamp())::text;
 END IF;
END $function$;
CREATE FUNCTION public.fn_weekly_accounting_attempt_end() RETURNS void
 LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
 PERFORM set_config('app.weekly_accounting_scope_deadline','',true);
 PERFORM set_config('app.accounting_close_memo','',true);
 PERFORM set_config('app.accounting_earned_plan_memo','',true);
END $function$;

DO $patch$
DECLARE src text; needle text;
BEGIN
{patch_block('fn_process_weekly_accounting_scope(uuid,uuid)', COORD_PATCHES)}
{patch_block('fn_union_settlement_cascade(uuid,timestamp with time zone,timestamp with time zone)', CASCADE_PATCHES)}
END $patch$;

-- Every replaced function keeps exactly the access production gives it today.
REVOKE ALL ON FUNCTION public.fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_settle_accounting_rakeback_stage(text,uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_accounting_union_earned_plan(uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_process_weekly_accounting_scope(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_settlement_cascade(uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_assert_cash_commission_period(uuid,uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_assert_cash_commission_period(uuid,uuid,timestamp with time zone,timestamp with time zone) TO service_role;
REVOKE ALL ON FUNCTION public.fn_club_weekly_accounting_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_weekly_accounting_summary(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_accounting_union_earned_plan_v3(uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_weekly_accounting_attempt_begin(boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_weekly_accounting_deadline_check() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_weekly_accounting_attempt_end() FROM PUBLIC, anon, authenticated, service_role;

-- The cron close: one close attempt per tick, a 20-minute statement budget
-- (still the >= 20 minute cron-sized budget the inventory seal requires).
-- The job's active flag is left as it is.
DO $cron$
DECLARE j bigint;
BEGIN
  IF to_regnamespace('cron') IS NULL THEN RETURN; END IF;
  SELECT jobid INTO j FROM cron.job WHERE jobname='union-weekly-rakeback-close';
  IF j IS NULL THEN RAISE EXCEPTION 'cron job union-weekly-rakeback-close missing' USING ERRCODE='55000'; END IF;
  IF (SELECT command FROM cron.job WHERE jobid=j) IS DISTINCT FROM {sqlq(CRON_OLD)} THEN
    RAISE EXCEPTION 'preimage mismatch: union-weekly-rakeback-close command' USING ERRCODE='55000';
  END IF;
  PERFORM cron.alter_job(j, command:={sqlq(CRON_NEW)});
END $cron$;

DO $post$
BEGIN
{post_checks}
{acl_checks}
END $post$;
COMMIT;
"""
Path(sys.argv[1]).write_text(out)
print('wrote', sys.argv[1], len(out))
