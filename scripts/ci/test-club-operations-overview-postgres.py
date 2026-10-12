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
    q(FIXTURE.joinpath('bomb-rollup-installed.sql').read_text())
    q(FIXTURE.joinpath('bomb-catchup-installed.sql').read_text())
    q(FIXTURE.joinpath('bomb-report-installed.sql').read_text())
    q(FIXTURE.joinpath('dashboard-installed.sql').read_text())
    q("REVOKE ALL ON FUNCTION ca_club_operations_overview(uuid) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION ca_club_operations_overview(uuid) TO authenticated,service_role;")
    assert q("SELECT md5(pg_get_functiondef('ca_club_operations_overview(uuid)'::regprocedure))") == 'ff2f0b8132efc1c1091594d230c990d6'
    q("REVOKE ALL ON FUNCTION ca_club_activity(uuid,integer) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION ca_club_activity(uuid,integer) TO authenticated,service_role;")
    assert q("SELECT md5(pg_get_functiondef('ca_club_activity(uuid,integer)'::regprocedure))")=='6e4702f9aa88dabc1e472a399df319f1'
    activity_before=q(f"SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM ca_club_activity('{CLUB}',100) a")
    activity_metadata=q("SELECT json_build_object('owner',proowner::regrole::text,'acl',proacl,'definer',prosecdef,'config',proconfig)::text FROM pg_proc WHERE oid='ca_club_activity(uuid,integer)'::regprocedure")
    q("REVOKE ALL ON FUNCTION fn_club_bomb_pot_report(uuid,integer) FROM PUBLIC,anon,authenticated,service_role; GRANT EXECUTE ON FUNCTION fn_club_bomb_pot_report(uuid,integer) TO authenticated,service_role;")
    q("REVOKE ALL ON FUNCTION fn_ca_bomb_pot_rollup_day(uuid,date),fn_ca_bomb_pot_catchup(uuid,integer) FROM PUBLIC,anon,authenticated,service_role; GRANT EXECUTE ON FUNCTION fn_ca_bomb_pot_rollup_day(uuid,date),fn_ca_bomb_pot_catchup(uuid,integer) TO service_role;")
    bomb_signatures=['fn_club_bomb_pot_report(uuid,integer)','fn_ca_bomb_pot_rollup_day(uuid,date)']
    bomb_meta={sig:q(f"SELECT json_build_object('owner',proowner::regrole::text,'acl',proacl,'definer',prosecdef,'config',proconfig)::text FROM pg_proc WHERE oid='{sig}'::regprocedure") for sig in bomb_signatures}
    yesterday="(now() AT TIME ZONE 'UTC')::date-2"
    assert q(f"SELECT fn_ca_bomb_pot_rollup_day('{CLUB}',{yesterday})")=='1'
    bomb_day_before=q('SELECT jsonb_agg(to_jsonb(d) ORDER BY day,table_id) FROM ca_club_bomb_pot_daily d')
    bomb_before=q(f"SET request.jwt.claim.sub='{USER}'; SELECT jsonb_agg(to_jsonb(r) ORDER BY table_id,trigger_reason,board_count,variant) FROM fn_club_bomb_pot_report('{CLUB}',30) r")
    assert json.loads(bomb_before)[0]['hands']==4
    assert json.loads(bomb_before)[0]['total_rake']==10
    assert json.loads(bomb_before)[0]['scoops']==1 and json.loads(bomb_before)[0]['splits']==1
    assert json.loads(bomb_before)[0]['unrecorded_hands']==2
    q("REVOKE ALL ON FUNCTION ca_club_dashboard_stats(uuid) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION ca_club_dashboard_stats(uuid) TO authenticated,service_role;")
    assert q("SELECT md5(pg_get_functiondef('ca_club_dashboard_stats(uuid)'::regprocedure))")=='f82002cb3b36a4454a9f6e17af141985'
    stats_before=json.loads(q(f"SELECT ca_club_dashboard_stats('{CLUB}')"))
    assert stats_before['total_members']==6 and stats_before['online_now']==9 and stats_before['new_this_week']==6 and stats_before['seated_now']==4
    stats_metadata=q("SELECT json_build_object('owner',proowner::regrole::text,'acl',proacl,'definer',prosecdef,'config',proconfig)::text FROM pg_proc WHERE oid='ca_club_dashboard_stats(uuid)'::regprocedure")
    before = reading()
    assert before['kpis']['members_new_7d'] == 4
    assert before['kpis']['online_now'] == 9
    assert before['kpis']['rake_today'] == 0
    assert before['counts']['anti_cheat_flags_open'] == 1
    original_metadata = metadata()
    ledger = q('SELECT md5(jsonb_agg(to_jsonb(m) ORDER BY user_id)::text) FROM club_members m')
    q(MIGRATION.read_text())
    assert q("SELECT md5(prosrc) FROM pg_proc WHERE oid='ca_club_operations_overview(uuid)'::regprocedure") == 'f37429f441b5a31bceb13700d6b8d015'
    assert q("SELECT md5(prosrc) FROM pg_proc WHERE oid='ca_club_dashboard_stats(uuid)'::regprocedure")=='0d64c2d9d5f63a68418ce21c4442b8f0'
    stats_after=json.loads(q(f"SELECT ca_club_dashboard_stats('{CLUB}')"))
    assert stats_after['total_members']==3 and stats_after['online_now']==3 and stats_after['new_this_week']==2 and stats_after['seated_now']==2
    personnel={'total_members','online_now','new_this_week','seated_now'}
    assert {k:v for k,v in stats_before.items() if k not in personnel}=={k:v for k,v in stats_after.items() if k not in personnel}
    assert q("SELECT json_build_object('owner',proowner::regrole::text,'acl',proacl,'definer',prosecdef,'config',proconfig)::text FROM pg_proc WHERE oid='ca_club_dashboard_stats(uuid)'::regprocedure")==stats_metadata
    q(f"SET SESSION AUTHORIZATION authenticated; SET request.jwt.claim.sub=''; SELECT ca_club_dashboard_stats('{CLUB}')",'not authorized for this club')
    q(f"SET SESSION AUTHORIZATION anon; SELECT ca_club_dashboard_stats('{CLUB}')",'permission denied for function')
    print('PASS: dashboard personnel matches roster; all financial/day/weekly fields, dates and authority unchanged',flush=True)
    assert q("SELECT md5(prosrc) FROM pg_proc WHERE oid='fn_club_bomb_pot_report(uuid,integer)'::regprocedure")=='db2daf3cd7367513cf219d75ea1377ba'
    assert q("SELECT md5(prosrc) FROM pg_proc WHERE oid='fn_ca_bomb_pot_rollup_day(uuid,date)'::regprocedure")=='f8b2e4eda1ee5c7d75243f1448566ea2'
    q('TRUNCATE ca_club_bomb_pot_daily,ca_club_bomb_pot_complete')
    assert q(f"SELECT fn_ca_bomb_pot_rollup_day('{CLUB}',{yesterday})")=='1'
    assert q('SELECT jsonb_agg(to_jsonb(d) ORDER BY day,table_id) FROM ca_club_bomb_pot_daily d')==bomb_day_before
    assert q(f"SET request.jwt.claim.sub='{USER}'; SELECT jsonb_agg(to_jsonb(r) ORDER BY table_id,trigger_reason,board_count,variant) FROM fn_club_bomb_pot_report('{CLUB}',30) r")==bomb_before
    assert q(f"SELECT fn_ca_bomb_pot_rollup_day('{CLUB}',(now() AT TIME ZONE 'UTC')::date)")=='0'
    assert q(f"SELECT fn_ca_bomb_pot_rollup_day(NULL,{yesterday})")=='0'
    assert q(f"SELECT count(*) FROM ca_club_bomb_pot_complete WHERE club_id='{CLUB}' AND day=(now() AT TIME ZONE 'UTC')::date-4")=='0'
    for sig in bomb_signatures:
        assert q(f"SELECT json_build_object('owner',proowner::regrole::text,'acl',proacl,'definer',prosecdef,'config',proconfig)::text FROM pg_proc WHERE oid='{sig}'::regprocedure")==bomb_meta[sig]
    q(f"SET request.jwt.claim.sub=''; SELECT * FROM fn_club_bomb_pot_report('{CLUB}',30)",'not_authenticated')
    q(f"SET request.jwt.claim.sub='00000000-0000-0000-0000-000000000006'; SELECT * FROM fn_club_bomb_pot_report('{CLUB}',30)",'not_authorized')
    assert q(f"SET SESSION AUTHORIZATION authenticated; SET request.jwt.claim.sub='{USER}'; SELECT sum(hands) FROM fn_club_bomb_pot_report('{CLUB}',30)")=='4'
    q(f"SET SESSION AUTHORIZATION authenticated; SELECT fn_ca_bomb_pot_rollup_day('{CLUB}',{yesterday})",'permission denied for function')
    q(f"SET SESSION AUTHORIZATION anon; SELECT * FROM fn_club_bomb_pot_report('{CLUB}',30)",'permission denied for function')
    print('PASS: actual bomb rollup/report equivalence, catchup/sealing, UTC/date/foreign/null table boundaries and authority',flush=True)
    assert q("SELECT md5(prosrc) FROM pg_proc WHERE oid='ca_club_activity(uuid,integer)'::regprocedure")=='c9d199dd6f2a4be40aa3846acabb5c98'
    assert q(f"SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM ca_club_activity('{CLUB}',100) a")==activity_before
    activity=json.loads(activity_before)
    hands=[row for row in activity if row['activity_type']=='big_hand']
    assert len(hands)==30
    assert all('80.00' in row['message'] and row['display_name']=='Fixture Alias' and row['avatar_url']=='fixture.png' for row in hands)
    assert q("SELECT json_build_object('owner',proowner::regrole::text,'acl',proacl,'definer',prosecdef,'config',proconfig)::text FROM pg_proc WHERE oid='ca_club_activity(uuid,integer)'::regprocedure")==activity_metadata
    print('PASS: activity equivalence, forty-eight hour/threshold/top-thirty boundaries, names and unchanged authority',flush=True)
    after = reading()
    assert after['kpis']['members_new_7d'] == 2
    assert after['kpis']['members'] == 3
    assert after['kpis']['online_now'] == 3
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
    q(FIXTURE.joinpath('installed.sql').read_text())
    q(FIXTURE.joinpath('activity-installed.sql').read_text())
    q(FIXTURE.joinpath('bomb-report-installed.sql').read_text())
    q(FIXTURE.joinpath('bomb-rollup-installed.sql').read_text())
    q("DO $$BEGIN EXECUTE replace(pg_get_functiondef('fn_club_bomb_pot_report(uuid,integer)'::regprocedure),'365','364'); END$$;")
    tampered_report=q("SELECT md5(prosrc) FROM pg_proc WHERE oid='fn_club_bomb_pot_report(uuid,integer)'::regprocedure")
    q(MIGRATION.read_text(),'Bomb pot reporting source changed')
    assert q("SELECT md5(prosrc) FROM pg_proc WHERE oid='ca_club_operations_overview(uuid)'::regprocedure")=='56fce10a30115b2d8b84891229af5de7'
    assert q("SELECT md5(prosrc) FROM pg_proc WHERE oid='ca_club_activity(uuid,integer)'::regprocedure")=='50002a220d610b93ed9b368e619e321c'
    assert q("SELECT md5(prosrc) FROM pg_proc WHERE oid='fn_club_bomb_pot_report(uuid,integer)'::regprocedure")==tampered_report
    q(FIXTURE.joinpath('bomb-report-installed.sql').read_text())
    q("DO $$BEGIN EXECUTE replace(pg_get_functiondef('fn_ca_bomb_pot_rollup_day(uuid,date)'::regprocedure),$old$interval '15 minutes'$old$,$new$interval '14 minutes'$new$); END$$;")
    q(MIGRATION.read_text(),'Bomb pot reporting source changed')
    assert q("SELECT md5(prosrc) FROM pg_proc WHERE oid='fn_club_bomb_pot_report(uuid,integer)'::regprocedure")=='635cce48ca50b92c3ef235be220d7dc8'
    print('PASS: report/rollup changed-source refusals atomically preserve all prior function sources',flush=True)
    for fixture in ['installed.sql','activity-installed.sql','bomb-report-installed.sql','bomb-rollup-installed.sql','dashboard-installed.sql']:
        q(FIXTURE.joinpath(fixture).read_text())
    q("DO $$BEGIN EXECUTE replace(pg_get_functiondef('ca_club_dashboard_stats(uuid)'::regprocedure),'v_today - 13','v_today - 12'); END$$;")
    tampered_stats=q("SELECT md5(prosrc) FROM pg_proc WHERE oid='ca_club_dashboard_stats(uuid)'::regprocedure")
    q(MIGRATION.read_text(),'Club dashboard source changed')
    assert q("SELECT md5(prosrc) FROM pg_proc WHERE oid='ca_club_operations_overview(uuid)'::regprocedure")=='56fce10a30115b2d8b84891229af5de7'
    assert q("SELECT md5(prosrc) FROM pg_proc WHERE oid='fn_club_bomb_pot_report(uuid,integer)'::regprocedure")=='635cce48ca50b92c3ef235be220d7dc8'
    assert q("SELECT md5(prosrc) FROM pg_proc WHERE oid='ca_club_dashboard_stats(uuid)'::regprocedure")==tampered_stats
    print('PASS: dashboard source guard rejects drift and rolls back every earlier function change',flush=True)


finally:
    if started:
        run([PG/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
    shutil.rmtree(cluster)
