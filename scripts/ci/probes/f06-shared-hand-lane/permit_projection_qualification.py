"""Real canonical permit projection; no monetary writes or substituted lane authority."""
import ast
import hashlib
import json

MIGRATION='supabase/migrations/20261029062111_project_the_original_f06_permit_evidence_identity.sql'

def qualify(root,out,cmd,command,run,probe,require,results):
    here=root/'scripts/ci/probes/f06-shared-hand-lane'
    driver=root/'scripts/ci/test-a-tournament-table-s-hand-does-not-wait-for-its-sibling-tables.py'
    tree=ast.parse(driver.read_text())
    schema=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='SCHEMA' for t in n.targets))
    # Roles are cluster-wide and owned by the existing native harness.
    schema=schema[schema.index('CREATE SCHEMA auth;'):]
    original_db=cmd[-1]
    run('projection-database','CREATE DATABASE f06_projection;');cmd[-1]='f06_projection'
    try:
        run('projection-real-shapes',schema)
        run('projection-real-lane-authority',(root/'scripts/ci/fixtures/f06-share-table-lane/lane-authorities.sql').read_text())
        source=(root/'supabase/migrations/20261003230910_a_tournament_table_s_hand_does_not_wait_for_its_sibling_tabl.sql').read_text()
        lane=source[source.index('CREATE FUNCTION public.fn_ca_f06_share_table_lane'):source.index('DO $subs$')]
        run('projection-real-shared-lane',lane)
        run('projection-installed-preimage',(here/'permit-projection-preimage.sql').read_text()+"; REVOKE ALL ON FUNCTION public.fn_f06_hand_number_state(uuid,uuid,uuid) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.fn_f06_hand_number_state(uuid,uuid,uuid) TO service_role;")
        run('projection-seed',"""
INSERT INTO tournaments VALUES(md5('projection-event')::uuid,'RUNNING');
INSERT INTO engine_tournament_leases VALUES(md5('projection-event')::uuid,2,md5('projection-generation')::uuid,now()+interval '1 day');
INSERT INTO tables(id,tournament_id) VALUES(md5('projection-table')::uuid,md5('projection-event')::uuid);
INSERT INTO smarter_private.f06_hand_permits VALUES(md5('projection-permit')::uuid,md5('projection-event')::uuid,md5('projection-table')::uuid,1,100,md5('projection-custody')::uuid,md5('projection-generation')::uuid,'reserved',NULL);
""")
        auth="SET request.jwt.claim.role='service_role'; SET app.smarter_data_actor='tournament-manager'; SELECT set_config('app.smarter_tournament_id',md5('projection-event')::uuid::text,false),set_config('app.smarter_tournament_lease_generation',md5('projection-generation')::uuid::text,false);"
        call="public.fn_f06_hand_number_state(md5('projection-event')::uuid,md5('projection-generation')::uuid,md5('projection-table')::uuid)"
        check="DO $$DECLARE x jsonb:="+call+"; BEGIN IF NOT ((x->'unresolved_permit')?'evidence_id') THEN RAISE EXCEPTION 'PROJECTION_REAL_KEY_MISSING'; END IF; END $$;"
        probe('projection-old-fails-real-key',auth+check,error='PROJECTION_REAL_KEY_MISSING')
        migration=(root/MIGRATION).read_text()
        wrapper="BEGIN;\nSET LOCAL lock_timeout='1s';\nSET LOCAL statement_timeout='5s';\n"
        require(migration.count(wrapper)==1 and migration.endswith('COMMIT;\n'),'exact transaction wrapper required')
        rollback_migration=migration.replace(wrapper,"SET LOCAL lock_timeout='1s';\nSET LOCAL statement_timeout='5s';\n",1)[:-len('COMMIT;\n')]
        proof=migration.split('-- @live-proof: ',1)[1].split('\n',1)[0]
        run('projection-live-proof-before','SELECT '+proof+';', 'f')
        catalog="SELECT md5(pg_get_functiondef(oid)),proacl,proconfig,prosecdef,proowner FROM pg_proc WHERE oid='public.fn_f06_hand_number_state(uuid,uuid,uuid)'::regprocedure;"
        before=run('projection-catalog-before',catalog)
        witness="SELECT jsonb_build_object('permits',(SELECT jsonb_agg(h) FROM smarter_private.f06_hand_permits h),'tables',(SELECT jsonb_agg(t) FROM tables t),'leases',(SELECT jsonb_agg(l) FROM engine_tournament_leases l));"
        data=run('projection-data-before',witness)
        probe('projection-rollback',rollback_migration+auth+check)
        require(run('projection-catalog-rollback',catalog)==before,'projection DDL rollback differed')
        run('projection-install',migration)
        proof=migration.split('-- @live-proof: ',1)[1].split('\n',1)[0]
        run('projection-live-proof','SELECT '+proof+';', 't')
        run('projection-postimage-identities',"SELECT md5(prosrc)||':'||md5(pg_get_functiondef(oid)) FROM pg_proc WHERE oid='public.fn_f06_hand_number_state(uuid,uuid,uuid)'::regprocedure;", 'c71e331cc40d676c931f2d711f2d02a0:570441684fd001cd76d4591e04194b98')
        probe('projection-real-null',auth+check+"DO $$DECLARE x jsonb:="+call+"; BEGIN IF x#>'{unresolved_permit,evidence_id}' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'not actual null'; END IF; END $$;")
        probe('projection-real-nonnull',auth+"UPDATE smarter_private.f06_hand_permits SET evidence_id=md5('real-evidence')::uuid; DO $$DECLARE x jsonb:="+call+"; BEGIN IF x#>>'{unresolved_permit,evidence_id}' IS DISTINCT FROM md5('real-evidence')::uuid::text THEN RAISE EXCEPTION 'evidence identity fabricated'; END IF; END $$;")
        probe('projection-generation-fence',auth+"SELECT public.fn_f06_hand_number_state(md5('projection-event')::uuid,md5('wrong-generation')::uuid,md5('projection-table')::uuid);",error='F06_PROTOCOL2_REQUIRED')
        require(run('projection-data-after',witness)==data,'projection modified row data')
        # Exact reverse substitution proves every other function byte unchanged.
        run('projection-exact-only-difference',"SELECT replace(pg_get_functiondef('public.fn_f06_hand_number_state(uuid,uuid,uuid)'::regprocedure),'''state'',h.state,''evidence_id'',h.evidence_id)','''state'',h.state)') = "+"$pre$"+(here/'permit-projection-preimage.sql').read_text().rstrip('\n')+'\n$pre$;', 't')
        for label,mutation in [('acl','GRANT EXECUTE ON FUNCTION public.fn_f06_hand_number_state(uuid,uuid,uuid) TO anon;'),('body','ALTER FUNCTION public.fn_f06_hand_number_state(uuid,uuid,uuid) SET search_path=public;')]:
            reset=(here/'permit-projection-preimage.sql').read_text()+';'
            probe('projection-refuse-'+label,reset+mutation+rollback_migration,error='F06_PERMIT_PROJECTION_PREIMAGE_CHANGED')
        results['permitProjection']={'passed':True,'old_missing_key_failed':True,'actual_null_and_nonnull':True,'full_function_reverse_identity':True,'data_unchanged':True,'catalog_rollback':True}
        inputs=[driver,here/'permit_projection_qualification.py',here/'permit-projection-preimage.sql',root/MIGRATION,root/'scripts/ci/fixtures/f06-share-table-lane/lane-authorities.sql',root/'supabase/migrations/20261003230910_a_tournament_table_s_hand_does_not_wait_for_its_sibling_tabl.sql']
        results['permitProjection']['source_sha256']={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs}
    finally:
        cmd[-1]=original_db
        run('projection-remove-database','DROP DATABASE f06_projection;')
