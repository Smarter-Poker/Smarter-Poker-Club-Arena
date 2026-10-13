#!/usr/bin/env python3
"""Actual recap functions on a private socket-only PG17, never production."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor

ROOT = Path(__file__).resolve().parents[2]
USER = '00000000-0000-4000-8000-000000000002'
TABLE = '00000000-0000-4000-8000-000000000004'
OCCUPANCY = '00000000-0000-4000-8000-000000000006'
NEXT_TABLE = '00000000-0000-4000-8000-000000000007'
NEXT_OCCUPANCY = '00000000-0000-4000-8000-000000000008'
PORT = '54873'
OLD = ROOT / 'supabase/migrations/20261012062409_the_session_recap_reads_the_whole_session_from_the_server.sql'
NEW = ROOT / 'supabase/migrations/20261012191403_the_finished_diamond_session_recap_follows_its_exact_custody.sql'

def binary(name):
    for base in (os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'),
                 '/usr/lib/postgresql/17/bin', '/usr/pgsql-17/bin'):
        candidate = Path(base) / name
        if candidate.exists():
            return str(candidate)
    found = shutil.which(name)
    if not found:
        raise RuntimeError(f'PostgreSQL 17 binary missing: {name}')
    return found

def main():
    version = subprocess.check_output([binary('postgres'), '--version'], text=True)
    assert ' 17.' in version, version
    # On the Mac all scratch belongs to this SSD task. On hosted Linux the
    # existing qualification runner supplies its ordinary temporary storage.
    scratch = ROOT.parent if sys.platform == 'darwin' else None
    if sys.platform == 'darwin':
        assert str(ROOT).startswith('/Volumes/SmarterWork/agent-work/'), 'SSD checkout required'
    env = {**os.environ, 'LC_ALL': 'C', 'LANG': 'C'}
    with tempfile.TemporaryDirectory(prefix='recap-', dir=scratch) as folder:
        tmp = Path(folder)
        socket = tmp / 's'
        socket.mkdir()
        data = tmp / 'data'
        log = tmp / 'postgres.log'
        subprocess.run([binary('initdb'), '-D', str(data), '-A', 'trust', '--no-locale', '-E', 'UTF8'],
                       check=True, env=env, stdout=subprocess.DEVNULL)
        subprocess.run([binary('pg_ctl'), '-D', str(data), '-l', str(log), '-o',
                        f"-k {socket} -p {PORT} -c listen_addresses=''"] + ['start'],
                       check=True, env=env, stdout=subprocess.DEVNULL)
        try:
            base = [binary('psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                    '-h', str(socket), '-p', PORT, '-d', 'postgres']
            def run(sql, ok=True):
                result = subprocess.run(base, input=sql, text=True, capture_output=True, env=env)
                if ok and result.returncode:
                    raise AssertionError(result.stderr)
                if not ok:
                    assert result.returncode != 0, 'expected refusal did not occur'
                return result
            def query(sql, role='postgres', user=USER):
                output = run(f"SET ROLE {role}; SET request.jwt.claim.sub='{user}'; {sql}").stdout.strip()
                return json.loads(output.splitlines()[-1]) if output else None
            def recap(table=TABLE, occupancy=OCCUPANCY, notify=False, role='authenticated', user=USER):
                name = 'fn_notify_my_diamond_cash_session_recap' if notify else 'fn_my_diamond_cash_session_recap'
                return query(f"SELECT {name}('{table}','{occupancy}')::text;", role, user)

            assert run("SELECT inet_server_addr() IS NULL;").stdout.strip() == 't'
            run("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='postgres') THEN CREATE ROLE postgres SUPERUSER; END IF; END $$;")
            run((ROOT / 'tests/sql/diamond-session-recap.fixture.sql').read_text())
            run('SET ROLE postgres;\n' + OLD.read_text())
            before = query(f"SELECT fn_my_table_session_facts('{TABLE}')::text;")
            assert before['hands_played'] == 3 and before['hands_won'] == 2
            assert query("SELECT count(*) FROM ca_hand_facts WHERE returned>0;") == 1
            print('BEFORE FAIL VERIFIED: old next-stack inference invents two wins; actual awards prove one.')

            run('SET ROLE postgres;\n' + NEW.read_text())
            assert query(f"SELECT fn_my_table_session_facts('{TABLE}')::text;")['hands_won'] == 1
            pending = recap(notify=True)
            assert pending['status'] == 'pending' and pending['profit_loss'] is None
            assert query('SELECT count(*) FROM notifications;') == 0
            run("UPDATE poker_diamond_custody SET state='released',balance=0,released_at='2026-10-12 05:05Z';"
                "INSERT INTO poker_diamond_movements VALUES('00000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-000000000001',"
                f"'{USER}','release',1500,'{{}}','2026-10-12 05:05Z');")
            with ThreadPoolExecutor(max_workers=2) as pool:
                concurrent = list(pool.map(lambda _: recap(notify=True), range(2)))
            assert concurrent[0] == concurrent[1]
            settled = concurrent[0]
            assert settled['total_buy_in'] == 1500 and settled['profit_loss'] == 0
            assert settled['hands_played'] == 3 and settled['hands_won'] == 1
            assert settled['vpip_percent'] == 67 and settled['total_rebuys'] == 1
            assert settled['peak_stack'] == 1500
            assert recap(notify=True) == settled
            assert query('SELECT count(*) FROM notifications;') == 1
            assert query("SELECT to_jsonb(metadata->>'custodyId')::text FROM notifications;") == settled['custody_id']
            assert recap(user='00000000-0000-4000-8000-000000000099') is None
            assert recap(occupancy=NEXT_OCCUPANCY) is None
            refused = run(f"SET ROLE anon; SELECT fn_my_diamond_cash_session_recap('{TABLE}','{OCCUPANCY}');", False)
            assert 'permission denied for function fn_my_diamond_cash_session_recap' in refused.stderr
            denied_insert = run(f"SET ROLE authenticated; SET request.jwt.claim.sub='{USER}'; INSERT INTO notifications(id,user_id,type,title) VALUES('{NEXT_OCCUPANCY}','{USER}','system','Forged');", False)
            assert 'row-level security' in denied_insert.stderr
            replay = run('SET ROLE postgres;\n' + NEW.read_text(), False)
            assert 'diamond_final_recap_migration_already_installed' in replay.stderr
            run("DELETE FROM ca_hand_facts WHERE hand_id='00000000-0000-4000-8000-000000000023';")
            missing = recap()
            assert missing['facts_complete'] is False and missing['hands_won'] is None and missing['vpip_percent'] is None
            assert missing['profit_loss'] == 0 and missing['hands_played'] == 3
            run("INSERT INTO ca_hand_facts SELECT h.id,'" + USER + "',h.table_id,h.created_at,50,200,150,true FROM hand_history h WHERE h.hand_number=1000023;")

            # A retargeted custody retains its original reserve and source hands.
            run(f"DELETE FROM notifications; UPDATE poker_diamond_custody SET target_id='{NEXT_TABLE}',occupancy_id='{NEXT_OCCUPANCY}',seat_joined_at='2026-10-12 05:03:30Z';"
                f"INSERT INTO cash_seat_move_receipts VALUES('00000000-0000-4000-8000-000000000031','{USER}','00000000-0000-4000-8000-000000000032','00000000-0000-4000-8000-000000000003','{TABLE}','{OCCUPANCY}','{NEXT_TABLE}','{NEXT_OCCUPANCY}','2026-10-12 05:03:30Z');"
                f"UPDATE hand_history SET table_id='{NEXT_TABLE}' WHERE hand_number=1000023; UPDATE ca_hand_facts SET table_id='{NEXT_TABLE}' WHERE hand_id='00000000-0000-4000-8000-000000000023';"
                f"INSERT INTO poker_diamond_jackpot_ledger VALUES(1,'payout',-1000,'{TABLE}',1000021,'{USER}','00000000-0000-4000-8000-000000000041'),"
                f"(2,'payout',-9000,'{TABLE}',1000021,'00000000-0000-4000-8000-000000000099','00000000-0000-4000-8000-000000000042'),"
                f"(3,'contribution',100,'{TABLE}',1000021,'{USER}',NULL);"
                f"INSERT INTO hand_history VALUES('00000000-0000-4000-8000-000000000024','{TABLE}','2026-10-12 05:04Z','2026-10-12 05:04Z','2026-10-12 05:04Z',1000024,jsonb_build_array(jsonb_build_object('userId','{USER}','stack',9999)),100);"
                f"INSERT INTO poker_diamond_jackpot_ledger VALUES(4,'payout',-5000,'{TABLE}',1000024,'{USER}','00000000-0000-4000-8000-000000000044');")
            moved = recap(NEXT_TABLE, NEXT_OCCUPANCY, True)
            assert moved['hands_played'] == 3 and moved['hands_won'] == 1 and moved['peak_stack'] == 1500
            assert moved['total_buy_in'] == 1500 and moved['jackpot_awards'] == 1000 and moved['profit_loss'] == 1000
            assert recap(NEXT_TABLE, NEXT_OCCUPANCY, True) == moved
            assert query('SELECT count(*) FROM notifications;') == 1
            assert recap() is None
            # A bust plus an award paid outside the seat is neither a loss nor
            # a fabricated stack refund. The two real rails add exactly once.
            busted_occupancy = '00000000-0000-4000-8000-000000000056'
            run(f"INSERT INTO poker_diamond_custody VALUES('00000000-0000-4000-8000-000000000050','{USER}','00000000-0000-4000-8000-000000000003','cash_seat','{TABLE}','busted',0,'released','2026-10-12 06:00Z','2026-10-12 06:05Z','00000000-0000-4000-8000-000000000055','2026-10-12 06:00Z','{busted_occupancy}');"
                f"INSERT INTO poker_diamond_movements VALUES('00000000-0000-4000-8000-000000000051','00000000-0000-4000-8000-000000000050','{USER}','reserve',1000,'{{}}','2026-10-12 06:00Z'),"
                f"('00000000-0000-4000-8000-000000000052','00000000-0000-4000-8000-000000000050','{USER}','release',0,'{{}}','2026-10-12 06:05Z');"
                f"INSERT INTO hand_history VALUES('00000000-0000-4000-8000-000000000026','{TABLE}','2026-10-12 06:01Z','2026-10-12 06:01Z','2026-10-12 06:01Z',1000026,jsonb_build_array(jsonb_build_object('userId','{USER}','stack',0)),2000);"
                f"INSERT INTO ca_hand_facts VALUES('00000000-0000-4000-8000-000000000026','{USER}','{TABLE}','2026-10-12 06:01Z',1000,0,-1000,true);"
                f"INSERT INTO poker_diamond_jackpot_ledger VALUES(6,'payout',-1000,'{TABLE}',1000026,'{USER}','00000000-0000-4000-8000-000000000046');")
            bust = recap(TABLE, busted_occupancy, True)
            assert bust['total_buy_in'] == 1000 and bust['chips_returned'] == 0 and bust['jackpot_awards'] == 1000 and bust['profit_loss'] == 0
            assert bust['hands_played'] == 1 and bust['hands_won'] == 0
            no_update = run("UPDATE notifications SET user_id='00000000-0000-4000-8000-000000000099';", False)
            assert 'notification_update_is_forbidden' in no_update.stderr
            print('Diamond final session recap passed isolated PostgreSQL 17: source failure, exact custody, moves, awards, permissions, duplicates and replay refusal.')
        finally:
            subprocess.run([binary('pg_ctl'), '-D', str(data), '-m', 'immediate', 'stop'],
                           check=True, env=env, stdout=subprocess.DEVNULL)

if __name__ == '__main__':
    main()
