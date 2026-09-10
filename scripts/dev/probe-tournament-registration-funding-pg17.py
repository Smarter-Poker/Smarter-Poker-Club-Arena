#!/usr/bin/env python3
"""Rehearse installed pre-start funding and its corrected club-wallet receipt.

Creates its own local PostgreSQL 17 cluster; accepts no database URL.
Use --cross-club --baseline to reproduce the old receipt failure.
Fixture limits are in fixtures/registration-funding/README.md.
"""
from pathlib import Path
import concurrent.futures
import json
import os
import shutil
import sys
import subprocess
import tempfile
import time

repo = Path(__file__).resolve().parents[2]
fixture = repo / 'scripts/dev/fixtures/satellite-refund/fixture.sql'
overlay = repo / 'scripts/dev/fixtures/registration-funding/installed.sql'
migrations = list((repo/'supabase/migrations').glob('*_tournament_entry_receipts_use_the_charged_club_wallet.sql'))
assert len(migrations) == 1, 'Expected one recorded entry-receipt migration'
migration = migrations[0]
configured = os.environ.get('POKER_AUDIT_PG_BIN') or os.environ.get('PGBIN')
pg = Path(configured) if configured else Path(subprocess.check_output(['brew','--prefix','postgresql@17'],text=True).strip())/'bin'
root = Path(tempfile.mkdtemp(prefix='ca-registration-funding-pg17-'))
cluster, sock = root/'cluster', root/'socket'
sock.mkdir()
port = str(35000 + os.getpid() % 10000)
node = os.environ.get('PGNODE')
database = 'postgres'
query_helper = repo / 'scripts/ci/probes/chip-journal-atomicity/postgres-runtime/registration-query.mjs'
passed = []
started = False
event = 'c3000000-0000-4000-8000-000000000001'
club = 'c2000000-0000-4000-8000-000000000001'

def uid(n): return 'c1000000-0000-4000-8000-' + str(n).zfill(12)
def key(n): return 'c8000000-0000-4000-8000-' + str(n).zfill(12)
def call(user, request):
    return "SET test.actor='%s'; SELECT public.fn_register_for_tournament_request('%s','%s');" % (uid(user),event,key(request))

with (root/'results.log').open('w') as log:
    def run(command):
        result = subprocess.run(command,stdout=log,stderr=log,text=True,timeout=40)
        log.flush()
        assert result.returncode == 0, 'Command failed; see '+str(root/'results.log')

    def client_command():
        if node:
            return [node, str(query_helper)]
        return [str(pg/'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1']

    def connection_env():
        return dict(os.environ, PGHOST=str(sock), PGHOSTADDR='', PGPORT=port,
                    PGUSER='registration_test', PGDATABASE=database)

    def encode(sql):
        return (json.dumps(sql) if node else sql) + '\n'

    def q(sql, expected_error=None):
        result = subprocess.run(client_command(),input=encode(sql),capture_output=True,text=True,timeout=15,env=connection_env())
        log.write(result.stdout+result.stderr)
        log.flush()
        if expected_error:
            assert result.returncode != 0 and expected_error in result.stderr, result.stderr
        else:
            assert result.returncode == 0, result.stderr
        return result.stdout.strip()

    def fresh(name, cap=100):
        global database
        database='postgres'
        q('CREATE DATABASE "'+name+'";')
        database=name
        q(fixture.read_text())
        q(overlay.read_text())
        if '--baseline' not in sys.argv:
            q(migration.read_text())
            if name == 'single':
                q(migration.read_text())  # Verify the source pin permits clean replay.
        q("INSERT INTO clubs(id) VALUES ('"+club+"');")
        for n in range(1,5):
            q("INSERT INTO profiles(id,username,display_name) VALUES ('%s','Fixture %s','Fixture %s'); INSERT INTO club_members(club_id,user_id,chip_balance,status,role) VALUES ('%s','%s',500,'active','player');" % (uid(n),n,n,club,uid(n)))
        q("INSERT INTO tournaments(id,club_id,name,buy_in_amount,buy_in_fee,start_time,max_players,status,current_players,prize_pool,bounty_pool,total_rake,variant) VALUES ('%s','%s','Isolated Entry Funding',180,20,now()+interval '1 day',%s,'REGISTERING',0,0,0,0,'mtt');" % (event,club,cap))

    def state():
        return json.loads(q("""SELECT jsonb_build_object(
          'wallets',(SELECT sum(chip_balance) FROM club_members),
          'entries',(SELECT count(*) FROM tournament_players),
          'cached',(SELECT current_players FROM tournaments),
          'pool',(SELECT prize_pool FROM tournaments),
          'fee',(SELECT total_rake FROM tournaments),
          'gross',COALESCE((SELECT gross_in FROM tournament_escrow),0),
          'prize',COALESCE((SELECT prize_balance FROM tournament_escrow),0),
          'fee_escrow',COALESCE((SELECT fee_balance FROM tournament_escrow),0),
          'journal',(SELECT count(*) FROM chip_ledger),
          'wallet_receipts',(SELECT count(*) FROM wallet_transactions),
          'entitlements',(SELECT count(*) FROM tournament_refund_entitlements),
          'operations',(SELECT count(*) FROM entry_purchase_idempotency_receipts)
        );"""))

    def assert_funded(count):
        observed=state()
        expected=dict(wallets=2000-200*count,entries=count,cached=count,
                      pool=180*count,fee=20*count,gross=200*count,
                      prize=180*count,fee_escrow=20*count,
                      journal=count,wallet_receipts=count,entitlements=count,operations=count)
        assert observed==expected,(observed,expected)

    def check(name):
        passed.append(name)
        print('PASS '+name,flush=True)

    def overlap(first, second, closing=False):
        owner=subprocess.Popen(client_command(),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1,env=connection_env())
        try:
            # Execute the real entry route before holding its transaction open.
            # Pre-acquiring a deeper lock would manufacture an impossible outer lock order.
            owner.stdin.write(encode("BEGIN; "+first+" SELECT 'owner-ready';"))
            owner.stdin.flush()
            first_lines=[]
            while True:
                line=owner.stdout.readline().strip()
                if line=='owner-ready': break
                if line: first_lines.append(line)
                assert owner.poll() is None,'owner exited: '+owner.stderr.read()
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                contender=pool.submit(q,"SET application_name='registration-funding-contender'; "+second)
                waiting=False
                for _ in range(40):
                    waiting=q("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='registration-funding-contender' AND wait_event_type='Lock');")=='t'
                    if waiting: break
                    time.sleep(0.025)
                assert waiting,'competing transaction did not overlap the real database lock'
                owner.stdin.write(encode("COMMIT;"))
                owner.stdin.close()
                owner.stdout.read()
                assert owner.wait(timeout=15)==0,owner.stderr.read()
                other=contender.result(timeout=15)
            return (None if closing else json.loads(first_lines[-1])),json.loads(other)
        finally:
            if owner.poll() is None:
                owner.kill()
                owner.wait(timeout=5)

    def cross_club():
        fresh('cross_club')
        other='c2000000-0000-4000-8000-000000000002'
        q("INSERT INTO clubs(id) VALUES ('"+other+"'); INSERT INTO club_members(club_id,user_id,chip_balance,status,role,joined_at) VALUES ('"+other+"','"+uid(1)+"',1000,'active','player','2000-01-01');")
        response=json.loads(q(call(1,1)))
        assert response.get('ok') is True,response
        observed=json.loads(q("SELECT jsonb_build_object('source_balance',(SELECT chip_balance FROM club_members WHERE club_id='"+club+"' AND user_id='"+uid(1)+"'),'other_balance',(SELECT chip_balance FROM club_members WHERE club_id='"+other+"' AND user_id='"+uid(1)+"'),'receipt_balance',(SELECT balance_after FROM wallet_transactions),'ledger_club',(SELECT club_id FROM chip_ledger));"))
        print('CROSS_CLUB_OBSERVED '+json.dumps(observed),flush=True)
        assert observed==dict(source_balance=300,other_balance=1000,receipt_balance=300,ledger_club=club),observed
        check('entry receipt balance belongs to the club wallet actually charged')


    try:
        version=subprocess.check_output([str(pg/'postgres'),'--version'],text=True)
        assert ' 17.' in version,version
        run([str(pg/'initdb'),'-D',str(cluster),'-U','registration_test','--auth=trust','--no-locale'])
        run([str(pg/'pg_ctl'),'-D',str(cluster),'-o',f'-k {sock} -p {port} -c listen_addresses=','-w','start'])
        started=True

        if '--cross-club' in sys.argv:
            cross_club()
        else:
            fresh('single')
            response=json.loads(q(call(1,1)))
            assert response.get('ok') is True,response
            assert_funded(1)
            check('one real registration binds one debit, journal, entitlement, escrow and operation receipt')

            fresh('rollback')
            q("CREATE FUNCTION probe_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected receipt failure'; END $$; CREATE TRIGGER probe_receipt_failure BEFORE UPDATE OF response ON entry_purchase_idempotency_receipts FOR EACH ROW EXECUTE FUNCTION probe_receipt_failure();")
            q(call(1,1),'injected receipt failure')
            assert_funded(0)
            check('late operation receipt failure rolls back every funding and entry write')

            for name, second_key in [('retry',1),('duplicate',2)]:
                fresh(name)
                a,b=overlap(call(1,1),call(1,second_key))
                assert a.get('ok') is True,a
                if second_key==1: assert b==a,(a,b)
                else: assert b.get('reason')=='already_registered',b
                assert_funded(1)
                check('overlapping '+name+' requests fund one entry')

            fresh('last_seat',3)
            for n in [1,2]:
                assert json.loads(q(call(n,n))).get('ok') is True
            a,b=overlap(call(3,3),call(4,4))
            assert a.get('ok') is True and b.get('reason')=='tournament_full',(a,b)
            assert_funded(3)
            check('two real contenders for the last place commit one funded entry')

            fresh('closure')
            a,b=overlap("UPDATE tournaments SET prize_pool_finalized=true WHERE id='"+event+"';",
                        call(1,1),closing=True)
            assert b.get('reason')=='registration_closed',b
            assert_funded(0)
            check('registration waiting behind pool closure rechecks eligibility without charging')

            cross_club()

    finally:
        if started:
            subprocess.run([str(pg/'pg_ctl'),'-D',str(cluster),'-m','fast','-w','stop'],stdout=log,stderr=log,check=True,timeout=15)
        shutil.rmtree(cluster,ignore_errors=True)

(root/'results.json').write_text(json.dumps({'passed':passed,'production_database_used':False},indent=2)+'\n')
print(str(len(passed))+' groups passed; evidence: '+str(root/'results.json'))
