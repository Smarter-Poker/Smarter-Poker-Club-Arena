"""Exact allocated installer DO, isolated native OID metadata adaptation only.

Production installer bytes retain their real OIDs. This native-only loader
rebinds the one entire expected_metadata JSON to a frozen actual native pg_proc
before-image, then proves its exact inverse. No predicate or GEN hash changes.
"""
import hashlib,json,re

def build(R,F):
    p=R/'supabase/migrations/20261030051108_standalone_paid_rakeback_preparation_reuses_its_completed_or.sql'
    migration=p.read_text()
    assert hashlib.sha256(p.read_bytes()).hexdigest()=='612b8bae47b7d24ee63afb2de7033ec72346c33c28153daf42dd14f43e0bd7ff'
    assert migration.count('BEGIN;')==1 and migration.rstrip().endswith('COMMIT;')
    assert all(x in migration for x in ["SET LOCAL transaction_timeout='15s';","SET LOCAL statement_timeout='5s';","SET LOCAL lock_timeout='1s';"])
    start=migration.index('DO $standalone_paid_prepare$')
    body=migration[start:migration.index('END $standalone_paid_prepare$;',start)+len('END $standalone_paid_prepare$;')]
    original=re.search(r'\$prepare_metadata\$(.*?)\$prepare_metadata\$',body,re.S).group(1)
    captured=json.loads((F/'actual-before-owner.json').read_text())['metadata']
    assert json.loads(original)=={k:v for k,v in captured.items()if k!='prosrc'},'production metadata authority drift'
    # The source JSON is separately frozen by the exact migration SHA; no
    # production OID is claimed to be meaningful in this isolated cluster.
    def lit(s):return "'"+s.replace("'","''")+"'"
    sql=[migration[migration.index("SET LOCAL transaction_timeout="):start]];cases=[]
    sql.append("SELECT caw_assert(current_setting('transaction_timeout')='15s'AND current_setting('statement_timeout')='5s'AND current_setting('lock_timeout')='1s','allocated installer effective native caps');")
    for owner in json.loads((F/'generation-owner-authority.json').read_text()):
        sql.append('SET check_function_bodies=off;'+owner['definition']+';')
    sql.append("CREATE TEMP TABLE spr_installer_baseline AS SELECT to_jsonb(p)-'prosrc'meta,pg_get_functiondef(p.oid)definition,(SELECT jsonb_agg(jsonb_build_object('signature',x.oid::regprocedure::text,'metadata',to_jsonb(x),'definition',pg_get_functiondef(x.oid))ORDER BY x.proname)FROM pg_proc x WHERE x.oid IN('smarter_private.original_inventory_proof_sources_match()'::regprocedure,'smarter_private.original_inventory_basis_generation()'::regprocedure))generations FROM pg_proc p WHERE p.oid='public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure;")
    sql.append("CREATE TEMP TABLE spr_installer_source AS SELECT "+lit(body)+"original,"+lit(original)+"production_meta,replace("+lit(body)+","+lit(original)+",(SELECT meta::text FROM spr_installer_baseline))adapted;")
    sql.append("SELECT caw_assert((SELECT replace(adapted,(SELECT meta::text FROM spr_installer_baseline),production_meta)=original FROM spr_installer_source),'exact inverse native expected-metadata-only adaptation');")
    def add(name,code):sql.append(code);cases.append({'case':'standalone-paid-installer-'+name,'passed':True})
    def refuse(name,mutation,expected,expression='(SELECT adapted FROM spr_installer_source)'):
        add(name,"DO $installer_case$DECLARE target text:="+expression+";BEGIN RAISE NOTICE 'INSTALLER_CASE:"+name+"';BEGIN "+mutation+';EXECUTE target'+";RAISE EXCEPTION 'expected_installer_refusal_missing:"+name+"';EXCEPTION WHEN OTHERS THEN IF position("+lit(expected)+"in SQLERRM)=0 THEN RAISE;END IF;END;PERFORM caw_assert((SELECT meta=(SELECT to_jsonb(p)-'prosrc'FROM pg_proc p WHERE p.oid='fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure)AND definition=pg_get_functiondef('fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure)FROM spr_installer_baseline),'installer refusal rolls back definition/fullmetadata');END $installer_case$;")
    refuse('already-installed-version',"INSERT INTO supabase_migrations.schema_migrations(version)VALUES('20261030051108')",'standalone_paid_prepare_version_already_installed')
    refuse('preimage-drift',"EXECUTE replace((SELECT definition FROM spr_installer_baseline),'DECLARE','DECLARE -- native wrong body'||chr(10))",'standalone_paid_prepare_exact_preimage_or_authority_changed')
    refuse('acl-drift','GRANT EXECUTE ON FUNCTION fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)TO service_role','standalone_paid_prepare_exact_preimage_or_authority_changed')
    refuse('maintenance-freeze',"EXECUTE 'CREATE OR REPLACE FUNCTION public.fn_platform_frozen()RETURNS boolean LANGUAGE sql STABLE AS $freeze$SELECT true$freeze$'",'standalone_paid_prepare_maintenance_refused')
    refuse('operator-role','SET LOCAL ROLE authenticated','standalone_paid_prepare_operator_required')
    for sig in ['smarter_private.original_inventory_proof_sources_match()','smarter_private.original_inventory_basis_generation()']:
        mutate="EXECUTE replace(pg_get_functiondef('"+sig+"'::regprocedure),'AS $function$','AS $function$ -- native changed generation owner'||chr(10))"
        refuse('generation-source-drift-'+sig.split('.')[-1].split('(')[0],mutate,'standalone_paid_prepare_generation_source_changed')
    # Mutate only the final postcondition hash, after EXECUTE d has happened.
    marker="IF md5(pg_get_functiondef('public.fn_prepare_accounting_week"
    idx=body.index(marker)
    broken=body[:idx]+body[idx:].replace('39a7e057da9a65dab5d0b2f761428f13','00000000000000000000000000000000',1)
    expression='replace('+lit(broken)+','+lit(original)+',(SELECT meta::text FROM spr_installer_baseline))'
    refuse('post-ddl-failure-rolls-back-all',"PERFORM 1",'standalone_paid_prepare_exact_postimage_or_authority_changed',expression)
    add('exact-installed-body-fullmetadata-acl-generation-retained',"DO $positive$BEGIN EXECUTE(SELECT adapted FROM spr_installer_source);PERFORM caw_assert(md5(pg_get_functiondef('fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure))='39a7e057da9a65dab5d0b2f761428f13'AND(SELECT meta=(SELECT to_jsonb(p)-'prosrc'FROM pg_proc p WHERE oid='fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure)FROM spr_installer_baseline),'postimage and exact full metadata');PERFORM caw_assert((SELECT generations=(SELECT jsonb_agg(jsonb_build_object('signature',x.oid::regprocedure::text,'metadata',to_jsonb(x),'definition',pg_get_functiondef(x.oid))ORDER BY x.proname)FROM pg_proc x WHERE x.oid IN('smarter_private.original_inventory_proof_sources_match()'::regprocedure,'smarter_private.original_inventory_basis_generation()'::regprocedure))FROM spr_installer_baseline),'both original GEN definitions/fullmetadata retained');END $positive$;")
    add('replay-refuses-installed-postimage',"DO $replay$BEGIN BEGIN EXECUTE(SELECT adapted FROM spr_installer_source);RAISE EXCEPTION 'installer_replay_wrongly_accepted';EXCEPTION WHEN OTHERS THEN IF position('standalone_paid_prepare_exact_preimage_or_authority_changed'in SQLERRM)=0 THEN RAISE;END IF;END;END $replay$;")
    return sql,cases
