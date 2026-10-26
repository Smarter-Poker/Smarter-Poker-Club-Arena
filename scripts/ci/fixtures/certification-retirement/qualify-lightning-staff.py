"""Continue the existing real-PG17 certificate with the exact prepared union staff scope."""
import hashlib
import json

def qualify(root, fixture, query):
    user = '00000000-0000-4000-8000-000000000094'
    email = 'ca-customization-cert-postdeploy-lightning@example.invalid'
    e2e = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'
    protected = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'
    host = 'fade0000-0000-0000-0000-000000000001'
    sig = 'public.cleanup_reserved_certification_account(uuid)'
    migration = next((root/'supabase/migrations').glob('*_reserved_lightning_staff_cleanup_matches_its_prepared_scope.sql')).read_text()
    after = (fixture/'lightning-staff-cleanup-after.sql').read_text()
    def seed():
        query(f"INSERT INTO auth.users(id,email) VALUES('{user}','{email}'); INSERT INTO profiles(id,email) VALUES('{user}','{email}'); INSERT INTO users VALUES('{user}'); INSERT INTO club_members(club_id,user_id,role) VALUES('{e2e}','{user}','admin'),('{protected}','{user}','admin'),('{host}','{user}','admin');")
    def call():
        return f"SELECT public.cleanup_reserved_certification_account('{user}');"
    def state():
        return query(f"SELECT jsonb_build_object('members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY club_id) FROM club_members m WHERE user_id='{user}'),'auth',(SELECT to_jsonb(u) FROM auth.users u WHERE id='{user}'),'ledger',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM chip_ledger l));")
    def catalog():
        return query(f"SELECT jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig) FROM pg_proc WHERE oid='{sig}'::regprocedure;")
    seed()
    before = state()
    meta = catalog()
    assert query(f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure));") == '07419c2062fbff02d3ee7d3c24cd8ea9'
    query(call(), 'CERTIFICATION_PROTECTED_MEMBERSHIP_HAS_AUTHORITY_OR_CUSTODY')
    assert state() == before
    print('lightning-staff-fail-before-reproduced')
    query(migration.replace('COMMIT;', "DO $$ BEGIN RAISE EXCEPTION 'fixture rollback'; END $$; COMMIT;"), 'fixture rollback')
    assert query(f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure));") == '07419c2062fbff02d3ee7d3c24cd8ea9'
    query(migration)
    assert query(f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure));") == hashlib.md5(after.encode()).hexdigest()
    assert catalog() == meta
    query(migration, 'LIGHTNING_CERTIFICATION_CLEANUP_PREIMAGE_CHANGED')
    for role in ['anon','authenticated']:
        query('SET ROLE '+role+';'+call(), 'permission denied')
    for column in ['chip_balance','promo_balance','held_chips','locked_chips','credit_used','credit_limit']:
        for value in ['1','-1','NULL']:
            query(f"UPDATE club_members SET {column}={value} WHERE user_id='{user}' AND club_id='{host}';")
            snapshot = state()
            query(call(), 'CERTIFICATION_PROTECTED_MEMBERSHIP_HAS_AUTHORITY_OR_CUSTODY')
            assert state() == snapshot
            query(f"UPDATE club_members SET {column}=0 WHERE user_id='{user}' AND club_id='{host}';")
    for role in ['owner','super_agent','member']:
        query(f"UPDATE club_members SET role='{role}' WHERE user_id='{user}' AND club_id='{host}';")
        query(call(), 'CERTIFICATION_PROTECTED_MEMBERSHIP_HAS_AUTHORITY_OR_CUSTODY')
        query(f"UPDATE club_members SET role='admin' WHERE user_id='{user}' AND club_id='{host}';")
    query('UPDATE freeze_fixture SET active=true;')
    assert json.loads(query(call())) == {'success':False,'reason':'platform_is_frozen'}
    assert state() == before
    query('UPDATE freeze_fixture SET active=false;')
    assert json.loads(query('SET ROLE service_role;'+call()))['success'] is True
    assert query(f"SELECT count(*) FROM auth.users WHERE id='{user}';") == '0'
    # Same prepared scope on a retained actor: preserve the full ledger and use
    # supported Auth retirement, never detach an actor to manufacture cleanup.
    seed()
    query("SET request.jwt.claims='{\"role\":\"service_role\"}';"+f"INSERT INTO chip_ledger(performed_by,amount) VALUES('{user}',100000);")
    immutable = query('SELECT md5(jsonb_agg(to_jsonb(l) ORDER BY id)::text) FROM chip_ledger l;')
    assert json.loads(query('SET ROLE service_role;'+call()))['reason'] == 'auth_soft_delete_required'
    assert query(f"SELECT count(*) FROM club_members WHERE user_id='{user}';") == '0'
    assert query('SELECT md5(jsonb_agg(to_jsonb(l) ORDER BY id)::text) FROM chip_ledger l;') == immutable
    query(f"BEGIN; UPDATE auth.users SET email='deleted-{user}',encrypted_password='',deleted_at=now() WHERE id='{user}'; DELETE FROM auth.sessions WHERE user_id='{user}'; DELETE FROM auth.refresh_tokens WHERE user_id='{user}'; COMMIT;")
    assert json.loads(query(call()))['disposition'] == 'retained_ledger_actor'
    assert catalog() == meta
    print('lightning-staff-guarded-cleanup-native-acceptance-passed')
