#!/usr/bin/env python3
"""Exercise current mystery seed/reserve/reveal in an isolated local PG17 cluster."""
from pathlib import Path
import json, os, select, shutil, subprocess, tempfile, time

repo = Path(__file__).resolve().parents[2]
fixture = repo / 'scripts/dev/fixtures/mystery-reservation'
pg = Path(os.environ.get('POKER_AUDIT_PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
root = Path(tempfile.mkdtemp(prefix='ca-mystery-reservation-pg17-'))
cluster, socket = root/'cluster', root/'socket'
socket.mkdir()
port = str(35000 + os.getpid() % 10000)
node = os.environ.get('PGNODE')
query_helper = repo / 'scripts/ci/probes/chip-journal-atomicity/postgres-runtime/registration-query.mjs'

def client_command():
    return [node,str(query_helper)] if node else [str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1']

def connection_env(application_name=None):
    env = dict(os.environ,PGHOST=str(socket),PGHOSTADDR='',PGPORT=port,
               PGDATABASE='postgres',PGUSER='mystery_test')
    if application_name is not None:
        env['PGAPPNAME'] = application_name
    return env

def encode(body):
    return (json.dumps(body) if node else body) + '\n'
passed = []
started = False
base = """
INSERT INTO tournaments VALUES
('10000000-0000-4000-8000-000000000001',true,true,10,0,'pending',50,50,NULL,NULL,NULL);
INSERT INTO tournament_bounty_obligations(
 id,tournament_id,eliminated_user_id,table_id,hand_id,hand_number,
 settlement_completed_at,seat_joined_at,position,prize,mode,
 activation_generation,head_amount,knocker_user_id,claimants)
SELECT ('20000000-0000-4000-8000-00000000000'||n)::uuid,
 '10000000-0000-4000-8000-000000000001',
 ('30000000-0000-4000-8000-00000000000'||n)::uuid,
 '40000000-0000-4000-8000-000000000001',
 ('50000000-0000-4000-8000-00000000000'||n)::uuid,1000000+n,
 now(),now(),4-n,0,'mystery_chest',1,5,
 '60000000-0000-4000-8000-000000000001',
 '[{"user_id":"60000000-0000-4000-8000-000000000001","weight":1},{"user_id":"60000000-0000-4000-8000-000000000002","weight":1}]'
FROM generate_series(1,2) n;
"""
inventory = """'[{"seq":1,"tier":"base","amount_cents":301},{"seq":2,"tier":"base","amount_cents":199}]'::jsonb"""
seed = f"SELECT fn_mystery_bounty_seed('10000000-0000-4000-8000-000000000001',3,{inventory});"
def reserve(n=1):
    return f"""fn_mystery_bounty_reserve(
'10000000-0000-4000-8000-000000000001',
'30000000-0000-4000-8000-00000000000{n}',
'[{{"user_id":"60000000-0000-4000-8000-000000000009","weight":999}}]',
'40000000-0000-4000-8000-000000000001',
'50000000-0000-4000-8000-00000000000{n}',
gen_random_uuid(),20000)"""

with (root/'results.log').open('w') as log:
    def cmd(command):
        r = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)
        log.write(r.stdout); log.flush()
        if r.returncode: raise AssertionError('Command failed: '+str(root/'results.log'))
        return r.stdout.strip()
    def sql(body):
        r = subprocess.run(client_command(),input=encode(body),capture_output=True,
                           text=True,timeout=30,env=connection_env())
        log.write(r.stdout+r.stderr); log.flush()
        if r.returncode: raise AssertionError('SQL failed: '+str(root/'results.log'))
        return r.stdout.strip()
    def check(name, body, seeded=True):
        sql('BEGIN;'+base+(seed if seeded else '')+body+'; SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;')
        passed.append(name); print('PASS '+name,flush=True)
    def assertion(condition,message):
        return "DO $check$ BEGIN IF NOT ("+condition+") THEN RAISE EXCEPTION '"+message+"'; END IF; END $check$;"
    try:
        assert ' 17.' in cmd([str(pg/'postgres'),'--version'])
        cmd([str(pg/'initdb'),'-D',str(cluster),'-U','mystery_test','--auth=trust','--no-locale'])
        started=True
        cmd([str(pg/'pg_ctl'),'-D',str(cluster),'-l',str(root/'postgres.log'),'-o',f'-k {socket} -p {port} -c listen_addresses=', '-w','start'])
        sql((fixture/'fixture.sql').read_text())
        sql("""CREATE FUNCTION test_state() RETURNS jsonb LANGUAGE sql AS $s$
        SELECT jsonb_build_array(
         (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tournaments t),
         (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tournament_bounty_chests t),
         (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tournament_bounty_awards t),
         (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tournament_bounty_award_recipients t),
         (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tournament_bounty_obligations t))
        $s$;""")
        check('funded inventory creates N minus one chests summing to reserved pool',
            assertion("(SELECT count(*)=2 AND sum(amount_cents)=500 FROM tournament_bounty_chests) AND (SELECT mystery_bounty_pool_cents=500 AND mystery_bounty_stage='active' FROM tournaments)",'inventory mismatch'))
        check('entry-open seed refuses without inventory',
            "UPDATE tournaments SET prize_pool_finalized=false;"+
            assertion(f"(fn_mystery_bounty_seed('10000000-0000-4000-8000-000000000001',3,{inventory})->>'reason')='entry_still_open' AND NOT EXISTS(SELECT 1 FROM tournament_bounty_chests)",'opened before cutoff'),False)
        check('unfunded inventory refuses',
            assertion(f"(fn_mystery_bounty_seed('10000000-0000-4000-8000-000000000001',3,replace({inventory}::text,'301','302')::jsonb)->>'reason')='inventory_mismatch' AND NOT EXISTS(SELECT 1 FROM tournament_bounty_chests)",'unfunded inventory'),False)
        check('duplicate sequence cannot partially seed',
            f"""DO $check$ DECLARE before_state jsonb:=test_state(); refused boolean:=false; BEGIN
            BEGIN PERFORM fn_mystery_bounty_seed('10000000-0000-4000-8000-000000000001',3,replace({inventory}::text,'"seq": 2','"seq": 1')::jsonb);
            EXCEPTION WHEN OTHERS THEN refused:=true; END;
            IF NOT refused OR test_state() IS DISTINCT FROM before_state THEN RAISE EXCEPTION 'partial duplicate seed'; END IF; END $check$;""",False)
        check('seed replay cannot replace the committed draw order',
            f"""DO $check$ DECLARE before_state jsonb:=test_state(); r jsonb; BEGIN
            r:=fn_mystery_bounty_seed('10000000-0000-4000-8000-000000000001',99,'[]');
            IF r->>'already_seeded'<>'true' OR test_state() IS DISTINCT FROM before_state THEN RAISE EXCEPTION 'seed replay mutated inventory'; END IF; END $check$;""")
        check('reserve binds persisted recipients and conserves an odd-cent split',
            f"SELECT {reserve()};"+
            assertion("""(SELECT sum(amount_cents)=301 AND count(*)=2 AND min(amount_cents)=150 AND max(amount_cents)=151 FROM tournament_bounty_award_recipients)
             AND NOT EXISTS(SELECT 1 FROM tournament_bounty_award_recipients WHERE user_id='60000000-0000-4000-8000-000000000009')
             AND (SELECT count(*)=1 FROM tournament_bounty_awards WHERE bounty_obligation_id='20000000-0000-4000-8000-000000000001' AND activation_generation=1)""",'unbound split'))
        check('retry with a different client token returns the same award',
            f"""DO $check$ DECLARE a jsonb; b jsonb; s jsonb; BEGIN
            a:={reserve()}; s:=test_state(); b:={reserve()};
            IF b->>'already'<>'true' OR a->>'award_id'<>b->>'award_id' OR test_state() IS DISTINCT FROM s THEN RAISE EXCEPTION 'reservation rerolled'; END IF; END $check$;""")
        check('wrong hand cannot reserve a chest',
            assertion(f"({reserve().replace('50000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000009')}->>'reason')='bounty_obligation_not_ready' AND NOT EXISTS(SELECT 1 FROM tournament_bounty_awards)",'wrong generation admitted'))
        check('two eliminations consume different funded chests',
            f"SELECT {reserve()}; SELECT {reserve(2)};"+
            assertion("(SELECT count(*)=2 AND count(DISTINCT chest_id)=2 AND sum(amount_cents)=500 FROM tournament_bounty_awards) AND (SELECT sum(amount_cents)=500 FROM tournament_bounty_award_recipients)",'duplicate chest'))
        check('late recipient failure rolls the reservation back completely',
            """CREATE FUNCTION test_fail_recipient() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'injected recipient failure' USING ERRCODE='23514'; END $f$;
            CREATE TRIGGER test_fail BEFORE INSERT ON tournament_bounty_award_recipients FOR EACH ROW EXECUTE FUNCTION test_fail_recipient();"""+
            f"""DO $check$ DECLARE before_state jsonb:=test_state(); refused boolean:=false; BEGIN
            BEGIN PERFORM {reserve()}; EXCEPTION WHEN check_violation THEN refused:=true; END;
            IF NOT refused OR test_state() IS DISTINCT FROM before_state THEN RAISE EXCEPTION 'partial reservation'; END IF; END $check$;""")
        check('browser cannot impersonate the revealer or request engine auto-reveal',
            f"SELECT {reserve()}; SET LOCAL test.role='authenticated'; SET LOCAL test.actor='60000000-0000-4000-8000-000000000009';"+
            assertion("(SELECT fn_mystery_bounty_reveal(id,'60000000-0000-4000-8000-000000000001',true)->>'reason'='not_the_revealer' FROM tournament_bounty_awards) AND (SELECT bool_and(status='reserved') FROM tournament_bounty_awards)",'revealer impersonated'))
        check('authorized reveal and replay return identical fixed awards',
            f"SELECT {reserve()}; SET LOCAL test.role='authenticated'; SET LOCAL test.actor='60000000-0000-4000-8000-000000000001';"+
            """DO $check$ DECLARE a jsonb; b jsonb; s jsonb; id uuid; BEGIN
            SELECT x.id INTO id FROM tournament_bounty_awards x;
            a:=fn_mystery_bounty_reveal(id,NULL,false); s:=test_state(); b:=fn_mystery_bounty_reveal(id,NULL,false);
            IF a->>'ok'<>'true' OR (a->>'amount_cents')::bigint<>301 OR a IS DISTINCT FROM b OR s IS DISTINCT FROM test_state() THEN RAISE EXCEPTION 'reveal replay changed award'; END IF; END $check$;""")
        # Real concurrent sessions. The first reserve holds the tournament row;
        # the second must be observed waiting before the first commits.
        sql(base+seed)
        owner=subprocess.Popen(client_command(),stdin=subprocess.PIPE,stdout=subprocess.PIPE,
            stderr=log,text=True,bufsize=1,env=connection_env('mystery_reserve_owner'))
        rival=None
        try:
            owner.stdin.write(encode('BEGIN; DO $owner$ BEGIN PERFORM '+reserve()+"; END $owner$; SELECT 'OWNED';")); owner.stdin.flush()
            assert select.select([owner.stdout],[],[],10)[0], 'Reservation owner did not become ready'
            assert owner.stdout.readline().strip()=='OWNED', 'Reservation owner exited before ready'
            rival=subprocess.Popen(client_command(),stdin=subprocess.PIPE,stdout=subprocess.PIPE,
                stderr=log,text=True,env=connection_env('mystery_reserve_rival'))
            rival.stdin.write(encode('SELECT '+reserve()+';')); rival.stdin.flush()
            deadline=time.monotonic()+10; blocked=False
            while time.monotonic()<deadline:
                blocked=sql("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='mystery_reserve_rival' AND wait_event_type='Lock');")=='t'
                if blocked: break
                time.sleep(.05)
            assert blocked, 'Competing reserve was not observed blocked'
            owner.stdin.write(encode('COMMIT;')); owner.stdin.close(); owner.wait(timeout=10)
            assert owner.returncode==0, 'Reservation owner failed to commit'
            result, _=rival.communicate(timeout=10)
            assert rival.returncode==0 and json.loads(result)['already'] is True
            assert sql("SELECT count(*)=1 AND sum(amount_cents)=301 FROM tournament_bounty_awards;")=='t'
            assert sql("SELECT count(*)=1 FROM tournament_bounty_chests WHERE status='available';")=='t'
            passed.append('observed overlapping reserve requests commit one award and one replay')
            print('PASS '+passed[-1],flush=True)
        finally:
            for p in [owner,rival]:
                if p is not None and p.poll() is None: p.terminate(); p.wait(timeout=10)
    finally:
        if started:
            subprocess.run([str(pg/'pg_ctl'),'-D',str(cluster),'-m','fast','-w','stop'],stdout=log,stderr=log,check=True,timeout=15)
        shutil.rmtree(cluster,ignore_errors=True)
(root/'results.json').write_text(json.dumps({'passed':passed,'production_database_used':False,'wallet_payer_installed':False},indent=2)+'\n')
print(f'{len(passed)} scenario groups passed; evidence: {root}/results.json')
