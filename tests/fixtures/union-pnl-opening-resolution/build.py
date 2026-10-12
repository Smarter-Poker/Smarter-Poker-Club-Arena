#!/usr/bin/env python3
"""Builds new/fn_union_pnl_boundary.sql from the definition migration
20260928211132 (#5551) installs, by exact unique replacements, and assembles
the migration and the production dry run.
Usage: build.py [postimage.json]"""
from pathlib import Path
import json, sys
here = Path(__file__).resolve().parent
root = here.parents[2]
base = (here.parent / 'union-pnl-evidence-fast' / 'new' / 'fn_union_pnl_boundary.sql').read_text()
PAIRS = [
 (" nonchips boolean; changed boolean; returned numeric;\n",
  " nonchips boolean; changed boolean; returned numeric; res_club uuid; res_amount numeric;\n"),
 ("""  IF first_op IS DISTINCT FROM 'INSERT' THEN
   issues:=issues||jsonb_build_array(jsonb_build_object('reason','open_tournament_precedes_original_population','tournament_id',t->'id')); CONTINUE;
  END IF;
""",
  """  -- A tournament captured as the baseline (it existed before the original
  -- inventory capture) is read only when every registration of its original
  -- population carries a valid opening resolution for this boundary
  -- (union_pnl_opening_registration_resolutions: its entry re-proved from the
  -- posted chip ledger, bound to these exact population rows). Otherwise it is
  -- refused exactly as before.
  IF first_op IS DISTINCT FROM 'INSERT' AND (first_op IS DISTINCT FROM 'baseline' OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(COALESCE(inv#>'{population,tournament_players}','[]')) y(x)
    WHERE y.x#>>'{row,tournament_id}'=t->>'id'
     AND (SELECT e.operation FROM public.union_pnl_inventory_events e WHERE e.source_name='tournament_players'
       AND e.row_id=(y.x#>>'{row,id}')::uuid ORDER BY e.event_id LIMIT 1) IS DISTINCT FROM 'INSERT'
     AND NOT EXISTS(SELECT 1 FROM public.fn_union_pnl_opening_registration_resolution(p_union_id,p_at,t,y.x->'row')))) THEN
   issues:=issues||jsonb_build_array(jsonb_build_object('reason','open_tournament_precedes_original_population','tournament_id',t->'id')); CONTINUE;
  END IF;
"""),
 ("  FOR s,entries,owners,owned,value,nonchips,changed,returned IN\n",
  "  FOR s,entries,owners,owned,value,nonchips,changed,returned,res_club,res_amount IN\n"),
 ("    k.changed,k.returned\n   FROM players p\n",
  "    k.changed,k.returned,rr.owning_club_id,rr.deferred_amount\n   FROM players p\n"),
 ("   ORDER BY p.ord\n  LOOP\n",
  """   LEFT JOIN LATERAL (SELECT q.owning_club_id,q.deferred_amount
    FROM public.fn_union_pnl_opening_registration_resolution(p_union_id,p_at,t,p.s) q WHERE first_op='baseline') rr ON true
   ORDER BY p.ord
  LOOP
   -- In a baseline tournament a resolved registration is carried at its
   -- re-proved original entry less its returns before the boundary.
   IF res_club IS NOT NULL THEN
    holdings:=holdings||jsonb_build_array(jsonb_build_object('club_id',res_club,'user_id',s->'user_id','amount',res_amount,
     'kind','deferred_tournament_result','source_id',s->'id','basis','opening_registration_resolution'));
    CONTINUE;
   END IF;
"""),
]
src = base
for old, new in PAIRS:
    n = src.count(old)
    if n != 1: sys.exit(f'needle found {n} times: {old[:80]!r}')
    src = src.replace(old, new)
(here / 'new').mkdir(exist_ok=True)
(here / 'new' / 'fn_union_pnl_boundary.sql').write_text(src)
objects = (here / 'objects.sql').read_text()
NOCHECK = '--nocheck' in sys.argv  # digest discovery only; never committed
post = json.loads(Path(sys.argv[1]).read_text()) if len(sys.argv) > 1 and not NOCHECK else {}
PRE_BOUNDARY = '52682459bd047ad5aea7c454f3ae8c5e'  # postimage of 20260928211132 (#5551)
NEW_FUNCS = ['fn_union_pnl_opening_registration_resolution(uuid,timestamp with time zone,jsonb,jsonb)',
             'fn_union_pnl_prove_opening_registrations(uuid,timestamp with time zone)',
             'fn_union_pnl_resolve_opening_registrations(uuid,timestamp with time zone,text,boolean)']
BOUNDARY = 'fn_union_pnl_boundary(uuid,timestamp with time zone)'
post_checks = '\n'.join(
 f"  IF md5(pg_get_functiondef('public.{s}'::regprocedure)) IS DISTINCT FROM '{h}' THEN RAISE EXCEPTION 'postimage mismatch: {s}' USING ERRCODE='55000'; END IF;"
 for s, h in sorted(post.items())) or ("  NULL;" if NOCHECK else "  RAISE EXCEPTION 'postimage digests not generated yet';")
header = (here / 'migration-header.sql').read_text()
exists = ' OR '.join(f"to_regprocedure('public.{s}') IS NOT NULL" for s in NEW_FUNCS)
out = f"""{header}
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $pre$
BEGIN
  -- Built on the definition migration 20260928211132 (#5551) installs: apply
  -- that one first. On the pre-#5551 definition (be154af9a391203d46ae54e5c318141f)
  -- this refuses and changes nothing.
  IF md5(pg_get_functiondef('public.{BOUNDARY}'::regprocedure)) IS DISTINCT FROM '{PRE_BOUNDARY}' THEN
    RAISE EXCEPTION 'preimage mismatch: fn_union_pnl_boundary is not the 20260928211132 (#5551) definition' USING ERRCODE='55000';
  END IF;
  IF to_regclass('public.union_pnl_opening_registration_resolutions') IS NOT NULL OR {exists} THEN
    RAISE EXCEPTION 'preimage mismatch: opening resolution objects already exist' USING ERRCODE='55000';
  END IF;
  IF to_regclass('public.union_pnl_inventory_checkpoints') IS NULL OR to_regclass('public.union_pnl_inventory_checkpoint_rows') IS NULL
     OR to_regprocedure('public.fn_union_pnl_inventory_immutable()') IS NULL THEN
    RAISE EXCEPTION 'preimage mismatch: sealed inventory checkpoints are required' USING ERRCODE='55000';
  END IF;
END $pre$;

{objects.rstrip()}

{src.rstrip()};

REVOKE ALL ON FUNCTION public.{NEW_FUNCS[0]} FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.{NEW_FUNCS[1]} FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.{NEW_FUNCS[2]} FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.{NEW_FUNCS[2]} TO service_role;
REVOKE ALL ON FUNCTION public.{BOUNDARY} FROM PUBLIC, anon, authenticated, service_role;

DO $post$
DECLARE f text;
BEGIN
{post_checks}
  FOREACH f IN ARRAY ARRAY['public.{NEW_FUNCS[0]}','public.{NEW_FUNCS[1]}','public.{NEW_FUNCS[2]}','public.{BOUNDARY}'] LOOP
    IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') THEN
      RAISE EXCEPTION 'postimage: % is browser-executable',f USING ERRCODE='55000';
    END IF;
  END LOOP;
  IF has_function_privilege('service_role','public.{NEW_FUNCS[1]}','EXECUTE') OR has_function_privilege('service_role','public.{BOUNDARY}','EXECUTE') THEN
    RAISE EXCEPTION 'postimage: prover or boundary is service-executable' USING ERRCODE='55000';
  END IF;
  IF has_table_privilege('anon','public.union_pnl_opening_registration_resolutions','SELECT')
     OR has_table_privilege('authenticated','public.union_pnl_opening_registration_resolutions','SELECT')
     OR has_table_privilege('service_role','public.union_pnl_opening_registration_resolutions','INSERT')
     OR has_table_privilege('service_role','public.union_pnl_opening_registration_resolutions','UPDATE') THEN
    RAISE EXCEPTION 'postimage: opening resolutions are writable or browser-readable' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.union_pnl_opening_registration_resolutions'::regclass AND tgname='original_pnl_immutable') THEN
    RAISE EXCEPTION 'postimage: opening resolutions are not immutable' USING ERRCODE='55000';
  END IF;
  -- No balance column is written here (the money-RPC registry guard's own test).
  IF EXISTS(
     SELECT 1 FROM pg_proc p WHERE p.oid IN ('public.{NEW_FUNCS[2]}'::regprocedure,'public.{BOUNDARY}'::regprocedure)
      AND public.fn_ca_money_rpc_writes_balances(p.prosrc)) THEN
    RAISE EXCEPTION 'postimage: a resolution function writes balances' USING ERRCODE='55000';
  END IF;
END $post$;

COMMIT;
"""
mig = sorted(root.glob('supabase/migrations/*_an_opening_registration_is_resolved_from_its_ledger_entry.sql'))[0]
mig.write_text(out)
# the production dry run: the prover core, byte for byte, with literal arguments
core = objects[objects.index('-- CORE BEGIN'):objects.index('-- CORE END')]
ARGS = 'WITH args AS MATERIALIZED (SELECT p_union_id AS union_id, p_at AS boundary),'
assert core.count(ARGS) == 1
for name, at in (('0921', '2026-09-21 07:00+00'), ('0928', '2026-09-28 07:00+00')):
    body = core.replace(ARGS, f"WITH args AS MATERIALIZED (SELECT 'fade0000-0000-0000-0000-000000000001'::uuid AS union_id, '{at}'::timestamptz AS boundary),")
    (here / f'production-dryrun-{name}.sql').write_text(
     "-- Read-only (a single SELECT). Midway Union at " + at + ": the migration's proof core,\n"
     "-- byte for byte except the argument line (test-union-pnl-opening-resolution.sh checks it).\n"
     "SET statement_timeout='44s';\n"
     "SELECT q.proof->>'status' status,q.proof->>'reason' reason,q.proof->>'registration_first_operation' first_op,(q.proof->>'zero_cost_entry')::boolean zero_cost,\n"
     " count(*) registrations,count(DISTINCT q.tournament_id) tournaments,sum((q.proof->>'entry_amount')::numeric) entry,\n"
     " sum((q.proof->>'returned')::numeric) returned,sum((q.proof->>'deferred_amount')::numeric) deferred\n"
     "FROM (\n" + body + "-- CORE END\n) q GROUP BY 1,2,3,4 ORDER BY 1,2,3,4;\n")
print('wrote', mig.name, len(out))
