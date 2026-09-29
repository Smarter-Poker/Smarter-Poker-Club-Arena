#!/usr/bin/env python3
"""Builds new/fn_union_pnl_evidence_report.sql from the definition
20260928230637 (#5554) installs, by exact unique replacements, and assembles
the migration and the production dry runs. Usage: build.py [postimage.json] [--nocheck]"""
from pathlib import Path
import json, re, sys
here = Path(__file__).resolve().parent
root = here.parents[2]
base = (here.parent / 'union-pnl-award-owner' / 'new' / 'fn_union_pnl_evidence_report.sql').read_text()
UUID = "'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'"
PAIRS = [
 (" IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','accepted_cash_basis_incomplete','count',v_bad)); END IF;\n",
  """ -- A hand whose provenance link the engine never recorded (its outcome has no
 -- game scope) counts only through its immutable link resolution
 -- (union_pnl_cash_outcome_link_resolutions), in the Union its re-proved scope
 -- names, and is accepted only when its re-proved evidence is certified.
 SELECT v_bad+count(*) FILTER(WHERE NOT (k.evidence->>'status'='ready' AND k.evidence->'basis_certified'='true'::jsonb
   AND k.evidence->'all_players_included'='true'::jsonb)),
  v_resolved+count(*) FILTER(WHERE k.evidence->>'status'='ready' AND k.evidence->'basis_certified'='true'::jsonb
   AND k.evidence->'all_players_included'='true'::jsonb)
 INTO v_bad,v_resolved FROM public.fn_union_pnl_linked_cash_outcomes(p_union_id,p_start,p_end) k;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','accepted_cash_basis_incomplete','count',v_bad)); END IF;
"""),
 (""" SELECT count(*) INTO v_bad FROM public.union_pnl_cash_outcomes WHERE recognized_at>=p_start AND recognized_at<p_end
  AND NOT game_scope ?& ARRAY['game_union_id','host_club_id','tournament_id','is_private','asset','unit_scale'];
""",
  """ SELECT count(*) INTO v_bad FROM public.union_pnl_cash_outcomes WHERE recognized_at>=p_start AND recognized_at<p_end
  AND NOT game_scope ?& ARRAY['game_union_id','host_club_id','tournament_id','is_private','asset','unit_scale']
  AND NOT EXISTS(SELECT 1 FROM public.fn_union_pnl_cash_outcome_link(union_pnl_cash_outcomes));
"""),
 ("""  FROM public.union_pnl_cash_outcomes o CROSS JOIN LATERAL (
   SELECT 0 kind,NULL::uuid club_id,NULL::uuid user_id,NULL::numeric delta,(o.evidence->>'accepted_rake')::numeric rake
   UNION ALL
   SELECT 1,(p->>'earning_club_id')::uuid,(p->>'user_id')::uuid,(p->>'observed_stack_delta')::numeric,NULL::numeric
   FROM jsonb_array_elements(COALESCE(o.evidence->'participants','[]')) p) x
  WHERE o.game_scope->>'game_union_id'=p_union_id::text AND o.recognized_at>=p_start AND o.recognized_at<p_end
  GROUP BY x.kind,x.club_id,x.user_id
""",
  """  FROM (SELECT o.evidence FROM public.union_pnl_cash_outcomes o
   WHERE o.game_scope->>'game_union_id'=p_union_id::text AND o.recognized_at>=p_start AND o.recognized_at<p_end
   -- with this Union's linked hands, through their link resolutions
   UNION ALL SELECT k.evidence FROM public.fn_union_pnl_linked_cash_outcomes(p_union_id,p_start,p_end) k) o CROSS JOIN LATERAL (
   SELECT 0 kind,NULL::uuid club_id,NULL::uuid user_id,NULL::numeric delta,(o.evidence->>'accepted_rake')::numeric rake
   UNION ALL
   SELECT 1,(p->>'earning_club_id')::uuid,(p->>'user_id')::uuid,(p->>'observed_stack_delta')::numeric,NULL::numeric
   FROM jsonb_array_elements(COALESCE(o.evidence->'participants','[]')) p) x
  GROUP BY x.kind,x.club_id,x.user_id
"""),
 (" WHERE (NOT COALESCE(e.has_entry,false) AND i.row_id<>ALL(v_open_resolved)) OR COALESCE(e.has_other,false);\n",
  " WHERE (NOT COALESCE(e.has_entry,false) AND i.row_id<>ALL(v_open_resolved)\n"
  "   AND public.fn_union_pnl_satellite_seat_owner(i.row_id,NULL) IS NULL)\n"
  "  OR COALESCE(e.has_other,false);\n"),
 ("  AND NOT public.fn_union_pnl_award_owner_resolved(c,p_union_id,p_start,v_open_resolved);\n",
  "  AND NOT public.fn_union_pnl_award_owner_resolved(c,p_union_id,p_start,v_open_resolved)\n  AND NOT public.fn_union_pnl_award_satellite_owner(c);\n"),
]
src = base
for old, new in PAIRS:
    n = src.count(old)
    if n != 1: sys.exit(f'needle found {n} times: {old[:80]!r}')
    src = src.replace(old, new)
(here / 'new').mkdir(exist_ok=True)
(here / 'new' / 'fn_union_pnl_evidence_report.sql').write_text(src)
objects = (here / 'objects.sql').read_text()
NOCHECK = '--nocheck' in sys.argv
args = [a for a in sys.argv[1:] if a != '--nocheck']
post = json.loads(Path(args[0]).read_text()) if args and not NOCHECK else {}
REPORT = 'fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)'
FLOW = 'fn_union_pnl_original_flow_evidence(uuid,timestamp with time zone,timestamp with time zone)'
NEW = ['fn_union_pnl_satellite_seat_owner(uuid,uuid)','fn_union_pnl_award_satellite_owner(tournament_accounting_credit_receipts)',
       'fn_union_pnl_cash_outcome_link(union_pnl_cash_outcomes)','fn_union_pnl_linked_cash_outcomes(uuid,timestamp with time zone,timestamp with time zone)',
       'fn_union_pnl_prove_cash_outcome_links(timestamp with time zone,timestamp with time zone)',
       'fn_union_pnl_resolve_cash_outcome_links(timestamp with time zone,timestamp with time zone,text,boolean)']
WRITER = NEW[5]
PRE = {REPORT: ('cfc23476884e4537f47433e65122e5dd', '20260928230637 (#5554)'),
       FLOW: ('5c4d8cb079d19fe08536afd7067b7617', 'the live definition'),
       'fn_union_pnl_boundary(uuid,timestamp with time zone)': ('0e1fb7d6826b5a95ce5e637174017ede', '20260928222109 (#5552)'),
       'fn_union_pnl_award_owner_resolved(tournament_accounting_credit_receipts,uuid,timestamp with time zone,uuid[])': ('639b5a724967f7779f8134275c93dfa1', '20260928230637 (#5554)'),
       'fn_cash_original_funding_lineage(uuid,uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,boolean)': ('a7d96d1627656a46fabe9dba751314c8', 'the live definition')}
pre_checks = '\n'.join(
 f"  IF md5(pg_get_functiondef('public.{s}'::regprocedure)) IS DISTINCT FROM '{h}' THEN\n    RAISE EXCEPTION 'preimage mismatch: {s.split('(')[0]} is not {who}' USING ERRCODE='55000'; END IF;"
 for s, (h, who) in PRE.items())
exists = '\n     OR '.join(f"to_regprocedure('public.{s}') IS NOT NULL" for s in NEW)
post_checks = '\n'.join(
 f"  IF md5(pg_get_functiondef('public.{s}'::regprocedure)) IS DISTINCT FROM '{h}' THEN RAISE EXCEPTION 'postimage mismatch: {s}' USING ERRCODE='55000'; END IF;"
 for s, h in sorted(post.items())) or ("  NULL;" if NOCHECK else "  RAISE EXCEPTION 'postimage digests not generated yet';")
revokes = '\n'.join(f"REVOKE ALL ON FUNCTION public.{s} FROM PUBLIC, anon, authenticated, service_role;" for s in NEW + [REPORT, FLOW])
header = (here / 'migration-header.sql').read_text()
out = f"""{header}
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $pre$
BEGIN
{pre_checks}
  IF to_regclass('public.union_pnl_cash_outcome_link_resolutions') IS NOT NULL
     OR {exists} THEN
    RAISE EXCEPTION 'preimage mismatch: link or satellite objects already exist' USING ERRCODE='55000';
  END IF;
  IF to_regclass('public.union_pnl_opening_registration_resolutions') IS NULL THEN
    RAISE EXCEPTION 'preimage mismatch: 20260928222109 (#5552) is required' USING ERRCODE='55000';
  END IF;
END $pre$;

{objects.rstrip()}

{src.rstrip()};

{revokes}
GRANT EXECUTE ON FUNCTION public.{WRITER} TO service_role;

DO $post$
DECLARE f text;
BEGIN
{post_checks}
  FOREACH f IN ARRAY ARRAY[{', '.join("'public."+s+"'" for s in NEW + [REPORT, FLOW])}] LOOP
    IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') THEN
      RAISE EXCEPTION 'postimage: % is browser-executable',f USING ERRCODE='55000';
    END IF;
  END LOOP;
  IF has_table_privilege('anon','public.union_pnl_cash_outcome_link_resolutions','SELECT')
     OR has_table_privilege('authenticated','public.union_pnl_cash_outcome_link_resolutions','SELECT')
     OR has_table_privilege('service_role','public.union_pnl_cash_outcome_link_resolutions','INSERT') THEN
    RAISE EXCEPTION 'postimage: link resolutions are writable or browser-readable' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.union_pnl_cash_outcome_link_resolutions'::regclass AND tgname='original_pnl_immutable') THEN
    RAISE EXCEPTION 'postimage: link resolutions are not immutable' USING ERRCODE='55000';
  END IF;
  -- No balance column is written here (the money-RPC registry guard's own test).
  IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid IN ({', '.join("'public."+s+"'::regprocedure" for s in NEW + [REPORT, FLOW])})
      AND public.fn_ca_money_rpc_writes_balances(p.prosrc)) THEN
    RAISE EXCEPTION 'postimage: a function here writes balances' USING ERRCODE='55000';
  END IF;
END $post$;

COMMIT;
"""
mig = sorted(root.glob('supabase/migrations/*_a_cash_out_a_lost_link_and_a_satellite_seat_are_proved_from_*.sql'))[0]
mig.write_text(out)
# production dry runs: the proof cores byte for byte, literal arguments
def core(t): return t[t.index('-- CORE BEGIN'):t.index('-- CORE END')]
hc = core(objects)
ARGS = 'WITH args AS MATERIALIZED (SELECT p_start AS s, p_end AS e),'
assert hc.count(ARGS) == 1
(here / 'production-dryrun-links.sql').write_text("-- Read-only (a single SELECT): the link proof core, byte for byte except the argument line.\nSET statement_timeout='44s';\n"
 "SELECT q.table_id,q.hand_number,q.proof->>'status' status,q.proof->>'reason' reason,q.proof->>'roster_source' roster,\n"
 " q.proof#>>'{game_scope,game_union_id}' union_id,q.proof#>>'{evidence,status}' evidence,q.proof#>>'{evidence,accepted_rake}' rake,\n"
 " q.proof#>>'{evidence,observed_delta_total}' delta\nFROM (\n"
 + hc.replace(ARGS, "WITH args AS MATERIALIZED (SELECT '2026-09-21 07:00+00'::timestamptz AS s, '2026-09-28 07:00+00'::timestamptz AS e),") + "-- CORE END\n) q;\n")
print('wrote', mig.name, len(out))
