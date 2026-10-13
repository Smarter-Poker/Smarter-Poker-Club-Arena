"""Exact source40 + protectedRF successor installation; metadata only."""
from pathlib import Path
import json,os,subprocess,re,select,time,hashlib
P=Path(__file__).resolve().parent;R=P.parents[2];O=Path(os.environ['ELIG_NATIVE_OUTPUT']);O.mkdir(parents=True,exist_ok=True)
cmd=[str(Path(os.environ['PG_BIN'])/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',os.environ['ELIG_NATIVE_SOCKET'],'-p',os.environ['ELIG_NATIVE_PORT'],'-U','postgres','-d',os.environ['ELIG_NATIVE_DB']]
def call(sql,name,error=None):
 (O/(name+'.sql')).write_text(sql);r=subprocess.run(cmd,input=sql,text=True,capture_output=True,timeout=35);(O/(name+'.stdout')).write_text(r.stdout);(O/(name+'.stderr')).write_text(r.stderr)
 if error:assert r.returncode!=0 and error in r.stderr,(name,r.stderr[-2500:])
 else:assert r.returncode==0,(name,r.stderr[-2500:])
 return r.stdout.strip()
sources=json.loads((P/'current-source40.json').read_text());helpers=json.loads((P/'actual-helpers.json').read_text());assert len(sources)==40
setup="SET check_function_bodies=false;CREATE SCHEMA IF NOT EXISTS smarter_private;"+(P/'maintenance-type-source.sql').read_text()+';'
for row in sources:
 setup+=row['definition'].rstrip()+';ALTER FUNCTION '+row['signature']+' OWNER TO postgres;REVOKE ALL ON FUNCTION '+row['signature']+' FROM PUBLIC,anon,authenticated,service_role;'
 if 'service_role=X/postgres' in row['acl']:setup+='GRANT EXECUTE ON FUNCTION '+row['signature']+' TO service_role;'
setup+=(P/'before-flow.sql').read_text()+(P/'before-matcher.sql').read_text()
setup+='REVOKE ALL ON FUNCTION public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz),smarter_private.original_inventory_proof_sources_match() FROM PUBLIC,anon,authenticated,service_role;'
for row in helpers:
 sig='public.'+row['signature'];setup+=row['definition'].rstrip()+';REVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC,anon,authenticated,service_role;'
 if 'service_role=X/postgres' in row['acl']:setup+='GRANT EXECUTE ON FUNCTION '+sig+' TO service_role;'
parent=(R/'supabase/migrations/20261013063142_original_refund_evidence_scans_its_application_lineage_once.sql').read_text()
setup+="CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,statements text[] NOT NULL);INSERT INTO supabase_migrations.schema_migrations VALUES('20261013063142',ARRAY[$parent$"+parent+'$parent$]);'
call(setup,'installer-real40-current-parent-bootstrap');assert call('SELECT smarter_private.original_inventory_proof_sources_match();','source40-before')=='t'
source=(R/'supabase/migrations/20261013084856_original_flow_proofs_run_only_for_their_eligible_receipts.sql').read_text();pre='BEGIN;SET LOCAL check_function_bodies=false;'
checks=[("SET LOCAL request.jwt.claims='{\"role\":\"service_role\"}';",'flow_eligibility_operator_refused','jwt'),("SET LOCAL request.jwt.claim.role='service_role';",'flow_eligibility_operator_refused','jwt-role'),("SET LOCAL request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';",'flow_eligibility_operator_refused','jwt-sub'),('SET LOCAL ROLE service_role;','flow_eligibility_operator_refused','caller-role'),("INSERT INTO supabase_migrations.schema_migrations VALUES('20261013084856',ARRAY['old']);",'flow_eligibility_history_replay','own-history'),("DELETE FROM supabase_migrations.schema_migrations WHERE version='20261013063142';",'flow_eligibility_parent_history_refused','missing-parent'),("UPDATE supabase_migrations.schema_migrations SET statements=statements||ARRAY['extra'];",'flow_eligibility_parent_history_refused','parent-extra-statement'),("UPDATE supabase_migrations.schema_migrations SET statements=ARRAY['wrong'];",'flow_eligibility_parent_history_refused','parent-wrong-bytes'),("ALTER FUNCTION public.fn_union_pnl_prove_late_settlement(uuid) SECURITY INVOKER;",'flow_eligibility_preimage_refused','late-security'),("REVOKE EXECUTE ON FUNCTION public.fn_union_pnl_prove_late_settlement(uuid) FROM service_role;",'flow_eligibility_preimage_refused','late-service-acl'),("GRANT EXECUTE ON FUNCTION public.fn_union_pnl_prove_late_settlement(uuid) TO anon;",'flow_eligibility_preimage_refused','late-browser-acl'),("ALTER FUNCTION public.fn_union_pnl_prove_late_settlement(uuid) SET search_path=public;",'flow_eligibility_preimage_refused','late-path'),("ALTER FUNCTION public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz) VOLATILE;",'flow_eligibility_source40_refused','flow-volatility'),("ALTER FUNCTION public.fn_union_week_start(timestamptz) VOLATILE;",'flow_eligibility_source40_refused','unchanged-source40-drift')]
for injection,error,name in checks:call(source.replace('BEGIN;',pre+injection,1),name,error)
call("INSERT INTO engine_maintenance_break(id,phase,ownership_token,announced_at,break_started_at,break_ends_at,enforce_freeze) VALUES(true,'counting_down',gen_random_uuid(),clock_timestamp()-interval '3 minutes',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '3 minutes',true);",'freeze-on');call(source,'frozen','flow_eligibility_freeze_refused');call('DELETE FROM engine_maintenance_break;','freeze-off')
freeze=next(x for x in sources if x['signature']=='public.fn_platform_frozen()')['definition'];null=re.sub(r'AS \$function\$[\s\S]*?\$function\$','AS $function$ SELECT NULL::boolean; $function$',freeze)
call(source.replace('BEGIN;',pre+null+';',1),'null-freeze','flow_eligibility_freeze_refused')
owner=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
try:
 owner.stdin.write("BEGIN;DO $$BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0));END$$;\n\\echo ELIGIBILITY_OWNER_HELD\n");owner.stdin.flush();deadline=time.monotonic()+5;ready=False
 while time.monotonic()<deadline:
  if select.select([owner.stdout],[],[],max(0,deadline-time.monotonic()))[0] and owner.stdout.readline().strip()=='ELIGIBILITY_OWNER_HELD':ready=True;break
 assert ready;call(source,'original-reader-owned','flow_eligibility_reader_owned')
finally:
 if owner.poll() is None:owner.stdin.write('ROLLBACK;\n\\q\n');owner.stdin.flush();owner.communicate(timeout=5)
 assert owner.returncode==0
call(source.replace('BEGIN;',pre,1).replace('COMMIT;','ROLLBACK;'),'whole-installer-trial')
assert call("SELECT md5(pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure));",'trial-restored')=='5477b968656e1179aa25d7ec9bc527ca'
call(source.replace('BEGIN;',pre,1),'whole-installer-commit')
assert call('SELECT smarter_private.original_inventory_proof_sources_match();','source40-after')=='t'
call(source,'whole-installer-replay','flow_eligibility_source40_refused' if False else 'flow_eligibility_preimage_refused')
meta=call("SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'full_md5',md5(pg_get_functiondef(p.oid)),'body_md5',md5(p.prosrc),'acl',p.proacl::text,'config',p.proconfig,'owner',p.proowner::regrole::text,'secdef',p.prosecdef,'volatility',p.provolatile) ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.oid IN('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure,'smarter_private.original_inventory_proof_sources_match()'::regprocedure,'public.fn_union_pnl_prove_late_settlement(uuid)'::regprocedure,'public.fn_cash_original_funding_lineage(uuid,uuid,uuid,uuid,timestamptz,timestamptz,boolean)'::regprocedure);",'final-four-source-security')
(O/'installer-result.json').write_text(json.dumps({'scope':'Actualsource40/currentRF/actual2helper metadata composition; no financial writer/productiontiming','source40':True,'beforeflow':'5477b968656e1179aa25d7ec9bc527ca','refusals':[x[2] for x in checks]+['frozen','null-freeze','original-reader-owned','replay'],'rollback':True,'replay_refused':True,'postimage':json.loads(meta),'migration_bytes':len(source.encode()),'md5':hashlib.md5(source.encode()).hexdigest(),'sha256':hashlib.sha256(source.encode()).hexdigest()},indent=2))
print('PASS exactsource40/4metadata/perrowACL/parenthistory/operator/thaw/ownedreader/rollback/install/replay')
