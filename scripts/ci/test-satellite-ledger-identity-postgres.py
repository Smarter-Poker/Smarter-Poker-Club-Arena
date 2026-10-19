#!/usr/bin/env python3
"""Native original satellite proof, exact-ledger predicate and forty-source guard."""
import argparse,json,os,subprocess,tempfile
from pathlib import Path
ap=argparse.ArgumentParser();ap.add_argument('--pg-bin',type=Path,required=True);ap.add_argument('--scratch',type=Path,required=True);a=ap.parse_args()
repo=Path(__file__).resolve().parents[2]
fixture=json.loads((repo/'scripts/ci/fixtures/satellite-ledger-identity-preimages.json').read_text())
migration=repo/'supabase/migrations/20261019203327_satellite_ownership_reads_its_exact_original_ledger_identity.sql'
with tempfile.TemporaryDirectory(prefix='satid-',dir=a.scratch) as tmp:
 root=Path(tmp);data=root/'d';started=False
 env={**os.environ,'PGHOST':str(root),'PGUSER':'postgres','PGDATABASE':'postgres','PGSSLMODE':'disable'}
 def run(cmd,sql=None,error=None):
  r=subprocess.run([str(x) for x in cmd],input=sql,text=True,capture_output=True,env=env,timeout=90)
  if error:assert r.returncode and error in r.stderr,r.stdout+r.stderr
  else:assert r.returncode==0,r.stdout+r.stderr
  return r.stdout.strip()
 def q(s,error=None):return run([a.pg_bin/'psql','-X','-qAt','-v','ON_ERROR_STOP=1'],s,error)
 def uid(n):return '00000000-0000-0000-0000-'+str(n).zfill(12)
 try:
  run([a.pg_bin/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'])
  with (data/'postgresql.conf').open('a') as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(root)+"'\nshared_buffers='16MB'\n")
  run([a.pg_bin/'pg_ctl','-D',data,'-l',root/'pg.log','-w','start']);started=True
  q('''CREATE SCHEMA smarter_private;CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
CREATE TABLE union_pnl_inventory_events(event_id bigint PRIMARY KEY,source_name text,row_id uuid,after_row jsonb);
CREATE INDEX union_pnl_inventory_identity ON union_pnl_inventory_events(source_name,row_id,event_id);
CREATE TABLE tournament_satellite_awards(tournament_id uuid,user_id uuid,delivery_kind text,registration_id uuid,ticket_id uuid,UNIQUE(tournament_id,user_id));
CREATE TABLE tournament_satellite_settlements(tournament_id uuid PRIMARY KEY,target_id uuid);
CREATE TABLE tournament_tickets(id uuid PRIMARY KEY,holder_id uuid,source_satellite_id uuid,source_tournament_id uuid,status text,redemption_mode text,redeemed_at timestamptz);
CREATE TABLE tournament_participant_funding_receipts(id uuid PRIMARY KEY,tournament_id uuid,user_id uuid,funding_club_id uuid,operation text,asset text,amount numeric,ledger_id uuid);
CREATE INDEX idx_tournament_funding_tournament_user ON tournament_participant_funding_receipts(tournament_id,user_id);
CREATE TABLE chip_ledger(id uuid PRIMARY KEY,status text,from_type text,from_entity_id uuid,to_type text,to_entity_id uuid,tournament_id uuid,amount numeric,club_id uuid,category text,row_hash text);
CREATE INDEX idx_chip_ledger_tournament_entry_from_player ON chip_ledger(club_id,from_entity_id) WHERE status='posted' AND from_type='player_wallet' AND to_type='prize_liability';
SET check_function_bodies=off;''')
  for f in fixture['functions']:q('SET check_function_bodies=off;'+f['definition'])
  q(fixture['source_match'])
  q('REVOKE ALL ON FUNCTION public.fn_union_pnl_satellite_seat_owner(uuid,uuid),smarter_private.original_inventory_proof_sources_match() FROM PUBLIC,anon,authenticated,service_role;')
  assert q('SELECT smarter_private.original_inventory_proof_sources_match()')=='t','actual forty production source bodies must match before migration'
  original=next(f['definition'] for f in fixture['functions'] if f['signature'].startswith('fn_union_pnl_satellite_seat_owner'))
  assert 'OFFSET 0) l WHERE l.status' not in original,'preimage already has exact ledger fence'
  reg,sat,target,user,club,ledger,ticket=[uid(i) for i in range(1,8)]
  q(f'''INSERT INTO union_pnl_inventory_events VALUES(1,'tournament_players','{reg}',jsonb_build_object('user_id','{user}','source_satellite_id','{sat}','tournament_id','{target}','registered_at','2026-10-05T08:00:00Z'));
INSERT INTO tournament_satellite_settlements VALUES('{sat}','{target}');
INSERT INTO tournament_satellite_awards VALUES('{sat}','{user}','seat','{reg}',NULL);
INSERT INTO chip_ledger VALUES('{ledger}','posted','player_wallet','{user}','prize_liability','{sat}','{sat}',100,'{club}','tournament_buyin','original-hash');
INSERT INTO tournament_participant_funding_receipts VALUES('{uid(8)}','{sat}','{user}','{club}','entry','chips',100,'{ledger}');
INSERT INTO chip_ledger SELECT md5('unrelated-'||n)::uuid,'posted','player_wallet','{user}','prize_liability','{sat}','{sat}',100,'{club}','tournament_buyin','other-hash' FROM generate_series(1,12000)n;
ANALYZE chip_ledger;ANALYZE tournament_participant_funding_receipts;''')
  call=f"SELECT public.fn_union_pnl_satellite_seat_owner('{reg}','{target}')"
  def results():
   out=[q(call),q(call.replace("'"+target+"'",'NULL::uuid')),q(call.replace(target,uid(99)))]
   assert out==[club,club,''],out
   faults=[("chip_ledger","status='pending'"),("chip_ledger","amount=99"),("chip_ledger","row_hash=NULL"),("chip_ledger",f"club_id='{uid(99)}'"),("chip_ledger",f"from_entity_id='{uid(99)}'"),("chip_ledger",f"tournament_id='{uid(99)}'"),("chip_ledger","category='other'"),("chip_ledger","to_type='other'"),("tournament_participant_funding_receipts","asset='diamonds'"),("tournament_participant_funding_receipts","amount=0"),("tournament_participant_funding_receipts","operation='addon'"),("tournament_participant_funding_receipts",f"ledger_id='{uid(99)}'")]
   for table,change in faults:
    v=q('BEGIN;UPDATE '+table+' SET '+change+' WHERE id=\''+(ledger if table=='chip_ledger' else uid(8))+'\';'+call+';ROLLBACK;')
    assert v=='',(table,change,v);out.append(v)
   ticketsetup=f"UPDATE tournament_satellite_awards SET delivery_kind='ticket',registration_id=NULL,ticket_id='{ticket}';INSERT INTO tournament_tickets VALUES('{ticket}','{user}','{sat}','{target}','redeemed','tournament_entry_only','2026-10-05T08:00Z');"
   assert q('BEGIN;'+ticketsetup+call+';ROLLBACK;')==club
   assert q('BEGIN;'+ticketsetup+"UPDATE tournament_tickets SET status='available';"+call+';ROLLBACK;')==''
   return out
  before=results()
  fingerprint="SELECT jsonb_build_object('ledger',(SELECT md5(string_agg(to_jsonb(l)::text,'' ORDER BY id)) FROM chip_ledger l),'funding',(SELECT md5(string_agg(to_jsonb(l)::text,'' ORDER BY id)) FROM tournament_participant_funding_receipts l),'other_sources',(SELECT md5(string_agg(pg_get_functiondef(oid),'' ORDER BY oid)) FROM pg_proc WHERE pronamespace IN('public'::regnamespace,'smarter_private'::regnamespace) AND proname NOT IN('fn_union_pnl_satellite_seat_owner','original_inventory_proof_sources_match')))"
  pre=q(fingerprint)
  meta="SELECT jsonb_agg(jsonb_build_array(proowner,proacl,proconfig,provolatile,prosecdef) ORDER BY oid) FROM pg_proc WHERE oid IN('public.fn_union_pnl_satellite_seat_owner(uuid,uuid)'::regprocedure,'smarter_private.original_inventory_proof_sources_match()'::regprocedure)"
  oldmeta=q(meta)
  q(migration.read_text())
  assert results()==before
  predicate=next(line.split('-- @live-proof: ',1)[1] for line in migration.read_text().splitlines() if line.startswith('-- @live-proof: '))
  assert q('SELECT '+predicate)=='t'
  assert q(fingerprint)==pre and q(meta)==oldmeta
  assert q('SELECT smarter_private.original_inventory_proof_sources_match()')=='t'
  changed=q("SELECT pg_get_functiondef('public.fn_union_pnl_satellite_seat_owner(uuid,uuid)'::regprocedure)")
  assert 'FROM (SELECT row.* FROM public.chip_ledger row WHERE row.id=r.ledger_id OFFSET 0) l WHERE l.status' in changed
  body=changed.split('AS $function$\n')[1].split('\n$function$')[0].replace('p_registration_id','$1').replace('p_tournament_id','$2')
  plan=json.loads(q("SET plan_cache_mode=force_generic_plan;PREPARE audit_sat(uuid,uuid) AS "+body+f";EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) EXECUTE audit_sat('{reg}','{target}');"))[0]
  def nodes(n):
   yield n
   for c in n.get('Plans',[]):yield from nodes(c)
  ls=[n for n in nodes(plan['Plan']) if n.get('Relation Name')=='chip_ledger']
  assert ls and all(n.get('Index Name')=='chip_ledger_pkey' and 'id = r.ledger_id' in n.get('Index Cond','') for n in ls),ls
  q(migration.read_text(),'satellite_ledger_identity_preimage_changed')
  q("ALTER FUNCTION public.fn_union_week_start(timestamptz) SET work_mem='8MB';")
  assert q('SELECT smarter_private.original_inventory_proof_sources_match()')=='f','unrelated source drift must remain refused'
  for role in ['anon','authenticated','service_role']:
   q('SET ROLE '+role+';'+call,'permission denied')
  hashes=json.loads(q("SELECT jsonb_object_agg(proname,md5(pg_get_functiondef(oid))) FROM pg_proc WHERE oid IN('public.fn_union_pnl_satellite_seat_owner(uuid,uuid)'::regprocedure,'smarter_private.original_inventory_proof_sources_match()'::regprocedure)"))
  print(json.dumps({'qualification':'passed','actual_forty_source_guard':True,'original_and_new_owner_equivalent':True,'negative_fields':12,'seat_and_ticket':True,'generic_plan_exact_ledger_primary_key':True,'rows_and_other_sources_unchanged':True,'metadata_preserved':True,'source_drift_refused':True,'replay_refused':True,'hashes':hashes}))
 finally:
  if started:run([a.pg_bin/'pg_ctl','-D',data,'-m','fast','-w','stop'])
