from pathlib import Path
import subprocess,tempfile,shutil,socket,json,time,os
root=Path(__file__).resolve().parents[3]
base=Path(os.environ['DIGEST_NATIVE_WORK']);pg=Path(os.environ['PG_BIN'])
scratch=Path(tempfile.mkdtemp(prefix='retention-pg-',dir=base))
with socket.socket() as listener:listener.bind(('127.0.0.1',0));port=str(listener.getsockname()[1])
def run(tool,args,content=None):
 p=subprocess.run([str(pg/tool),*args],input=content,text=True,capture_output=True)
 if p.returncode:raise RuntimeError(p.stderr)
 return p.stdout.strip()
def sql(s):return run('psql',['-X','-h','127.0.0.1','-p',port,'-d','postgres','-At','-v','ON_ERROR_STOP=1'],s)
started=False
try:
 run('initdb',['-D',str(scratch/'data'),'-A','trust','--no-locale']);run('pg_ctl',['-D',str(scratch/'data'),'-l',str(scratch/'log'),'-o',f'-h 127.0.0.1 -k {scratch} -p {port}','-w','start']);started=True
 sql('''CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 CREATE SCHEMA smarter_private;
 CREATE TABLE hand_history_retention_policy(horse_retention_days integer);INSERT INTO hand_history_retention_policy VALUES(8);
 CREATE FUNCTION fn_platform_frozen() RETURNS boolean LANGUAGE sql AS $$SELECT current_setting('test.frozen',true)='on'$$;
 CREATE TABLE smarter_private.horse_adaptive_disposal_certificates(hand_id uuid PRIMARY KEY,qualified_at timestamptz);
 CREATE TABLE smarter_private.horse_fact_card_disposals(hand_id uuid PRIMARY KEY);
 CREATE TABLE ca_hand_facts(hand_id uuid PRIMARY KEY,hole_cards text[],player_total numeric);
 CREATE FUNCTION smarter_private.compact_horse_fact_cards(uuid[]) RETURNS integer LANGUAGE plpgsql AS $$
 DECLARE n integer;
 BEGIN
 IF current_setting('test.fail',true)='on' THEN RAISE EXCEPTION 'compactor-refused'; END IF;
 INSERT INTO smarter_private.horse_fact_card_disposals SELECT unnest($1) ON CONFLICT DO NOTHING;
 UPDATE ca_hand_facts SET hole_cards=null WHERE hand_id=ANY($1);GET DIAGNOSTICS n=ROW_COUNT;RETURN n;
 END$$;
 INSERT INTO smarter_private.horse_adaptive_disposal_certificates SELECT lpad(i::text,32,'0')::uuid,now()-interval '8 days' FROM generate_series(1,1000000)i;
 INSERT INTO smarter_private.horse_fact_card_disposals SELECT hand_id FROM smarter_private.horse_adaptive_disposal_certificates WHERE hand_id NOT IN(lpad('1',32,'0')::uuid,lpad('500000',32,'0')::uuid,lpad('1000000',32,'0')::uuid);
 INSERT INTO ca_hand_facts SELECT hand_id,ARRAY['As','Kd'],12.34 FROM smarter_private.horse_adaptive_disposal_certificates WHERE hand_id IN(lpad('1',32,'0')::uuid,lpad('500000',32,'0')::uuid,lpad('1000000',32,'0')::uuid);
 INSERT INTO smarter_private.horse_fact_card_disposals VALUES('00000000-0000-0000-0000-00000000000a');
 ANALYZE smarter_private.horse_adaptive_disposal_certificates;ANALYZE smarter_private.horse_fact_card_disposals;''')
 sql((Path(__file__).parent/'before.sql').read_text())
 sql((root/'supabase/migrations/20261018135943_fact_retention_reads_a_bounded_source_page.sql').read_text())
 results=[]
 for i in range(6):
  began=time.monotonic();d=json.loads(sql('select fn_prune_ca_hand_facts(200000)'));d['seconds']=round(time.monotonic()-began,3);results.append(d)
  assert d['scanned']<=200000 and d['retention_days']==8
 assert sql('select count(*) from ca_hand_facts where hole_cards is not null')=='0'
 assert sql('select sum(player_total) from ca_hand_facts')=='37.02'
 assert sql('select last_hand_id is null from smarter_private.horse_fact_card_prune_cursor')=='t'
 before=sql('select coalesce(last_hand_id::text,\'empty\') from smarter_private.horse_fact_card_prune_cursor')
 assert 'frozen' in sql("SET test.frozen='on';select fn_prune_ca_hand_facts(200000)")
 assert sql('select coalesce(last_hand_id::text,\'empty\') from smarter_private.horse_fact_card_prune_cursor')==before
 try:sql("set test.fail='on'; select fn_prune_ca_hand_facts(200000)")
 except RuntimeError as e:assert 'compactor-refused' in str(e)
 else:raise AssertionError('compactor failure must propagate')
 assert sql('select coalesce(last_hand_id::text,\'empty\') from smarter_private.horse_fact_card_prune_cursor')==before
 # Execute the exact Stripe aggregate extracted from the installed full body.
 sql("CREATE TABLE public.stripe_webhook_events(processed_at timestamptz,processing_status text)")
 before_metrics=(Path(__file__).parent/'metrics-before.sql').read_text()
 sql(before_metrics)
 import re
 aggregate=re.search(r"SELECT jsonb_build_object\('total', count\(\*\), 'not_completed'.*?FROM public.stripe_webhook_events WHERE processed_at >= s AND processed_at < e",before_metrics,re.S)[0]
 aggregate=aggregate.replace('processed_at >= s AND processed_at < e',"processed_at >= '2026-10-16 05:00Z' AND processed_at < '2026-10-17 05:00Z'")
 sql("INSERT INTO stripe_webhook_events VALUES('2026-10-17 01:10Z','done'),('2026-10-17 01:55Z','done')")
 assert json.loads(sql(aggregate))['not_completed']==2
 sql((root/'supabase/migrations/20261018140428_successful_stripe_webhook_receipts_are_completed_for_digest_.sql').read_text())
 patched=sql("SELECT pg_get_functiondef('fn_sp_daily_metrics_compute(date)'::regprocedure)")
 after_aggregate=aggregate.replace("processing_status IS DISTINCT FROM 'completed'","(processing_status IS NULL OR processing_status NOT IN ('done','completed'))")
 assert "processing_status NOT IN ('done','completed')" in patched
 assert json.loads(sql(after_aggregate))['not_completed']==0
 sql("INSERT INTO stripe_webhook_events SELECT '2026-10-16 08:00Z',s FROM unnest(ARRAY['completed','failed','error','dead_letter','processing',NULL])s")
 assert json.loads(sql(after_aggregate))['not_completed']==5
 print('PASS: native Stripe aggregate reproduces two false alarms before; done/completed succeed after; failed/error/dead_letter/processing/null remain visible')
 print('PASS: one million historical receipts, bounded six passes, three sparse pending hands compacted, totals unchanged, cursor wraps, freeze and failure preserve cursor')
 print(json.dumps(results))
finally:
 if started:run('pg_ctl',['-D',str(scratch/'data'),'-m','immediate','-w','stop'])
 shutil.rmtree(scratch)
