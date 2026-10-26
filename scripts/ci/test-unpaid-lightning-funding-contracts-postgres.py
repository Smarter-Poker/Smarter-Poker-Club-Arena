#!/usr/bin/env python3
"""Real PostgreSQL qualification of original unpaid Lightning accrual restarts."""
import argparse, concurrent.futures, json, os, shutil, socket, subprocess, tempfile
from pathlib import Path
from decimal import Decimal
ap=argparse.ArgumentParser();ap.add_argument('--pg-bin',type=Path,required=True);ap.add_argument('--scratch',type=Path,required=True);a=ap.parse_args()
root=Path(__file__).resolve().parents[2];fixtures=root/'scripts/ci/fixtures';data=json.loads((fixtures/'unpaid-lightning-funding-contracts.json').read_text())
a.scratch=a.scratch.resolve();base=Path(tempfile.mkdtemp(prefix='lightning-funding-',dir=a.scratch));started=False
with socket.socket() as listener:listener.bind(('127.0.0.1',0));port=str(listener.getsockname()[1])
env={**os.environ,'TMPDIR':str(base)}
def run(args,content=None,error=None):
 p=subprocess.run([str(x) for x in args],input=content,text=True,capture_output=True,env=env,timeout=120)
 if error:assert p.returncode and error in p.stderr,p.stdout+p.stderr
 else:assert p.returncode==0,p.stdout+p.stderr
 return p.stdout.strip()
def sql(s,error=None):return run([a.pg_bin/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres','-d','postgres'],s,error)
def quoted(v):return "'"+json.dumps(v).replace("'","''")+"'::jsonb"
def insert(table,rows):
 if rows:
  columns=','.join(rows[0]);assert all(set(r)==set(rows[0])for r in rows)
  sql('INSERT INTO '+table+'('+columns+') SELECT '+columns+' FROM jsonb_populate_recordset(NULL::'+table+','+quoted(rows)+')')
def snapshot(table):return sql('SELECT md5(coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),\'[]\'::jsonb)::text) FROM '+table+' x')
try:
 run([a.pg_bin/'initdb','-D',base/'d','-U','postgres','-A','trust','--no-locale','--encoding=UTF8'])
 run([a.pg_bin/'pg_ctl','-D',base/'d','-l',base/'log','-o',f"-h 127.0.0.1 -k '' -p {port}",'-w','start']);started=True
 sql("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA smarter_private;CREATE SEQUENCE hand_id_seq;ALTER DATABASE postgres SET TimeZone='UTC';")
 sql("CREATE FUNCTION fn_caller_is_engine() RETURNS boolean LANGUAGE sql AS $$SELECT current_setting('fixture.engine',true) IS DISTINCT FROM 'off'$$;CREATE FUNCTION fn_ca_launch_accounting_accepts(uuid,timestamptz) RETURNS boolean LANGUAGE sql AS $$SELECT true$$;")
 for r in json.loads((fixtures/'unpaid-atomic-cash-contract-columns.json').read_text()):sql('CREATE TABLE '+r['table_name']+'('+r['columns']+')')
 sql('CREATE TABLE clubs(id uuid PRIMARY KEY,owner_id uuid,is_union boolean,union_id uuid);CREATE TABLE wallet_transactions(id uuid PRIMARY KEY,user_id uuid,wallet_type text,amount numeric(15,2),type text,category text,description text,related_entity_id uuid,table_id uuid,hand_id uuid,created_at timestamptz,balance_after numeric,terminal_closed_at timestamptz);')
 sql('CREATE TABLE cash_hand_provenance_receipts(hand_id uuid PRIMARY KEY,table_id uuid,hand_number bigint,accepted_request jsonb);CREATE TABLE lightning_hand(hand_history_id uuid,host_table_id uuid);')
 sql('CREATE TABLE accounting_cash_atomic_contract_admissions(source_id uuid PRIMARY KEY,original_contract jsonb,admitted_contract jsonb,original_commissions jsonb,invalid_history_ids bigint[],admitted_at timestamptz);')
 sql('CREATE TABLE accounting_close_partials(kind text,union_id uuid,period_start timestamptz,period_end timestamptz,value jsonb);CREATE TABLE accounting_close_certificates(kind text,union_id uuid,period_start timestamptz,period_end timestamptz,value jsonb);CREATE TABLE accounting_recompute_split_parts(club_id uuid,period_start date,period_end date,kind text,part integer,value jsonb,computed_at timestamptz);')
 sql('ALTER TABLE accounting_cash_rake_sources ADD PRIMARY KEY(id);CREATE UNIQUE INDEX ON accounting_cash_accrual_batches(rake_record_id);CREATE UNIQUE INDEX ON accounting_period_recompute_requests(club_id,period_start,period_end);CREATE UNIQUE INDEX ON agent_commissions(user_id,source_id,source_type) WHERE source_id IS NOT NULL;')
 for table,key in [('clubs','clubs'),('accounting_agreement_history','history'),('rake_records','records'),('accounting_cash_rake_sources','sources'),('accounting_cash_accrual_batches','batches'),('rake_attributions','attributions'),('accounting_cash_bank_receipts','banks'),('union_wallet_transactions','union_journals'),('agents','agents'),('chip_ledger','buyin_journals'),('wallet_transactions','wallet_journals'),('cash_hand_provenance_receipts','provenance'),('lightning_hand','lightning')]:insert(table,data[key])
 # JSON fixture transport normalizes numeric display scale. Bind the original
 # batch fingerprint to its exact normalized source; monetary values do not change.
 sql("UPDATE accounting_cash_accrual_batches b SET source_fingerprint=md5(jsonb_build_object('record',r.id,'hand',r.hand_id,'rake',r.rake_amount,'earned_at',r.created_at,'shares',(SELECT coalesce(jsonb_agg(jsonb_build_array(a.id,a.player_id,a.club_id,a.weighted_rake_credit) ORDER BY a.player_id),'[]'::jsonb) FROM rake_attributions a WHERE a.rake_record_id=r.id))::text) FROM rake_records r WHERE r.id=b.rake_record_id")
 for r in data['definitions']:
  sql(r['definition']);assert sql("SELECT md5(pg_get_functiondef('"+r['signature']+"'::regprocedure))")==r['md5']
 sql('CREATE VIEW accounting_effective_cash_rake_sources AS '+data['effective_view'])
 sql('REVOKE ALL ON accounting_effective_cash_rake_sources FROM PUBLIC,anon,authenticated,service_role;REVOKE ALL ON FUNCTION fn_accrue_cash_hand_commissions(uuid) FROM PUBLIC,anon,authenticated;GRANT EXECUTE ON FUNCTION fn_accrue_cash_hand_commissions(uuid) TO service_role;')
 sql('CREATE TABLE accounting_tournament_fee_sources(id uuid,rake_record_id uuid,tournament_id uuid,player_id uuid,club_id uuid,union_id uuid,coordinator_union_id uuid,charged_at timestamptz,rake_credit numeric,contract jsonb);CREATE TABLE accounting_tournament_recognized_sources(source_id uuid,tournament_id uuid,recognized_at timestamptz,disposition text,rake_credit numeric);CREATE TABLE accounting_tournament_fee_recognitions(tournament_id uuid,recognized_at timestamptz,status text,union_id uuid);CREATE FUNCTION fn_ca_launch_accounting_club_cutoffs() RETURNS TABLE(club_id uuid,cutoff_at timestamptz) LANGUAGE sql AS $$SELECT NULL::uuid,NULL::timestamptz WHERE false$$;CREATE VIEW accounting_payable_earning_sources AS '+data['payable_view'])
 sql('CREATE TRIGGER immutable_source BEFORE UPDATE OR DELETE ON accounting_cash_rake_sources FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_history_immutable();CREATE TRIGGER immutable_batch BEFORE UPDATE OR DELETE ON accounting_cash_accrual_batches FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_history_immutable();CREATE TRIGGER immutable_attribution BEFORE UPDATE OR DELETE ON rake_attributions FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_history_immutable();CREATE TRIGGER commission_guard BEFORE INSERT ON agent_commissions FOR EACH ROW EXECUTE FUNCTION fn_accounting_cash_commission_source_guard();')
 preserved=['accounting_cash_rake_sources','accounting_cash_accrual_batches','rake_attributions','chip_ledger','wallet_transactions'];before={t:snapshot(t)for t in preserved}
 acl=sql("SELECT proacl::text FROM pg_proc WHERE oid='fn_accrue_cash_hand_commissions(uuid)'::regprocedure")
 expected={};by_record={}
 for e in data['expected']:
  source=e['source_id'];canonical=sql("SELECT fn_accounting_earning_contract('"+e['funding_club']+"',player_id,rake_credit,union_id,earned_at)||jsonb_build_object('attribution_id',contract->>'attribution_id') FROM accounting_cash_rake_sources WHERE id='"+source+"'")
  assert json.loads(canonical)==e['canonical_contract'],source
  expected[source]={'original_md5':sql("SELECT md5(contract::text) FROM accounting_cash_rake_sources WHERE id='"+source+"'"),'admitted_md5':sql("SELECT md5((fn_accounting_earning_contract('"+e['funding_club']+"',player_id,rake_credit,union_id,earned_at)||jsonb_build_object('attribution_id',contract->>'attribution_id'))::text) FROM accounting_cash_rake_sources WHERE id='"+source+"'")}
  by_record.setdefault(e['rake_record_id'],{})[source]=expected[source]
 hands={r['id']:r['hand_id']for r in data['records']};first_record=next(iter(by_record));first_source=next(iter(by_record[first_record]));first=next(e for e in data['expected']if e['source_id']==first_source)
 candidate=next((root/'supabase/migrations').glob('20261026161532_*')).read_text();sql(candidate)
 assert sql('SELECT '+candidate.splitlines()[0].split(': ',1)[1])=='t'
 assert sql("SELECT proacl::text FROM pg_proc WHERE oid='fn_accrue_cash_hand_commissions(uuid)'::regprocedure")==acl
 # The uncorrected original contract visibly names the host; raw receipts
 # remain unchanged after the fix, while the existing payable view must change.
 assert sql("SELECT club_id::text FROM accounting_payable_earning_sources WHERE source_id='"+first_source+"'")==first['original_club']
 def attempt(record,claims=None,prefix='',abort=False,error=None):
  claims=by_record[record]if claims is None else claims
  text='BEGIN;'+prefix+"SET LOCAL app.accounting_funding_contracts='"+json.dumps(claims)+"';SELECT fn_accrue_cash_hand_commissions('"+hands[record]+"');"
  text+="DO $$BEGIN RAISE EXCEPTION 'funding_rollback_proved';END$$;"if abort else 'COMMIT;'
  return sql(text,error or ('funding_rollback_proved'if abort else None))
 for field,message in [('original_md5','funding_cash_admission_original_changed'),('admitted_md5','funding_cash_admission_canonical_changed')]:
  bad=json.loads(json.dumps(by_record[first_record]));bad[first_source][field]='0'*32;attempt(first_record,bad,error=message)
 attempt(first_record,prefix="SET LOCAL fixture.engine='off';",error='service_role_required')
 bad={**by_record[first_record],'00000000-0000-0000-0000-000000000099':{'original_md5':'0'*32,'admitted_md5':'0'*32}};attempt(first_record,bad,error='funding_cash_admission_foreign_source')
 attempt(first_record,prefix="DELETE FROM lightning_hand WHERE hand_history_id='"+hands[first_record]+"';",error='funding_cash_admission_requires_accrued_lightning_host_source')
 attempt(first_record,prefix="DELETE FROM accounting_cash_bank_receipts WHERE rake_record_id='"+first_record+"';",error='cash_commission_bank_receipt_not_proven')
 attempt(first_record,prefix="DELETE FROM wallet_transactions WHERE id='"+first['wallet_transaction_id']+"';",error='funding_cash_admission_witness_not_exact')
 attempt(first_record,prefix="INSERT INTO wallet_transactions SELECT * FROM jsonb_populate_record(NULL::wallet_transactions,(SELECT to_jsonb(w)||jsonb_build_object('id',gen_random_uuid())FROM wallet_transactions w WHERE id='"+first['wallet_transaction_id']+"'));",error='funding_cash_admission_witness_not_exact')
 # Reject preparation/paid boundaries even if a source has no agent tiers.
 period="'2026-10-19','2026-10-25'"
 attempt(first_record,prefix="INSERT INTO rakeback_periods(club_id,user_id,period_start,period_end,status) VALUES('"+first['original_club']+"','"+first['player_id']+"',"+period+",'pending');",error='funding_cash_admission_week_already_calculated_or_paid')
 attempt(first_record,prefix="INSERT INTO agent_commission_settlements(club_id,user_id,period_start,period_end,amount) VALUES('"+first['funding_club']+"','"+first['player_id']+"','2026-10-19 07:00Z','2026-10-26 07:00Z',0);",error='funding_cash_admission_week_already_calculated_or_paid')
 for t in ['accounting_close_partials','accounting_close_certificates']:
  sql("INSERT INTO "+t+" VALUES('earned_plan','fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z','{}'),('boundary','fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-19 07:00Z','{}'),('other_book','00000000-0000-0000-0000-000000000099','2026-10-19 07:00Z','2026-10-26 07:00Z','{}')")
 sql("INSERT INTO accounting_recompute_split_parts VALUES('"+first['funding_club']+"','2026-10-19','2026-10-25','players',0,'{}',now())")
 attempt(first_record,abort=True)
 assert sql('SELECT count(*) FROM accounting_cash_funding_contract_admissions')=='0'
 assert sql('SELECT count(*) FROM agent_commissions')=='0'
 assert all(snapshot(t)==h for t,h in before.items())
 # Concurrent duplicate original requests cannot create a second admission or
 # commission. The remaining distinct hands contend on the same sorted keys.
 with concurrent.futures.ThreadPoolExecutor(max_workers=2)as pool:
  fs=[pool.submit(attempt,first_record)for _ in range(2)]
  for f in fs:f.result()
 with concurrent.futures.ThreadPoolExecutor(max_workers=2)as pool:
  fs=[pool.submit(attempt,r)for r in by_record if r!=first_record]
  for f in fs:f.result()
 assert sql('SELECT count(*) FROM accounting_cash_funding_contract_admissions')==str(len(expected))
 assert sql('SELECT sum(amount) FROM agent_commissions')=='0.08'
 assert sql('SELECT count(*) FROM agent_commissions')=='3'
 assert Decimal(sql('SELECT sum(lifetime_rake_generated) FROM agents'))==Decimal('10000.26')
 assert Decimal(sql('SELECT sum(weekly_rake_generated) FROM agents'))==Decimal('5000')
 assert Decimal(sql('SELECT coalesce(sum(agent_wallet_balance),0) FROM agents'))==0
 assert all(snapshot(t)==h for t,h in before.items())
 for e in data['expected']:
  assert sql("SELECT club_id::text FROM accounting_payable_earning_sources WHERE source_id='"+e['source_id']+"'")==e['funding_club']
 assert sql('SELECT count(*) FROM accounting_payable_earning_sources')==str(len(data['sources']))
 assert sql("SELECT count(*) FROM accounting_payable_earning_sources WHERE contract->>'club_id' IS DISTINCT FROM club_id::text")=='0'
 assert sql('SELECT count(*) FROM accounting_recompute_split_parts')=='0'
 for t in ['accounting_close_partials','accounting_close_certificates']:
  assert sql('SELECT count(*) FROM '+t)=='2'
  sql("INSERT INTO "+t+" VALUES('fresh','fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z','{}')")
 # Replay after a completed period remains a no-op; it keeps fresh proofs.
 sql("INSERT INTO rakeback_periods(club_id,user_id,period_start,period_end,status) VALUES('"+first['original_club']+"','"+first['player_id']+"',"+period+",'paid')")
 for r in by_record:attempt(r)
 assert sql('SELECT sum(amount) FROM agent_commissions')=='0.08'
 for t in ['accounting_close_partials','accounting_close_certificates']:assert sql('SELECT count(*) FROM '+t)=='3'
 bad=json.loads(json.dumps(by_record[first_record]));bad[first_source]['admitted_md5']='0'*32;attempt(first_record,bad,error='funding_cash_admission_replay_conflict')
 sql('UPDATE accounting_cash_funding_contract_admissions SET funding_club_id=funding_club_id','accounting_agreement_history_is_immutable')
 sql('DELETE FROM accounting_cash_funding_contract_admissions','accounting_agreement_history_is_immutable')
 sql('TRUNCATE accounting_cash_funding_contract_admissions','accounting_agreement_history_is_immutable')
 sql('UPDATE accounting_cash_rake_sources SET club_id=club_id','accounting_agreement_history_is_immutable')
 sql('UPDATE rake_attributions SET club_id=club_id','accounting_agreement_history_is_immutable')
 assert sql("SELECT has_function_privilege('authenticated','smarter_private.admit_cash_funding_contracts(uuid,jsonb)','EXECUTE')")=='f'
 assert sql("SELECT has_table_privilege('authenticated','accounting_cash_funding_contract_admissions','SELECT')")=='f'
 sql(candidate,'cash_funding_admission_preimage_changed')
 print(json.dumps({'qualification':'passed','sources':len(expected),'original_rows_immutable':True,'commission_amount':'0.08','wallets_unchanged':True,'original_request_replay':True,'concurrent_identical_and_distinct_hands':True,'missing_and_ambiguous_funding_refused':True,'paid_and_prepared_periods_refused':True,'scoped_proofs_invalidated':True,'fresh_proofs_kept_on_replay':True,'anonymous_acl_refused':True}))
finally:
 if started:run([a.pg_bin/'pg_ctl','-D',base/'d','-m','immediate','-w','stop'])
 shutil.rmtree(base)
