import subprocess,tempfile,shutil,socket,json,hashlib
from pathlib import Path
p=Path(__file__).resolve().parent;pg=Path(__import__('os').environ.get('PG_BIN',str(Path(shutil.which('psql') or '/opt/homebrew/opt/postgresql@17/bin/psql').parent)));d=Path(tempfile.mkdtemp(prefix='native-',dir=p));started=False
with socket.socket()as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
cmd=[pg/'psql','-XqAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',str(port),'-U','postgres','-d','postgres']
def run(c,sql=None):
 r=subprocess.run(list(map(str,c)),input=sql,text=True,capture_output=True,timeout=120);assert r.returncode==0,r.stderr;return r.stdout.strip()
def q(sql):return run(cmd,sql)
try:
 run([pg/'initdb','-D',d/'db','-U','postgres','-A','trust','--no-locale']);run([pg/'pg_ctl','-D',d/'db','-l',d/'pg.log','-o',f'-h 127.0.0.1 -p {port} -k ""','-w','start']);started=True
 q("""CREATE TABLE union_pnl_inventory_touches(source_name text,row_id uuid,event_id bigint,union_id text,tournament_id text,frame_observed_at timestamptz,observed_at timestamptz);
 CREATE INDEX touch_identity ON union_pnl_inventory_touches(source_name,row_id,event_id)INCLUDE(union_id);
 CREATE TABLE union_pnl_inventory_events(source_name text,row_id uuid,event_id bigint,transaction_id xid8,before_row jsonb,after_row jsonb,observed_at timestamptz);
 CREATE TABLE union_pnl_transaction_frames(transaction_id xid8 PRIMARY KEY,observed_at timestamptz);
 CREATE TABLE tournament_participant_funding_receipts(registration_id uuid,tournament_id uuid,user_id uuid,operation text,asset text,amount numeric,funding_club_id uuid,ledger_id uuid,entitlement_id uuid,registration_snapshot jsonb);
 CREATE TABLE tournament_satellite_awards(tournament_id uuid,user_id uuid,delivery_kind text,registration_id uuid,ticket_id uuid);
 CREATE TABLE tournament_satellite_settlements(tournament_id uuid,target_id uuid);
 CREATE TABLE tournament_tickets(id uuid,holder_id uuid,source_satellite_id uuid,source_tournament_id uuid,status text,redemption_mode text,redeemed_at timestamptz);
 CREATE TABLE chip_ledger(id uuid,status text,from_type text,from_entity_id uuid,to_type text,to_entity_id uuid,tournament_id uuid,amount numeric,club_id uuid,category text,row_hash text);
 INSERT INTO union_pnl_transaction_frames VALUES('1','2026-10-21');
 INSERT INTO union_pnl_inventory_touches SELECT 'tournaments',md5('tournament-'||g)::uuid,g,
 CASE g%3 WHEN 0 THEN md5('union')::uuid::text WHEN 1 THEN md5('foreign')::uuid::text END,NULL,'2026-10-20','2026-10-20'FROM generate_series(0,19)g;
 INSERT INTO union_pnl_inventory_touches SELECT 'clubs',md5('tournament-'||g)::uuid,g,md5('union')::uuid::text,NULL,'2026-10-20','2026-10-20'FROM generate_series(0,19)g;
 INSERT INTO union_pnl_inventory_touches SELECT 'tournaments',md5('tournament-8')::uuid,800,md5('union')::uuid::text,NULL,'2020-01-01','2020-01-01';
 INSERT INTO union_pnl_inventory_events SELECT 'tournaments',md5('tournament-'||g)::uuid,g,'1',jsonb_build_object('union_id',md5('union')::uuid),
 CASE g%6 WHEN 0 THEN jsonb_build_object('union_id',md5('union')::uuid)WHEN 1 THEN NULL WHEN 2 THEN 'null'::jsonb WHEN 3 THEN '{}'::jsonb WHEN 4 THEN jsonb_build_object('union_id',md5('foreign')::uuid)ELSE jsonb_build_object('union_id',NULL)END,'2019-01-01'FROM generate_series(0,19)g;
 CREATE TABLE native_registrations AS SELECT g,md5('registration-'||g)::uuid id,
 CASE g%8 WHEN 0 THEN md5('tournament-'||(g%20))::uuid::text WHEN 1 THEN upper(md5('tournament-'||(g%20))::uuid::text)WHEN 2 THEN md5('tournament-'||(g%20))WHEN 3 THEN '{'||md5('tournament-'||(g%20))::uuid::text||'}'WHEN 4 THEN md5('tournament-'||(g%20))::uuid::text||' 'WHEN 5 THEN 'invalid-tournament'WHEN 6 THEN NULL ELSE md5('tournament-'||(g%20))::uuid::text END tournament_id,
 CASE WHEN g%11=0 THEN '2026-10-26 07:00Z'::timestamptz ELSE '2026-10-21'::timestamptz END observed_at FROM generate_series(1,200)g;
 INSERT INTO union_pnl_inventory_touches SELECT 'tournament_players',id,g+1000,NULL,tournament_id,'2026-10-21',observed_at FROM native_registrations;
 INSERT INTO union_pnl_inventory_touches SELECT 'tournament_players',id,g+2000,NULL,tournament_id,'2026-10-21',observed_at FROM native_registrations WHERE g%10=0;
 INSERT INTO union_pnl_inventory_events SELECT 'tournament_players',id,g+1000,'1',NULL,jsonb_build_object('tournament_id',tournament_id),observed_at FROM native_registrations;
 INSERT INTO union_pnl_inventory_events SELECT 'tournament_players',id,g+2000,'1',NULL,jsonb_build_object('tournament_id',tournament_id),observed_at FROM native_registrations WHERE g%10=0;
 INSERT INTO tournament_participant_funding_receipts SELECT id,NULL,NULL,'entry',CASE g%6 WHEN 2 THEN 'credits'WHEN 5 THEN NULL ELSE'chips'END,CASE g%6 WHEN 3 THEN 0 WHEN 4 THEN NULL WHEN 5 THEN -1 ELSE 10 END,md5('club')::uuid,NULL,NULL,jsonb_build_object('is_satellite_qualifier',false,'club_id',md5('club')::uuid)FROM native_registrations WHERE g%6<>0;
 INSERT INTO tournament_participant_funding_receipts SELECT *FROM tournament_participant_funding_receipts LIMIT 3;
 UPDATE union_pnl_inventory_events SET after_row=jsonb_build_object('user_id',md5('sat-user')::uuid,'source_satellite_id',md5('satellite')::uuid,'registered_at','2026-10-21Z','tournament_id',md5('tournament-0')::uuid)WHERE source_name='tournament_players'AND row_id=md5('registration-120')::uuid;
 INSERT INTO tournament_satellite_awards VALUES(md5('satellite')::uuid,md5('sat-user')::uuid,'seat',md5('registration-120')::uuid,NULL);
 INSERT INTO tournament_satellite_settlements VALUES(md5('satellite')::uuid,md5('tournament-0')::uuid);
 INSERT INTO tournament_participant_funding_receipts VALUES(md5('sat-registration')::uuid,md5('satellite')::uuid,md5('sat-user')::uuid,'entry','chips',10,md5('club')::uuid,md5('sat-ledger')::uuid,NULL,'{}');
 INSERT INTO chip_ledger VALUES(md5('sat-ledger')::uuid,'posted','player_wallet',md5('sat-user')::uuid,'prize_liability',md5('satellite')::uuid,md5('satellite')::uuid,10,md5('club')::uuid,'tournament_buyin','original');
 ANALYZE;""")
 expected={'fn_union_pnl_touched_registrations(timestamp with time zone,timestamp with time zone,boolean)':'e45d89f53048f070a3ddc9264d1ecdff','fn_union_pnl_tournament_in_union(text,uuid,boolean)':'e46d1253e8fc17f3fb8616d8a3e13793','fn_union_pnl_tournament_entry_club_of(text,numeric,uuid,uuid,uuid,jsonb)':'b875ae9c879c65cd1db5ae207af9f3c3','fn_union_pnl_satellite_seat_owner(uuid,uuid)':'3beddbfe1e3d204d1907b428d9358f08'}
 for sig,digest in expected.items():
  name=sig.split('(')[0];q((p/(name+'.sql')).read_text());actual=q("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure))");assert actual==digest,(name,actual,digest)
 assert q("SELECT fn_union_pnl_satellite_seat_owner(md5('registration-120')::uuid,NULL)IS NOT NULL")=='t'
 old=(p/'original-query.sql').read_text();new=(p/'candidate-query.sql').read_text()
 marker='SELECT to_jsonb(count(*))';assert old.count(marker)==1 and new.count(marker)==1
 replacement="SELECT jsonb_build_object('union_touched',(SELECT coalesce(jsonb_agg(row_id ORDER BY row_id),'[]')FROM union_touched),'bad_count',count(*),'bad_rows',coalesce(jsonb_agg(i.row_id ORDER BY i.row_id),'[]'))"
 old=old.replace(marker,replacement);new=new.replace(marker,replacement)
 def bind(s,union,projected,resolved,start="'2026-10-19 07:00Z'::timestamptz",end="'2026-10-26 07:00Z'::timestamptz"):
  for a,b in [('p_start',start),('p_end',end),('p_union_id',union),('v_inv',projected),('v_open_resolved',resolved)]:s=s.replace(a,b)
  return s
 arrays=['ARRAY[]::uuid[]',"ARRAY[md5('registration-120')::uuid]",'NULL::uuid[]','ARRAY[NULL::uuid]',"ARRAY[md5('registration-1')::uuid,NULL::uuid]"]
 cases=0;positive=0;bad_values=set()
 for union in ["md5('union')::uuid","md5('foreign')::uuid",'NULL::uuid']:
  for projected in ['true','false','NULL::boolean']:
   for resolved in arrays:
    a=bind(old,union,projected,resolved);b=bind(new,union,projected,resolved);out=q(a+';'+b).splitlines();assert len(out)==2 and json.loads(out[0])==json.loads(out[1]),(union,projected,resolved,out);v=json.loads(out[0]);positive=max(positive,len(v['union_touched']));bad_values.add(v['bad_count']);cases+=1
 assert positive>0 and max(bad_values)>0
 # Boundaries, lowercase-regex/UUID/row_id::text, NULL selection and historical JSON fallback.
 for start,end in [("'2026-10-26 07:00Z'::timestamptz","'2026-10-26 07:00Z'::timestamptz"),('NULL::timestamptz',"'2026-10-26Z'::timestamptz"),("'-infinity'::timestamptz","'infinity'::timestamptz")]:
  out=q(bind(old,"md5('union')::uuid",'true',arrays[0],start,end)+';'+bind(new,"md5('union')::uuid",'true',arrays[0],start,end)).splitlines();assert json.loads(out[0])==json.loads(out[1]);cases+=1
 base=q(bind(old,"md5('union')::uuid",'true',arrays[0]));q('UPDATE chip_ledger SET row_hash=NULL;');out=q(bind(old,"md5('union')::uuid",'true',arrays[0])+';'+bind(new,"md5('union')::uuid",'true',arrays[0])).splitlines();assert json.loads(out[0])==json.loads(out[1]);assert json.loads(out[0])['bad_count']>json.loads(base)['bad_count']
 result={'passed':True,'whole_materialized_branch_full_union_touched_and_bad_row_bag_cases':cases,'non_vacuous_union_touched_max_rows':positive,'bad_counts':sorted(bad_values),'real_original_touched_membership_entry_satellite_helpers_md5':expected,'original_satellite_economic_proof_pass_and_missing_ledger_hash_refusal_preserved':True,'canonical_uuid_regex_cast_rowid_text_and_both_membership_branches_preserved':True,'source_gen_guard_or_public_function_changed':False,'limits':'Real original4helpers and entire branch; controlled synthetic financial source tables/opening-resolved arrays. Not whole-report/source65/GEN/production qualification.'}
 (p/'native-whole-branch-result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
finally:
 if started:subprocess.run(list(map(str,[pg/'pg_ctl','-D',d/'db','-m','immediate','-w','stop'])),capture_output=True)
 shutil.rmtree(d,ignore_errors=True)
