"""Install the exact candidate against actual current/qualified-parent source.

The fourth parent is native-only qualified source, not a production installation.
No financial admission is performed by this installer test.
"""
from pathlib import Path
import os,json,subprocess,time,re
p=Path(__file__).resolve().parent;b=p/'fixtures';socket=Path(os.environ['ORB_NATIVE_SOCKET']);pg=Path(os.environ['PG_BIN']);port=os.environ['ORB_NATIVE_PORT'];cmd=[str(pg/'psql'),'-X','-qAt','-h',str(socket),'-p',port,'-U','postgres','-v','ON_ERROR_STOP=1']
def call(sql,expected=None):
 r=subprocess.run(cmd+['-d','inventory_install_native'],input=sql,text=True,capture_output=True,timeout=45)
 if expected:assert r.returncode!=0 and expected in r.stderr,r.stderr
 else:assert r.returncode==0,(r.stdout+r.stderr)[-4000:]
 return r
r=subprocess.run(cmd+['-d','postgres'],input='CREATE DATABASE inventory_install_native TEMPLATE original_source_refs;',text=True,capture_output=True);assert r.returncode==0,r.stderr
s="SET check_function_bodies=off;"+(p/'actual-maintenance-freeze-native.sql').read_text()+(b/'actual-week-start.sql').read_text()
cols=json.loads((b/'inventory245-installer-cash-outcomes-type.json').read_text())['rows'];s+='CREATE TABLE public.union_pnl_cash_outcomes('+','.join(x['column_name']+' '+x['data_type']+(' NOT NULL' if x['not_null'] else '') for x in cols)+');'+(b/'actual-cash-touches-type.sql').read_text()
for x in json.loads((b/'inventory245-installer-six-current-preimages.json').read_text())['rows']:s+=x['body']+';'
s+=(b/'actual-satellite-seat-owner.sql').read_text()
for x in json.loads((b/'inventory245-actual-cache-functions.json').read_text())['rows']:s+=x['body']+';'
s+=(b/'fourth-qualified-native-eleven-creates.sql').read_text()
parent=(b/'qualified-fourth-parent.sql').read_text();s+="INSERT INTO supabase_migrations.schema_migrations(version,statements)VALUES('20261012211046',ARRAY[$qualified_native_parent$"+parent+"$qualified_native_parent$]);"
call(s)
root=p.parents[2];migration=root/'supabase/migrations/20261012224150_original_retirement_evidence_certifies_finite_inventory_boun.sql';source=migration.read_text()
call("INSERT INTO engine_maintenance_break(id,phase,ownership_token,announced_at,break_started_at,break_ends_at,enforce_freeze) VALUES(true,'counting_down',gen_random_uuid(),clock_timestamp()-interval '3 minutes',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '3 minutes',true);")
call(source,'original_inventory_install_frozen');call('DELETE FROM engine_maintenance_break;')
call("UPDATE supabase_migrations.schema_migrations SET statements=ARRAY['wrong qualified parent'] WHERE version='20261012211046';")
call(source,'original_posthand_dependency_not_installed');call("UPDATE supabase_migrations.schema_migrations SET statements=ARRAY[$qualified_native_parent$"+parent+"$qualified_native_parent$] WHERE version='20261012211046';")
call(source.replace('COMMIT;','ROLLBACK;'))
call("DO $b$BEGIN IF to_regclass('smarter_private.original_inventory_restoration_cases') IS NOT NULL THEN RAISE EXCEPTION 'rolledback installer persisted';END IF;END$b$;")
start=time.monotonic();r=call(source);elapsed=time.monotonic()-start
(socket/'inventory-installer-exact.log').write_text(r.stdout+r.stderr);print(r.stdout+r.stderr)
call("DO $b$BEGIN IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true OR (SELECT count(*) FROM smarter_private.original_inventory_restoration_cases)<>245 OR EXISTS(SELECT FROM smarter_private.original_inventory_restoration_certificates) OR EXISTS(SELECT FROM smarter_private.original_erased_cash_base_discharges) OR EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='smarter_private' AND c.relname IN('original_inventory_restoration_cases','original_inventory_restoration_certificates','original_erased_cash_base_discharges') AND (c.relowner<>'postgres'::regrole OR NOT c.relrowsecurity)) THEN RAISE EXCEPTION 'installer schema/source/noadmission postimage differs';END IF;END$b$;")
call(source,'original_inventory_source_preimage_changed')
full=(p/'finite245-corpus-exact-originals.jsonb').read_text()
call("DO $e$BEGIN IF EXISTS(SELECT FROM jsonb_array_elements($full_original$"+full+"$full_original$::jsonb)x FULL JOIN smarter_private.original_inventory_restoration_cases c ON c.event_id=(x->>'event_id')::bigint WHERE c.event_id IS NULL OR x IS NULL OR c.original_witness IS DISTINCT FROM x->'original_witness' OR c.source_refs IS DISTINCT FROM x->'source_refs' OR c.witness_md5 IS DISTINCT FROM md5((x->'original_witness')::text) OR c.family IS DISTINCT FROM x->>'family' OR c.source_name IS DISTINCT FROM x->>'source_name' OR c.row_id::text IS DISTINCT FROM x->>'row_id') THEN RAISE EXCEPTION 'shared corpus reconstruction differs from full original245';END IF;END$e$;")
print('PASS shared46 representation reconstructs exact original245 full witnesses/source refs/identity pins; no omitted originals')

checks=json.loads((p.parents[2]/'scripts/ci/schema-manifest.d/original-inventory-restoration.json').read_text())['functions']
for name in checks:
 name=name if '.' in name else 'public.'+name
 block=re.search(r'CREATE (?:OR REPLACE )?FUNCTION\s+'+re.escape(name)+r'\s*\(.*?(?=\bAS\s+\$)',source,re.S|re.I).group(0)
 expected_path=re.search(r'SET search_path\s*=\s*([^\s]+)',block,re.I).group(1).replace(',',', ')
 definer='true' if name=='public.fn_union_pnl_inventory_as_of_admitted' else 'false'
 verdict=call("SELECT count(*)=1 AND bool_and(p.proowner='postgres'::regrole AND p.prosecdef IS NOT DISTINCT FROM "+definer+" AND array_position(p.proconfig,'search_path="+expected_path+"') IS NOT NULL AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AND NOT has_function_privilege('service_role',p.oid,'EXECUTE')) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='"+name.split('.')[0]+"' AND p.proname='"+name.split('.')[1]+"';")
 assert verdict.stdout.strip()=='t',name+':'+verdict.stdout
call("DO $b$BEGIN IF EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='smarter_private' AND c.relname IN('original_inventory_restoration_cases','original_inventory_restoration_certificates','original_erased_cash_base_discharges') AND(has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') OR has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') OR has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))) OR EXISTS(SELECT FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relname IN('original_inventory_restoration_cases','original_inventory_restoration_certificates','original_erased_cash_base_discharges') AND NOT t.tgisinternal AND t.tgenabled<>'O') THEN RAISE EXCEPTION 'new private ACL/triggers changed';END IF;END$b$;")
metadata=call("SELECT jsonb_agg(jsonb_build_object('function',n.nspname||'.'||p.proname,'owner',p.proowner::regrole::text,'security_definer',p.prosecdef,'config',p.proconfig,'acl',p.proacl) ORDER BY n.nspname,p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='smarter_private' AND p.proname IN("+','.join("'"+x.split('.')[-1]+"'" for x in checks)+");")
print('ACTUAL newfunction catalog',metadata.stdout.strip())
call("DO $b$BEGIN IF (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid IN('smarter_private.original_inventory_restoration_cases'::regclass,'smarter_private.original_inventory_restoration_certificates'::regclass,'smarter_private.original_erased_cash_base_discharges'::regclass))<>6 THEN RAISE EXCEPTION 'immutable trigger cardinality';END IF;END$b$;")
for table in ['original_inventory_restoration_cases','original_inventory_restoration_certificates','original_erased_cash_base_discharges']:
 for operation in ['UPDATE','DELETE','TRUNCATE']:
  statement={'UPDATE':'UPDATE smarter_private.'+table+' SET event_id=event_id','DELETE':'DELETE FROM smarter_private.'+table,'TRUNCATE':'TRUNCATE smarter_private.'+table}[operation]
  call(statement,'immutable')
print('PASS exact224150 installer freeze/history/rollback/install/postguard40/245cases/no certificate or money/replay refusal; native-only qualified fourthparent;',round(elapsed,3),'seconds')
