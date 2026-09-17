#!/usr/bin/env python3
"""Captured launch/overlay/entry-close functions on an isolated PG17 cluster.

Synthetic input tables; real captured ladder math, launch receipts and durable
wake writer. Explicit guarantee/alert/maintenance stand-ins are not provider,
full production trigger-chain, legal-hand or end-to-end settlement proof.
No remote connection option or production event rows.
"""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time

repo = Path(__file__).resolve().parents[2]
fixture = repo / 'scripts/dev/fixtures/committed-payout-terms'
capture = json.loads((fixture / 'installed.json').read_text())
launch_capture = json.loads((repo / 'scripts/dev/fixtures/played-mtt-launch/installed.json').read_text())
migration = repo / 'supabase/migrations/20260914143521_preserve_committed_tournament_payout_terms_on_recovery.sql'
pg = Path(os.environ.get('POKER_AUDIT_PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
root = Path(tempfile.mkdtemp(prefix='ca-payout-terms-'))
cluster, sock = root / 'db', root / 's'
sock.mkdir()
env = dict(os.environ, PGHOST=str(sock), PGHOSTADDR='', PGPORT=str(35000 + os.getpid() % 10000), PGUSER='postgres', PGDATABASE='postgres')
client = [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1']
event = 'd3000000-0000-4000-8000-000000000001'
generation = 'd6000000-0000-4000-8000-000000000001'
launch = 'd5000000-0000-4000-8000-000000000001'
table = 'd4000000-0000-4000-8000-000000000001'
closed = 'd4000000-0000-4000-8000-000000000002'
club = 'd7000000-0000-4000-8000-000000000001'
first = '2026-09-08T14:01:44.798851+00:00'
ladder = json.dumps([{'place':i+1,'percentage':p} for i,p in enumerate([34.72,25,18,12.96,9.32])])
passed = []
started = False
begin = f"SELECT fn_begin_tournament_launch_atomic('{event}','{launch}','{first}','{generation}');"
complete = f"SELECT fn_complete_tournament_launch_atomic('{event}','{launch}','{generation}');"
close = f"SELECT fn_finalize_tournament_entry_pool_locked('{event}','fixture','levels');"
accept = f"SELECT fn_complete_tournament_entry_reprice('{event}');"

def uid(n):
    return 'd1000000-0000-4000-8000-' + str(n).zfill(12)

with (root / 'results.log').open('w') as log:
    def run(args):
        subprocess.run(args, stdout=log, stderr=log, check=True, timeout=40)

    def q(sql, error=None):
        r = subprocess.run(client, input=sql + '\n', capture_output=True, text=True, env=env, timeout=20)
        log.write(r.stdout + r.stderr)
        log.flush()
        if error:
            assert r.returncode and error in r.stderr, r.stderr
        else:
            assert r.returncode == 0, r.stderr
        return r.stdout.strip()

    def call(sql):
        return json.loads(q(sql))

    def check(name, condition=True):
        assert condition, name
        passed.append(name)
        print('PASS ' + name, flush=True)

    def snapshot():
        return q("SELECT md5(jsonb_build_array(" + ','.join(
            f"(SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM {t} x)" for t in
            ['tournaments','tournament_players','table_seats','tables','hand_history','tournament_obligations','tournament_payouts','clubs','union_wallets','chip_ledger','tournament_entry_close_receipts','tournament_manager_wakes','fixture_provider_calls']) + ")::text);")

    def money():
        return q("SELECT jsonb_build_array((SELECT jsonb_agg(o ORDER BY place) FROM tournament_obligations o),(SELECT jsonb_agg(p ORDER BY position) FROM tournament_payouts p),(SELECT jsonb_agg(l) FROM chip_ledger l),(SELECT jsonb_agg(c) FROM clubs c));")

    def reset(status='REGISTERING', finalized=True, paid=True):
        q("TRUNCATE tournaments,tournament_players,tables,table_seats,hand_history,tournament_launch_receipts,engine_tournament_leases,tournament_entry_close_receipts,tournament_manager_wakes,tournament_place_settlement_batches,tournament_satellite_settlement_batches,tournament_final_table_deal_batches,tournament_terminal_settlements,tournament_cancellation_receipts,tournament_obligations,tournament_payouts,clubs,union_wallets,chip_ledger,fixture_provider_calls;")
        q(f"""INSERT INTO tournaments(id,status,current_level,level_started_at,starting_chips,max_players,current_players,prize_pool,prize_pool_finalized,payout_structure,club_id)
          VALUES('{event}','{status}',21,'2026-09-08T14:53:31.061Z',12000,500,2,153,{str(finalized).lower()},'{ladder}','{club}');
          INSERT INTO clubs(id,chip_treasury) VALUES('{club}',1000);
          INSERT INTO tables VALUES('{table}','{event}','running',2,9,200,400),('{closed}','{event}','closed',0,9,100,200);
          INSERT INTO tournament_players(tournament_id,user_id,status,chips,table_id,seat_number,position) VALUES
          """ + ','.join(f"('{event}','{uid(i)}','{'playing' if i<3 else 'eliminated'}',{22000 if i==1 else 14000 if i==2 else 0},'{table if i<3 else closed}',{i if i<3 else 1},{'NULL' if i<3 else i-1})" for i in range(1,35)) + f""";
          INSERT INTO table_seats(table_id,user_id,seat_number,stack) VALUES('{table}','{uid(1)}',1,22000),('{table}','{uid(2)}',2,14000);
          INSERT INTO hand_history VALUES('{closed}','{event}','{first}'),('{table}','{event}','2026-09-08T14:53:30Z');
          INSERT INTO engine_tournament_leases VALUES('{event}','{generation}',2,clock_timestamp());
          UPDATE tournament_players p SET prize=a.amount FROM fn_ca_tournament_place_amounts('{event}') a WHERE p.tournament_id='{event}' AND p.position=a.place;
        """)
        if paid:
            q("INSERT INTO tournament_obligations(tournament_id,user_id,kind,place,amount_owed,amount_paid) SELECT tournament_id,user_id,'place',position,prize,prize FROM tournament_players WHERE prize>0; INSERT INTO tournament_payouts SELECT tournament_id,user_id,position,'structure',prize,tournament_id::text||':obl:'||user_id::text||':0' FROM tournament_players WHERE prize>0;")

    try:
        assert ' 17.' in subprocess.check_output([str(pg / 'postgres'), '--version'], text=True)
        run([str(pg / 'initdb'), '-D', str(cluster), '-U', 'postgres', '--auth=trust', '--no-locale'])
        run([str(pg / 'pg_ctl'), '-D', str(cluster), '-o', f'-k {sock} -p {env["PGPORT"]} -c listen_addresses=', '-w', 'start'])
        started = True
        q((fixture / 'bootstrap.sql').read_text())
        functions = capture['functions'] + json.loads((fixture / 'native-dependencies.json').read_text()) + json.loads((fixture / 'native-math-v2.json').read_text())
        # SQL wrappers resolve dependencies at CREATE; load their children first.
        functions.sort(key=lambda x: 0 if x['signature'].startswith(('fn_ca_prize_ladder(', 'fn_ca_prize_ladder_v2(', 'fn_safe_jsonb_array(', 'fn_ca_prize_entries(', 'fn_ca_tournament_unit_cents(')) else 1)
        for x in functions:
            assert hashlib.md5(x['definition'].split('$function$')[1].encode()).hexdigest() == x['body_md5'], x['signature']
            q(x['definition'] + ';')
        for x in launch_capture['functions']:
            assert hashlib.md5(x['definition'].split('$function$')[1].encode()).hexdigest() == x['source_md5'], x['proname']
            q(x['definition'] + ';')
        for t in launch_capture['triggers']:
            q(t['function_definition'] + ';' + t['definition'] + ';')
        q(capture['trigger']['definition'] + ';')
        q("REVOKE ALL ON FUNCTION fn_ca_fund_overlay_on_lock(),fn_finalize_tournament_entry_pool_locked(uuid,text,text) FROM PUBLIC,anon,authenticated,service_role; GRANT EXECUTE ON FUNCTION fn_ca_fund_overlay_on_lock() TO service_role;")
        check('every captured source body matches its recorded digest')
        reset()
        before = money()
        assert call(begin)['ok'] and call(complete)['ok']
        check('original real launch trigger reproduces paid five-to-four-place ladder rewrite', q('SELECT jsonb_array_length(payout_structure::jsonb) FROM tournaments;') == '4' and money() == before)
        reset('RUNNING')
        assert call(close)['ok']
        check('original entry close independently rewrites a finalized paid ladder', q('SELECT jsonb_array_length(payout_structure_snapshot) FROM tournament_entry_close_receipts;') == '4')
        check('real close acceptance refuses original repricing mismatch', call(accept).get('reason') == 'reprice_incomplete')
        q(migration.read_text())
        q(migration.read_text())
        reset()
        before = money()
        assert call(begin)['ok'] and call(complete)['ok']
        check('fixed real launch preserves exact played payout terms and existing paid evidence', q('SELECT payout_structure FROM tournaments;') == ladder and money() == before)
        launch_stamp = q('SELECT completed_at FROM tournament_launch_receipts;')
        check('lost launch reply replays same receipt and payout terms', call(complete)['replay'] and q('SELECT completed_at FROM tournament_launch_receipts;') == launch_stamp and money() == before)
        result = call(close)
        check('entry close snapshots five paid places without funding again', result['payout_structure'] == json.loads(ladder) and result['reprice_pending'] and q("SELECT count(*) FROM fixture_provider_calls WHERE kind='guarantee';") == '0')
        check('real amount and acceptance authorities accept preserved old prizes', call(accept)['ok'] and money() == before)
        state = snapshot()
        check('completed entry and acceptance replays change no event or financial row', call(close)['already_finalized'] and call(accept)['already_completed'] and snapshot() == state)
        reset('RUNNING', True, False)
        check('finalized terms are immutable before the first payment too', call(close)['payout_structure'] == json.loads(ladder))
        reset('RUNNING', False, False)
        fresh = call(close)
        check('fresh uncommitted entry close still generates final-field terms', len(fresh['payout_structure']) == 4 and q("SELECT count(*) FROM fixture_provider_calls WHERE kind='guarantee';") == '1')
        q('UPDATE tournament_manager_wakes SET consumed_at=clock_timestamp();')
        receipt = q('SELECT payout_structure_snapshot FROM tournament_entry_close_receipts;')
        check('pending legacy receipt replay retains snapshot and re-emits only consumed wake', call(close)['already_finalized'] and q('SELECT payout_structure_snapshot FROM tournament_entry_close_receipts;') == receipt and q('SELECT count(*) FROM tournament_manager_wakes WHERE consumed_at IS NULL;') == '1')
        wakes = q('SELECT count(*) FROM tournament_manager_wakes;')
        call(close)
        check('unconsumed wake is not duplicated on replay', q('SELECT count(*) FROM tournament_manager_wakes;') == wakes)
        for finalized in [False, True]:
            for variant, kind in [('spin','MTT'),('SPIN','MTT'),('freezeout','SPIN')]:
                reset('RUNNING', finalized, False)
                q(f"UPDATE tournaments SET variant='{variant}',tournament_type='{kind}';")
                check(f'entry close preserves Spin alias {variant}/{kind} finalized={finalized}', call(close)['payout_structure'] == json.loads(ladder))
        reset('REGISTERING', False, False)
        q('UPDATE tournaments SET guaranteed_prize=200;')
        q("UPDATE tournaments SET status='RUNNING';")
        check('fresh start retains field fitting and exact overlay debit', q('SELECT jsonb_array_length(payout_structure::jsonb)=4 AND prize_pool=200 FROM tournaments;') == 't' and q('SELECT chip_treasury=953 FROM clubs;') == 't' and q('SELECT count(*)=1 AND sum(amount)=47 FROM chip_ledger;') == 't')
        financial = money()
        q("UPDATE tournaments SET status='RUNNING';")
        check('same-status replay never refits or funds again', money() == financial)
        for variant, kind in [('spin','MTT'),('SPIN','MTT'),('freezeout','SPIN')]:
            reset('REGISTERING', False, False)
            q(f"UPDATE tournaments SET variant='{variant}',tournament_type='{kind}'; UPDATE tournaments SET status='RUNNING';")
            check(f'launch trigger preserves Spin alias {variant}/{kind}', q('SELECT payout_structure FROM tournaments;') == ladder)
        for status in ['REGISTERING','RUNNING']:
            reset(status, False, True)
            before = snapshot()
            q("UPDATE tournaments SET status='RUNNING';" if status == 'REGISTERING' else close, 'Committed tournament payout terms have no finalized pool')
            check('paid terms without finalized marker refuse before mutation ' + status, snapshot() == before)
        for bad in ['', 'not json', '{}', '[]']:
            reset('RUNNING')
            q("UPDATE tournaments SET payout_structure='" + bad + "';")
            before = snapshot()
            q(close, 'Committed payout structure is unreadable')
            check('malformed committed ladder is never silently regenerated: ' + repr(bad), snapshot() == before)
        for relation in ['tournament_place_settlement_batches','tournament_satellite_settlement_batches','tournament_final_table_deal_batches','tournament_terminal_settlements','tournament_cancellation_receipts']:
            reset('RUNNING', False, False)
            q(f"INSERT INTO {relation} VALUES('{event}');")
            before = snapshot()
            q(close, 'Committed tournament payout terms have no finalized pool')
            check('prepared contract is not repriced: ' + relation, snapshot() == before)
        for kind in ['place','bubble_protection','final_table_deal','late_reg_adjustment']:
            reset('RUNNING', False, False)
            q(f"INSERT INTO tournament_obligations(tournament_id,kind,amount_paid) VALUES('{event}','{kind}',0);")
            q(close, 'Committed tournament payout terms have no finalized pool')
            check('unpaid prepared obligation locks terms: ' + kind)
        reset('RUNNING', False, False)
        q(f"INSERT INTO tournament_payouts(tournament_id,source,amount) VALUES('{event}','bubble_protection',5);")
        q(close, 'Committed tournament payout terms have no finalized pool')
        check('paid bubble evidence also locks terms')
        reset('RUNNING', False, False)
        q(f"INSERT INTO tournament_obligations(tournament_id,kind) VALUES('{event}','bounty');")
        check('bounty-only obligation does not close ordinary late registration', len(call(close)['payout_structure']) == 4)
        reset('RUNNING', False, False)
        q("CREATE FUNCTION fixture_receipt_fail() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture receipt failure';END$$; CREATE TRIGGER fixture_receipt_fail BEFORE INSERT ON tournament_entry_close_receipts FOR EACH ROW EXECUTE FUNCTION fixture_receipt_fail();")
        before = snapshot()
        q(close, 'fixture receipt failure')
        check('entry receipt failure rolls back ladder pool provider call and wake', snapshot() == before)
        q('DROP TRIGGER fixture_receipt_fail ON tournament_entry_close_receipts;')
        reset('REGISTERING', False, False)
        q('UPDATE tournaments SET guaranteed_prize=200;')
        q("CREATE FUNCTION fixture_ledger_fail() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture ledger failure';END$$; CREATE TRIGGER fixture_ledger_fail BEFORE INSERT ON chip_ledger FOR EACH ROW EXECUTE FUNCTION fixture_ledger_fail();")
        before = snapshot()
        q("UPDATE tournaments SET status='RUNNING';", 'fixture ledger failure')
        check('original overlay journal failure still rolls back bank status and ladder', snapshot() == before)
        q('DROP TRIGGER fixture_ledger_fail ON chip_ledger;')
        reset('RUNNING')
        # Concurrent retries hold the same parent lock and create one receipt/wake.
        children = [subprocess.Popen(client, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env) for _ in range(4)]
        for child in children:
            child.stdin.write(close + '\n'); child.stdin.close()
        for child in children:
            assert child.wait(timeout=15) == 0, child.stderr.read()
            assert json.loads(child.stdout.read())['ok']
        check('four native sessions produce exactly one closure receipt and pending wake', q('SELECT count(*) FROM tournament_entry_close_receipts;') == '1' and q('SELECT count(*) FROM tournament_manager_wakes;') == '1')
        for finalize in [False, True]:
            reset('REGISTERING', False, False)
            holder = subprocess.Popen(client, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
            waiter = None
            try:
                holder.stdin.write(f"BEGIN; SELECT 1 FROM tournaments WHERE id='{event}' FOR UPDATE; INSERT INTO tournament_obligations(tournament_id,kind,amount_paid) VALUES('{event}','place',0); " + ("UPDATE tournaments SET prize_pool_finalized=true;" if finalize else '') + "SELECT 'held';\n")
                holder.stdin.flush()
                assert holder.stdout.readline().strip() == '1'
                assert holder.stdout.readline().strip() == 'held'
                waiter = subprocess.Popen(client, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=dict(env, PGAPPNAME='r42-waiting-launch'))
                waiter.stdin.write("UPDATE tournaments SET status='RUNNING';\n")
                waiter.stdin.close()
                waiting = False
                for _ in range(30):
                    if q("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='r42-waiting-launch' AND wait_event_type='Lock');") == 't':
                        waiting = True
                        break
                    time.sleep(0.02)
                assert waiting, 'second transaction did not reach the parent row lock'
                holder.stdin.write('COMMIT;\n')
                holder.stdin.close()
                assert holder.wait(timeout=10) == 0, holder.stderr.read()
                code = waiter.wait(timeout=10)
                error = waiter.stderr.read()
                if finalize:
                    check('waited-for finalization is visible to launch and preserves the original ladder', code == 0 and q('SELECT payout_structure FROM tournaments;') == ladder)
                else:
                    check('waited-for prepared evidence without finalization refuses launch', code != 0 and 'Committed tournament payout terms have no finalized pool' in error and q('SELECT status FROM tournaments;') == 'REGISTERING')
            finally:
                for child in [holder, waiter]:
                    if child and child.poll() is None:
                        child.kill()
                        child.wait(timeout=5)
        for role in ['anon','authenticated','service_role']:
            for signature, args in [('fn_tournament_payout_terms_committed_v1', 'NULL'),('fn_finalize_tournament_entry_pool_locked', "NULL,'fixture','levels'")]:
                q(f'SET ROLE {role}; SELECT {signature}({args});', 'permission denied')
                check(f'private {signature} denies direct {role}')
        signatures = ['fn_ca_fund_overlay_on_lock()', 'fn_finalize_tournament_entry_pool_locked(uuid,text,text)', 'fn_tournament_payout_terms_committed_v1(uuid)']
        for signature in signatures:
            original = q(f"SELECT pg_get_functiondef('public.{signature}'::regprocedure);")
            q(original.replace('AS $function$', 'AS $function$\n-- unreviewed drift\n') + ';')
            q(migration.read_text(), 'Payout terms unreviewed source or metadata')
            q(original + ';')
            check('source drift refuses without overwrite: ' + signature)
        q('GRANT EXECUTE ON FUNCTION fn_tournament_payout_terms_committed_v1(uuid) TO service_role;')
        q(migration.read_text(), 'Payout terms unreviewed source or metadata')
        q('REVOKE EXECUTE ON FUNCTION fn_tournament_payout_terms_committed_v1(uuid) FROM service_role;')
        check('unreviewed private execution grant refuses migration')
        q(migration.read_text())
        check('final migration replay preserves exact postimages and grants')
    finally:
        if started:
            subprocess.run([str(pg / 'pg_ctl'), '-D', str(cluster), '-m', 'fast', '-w', 'stop'], stdout=log, stderr=log, check=True, timeout=30)
        shutil.rmtree(cluster, ignore_errors=True)
(root / 'results.json').write_text(json.dumps({'passed':passed,'production_database_used':False,'scope':__doc__}, indent=2) + '\n')
print(f'{len(passed)} groups passed; evidence: {root / "results.json"}')
