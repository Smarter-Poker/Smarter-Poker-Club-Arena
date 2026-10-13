"""Public-safe exact-source admission/refusal checks; no private hand inputs."""
import hashlib, json
from pathlib import Path

def run(e,db,root):
    here=Path(__file__).parent
    binding=json.loads((here/'typed209-source-binding.json').read_text())
    migration=root/'supabase/migrations/20261013163547_scoped_launch_retained_originals_use_the_installed_typed_row.sql'
    for name,expected in binding['files'].items():
        path=migration if name=='migration' else here/name
        if hashlib.sha256(path.read_bytes()).hexdigest()!=expected:raise RuntimeError('Typed209 source binding mismatch: '+name)
    originals=['original_tournament30_source_correction_proof','cash_original17_source_correction_proof','original_hand_source_correction_proof']
    for name in originals:
        e.sql(db,file=here/(name+'.sql'),label='typed209-current-original-'+name)
    e.sql(db,"REVOKE ALL ON FUNCTION smarter_private.original_hand_source_correction_proof(uuid) FROM PUBLIC,anon,authenticated,service_role;",label='typed209-original-private-ACL')
    baseline="SELECT jsonb_object_agg(proname,md5(pg_get_functiondef(oid))) FROM pg_proc WHERE oid IN('smarter_private.original_tournament30_source_correction_proof(uuid)'::regprocedure,'smarter_private.cash_original17_source_correction_proof(uuid)'::regprocedure)"
    _,before,_=e.sql(db,baseline,label='typed209-original30-17-before')
    component=migration.read_text()
    wrong=component.replace("BEGIN;","BEGIN;ALTER FUNCTION smarter_private.original_hand_source_correction_proof(uuid) SECURITY DEFINER;",1)
    code,_,stderr=e.sql(db,wrong,label='typed209-wrong-original-refused',check=False)
    if code==0 or 'LAUNCH_TYPED_CORRECTION_DISPATCHER_CHANGED' not in stderr:raise RuntimeError('Wrong original source not refused')
    e.sql(db,file=migration,label='typed209-exact-component-compile')
    code,_,stderr=e.sql(db,file=migration,label='typed209-replay-refused',check=False)
    if code==0 or 'LAUNCH_TYPED_CORRECTION_DISPATCHER_CHANGED' not in stderr:raise RuntimeError('Replay not refused')
    _,after,_=e.sql(db,baseline,label='typed209-original30-17-after')
    if before!=after:raise RuntimeError('Existing30/17 proof source changed')
    e.sql(db,"""DO $q$ DECLARE u uuid; role_name text; BEGIN
      FOREACH u IN ARRAY ARRAY['00000000-0000-0000-0000-000000000031','00272a67-8849-4176-8180-1bc5bc68ad6d']::uuid[] LOOP
       IF smarter_private.launch_typed209_source_correction_proof(u) IS NOT NULL THEN RAISE EXCEPTION 'typed209 absent/unlisted accepted';END IF;
      END LOOP;
      FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
       IF has_function_privilege(role_name,'smarter_private.launch_typed209_source_correction_proof(uuid)','EXECUTE') THEN RAISE EXCEPTION 'typed209 private ACL exposed';END IF;
      END LOOP;
      IF EXISTS(SELECT FROM smarter_private.hand_submission_source_corrections) OR EXISTS(SELECT FROM smarter_private.hand_submission_correction_claims) OR EXISTS(SELECT FROM smarter_private.hand_submission_correction_results) THEN RAISE EXCEPTION 'typed209 refusal wrote financial claim';END IF;
    END $q$;""",label='typed209-public-absent-unlisted-private-refusals')
    e.report['typed209_public_safe']={'status':'passed','component_sha256':hashlib.sha256(component.encode()).hexdigest(),'original30_17_unchanged':True,'private_positive_financial_scope':'separately qualified; no private request/card fixtures loaded here'}
    _,catalog,_=e.sql(db,"SELECT jsonb_agg(jsonb_build_object('signature',oid::regprocedure::text,'body_md5',md5(prosrc),'full_md5',md5(pg_get_functiondef(oid)),'owner',pg_get_userbyid(proowner),'secdef',prosecdef,'config',proconfig,'acl',proacl::text) ORDER BY proname) FROM pg_proc WHERE oid IN('smarter_private.launch_typed209_source_correction_proof(uuid)'::regprocedure,'smarter_private.original_hand_source_correction_proof(uuid)'::regprocedure)",label='typed209-final-exact-helper-catalog')
    e.report['typed209_catalog']=catalog
    expected={
      'smarter_private.launch_typed209_source_correction_proof(uuid)':('07656636b07ec049754f7592e26addcb','10ba216676445a9d7d8e2d02b3abc94c',['search_path=pg_catalog, public, smarter_private','TimeZone=UTC']),
      'smarter_private.original_hand_source_correction_proof(uuid)':('f604ff7504222829d1b5b85d299af242','808401fbe1ed27b44c8d454848796317',['search_path=pg_catalog, public, smarter_private'])}
    for row in json.loads(catalog.strip()):
        full,body,config=expected.pop(row['signature'])
        if (row['full_md5'],row['body_md5'],row['config'],row['owner'],row['secdef'],row['acl'])!=(full,body,config,'postgres',False,'{postgres=X/postgres}'):raise RuntimeError('Typed209 runtime postimage mismatch')
        if full not in component or row['signature'] not in component:raise RuntimeError('Typed209 live-proof declaration missing')
    if expected:raise RuntimeError('Typed209 runtime postimage missing')
    if hashlib.sha256(migration.read_bytes()).hexdigest()!=binding['files']['migration']:raise RuntimeError('Typed209 source changed during native qualification')
    followup=root/'supabase/migrations/20261013180855_retained_launch_originals_preserve_their_exact_failed_stack_.sql'
    expected_followup='2d96ace37e810bd058943b01b4b57d1376d5335c8382181d75506c786b878e33'
    if hashlib.sha256(followup.read_bytes()).hexdigest()!=expected_followup:raise RuntimeError('80855 source identity changed')
    original_source=migration.read_text()
    e.sql(db,"INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES('20261013163547','scoped_launch_retained_originals_use_the_installed_typed_row',ARRAY['"+original_source.replace("'","''")+"']);",label='typed209-exact63547-parent-history')
    new=followup.read_text()
    bad=new.replace('BEGIN;',"BEGIN;DELETE FROM supabase_migrations.schema_migrations WHERE version='20261013163547';",1)
    code,_,err=e.sql(db,bad,label='typed209-80855-wrong-parent-refusal',check=False)
    if code==0 or 'LAUNCH_INSTALLED_TYPED_PROOF_HISTORY_REQUIRED' not in err:raise RuntimeError('80855 missing parent not refused by its exact guard')
    e.sql(db,file=followup,label='typed209-exact80855-compile')
    code,_,err=e.sql(db,file=followup,label='typed209-80855-replay-refusal',check=False)
    if code==0 or 'LAUNCH_FAILED_MARKER_PROOF_CHANGED' not in err:raise RuntimeError('80855 replay not refused by its exact guard')
    e.sql(db,"DO $q$ BEGIN IF smarter_private.launch_typed209_source_correction_proof('00272a67-8849-4176-8180-1bc5bc68ad6d') IS NOT NULL OR smarter_private.launch_typed209_source_correction_proof('00000000-0000-0000-0000-000000000031') IS NOT NULL THEN RAISE EXCEPTION '80855 absent/unlisted admitted';END IF;IF has_function_privilege('anon','smarter_private.launch_typed209_source_correction_proof(uuid)','EXECUTE') OR has_function_privilege('authenticated','smarter_private.launch_typed209_source_correction_proof(uuid)','EXECUTE') OR has_function_privilege('service_role','smarter_private.launch_typed209_source_correction_proof(uuid)','EXECUTE') THEN RAISE EXCEPTION '80855 private helper exposed';END IF;IF (SELECT md5(pg_get_functiondef(oid)) FROM pg_proc WHERE oid='smarter_private.launch_typed209_source_correction_proof(uuid)'::regprocedure) IS DISTINCT FROM '1e84786172400901cd0b3382a50afb67' OR (SELECT md5(pg_get_functiondef(oid)) FROM pg_proc WHERE oid='smarter_private.original_hand_source_correction_proof(uuid)'::regprocedure) IS DISTINCT FROM 'f604ff7504222829d1b5b85d299af242' THEN RAISE EXCEPTION '80855 runtime changed';END IF;END $q$;",label='typed209-80855-private-unlisted-runtime')
    _,end,_=e.sql(db,baseline,label='typed209-80855-original30-17-preserved')
    if end!=before:raise RuntimeError('80855 original30/17 changed')
    e.report['typed209_failed_marker_public_safe']={'status':'passed','sha256':expected_followup,'private_actual_failed_positive':'separately qualified by recovery; no private requests/cards loaded'}
