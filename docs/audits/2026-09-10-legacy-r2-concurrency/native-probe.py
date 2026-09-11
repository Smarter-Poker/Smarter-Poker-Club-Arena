#!/usr/bin/env python3
"""Actual legacy R2/direct-claim race outcomes, with an explicit third-session barrier."""
from pathlib import Path
import datetime
import hashlib
import json
import os
import re
import subprocess
import time
from fixture_helpers import sql, setup, state

here = Path(os.environ['LEGACY_R2_HERE'])
candidate = Path(os.environ['LEGACY_R2_SOURCE'])
psql = os.environ['COMMISSION_PSQL']
host = Path(os.environ['PGHOST'])
assert str(host).startswith('/tmp/ca-legacy-r2-native.') and host.name == 'socket'
isolation = json.loads(sql("""SELECT json_build_object(
 'database',current_database(),'data_directory',current_setting('data_directory'),
 'server_address',inet_server_addr(),'server_port',inet_server_port(),
 'version',version(),'backend_pid',pg_backend_pid());"""))
assert isolation['database'] == 'postgres' and isolation['server_address'] is None
assert Path(isolation['data_directory']).resolve() == (host.parent / 'data').resolve()
assert 'PostgreSQL 17.' in isolation['version']
setup()
sql((candidate / 'fixture-view.sql').read_text())
original = json.loads((candidate / 'installed-catalog.json').read_text())['functions']
for row in original:
    assert sql("SELECT md5(prosrc) FROM pg_proc WHERE oid='public.%s'::regprocedure;" % row['signature']) == row['body_md5']
sql("""INSERT INTO unions(id,name,owner_id,slug) VALUES(test_id(901),'Independent R2 Race',test_id(100),'independent-r2-race');
INSERT INTO union_clubs(union_id,club_id,rate_cash) VALUES(test_id(901),test_id(900),.90);""")
checks = []
observations = []
sequence = 4800000

def check(label, ok):
    assert ok, label
    checks.append(label)
    print('PASS ' + label, flush=True)

def money(actor):
    return json.loads(sql("""SELECT json_build_object(
     'bank',(SELECT chip_treasury FROM clubs WHERE id=test_id(900)),
     'wallet',(SELECT chip_balance FROM club_members WHERE club_id=test_id(900) AND user_id=test_id(%d)),
     'receipts',(SELECT count(*) FROM agent_commission_settlements WHERE club_id=test_id(900) AND user_id=test_id(%d)),
     'receipt_amount',coalesce((SELECT sum(amount) FROM agent_commission_settlements WHERE club_id=test_id(900) AND user_id=test_id(%d)),0),
     'journal_amount',coalesce((SELECT sum(amount) FROM chip_ledger WHERE club_id=test_id(900) AND to_entity_id=test_id(%d) AND category='commission'),0));""" % (actor,actor,actor,actor)))

def seed(actor, rows):
    global sequence
    for when, amount in rows:
        sequence += 1
        sql("""INSERT INTO agent_commissions
         (club_id,user_id,amount,commission_rate,source_type,source_id,contributing_user_id,created_at)
         VALUES(test_id(900),test_id(%d),%s,.30,'tournament_rake_settlement',test_id(%d),test_id(201),'%s');""" % (actor,amount,sequence,when))

def r2(start, end):
    return "SELECT fn_settle_round2_club_to_agents(test_id(901),'%s','%s');" % (start,end)

def claim(op):
    return "SELECT fn_agent_claim_commission(test_id(900),test_id(%d),1000);" % op

def spawn(name, statement, actor):
    prefix = """SET application_name='%s'; SET statement_timeout='12s';
      SET deadlock_timeout='1s';
      SELECT set_config('request.jwt.claim.sub',test_id(%d)::text,false);""" % (name,actor)
    return subprocess.Popen([psql,'-X','-qAt','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-c',prefix+statement],
                            text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)

def concurrent(label, first, second, actor, second_actor=100):
    holder = subprocess.Popen([psql,'-X','-qAt','-v','ON_ERROR_STOP=1'],
                              text=True,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    a = b = None
    try:
        holder.stdin.write("""SET application_name='legacy-r2-third-session-barrier';BEGIN;
         SELECT id FROM clubs WHERE id=test_id(900) FOR UPDATE;
         SELECT 'barrier-ready:'||pg_backend_pid();\n""")
        holder.stdin.flush()
        while True:
            line = holder.stdout.readline().strip()
            if line.startswith('barrier-ready:'):
                barrier_pid = int(line.split(':')[1])
                break
            assert holder.poll() is None, holder.stderr.read()
        a = spawn('legacy-r2-first',first,actor)
        # Observe the first owner's actual wait before starting its contender.
        for _ in range(100):
            waited = sql("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='legacy-r2-first' AND wait_event_type='Lock');") == 't'
            if waited: break
            time.sleep(.02)
        assert waited, 'first owner did not wait on the third-session barrier'
        b = spawn('legacy-r2-second',second,second_actor)
        for _ in range(100):
            waits = json.loads(sql("""SELECT coalesce(json_agg(json_build_object(
             'pid',pid,'application_name',application_name,'wait_event_type',wait_event_type,
             'wait_event',wait_event,'blocking_pids',pg_blocking_pids(pid)) ORDER BY application_name),'[]')
             FROM pg_stat_activity WHERE application_name IN ('legacy-r2-first','legacy-r2-second');"""))
            if len(waits)==2 and all(x['wait_event_type']=='Lock' for x in waits): break
            time.sleep(.02)
        assert len(waits)==2 and all(x['wait_event_type']=='Lock' for x in waits),waits
        assert any(barrier_pid in x['blocking_pids'] for x in waits),waits
        holder.stdin.write('COMMIT;\n\\q\n')
        holder.stdin.flush()
        holder.communicate(timeout=5)
        outputs = []
        for child in [a,b]:
            out,err = child.communicate(timeout=15)
            bodies = [json.loads(line) for line in out.splitlines() if line.startswith('{')]
            codes = re.findall(r'ERROR:\s+([0-9A-Z]{5}):',err)
            outputs.append(dict(exit=child.returncode,result=bodies[-1] if bodies else None,
                                sqlstate=codes[0] if codes else None,error=err.strip()))
        return dict(case=label,barrier='third session holds actual club row; two RPC waits observed before release',
                    barrier_pid=barrier_pid,observed_waits=waits,outputs=outputs)
    finally:
        for child in [a,b,holder]:
            if child is not None and child.poll() is None:
                child.kill()
                child.communicate(timeout=5)

def run_r2_case(mode, name, actor, rows, one, two, owed):
    seed(actor,rows)
    before=money(actor)
    observation=concurrent(mode+' '+name,one,two,100)
    after=money(actor)
    observation.update(before=before,after=after,unique_legacy_amount=owed)
    paid=before['bank']-after['bank']
    check(mode+' '+name+' bank debit equals actual wallet credit',paid==after['wallet']-before['wallet'])
    print('OBSERVATION '+json.dumps(observation,sort_keys=True),flush=True)
    (here / 'latest-observations.json').write_text(json.dumps(observations+[observation],indent=2)+'\n')
    if mode=='baseline':
        observation['duplicate_amount']=max(paid-owed,0)
        observation['baseline_outcome']='overpaid' if paid>owed else 'no_overpayment_observed'
        check(mode+' '+name+' returned native outcomes for both contenders',len(observation['outputs'])==2)
    else:
        check(mode+' '+name+' stale writer aborts with 40001',
              sorted(x['exit']==0 for x in observation['outputs'])==[False,True]
              and any(x['sqlstate']=='40001' for x in observation['outputs']))
        for statement in [one,two]:
            sql(statement)
        final=money(actor)
        observation['after_partial_retry']=final
        check(mode+' '+name+' retry pays exactly the remaining historical basis',
              before['bank']-final['bank']==owed and final['wallet']-before['wallet']==owed)
        snapshot=state()
        replies=[json.loads(sql(x)) for x in [one,two]]
        check(mode+' '+name+' exact completed replay changes no public row',
              all(x['amount']==0 for x in replies) and state()==snapshot)
    observations.append(observation)

def run_direct_case(mode,actor,when,start,end,op):
    seed(actor,[(when,13)])
    before=money(actor)
    observation=concurrent(mode+' R2 versus direct claim',r2(start,end),claim(op),100,actor)
    after=money(actor)
    observation.update(before=before,after=after,unique_legacy_amount=13)
    check(mode+' R2/direct-claim conflict commits only one 13-chip payment',
          before['bank']-after['bank']==13 and after['wallet']-before['wallet']==13)
    check(mode+' R2/direct-claim reports its actual deadlock victim',
          any(x['sqlstate']=='40P01' for x in observation['outputs']))
    before_retry=state()
    sql(r2(start,end))
    replay=json.loads(sql(claim(op),actor=actor))
    check(mode+' R2/direct-claim retry causes no additional money or receipt',
          state()==before_retry and (replay.get('replayed') is True or replay.get('nothing_owed') is True))
    observations.append(observation)

run_r2_case('baseline','same window',302,[('2026-03-03',17)],r2('2026-03-02','2026-03-09'),r2('2026-03-02','2026-03-09'),17)
run_r2_case('baseline','overlapping windows',302,[('2026-03-17',5),('2026-03-24',7),('2026-03-31',11)],r2('2026-03-16','2026-03-30'),r2('2026-03-23','2026-04-06'),23)
run_direct_case('baseline',302,'2026-04-14','2026-04-13','2026-04-20',4800500)

sql((candidate/'00-expand.sql').read_text())
subprocess.run([psql,'-X','-v','ON_ERROR_STOP=1','-f',str(candidate/'00-online-index.sql')],check=True)
sql('BEGIN;'+(candidate/'00-preflight.sql').read_text()+
    (candidate/'01-source-exclusion.sql').read_text()+
    (candidate/'02-excluded-owners.sql').read_text()+
    (candidate/'03-excluded-unpaid-rollups.sql').read_text()+'COMMIT;')
for row in json.loads((candidate/'patch-manifest.json').read_text()):
    assert sql("SELECT md5(prosrc) FROM pg_proc WHERE oid='public.%s'::regprocedure;" % row['signature'])==row['after_body_md5']
run_r2_case('candidate','same window',303,[('2026-05-05',17)],r2('2026-05-04','2026-05-11'),r2('2026-05-04','2026-05-11'),17)
run_r2_case('candidate','overlapping windows',303,[('2026-05-19',5),('2026-05-26',7),('2026-06-02',11)],r2('2026-05-18','2026-06-01'),r2('2026-05-25','2026-06-08'),23)
run_direct_case('candidate',303,'2026-06-16','2026-06-15','2026-06-22',4800600)
proof=dict(verified_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),checks=checks,
           isolation=isolation,observations=observations,
           candidate_sha256={name:hashlib.sha256((candidate/name).read_bytes()).hexdigest()
                             for name in ['00-expand.sql','00-online-index.sql','00-preflight.sql',
                                          '01-source-exclusion.sql','02-excluded-owners.sql','03-excluded-unpaid-rollups.sql']},
           original_owner_catalog=original,production_mutations=False,
           limits=['Synthetic principals, historical commission basis rows and pre-trigger opening treasury.',
                   'Third-session club-row barrier deliberately schedules old aggregation before contested locks.',
                   'Actual captured R2/direct-claim owners and financial trigger graph perform every payment.',
                   'R2/direct-claim lock inversion remains a deadlock/retry limitation; this candidate adds no new locks.',
                   'No complete outer cascade, common source finality or production rollout is claimed.'])
(here/'native-proof.json').write_text(json.dumps(proof,indent=2)+'\n')
print(json.dumps({'checks':len(checks),'completed_cases':len(observations)}),flush=True)
