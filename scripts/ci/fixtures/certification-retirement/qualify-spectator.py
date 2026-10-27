"""Exact installed cleanup with a reserved zero-custody spectator membership."""
import hashlib
import json

def qualify(root, fixture, query):
    user = '00000000-0000-4000-8000-000000000092'
    owner = '00000000-0000-4000-8000-000000000091'
    email = 'ca-customization-cert-postdeploy-spectator@example.invalid'
    host = 'fade0000-0000-0000-0000-000000000001'
    protected = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'
    e2e = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'
    sig = 'public.cleanup_reserved_certification_account(uuid)'
    migration = next((root/'supabase/migrations').glob('*_reserved_spectator_fixture_leaves_its_zero_custody_membershi.sql')).read_text()
    query((fixture/'spectator-cleanup-before.sql').read_text())
    query(f"INSERT INTO auth.users(id,email) VALUES('{user}','{email}'),('{owner}','native-owner@example.invalid'); INSERT INTO profiles(id,email) VALUES('{user}','{email}'),('{owner}','native-owner@example.invalid'); INSERT INTO users VALUES('{user}'); INSERT INTO clubs(id,owner_id) VALUES('{host}','{owner}') ON CONFLICT(id) DO UPDATE SET owner_id=EXCLUDED.owner_id; INSERT INTO club_members(club_id,user_id,role,agent_id) VALUES('{e2e}','{user}','admin',NULL),('{protected}','{user}','admin',NULL),('{host}','{user}','player','{owner}');")
    query("SET request.jwt.claims='{\"role\":\"service_role\"}';"+f"INSERT INTO chip_ledger(performed_by,amount) VALUES('{user}',100000);")
    def call():
        return f"SELECT public.cleanup_reserved_certification_account('{user}');"
    def state():
        return query(f"SELECT jsonb_build_object('members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY club_id) FROM club_members m WHERE user_id='{user}'),'auth',(SELECT to_jsonb(u) FROM auth.users u WHERE id='{user}'),'ledger',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM chip_ledger l));")
    def meta():
        return query(f"SELECT jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig) FROM pg_proc WHERE oid='{sig}'::regprocedure;")
    snapshot = state()
    metadata = meta()
    query(call(), 'CERTIFICATION_PROTECTED_MEMBERSHIP_HAS_AUTHORITY_OR_CUSTODY')
    assert state() == snapshot
    print('spectator-cleanup-fail-before-reproduced')
    query(migration.replace('COMMIT;', "DO $$ BEGIN RAISE EXCEPTION 'fixture rollback'; END $$; COMMIT;"), 'fixture rollback')
    assert query(f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure));") == 'b3354b7c9a3854dd8cd743701b3b0696'
    query(migration)
    assert query(f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure));") == hashlib.md5((fixture/'spectator-cleanup-after.sql').read_bytes()).hexdigest()
    assert meta() == metadata
    query(migration, 'SPECTATOR_CERTIFICATION_PREIMAGE_CHANGED')
    for role in ['anon','authenticated']:
        query('SET ROLE '+role+';'+call(), 'permission denied')
    for column in ['chip_balance','promo_balance','held_chips','locked_chips','credit_used','credit_limit']:
        for value in ['1','-1','NULL']:
            query(f"UPDATE club_members SET {column}={value} WHERE user_id='{user}' AND club_id='{host}';")
            before = state()
            query(call(), 'CERTIFICATION_PROTECTED_MEMBERSHIP_HAS_AUTHORITY_OR_CUSTODY')
            assert state() == before
            query(f"UPDATE club_members SET {column}=0 WHERE user_id='{user}' AND club_id='{host}';")
    for role in ['owner','super_agent','member']:
        query(f"UPDATE club_members SET role='{role}' WHERE user_id='{user}' AND club_id='{host}';")
        query(call(), 'CERTIFICATION_PROTECTED_MEMBERSHIP_HAS_AUTHORITY_OR_CUSTODY')
        query(f"UPDATE club_members SET role='player' WHERE user_id='{user}' AND club_id='{host}';")
    query(f"UPDATE club_members SET role=NULL WHERE user_id='{user}' AND club_id='{host}';")
    query(call(), 'CERTIFICATION_PROTECTED_MEMBERSHIP_HAS_AUTHORITY_OR_CUSTODY')
    query(f"UPDATE club_members SET role='player' WHERE user_id='{user}' AND club_id='{host}';")
    for column in ['agent_id','parent_agent_id']:
        query(f"UPDATE club_members SET {column}='{user}' WHERE user_id='{user}' AND club_id='{host}';")
        query(call(), 'CERTIFICATION_PROTECTED_MEMBERSHIP_HAS_AUTHORITY_OR_CUSTODY')
        value = f"'{owner}'" if column == 'agent_id' else 'NULL'
        query(f"UPDATE club_members SET {column}={value} WHERE user_id='{user}' AND club_id='{host}';")
    for table,column in [('table_seats','user_id'),('tournament_players','user_id'),('agents','user_id')]:
        query(f"INSERT INTO {table}({column}) VALUES('{user}');")
        query(call(), 'CERTIFICATION_PROTECTED_MEMBERSHIP_HAS_AUTHORITY_OR_CUSTODY')
        query(f"DELETE FROM {table} WHERE {column}='{user}';")
    query('UPDATE freeze_fixture SET active=true;')
    assert json.loads(query(call())) == {'success':False,'reason':'platform_is_frozen'}
    assert state() == snapshot
    query('UPDATE freeze_fixture SET active=false;')
    immutable = query('SELECT md5(jsonb_agg(to_jsonb(l) ORDER BY id)::text) FROM chip_ledger l;')
    assert json.loads(query('SET ROLE service_role;'+call()))['reason'] == 'auth_soft_delete_required'
    assert query(f"SELECT count(*) FROM club_members WHERE user_id='{user}';") == '0'
    assert query('SELECT md5(jsonb_agg(to_jsonb(l) ORDER BY id)::text) FROM chip_ledger l;') == immutable
    query(f"UPDATE auth.users SET email='deleted-{user}',encrypted_password='',deleted_at=now() WHERE id='{user}';")
    assert json.loads(query(call()))['disposition'] == 'retained_ledger_actor'
    assert meta() == metadata
    print('spectator-cleanup-native-acceptance-passed')
