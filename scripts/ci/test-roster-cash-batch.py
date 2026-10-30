#!/usr/bin/env python3
"""Private PG17 cash reader equivalence/index qualification; no live connection.
Actual cash/funding/cutoff/tournament-money/roster readers compile unchanged.
Auth, unrelated scope collaborators and maintenance/source65 gates are explicit
native adapters. Synthetic receipts and ledger entries certify reader behavior,
never a production settlement or full-response runtime.
"""
import argparse,hashlib,json,os,re,shutil,subprocess,tempfile
from pathlib import Path
R=Path(__file__).resolve().parents[2];F=R/'scripts/ci/fixtures/roster-cash-batch';IX='rake_attributions_member_fact_club_cover'
def lit(s):return "'"+str(s).replace("'","''")+"'"
def nodes(p):
 yield p
 for c in p.get('Plans',[]):yield from nodes(c)
def main():
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--pg-bin',type=Path,required=True);ap.add_argument('--scratch',type=Path,required=True);ap.add_argument('--output',type=Path,required=True);a=ap.parse_args();assert __debug__ and a.scratch.is_dir()and not a.output.exists()
 w=Path(tempfile.mkdtemp(prefix='rcash-',dir=a.scratch.resolve()));assert len(str(w).encode())<90;data=w/'data';started=False;cases=[];plans=[]
 env={k:v for k,v in os.environ.items()if not k.startswith('PG')};env.update(TMPDIR=str(w),TMP=str(w),TEMP=str(w),LC_ALL='C');ps=[a.pg_bin/'psql','-XqAt','-v','ON_ERROR_STOP=1','-h',w,'-U','postgres','-d','postgres']
 def run(cmd,sql=None,error=None):
  x=subprocess.run(list(map(str,cmd)),input=sql,text=True,capture_output=True,env=env,timeout=180)
  assert (x.returncode!=0 and error in x.stderr)if error else x.returncode==0,(x.stdout[-2000:],x.stderr[-7000:]);return x.stdout.strip()
 def q(sql,error=None):return run(ps,sql,error)
 def js(sql):return json.loads(q(sql))
 def ok(s):cases.append(s);print('PASS',s,flush=True)
 fs=json.loads((F/'functions-before.json').read_text());authority=json.loads((F/'ra-authority.json').read_text());manifest=json.loads((F/'manifest.json').read_text());migration=(R/manifest['migration']).read_text();assert (F/'candidate-helper.sql').read_text() in migration and (F/'candidate-reader.sql').read_text() in migration;at=migration.index('BEGIN;');prefix=migration[:at];body=migration[at:];reader=next(f for f in fs if f['signature'].startswith('ca_club_members_win_loss('))
 club="md5('club-a')::uuid";ids="ARRAY(SELECT md5('p-'||g)::uuid FROM generate_series(1,100)g)";args=club+','+ids
 def rollup():
  q("TRUNCATE member_record_daily_facts;INSERT INTO member_record_daily_facts SELECT public.fn_member_record_fact_club(f),f.user_id,(f.played_at AT TIME ZONE 'UTC')::date,f.game_variant,f.tournament_id IS NOT NULL,count(*),0,0,0,0,0,0,0,0,0,sum(f.net),public.fn_ca_launch_accounting_cutoff('club',public.fn_member_record_fact_club(f)) FROM ca_hand_facts f WHERE public.fn_ca_launch_accounting_accepts(public.fn_member_record_fact_club(f),f.played_at)GROUP BY 1,2,3,4,5,17;")
 def cash_matrix():
  return q("SELECT p::text||'|'||row_to_json(v)::text FROM unnest(ARRAY['today','week','month','overall'])p CROSS JOIN LATERAL public.ca_club_members_win_loss("+args+",p)v ORDER BY p,v.user_id")
 try:
  assert ' 17.'in run([a.pg_bin/'postgres','--version']);run([a.pg_bin/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'])
  with(data/'postgresql.conf').open('a')as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(w)+"'\ntimezone='UTC'\ntrack_functions='all'\nshared_buffers='16MB'\nwork_mem='16MB'\nmaintenance_work_mem='32MB'\n")
  run([a.pg_bin/'pg_ctl','-D',data,'-l',w/'postgres.log','-w','start']);started=True;q((F/'bootstrap.sql').read_text())
  cols=[c['name']+' '+c['type']+(' NOT NULL'if c['not_null']else'')+(' DEFAULT '+c['default']if c['default']else'')for c in authority['columns']];q('CREATE TABLE rake_attributions('+','.join(cols)+');')
  for c in authority['constraints']:q('ALTER TABLE rake_attributions ADD CONSTRAINT '+c['name']+' '+c['definition']+';')
  for ix in authority['indexes']:
   name=re.search(r'INDEX (\w+)',ix).group(1)
   if q('SELECT to_regclass('+lit(name)+')IS NULL')=='t':q(ix+';')
  q('ALTER TABLE rake_attributions ENABLE ROW LEVEL SECURITY;GRANT SELECT ON rake_attributions TO anon,authenticated;GRANT ALL ON rake_attributions TO service_role;')
  q('SET check_function_bodies=off;'+''.join(f['definition']+';'for f in fs))
  for f in fs:
   sig=f['signature'];q('REVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC,anon,authenticated,service_role;')
   for role in ['anon','authenticated','service_role']:
    if role+'=X/'in(f['acl']or''):q('GRANT EXECUTE ON FUNCTION '+sig+' TO '+role+';')
   assert q('SELECT md5(pg_get_functiondef('+lit(sig)+'::regprocedure))')==f['md5'],sig
  q((F/'seed.sql').read_text())
  # Explicit equal-seat/equal-recorded id winner is NULL, not the older club.
  assert q("SELECT funding_club_id IS NULL FROM cash_participant_funding_receipts WHERE table_id=md5('table-21')::uuid AND operation_kind='buyin' ORDER BY seat_joined_at DESC,recorded_at DESC,id DESC LIMIT 1")=='t'
  assert q("SELECT count(*) FROM cash_participant_funding_receipts WHERE table_id=md5('table-21')::uuid AND operation_kind='buyin' AND seat_joined_at=(SELECT max(seat_joined_at) FROM cash_participant_funding_receipts WHERE table_id=md5('table-21')::uuid AND operation_kind='buyin')")=='3'
  rollup();q('VACUUM ANALYZE rake_attributions;VACUUM ANALYZE ca_hand_facts;ANALYZE member_record_daily_facts;')
  q('SELECT pg_stat_reset();');before=cash_matrix();assert len(before.splitlines())==392
  old_calls=int(q("SELECT calls FROM pg_stat_user_functions WHERE funcid='public.ca_club_member_tournament_money(uuid,uuid,timestamptz,timestamptz)'::regprocedure"))
  # Independently check original cache readers against complete raw signed facts.
  raw="SELECT w.uid,d.s,d.e,coalesce(sum(f.net),0) expected FROM (SELECT unnest("+ids+")uid)w CROSS JOIN(VALUES('2026-03-08'::date,'2026-03-09'::date),('2026-11-01'::date,'2026-11-02'::date))d(s,e) LEFT JOIN ca_hand_facts f ON f.user_id=w.uid AND f.tournament_id IS NULL AND f.played_at>=d.s::timestamp AT TIME ZONE 'America/Chicago' AND f.played_at<d.e::timestamp AT TIME ZONE 'America/Chicago' AND public.fn_member_record_fact_club(f)="+club+" AND public.fn_ca_launch_accounting_accepts("+club+",f.played_at)GROUP BY w.uid,d.s,d.e"
  assert q('SELECT count(*)FROM('+raw+')x WHERE x.expected IS DISTINCT FROM public.ca_club_member_chicago_cash('+club+',x.uid,x.s,x.e)')=='0'
  ok('actual_original_sources_match_raw_cash_across_23h_and25h_Chicago_days')
  source_hash=q("SELECT md5(string_agg(md5(to_jsonb(t)::text),''ORDER BY id))FROM rake_attributions t")
  point="SELECT f.hand_id,f.user_id,ra.club_id FROM(SELECT hand_id,user_id FROM ca_hand_facts WHERE tournament_id IS NULL ORDER BY hand_id LIMIT 2000)f LEFT JOIN rake_attributions ra ON ra.hand_id=f.hand_id AND ra.player_id=f.user_id"
  old_plan=js('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)'+point);q(prefix);q(body);new_plan=js('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)'+point);plans=[old_plan,new_plan]
  assert any(n.get('Index Name')==IX and n['Node Type']=='Index Only Scan'for n in nodes(new_plan[0]['Plan'])),new_plan
  q('SELECT pg_stat_reset();');assert cash_matrix()==before
  new_calls=int(q("SELECT calls FROM pg_stat_user_functions WHERE funcid='public.ca_club_member_tournament_money(uuid,uuid,timestamptz,timestamptz)'::regprocedure"));assert old_calls==784 and new_calls==392,(old_calls,new_calls)
  ok('real_function_calls_halved_784_to392_without_changing_money')
  assert q("SELECT md5(string_agg(md5(to_jsonb(t)::text),''ORDER BY id))FROM rake_attributions t")==source_hash
  ok('100_member_all_periods_exact_original_totals_and_source_rows_preserved')
  assert q('SELECT count(*)FROM('+raw+')x JOIN public.ca_club_members_cash_window('+club+','+ids+',x.s,x.e)c ON c.user_id=x.uid WHERE x.expected IS DISTINCT FROM c.cash_net')=='0'
  ok('batch_funding_rejoin_NULL_latest_receipt_RA_fact_fallback_and_DST_raw_equivalence')
  for period in ['today','week','month','overall']:
   auth="SET test.authrole='authenticated';SET test.viewer="+lit(q("SELECT md5('p-102')::uuid"))+";SET ROLE authenticated;SELECT count(*)FROM public.ca_club_members_win_loss("+args+','+lit(period)+');'
   assert q(auth)=='10'
  assert q("SET test.authrole='authenticated';SET test.viewer="+lit(q("SELECT md5('p-103')::uuid"))+";SET ROLE authenticated;SELECT count(*)FROM public.ca_club_members_win_loss("+args+",'week')")=='0'
  q("SET ROLE anon;SELECT * FROM public.ca_club_members_win_loss("+args+",'week')",'permission denied')
  for role in ['anon','authenticated','service_role']:q('SET ROLE '+role+';SELECT * FROM public.ca_club_members_cash_window('+args+",NULL,NULL)",'permission denied')
  q("SELECT * FROM public.ca_club_members_win_loss("+club+",array_fill(md5('p-1')::uuid,ARRAY[101]),'week')",'At most 100')
  q("SELECT * FROM public.ca_club_members_win_loss("+args+",'invalid')",'Invalid win loss')
  assert q("SELECT count(*)FROM public.ca_club_members_win_loss("+club+",ARRAY[]::uuid[],'week')")=='0'
  ok('same_staff_downline_identity_anon_internal_helper_and_100_slot_validation')
  # Real boundary table and exact cutoff source, not the older fixture's OR mock.
  q("INSERT INTO ca_launch_accounting_boundaries VALUES('club',"+club+",'2026-03-08 06:00Z',NULL);");rollup()
  q("INSERT INTO member_record_daily_facts SELECT club_id,user_id,played_on,game_variant,is_mtt,hands,wins,vpip_hands,pfr_hands,tb_hands,faced_tb,folded_tb,cb_hands,cb_opps,fees,999999,NULL FROM member_record_daily_facts WHERE club_id="+club+";")
  current=cash_matrix();q(reader['definition']);expected=cash_matrix();assert current==expected
  q((F/'candidate-reader.sql').read_text());assert cash_matrix()==expected
  assert q('SELECT count(*)FROM('+raw+')x JOIN public.ca_club_members_cash_window('+club+','+ids+',x.s,x.e)c ON c.user_id=x.uid WHERE x.expected IS DISTINCT FROM c.cash_net')=='0'
  ok('real_launch_cutoff_exact_finite_predicate_and_stale_generation_rows_excluded')
  q(body,'helper_exists_or_replay')
  # Revert only the private candidate in the private fixture for admission cases.
  q(reader['definition']+';DROP FUNCTION public.ca_club_members_cash_window(uuid,uuid[],date,date);')
  q("BEGIN;SET LOCAL test.frozen='on';"+body,'window_refused')
  q("BEGIN;SET LOCAL test.source65='off';"+body,'original_source_generation_required')
  q('BEGIN;GRANT EXECUTE ON FUNCTION public.ca_club_members_win_loss(uuid,uuid[],text) TO anon;'+body,'source_preimage_changed')
  q('BEGIN;UPDATE pg_index SET indisvalid=false WHERE indexrelid='+lit(IX)+'::regclass;'+body,'existing_indexes_changed')
  q(body);ok('atomic_replay_freeze_source65_invalid_index_refusals')
  a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps({'cases':cases,'plans':plans,'readerAfter':manifest['readerAfter'],'limitations':__doc__},indent=2)+'\n')
 finally:
  if started:run([a.pg_bin/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
  shutil.rmtree(w)
if __name__=='__main__':main()
