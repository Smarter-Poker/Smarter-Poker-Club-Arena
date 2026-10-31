"""Exact live preimages, preserved ACLs and no financial mutations."""
import hashlib,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
MIGRATION='supabase/migrations/20261031031602_diamond_arena_owner_boundary_closure_without_refunds.sql'
CLUB='002c2d27-9584-4e52-835a-bb2be148fc81'
OP='01a18fed-2211-7a62-9416-611dd6e4d96d'
def render():
 rows=json.loads((ROOT/'scripts/ci/fixtures/diamond-owner-closure.json').read_text())
 patches={
 'fn_ca_launch_tournament_held':(' RETURN EXISTS('," IF EXISTS(SELECT 1 FROM public.ca_diamond_arena_owner_closure c WHERE c.club_id=p_club AND c.closed) THEN RETURN true; END IF;\n RETURN EXISTS("),
 'fn_ca_operator_floor_entry_guard':(" (EXISTS("," (EXISTS("),
 }
 changes=[]
 for r in rows:
  old=r['definition']; name=r['proname']; new=old
  if name=='fn_ca_launch_tournament_held':
   new=old.replace(' RETURN EXISTS(',patches[name][1],1)
  elif name=='fn_ca_operator_floor_state':
   anchor="'hold',coalesce("
   addition="""'hold',coalesce(
  (SELECT jsonb_build_object('operation_id',c.operation_id,'mode','park','reason',c.reason)
   FROM public.ca_diamond_arena_owner_closure c JOIN public.tables t ON t.club_id=c.club_id
   WHERE t.id=p_table_id AND c.closed
    -- Existing original recovery must load and finish before its boundary parks.
    AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits p WHERE p.table_id=t.id AND p.state='reserved')
    AND NOT EXISTS(SELECT 1 FROM public.hand_state_snapshots s WHERE s.table_id=t.id AND NOT s.is_complete)),"""
   assert old.count(anchor)==1;new=old.replace(anchor,addition)
  elif name=='fn_ca_operator_floor_entry_guard':
   anchor=' (EXISTS(SELECT 1 FROM public.ca_operator_floor_hold'
   replacement=" (EXISTS(SELECT 1 FROM public.ca_diamond_arena_owner_closure c JOIN public.tables t ON t.club_id=c.club_id WHERE t.id=NEW.table_id AND t.tournament_id IS NULL AND c.closed) OR EXISTS(SELECT 1 FROM public.ca_operator_floor_hold"
   assert old.count(anchor)==1;new=old.replace(anchor,replacement)
  elif name=='fn_ca_lock_tournament_seat_acquisition':
   anchor='  PERFORM public.fn_ca_lock_settlement_lane_for_tournament'
   addition="""  IF EXISTS(SELECT 1 FROM public.ca_diamond_arena_owner_closure c JOIN public.tournaments t ON t.club_id=c.club_id
    WHERE t.id=COALESCE(p_tournament_id,(SELECT tournament_id FROM public.tables WHERE id=p_table_id)) AND c.closed
    AND NOT EXISTS(SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id=t.id AND tp.user_id=p_user_id)) THEN
    RETURN jsonb_build_object('ok',false,'reason','diamond_arena_closed');
  END IF;
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament"""
   assert old.count(anchor)==1;new=old.replace(anchor,addition)
  elif name=='fn_f06_begin_hand':
   anchor=' -- A permit its engine attested absent'
   addition=""" -- Exact existing permit replay above stays lawful; only new hands stop.
 IF EXISTS(SELECT 1 FROM public.ca_diamond_arena_owner_closure c JOIN public.tables t ON t.club_id=c.club_id WHERE t.id=p_table_id AND c.closed) THEN
  RETURN jsonb_build_object('ok',false,'reason','diamond_arena_closed');
 END IF;
 -- A permit its engine attested absent"""
   assert old.count(anchor)==1;new=old.replace(anchor,addition)
  else:raise RuntimeError(name)
  assert old!=new and hashlib.md5(old.encode()).hexdigest()==r['hash']
  r['after']=new;r['post_hash']=hashlib.md5(new.encode()).hexdigest();changes.append(r)
 lit=lambda s:"'"+s.replace("'","''")+"'"
 checks=[]
 sql="""-- Owner October 30: close Diamond games at safe boundaries; no refunds.
-- Existing engine floor boundary consumes this record. Existing unfinished
-- originals retain recovery, settlement, and exact permit replay. No balances,
-- custody, seats, tournament outcomes or historical hands are rewritten.
-- No expiry, automatic reopening, cancellation, refund, cash-out or repair loop.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
CREATE TABLE public.ca_diamond_arena_owner_closure (
 club_id uuid PRIMARY KEY,
 operation_id uuid NOT NULL UNIQUE,
 closed boolean NOT NULL,
 reason text NOT NULL,
 requested_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
ALTER TABLE public.ca_diamond_arena_owner_closure ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_diamond_arena_owner_closure FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.ca_diamond_arena_owner_closure TO service_role;
"""
 sql+="INSERT INTO public.ca_diamond_arena_owner_closure VALUES('"+CLUB+"','"+OP+"',true,'Diamond Arena Closed By Owner. Finish Existing Hands Safely. No Refunds.',transaction_timestamp());\n"
 for r in changes:
  sig=r['nspname']+'.'+r['proname']+'('+','.join(a.strip().split()[-1] for a in r['args'].split(',')) +')' if r['args'] else r['nspname']+'.'+r['proname']+'()'
  predicate=lambda h:"EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure("+lit(sig)+") AND md5(pg_get_functiondef(p.oid))="+lit(h)+" AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text="+lit(r['acl'])+" AND p.proconfig=ARRAY["+','.join(lit(x) for x in r['proconfig'])+"])"
  sql+="DO $pin$ BEGIN IF NOT ("+predicate(r['hash'])+") THEN RAISE EXCEPTION 'DIAMOND_CLOSURE_PREIMAGE_CHANGED: "+r['proname']+"'; END IF; END $pin$;\n"+r['after']+";\n"
  checks.append(predicate(r['post_hash']))
 proof=' AND '.join(checks)+" AND EXISTS(SELECT 1 FROM public.ca_diamond_arena_owner_closure WHERE club_id='"+CLUB+"' AND operation_id='"+OP+"' AND closed)"
 sql+="DO $post$ BEGIN IF NOT ("+proof+") THEN RAISE EXCEPTION 'DIAMOND_CLOSURE_POSTIMAGE_CHANGED'; END IF; IF clock_timestamp()-transaction_timestamp()>=interval '8 seconds' THEN RAISE EXCEPTION 'DIAMOND_CLOSURE_INSTALL_BUDGET'; END IF; END $post$;\nCOMMIT;\n"
 return '-- @live-proof: '+proof+'\n'+sql,changes
if __name__=='__main__':
 sql,_=render();(ROOT/MIGRATION).write_text(sql)
