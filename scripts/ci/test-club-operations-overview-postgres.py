#!/usr/bin/env python3
"""Qualify the exact installed overview and five guarded repairs in private PG17."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'scripts/ci/fixtures/club-operations-overview'
MIGRATION = ROOT / 'supabase/migrations/20261011190124_operations_counts_follow_membership_and_live_tables.sql'
PG = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
parent = os.environ.get('CLUB_OPERATIONS_PG_SCRATCH_PARENT') or os.environ.get('TMPDIR') or os.environ.get('RUNNER_TEMP')
if not parent:
    raise SystemExit('Set task-owned SSD scratch parent or RUNNER_TEMP')
if os.uname().sysname == 'Darwin' and not str(Path(parent).resolve()).startswith('/Volumes/SmarterWork/agent-work/'):
    raise SystemExit('Mac qualification requires the external SSD')
cluster = Path(tempfile.mkdtemp(prefix='co-', dir=parent))
data, socket = cluster / 'd', cluster / 's'
socket.mkdir()
if len(str(socket).encode()) > 95:
    shutil.rmtree(cluster)
    raise SystemExit('Use shorter task-owned scratch parent for PostgreSQL socket')
env = {'PATH': str(PG) + ':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
started = False
CLUB = '00000000-0000-0000-0000-000000000001'
USER = CLUB

def run(args, sql=None, refused=None):
    p = subprocess.run([str(a) for a in args], input=sql, text=True,
                       capture_output=True, env=env, timeout=90)
    if refused:
        assert p.returncode and refused in p.stderr, p.stdout + p.stderr
        print('PASS: refused ' + refused, flush=True)
    elif p.returncode:
        raise RuntimeError(p.stdout + p.stderr)
    return p.stdout.strip()

def q(sql, refused=None):
    return run([PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',socket,'-U','postgres','-d','postgres'],sql,refused)

def reading(role='authenticated', user=USER):
    return json.loads(q(f"SET SESSION AUTHORIZATION {role}; SET request.jwt.claim.role='{role}'; SET request.jwt.claim.sub='{user}'; SELECT ca_club_operations_overview('{CLUB}');"))

def metadata():
    return q("SELECT json_build_object('owner',proowner::regrole::text,'acl',proacl,'definer',prosecdef,'config',proconfig)::text FROM pg_proc WHERE oid='ca_club_operations_overview(uuid)'::regprocedure")

try:
    assert ' 17.' in run([PG/'postgres','--version'])
    run([PG/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'])
    with (data/'postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) + "'\nautovacuum=off\n")
    started = True
    run([PG/'pg_ctl','-D',data,'-l',cluster/'server.log','-w','start'])
    assert json.loads(q("SELECT json_build_object('address',inet_server_addr(),'listen',current_setting('listen_addresses'))")) == {'address':None,'listen':''}
    q(FIXTURE.joinpath('setup.sql').read_text())
    q(FIXTURE.joinpath('installed.sql').read_text())
    q(FIXTURE.joinpath('activity-installed.sql').read_text())
    q("REVOKE ALL ON FUNCTION ca_club_operations_overview(uuid) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION ca_club_operations_overview(uuid) TO authenticated,service_role;")
    assert q("SELECT md5(pg_get_functiondef('ca_club_operations_overview(uuid)'::regprocedure))") == 'ff2f0b8132efc1c1091594d230c990d6'
    q("REVOKE ALL ON FUNCTION ca_club_activity(uuid,integer) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION ca_club_activity(uuid,integer) TO authenticated,service_role;")
    assert q("SELECT md5(pg_get_functiondef('ca_club_activity(uuid,integer)'::regprocedure))")=='6e4702f9aa88dabc1e472a399df319f1'
    activity_before=q(f"SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM ca_club_activity('{CLUB}',100) a")
    activity_metadata=q("SELECT json_build_object('owner',proowner::regrole::text,'acl',proacl,'definer',prosecdef,'config',proconfig)::text FROM pg_proc WHERE oid='ca_club_activity(uuid,integer)'::regprocedure")
    before = reading()
    assert before['kpis']['members_new_7d'] == 4
    assert before['kpis']['online_now'] == 8
    assert before['kpis']['rake_today'] == 0
    assert before['counts']['anti_cheat_flags_open'] == 1
    original_metadata = metadata()
    ledger = q('SELECT md5(jsonb_agg(to_jsonb(m) ORDER BY user_id)::text) FROM club_members m')
    q(MIGRATION.read_text())
    assert q("SELECT md5(prosrc) FROM pg_proc WHERE oid='ca_club_operations_overview(uuid)'::regprocedure") == '0cc301a559126c36a249454976733a4c'
    assert q("SELECT md5(prosrc) FROM pg_proc WHERE oid='ca_club_activity(uuid,integer)'::regprocedure")=='c9d199dd6f2a4be40aa3846acabb5c98'
    assert q(f"SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM ca_club_activity('{CLUB}',100) a")==activity_before
    activity=json.loads(activity_before)
    hands=[row for row in activity if row['activity_type']=='big_hand']
    assert len(hands)==30
    assert all('80.00' in row['message'] and row['display_name']=='Fixture Alias' and row['avatar_url']=='fixture.png' for row in hands)
    assert q("SELECT json_build_object('owner',proowner::regrole::text,'acl',proacl,'definer',prosecdef,'config',proconfig)::text FROM pg_proc WHERE oid='ca_club_activity(uuid,integer)'::regprocedure")==activity_metadata
    print('PASS: activity equivalence, forty-eight hour/threshold/top-thirty boundaries, names and unchanged authority',flush=True)
    after = reading()
    assert after['kpis']['members_new_7d'] == 3
    assert after['kpis']['online_now'] == 4
    assert after['kpis']['seated_now'] == 2
    assert after['kpis']['hands_today'] == 0
    assert after['kpis']['rake_today'] == 130482.8648
    assert after['counts']['anti_cheat_flags_open'] == 3
    assert after['kpis']['club_bank'] == before['kpis']['club_bank'] == 123456.789
    assert after['kpis']['member_chips'] == before['kpis']['member_chips']
    assert after['kpis']['members_pending'] == before['kpis']['members_pending'] == 1
    assert metadata() == original_metadata
    assert q('SELECT md5(jsonb_agg(to_jsonb(m) ORDER BY user_id)::text) FROM club_members m') == ledger
    print('PASS: five real source repairs, distinct seats/flags, money and catalog unchanged',flush=True)
    # The joined member remains one flag target even with duplicate membership rows.
    q(f"INSERT INTO club_members SELECT * FROM club_members WHERE user_id='{USER}';")
    assert reading()['counts']['anti_cheat_flags_open'] == 3
    q(f"DELETE FROM club_members WHERE ctid IN (SELECT ctid FROM club_members WHERE user_id='{USER}' ORDER BY ctid DESC LIMIT 1);")
    for role, finance, control in [('owner',True,True),('co_owner',True,True),('admin',True,True),('super_agent',True,False),('agent',False,False)]:
        q(f"UPDATE club_members SET role='{role}' WHERE user_id='{USER}';")
        result=reading()
        assert result['viewer']['can_view_finance'] is finance
        assert result['viewer']['can_control_club'] is control
        assert ('club_bank' in result['kpis']) is finance
        assert (result['counts']['invoices_open'] is not None) is finance
    q(f"UPDATE club_members SET role='member' WHERE user_id='{USER}';")
    q(f"SET SESSION AUTHORIZATION authenticated; SET request.jwt.claim.role='authenticated'; SET request.jwt.claim.sub='{USER}'; SELECT ca_club_operations_overview('{CLUB}');",'not authorized for this club')
    q(f"UPDATE profiles SET platform_admin=true WHERE id='{USER}';")
    assert reading()['viewer']['can_view_finance'] is True
    assert reading('service_role','')['viewer']['can_view_finance'] is True
    q(f"SET SESSION AUTHORIZATION anon; SET request.jwt.claim.role='anon'; SELECT ca_club_operations_overview('{CLUB}');",'permission denied for function')
    q(f"SET SESSION AUTHORIZATION authenticated; SET request.jwt.claim.role='authenticated'; SET request.jwt.claim.sub=''; SELECT ca_club_operations_overview('{CLUB}');",'not authorized for this club')
    print('PASS: role matrix, platform/service access and anonymous/nonmember refusal',flush=True)
    # Missing hand rows cannot erase rake; hand counts and UTC club/day isolation are independent.
    q(f"INSERT INTO club_hand_daily VALUES('{CLUB}',(now() AT TIME ZONE 'UTC')::date,17,999999);")
    result=reading()
    assert result['kpis']['hands_today']==17 and result['kpis']['rake_today']==130482.8648
    q(f"DELETE FROM ca_club_rake_daily WHERE club_id='{CLUB}';")
    assert reading()['kpis']['rake_today']==0
    q(f"INSERT INTO ca_club_rake_daily VALUES('{CLUB}',(now() AT TIME ZONE 'UTC')::date-1,7,8),('00000000-0000-0000-0000-000000000002',(now() AT TIME ZONE 'UTC')::date,9,10);")
    assert reading()['kpis']['rake_today']==0
    print('PASS: missing hand/rake rows, separate hand source and club/UTC date boundaries',flush=True)
    # Repeated installation and changed source fail atomically without catalog damage.
    q(MIGRATION.read_text(),'changed; re-read and requalify')
    q(FIXTURE.joinpath('installed.sql').read_text())
    q("DO $$BEGIN EXECUTE replace(pg_get_functiondef('ca_club_operations_overview(uuid)'::regprocedure),'v_hands_today       bigint := 0','v_hands_today       bigint := 123'); END$$;")
    tampered=q("SELECT md5(prosrc) FROM pg_proc WHERE oid='ca_club_operations_overview(uuid)'::regprocedure")
    q(MIGRATION.read_text(),'changed; re-read and requalify')
    assert q("SELECT md5(prosrc) FROM pg_proc WHERE oid='ca_club_operations_overview(uuid)'::regprocedure")==tampered
    assert metadata()==original_metadata
    print('PASS: tampered preimage/replay refusal; transaction preserves catalog',flush=True)
    q(FIXTURE.joinpath('installed.sql').read_text())
    q(FIXTURE.joinpath('activity-installed.sql').read_text())
    q("DO $$BEGIN EXECUTE replace(pg_get_functiondef('ca_club_activity(uuid,integer)'::regprocedure),'LIMIT 30','LIMIT 29'); END$$;")
    q(MIGRATION.read_text(),'Club activity changed')
    assert q("SELECT md5(prosrc) FROM pg_proc WHERE oid='ca_club_operations_overview(uuid)'::regprocedure")=='56fce10a30115b2d8b84891229af5de7'
    print('PASS: activity preimage refusal atomically rolls back preceding overview changes',flush=True)
finally:
    if started:
        run([PG/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
    shutil.rmtree(cluster)
