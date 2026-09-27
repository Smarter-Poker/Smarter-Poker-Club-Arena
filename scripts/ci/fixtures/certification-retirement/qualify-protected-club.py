"""Connected protected-membership cleanup proof in the caller's private PG17.

Uses the captured production guard, existing combined cleanup, actual row locks
and FKs. The surrounding runner owns the isolated cluster and shutdown.
"""
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
import time


def qualify(root, fixture, query):
    target = '00000000-0000-4000-8000-000000000097'
    real = '00000000-0000-4000-8000-000000000096'
    club = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'
    e2e = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'
    email = 'ca-customization-cert-postdeploy-protected@example.invalid'
    sig = 'public.cleanup_reserved_certification_account(uuid)'
    guard = 'public.fn_deep_stack_society_cannot_be_deleted_by_accident()'
    captured = json.loads((fixture/'protected-club-preimage.json').read_text())
    migration = next((root/'supabase/migrations').glob('*_reserved_certification_members_leave_protected_club_safely.sql')).read_text()
    after = (fixture/'protected-club-cleanup-after.sql').read_text()
    assert query(f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure));") == captured[0]['md5']
    query('ALTER TABLE agents ADD COLUMN club_id uuid; CREATE TABLE accounting_cash_rake_sources(player_id uuid REFERENCES auth.users(id));')
    query((root/'supabase/migrations/20260901110603_deep_stack_society_cannot_be_deleted_by_accident.sql').read_text())
    query(captured[1]['definition']+'; REVOKE ALL ON FUNCTION '+guard+' FROM PUBLIC; GRANT EXECUTE ON FUNCTION '+guard+' TO service_role;')
    assert query(f"SELECT md5(pg_get_functiondef('{guard}'::regprocedure));") == captured[1]['md5']
    query('GRANT ALL ON SCHEMA public TO postgres; GRANT service_role,anon,authenticated TO postgres; ALTER ROLE postgres NOSUPERUSER BYPASSRLS;')
    assert query("SELECT NOT rolsuper AND rolbypassrls FROM pg_roles WHERE rolname='postgres';") == 't'

    def catalog():
        return query(f"SELECT jsonb_agg(jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig) ORDER BY oid) FROM pg_proc WHERE oid IN('{sig}'::regprocedure,'{guard}'::regprocedure);")

    def members():
        return query('SELECT jsonb_agg(to_jsonb(m) ORDER BY user_id,club_id) FROM club_members m;')

    def call():
        return f"SELECT public.cleanup_reserved_certification_account('{target}');"

    def seed():
        query(f"INSERT INTO auth.users(id,email) VALUES('{target}','{email}'); INSERT INTO profiles(id,email) VALUES('{target}','{email}'); INSERT INTO users VALUES('{target}'); INSERT INTO club_members VALUES('{club}','{target}','admin',0,0),('{e2e}','{target}','admin',0,0);")

    query(f"INSERT INTO auth.users(id,email) VALUES('{real}','real@example.com'); INSERT INTO profiles(id,email) VALUES('{real}','real@example.com'); INSERT INTO club_members VALUES('{club}','{real}','member',73,4);")
    query(f"DELETE FROM club_members WHERE user_id='{real}';", 'DEEP_STACK_PROTECTED')
    seed()
    baseline = members()
    query(call(), 'DEEP_STACK_PROTECTED')
    assert members() == baseline, 'Original cleanup did not roll back on protected membership'
    meta = catalog()
    query(migration.replace('COMMIT;', "DO $$ BEGIN RAISE EXCEPTION 'fixture rollback'; END $$; COMMIT;"), 'fixture rollback')
    assert query(f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure));") == captured[0]['md5']
    query('ALTER TABLE club_members DISABLE TRIGGER trg_deep_stack_members_are_protected;')
    query(migration, 'CERTIFICATION_PROTECTED_CLUB_GUARD_CHANGED')
    query('ALTER TABLE club_members ENABLE TRIGGER trg_deep_stack_members_are_protected;')
    query('GRANT EXECUTE ON FUNCTION '+sig+' TO authenticated;')
    query(migration, 'CERTIFICATION_PROTECTED_CLEANUP_AUTHORITY_CHANGED')
    query('REVOKE EXECUTE ON FUNCTION '+sig+' FROM authenticated;')
    query(migration)
    assert catalog() == meta
    assert query(f"SELECT pg_get_functiondef('{sig}'::regprocedure);")+'\n' == after
    query(migration, 'CERTIFICATION_PROTECTED_CLEANUP_PREIMAGE_CHANGED')
    for role in ['anon', 'authenticated']:
        query('SET ROLE '+role+';'+call(), 'permission denied')
    query('UPDATE freeze_fixture SET active=true;')
    assert json.loads(query(call())) == {'success': False, 'reason': 'platform_is_frozen'}
    assert members() == baseline
    query('UPDATE freeze_fixture SET active=false;')

    def refuse(setup, reason, undo):
        query(setup)
        before = members()
        query(call(), reason)
        assert members() == before
        assert query("SELECT count(*) FROM deep_stack_delete_attempts WHERE allowed;") == '0'
        query(undo)

    identity = 'CERTIFICATION_PROTECTED_MEMBERSHIP_IDENTITY_REFUSED'
    profile = 'CERTIFICATION_PROTECTED_MEMBERSHIP_PROFILE_REFUSED'
    custody = 'CERTIFICATION_PROTECTED_MEMBERSHIP_HAS_AUTHORITY_OR_CUSTODY'
    for value in ['person@example.com','ca-customization-cert-native@example.invalid','club-create-cert-x@smarter-poker.invalid']:
        refuse(f"UPDATE auth.users SET email='{value}' WHERE id='{target}';", identity, f"UPDATE auth.users SET email='{email}' WHERE id='{target}';")
    refuse(f"UPDATE auth.users SET deleted_at=now() WHERE id='{target}';", identity, f"UPDATE auth.users SET deleted_at=NULL WHERE id='{target}';")
    for column, value, undo in [('is_horse','true','false'),('is_admin','true','false'),('role',"'god'","'user'"),('email',"'spoof@example.com'",f"'{email}'")]:
        refuse(f"UPDATE profiles SET {column}={value} WHERE id='{target}';",profile,f"UPDATE profiles SET {column}={undo} WHERE id='{target}';")
    for column in ['chip_balance','promo_balance']:
        for value in ['7','-1','NULL']:
            refuse(f"UPDATE club_members SET {column}={value} WHERE user_id='{target}' AND club_id='{club}';",custody,f"UPDATE club_members SET {column}=0 WHERE user_id='{target}';")
    for value in ["'owner'",'NULL']:
        refuse(f"UPDATE club_members SET role={value} WHERE user_id='{target}' AND club_id='{club}';",custody,f"UPDATE club_members SET role='admin' WHERE user_id='{target}';")
    for table,col in [('clubs','owner_id'),('unions','owner_id'),('agents','user_id'),('table_seats','user_id'),('tournament_players','user_id')]:
        refuse(f"INSERT INTO {table}({col}) VALUES('{target}');",custody,f"DELETE FROM {table} WHERE {col}='{target}';")
    for col in ['balance','locked_balance']:
        refuse(f"INSERT INTO wallets(user_id,{col}) VALUES('{target}',1);",custody,f"DELETE FROM wallets WHERE user_id='{target}';")
    refuse(f"INSERT INTO club_members VALUES('00000000-0000-4000-8000-000000000001','{target}','admin',0,0);",custody,f"DELETE FROM club_members WHERE user_id='{target}' AND club_id='00000000-0000-4000-8000-000000000001';")
    # Roll back inserted financial fixtures; the production actor guard stays on.
    for col in ['performed_by','from_entity_id','to_entity_id']:
        insert = (f"INSERT INTO chip_ledger(performed_by,amount) VALUES('{target}',1);" if col=='performed_by'
                  else f"INSERT INTO chip_ledger(performed_by,{col},amount) VALUES('{real}','{target}',1);")
        query('BEGIN;'+insert+call(),custody)
    query('BEGIN;'+f"INSERT INTO accounting_cash_rake_sources VALUES('{target}');"+call(),custody)
    assert members() == baseline
    # An exception after the scoped DELETE must undo the row AND allowed audit,
    # and the configuration must already be restored for downstream statements.
    query("CREATE FUNCTION fixture_cleanup_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF current_setting('app.deep_stack_teardown',true)='on' THEN RAISE EXCEPTION 'override leaked'; END IF; RAISE EXCEPTION 'downstream fixture failure'; END $$; CREATE TRIGGER z_fixture_failure BEFORE DELETE ON public.users FOR EACH ROW EXECUTE FUNCTION fixture_cleanup_failure();")
    query(call(),'downstream fixture failure')
    assert members() == baseline
    assert query('SELECT count(*) FROM deep_stack_delete_attempts;') == '0'
    query('DROP TRIGGER z_fixture_failure ON public.users; DROP FUNCTION fixture_cleanup_failure();')
    for setting in ['off','sentinel','on']:
        out=query("BEGIN; SELECT set_config('app.deep_stack_teardown','"+setting+"',true); "+call()+" SELECT current_setting('app.deep_stack_teardown'); ROLLBACK;").splitlines()
        assert json.loads(out[1])['success'] is True and out[2] == setting
        assert members() == baseline
    # Real parent row locks prevent new custody while the qualified deletion is
    # uncommitted. No spin/wait loop touches a provider; this is private PG only.
    with ThreadPoolExecutor(max_workers=4) as pool:
        holder=pool.submit(query,"SET application_name='protected-cleanup-holder'; BEGIN; "+call()+" SELECT pg_sleep(2); ROLLBACK;")
        for _ in range(100):
            if query("SELECT count(*) FROM pg_stat_activity WHERE application_name='protected-cleanup-holder' AND wait_event='PgSleep';") == '1':
                break
            time.sleep(.02)
        else:
            raise AssertionError('Protected cleanup never reached locked boundary')
        for table,col in [('table_seats','user_id'),('agents','user_id'),('wallets','user_id')]:
            pool.submit(query,f"SET lock_timeout='100ms'; INSERT INTO {table}({col}) VALUES('{target}');",'lock timeout').result()
        holder.result()
    with ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(lambda _:json.loads(query('SET ROLE service_role;'+call())),range(2)))
    assert all(x['success'] for x in results) and sum(x['already_removed'] for x in results)==1
    assert query(f"SELECT count(*) FROM auth.users WHERE id='{target}';")=='0'
    assert query(f"SELECT chip_balance||':'||promo_balance FROM club_members WHERE user_id='{real}';")=='73:4'
    assert query(f"SELECT count(*) FROM deep_stack_delete_attempts WHERE allowed AND source_table='club_members' AND old_row->>'user_id'='{target}';")=='1'
    query(f"DELETE FROM club_members WHERE user_id='{real}';", 'DEEP_STACK_PROTECTED')
    assert catalog()==meta
    assert query(f"SELECT md5(pg_get_functiondef('{guard}'::regprocedure));")==captured[1]['md5']
    assert hashlib.md5(after.encode()).hexdigest()==query(f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure));")
    print('certification-protected-club-native-acceptance-passed')
