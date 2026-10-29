#!/usr/bin/env python3
"""Native socket-only PostgreSQL qualification of the maintained census query.

All tables, identities and accepted actions are synthetic. Database replies and
server logs stay private; this command prints only the finite assertion count.
"""
import argparse, importlib.util, json, os, pathlib, shutil, subprocess, sys, tempfile

SPEC=importlib.util.spec_from_file_location('turn_census',pathlib.Path(__file__).with_name('horse-turn-census-packet.py'))
census=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(census)
START='2026-10-28T01:00:00.000Z';END='2026-10-28T01:00:40.000Z';SHA='a'*40
ACTOR='00000000-0000-4000-8000-000000000001'
HUMAN='90000000-0000-4000-8000-000000000001'
LEASE='30000000-0000-4000-8000-000000000001'
TABLE='20000000-0000-4000-8000-000000000001'
def uid(i):return f'10000000-0000-4000-8000-{i:012x}'
def literal(value):return "'"+json.dumps(value,separators=(',',':')).replace("'","''")+"'::jsonb"

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--pg-bin',required=True);parser.add_argument('--scratch',required=True);args=parser.parse_args()
    scratch=pathlib.Path(args.scratch).resolve();pg=pathlib.Path(args.pg_bin).resolve()
    if not scratch.is_absolute() or not scratch.is_dir():raise RuntimeError('scratch_unavailable')
    # A short socket leaf keeps sockaddr_un below macOS's 104-byte ceiling.
    sock=scratch/'s'
    if len(str(sock/'.s.PGSQL.5432').encode())>=104:raise RuntimeError('socket_path_bound')
    previous=os.umask(0o077);estate=None;started=False;sock_created=False;checks=0
    env={k:v for k,v in os.environ.items() if not k.startswith('PG') and k!='DATABASE_URL'}
    env['TMPDIR']=str(scratch)
    def command(argv,**kwargs):
        run=subprocess.run(argv,capture_output=True,text=True,timeout=30,env=env,**kwargs)
        if run.returncode:raise RuntimeError('native_command_failed')
        return run.stdout
    try:
        sock.mkdir(mode=0o700);sock_created=True
        estate=pathlib.Path(tempfile.mkdtemp(prefix='census-',dir=scratch));data=estate/'data';log=estate/'postgres.log'
        command([str(pg/'initdb'),'-D',str(data),'-U','census','-A','trust','--no-locale','-E','UTF8'])
        with (data/'postgresql.conf').open('a') as f:
            f.write("\nlisten_addresses = ''\nunix_socket_directories = '"+str(sock).replace("'","''")+"'\nport = 5432\n")
        command([str(pg/'pg_ctl'),'-D',str(data),'-l',str(log),'-w','start']);started=True
        def sql(statement):
            return command([str(pg/'psql'),'-X','-q','-A','-t','-h',str(sock),'-p','5432','-U','census','-d','postgres','-v','ON_ERROR_STOP=1'],input=statement)
        sql('''CREATE SCHEMA smarter_private;
CREATE TABLE public.ca_horse_fleet_register(horse_id uuid PRIMARY KEY,retired_at timestamptz);
INSERT INTO public.ca_horse_fleet_register SELECT ('00000000-0000-4000-8000-'||lpad(to_hex(n),12,'0'))::uuid,NULL FROM generate_series(0,999)n;
CREATE TABLE public.hand_history(id uuid PRIMARY KEY,table_id uuid,hand_number bigint,created_at timestamptz,actions jsonb);
CREATE INDEX idx_hand_history_created ON public.hand_history USING btree(created_at DESC);
CREATE TABLE public.lightning_hand(hand_id uuid PRIMARY KEY,hand_history_id uuid,settled_at timestamptz,host_table_id uuid,hand_number bigint);
CREATE INDEX idx_lightning_hand_hand_history_id ON public.lightning_hand USING btree(hand_history_id);
CREATE TABLE public.hand_atomic_commits(hand_id uuid,table_id uuid,hand_number bigint,post_commit_completed_at timestamptz,post_commit_payload jsonb);
CREATE TABLE smarter_private.hand_submissions(submission_id uuid PRIMARY KEY,table_id uuid,hand_number bigint,lease_generation uuid,request jsonb);
''')
        base={'userId':ACTOR,'stage':'preflop','action':'check','amount':0,'seat':1,'timestamp':1793149199000}
        actions=[{**base,'action':kind,'origin':'forced','amount':1} for kind in ('sb','bb')]+[{**base,'userId':HUMAN,'origin':'player'}]+[{**base,'origin':origin} for origin in sorted(census.ORIGINS)]+[{**base,'action':'return','historyEvent':'uncalled_bet_returned','amount':1}]
        lightning=[{**base,'stage':'flop','origin':'horse_policy','action':'bet','amount':1.0}]
        facts={'accepted_hand_facts':{'horse_journal_identity':{'version':1,'lease_generation':LEASE}}}
        sql(f"""INSERT INTO hand_history VALUES
('{uid(1)}','{TABLE}',1000001,'2026-10-28T01:00:01Z',{literal(actions)}),
('{uid(2)}','{TABLE}',1000002,'2026-10-28T01:00:02Z','[]'),
('{uid(3)}','{TABLE}',1000003,'2026-10-28T01:00:03Z',{literal(lightning)});
INSERT INTO hand_atomic_commits SELECT id,table_id,hand_number,created_at,{literal(facts)} FROM hand_history;
INSERT INTO smarter_private.hand_submissions SELECT id,table_id,hand_number,'{LEASE}',jsonb_build_object('p_hand_row',jsonb_build_object('actions',actions)) FROM hand_history WHERE hand_number<>1000003;
INSERT INTO lightning_hand VALUES('40000000-0000-4000-8000-000000000001','{uid(3)}','2026-10-28T01:00:03Z','{TABLE}',1000003);
""")
        def observe():return census.packet_from_rows(json.loads(sql(census.query(START,END))),SHA,START,END)
        packet,attestation=observe()
        assert attestation['sourceOwnerCounts']=={'classic':2,'lightning':1};checks+=1
        assert attestation['handDomains'][0]['nonDecisionDiagnostics']=={'forcedPosts':2,'uncalledReturns':1,'unknownNonDecision':0};checks+=1
        assert attestation['expectedActions']==7 and len(packet['hands'])==3;checks+=1
        classic=packet['hands'][0]['actions']
        assert [a['actionOrdinal'] for a in classic]==list(range(3,9));checks+=1
        assert {a['origin'] for a in classic}==census.ORIGINS;checks+=1
        assert all(a['timestamp']<packet['hands'][0]['committedAtMs'] for a in classic);checks+=1
        assert packet['hands'][1]['actions']==[];checks+=1
        assert packet['hands'][2]['actions'][0]['actionOrdinal']==0;checks+=1
        assert not any('actorId' in a or 'userId' in a for h in packet['hands'] for a in h['actions']);checks+=1
        def refused(mutation,restore):
            nonlocal checks
            sql(mutation)
            try:
                try:observe()
                except ValueError:checks+=1
                else:raise AssertionError('expected_refusal')
            finally:sql(restore)
        refused(f"UPDATE smarter_private.hand_submissions SET submission_id='{uid(99)}' WHERE submission_id='{uid(1)}';",f"UPDATE smarter_private.hand_submissions SET submission_id='{uid(1)}' WHERE submission_id='{uid(99)}';")
        refused(f"UPDATE smarter_private.hand_submissions SET request='{{}}' WHERE submission_id='{uid(1)}';",f"UPDATE smarter_private.hand_submissions SET request=jsonb_build_object('p_hand_row',jsonb_build_object('actions',{literal(actions)})) WHERE submission_id='{uid(1)}';")
        changed=[{**a,'amount':99} for a in actions]
        refused(f"UPDATE smarter_private.hand_submissions SET request=jsonb_build_object('p_hand_row',jsonb_build_object('actions',{literal(changed)})) WHERE submission_id='{uid(1)}';",f"UPDATE smarter_private.hand_submissions SET request=jsonb_build_object('p_hand_row',jsonb_build_object('actions',{literal(actions)})) WHERE submission_id='{uid(1)}';")
        refused(f"UPDATE hand_atomic_commits SET post_commit_completed_at=NULL WHERE hand_id='{uid(1)}';",f"UPDATE hand_atomic_commits SET post_commit_completed_at='2026-10-28T01:00:01Z' WHERE hand_id='{uid(1)}';")
        refused(f"UPDATE hand_atomic_commits SET post_commit_payload='{{}}' WHERE hand_id='{uid(3)}';",f"UPDATE hand_atomic_commits SET post_commit_payload={literal(facts)} WHERE hand_id='{uid(3)}';")
        malformed={'accepted_hand_facts':{'horse_journal_identity':{'version':1,'lease_generation':'not-a-uuid'}}}
        refused(f"UPDATE hand_atomic_commits SET post_commit_payload={literal(malformed)} WHERE hand_id='{uid(3)}';",f"UPDATE hand_atomic_commits SET post_commit_payload={literal(facts)} WHERE hand_id='{uid(3)}';")
        refused("UPDATE lightning_hand SET settled_at=NULL;","UPDATE lightning_hand SET settled_at='2026-10-28T01:00:03Z';")
        refused("UPDATE lightning_hand SET hand_number=999;","UPDATE lightning_hand SET hand_number=1000003;")
        refused("UPDATE lightning_hand SET host_table_id='ffffffff-ffff-4fff-8fff-ffffffffffff';",f"UPDATE lightning_hand SET host_table_id='{TABLE}';")
        for unexpected in ({**base,'action':'sb','origin':'horse_policy'},{**base,'action':'bb','origin':'horse_fallback'},{**base,'action':'unrecognized','origin':'forced'}):
            bad=actions+[unexpected]
            def replace_original(value):
                return f"UPDATE hand_history SET actions={literal(value)} WHERE id='{uid(1)}'; UPDATE smarter_private.hand_submissions SET request=jsonb_build_object('p_hand_row',jsonb_build_object('actions',{literal(value)})) WHERE submission_id='{uid(1)}';"
            refused(replace_original(bad),replace_original(actions))
        assert observe()[1]['expectedActions']==7;checks+=1
        print(json.dumps({'status':'passed','nativePostgresCensusAssertions':checks,'productionQueries':0}));return 0
    finally:
        if estate is not None and (started or (estate/'data'/'postmaster.pid').exists()):
            command([str(pg/'pg_ctl'),'-D',str(estate/'data'),'-m','immediate','-w','stop'])
        if estate is not None:shutil.rmtree(estate)
        if sock_created and sock.exists():sock.rmdir()
        os.umask(previous)

if __name__=='__main__':
    try:sys.exit(main())
    except Exception:
        print(json.dumps({'status':'failed','reason':'native_census_regression_failed'}));sys.exit(1)
