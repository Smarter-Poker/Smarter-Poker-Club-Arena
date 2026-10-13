"""Actual40 source identity composition, not financial helper execution."""
from pathlib import Path
import os,json,subprocess,hashlib,re,select,time
P=Path(__file__).resolve().parent;N=Path(os.environ['RF_NATIVE_OUTPUT']);R=P.parents[2]
cmd=[str(Path(os.environ['PG_BIN'])/'psql'),'-X','-qAt','-h',os.environ['RF_NATIVE_SOCKET'],'-p',os.environ['RF_NATIVE_PORT'],'-U','postgres','-d',os.environ.get('RF_NATIVE_DB','postgres'),'-v','ON_ERROR_STOP=1']
def call(sql,name,expected=None):
 (N/(name+'.sql')).write_text(sql)
 r=subprocess.run(cmd,input=sql,text=True,capture_output=True,timeout=35);(N/(name+'.stdout')).write_text(r.stdout);(N/(name+'.stderr')).write_text(r.stderr)
 if expected:assert r.returncode!=0 and expected in r.stderr,(name,r.stderr)
 else:assert r.returncode==0,(name,r.stderr[-3000:])
 return r
sources=json.loads((P/'current-source40.json').read_text());owners=json.loads((P/'current-owner-functions.json').read_text());assert len(sources)==40
bootstrap="SET check_function_bodies=false;DO $roles$BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon;END IF;IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated;END IF;IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role;END IF;END$roles$;CREATE SCHEMA IF NOT EXISTS smarter_private;"+(P/'maintenance-type-source.sql').read_text()
for row in sources+owners:
 assert row['owner']=='postgres'
 bootstrap+=row['definition'].rstrip()+';ALTER FUNCTION '+row['signature']+' OWNER TO postgres;REVOKE ALL ON FUNCTION '+row['signature']+' FROM PUBLIC,anon,authenticated,service_role;'
 if 'service_role=X/postgres' in row['acl']:bootstrap+='GRANT EXECUTE ON FUNCTION '+row['signature']+' TO service_role;'
call(bootstrap,'installer-real40-bootstrap')
call("SELECT smarter_private.original_inventory_proof_sources_match();",'source40-before')
assert (N/'source40-before.stdout').read_text().strip()=='t'
source=(R/'supabase/migrations/20261013063142_original_refund_evidence_scans_its_application_lineage_once.sql').read_text()
# Temporary metadata fault injections are isolated and restored by connection rollback.
checks=[("SET LOCAL request.jwt.claims='{\"role\":\"service_role\"}';",'original_rf_operator_refused','jwt'),("SET LOCAL ROLE service_role;",'original_rf_operator_refused','role'),("ALTER FUNCTION public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz) SECURITY INVOKER;",'original_rf_preimage_refused','security'),("GRANT EXECUTE ON FUNCTION public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz) TO anon;",'original_rf_preimage_refused','acl'),("ALTER FUNCTION public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz) SET search_path=public;",'original_rf_preimage_refused','path'),("ALTER FUNCTION public.fn_union_week_start(timestamptz) VOLATILE;",'original_rf_preimage_refused','source40_drift')]
for setup,expected,name in checks:call(source.replace('BEGIN;', 'BEGIN;SET LOCAL check_function_bodies=false;'+setup,1),name,expected)
call("INSERT INTO engine_maintenance_break(id,phase,ownership_token,announced_at,break_started_at,break_ends_at,enforce_freeze) VALUES(true,'counting_down',gen_random_uuid(),clock_timestamp()-interval '3 minutes',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '3 minutes',true);",'freeze-set')
call(source,'frozen','original_rf_freeze_refused');call('DELETE FROM engine_maintenance_break;','freeze-clear')
# Existing weekly-owner advisory key is refused without waiting or disturbing its owner.
owner=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
try:
 owner.stdin.write("BEGIN;DO $held$BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0));END$held$;\n\\echo RF_OWNER_HELD\n");owner.stdin.flush()
 deadline=time.monotonic()+5;ready=False
 while time.monotonic()<deadline:
  if select.select([owner.stdout],[],[],max(0,deadline-time.monotonic()))[0]:
   if owner.stdout.readline().strip()=='RF_OWNER_HELD':ready=True;break
 assert ready,'native original reader owner not observed held'
 call(source,'reader-owned','original_rf_reader_owned')
finally:
 if owner.poll() is None:
  owner.stdin.write('ROLLBACK;\n\\q\n');owner.stdin.flush();owner.communicate(timeout=5)
 assert owner.returncode==0,'native reader owner cleanup failed'
# Force SQL NULL from the real frozen helper via isolated transaction only; fail closed.
freeze=next(x for x in sources if x['signature']=='public.fn_platform_frozen()')['definition']
nullfreeze=re.sub(r'AS \$function\$[\s\S]*?\$function\$', 'AS $function$ SELECT NULL::boolean; $function$',freeze)
call(source.replace('BEGIN;', 'BEGIN;SET LOCAL check_function_bodies=false;'+nullfreeze+';',1),'null-freeze','original_rf_freeze_refused')
call(source.replace('BEGIN;','BEGIN;SET LOCAL check_function_bodies=false;',1).replace('COMMIT;','ROLLBACK;'),'exact-trial')
assert call('SELECT md5(pg_get_functiondef(\'public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)\'::regprocedure));','trial-absent').stdout.strip()=='308cbce5cddd70d9158c0ffa0220cb43'
call(source.replace('BEGIN;','BEGIN;SET LOCAL check_function_bodies=false;',1),'exact-install')
call(source,'replay','original_rf_preimage_refused')
meta=call("SELECT jsonb_agg(jsonb_build_object('signature',x.s,'full_md5',md5(pg_get_functiondef(p.oid)),'acl',p.proacl::text,'owner',p.proowner::regrole::text,'secdef',p.prosecdef,'config',p.proconfig,'volatility',p.provolatile) ORDER BY x.s) FROM(VALUES('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'),('smarter_private.original_inventory_proof_sources_match()'))x(s) JOIN pg_proc p ON p.oid=to_regprocedure(x.s);",'postimage')
assert call('SELECT smarter_private.original_inventory_proof_sources_match();','source40-after').stdout.strip()=='t'
result={'scope':'actual source40 definition/security/installation metadata, no financial helper execution or production timing','source40':40,'classification_cases':26,'guard_refusals':[x[2] for x in checks]+['frozen','null-freeze','reader-owned','replay'],'trial_rolled_back':True,'postimage':json.loads(meta.stdout),'migration_bytes':len(source.encode()),'migration_md5':hashlib.md5(source.encode()).hexdigest(),'migration_sha256':hashlib.sha256(source.encode()).hexdigest()};(N/'installer-result.json').write_text(json.dumps(result,indent=2)+'\n');print('PASS actual40/source security guards/NULL freeze/rollback/exact install/replay')
