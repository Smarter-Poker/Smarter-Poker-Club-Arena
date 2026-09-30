#!/usr/bin/env python3
"""Assembles the union P&L evidence migration from new/ and indexes.sql.
Usage: gen-migration.py <migration path> [postimage.json]"""
from pathlib import Path
import hashlib, json, re, sys
here = Path(__file__).resolve().parent
PRE = {  # md5(pg_get_functiondef) read from production 2026-09-28
 'fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)': ('fn_union_pnl_evidence_report', 'e42a295828a8d21d5be083c6a7ae4a15'),
 'fn_union_pnl_boundary(uuid,timestamp with time zone)': ('fn_union_pnl_boundary', 'be154af9a391203d46ae54e5c318141f'),
 'fn_weekly_accounting_attempt_begin(boolean)': ('fn_weekly_accounting_attempt_begin', '96e8c69092908fbe9526963e9012b3e0'),
 'fn_weekly_accounting_attempt_end()': ('fn_weekly_accounting_attempt_end', 'b7d27aa978a1b8db3a98921d6af82588'),
 # read, not replaced: the new bodies restate their semantics (returns, flows,
 # entry club, acceptance) or are their callers (close quality, qualified clubs)
 'fn_union_pnl_tournament_returns(uuid,uuid,timestamp with time zone,timestamp with time zone)': ('fn_union_pnl_tournament_returns', '065c90de9bd14ae893dcb96bff0a3be1'),
 'fn_union_pnl_original_flow_evidence(uuid,timestamp with time zone,timestamp with time zone)': ('fn_union_pnl_original_flow_evidence', '5c4d8cb079d19fe08536afd7067b7617'),
 'fn_union_pnl_tournament_entry_club(tournament_participant_funding_receipts)': ('fn_union_pnl_tournament_entry_club', 'b49d259721d3eb9c1d8ba7061fd28b7e'),
 'fn_union_pnl_cash_outcome_accepted(union_pnl_cash_outcomes)': ('fn_union_pnl_cash_outcome_accepted', '7e443fd75f3b1ece7cd0713a6b8fc0a5'),
 'fn_union_pnl_close_quality(uuid,timestamp with time zone,timestamp with time zone)': ('fn_union_pnl_close_quality', '8b5551d177b27bcbd211b8ecd9ee3a11'),
 'fn_union_pnl_qualified_clubs(uuid,timestamp with time zone,timestamp with time zone)': ('fn_union_pnl_qualified_clubs', '2fed6a15cdb5186d19e3cee731b8d804'),
 'fn_accounting_union_earned_plan(uuid,timestamp with time zone,timestamp with time zone)': ('fn_accounting_union_earned_plan', '409eade1f18decea288db84784f127b2'),
 # the only writer of framed inventory events, and the frame it stamps them with
 'fn_union_pnl_inventory_observe()': ('fn_union_pnl_inventory_observe', '11c7c788d943a11375a15819e78873ba'),
 'fn_union_pnl_original_frame()': ('fn_union_pnl_original_frame', '9a6559774cc1ed4ed49b315a3428abdb'),
}
REPLACED = ['fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)', 'fn_union_pnl_boundary(uuid,timestamp with time zone)',
            'fn_weekly_accounting_attempt_begin(boolean)', 'fn_weekly_accounting_attempt_end()']
post = json.loads(Path(sys.argv[2]).read_text()) if len(sys.argv) > 2 else {}
def body(name): return (here / 'new' / f'{name}.sql').read_text().rstrip('\n') + ';\n'
idx_sql = (here / 'indexes.sql').read_text()
idx = re.findall(r'CREATE INDEX IF NOT EXISTS (\w+) ON (public\.\w+) (.*?);', idx_sql, re.S)
step1 = '\n'.join(f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {n} ON {t} {d};" for n, t, d in idx)
pre_checks = '\n'.join(
 f"  IF md5(pg_get_functiondef('public.{sig}'::regprocedure)) IS DISTINCT FROM '{h}' THEN RAISE EXCEPTION 'preimage mismatch: {name or sig}' USING ERRCODE='55000'; END IF;"
 for sig, (name, h) in PRE.items())
idx_checks = '\n'.join(
 f"  IF NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('public.{n}') AND i.indisvalid AND i.indisready) THEN\n"
 f"    RAISE EXCEPTION 'STEP 1 index {n} missing or INVALID: DROP INDEX CONCURRENTLY IF EXISTS public.{n}; then re-run STEP 1' USING ERRCODE='55000'; END IF;"
 for n, t, d in idx)
post_checks = '\n'.join(
 f"  IF md5(pg_get_functiondef('public.{sig}'::regprocedure)) IS DISTINCT FROM '{h}' THEN RAISE EXCEPTION 'postimage mismatch: {sig}' USING ERRCODE='55000'; END IF;"
 for sig, h in sorted(post.items())) or "  RAISE EXCEPTION 'postimage digests not generated yet';"
acl = '\n'.join(f"REVOKE ALL ON FUNCTION public.{s} FROM PUBLIC, anon, authenticated, service_role;" for s in REPLACED)
acl_checks = '\n'.join(
 f"  IF (SELECT proacl::text FROM pg_proc WHERE oid='public.{s}'::regprocedure) IS DISTINCT FROM '{{postgres=X/postgres}}' THEN RAISE EXCEPTION 'access mismatch: {s}' USING ERRCODE='55000'; END IF;"
 for s in REPLACED)
header = (here / 'migration-header.sql').read_text()
out = f"""{header}
-- ============================================================================
-- STEP 1 - OUTSIDE ANY TRANSACTION (each statement commits on its own; none
-- blocks writers). Re-running it is harmless.
-- ============================================================================
{step1}

-- ============================================================================
-- STEP 2 - ONE TRANSACTION
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $pre$
BEGIN
{idx_checks}
{pre_checks}
END $pre$;

{body('fn_union_pnl_boundary')}
{body('fn_union_pnl_evidence_report')}
{body('fn_weekly_accounting_attempt_begin')}
{body('fn_weekly_accounting_attempt_end')}
-- Production access, restated: owner only, as before.
{acl}

DO $post$
BEGIN
{post_checks}
{acl_checks}
END $post$;
COMMIT;
"""
Path(sys.argv[1]).write_text(out)
ops = here.parents[2] / 'scripts/ops/build-union-pnl-evidence-indexes-concurrently.sql'
ops.write_text("""-- STEP 1 of migration """ + Path(sys.argv[1]).name + """, as its own script.
-- Run outside any transaction (psql autocommit), not during the :55 break
-- window (platform DDL guard). Each statement commits on its own and never
-- blocks writers; IF NOT EXISTS makes a re-run harmless. An index left
-- INVALID by a cancelled build: DROP INDEX CONCURRENTLY IF EXISTS it, re-run.
-- The migration's STEP 2 refuses to start until all of them are valid.
SET statement_timeout = '15min';
SET lock_timeout = '180s';
""" + step1 + "\n")
print('wrote', ops)
print('wrote', sys.argv[1], len(out), 'bytes')
