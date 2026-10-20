"""Real login/ACL/fence qualification of the fixed fold-only transport lane."""
from pathlib import Path
import json
import subprocess
import time


def qualify(root, pg, port, sql):
    here = Path(__file__).parent
    migration = root / 'supabase/migrations/20261020160107_lightning_fold_uses_a_separate_restricted_session.sql'
    # These roles and relations model only missing hosting infrastructure.
    # The fold body and complete deployed pre-request hook are unmodified.
    sql('''CREATE ROLE postgres LOGIN CREATEROLE BYPASSRLS;
      GRANT service_role TO postgres WITH ADMIN OPTION;
      ALTER SCHEMA smarter_private OWNER TO postgres;
      GRANT CREATE,USAGE ON SCHEMA public TO postgres;
      GRANT USAGE ON SCHEMA smarter_private TO service_role;
      CREATE SCHEMA auth AUTHORIZATION postgres;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$
        SELECT coalesce(nullif(current_setting('request.jwt.claim.role',true),''),
          nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role')$$;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
        SELECT nullif(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub','')::uuid$$;
      CREATE TABLE public.ca_player_session_revocations(user_id uuid);
      CREATE FUNCTION public.fn_ca_player_session_live(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
      CREATE TABLE public.engine_tournament_leases(tournament_id uuid PRIMARY KEY,lease_generation uuid,protocol_version integer,heartbeat_at timestamptz);
      ALTER TABLE public.engine_tournament_leases OWNER TO postgres;
      CREATE TABLE smarter_private.fold_lane_aborted(tournament_id uuid,generation uuid);
      CREATE FUNCTION smarter_private.f06_generation_aborted(t uuid,g uuid) RETURNS boolean LANGUAGE sql AS $$
        SELECT EXISTS(SELECT 1 FROM smarter_private.fold_lane_aborted WHERE tournament_id=t AND generation=g)$$;
      GRANT SELECT ON public.engine_tournament_leases,public.ca_player_session_revocations,smarter_private.fold_lane_aborted TO postgres;
      GRANT USAGE ON SCHEMA auth TO postgres,service_role;
      CREATE SCHEMA vault AUTHORIZATION postgres;
      CREATE TABLE vault.secrets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),secret text,name text UNIQUE,description text);
      ALTER TABLE vault.secrets OWNER TO postgres;
      CREATE VIEW vault.decrypted_secrets AS SELECT id,secret AS decrypted_secret,name,description FROM vault.secrets;
      ALTER VIEW vault.decrypted_secrets OWNER TO postgres;
      CREATE FUNCTION vault.create_secret(value text,name text,description text) RETURNS uuid
        LANGUAGE sql AS $$INSERT INTO vault.secrets(secret,name,description) VALUES($1,$2,$3) RETURNING id$$;
      GRANT USAGE ON SCHEMA vault TO service_role;
      REVOKE ALL ON FUNCTION public.fn_lightning_fast_fold(uuid,uuid,uuid,text,numeric) FROM PUBLIC,anon,authenticated;
      GRANT EXECUTE ON FUNCTION public.fn_lightning_fast_fold(uuid,uuid,uuid,text,numeric) TO service_role;
      GRANT SELECT,UPDATE ON lightning_hand,lightning_instance,lightning_hand_player,lightning_reservation TO service_role;
      GRANT SELECT,UPDATE ON lightning_pool_session TO service_role;
      GRANT SELECT ON cash_games TO service_role;
      GRANT INSERT ON cash_cluster_events TO service_role;''')
    sql((here / 'fold-lane-pre-request.sql').read_text())
    sql('''ALTER FUNCTION smarter_private.fn_smarter_data_api_pre_request() OWNER TO postgres;
      REVOKE ALL ON FUNCTION smarter_private.fn_smarter_data_api_pre_request() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION smarter_private.fn_smarter_data_api_pre_request() TO service_role;
      GRANT EXECUTE ON FUNCTION smarter_private.f06_generation_aborted(uuid,uuid) TO postgres;
      GRANT SELECT ON lightning_instance,lightning_hand_player,lightning_reservation,cash_cluster_events TO postgres;''')
    assert sql("SELECT rolsuper FROM pg_roles WHERE rolname='postgres'") == 'f'
    schema_acl = sql("SELECT nspacl::text FROM pg_namespace WHERE nspname='smarter_private'")
    original = sql("SELECT pg_get_functiondef('fn_lightning_fast_fold(uuid,uuid,uuid,text,numeric)'::regprocedure)")
    assert sql("SELECT to_regprocedure('smarter_private.fn_engine_lightning_fast_fold(uuid,uuid,uuid,text,numeric,jsonb)') IS NULL") == 't'
    # Actual production-like non-superuser creator, not a SET ROLE service test.
    sql('SET SESSION AUTHORIZATION postgres;' + migration.read_text() + ';RESET SESSION AUTHORIZATION;')
    assert sql("SELECT nspacl::text FROM pg_namespace WHERE nspname='smarter_private'") != ''
    assert sql("SELECT has_schema_privilege('service_role','smarter_private','CREATE')") == 'f'
    assert sql("SELECT pg_get_functiondef('fn_lightning_fast_fold(uuid,uuid,uuid,text,numeric)'::regprocedure)") == original
    assert sql("SELECT pg_get_userbyid(proowner)||':'||prosecdef FROM pg_proc WHERE oid='smarter_private.fn_engine_lightning_fast_fold(uuid,uuid,uuid,text,numeric,jsonb)'::regprocedure") == 'service_role:true'
    assert sql("SELECT count(*) FROM vault.secrets WHERE name='engine_lightning_fold_url'") == '1'

    command = [str(pg / 'psql'), '-X', '-q', '-h', '127.0.0.1', '-p', port,
               '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1']
    def run(statement, user='engine_lightning_fold'):
        result = subprocess.run(command + ['-U', user], input=statement, text=True, capture_output=True)
        if result.returncode:
            # Never emit SQL context or secret-bearing values, even locally.
            message = next((line for line in result.stderr.splitlines() if line.startswith('ERROR:')), 'database refusal')
            raise RuntimeError(message)
        return result.stdout.strip()

    def denied(statement, marker='permission denied', user='engine_lightning_fold'):
        try:
            run(statement, user)
        except RuntimeError as error:
            assert marker in str(error), str(error)
        else:
            raise AssertionError('restricted login admitted a forbidden statement')

    hand = '00000000-0000-0000-0000-000000000002'
    service = {'x-smarter-data-actor':'service','x-smarter-data-protocol':'1'}
    manager = {'x-smarter-data-actor':'tournament-manager','x-smarter-data-protocol':'2',
               'x-smarter-tournament-id':'00000000-0000-0000-0000-000000000071',
               'x-smarter-tournament-lease-generation':'00000000-0000-0000-0000-000000000072'}
    def call(headers=service, kind='normal', amount='1', player=12):
        text = json.dumps(headers).replace("'", "''")
        return f"SELECT smarter_private.fn_engine_lightning_fast_fold('{hand}',lpad('{player}',32,'0')::uuid,gen_random_uuid(),'{kind}',{amount},'{text}'::jsonb)"

    def reset():
        sql("UPDATE lightning_instance SET state='dealing'; UPDATE lightning_hand_player SET folded_at=NULL,fold_type=NULL; UPDATE lightning_reservation SET state='committed';DELETE FROM cash_cluster_events")

    assert run('SELECT session_user') == 'engine_lightning_fold'
    denied('SET ROLE service_role')
    denied('SET ROLE postgres')
    denied('SELECT public.fn_engine_lightning_fold_session_url()')
    denied("SELECT decrypted_secret FROM vault.decrypted_secrets")
    denied("UPDATE public.lightning_hand_player SET stack_before=999")
    forged = "SET request.jwt.claim.role='service_role'; SET request.jwt.claims='{\"role\":\"service_role\"}';"
    denied(forged + f"SELECT public.fn_lightning_fast_fold('{hand}',lpad('12',32,'0')::uuid,gen_random_uuid(),'normal',1)")
    denied(forged + 'SELECT public.fn_engine_lightning_fold_session_url()')
    denied(forged + 'UPDATE public.lightning_reservation SET state=\'released\'')
    denied('SET ROLE service_role;' + call(), user='postgres', marker='LIGHTNING_FOLD_SESSION_FORBIDDEN')
    assert run('SET ROLE service_role; SELECT length(public.fn_engine_lightning_fold_session_url())>0', user='postgres') == 't'
    denied('SET synchronous_commit=off;' + call(), marker='LIGHTNING_FOLD_DURABLE_COMMIT_REQUIRED')
    for bad in [None, {}, {**service,'authorization':'forged'}, {**service,'x-smarter-tournament-id':manager['x-smarter-tournament-id']}, {**service,'x-smarter-data-protocol':'2'}, {**manager,'x-smarter-tournament-id':'not-a-uuid'}]:
        denied(call(bad), marker='INVALID')
    reset()
    first = json.loads(run('BEGIN;SET LOCAL synchronous_commit=on;' + call() + ';COMMIT'))
    assert first['ok'] is True and first['released'] is True
    assert json.loads(run(call()))['replay'] is True
    assert json.loads(run(call(kind='fast')))['reason'] == 'already_folded'
    assert sql("SELECT count(*) FROM cash_cluster_events WHERE payload->>'player_id'=lpad('12',32,'0')::uuid::text") == '1'
    assert sql("SELECT stack_before FROM lightning_hand_player WHERE player_id=lpad('12',32,'0')::uuid") == '10'
    reset()
    assert json.loads(run(call(kind='fold_watch')))['released'] is False
    assert sql("SELECT state FROM lightning_reservation WHERE player_id=lpad('12',32,'0')::uuid") == 'committed'
    assert json.loads(run(call(player=99)))['reason'] == 'not_a_participant'
    assert json.loads(run(call(kind='invalid')))['reason'] == 'invalid_fold_type'
    reset()
    assert json.loads(run(call(amount='11')))['reason'] == 'committed_exceeds_stack_before'
    sql("UPDATE lightning_instance SET state='completed'")
    assert json.loads(run(call()))['reason'] == 'instance_not_dealing'

    # The complete production hook owns exact generation, age and abort rules.
    reset()
    denied(call(manager), marker='TOURNAMENT_MANAGER_FENCED')
    sql(f"INSERT INTO engine_tournament_leases VALUES('{manager['x-smarter-tournament-id']}','{manager['x-smarter-tournament-lease-generation']}',2,clock_timestamp())")
    assert json.loads(run(call(manager)))['ok'] is True
    reset()
    wrong = {**manager,'x-smarter-tournament-lease-generation':'00000000-0000-0000-0000-000000000073'}
    denied(call(wrong), marker='TOURNAMENT_MANAGER_FENCED')
    sql("UPDATE engine_tournament_leases SET heartbeat_at=clock_timestamp()-interval '31 seconds'")
    denied(call(manager), marker='TOURNAMENT_MANAGER_FENCED')
    sql("UPDATE engine_tournament_leases SET heartbeat_at=clock_timestamp()")
    sql(f"INSERT INTO smarter_private.fold_lane_aborted VALUES('{manager['x-smarter-tournament-id']}','{manager['x-smarter-tournament-lease-generation']}')")
    denied(call(manager), marker='TOURNAMENT_MANAGER_FENCED')
    sql('DELETE FROM smarter_private.fold_lane_aborted')
    reset()
    # The original pre-request hook keeps the exact manager generation locked
    # until the enclosing fold transaction commits. A second original request
    # cannot enter through the wrapper and bypass that transactional custody.
    holder = subprocess.Popen(command + ['-U','engine_lightning_fold'], stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    holder.stdin.write("SET application_name='fold-lane-manager-custody';BEGIN;" + call(manager) + ';SELECT pg_sleep(2);COMMIT;\n')
    holder.stdin.close()
    try:
        for _ in range(150):
            if sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='fold-lane-manager-custody' AND wait_event='PgSleep'") == '1':
                break
            time.sleep(.01)
        else:
            raise AssertionError('fold transaction did not reach held manager custody')
        try:
            sql("SET lock_timeout='200ms';SELECT tournament_id FROM engine_tournament_leases FOR UPDATE")
        except RuntimeError as error:
            assert 'lock timeout' in str(error)
        else:
            raise AssertionError('manager takeover crossed a live fold transaction')
        denied("SET lock_timeout='200ms';" + call(), marker='lock timeout')
    finally:
        holder.wait(timeout=8)
        assert holder.returncode == 0, 'held fold transaction failed'
        holder.stdout.close()
        holder.stderr.close()
    assert json.loads(run(call()))['replay'] is True
    assert sql("SELECT count(*) FROM cash_cluster_events") == '1'
    reset()
    assert json.loads(run('BEGIN;' + call() + ';ROLLBACK'))['ok'] is True
    assert sql("SELECT count(*) FROM cash_cluster_events") == '0'
    assert sql("SELECT folded_at IS NULL FROM lightning_hand_player WHERE player_id=lpad('12',32,'0')::uuid") == 't'
    # Same physical connection, two transactions: manager state cannot leak.
    reset()
    observed = run('BEGIN;' + call(manager) + ";SELECT current_setting('app.smarter_data_actor');COMMIT;BEGIN;" + call(service,player=11) + ";SELECT current_setting('app.smarter_data_actor')||':'||current_setting('app.smarter_tournament_id');COMMIT").splitlines()
    assert observed[1] == 'tournament-manager' and observed[3] == 'service:'
    assert sql("SELECT count(*) FROM cash_cluster_events") == '2'
    try:
        sql(migration.read_text())
    except RuntimeError as error:
        assert 'already exists' in str(error)
    else:
        raise AssertionError('lane migration replay rotated a live credential')
    print('PASS: real restricted login cannot forge privileges via GUCs, write tables, assume service role or read Vault; non-superuser installation restores schema CREATE')
    print('PASS: exact original fold/refusal/duplicate/watch behavior and atomic rollback; complete deployed manager fence refuses missing/stale/aborted generations and excludes takeover through commit; pooled actor context does not leak')
