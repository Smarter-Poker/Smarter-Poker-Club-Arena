#!/usr/bin/env python3
"""Compose the original capture/readers with exact retained movement custody."""
from pathlib import Path
import json,sys
fix=Path(__file__).resolve().parent
root=fix.parents[2]
rows=json.loads((fix/'captured-move-preimages.json').read_text())
path=root/'supabase/migrations/20260918032932_cash_accounting_retains_original_move_funding.sql'
def once(s,a,b):
 assert s.count(a)==1,(a,s.count(a))
 return s.replace(a,b)
def candidate(r):
 s=r['definition'];name=r['signature'].split('(')[0]
 if name=='fn_cash_capture_hand_manifest':
  s=once(s,"v_funding jsonb; v_initial integer;", "v_lineage jsonb; v_funding jsonb; v_initial integer;")
  a=s.index('  SELECT coalesce(jsonb_agg(jsonb_build_object(\'id\',f.id,')
  b=s.index('  IF v_initial<>1 OR v_accounts<>1 THEN',a)
  s=s[:a]+'''  v_lineage:=public.fn_cash_original_funding_lineage(v_user,p_table_id,v_seat,v_occupancy,v_join,clock_timestamp(),false);
  v_funding:=v_lineage->'funding_receipts';
  SELECT count(*) FILTER(WHERE f.operation_kind='buyin'),count(DISTINCT (f.funding_club_id,f.funding_union_id,f.asset))
   INTO v_initial,v_accounts FROM jsonb_array_elements(v_funding) ref
   JOIN public.cash_participant_funding_receipts f ON f.id=(ref->>'id')::uuid;
  IF v_lineage->'issues'<>'[]'::jsonb THEN
   v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','original_cash_move_lineage_unproven','user_id',v_user,'details',v_lineage->'issues'));
   v_complete:=false;
  END IF;
'''+s[b:]
  s=once(s,'WHERE f.occupancy_id=v_occupancy AND f.pending_addon_id IS NOT NULL',"WHERE f.id IN(SELECT (ref->>'id')::uuid FROM jsonb_array_elements(v_funding) ref) AND f.pending_addon_id IS NOT NULL")
  s=once(s,"'is_horse',(x->>'is_horse')::boolean,'funding_receipts',v_funding)","'is_horse',(x->>'is_horse')::boolean,'funding_receipts',v_funding,'funding_lineage',v_lineage)")
 elif name=='fn_pnl_cash_hand_evidence':
  s=once(s,'x jsonb; y jsonb; submitted jsonb;', 'v_lineage jsonb; v_lineage_at timestamptz; x jsonb; y jsonb; submitted jsonb;')
  s=once(s,"  IF jsonb_typeof(x->'funding_receipts') IS DISTINCT FROM 'array'",'''  v_lineage:=NULL;
  IF x ? 'funding_lineage' THEN
   v_lineage_at:=(x#>>'{funding_lineage,observed_at}')::timestamptz;
   IF v_lineage_at IS NULL OR NOT isfinite(v_lineage_at) OR v_lineage_at>m.captured_at THEN v_owned:=false; END IF;
   v_lineage:=public.fn_cash_original_funding_lineage(v_user,p_table_id,(x->>'seat_id')::uuid,
    (x->>'occupancy_id')::uuid,(x->>'seat_joined_at')::timestamptz,v_lineage_at,false);
   IF v_lineage IS DISTINCT FROM x->'funding_lineage' OR v_lineage->'issues'<>'[]'::jsonb
    OR v_lineage->'funding_receipts' IS DISTINCT FROM x->'funding_receipts' THEN v_owned:=false; END IF;
  END IF;
  IF jsonb_typeof(x->'funding_receipts') IS DISTINCT FROM 'array' ''')
  a='''IF f.user_id IS DISTINCT FROM v_user OR f.table_id IS DISTINCT FROM p_table_id
     OR f.seat_id::text IS DISTINCT FROM x->>'seat_id' OR f.occupancy_id::text IS DISTINCT FROM x->>'occupancy_id'
     OR f.seat_joined_at IS DISTINCT FROM (x->>'seat_joined_at')::timestamptz'''
  b='''IF f.user_id IS DISTINCT FROM v_user OR (v_lineage IS NULL AND (f.table_id IS DISTINCT FROM p_table_id
     OR f.seat_id::text IS DISTINCT FROM x->>'seat_id' OR f.occupancy_id::text IS DISTINCT FROM x->>'occupancy_id'
     OR f.seat_joined_at IS DISTINCT FROM (x->>'seat_joined_at')::timestamptz))'''
  s=once(s,a,b)
  s=once(s,"v_funding_account:=jsonb_build_array(f.account_type,f.account_entity_id,f.funding_club_id);", "v_funding_account:=jsonb_build_array(f.funding_club_id,f.funding_union_id,f.asset);")
  s=once(s,"l.to_type IS DISTINCT FROM 'table_stack' OR l.to_entity_id IS DISTINCT FROM p_table_id", "l.to_type IS DISTINCT FROM 'table_stack' OR l.to_entity_id IS DISTINCT FROM f.table_id")
 elif name=='fn_union_pnl_boundary':
  s=once(s,'owned uuid; owners int;', 'lineage jsonb; owned uuid; owners int;')
  a=s.index("  SELECT count(*) FILTER(WHERE operation_kind='buyin'),")
  b=s.index("  value:=public.fn_pnl_evidence_cents(s->'stack');",a)
  s=s[:a]+'''  lineage:=public.fn_cash_original_funding_lineage((s->>'user_id')::uuid,(s->>'table_id')::uuid,
   (s->>'id')::uuid,(s->>'occupancy_id')::uuid,(s->>'joined_at')::timestamptz,p_at,true);
  SELECT count(*) FILTER(WHERE r.operation_kind='buyin'),count(DISTINCT (r.funding_club_id,r.funding_union_id,r.asset)),min(r.funding_club_id::text)::uuid
   INTO initial,owners,owned FROM jsonb_array_elements(lineage->'funding_receipts') ref
   JOIN public.cash_participant_funding_receipts r ON r.id=(ref->>'id')::uuid;
'''+s[b:]
  s=once(s,'IF initial<>1 OR owners<>1 OR owned IS NULL OR value IS NULL OR value<0 THEN',"IF lineage->'issues'<>'[]'::jsonb OR initial<>1 OR owners<>1 OR owned IS NULL OR value IS NULL OR value<0 THEN")
 else: return None
 return s
changed=[r for r in rows if candidate(r)]
header='''-- Original buy-ins remained on source occupancies after legitimate cash moves.
-- Follow the retained original movement receipts without making a new debit,
-- changing beneficiaries, inferring current membership or rewriting history.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preconditions$
BEGIN
'''
for r in changed:
 header+=f" IF md5(pg_get_functiondef('public.{r['signature']}'::regprocedure)) IS DISTINCT FROM '{r['md5']}' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.{r['signature']}'::regprocedure) IS DISTINCT FROM '{r['acl']}' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.{r['signature']}'::regprocedure) IS DISTINCT FROM '{r['owner']}' THEN RAISE EXCEPTION 'original_cash_move_prerequisite_changed:{r['signature']}'; END IF;\n"
header+='END $preconditions$;\n'
parts=[header,(fix/'move-authority.sql').read_text()]
for r in changed:
 parts.append(candidate(r)+';\n')
 parts.append('REVOKE ALL ON FUNCTION public.'+r['signature']+' FROM PUBLIC,anon,authenticated,service_role;\n')
 if 'service_role=' in r['acl']:parts.append('GRANT EXECUTE ON FUNCTION public.'+r['signature']+' TO service_role;\n')
parts.append('COMMIT;\n')
result='\n'.join(parts)
if '--check' in sys.argv:
 assert path.read_text()==result,'Move lineage candidate differs from its original source binding'
 print('PASS original cash move source binding')
else:path.write_text(result);print(path)
