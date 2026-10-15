"""A floor park is a lease that expires and pages, never a switch left on.

Qualifies supabase/migrations/20261014231111_a_floor_park_is_a_lease_that_expires_and_pages_never_a_switc.sql
against the exact production floor owners (scripts/ci/fixtures/launch-reset/floor/originals.json
and the floor component of the scoped launch reset migration), on a throwaway
local PostgreSQL, the way scripts/ci/test_launch_reset_floor.py does.

What it proves (each one read from production on 2026-10-14, where a park
taken 2026-10-13 13:15Z held the whole Midway Union floor for 34 hours and
paged nobody):

  1. A park written by the untouched owners gets held_since / expires_at.
  2. A hold younger than the page threshold raises nothing; older raises ONE
     critical financial alert and never a second for the same operation.
  3. The hold's owner can renew it as service_role; another operation cannot;
     anyone without service_role cannot.
  4. At expiry the watchdog releases the hold exactly as the owner's own
     resume would: a scope row for the resume operation, the resume command,
     one receipt per closed table, fn_ca_launch_cash_close_resumed true for
     every table, the entry guard admits seats again, the alert resolves.
  5. A close the engine finishes after the release gets its receipt on the
     next tick.
  6. An unscoped park (fn_ca_engine_operator_command) expires the same way.
"""
from pathlib import Path
import os, json, tempfile, subprocess, argparse, re, sys

repo = Path(__file__).resolve().parents[2]
floor_base = repo / 'scripts' / 'ci' / 'fixtures' / 'launch-reset' / 'floor'
parser = argparse.ArgumentParser()
parser.add_argument('--pgbin', default=os.environ.get('PGBIN', os.environ.get('PG_BIN', '/opt/homebrew/bin')))
parser.add_argument('--scratch', type=Path, default=Path(os.environ.get('TMPDIR', tempfile.gettempdir())))
parser.add_argument('--floor-migration', type=Path,
                    default=repo / 'supabase' / 'migrations' / '20261012181905_scoped_club_launch_reset_and_guarded_recovery.sql')
parser.add_argument('--candidate', type=Path,
                    default=next((repo / 'supabase' / 'migrations').glob('*_a_floor_park_is_a_lease_that_expires_and_pages_never_a_switc.sql')))
parser.add_argument('--output', type=Path, default=None)
args = parser.parse_args()

def floor_component(text):
    marker = '-- Component: floor-component/scoped-floor.sql'
    matches = list(re.finditer(r'^' + re.escape(marker) + r'\s*$', text, re.M))
    assert len(matches) == 1, 'floor migration must carry exactly one floor component marker'
    tail = text[matches[0].end():]
    nxt = re.search(r'^-- Component: ', tail, re.M)
    extracted = tail[:nxt.start()] if nxt else re.sub(r'\nCOMMIT;\s*$', '\n', tail, count=1)
    return 'BEGIN;\n' + extracted.strip() + '\nCOMMIT;\n'

candidate_sql = args.candidate.read_text()
assert 'BEGIN;' in candidate_sql and candidate_sql.rstrip().endswith('COMMIT;'), 'one transaction'
assert '-- periodic-work:' in candidate_sql, 'a cron schedule declares its periodic work'
assert 'cron.schedule(' in candidate_sql and "'ca-operator-floor-hold-watchdog-1m'" in candidate_sql

pg = Path(args.pgbin)
args.scratch.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='floor-hold-', dir=args.scratch) as tmp:
    root = Path(tmp); socket = root / 's'; socket.mkdir(); data = root / 'd'
    env = dict(os.environ, PGHOST=str(socket), PGUSER='postgres', PGDATABASE='postgres', PGSSLMODE='disable')

    def run(cmd, sql=None, refuse=None):
        r = subprocess.run([str(x) for x in cmd], input=sql, text=True, capture_output=True, env=env, timeout=60)
        if refuse:
            assert r.returncode != 0 and refuse in r.stderr, (refuse, r.stdout, r.stderr)
        else:
            assert r.returncode == 0, (sql, r.stderr)
        return r.stdout.strip()

    psql = [pg / 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1']
    run([pg / 'initdb', '-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '-E', 'UTF8'])
    with (data / 'postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) + "'\n")
    try:
        run([pg / 'pg_ctl', '-D', data, '-l', root / 'server.log', '-w', 'start'])
        fixture = """
CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.role',true),'')$$;
CREATE SCHEMA cron;
CREATE TABLE cron.job(jobid serial PRIMARY KEY,jobname text,schedule text,command text,active boolean DEFAULT true);
CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS $$INSERT INTO cron.job(jobname,schedule,command) VALUES($1,$2,$3) RETURNING jobid::bigint$$;
CREATE FUNCTION cron.unschedule(text) RETURNS boolean LANGUAGE sql AS $$DELETE FROM cron.job WHERE jobname=$1 RETURNING true$$;
CREATE TABLE ca_engine_operator_commands(id uuid PRIMARY KEY,actor_id uuid,domain text,action text,reason text,status text,announced_at timestamptz,result jsonb,created_at timestamptz DEFAULT clock_timestamp(),updated_at timestamptz DEFAULT clock_timestamp(),end_requested_at timestamptz);
CREATE TABLE ca_operator_floor_hold(id boolean PRIMARY KEY,operation_id uuid,mode text,reason text);
CREATE TABLE ca_operator_table_closes(table_id uuid PRIMARY KEY,operation_id uuid,actor_id uuid,reason text,status text DEFAULT 'pending');
CREATE TABLE tables(id uuid PRIMARY KEY,club_id uuid,union_id uuid,tournament_id uuid,status text,is_deleted boolean,game_type text);
CREATE TABLE tournaments(id uuid PRIMARY KEY,club_id uuid,union_id uuid,status text);
CREATE TABLE tournament_launch_receipts(tournament_id uuid);
CREATE TABLE tournament_players(tournament_id uuid,user_id uuid);
CREATE TABLE table_seats(table_id uuid,left_at timestamptz,occupancy_id uuid);
CREATE TABLE hand_state_snapshots(table_id uuid,is_complete boolean);
CREATE TABLE financial_alerts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),severity text NOT NULL,source text NOT NULL,message text NOT NULL,context jsonb DEFAULT '{}'::jsonb,resolved boolean NOT NULL DEFAULT false,resolved_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),resolved_by uuid,resolution text);
CREATE TABLE fixture_audits(actor_id uuid,action text,object_id text);
CREATE FUNCTION fn_ca_operator_permissions(uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT CASE WHEN $1='20000000-0000-0000-0000-000000000001' THEN '{"permissions":["clubs.write","settings.write"]}'::jsonb ELSE '{"permissions":[]}'::jsonb END$$;
CREATE FUNCTION fn_log_admin_action(uuid,text,text,text,jsonb,jsonb,jsonb,text,text,text) RETURNS void LANGUAGE sql AS $$INSERT INTO fixture_audits VALUES($1,$2,$4)$$;
CREATE FUNCTION fn_ca_lock_settlement_lane_for_tournament(uuid,uuid) RETURNS void LANGUAGE sql AS $$SELECT$$;
CREATE FUNCTION fn_ca_lock_mtt_admission_contract() RETURNS void LANGUAGE sql AS $$SELECT$$;
CREATE FUNCTION fn_entry_purchases_frozen() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE FUNCTION fn_lock_daily_mission_user(uuid) RETURNS void LANGUAGE sql AS $$SELECT$$;
"""
        run(psql, fixture)
        run(psql, (floor_base / 'finish-close-original.sql').read_text())
        for r in json.loads((floor_base / 'originals.json').read_text()):
            run(psql, r['definition'] + ';')
        run(psql, "CREATE TRIGGER entry_guard BEFORE INSERT OR UPDATE OF left_at,occupancy_id ON table_seats FOR EACH ROW EXECUTE FUNCTION fn_ca_operator_floor_entry_guard();")
        run(psql, "TRUNCATE ca_operator_floor_hold,ca_engine_operator_commands,fixture_audits;")
        run(psql, floor_component(args.floor_migration.read_text()))
        # The candidate, on top of the exact owners.
        run(psql, candidate_sql)
        assert run(psql, "SELECT count(*) FROM cron.job WHERE jobname='ca-operator-floor-hold-watchdog-1m' AND active;") == '1'
        run(psql, candidate_sql)  # re-runnable: one cron row, one trigger
        assert run(psql, "SELECT count(*) FROM cron.job WHERE jobname='ca-operator-floor-hold-watchdog-1m';") == '1'
        assert run(psql, "SELECT count(*) FROM pg_trigger WHERE tgname='ca_operator_floor_hold_lease';") == '1'

        club = 'a0000000-0000-0000-0000-000000000001'; outside = '002c2d27-9584-4e52-835a-bb2be148fc81'
        t1 = '10000000-0000-0000-0000-000000000001'; t2 = '10000000-0000-0000-0000-000000000002'; t_out = '10000000-0000-0000-0000-000000000003'
        actor = '20000000-0000-0000-0000-000000000001'; other = '20000000-0000-0000-0000-000000000002'
        park = '30000000-0000-0000-0000-000000000001'; close = '30000000-0000-0000-0000-000000000002'
        prefix = "SET request.jwt.claim.role='service_role';"
        run(psql, f"INSERT INTO tables VALUES('{t1}','{club}',NULL,NULL,'running',false,'cash'),('{t2}','{club}',NULL,NULL,'running',false,'cash'),('{t_out}','{outside}',NULL,NULL,'running',false,'cash');")

        # 1. A park written by the untouched owner carries a lease.
        run(psql, prefix + f"SELECT fn_ca_launch_operator_command('{actor}','{park}','park','Qualified Launch Scope Park');")
        lease = json.loads(run(psql, "SELECT jsonb_build_object('held',held_since IS NOT NULL,'ttl',expires_at-held_since) FROM ca_operator_floor_hold;"))
        assert lease['held'] and lease['ttl'] == '01:00:00', lease
        run(psql, f"INSERT INTO table_seats VALUES('{t1}',NULL,'40000000-0000-0000-0000-000000000001');", refuse='OPERATOR_FLOOR_PARKED')

        # 2. Young hold: nothing. Old hold: one alert, once.
        w = json.loads(run(psql, "SELECT fn_ca_operator_floor_hold_watchdog();"))
        assert w['raised'] == 0 and w['released'] is False and w['hold']['refusing_tables'] == 2, w
        assert run(psql, "SELECT count(*) FROM financial_alerts;") == '0'
        run(psql, "UPDATE ca_operator_floor_hold SET held_since=held_since-interval '11 minutes', expires_at=expires_at-interval '11 minutes';")
        w = json.loads(run(psql, "SELECT fn_ca_operator_floor_hold_watchdog();"))
        assert w['raised'] == 1 and w['released'] is False, w
        w = json.loads(run(psql, "SELECT fn_ca_operator_floor_hold_watchdog();"))
        assert w['raised'] == 0, w
        assert run(psql, "SELECT count(*) FROM financial_alerts WHERE severity='critical' AND NOT resolved AND source='fn_ca_operator_floor_hold_watchdog';") == '1'
        assert run(psql, f"SELECT context->>'operation_id' FROM financial_alerts;") == park

        # 3. Renewal: the owner as service_role, nobody else.
        run(psql, f"SELECT fn_ca_operator_floor_hold_renew('{actor}','{park}','Reset still running, keep the floor');", refuse='engine_operator_forbidden')
        run(psql, prefix + f"SELECT fn_ca_operator_floor_hold_renew('{actor}','{close}','Reset still running, keep the floor');", refuse='launch_operator_other_hold_active')
        run(psql, prefix + f"SELECT fn_ca_operator_floor_hold_renew('{other}','{park}','Reset still running, keep the floor');", refuse='operation_identity_conflict')
        before = run(psql, "SELECT expires_at FROM ca_operator_floor_hold;")
        renewed = json.loads(run(psql, prefix + f"SELECT fn_ca_operator_floor_hold_renew('{actor}','{park}','Reset still running, keep the floor');").splitlines()[-1])
        assert renewed['ok'] is True and renewed['expires_at'] > before, (before, renewed)
        assert run(psql, "SELECT count(*) FROM fixture_audits WHERE action='engine_operator.floor.renew';") == '1'
        # A write can never push the lease out by more than one TTL.
        clamped = run(psql, "UPDATE ca_operator_floor_hold SET expires_at=expires_at+interval '9 hours' RETURNING expires_at = (SELECT expires_at+interval '1 hour' FROM ca_operator_floor_hold);")
        assert clamped.splitlines()[0] == 't', clamped

        # Close the scoped cash tables under the park, finish one, leave one pending.
        run(psql, prefix + f"SELECT fn_ca_launch_operator_command('{actor}','{close}','close_cash','Qualified Launch Scope Close','{park}');")
        assert run(psql, "SELECT count(*) FROM ca_operator_table_closes;") == '2'
        run(psql, prefix + f"SELECT fn_ca_operator_finish_cash_close('{t1}','{close}');")
        run(psql, f"INSERT INTO table_seats VALUES('{t2}',NULL,'40000000-0000-0000-0000-000000000002');", refuse='OPERATOR_FLOOR_PARKED')

        # 4. Expiry: released as the owner would have released it.
        run(psql, "UPDATE ca_operator_floor_hold SET expires_at=clock_timestamp()-interval '1 second';")
        w = json.loads(run(psql, "SELECT fn_ca_operator_floor_hold_watchdog();"))
        # The close command is still 'accepted' while one table is pending, so
        # (exactly as the owner's own resume) no receipt can be proven yet.
        assert w['released'] is True and w['receipts_written'] == 0 and w['closes_pending'] == 1, w
        resume = w['resume_operation_id']
        assert run(psql, "SELECT count(*) FROM ca_operator_floor_hold;") == '0'
        assert run(psql, f"SELECT action||':'||status||':'||actor_id FROM ca_engine_operator_commands WHERE id='{resume}';") == f'resume:accepted:{actor}'
        assert run(psql, f"SELECT count(*) FROM ca_launch_operator_scopes WHERE operation_id='{resume}' AND actor_id='{actor}';") == '1'
        assert run(psql, f"SELECT count(*) FROM ca_operator_floor_hold_releases WHERE park_operation_id='{park}' AND resume_operation_id='{resume}' AND scoped;") == '1'
        assert run(psql, "SELECT count(*) FROM fixture_audits WHERE action='engine_operator.floor.auto_release';") == '1'
        run(psql, f"INSERT INTO table_seats VALUES('{t_out}',NULL,'40000000-0000-0000-0000-000000000004');")
        # The unfinished close command still refuses its own tables, and the alert stays open for them.
        run(psql, f"INSERT INTO table_seats VALUES('{t1}',NULL,'40000000-0000-0000-0000-000000000003');", refuse='OPERATOR_FLOOR_PARKED')
        run(psql, f"INSERT INTO table_seats VALUES('{t2}',NULL,'40000000-0000-0000-0000-000000000005');", refuse='OPERATOR_FLOOR_PARKED')
        assert run(psql, "SELECT count(*) FROM financial_alerts WHERE NOT resolved;") == '1'

        # 5. The engine finishes the late close; the next tick proves it resumed.
        run(psql, "DELETE FROM table_seats;")
        run(psql, prefix + f"SELECT fn_ca_operator_finish_cash_close('{t2}','{close}');")
        w = json.loads(run(psql, "SELECT fn_ca_operator_floor_hold_watchdog();"))
        assert w['late_receipts_written'] == 2 and w['resolved'] == 1, w
        assert run(psql, f"SELECT fn_ca_launch_cash_close_resumed('{t1}','{close}') AND fn_ca_launch_cash_close_resumed('{t2}','{close}');") == 't'
        run(psql, f"INSERT INTO table_seats VALUES('{t1}',NULL,'40000000-0000-0000-0000-000000000003');")
        run(psql, f"INSERT INTO table_seats VALUES('{t2}',NULL,'40000000-0000-0000-0000-000000000006');")
        assert run(psql, "SELECT count(*) FROM financial_alerts WHERE NOT resolved;") == '0'
        assert 'released by this watchdog' in run(psql, "SELECT resolution FROM financial_alerts;")
        # The owner's own resume replays cleanly on top of the auto-release (same
        # operation, same reason, as every replay of a floor command must).
        auto_reason = run(psql, f"SELECT reason FROM ca_engine_operator_commands WHERE id='{resume}';")
        run(psql, prefix + f"SELECT fn_ca_launch_operator_command('{actor}','{resume}','resume',$r${auto_reason}$r$,'{park}');")
        assert run(psql, "SELECT count(*) FROM ca_launch_floor_resume_receipts;") == '2'

        # 6. An unscoped park expires the same way.
        park2 = '30000000-0000-0000-0000-000000000011'
        run(psql, prefix + f"SELECT fn_ca_engine_operator_command('{actor}','{park2}','floor','park','Platform Wide Park');")
        run(psql, f"INSERT INTO table_seats VALUES('{t_out}',NULL,'40000000-0000-0000-0000-000000000007');", refuse='OPERATOR_FLOOR_PARKED')
        run(psql, "UPDATE ca_operator_floor_hold SET held_since=clock_timestamp()-interval '2 hours', expires_at=clock_timestamp()-interval '1 hour';")
        w = json.loads(run(psql, "SELECT fn_ca_operator_floor_hold_watchdog();"))
        assert w['raised'] == 1 and w['released'] is True and w['receipts_written'] == 0, w
        assert run(psql, "SELECT count(*) FROM ca_operator_floor_hold;") == '0'
        assert run(psql, "SELECT count(*) FROM financial_alerts WHERE NOT resolved;") == '0'
        run(psql, f"INSERT INTO table_seats VALUES('{t_out}',NULL,'40000000-0000-0000-0000-000000000008');")
        assert run(psql, f"SELECT count(*) FROM ca_operator_floor_hold_releases WHERE park_operation_id='{park2}' AND NOT scoped;") == '1'

        # Grants: nothing here is callable by a client.
        for sig in ['fn_ca_operator_floor_hold_watchdog()', 'fn_ca_operator_floor_hold_renew(uuid,uuid,text)', 'fn_ca_operator_floor_hold_open_alert(uuid)']:
            assert run(psql, f"SELECT NOT has_function_privilege('authenticated','{sig}','EXECUTE') AND NOT has_function_privilege('anon','{sig}','EXECUTE');") == 't', sig
        assert run(psql, "SELECT has_function_privilege('service_role','fn_ca_operator_floor_hold_renew(uuid,uuid,text)','EXECUTE');") == 't'

        result = {'qualification': 'passed', 'lease_stamped_by_untouched_owners': True, 'one_alert_per_hold': True,
                  'owner_renews_as_service_role_only': True, 'expiry_releases_like_owner_resume': True,
                  'late_close_receipted_next_tick': True, 'unscoped_park_expires': True,
                  'candidate': args.candidate.name, 'production_installation': False}
        if args.output:
            args.output.write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result))
    finally:
        run([pg / 'pg_ctl', '-D', data, '-m', 'immediate', '-w', 'stop'])
