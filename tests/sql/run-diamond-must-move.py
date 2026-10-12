#!/usr/bin/env python3
"""Actual Diamond cluster/custody transactions on a private PostgreSQL17 socket.

No URL, password or production data input is accepted. The retained catalog
columns/preimages and real occupancy/deferred custody triggers are fixture
inputs. Auth/maintenance predicates model transport authority only. This is
focused transaction qualification, not full production RLS or gameplay proof.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'tests/fixtures/diamond-must-move'
PORT = '55731'
PG_BIN = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
PROOF = 'Diamond must-move custody, spawning, affordability and replay checks passed on isolated PostgreSQL 17; not a production certification.'
M = '66666666-6666-4666-8666-666666666666'
G = '33333333-3333-4333-8333-333333333333'
U = '11111111-1111-4111-8111-111111111111'
V = '22222222-2222-4222-8222-222222222222'
T = '44444444-4444-4444-8444-444444444444'
DEST = '55555555-5555-4555-8555-555555555555'


def main():
    version = subprocess.check_output([str(PG_BIN / 'postgres'), '--version'], text=True)
    if not version.startswith('postgres (PostgreSQL) 17.'):
        raise RuntimeError('PostgreSQL17 is required')
    # ROOT.parent is the owned SSD task folder on the Mac. Keep the socket
    # shorter than Unix's path limit even when TMPDIR points at a long path.
    cluster = Path(tempfile.mkdtemp(prefix='dm.', dir=ROOT.parent))
    socket = cluster / 's'
    socket.mkdir()
    running = False
    psql = [str(PG_BIN / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
            '-h', str(socket), '-p', PORT, '-U', 'postgres', '-d', 'postgres']

    def run(query=None, file=None, error=None):
        command = psql + (['-f', str(file)] if file else ['-c', query])
        result = subprocess.run(command, text=True, capture_output=True)
        if error:
            assert result.returncode != 0 and error in result.stderr, result.stderr
            return
        if result.returncode:
            raise AssertionError(result.stderr)
        return result.stdout.strip()

    def value(query):
        return json.loads(run(query))

    def scene(swap=False):
        run('SELECT fixture_diamond_scene(' + ('true' if swap else 'false') + ')')

    def state():
        return value("SELECT jsonb_build_object('custody',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) "
                     "FROM poker_diamond_custody c),'seats',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) "
                     "FROM table_seats s),'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY move_id) "
                     "FROM cash_seat_move_receipts r),'wallets',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) "
                     "FROM profiles p))")

    try:
        share = Path(subprocess.check_output([str(PG_BIN / 'pg_config'), '--sharedir'], text=True).strip())
        if not (share / 'postgres.bki').exists():
            share = PG_BIN.parent / 'share/postgresql'
        subprocess.run([str(PG_BIN / 'initdb'), '-L', str(share), '-D', str(cluster / 'data'),
                        '-U', 'postgres', '-A', 'trust', '--no-locale', '-E', 'UTF8'],
                       check=True, stdout=subprocess.DEVNULL)
        subprocess.run([str(PG_BIN / 'pg_ctl'), '-D', str(cluster / 'data'),
                        '-l', str(cluster / 'postgres.log'), '-o',
                        f"-c listen_addresses='' -k {socket} -p {PORT}", '-w', 'start'],
                       check=True, stdout=subprocess.DEVNULL)
        running = True
        run(file=FIXTURE / 'native-bootstrap.sql')
        capture = json.loads((FIXTURE / 'native-capture.json').read_text())
        for function in capture['functions']:
            actual = run("SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace "
                         "AND proname='" + function['name'] + "'")
            assert actual == function['body_md5'], function['name']
        run(file=FIXTURE / 'native-scene.sql')
        scene()
        run(f"UPDATE profiles SET diamonds=0 WHERE id='{V}'")
        assert value(f"SET test.uid='{V}'; SELECT fn_cash_game_join('{G}')")['action'] == 'seat'
        assert run('SELECT count(*) FROM table_waitlist') == '1', 'original defect not reproduced'
        scene()
        audit = f"SET test.uid='{U}'; SELECT fn_poker_diamond_staff_audit('diamond.table_edit','diamond_table','{T}',NULL,'{{}}'::jsonb)"
        run(audit)
        assert run('SELECT bool_or(fn_poker_diamond_plain_cash_table(t)) FROM tables t') == 'f'
        before = state()
        run(f"BEGIN; SELECT fn_cash_seat_move_execute('{M}'); COMMIT;",
            error='diamond_seat_and_custody_must_commit_together')
        assert state() == before, 'old refused transfer committed a financial effect'
        migration = sorted((ROOT / 'supabase/migrations').glob('*diamond_must_move_keeps_its_custody_and_its_table_rules.sql'))
        assert len(migration) == 1, 'one owning compatible migration is required'
        run(file=migration[0])
        # A pause retains live tables so existing hands/top-ups can settle,
        # but neither the game door nor a physical new buy-in may fund a seat.
        scene()
        run("UPDATE cash_games SET cluster_mode='paused'")
        before = state()
        run(f"SET test.uid='{V}'; SELECT fn_cash_game_join('{G}')", error='GAME_CLOSED')
        assert run('SELECT count(*) FROM table_waitlist') == '0'
        assert value(f"SET test.uid='{U}'; SELECT fn_cash_game_join('{G}')")['action'] == 'seated'
        arena = run(f"SELECT club_id FROM tables WHERE id='{T}'")
        physical = f"SELECT fn_poker_diamond_buyin('{V}','{T}',2,20,false,'{arena}','99999999-9999-4999-8999-999999999999')"
        run(physical, error='GAME_CLOSED')
        assert state() == before, 'paused new-entry refusal changed money or seats'
        run("UPDATE cash_games SET cluster_mode='must_move',enabled=false")
        run(physical, error='GAME_CLOSED')
        assert state() == before
        run("UPDATE cash_games SET enabled=true; UPDATE tables SET lifecycle='breaking'")
        run(physical, error='TABLE_CLOSING')
        assert state() == before
        # Control-flow witness only: the real funding core has separate native
        # qualification. Stop the admitted unpaused call at its first reserve,
        # and prove the new-entry gate leaves that existing path reachable.
        run("CREATE TABLE blacklists(user_id uuid,club_id uuid,expires_at timestamptz)")
        run("CREATE FUNCTION fn_poker_diamond_reserve(uuid,text,uuid,text,numeric,uuid) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ENTRY_REACHED_RESERVATION'; END $$")
        run("UPDATE tables SET lifecycle='live'")
        run(physical, error='ENTRY_REACHED_RESERVATION')
        assert state() == before
        # A pause already owning the game lock must win before the admission
        # can reach its funding call. Observe the isolated holder, then enter;
        # no guessed scheduling delay or production fault is involved.
        holder = subprocess.Popen(psql + ['-c',
          f"BEGIN; UPDATE cash_games SET cluster_mode='paused' WHERE id='{G}'; SELECT pg_sleep(1); COMMIT;"],
          text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            for _ in range(100):
                if run("SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE 'BEGIN; UPDATE cash_games SET cluster_mode=%'") == '1':
                    break
                time.sleep(0.01)
            else:
                raise AssertionError('isolated pause never owned its game lock')
            run(physical, error='GAME_CLOSED')
            assert state() == before, 'concurrent pause refusal changed money or seats'
        finally:
            stdout, stderr = holder.communicate(timeout=5)
            assert holder.returncode == 0, stderr
        scene()

        run(f"UPDATE profiles SET diamonds=0 WHERE id='{V}'")
        run(f"SET test.uid='{V}'; SELECT fn_cash_game_join('{G}')",error='INSUFFICIENT_SETTLED_DIAMONDS:20')
        assert run('SELECT count(*) FROM table_waitlist') == '0'
        run(f"UPDATE profiles SET diamonds=1000 WHERE id='{V}'")
        run(f"SET test.uid='{V}'; SET test.session='false'; SELECT fn_cash_game_join('{G}')",error='SESSION_REVOKED')
        assert run('SELECT count(*) FROM table_waitlist') == '0'
        run(audit)
        assert run('SELECT count(*) FROM admin_audit_log') == '2'
        run(audit.replace('diamond.table_edit','diamondEvil.table_edit'),
            error='diamond_staff_audit_requires_an_action_a_target_and_a_state')
        assert run('SELECT bool_and(fn_poker_diamond_plain_cash_table(t)) FROM tables t') == 't'
        for swap in (False, True):
            scene(swap)
            before = state()
            result = value(f"SELECT fn_cash_seat_move_execute('{M}')")
            assert result['ok'] is True
            after = state()
            assert before['wallets'] == after['wallets'], 'transfer changed a wallet'
            old = {c['id']: c for c in before['custody']}
            for custody in after['custody']:
                original = old[custody['id']]
                for field in ('id','balance','entry_key','created_at','user_id','arena_id','purpose'):
                    assert custody[field] == original[field], field
                assert custody['occupancy_id'] != original['occupancy_id']
            assert run("SELECT count(*) FROM poker_diamond_custody c JOIN table_seats s ON s.id=c.seat_id "
                       "WHERE c.occupancy_id=s.occupancy_id AND c.target_id=s.table_id "
                       "AND c.balance=s.stack AND s.left_at IS NULL") == ('2' if swap else '1')
            assert value(f"SELECT fn_cash_seat_move_execute('{M}')") == result
            assert state() == after, 'same move request changed a committed receipt'
        scene()
        before = state()
        run("UPDATE tables SET club_id=gen_random_uuid() WHERE id='" + DEST + "'")
        broken = state()
        run(f"SELECT fn_cash_seat_move_execute('{M}')", error='diamond_move_scope_mismatch')
        assert state() == broken, 'cross-arena rejection committed seat/custody/receipt mutation'
        scene()
        run("UPDATE cash_seat_moves SET source_occupancy_id=gen_random_uuid()")
        before = state()
        result = value(f"SELECT fn_cash_seat_move_execute('{M}')")
        assert result['ok'] is False and result['reason'] == 'original_occupancy_gone'
        assert state() == before, 'stale occupancy changed financial state'
        scene()
        before = state()
        run("SET test.engine='false'; SELECT fn_cash_seat_move_execute('" + M + "')",
            error='Engine authority required')
        assert state() == before
        # A malformed custody fails AFTER the seat transition was attempted;
        # the authoritative function raise rolls every earlier write back.
        run("UPDATE poker_diamond_custody SET occupancy_id=gen_random_uuid()")
        before = state()
        run(f"SELECT fn_cash_seat_move_execute('{M}')", error='diamond_move_custody_missing')
        assert state() == before, 'late custody failure leaked an earlier seat write'
        scene()
        fresh = value(f"SELECT to_jsonb(fn_cash_cluster_open_table('{G}','feeder',NULL,'opening',NULL))")
        assert run(f"SELECT fn_poker_diamond_plain_cash_table(t) FROM tables t WHERE id='{fresh}'") == 't'
        assert run(f"SELECT fn_cash_apply_ruleset('{G}')") == '0', 'an unchanged tick rewrote tables'
        run("UPDATE tables SET rake_percent=-1,bbj_percent=100 WHERE id='" + fresh + "'")
        assert run(f"SELECT fn_cash_apply_ruleset('{G}')") == '1'
        assert run(f"SELECT fn_poker_diamond_plain_cash_table(t) FROM tables t WHERE id='{fresh}'") == 't'
        assert run(f"SELECT fn_poker_diamond_wallet_covers('{U}','{T}',1000)") == 't'
        run(f"INSERT INTO diamond_purchase_lots(user_id,purchase_id,issued,created_at) "
            f"VALUES('{U}',gen_random_uuid(),100,now())")
        assert run(f"SELECT fn_poker_diamond_wallet_covers('{U}','{T}',1000)") == 'f'
        assert run(f"SELECT fn_ca_cash_wallet_covers('{U}','{T}',NULL,1000)") == 'f'
        assert run(f"SELECT fn_poker_diamond_wallet_covers('{U}','{T}',900)") == 't'
        run(f"INSERT INTO diamond_debts(user_id,amount,reason) VALUES('{U}',1,'fixture debt')")
        assert run(f"SELECT fn_poker_diamond_wallet_covers('{U}','{T}',1)") == 'f'
        # Staff edits/closes operate on the whole game, preserving the door's
        # real audit writer. They cannot abandon an occupied sibling table.
        scene()
        run(f"SET test.uid='{U}'; SELECT fn_poker_diamond_close_cash_table('{DEST}')",
            error='diamond_game_must_be_empty_to_close')
        run('BEGIN; TRUNCATE poker_diamond_custody,table_seats; UPDATE tables SET status=\'waiting\',current_players=0; COMMIT;')
        # Width alone must reach every empty sibling. Other projection values
        # remain unchanged, so no unrelated edit can mask the shrink predicate.
        run(f"SET test.uid='{U}'; SELECT fn_poker_diamond_edit_cash_table('{T}',NULL,NULL,NULL,NULL,NULL,9)")
        assert run('SELECT bool_and(max_players=9) FROM tables') == 't'
        run(f"SET test.uid='{U}'; SELECT fn_poker_diamond_edit_cash_table('{T}',NULL,NULL,NULL,NULL,NULL,6)")
        assert run("SELECT bool_and(max_players=6 AND small_blind=1 AND big_blind=2 AND min_buy_in=20 AND max_buy_in=200) FROM tables") == 't', 'width-only shrink left a sibling at the old seat count'
        run(f"SET test.uid='{U}'; SELECT fn_poker_diamond_edit_cash_table('{T}',NULL,2,4,40,400,6)")
        assert run("SELECT bool_and(small_blind=2 AND big_blind=4 AND min_buy_in=40 AND max_buy_in=400) FROM tables") == 't'
        assert run("SELECT count(*) FROM admin_audit_log WHERE action='diamond.table_edit'") == '5'
        run(f"SET test.uid='{U}'; SELECT fn_poker_diamond_close_cash_table('{T}')")
        assert run('SELECT bool_and(NOT enabled) FROM cash_games') == 't'
        assert run("SELECT bool_and(status='closed' AND lifecycle='closed') FROM tables") == 't'
        # A real ladder adoption preserves every seat/custody byte and tableid,
        # grouping equal variant/stakes entries under one existing game key.
        scene(True)
        run('UPDATE tables SET cluster_id=NULL,role=NULL,main_index=NULL,lifecycle=NULL; TRUNCATE cash_games,cash_seat_moves;')
        before = state()
        adoption = sorted((ROOT / 'supabase/migrations').glob('*the_live_diamond_ladder_becomes_must_move_after_engine_activ.sql'))
        assert len(adoption) == 1
        run(file=adoption[0])
        after = state()
        for field in ('custody','wallets','receipts'):
            assert after[field] == before[field], 'adoption changed ' + field
        original_seats = {s['id']: s for s in before['seats']}
        for seat in after['seats']:
            original = original_seats[seat['id']]
            assert seat['active_game_scope'].startswith('cluster:')
            assert {k:v for k,v in seat.items() if k!='active_game_scope'} == {
                k:v for k,v in original.items() if k!='active_game_scope'
            }, 'adoption changed a seat beyond its declared game scope'
        assert run('SELECT count(*) FROM cash_games') == '1'
        assert run('SELECT count(DISTINCT cluster_id) FROM tables') == '1'
        assert run('SELECT count(*) FROM cash_game_roster') == '2'
        assert run("SELECT bool_and(s.active_game_scope=t.seat_game_scope AND t.seat_game_scope='cluster:'||t.cluster_id::text) FROM table_seats s JOIN tables t ON t.id=s.table_id WHERE s.left_at IS NULL") == 't'
        # The deployed deferred uniqueness rule rejects a second committed
        # chair for an adopted player in a sibling, in the same transaction.
        before_duplicate = state()
        arena = run(f"SELECT club_id FROM tables WHERE id='{DEST}'")
        run(f"BEGIN; INSERT INTO table_seats(table_id,seat_number,user_id,club_id,stack,joined_at) VALUES('{DEST}',3,'{U}','{arena}',0,clock_timestamp()); COMMIT;", error='one_committed_seat_per_game_player')
        assert state() == before_duplicate, 'duplicate adopted chair committed'

        run(file=adoption[0], error='diamond_must_move_adoption_already_started')
        run(file=migration[0], error='diamond_must_move_source_drift')
        print(PROOF)
    finally:
        if running:
            subprocess.run([str(PG_BIN / 'pg_ctl'), '-D', str(cluster / 'data'),
                            '-m', 'immediate', '-w', 'stop'], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, check=True)
        shutil.rmtree(cluster)


if __name__ == '__main__':
    main()
