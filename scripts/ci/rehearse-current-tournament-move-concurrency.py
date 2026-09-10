#!/usr/bin/env python3
"""Current native move races on one owned, retained synthetic fixture; no production use."""
import argparse, hashlib, json, os, re, subprocess, time, uuid
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('--socket', type=Path, required=True)
p.add_argument('--port', type=int, required=True)
p.add_argument('--database', choices=['full_stage1'], required=True)
p.add_argument('--psql', required=True)
p.add_argument('--output', type=Path, required=True)
p.add_argument('--resume-fixture', action='store_true')
a=p.parse_args()
assert a.socket.is_absolute() and a.socket.is_dir()
repo=Path(__file__).resolve().parents[2]
cmd=[a.psql,'-X','-q','-h',str(a.socket),'-p',str(a.port),'-U','postgres','-d',a.database,'-v','ON_ERROR_STOP=1','-At']
def run(sql, check=True):
    r=subprocess.run(cmd,input=sql,text=True,capture_output=True)
    if check and r.returncode: raise RuntimeError(r.stderr)
    return r
def read(sql): return run(sql).stdout.strip()
sha=lambda x:hashlib.sha256(x.encode()).hexdigest()
def definition(path,name):
    s=(repo/path).read_text()
    match=re.search(r'CREATE OR REPLACE FUNCTION\s+public\.'+re.escape(name)+r'\s*\(',s)
    assert match,name
    suffix=s[match.start():]
    body=re.search(r'AS (\$[A-Za-z_]*\$)(.*?)\1;',suffix,re.S)
    assert body,name
    return suffix[:body.end()],hashlib.md5(body.group(2).encode()).hexdigest(),sha(s)
move_sig='public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)'
lane_sig='public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)'
move,move_md5,move_source_sha=definition(Path('supabase/migrations/20260910051125_the_seat_move_door_the_engine_calls_exists.sql'),'fn_move_tournament_player')
lane,lane_md5,lane_source_sha=definition(Path('supabase/migrations/20260910035245_the_settlement_lane_is_per_tournament_not_platform_wide.sql'),'fn_ca_lock_settlement_lane_for_tournament')
reader_sig='public.fn_ca_tournament_seat_move_receipt(uuid)'
reader,reader_md5,reader_source_sha=definition(Path('supabase/migrations/20260910051125_the_seat_move_door_the_engine_calls_exists.sql'),'fn_ca_tournament_seat_move_receipt')
assert move_md5=='466c39065b59cf7922a5859df9f26bd3'
assert reader_md5=='68813ee03e355e2eec053e15bf40f98d'
catalog_sql="""SELECT jsonb_build_object(
'functions',(SELECT jsonb_agg(jsonb_build_object('signature',oid::regprocedure::text,'definition',md5(pg_get_functiondef(oid)),'owner',proowner,'acl',proacl) ORDER BY oid::regprocedure::text) FROM pg_proc WHERE pronamespace IN('public'::regnamespace,'smarter_private'::regnamespace) AND prokind='f'),
'triggers',(SELECT jsonb_agg(jsonb_build_object('relation',tgrelid::regclass::text,'name',tgname,'enabled',tgenabled,'definition',pg_get_triggerdef(oid)) ORDER BY tgrelid::regclass::text,tgname) FROM pg_trigger WHERE NOT tgisinternal));"""
connection=json.loads(read("""SELECT jsonb_build_object('database',current_database(),'user',current_user,'local',inet_server_addr() IS NULL,'other_sessions',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()));"""))
assert connection=={'database':'full_stage1','user':'postgres','local':True,'other_sessions':0},connection
assert read("SELECT to_regprocedure('"+move_sig+"') IS NULL AND to_regprocedure('"+lane_sig+"') IS NULL;")=='t'
if a.resume_fixture:
    previous=json.loads(a.output.read_text())
    assert previous['fixtures_retained'] is True and previous['catalog_restored'] is True and previous['cases']==[]
    assert previous['fixture_tournament']=='97010000-0000-0000-0000-000000000001'
    assert read("SELECT count(*) FROM public.tournaments WHERE id::text LIKE '9701%' AND name='Native Current Move Races';")=='1'
    assert read("SELECT count(*) FROM public.tournament_players WHERE tournament_id='97010000-0000-0000-0000-000000000001';")=='2'
    assert read("SELECT count(*) FROM public.tables WHERE tournament_id='97010000-0000-0000-0000-000000000001';")=='3'
else:
    assert read("SELECT count(*) FROM public.tournaments WHERE id::text LIKE '9701%';")=='0'
assert read('SELECT count(*) FROM public.tournament_seat_move_receipts;')=='0'
assert read("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='tournament_seat_move_receipts' AND column_name='source_mode';")=='0'
reader_before=read("SELECT pg_get_functiondef('"+reader_sig+"'::regprocedure);")
reader_before_md5=read("SELECT md5(prosrc) FROM pg_proc WHERE oid='"+reader_sig+"'::regprocedure;")
assert reader_before_md5=='38445b82bd77ebd2990fda8ce993fd24'
events_before=int(read('SELECT count(*) FROM public.tournaments;'))
users=[str(uuid.UUID(hashlib.md5(("current-spin-shared3-user:"+str(i)).encode()).hexdigest())) for i in range(1,3)]
assert read("SELECT count(*) FROM public.profiles WHERE id IN('"+users[0]+"','"+users[1]+"');")=='2'
catalog_before=read(catalog_sql)
tid='97010000-0000-0000-0000-000000000001'
tables=['97020000-0000-0000-0000-00000000000'+str(i) for i in range(1,4)]
generation='97050000-0000-4000-8000-000000000001'
setup_claims="""SET LOCAL request.jwt.claim.role='service_role'; SET LOCAL request.jwt.claims='{"role":"service_role"}'; SET LOCAL app.smarter_data_actor='service';"""
setup=r"""
BEGIN;
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='25s';
@CLAIMS@
INSERT INTO public.tournaments(
id,club_id,name,game_type,variant,tournament_type,buy_in_amount,buy_in_fee,start_time,
status,current_players,max_players,min_players,starting_chips,table_size,prize_pool,
blind_structure,payout_structure,current_level,level_started_at,started_at,
synchronized_breaks,on_break,late_reg_mins,free_buy)
VALUES('@TID@','96000000-0000-0000-0000-000000000001','Native Current Move Races',
'NLH','mtt','MTT',0,0,now(),'RUNNING',0,20,2,1000,9,0,
'[{"level":1,"smallBlind":10,"bigBlind":20,"ante":0,"duration":180}]',
'[{"place":1,"percentage":100}]',1,now(),now(),false,false,60,true);
SELECT public.fn_ca_lock_settlement_lane_for_tournament('@TID@');
INSERT INTO public.tables(id,club_id,tournament_id,name,game_type,game_variant,
max_players,current_players,status,lifecycle,starting_chips,small_blind,big_blind)
SELECT ('97020000-0000-0000-0000-00000000000'||i)::uuid,
'96000000-0000-0000-0000-000000000001','@TID@','Native Move Table '||i,
'tournament','nlh',9,0,'running','live',1000,10,20 FROM generate_series(1,3) i;
WITH wake AS(SELECT public.fn_emit_tournament_manager_wake('@TID@','late_registration') id)
INSERT INTO public.tournament_capacity_table_receipts(table_id,tournament_id,manager_wake_id)
SELECT ('97020000-0000-0000-0000-00000000000'||i)::uuid,'@TID@',wake.id
FROM generate_series(1,3) i CROSS JOIN wake;
INSERT INTO public.tournament_players(id,tournament_id,user_id,username,chips,
status,table_id,seat_number,club_id)
SELECT ('97030000-0000-0000-0000-00000000000'||i)::uuid,'@TID@',
CASE i WHEN 1 THEN '@USER1@'::uuid ELSE '@USER2@'::uuid END,'Native Move Entrant '||i,1000,
'playing',('97020000-0000-0000-0000-00000000000'||i)::uuid,i,
'96000000-0000-0000-0000-000000000001' FROM generate_series(1,2) i;
INSERT INTO public.table_seats(id,table_id,seat_number,user_id,stack,status,
left_at,leave_pending,is_sitting_out,is_away,club_id)
SELECT ('97040000-0000-0000-0000-00000000000'||i)::uuid,
('97020000-0000-0000-0000-00000000000'||i)::uuid,i,
CASE i WHEN 1 THEN '@USER1@'::uuid ELSE '@USER2@'::uuid END,1000,'active',NULL,
false,false,false,'96000000-0000-0000-0000-000000000001' FROM generate_series(1,2) i;
UPDATE public.tables t SET current_players=(SELECT count(*) FROM public.table_seats s
WHERE s.table_id=t.id AND s.left_at IS NULL) WHERE tournament_id='@TID@';
INSERT INTO public.engine_tournament_leases(tournament_id,instance_id,engine_version,
acquired_at,heartbeat_at,lease_generation,protocol_version)
VALUES('@TID@','native-move-races','native-move-races',now(),clock_timestamp(),
'97050000-0000-4000-8000-000000000001',2);
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;
""".replace('@CLAIMS@',setup_claims).replace('@TID@',tid).replace('@USER1@',users[0]).replace('@USER2@',users[1])
headers=json.dumps({'x-smarter-data-actor':'tournament-manager','x-smarter-data-protocol':'2','x-smarter-tournament-id':tid,'x-smarter-tournament-lease-generation':generation})
claims=setup_claims+" SET LOCAL request.method='POST'; SET LOCAL request.path='rpc/fn_move_tournament_player'; SET LOCAL request.headers='"+headers+"'; SELECT smarter_private.fn_smarter_data_api_pre_request();"
state_sql="""SELECT jsonb_build_object(
'players',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM tournament_players p WHERE tournament_id='@TID@'),
'seats',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM table_seats s JOIN tables t ON t.id=s.table_id WHERE t.tournament_id='@TID@'),
'tables',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tables t WHERE tournament_id='@TID@'),
'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY request_id) FROM tournament_seat_move_receipts r WHERE tournament_id='@TID@'),
'clock',(SELECT jsonb_build_object('level',current_level,'anchor',level_started_at,'break',on_break,'break_started',break_started_at,'break_ends',break_ends_at) FROM tournaments WHERE id='@TID@'),
'authority_rows',(SELECT count(*) FROM tournament_seat_exit_authorizations WHERE tournament_id='@TID@'));""".replace('@TID@',tid)
def request(user,src,dst,seat,key):
    return "SELECT public.fn_move_tournament_player('%s','%s','%s','%s',%s,'%s','live_source');"%(tid,user,src,dst,seat,key)
class Session:
    def __init__(self):
        self.proc=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
        self.pid=int(self.query('SELECT pg_backend_pid();')[0])
    def query(self,sql):
        self.proc.stdin.write(sql+'\n\\echo MOVE_DONE\n');self.proc.stdin.flush()
        rows=[]
        while True:
            line=self.proc.stdout.readline()
            if not line: raise RuntimeError(self.proc.stderr.read())
            if line.strip()=='MOVE_DONE': return rows
            if line.strip(): rows.append(line.strip())
    def close(self):
        if self.proc.poll() is None:
            self.proc.stdin.write('\\q\n');self.proc.stdin.flush()
        self.proc.communicate(timeout=10)
report={'production_mutations':False,'scope':'Actual PostgreSQL committed move races on one retained synthetic local fixture',
'function_body_md5':move_md5,'lane_body_md5':lane_md5,'source_sha256':{'move':move_source_sha,'lane':lane_source_sha},
'receipt_reader_body_md5':reader_md5,'receipt_reader_original_body_md5':reader_before_md5,
'fixture_tournament':tid,'fixtures_retained':a.resume_fixture,'cases':[],'catalog_restored':False,
'catalog_scope':'All public/smarter_private function definitions, owners, ACLs; all noninternal trigger definitions/enabled state',
'event_count_before':events_before,'retained_fixture_counts':{'events':1,'tables':3,'entrants':2,'initial_seats':2},
'intentional_retained_schema_extension':{'table':'public.tournament_seat_move_receipts','column':'source_mode','type':'text','not_null':True,'allowed_values':['live_source','closed_orphan'],'source_sha256':move_source_sha},
'limitations':['Synthetic local fixture; no production mutations','Function and trigger catalog restored; fixture rows, immutable real move receipts and source_mode column intentionally retained','Existing native ACLs are preserved; this does not certify production role grants','This proves concurrent movement and clock preservation, not integrated heads-up hands or complete break and restart lifecycle']}
a.output.with_suffix('.catalog-before.json').write_text(catalog_before+'\n')
def checkpoint():
    a.output.write_text(json.dumps(report,indent=2)+'\n')
checkpoint()
installed=False
owner=None
rival=None
try:
    run("BEGIN; SET LOCAL lock_timeout='5s'; ALTER TABLE public.tournament_seat_move_receipts ADD COLUMN source_mode text NOT NULL CHECK (source_mode IN ('live_source','closed_orphan'));\n"+lane+"\n"+reader+"\n"+move+
        "\nREVOKE ALL ON FUNCTION "+lane_sig+" FROM PUBLIC,anon,authenticated,service_role;"+
        "\nREVOKE ALL ON FUNCTION "+move_sig+" FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION "+move_sig+" TO service_role; COMMIT;")
    installed=True
    if not a.resume_fixture: run(setup)
    report['fixtures_retained']=True;checkpoint()
    clock=json.loads(read(state_sql))['clock']
    cases=[
      ('same_entry_different_destination',users[0],tables[0],tables[1],1,users[0],tables[0],tables[2],1,'source roster is not exact'),
      ('competing_entries_one_slot',users[0],tables[1],tables[2],1,users[1],tables[1],tables[2],1,'destination seat is occupied'),
      ('same_request_exact_replay',users[0],tables[2],tables[0],1,users[0],tables[2],tables[0],1,None),
    ]
    for index,(name,u1,s1,d1,n1,u2,s2,d2,n2,refusal) in enumerate(cases,1):
        run("UPDATE engine_tournament_leases SET heartbeat_at=clock_timestamp() WHERE tournament_id='"+tid+"';")
        key='97060000-0000-4000-8000-'+str(index*2-1).zfill(12)
        rival_key=key if refusal is None else '97060000-0000-4000-8000-'+str(index*2).zfill(12)
        owner=Session()
        owner.query("BEGIN; SET LOCAL lock_timeout='8s'; SET LOCAL statement_timeout='15s';"+claims)
        first=json.loads(owner.query(request(u1,s1,d1,n1,key))[0])
        assert first['ok'] is True and first['replayed'] is False,first
        owner.query('SET CONSTRAINTS ALL IMMEDIATE;')
        owner_state=owner.query(state_sql)[0]
        app='codex_current_move_'+name
        env=dict(os.environ,PGAPPNAME=app)
        rival=subprocess.Popen(cmd+['-c',"BEGIN; SET LOCAL lock_timeout='8s'; SET LOCAL statement_timeout='15s';"+claims+request(u2,s2,d2,n2,rival_key)+" SET CONSTRAINTS ALL IMMEDIATE; COMMIT;"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
        blocked=False;deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            blocked=read("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='"+app+"' AND wait_event_type='Lock' AND "+str(owner.pid)+"=ANY(pg_blocking_pids(pid)));")=='t'
            if blocked or rival.poll() is not None: break
            time.sleep(.05)
        assert blocked,(name,'did not observe actual owner lock wait')
        owner.query('COMMIT;');owner.close();owner=None
        out,err=rival.communicate(timeout=16)
        if refusal:
            assert rival.returncode!=0 and refusal in err,(name,rival.returncode,out,err)
        else:
            assert rival.returncode==0,(out,err)
            replay=json.loads([x for x in out.splitlines() if x.strip()][-1])
            assert replay==dict(first,replayed=True),replay
        after=read(state_sql)
        assert after==owner_state,(name,'rival changed committed result')
        state=json.loads(after)
        assert state['clock']==clock and state['authority_rows']==0
        assert len(state['receipts'])==index
        live=[s for s in state['seats'] if s['left_at'] is None]
        assert len(live)==2 and {s['user_id'] for s in live}==set(users)
        assert sum(float(s['stack']) for s in live)==2000
        for entrant in state['players']:
            matches=[s for s in live if s['user_id']==entrant['user_id']]
            assert len(matches)==1
            assert (matches[0]['table_id'],matches[0]['seat_number'],float(matches[0]['stack']))==(entrant['table_id'],entrant['seat_number'],float(entrant['chips']))
        report['cases'].append({'name':name,'actual_lock_wait':True,'owner_committed':True,'rival_exit':rival.returncode,'rival_refusal':refusal,'committed_state_unchanged_by_rival':True,'one_seat_per_entry':True,'chips_conserved':True,'clock_unchanged':True,'state_sha256':sha(after)})
        rival=None;checkpoint()
    report['event_count_after']=int(read('SELECT count(*) FROM public.tournaments;'))
    report['receipt_count_after']=int(read("SELECT count(*) FROM tournament_seat_move_receipts WHERE tournament_id='"+tid+"';"))
    report['passed']=True
finally:
    if owner is not None:
        try: owner.query('ROLLBACK;');owner.close()
        except Exception: pass
    if rival is not None:
        try: rival.communicate(timeout=16)
        except subprocess.TimeoutExpired: rival.terminate();rival.communicate(timeout=5)
    if installed:
        assert read("SELECT md5(prosrc) FROM pg_proc WHERE oid='"+move_sig+"'::regprocedure;")==move_md5
        assert read("SELECT md5(prosrc) FROM pg_proc WHERE oid='"+lane_sig+"'::regprocedure;")==lane_md5
        run("BEGIN; SET LOCAL lock_timeout='5s';\n"+reader_before+";\nDROP FUNCTION "+move_sig+" RESTRICT; DROP FUNCTION "+lane_sig+" RESTRICT; COMMIT;")
        assert read(catalog_sql)==catalog_before,'full function/trigger catalog differs'
        report['catalog_restored']=True
        report['function_trigger_catalog_sha256']=sha(catalog_before)
        report['other_sessions_after']=int(read("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid();"))
        report['authority_rows_after']=int(read('SELECT count(*) FROM tournament_seat_exit_authorizations;'))
    checkpoint()


assert report.get('passed') and report['catalog_restored'] and report['other_sessions_after']==0 and report['authority_rows_after']==0
print('CURRENT_MOVE_CONCURRENCY_PASS',json.dumps(report['cases']),flush=True)
