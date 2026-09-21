"""Record a bounded historical loss through existing transfer and completion."""
from pathlib import Path
import hashlib
import json
import re
import runpy
import sys
ROOT=Path(__file__).resolve().parents[2]
MIGRATION='supabase/migrations/20260919033536_historical_mtt_bank_loss_uses_one_ordinary_lifetime_session.sql'
AUTHORITY='scripts/ci/probes/f06-historical-bank-loss-authority.sql'
COHORTS='scripts/ci/probes/f06-historical-bank-loss-cohorts.json'

def once(s,a,b):
 if s.count(a)!=1:raise ValueError('historical bank composition drift: '+a)
 return s.replace(a,b,1)
def definition(s,name):
 return re.search(r'CREATE(?: OR REPLACE)? FUNCTION '+re.escape(name)+r'\(.*?END \$\$;',s,re.S)[0]
def definitions(root=ROOT):
 old=runpy.run_path(str(root/'scripts/ci/build-f06-stopped-bank-custody.py'))['definitions'](root)[1]
 new=dict(old)
 k='smarter_private.f06_mixed_bank_proof'
 new[k]=once(new[k]," -- Prior parked evidence remains a CAS input. A new runtime may additionally", " IF custody ? 'historical_loss' THEN\n RETURN smarter_private.f06_historical_loss_bank_proof(t,engine,durable);\n END IF;\n -- Prior parked evidence remains a CAS input. A new runtime may additionally")
 k='smarter_private.f06_mixed_custody_snapshot'
 new[k]=once(new[k],"WHERE e->>'break_id'=o.break_id::text AND e->>'table_id'=o.source_table_id::text AND engine->>'lifecycle'=o.lifecycle::text)) THEN", "WHERE e->>'break_id'=o.break_id::text AND e->>'table_id'=o.source_table_id::text AND engine->>'lifecycle'=o.lifecycle::text) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(smarter_private.f06_historical_loss_pending(t,local_proof,false)) hp WHERE hp#>>'{source,table_id}'=o.source_table_id::text AND hp#>>'{proof,historical_loss,observations,0,original,break_id}'=o.break_id::text)) THEN")
 new[k]=once(new[k],' RETURN result;'," value:=smarter_private.f06_historical_loss_snapshot(t,g,local_proof);\n IF value IS NOT NULL THEN result:=result||jsonb_build_object('historical_loss',value); END IF;\n RETURN result;")
 k='public.fn_f06_prepare_mixed_manager_custody'
 new[k]=once(new[k],' canonical:=smarter_private.f06_mixed_custody_snapshot(p_tournament_id,p_origin_generation,p_local);'," IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_local->'engines') e WHERE e#>'{bank_custody,historical_loss}' IS NOT NULL) AND (NOT retired_origin OR checkpoint IS NULL) THEN\n RAISE EXCEPTION 'F06_HISTORICAL_LOSS_RETIRED_CHECKPOINT_REQUIRED'; END IF;\n canonical:=smarter_private.f06_mixed_custody_snapshot(p_tournament_id,p_origin_generation,p_local);")
 k='smarter_private.f06_mixed_adopt_presence';s=new[k]
 s=once(s,'DECLARE engine jsonb;', 'DECLARE bank_proof jsonb; historical boolean; engine jsonb;')
 s=once(s," FOR engine IN SELECT * FROM jsonb_array_elements(local_proof->'engines') LOOP", " FOR item IN SELECT jsonb_build_object('source',e,'proof',smarter_private.f06_mixed_bank_proof(t,e)) FROM jsonb_array_elements(local_proof->'engines') e UNION ALL SELECT value FROM jsonb_array_elements(smarter_private.f06_historical_loss_pending(t,local_proof,true)) LOOP\n engine:=item->'source';")
 s=once(s," durable:=smarter_private.f06_mixed_bank_proof(t,engine)->'presence';\n custody:=engine->'bank_custody';", """ bank_proof:=item->'proof';
 durable:=bank_proof->'presence'; custody:=engine->'bank_custody';
 historical:=bank_proof ? 'historical_loss';
 IF historical THEN
 -- Only this new normal session uses a completion timestamp. The original raw
 -- custody remains in the immutable transfer; it is never labelled preserved.
 custody:=jsonb_set(custody,'{roster}',bank_proof->'source_roster');
 durable:=jsonb_set(durable,'{parked_at}',to_jsonb(at_time));
 END IF;""")
 s=once(s," item:=COALESCE(targets->table_key,jsonb_build_object('banks','{}'::jsonb,'presence','{}'::jsonb));", """ item:=COALESCE(targets->table_key,jsonb_build_object('banks','{}'::jsonb,'presence','{}'::jsonb));
 IF historical THEN
 item:=item||jsonb_build_object('initializationKind','historical_loss_normal_session_v1',
 'originalReceiptId',engine#>>'{bank_custody,historical_loss,receipt_id}');
 END IF;""")
 s=once(s,"'move_receipt',receipt,'bank',bank,'presence',presence));", "'move_receipt',receipt,'bank',bank,'presence',presence)||CASE WHEN historical THEN jsonb_build_object('historical_loss',bank_proof->'historical_loss') ELSE '{}'::jsonb END);")
 s=once(s,' FOR table_key,item IN SELECT * FROM jsonb_each(targets) ORDER BY key LOOP',""" FOR table_key,item IN SELECT * FROM jsonb_each(targets) ORDER BY key LOOP
 IF item->>'initializationKind'='historical_loss_normal_session_v1' AND EXISTS(
 SELECT 1 FROM public.table_seats seat WHERE seat.table_id=table_key::uuid AND seat.left_at IS NULL AND seat.stack>0
 AND (item#>ARRAY['banks',seat.user_id::text] IS NULL OR item#>>ARRAY['banks',seat.user_id::text,'occupancyId'] IS DISTINCT FROM seat.occupancy_id::text))
 THEN RAISE EXCEPTION 'F06_HISTORICAL_LOSS_DESTINATION_CUSTODY_MISSING'; END IF;""")
 s=once(s,"'handNumber',hand,'players',item->'banks'))", "'handNumber',hand,'players',item->'banks')||CASE WHEN item ? 'initializationKind' THEN jsonb_build_object('initializationKind',item->>'initializationKind','originalReceiptId',item->>'originalReceiptId') ELSE '{}'::jsonb END)")
 new[k]=s
 retired=runpy.run_path(str(root/'scripts/ci/build-f06-retired-origin.py'))['render'](root)
 k='public.fn_f06_mixed_custody_contract';old[k]=definition(retired,k)
 additions=['smarter_private.f06_historical_bank_loss_cohort(uuid)','smarter_private.f06_historical_loss_bank_proof(uuid,jsonb,jsonb)','smarter_private.f06_historical_loss_snapshot(uuid,uuid,jsonb)','smarter_private.f06_historical_loss_pending(uuid,jsonb,boolean)','public.fn_time_bank_allowance_v2(uuid[])']
 new[k]=once(old[k],"('public.fn_f06_mixed_custody_contract()')", "('public.fn_f06_mixed_custody_contract()'),\n "+',\n '.join("('"+x+"')" for x in additions))
 return old,new

def render(root=ROOT):
 old,new=definitions(root)
 sql="-- Unknown old banks remain recorded; one ordinary Lifetime session is materialized only by original completion.\nBEGIN;\nSET LOCAL lock_timeout='1s';\nSET LOCAL statement_timeout='15s';\nDO $pins$ BEGIN\n"
 args=['uuid,jsonb','uuid,uuid,jsonb','uuid,uuid,uuid,uuid,jsonb,jsonb','uuid,jsonb','']
 for (name,source),arg in zip(old.items(),args):
  body=source.split('AS $$',1)[1].rsplit('$$;',1)[0]
  acl='{postgres=X/postgres,service_role=X/postgres}' if name.startswith('public.') else '{postgres=X/postgres}'
  config='search_path=pg_catalog' if name.endswith('_contract') else 'search_path=pg_catalog, public, smarter_private'
  sql+=f"IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('{name}({arg})') AND md5(prosrc)='{hashlib.md5(body.encode()).hexdigest()}' AND proowner='postgres'::regrole AND prosecdef AND proacl::text='{acl}' AND proconfig=ARRAY['{config}']) THEN RAISE EXCEPTION 'F06_HISTORICAL_LOSS_DEPENDENCY_DRIFT: {name}'; END IF;\n"
 allowance=(root/'supabase/migrations/20260907081603_marketplace_phase8_lifetime_vip_unlimited_digital_benefits.sql').read_text().split('CREATE OR REPLACE FUNCTION public.fn_time_bank_allowance_v2',1)[1].split('$function$;',1)[0].split('AS $function$',1)[1]
 sql+=f"IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_time_bank_allowance_v2(uuid[])') AND md5(prosrc)='{hashlib.md5(allowance.encode()).hexdigest()}' AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=public, pg_temp']) THEN RAISE EXCEPTION 'F06_HISTORICAL_LOSS_ALLOWANCE_DRIFT'; END IF;\nEND $pins$;\n"
 cohort="CREATE FUNCTION smarter_private.f06_historical_bank_loss_cohort(t uuid) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $cohort$ SELECT $data$"+json.dumps(json.loads((root/COHORTS).read_text()),separators=(',',':'),sort_keys=True)+"$data$::jsonb->t::text $cohort$;\nREVOKE ALL ON FUNCTION smarter_private.f06_historical_bank_loss_cohort(uuid) FROM PUBLIC,anon,authenticated,service_role;\n"
 return sql+cohort+(root/AUTHORITY).read_text()+'\n'+'\n'.join(new.values())+'\nCOMMIT;\n'
if __name__=='__main__':
 output=render()
 if '--check' in sys.argv:
  if (ROOT/MIGRATION).read_text()!=output:raise SystemExit('Historical bank migration source changed')
 else:(ROOT/MIGRATION).write_text(output)
