#!/usr/bin/env python3
"""Builds new/fn_union_pnl_evidence_report.sql from the definition migration
20260928211132 installs, by exact unique replacements, and assembles the
migration. Usage: build.py [postimage.json] [--nocheck]"""
from pathlib import Path
import json, sys
here = Path(__file__).resolve().parent
root = here.parents[2]
base = (here.parent / 'union-pnl-evidence-fast' / 'new' / 'fn_union_pnl_evidence_report.sql').read_text()
PAIRS = [
 (" v_memo_key text; v_memo jsonb; v_report jsonb; v_flows jsonb;\n",
  " v_memo_key text; v_memo jsonb; v_report jsonb; v_flows jsonb; v_open_resolved uuid[];\n"),
 (" IF v_close->>'status' IS DISTINCT FROM 'ready' THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','closing_basis_incomplete','evidence',v_close)); END IF;\n",
  """ IF v_close->>'status' IS DISTINCT FROM 'ready' THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','closing_basis_incomplete','evidence',v_close)); END IF;
 -- The registrations the opening boundary carried through a valid opening
 -- resolution (union_pnl_opening_registration_resolutions): each one's
 -- original entry is proved from the posted chip ledger, not a funding receipt.
 v_open_resolved:=ARRAY(SELECT (x->>'source_id')::uuid FROM jsonb_array_elements(COALESCE(v_open->'holdings','[]')) x
  WHERE x->>'kind'='deferred_tournament_result' AND x->>'basis'='opening_registration_resolution');
"""),
 (" WHERE NOT COALESCE(e.has_entry,false) OR COALESCE(e.has_other,false);\n",
  " WHERE (NOT COALESCE(e.has_entry,false) AND i.row_id<>ALL(v_open_resolved)) OR COALESCE(e.has_other,false);\n"),
 ("   WHERE r.id IS NULL OR r.asset<>'chips' OR public.fn_union_pnl_tournament_entry_club(r) IS DISTINCT FROM c.credited_club_id OR r.user_id IS DISTINCT FROM c.user_id));\n",
  "   WHERE r.id IS NULL OR r.asset<>'chips' OR public.fn_union_pnl_tournament_entry_club(r) IS DISTINCT FROM c.credited_club_id OR r.user_id IS DISTINCT FROM c.user_id))\n"
  "  AND NOT public.fn_union_pnl_award_owner_resolved(c,p_union_id,p_start,v_open_resolved);\n"),
]
src = base
for old, new in PAIRS:
    n = src.count(old)
    if n != 1: sys.exit(f'needle found {n} times: {old[:80]!r}')
    src = src.replace(old, new)
(here / 'new' / 'fn_union_pnl_evidence_report.sql').write_text(src)
objects = (here / 'objects.sql').read_text()
NOCHECK = '--nocheck' in sys.argv
args = [a for a in sys.argv[1:] if a != '--nocheck']
post = json.loads(Path(args[0]).read_text()) if args and not NOCHECK else {}
REPORT = 'fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)'
AWARD = 'fn_union_pnl_award_owner_resolved(tournament_accounting_credit_receipts,uuid,timestamp with time zone,uuid[])'
BOUNDARY = 'fn_union_pnl_boundary(uuid,timestamp with time zone)'
post_checks = '\n'.join(
 f"  IF md5(pg_get_functiondef('public.{s}'::regprocedure)) IS DISTINCT FROM '{h}' THEN RAISE EXCEPTION 'postimage mismatch: {s}' USING ERRCODE='55000'; END IF;"
 for s, h in sorted(post.items())) or ("  NULL;" if NOCHECK else "  RAISE EXCEPTION 'postimage digests not generated yet';")
header = (here / 'migration-header.sql').read_text()
out = f"""{header}
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $pre$
BEGIN
  -- The report as 20260928211132 (#5551) installs it, and the boundary as
  -- 20260928222109 (#5553) installs it (the resolved holdings' 'basis' mark).
  IF md5(pg_get_functiondef('public.{REPORT}'::regprocedure)) IS DISTINCT FROM '3fda4fe97fac170716fef799ab6c5830' THEN
    RAISE EXCEPTION 'preimage mismatch: fn_union_pnl_evidence_report is not the 20260928211132 definition' USING ERRCODE='55000';
  END IF;
  IF md5(pg_get_functiondef('public.{BOUNDARY}'::regprocedure)) IS DISTINCT FROM '0e1fb7d6826b5a95ce5e637174017ede' THEN
    RAISE EXCEPTION 'preimage mismatch: fn_union_pnl_boundary is not the 20260928222109 definition' USING ERRCODE='55000';
  END IF;
  IF to_regclass('public.union_pnl_opening_registration_resolutions') IS NULL THEN
    RAISE EXCEPTION 'preimage mismatch: opening resolutions (20260928222109) are required' USING ERRCODE='55000';
  END IF;
  IF to_regprocedure('public.{AWARD}') IS NOT NULL THEN
    RAISE EXCEPTION 'preimage mismatch: fn_union_pnl_award_owner_resolved already exists' USING ERRCODE='55000';
  END IF;
END $pre$;

{objects.rstrip()}

{src.rstrip()};

REVOKE ALL ON FUNCTION public.{AWARD} FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.{REPORT} FROM PUBLIC, anon, authenticated, service_role;

DO $post$
BEGIN
{post_checks}
  IF (SELECT proacl::text FROM pg_proc WHERE oid='public.{REPORT}'::regprocedure) IS DISTINCT FROM '{{postgres=X/postgres}}'
     OR (SELECT proacl::text FROM pg_proc WHERE oid='public.{AWARD}'::regprocedure) IS DISTINCT FROM '{{postgres=X/postgres}}' THEN
    RAISE EXCEPTION 'access mismatch: the report and the award predicate are owner-only' USING ERRCODE='55000';
  END IF;
  -- No balance column is written here (the money-RPC registry guard's own test).
  IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid IN ('public.{REPORT}'::regprocedure,'public.{AWARD}'::regprocedure)
      AND public.fn_ca_money_rpc_writes_balances(p.prosrc)) THEN
    RAISE EXCEPTION 'postimage: a report function writes balances' USING ERRCODE='55000';
  END IF;
END $post$;

COMMIT;
"""
mig = sorted(root.glob('supabase/migrations/*_a_resolved_opening_registration_is_the_entry_evidence_for_it.sql'))[0]
mig.write_text(out)
print('wrote', mig.name, len(out))
