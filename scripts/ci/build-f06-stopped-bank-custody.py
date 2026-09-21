"""Forward existing custody receipt: actual new-runtime banks, never reconstruction."""
from pathlib import Path
import hashlib
import re
import runpy
import sys
ROOT=Path(__file__).resolve().parents[2]
MIGRATION='supabase/migrations/20260919032212_stopped_mtt_banks_survive_their_original_owner_transfer.sql'
AUTHORITY='scripts/ci/probes/f06-mixed-custody-authority.sql'

def once(s,a,b):
 if s.count(a)!=1:raise ValueError('stopped-bank composition drift: '+a)
 return s.replace(a,b,1)
def definition(s,name):
 return re.search(r'CREATE(?: OR REPLACE)? FUNCTION '+re.escape(name)+r'\(.*?END \$\$;',s,re.S)[0]
def definitions(root=ROOT):
 source=(root/AUTHORITY).read_text()
 retired=runpy.run_path(str(root/'scripts/ci/build-f06-retired-origin.py'))['render'](root)
 old={name:definition(retired if name.startswith('public.') else source,name) for name in (
 'smarter_private.f06_mixed_bank_proof','smarter_private.f06_mixed_custody_snapshot','public.fn_f06_prepare_mixed_manager_custody','smarter_private.f06_mixed_adopt_presence')}
 new={k:re.sub(r'^CREATE(?: OR REPLACE)? FUNCTION','CREATE OR REPLACE FUNCTION',v) for k,v in old.items()}
 k='smarter_private.f06_mixed_bank_proof';s=new[k]
 s=once(s,' value jsonb;',' value jsonb; captured jsonb;')
 s=once(s," banks:=durable#>'{time_bank_snapshot,players}';", """ -- Prior parked evidence remains a CAS input. A new runtime may additionally
 -- retain the actual values it captured before disposal, in this immutable
 -- transfer itself. This is never an inferred replacement for legacy data.
 IF custody ? 'stopped_capture' THEN
 captured:=custody->'stopped_capture';
 IF captured->>'kind' IS DISTINCT FROM 'mtt_pre_disposal_bank_v1'
 OR captured->>'table_id' IS DISTINCT FROM engine->>'table_id'
 OR captured->>'engine_id' IS DISTINCT FROM engine->>'engine_id'
 OR captured->>'tournament_id' IS DISTINCT FROM t::text
 OR captured->>'lifecycle' IS DISTINCT FROM engine->>'lifecycle'
 OR (captured->>'generation')::uuid IS NULL
 OR captured->>'accounting' IS DISTINCT FROM 'acknowledged'
 OR jsonb_typeof(captured->'snapshot') IS DISTINCT FROM 'object'
 OR captured#>>'{snapshot,table_id}' IS DISTINCT FROM engine->>'table_id'
 OR jsonb_typeof(captured#>'{snapshot,disconnect_states}') IS DISTINCT FROM 'object'
 OR captured#>>'{snapshot,time_bank_snapshot,version}' IS DISTINCT FROM '1'
 OR captured#>>'{snapshot,time_bank_snapshot,handNumber}' IS DISTINCT FROM custody->>'hand_number'
 OR captured#>>'{snapshot,parked_at}' IS NULL
 OR NOT isfinite((captured#>>'{snapshot,parked_at}')::timestamptz)
 OR captured#>>'{snapshot,time_bank_snapshot,parkedAt}' IS DISTINCT FROM captured#>>'{snapshot,parked_at}'
 OR captured#>'{snapshot,time_bank_snapshot,players}' IS DISTINCT FROM custody->'parked_time_banks'
 THEN RAISE EXCEPTION 'F06_STOPPED_BANK_CAPTURE_UNPROVEN'; END IF;
 durable:=captured->'snapshot';
 END IF;
 banks:=durable#>'{time_bank_snapshot,players}';""")
 s=once(s," RETURN jsonb_build_object('table_id',engine->>'table_id','custody',custody);", " RETURN jsonb_build_object('table_id',engine->>'table_id','custody',custody,'presence',durable);")
 new[k]=s
 k='smarter_private.f06_mixed_custody_snapshot';s=new[k]
 s=once(s," IF x->>'allocation_epoch' IS NOT NULL AND x->'permit'='null'::jsonb THEN", " IF x->>'allocation_epoch' IS NOT NULL AND x->'permit'='null'::jsonb AND (x->>'lifecycle' IS NULL OR NOT (x->'bank_custody' ? 'stopped_capture')) THEN")
 s=once(s,' PERFORM smarter_private.f06_mixed_bank_proof(t,x);',""" IF x#>'{bank_custody,stopped_capture}' IS NOT NULL THEN
 b:=x#>'{bank_custody,stopped_capture}';
 IF local_proof#>>'{stopped_bank_owner,kind}' IS DISTINCT FROM 'mtt_pre_disposal_bank_v1'
 OR local_proof#>>'{stopped_bank_owner,tournament_id}' IS DISTINCT FROM t::text
 OR local_proof#>>'{stopped_bank_owner,generation}' IS DISTINCT FROM g::text
 OR b->>'generation' IS DISTINCT FROM g::text
 OR COALESCE(local_proof#>>'{stopped_bank_owner,instance_id}','')=''
 OR COALESCE(local_proof#>>'{stopped_bank_owner,version}','') !~ '^[0-9a-f]{8}$'
 OR local_proof#>>'{stopped_bank_owner,version}'='8825af51'
 OR (x#>>'{bank_custody,hand_number}')::bigint IS DISTINCT FROM GREATEST(
 COALESCE((SELECT max(hand_number) FROM public.hand_history WHERE table_id=(x->>'table_id')::uuid),0),
 COALESCE((SELECT max(hand_number) FROM smarter_private.f06_hand_permits WHERE table_id=(x->>'table_id')::uuid),0))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(x#>'{bank_custody,roster}') occupant WHERE NOT EXISTS(
 SELECT 1 FROM public.table_seats seat WHERE seat.table_id=(x->>'table_id')::uuid AND seat.user_id=(occupant->>0)::uuid
 AND seat.occupancy_id=(occupant->>1)::uuid AND seat.seat_number=(occupant->>2)::integer))
 THEN RAISE EXCEPTION 'F06_STOPPED_BANK_ORIGINAL_CHANGED'; END IF;
 END IF;
 PERFORM smarter_private.f06_mixed_bank_proof(t,x);""")
 new[k]=s
 k='public.fn_f06_prepare_mixed_manager_custody';s=new[k]
 s=once(s,' canonical:=smarter_private.f06_mixed_custody_snapshot(p_tournament_id,p_origin_generation,p_local);',""" IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_local->'engines') e WHERE e#>'{bank_custody,stopped_capture}' IS NOT NULL) THEN
 IF retired_origin OR p_local#>>'{stopped_bank_owner,instance_id}' IS DISTINCT FROM l.instance_id
 OR p_local#>>'{stopped_bank_owner,version}' IS DISTINCT FROM l.engine_version
 THEN RAISE EXCEPTION 'F06_STOPPED_BANK_OWNER_CHANGED'; END IF;
 END IF;
 canonical:=smarter_private.f06_mixed_custody_snapshot(p_tournament_id,p_origin_generation,p_local);""")
 new[k]=s
 k='smarter_private.f06_mixed_adopt_presence';s=new[k]
 s=once(s," PERFORM smarter_private.f06_mixed_bank_proof(t,engine);\n custody:=engine->'bank_custody'; durable:=custody->'durable_presence';", " durable:=smarter_private.f06_mixed_bank_proof(t,engine)->'presence';\n custody:=engine->'bank_custody';")
 new[k]=s
 return old,new

def render(root=ROOT):
 old,new=definitions(root);sql='-- Preserve actual pre-disposal banks in the existing immutable owner-transfer receipt.\nBEGIN;\nSET LOCAL lock_timeout=\'1s\';\nSET LOCAL statement_timeout=\'15s\';\nDO $pins$ BEGIN\n'
 args=['uuid,jsonb','uuid,uuid,jsonb','uuid,uuid,uuid,uuid,jsonb,jsonb','uuid,jsonb']
 for (name,definition),arg in zip(old.items(),args):
  body=definition.split('AS $$',1)[1].rsplit('$$;',1)[0]
  acl='{postgres=X/postgres,service_role=X/postgres}' if name.startswith('public.') else '{postgres=X/postgres}'
  sql+=f"IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('{name}({arg})') AND md5(prosrc)='{hashlib.md5(body.encode()).hexdigest()}' AND proowner='postgres'::regrole AND prosecdef AND proacl::text='{acl}' AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN RAISE EXCEPTION 'F06_STOPPED_BANK_DEPENDENCY_DRIFT: {name}'; END IF;\n"
 return sql+'END $pins$;\n'+'\n'.join(new.values())+'\nCOMMIT;\n'
if __name__=='__main__':
 output=render()
 if '--check' in sys.argv:
  if (ROOT/MIGRATION).read_text()!=output:raise SystemExit('Stopped bank migration source changed')
 else:(ROOT/MIGRATION).write_text(output)
