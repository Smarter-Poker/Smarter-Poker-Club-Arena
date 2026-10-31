"""Park retained originals intact; the existing engine pauses at its safe boundary."""
import hashlib,importlib.util
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
MIGRATION='supabase/migrations/20261031034048_diamond_closure_parks_retained_originals_without_disposing_t.sql'
def render():
 spec=importlib.util.spec_from_file_location('diamond_initial_closure',ROOT/'scripts/ci/build-diamond-owner-closure.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
 _,rows=b.render();r=next(x for x in rows if x['proname']=='fn_ca_operator_floor_state');before=r['after']
 old="""   WHERE t.id=p_table_id AND c.closed
    -- Existing original recovery must load and finish before its boundary parks.
    AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits p WHERE p.table_id=t.id AND p.state='reserved')
    AND NOT EXISTS(SELECT 1 FROM public.hand_state_snapshots s WHERE s.table_id=t.id AND NOT s.is_complete)),"""
 new="""   -- Park at the existing engine boundary, including old retained originals.
   -- Their persisted permits, continuations, snapshots and money remain intact.
   -- Recovery must wait for a separately authorized reopening.
   WHERE t.id=p_table_id AND c.closed),"""
 assert before.count(old)==1;after=before.replace(old,new)
 # Preserve the exact installed search_path, rather than guessing its order.
 def proof(value):return "EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_ca_operator_floor_state(uuid)'::regprocedure AND md5(pg_get_functiondef(p.oid))='"+hashlib.md5(value.encode()).hexdigest()+"' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='"+r['acl']+"' AND p.proconfig=ARRAY["+','.join("'"+x.replace("'","''")+"'" for x in r['proconfig'])+"])"
 sql='-- @live-proof: '+proof(after)+"\n-- Owner requests complete Diamond shutdown before any compute resize.\n-- The remaining old originals are parked intact, never refunded or disposed.\nBEGIN;\nSET LOCAL lock_timeout='1s';\nSET LOCAL statement_timeout='5s';\nDO $pin$ BEGIN IF NOT ("+proof(before)+") THEN RAISE EXCEPTION 'DIAMOND_PARK_PREIMAGE_CHANGED';END IF;END $pin$;\n"+after+";\nREVOKE ALL ON FUNCTION public.fn_ca_operator_floor_state(uuid) FROM PUBLIC,anon,authenticated;\nGRANT EXECUTE ON FUNCTION public.fn_ca_operator_floor_state(uuid) TO service_role;\nDO $post$ BEGIN IF NOT ("+proof(after)+") THEN RAISE EXCEPTION 'DIAMOND_PARK_POSTIMAGE_CHANGED';END IF;IF clock_timestamp()-transaction_timestamp()>=interval '8 seconds' THEN RAISE EXCEPTION 'DIAMOND_PARK_INSTALL_BUDGET';END IF;END $post$;\nCOMMIT;\n"
 switches="UPDATE public.ca_arena_settings SET cash_games_enabled=false,tournaments_enabled=false WHERE id=1 AND club_id='002c2d27-9584-4e52-835a-bb2be148fc81';\n"
 sql=sql.replace('DO $post$ BEGIN',switches+'DO $post$ BEGIN')
 sql=sql.replace("IF clock_timestamp()-transaction_timestamp()", "IF NOT EXISTS(SELECT 1 FROM public.ca_arena_settings WHERE id=1 AND club_id='002c2d27-9584-4e52-835a-bb2be148fc81' AND NOT cash_games_enabled AND NOT tournaments_enabled) THEN RAISE EXCEPTION 'DIAMOND_SWITCHES_NOT_CLOSED';END IF;IF clock_timestamp()-transaction_timestamp()")
 sql=sql.replace('-- @live-proof: '+proof(after),'-- @live-proof: '+proof(after)+" AND EXISTS(SELECT 1 FROM public.ca_arena_settings WHERE id=1 AND club_id='002c2d27-9584-4e52-835a-bb2be148fc81' AND NOT cash_games_enabled AND NOT tournaments_enabled)")
 return sql
if __name__=='__main__':(ROOT/MIGRATION).write_text(render())
