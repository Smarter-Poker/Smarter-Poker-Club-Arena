"""Native retained-actor recovery in the existing isolated PG17 qualification."""
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
import time


def qualify(root, fixture, query):
    user = '00000000-0000-4000-8000-000000000095'
    email = 'ca-customization-cert-postdeploy-ledger@example.invalid'
    club = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'
    e2e = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'
    sig = 'public.cleanup_reserved_certification_account(uuid)'
    captured = json.loads((fixture/'protected-ledger-preimage.json').read_text())
    migration = next((root/'supabase/migrations').glob('*_reserved_protected_ledger_actors_reach_auth_retirement.sql')).read_text()
    after = (fixture/'protected-ledger-cleanup-after.sql').read_text()
    query("""ALTER TABLE club_members ADD COLUMN held_chips numeric DEFAULT 0,
      ADD COLUMN locked_chips integer DEFAULT 0, ADD COLUMN credit_used numeric DEFAULT 0,
      ADD COLUMN credit_limit numeric DEFAULT 0, ADD COLUMN agent_id uuid, ADD COLUMN parent_agent_id uuid;
      ALTER TABLE accounting_conversations ADD COLUMN conversation_id uuid;
      CREATE TABLE social_conversations(id uuid PRIMARY KEY);
      CREATE FUNCTION public.fn_club_membership_lock(p_user_id uuid) RETURNS void LANGUAGE sql
        SET search_path TO 'pg_catalog' AS $$ SELECT pg_advisory_xact_lock(hashtextextended(p_user_id::text,77431)) $$;
    """)
    query(captured['definition'])
    assert query(f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure));") == captured['definition_md5']
    query(f"INSERT INTO auth.users(id,email) VALUES('{user}','{email}'); INSERT INTO profiles(id,email) VALUES('{user}','{email}'); INSERT INTO users VALUES('{user}'); INSERT INTO diamond_wallets(user_id) VALUES('{user}'); INSERT INTO auth.sessions(user_id) VALUES('{user}'); INSERT INTO auth.refresh_tokens(user_id) VALUES('{user}'); INSERT INTO club_members(club_id,user_id,role) VALUES('{club}','{user}','admin'),('{e2e}','{user}','admin');")
    query("SET request.jwt.claims='{\"role\":\"service_role\"}';" + f"INSERT INTO chip_ledger(performed_by,amount) VALUES('{user}',100000),('{user}',100),('{user}',200);")

    def call():
        return f"SELECT public.cleanup_reserved_certification_account('{user}');"

    def ledger():
        return query('SELECT md5(jsonb_agg(to_jsonb(l) ORDER BY id)::text) FROM chip_ledger l;')

    def state():
        return query(f"SELECT jsonb_build_object('members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY club_id) FROM club_members m WHERE user_id='{user}'),'auth',(SELECT to_jsonb(u) FROM auth.users u WHERE id='{user}'),'ledger',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM chip_ledger l));")

    def catalog():
        return query("SELECT jsonb_build_object('functions',(SELECT jsonb_agg(jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig) ORDER BY oid) FROM pg_proc WHERE oid IN('public.cleanup_reserved_certification_account(uuid)'::regprocedure,'public.fn_deep_stack_society_cannot_be_deleted_by_accident()'::regprocedure,'public.fn_ca_certification_identity_retired(uuid)'::regprocedure)),'triggers',(SELECT jsonb_agg(to_jsonb(t) ORDER BY oid) FROM pg_trigger t WHERE tgfoid='public.fn_deep_stack_society_cannot_be_deleted_by_accident()'::regprocedure));")

    before = state()
    meta = catalog()
    immutable = ledger()
    query(call(), 'CERTIFICATION_PROTECTED_MEMBERSHIP_HAS_AUTHORITY_OR_CUSTODY')
    assert state() == before
    print('protected-ledger-fail-before-reproduced')
    query(migration.replace('COMMIT;', "DO $$ BEGIN RAISE EXCEPTION 'fixture rollback'; END $$; COMMIT;"), 'fixture rollback')
    assert query(f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure));") == captured['definition_md5']
    query('ALTER FUNCTION '+sig+" SET statement_timeout='9min';")
    query(migration, 'CERTIFICATION_PROTECTED_LEDGER_PREIMAGE_CHANGED')
    query('ALTER FUNCTION '+sig+" SET statement_timeout='10min';")
    query('GRANT EXECUTE ON FUNCTION '+sig+' TO authenticated;')
    query(migration, 'CERTIFICATION_PROTECTED_CLEANUP_AUTHORITY_CHANGED')
    query('REVOKE EXECUTE ON FUNCTION '+sig+' FROM authenticated;')
    query('ALTER TABLE club_members DISABLE TRIGGER trg_deep_stack_members_are_protected;')
    query(migration, 'CERTIFICATION_PROTECTED_CLUB_GUARD_CHANGED')
    query('ALTER TABLE club_members ENABLE TRIGGER trg_deep_stack_members_are_protected;')
    query(migration)
    assert catalog() == meta
    assert query(f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure));") == hashlib.md5(after.encode()).hexdigest()
    query(migration, 'CERTIFICATION_PROTECTED_LEDGER_PREIMAGE_CHANGED')
    for role in ['anon','authenticated']:
        query('SET ROLE '+role+';'+call(), 'permission denied')

    def refused(setup, error, undo):
        query(setup)
        snapshot = state()
        query(call(), error)
        assert state() == snapshot and ledger() == immutable
        query(undo)

    custody = 'CERTIFICATION_PROTECTED_MEMBERSHIP_HAS_AUTHORITY_OR_CUSTODY'
    for column in ['chip_balance','promo_balance','held_chips','locked_chips','credit_used','credit_limit']:
        for value in ['1','-1','NULL']:
            refused(f"UPDATE club_members SET {column}={value} WHERE user_id='{user}';", custody, f"UPDATE club_members SET {column}=0 WHERE user_id='{user}';")
    for column in ['agent_id','parent_agent_id']:
        refused(f"UPDATE club_members SET {column}='{user}' WHERE user_id='{user}';", custody, f"UPDATE club_members SET {column}=NULL WHERE user_id='{user}';")
    for table,column in [('clubs','owner_id'),('unions','owner_id'),('agents','user_id'),('table_seats','user_id'),('tournament_players','user_id')]:
        refused(f"INSERT INTO {table}({column}) VALUES('{user}');",custody,f"DELETE FROM {table} WHERE {column}='{user}';")
    for column in ['balance','locked_balance']:
        for value in ['1','-1','NULL']:
            refused(f"INSERT INTO wallets(user_id,{column}) VALUES('{user}',{value});",custody,f"DELETE FROM wallets WHERE user_id='{user}';")
    for column in ['from_entity_id','to_entity_id']:
        query('BEGIN; SET request.jwt.claims=\'{"role":"service_role"}\';'+f"INSERT INTO chip_ledger(performed_by,{column},amount) VALUES('{user}','{user}',1);"+call(),custody)
        assert state() == before
    query('BEGIN;'+f"INSERT INTO accounting_cash_rake_sources VALUES('{user}');"+call(),custody)
    refused(f"UPDATE auth.users SET email='real@example.com' WHERE id='{user}';",'CERTIFICATION_PROTECTED_MEMBERSHIP_IDENTITY_REFUSED',f"UPDATE auth.users SET email='{email}' WHERE id='{user}';")
    for column,value,undo in [('role',"'god'","'user'"),('is_admin','true','false'),('is_horse','true','false')]:
        refused(f"UPDATE profiles SET {column}={value} WHERE id='{user}';",'CERTIFICATION_PROTECTED_MEMBERSHIP_PROFILE_REFUSED',f"UPDATE profiles SET {column}={undo} WHERE id='{user}';")
    query('UPDATE freeze_fixture SET active=true;')
    assert json.loads(query(call())) == {'success':False,'reason':'platform_is_frozen'}
    assert state() == before
    query('UPDATE freeze_fixture SET active=false;')
    query("BEGIN; SELECT set_config('app.deep_stack_teardown','sentinel',true); "+call()+" SELECT current_setting('app.deep_stack_teardown'); ROLLBACK;")
    assert state() == before
    # A concurrent join is excluded before any identity/member row lock.
    with ThreadPoolExecutor(max_workers=2) as pool:
        holder=pool.submit(query,"SET application_name='protected-ledger-holder'; BEGIN; "+call()+" SELECT pg_sleep(2); ROLLBACK;")
        for _ in range(100):
            if query("SELECT count(*) FROM pg_stat_activity WHERE application_name='protected-ledger-holder' AND wait_event='PgSleep';") == '1':
                break
            time.sleep(.02)
        else:
            raise AssertionError('Cleanup never reached locked boundary')
        query("SET lock_timeout='100ms'; SELECT public.fn_club_membership_lock('"+user+"');",'lock timeout')
        holder.result()
    assert state() == before
    outcome=json.loads(query('SET ROLE service_role;'+call()))
    assert outcome == {'success':False,'reason':'auth_soft_delete_required','user_id':user,'email':email}
    assert ledger() == immutable
    assert query(f"SELECT count(*) FROM club_members WHERE user_id='{user}';") == '0'
    assert query(f"SELECT count(*) FROM auth.users WHERE id='{user}' AND deleted_at IS NULL;") == '1'
    # Model the supported GoTrue transaction, never a production SQL write.
    query(f"BEGIN; UPDATE auth.users SET email='deleted-{user}',encrypted_password='',deleted_at=now() WHERE id='{user}'; DELETE FROM auth.sessions WHERE user_id='{user}'; DELETE FROM auth.refresh_tokens WHERE user_id='{user}'; COMMIT;")
    assert json.loads(query(call())) == {'success':True,'disposition':'retained_ledger_actor','user_id':user}
    assert json.loads(query(call()))['success'] is True
    assert ledger() == immutable and catalog() == meta
    assert query(f"SELECT balance FROM diamond_wallets WHERE user_id='{user}';") == '500'
    query("DELETE FROM club_members WHERE user_id='00000000-0000-4000-8000-000000000096';",'DEEP_STACK_PROTECTED')
    print('protected-ledger-pass-after-immutable-auth-retirement-acceptance-passed')
