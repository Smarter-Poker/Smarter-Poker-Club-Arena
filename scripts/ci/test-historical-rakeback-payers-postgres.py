#!/usr/bin/env python3
"""Real original calculator, R3 wallet/ledger and invoice transactions on PG17."""
import argparse,concurrent.futures,json,os,re,shutil,socket,subprocess,tempfile
from decimal import Decimal
from pathlib import Path
ap=argparse.ArgumentParser();ap.add_argument('--pg-bin',type=Path,required=True);ap.add_argument('--scratch',type=Path,required=True)
a=ap.parse_args();root=Path(__file__).resolve().parents[2];base=Path(tempfile.mkdtemp(prefix='hrp-',dir=a.scratch));started=False
with socket.socket()as listener:listener.bind(('127.0.0.1',0));port=str(listener.getsockname()[1])
env={**os.environ,'TMPDIR':str(base)}
def run(args,content=None,error=None):
 p=subprocess.run([str(x)for x in args],input=content,text=True,capture_output=True,env=env,timeout=90)
 if error:assert p.returncode and error in p.stderr,p.stdout+p.stderr
 else:assert p.returncode==0,p.stdout+p.stderr
 return p.stdout.strip()
def sql(s,error=None):return run([a.pg_bin/'psql','-XqAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres'],s,error)
def load(p):return sql((root/p).read_text())
try:
 run([a.pg_bin/'initdb','-D',base/'d','-U','postgres','-A','trust','--no-locale','--encoding=UTF8'])
 run([a.pg_bin/'pg_ctl','-D',base/'d','-l',base/'log','-o',f'-h 127.0.0.1 -k {base} -p {port}','-w','start']);started=True
 sql("ALTER DATABASE postgres SET TimeZone='UTC';CREATE SCHEMA smarter_private;")
 for p in ['tests/fixtures/routed-accounting/bootstrap.sql','tests/fixtures/routed-accounting/preimage.sql','supabase/accounting/weekly-v3/components/20260914132449_rakeback_follows_recorded_hierarchy_in_one_funded_transaction.sql','supabase/accounting/weekly-v3/components/20260914135008_standalone_clubs_use_the_same_atomic_routed_stages.sql','tests/fixtures/routed-accounting/mixed-source-schema.sql','supabase/accounting/weekly-v3/components/20260914140015_recognized_cash_and_tournament_sources_share_one_payment_route.sql','tests/fixtures/routed-accounting/central-delivery-schema.sql','tests/fixtures/routed-accounting/central-delivery-preimage.sql','supabase/accounting/weekly-v3/components/20260914133404_routed_invoice_roles_follow_the_recorded_payment.sql','tests/fixtures/routed-accounting/central-delivery-triggers.sql']:load(p)
 sql("""ALTER TABLE profiles ADD COLUMN status text DEFAULT 'active';
 ALTER TABLE club_members ADD COLUMN held_chips numeric DEFAULT 0,ADD COLUMN locked_chips numeric DEFAULT 0;
 ALTER TABLE rakeback_periods ALTER COLUMN id SET DEFAULT gen_random_uuid();
 ALTER TABLE rakeback_periods ADD UNIQUE(user_id,club_id,period_start,period_end);
 ALTER TABLE accounting_rakeback_period_calculations ADD CONSTRAINT accounting_rakeback_period_calculations_payer_kind_check CHECK(payer_kind IN('agent','club'));
 CREATE TABLE accounting_agreement_history(id bigint PRIMARY KEY,entity_type text,entity_key text,observed_at timestamptz,after_terms jsonb);
 CREATE TABLE accounting_rakeback_period_evidence_checkpoints(metadata_only boolean);
 CREATE FUNCTION fn_accounting_tournament_source_terms_at(uuid,timestamptz,jsonb) RETURNS timestamptz LANGUAGE sql AS $$SELECT $2$$;
 CREATE FUNCTION fn_ca_launch_accounting_waived(text,uuid,timestamptz) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
 CREATE FUNCTION fn_accounting_union_earned_plan(uuid,timestamptz,timestamptz) RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$;
 CREATE FUNCTION fn_settle_accounting_rakeback_plan_get(text,uuid,timestamptz,timestamptz,uuid[],uuid,uuid,boolean) RETURNS jsonb LANGUAGE sql AS $$SELECT NULL::jsonb$$;
 CREATE FUNCTION fn_ca_deleted_wallet_bank_return(uuid,uuid,text) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'unexpected deleted account in fixture';END$$;
 INSERT INTO unions(id,name,owner_id)VALUES(u(1),'Union',u(902));INSERT INTO union_clubs VALUES(u(1),u(11));
 INSERT INTO clubs(id,chip_treasury,name,owner_id)VALUES(u(11),1000,'Club',u(901));
 INSERT INTO union_settlement_floor VALUES(u(1),'2026-09-07');INSERT INTO accounting_cash_accrual_cutover VALUES(true,'2026-09-07 07:00Z');
 INSERT INTO profiles(id,username,status)VALUES(u(304),'Zero contributor','active'),(u(305),'Owner deal','active');
 INSERT INTO club_members(club_id,user_id,chip_balance,role,status)SELECT u(11),u(n),CASE n WHEN 201 THEN 10 WHEN 202 THEN 20 ELSE 0 END,'player','active'FROM unnest(ARRAY[201,202,301,302,303,304,305])n;
 """)
 pre=json.loads((root/'scripts/ci/fixtures/historical-rakeback-payer-preimages.json').read_text())+json.loads((root/'scripts/ci/fixtures/historical-rakeback-payer-observer-preimages.json').read_text())
 for r in pre:sql(r['definition']);assert sql("SELECT md5(pg_get_functiondef('"+r['signature']+"'::regprocedure))")==r['md5']
 for r in pre:
  sql('REVOKE ALL ON FUNCTION '+r['signature']+' FROM PUBLIC,anon,authenticated,service_role')
  if 'service_role=X/'in(r['acl']or''):sql('GRANT EXECUTE ON FUNCTION '+r['signature']+' TO service_role')
  if 'authenticated=X/'in(r['acl']or''):sql('GRANT EXECUTE ON FUNCTION '+r['signature']+' TO authenticated')
 original_acl={r['signature']:sql("SELECT proacl::text FROM pg_proc WHERE oid='"+r['signature']+"'::regprocedure")for r in pre}
 for r in json.loads((root/'scripts/ci/fixtures/unpaid-atomic-cash-contract-dependencies.json').read_text())['definitions']:
  if r['signature']=='fn_accounting_agreement_history_immutable()':sql(r['definition'])
 sql("CREATE CONSTRAINT TRIGGER zz_ca_rakeback_payout_leg_is_documented AFTER INSERT ON public.chip_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.status='posted' AND NEW.category='rakeback' AND NEW.to_type='player_wallet') EXECUTE FUNCTION fn_ca_rakeback_payout_leg_is_documented();")
 # Source records represent two earning-time agents, an agent/club change,
 # and an unchanged payer. The .015 products expose double rounding.
 for i,player,payer,rake in [(1,301,201,'.10'),(2,301,202,'.10'),(3,302,201,'.10'),(4,302,None,'.30'),(5,303,201,'.10'),(6,303,201,'.10'),(7,304,201,'0'),(8,304,202,'0'),(9,305,901,'.10')]:
  member={'club_id':'00000000-0000-4000-8000-000000000011','user_id':f'00000000-0000-4000-8000-{player:012d}','agent_id':f'00000000-0000-4000-8000-{payer:012d}'if payer else None,'status':'active','is_active':True,'player_rakeback_pct':.15 if payer else 0}
  agent={'club_id':member['club_id'],'user_id':member['agent_id'],'status':'active','player_rakeback_rate':.15,'commission_rate':.25}
  contract={'membership':{'history_id':i,'terms':member},'tiers':[{'depth':1,'rate':.25,'user_id':member['agent_id'],'agreement':{'history_id':100+i,'terms':agent}}]if payer else []}
  if player==305:member['player_rakeback_pct']=.70;contract['tiers']=[]
  encoded=json.dumps(contract).replace("'","''");m=json.dumps(member);g=json.dumps(agent)
  sql("INSERT INTO accounting_agreement_history VALUES("+str(i)+",'club_members','"+member['club_id']+":"+member['user_id']+"','2026-09-01','"+m+"'),("+str(100+i)+",'agents','agent-"+str(i)+"','2026-09-01','"+g+"');")
  if i==2:
   sql("INSERT INTO accounting_tournament_fee_sources VALUES(u(402),u(502),u(802),u(301),u(11),u(1),u(1),'2026-09-08',.10,'"+encoded+"');INSERT INTO accounting_tournament_fee_recognitions VALUES(u(802),'2026-09-09','recognized',.10,u(1));INSERT INTO accounting_tournament_recognized_sources VALUES(u(402),u(802),'2026-09-09','earned',.10);")
  else:
   sql("INSERT INTO accounting_cash_rake_sources VALUES(u("+str(400+i)+"),u("+str(500+i)+"),u("+str(player)+"),u(11),u(1),u(1),'2026-09-08',"+rake+",'"+encoded+"')")
 before=json.loads(sql("SELECT fn_rakeback_split_check(u(11),'2026-09-07','2026-09-13',NULL)"))
 assert before['reason']=='multiple_historical_payers_require_split_period'
 candidate=next((root/'supabase/migrations').glob('20261019213557_*')).read_text();sql(candidate)
 assert sql('SELECT '+candidate.splitlines()[0].split(': ',1)[1])=='t'
 for sig,acl in original_acl.items():assert sql("SELECT proacl::text FROM pg_proc WHERE oid='"+sig+"'::regprocedure")==acl
 check=json.loads(sql("SELECT fn_rakeback_split_check(u(11),'2026-09-07','2026-09-13',NULL)"));assert check['players']==5
 sql("SELECT fn_rakeback_split_write(u(11),'2026-09-07','2026-09-13',NULL)")
 assert sql('SELECT sum(rakeback_amount)FROM rakeback_periods')=='0.16'
 assert sql("SELECT count(*)FROM accounting_rakeback_period_calculations WHERE payer_kind='split'")=='3'
 assert Decimal(sql('SELECT smarter_private.deleted_wallet_published_rakeback_reserve(u(11),u(201))'))==Decimal('.07')
 assert Decimal(sql('SELECT smarter_private.deleted_wallet_published_rakeback_reserve(u(11),u(202))'))==Decimal('.01')
 sql("UPDATE accounting_rakeback_payer_contracts SET amount=amount+.01",'accounting_agreement_history_is_immutable')
 sql("SELECT smarter_private.rakeback_payer_plan('[]',0)",'rakeback_payer_plan_invalid')
 sql("SELECT smarter_private.rakeback_payer_plan('[{\"payer_kind\":\"agent\",\"payer_user_id\":null,\"rake_credit\":1,\"rate\":0.1}]',0.1)",'rakeback_payer_allocation_invalid')
 sql("SELECT smarter_private.rakeback_payer_plan('[{\"payer_kind\":\"club\",\"payer_user_id\":null,\"rake_credit\":1,\"rate\":0.1}]',0.2)",'rakeback_payer_total_disagrees')
 assert sql("SELECT has_table_privilege('service_role','accounting_rakeback_payer_contracts','INSERT')")=='f'
 assert sql("SELECT has_function_privilege('authenticated','smarter_private.rakeback_certificate_payers(bigint)','EXECUTE')")=='f'
 call="SELECT fn_settle_accounting_rakeback_stage('union',u(1),'2026-09-07 07:00Z','2026-09-14 07:00Z');"
 sql("BEGIN;SET LOCAL test.is_engine='false';"+call,'service_role_required')
 sql("BEGIN;INSERT INTO settlement_locks VALUES('GLOBAL_SETTLEMENT_FREEZE',true);"+call,'EMERGENCY_PROFIT_DRIFT_LOCK')
 sql("BEGIN;UPDATE club_members SET chip_balance=0 WHERE user_id=u(202);"+call,'routed_rakeback_agent_funding_shortfall')
 sql("BEGIN;UPDATE clubs SET chip_treasury=0;"+call,'routed_rakeback_club_funding_shortfall')
 sql("BEGIN;SET LOCAL test.delivery_failure='rakeback';"+call,'test real notification failure')
 sql("BEGIN;"+call+"SET CONSTRAINTS ALL IMMEDIATE;DO $$BEGIN RAISE EXCEPTION 'qualified_rakeback_rollback';END$$;",'qualified_rakeback_rollback')
 assert sql('SELECT count(*)FROM rakeback_period_payouts')=='0'
 assert sql('SELECT count(*)FROM chip_ledger')=='0'
 assert sql('SELECT count(*)FROM settlement_invoices')=='0'
 assert sql('SELECT count(*)FROM social_messages')=='0'
 assert Decimal(sql('SELECT sum(chip_balance)FROM club_members'))==Decimal(30)
 # Force only the existing batch clock in isolation. Production retains its
 # original ninety-second budget. The old global-run-only document gate
 # incorrectly rolled a fully paid period back at an unfinished book boundary.
 stage_sql=sql("SELECT pg_get_functiondef('fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure)")
 assert stage_sql.count("v_stop:=clock_timestamp()+interval '90 seconds';")==1
 forced_stage=stage_sql.replace("v_stop:=clock_timestamp()+interval '90 seconds';","v_stop:=clock_timestamp()-interval '1 second';")
 guard_sql=sql("SELECT pg_get_functiondef('fn_ca_rakeback_payout_leg_is_documented()'::regprocedure)")
 old_guard=next(r['definition']for r in pre if r['signature']=='fn_ca_rakeback_payout_leg_is_documented()')
 gate=r"IF NOT EXISTS\(SELECT 1 FROM public\.accounting_routed_settlement_runs r.*?\) THEN"
 strict_gate=re.search(gate,old_guard,re.S).group(0)
 assert len(re.findall(gate,guard_sql,re.S))==1
 strict_guard=re.sub(gate,lambda m:strict_gate,guard_sql,count=1,flags=re.S)
 sql(forced_stage);sql(strict_guard)
 chunk="BEGIN;SET LOCAL app.weekly_accounting_chunked='on';SET LOCAL app.weekly_accounting_scope_deadline='2099-01-01';"
 sql(chunk+call+'COMMIT;','names no routed settlement run')
 assert sql('SELECT count(*)FROM rakeback_period_payouts')=='0'
 sql(guard_sql)
 sql(chunk+call+"SET CONSTRAINTS ALL IMMEDIATE;DO $$BEGIN IF(SELECT count(*)FROM rakeback_period_payouts)<>1 OR EXISTS(SELECT 1 FROM accounting_routed_settlement_runs WHERE round_no=3)THEN RAISE EXCEPTION 'partial period proof incorrect';END IF;RAISE EXCEPTION 'qualified_partial_rollback';END$$;",'qualified_partial_rollback')
 assert sql('SELECT count(*)FROM rakeback_period_payouts')=='0'
 # The actual cached source/certificate plan must accept exactly the same
 # original historical payer identities as the direct set-reading path.
 sql('CREATE TABLE accounting_close_partials(kind text,union_id uuid,period_start timestamptz,period_end timestamptz,window_start timestamptz,window_end timestamptz,value jsonb,computed_at timestamptz,cash_ids uuid[],cash_md5 text[],fee_ids uuid[],fee_md5 text[],UNIQUE(kind,union_id,period_start,period_end,window_start));')
 for r in json.loads((root/'scripts/ci/fixtures/historical-rakeback-payer-cache-preimages.json').read_text()):sql(r['definition'])
 sql("BEGIN;SET LOCAL app.weekly_accounting_chunked='on';SET LOCAL app.weekly_accounting_scope_deadline='2099-01-01';INSERT INTO accounting_close_partials(kind,union_id,period_start,period_end,window_start,window_end,value,computed_at)SELECT 'round3_union_window',u(1),'2026-09-07 07:00Z','2026-09-14 07:00Z',w.window_start,w.window_end,fn_settle_accounting_rakeback_window(u(1),NULL,w.window_start,w.window_end),clock_timestamp()FROM fn_accounting_close_windows('2026-09-07 07:00Z','2026-09-14 07:00Z')w;SELECT fn_settle_accounting_rakeback_plan('union',u(1),'2026-09-07 07:00Z','2026-09-14 07:00Z');COMMIT;")
 partial=json.loads(sql(chunk+call+'COMMIT;'));assert partial['batch_committed']is True and partial['remaining']==4,partial
 assert sql('SELECT count(*)FROM rakeback_period_payouts')=='1'
 sql(stage_sql)
 cached_call="BEGIN;SET LOCAL app.weekly_accounting_chunked='on';SET LOCAL app.weekly_accounting_scope_deadline='2099-01-01';"+call+"SELECT current_setting('app.accounting_round3_plan_used');COMMIT;"
 with concurrent.futures.ThreadPoolExecutor(max_workers=2)as pool:
  futures=[pool.submit(sql,cached_call)for _ in range(2)]
  cached=[f.result()for f in futures]
 for answer in cached:assert answer.splitlines()[-1]=='on',answer
 results=[json.loads(answer.splitlines()[0])for answer in cached]
 assert all(v['amount']==.16 for v in results),results
 assert sum(v.get('duplicate',False)for v in results)==1,results
 assert sql('SELECT count(*)FROM rakeback_period_payouts')=='5'
 assert sql('SELECT count(*)FROM accounting_rakeback_payer_transfers')=='4'
 assert Decimal(sql("SELECT sum(chip_balance)FROM club_members WHERE user_id IN(u(301),u(302),u(303))"))==Decimal('.09')
 assert Decimal(sql('SELECT chip_treasury FROM clubs WHERE id=u(11)'))==Decimal('999.92')
 assert Decimal(sql('SELECT chip_balance FROM club_members WHERE user_id=u(305)'))==Decimal('.07')
 assert Decimal(sql('SELECT chip_balance FROM club_members WHERE user_id=u(201)'))==Decimal('9.93')
 assert Decimal(sql('SELECT chip_balance FROM club_members WHERE user_id=u(202)'))==Decimal('19.99')
 assert sql('SELECT count(*)FROM chip_ledger')=='6'
 assert Decimal(sql('SELECT smarter_private.deleted_wallet_published_rakeback_reserve(u(11),u(201))'))==0
 assert Decimal(sql('SELECT smarter_private.deleted_wallet_published_rakeback_reserve(u(11),u(202))'))==0
 sql("DELETE FROM accounting_rakeback_payer_transfers",'accounting_agreement_history_is_immutable')
 assert sql('SELECT count(*)FROM settlement_invoices')=='6'
 delivery=sql("SELECT count(*)FROM accounting_invoice_deliveries WHERE message_id IS NOT NULL AND notification_id IS NOT NULL")
 assert delivery=='10'
 assert sql("SELECT count(*)FROM settlement_invoices i WHERE(SELECT count(*)FROM accounting_invoice_deliveries d WHERE d.invoice_id=i.id)<>CASE WHEN i.from_entity_type='club' THEN 1 ELSE 2 END")=='0'
 assert sql("SELECT bool_and(smarter_private.split_rakeback_payout_complete(p.id,c.id))FROM rakeback_period_payouts p JOIN accounting_rakeback_period_calculations c ON c.period_id=p.rakeback_period_id WHERE c.payer_kind='split'")=='t'
 duplicate=json.loads(sql("SELECT fn_settle_accounting_rakeback_stage('union',u(1),'2026-09-07 07:00Z','2026-09-14 07:00Z')"));assert duplicate['duplicate']is True
 assert sql('SELECT count(*)FROM chip_ledger')=='6'
 # The unchanged correctness checker loops are metadata prerequisites. Execute
 # its actual C3 cohort query, which must retain real evidence gaps while
 # recognizing the complete multiple-credit receipts rather than a fake pointer.
 sql('CREATE TABLE rakeback_distributions(id uuid,club_id uuid,status text,transferred_at timestamptz,chip_transfer_id uuid,rakeback_amount numeric);')
 def c3(definition):
  first=definition.index("SELECT 'period_payout' AS src")
  end=definition.index('LIMIT 20',first)+len('LIMIT 20')
  return definition[first:end]
 old_check=next(r['definition']for r in pre if r['signature']=='fn_ca_settlement_correctness_check()')
 new_check=sql("SELECT pg_get_functiondef('fn_ca_settlement_correctness_check()'::regprocedure)")
 assert sql('SELECT count(*)FROM('+c3(old_check)+')g')=='2'
 assert sql('SELECT count(*)FROM('+c3(new_check)+')g')=='0'
 sql("BEGIN;INSERT INTO rakeback_periods(id,user_id,club_id,period_start,period_end,rake_generated,rakeback_rate,rakeback_amount,status,rakeback_earned,total_rake_paid)VALUES(u(999),u(301),u(11),'2026-09-14','2026-09-20',1,.1,.1,'paid',.1,1);INSERT INTO rakeback_period_payouts(rakeback_period_id,club_id,user_id,payout_amount,status,paid_at)VALUES(u(999),u(11),u(301),.1,'paid',now());DO $check$ BEGIN IF(SELECT count(*)FROM("+c3(new_check)+")g)<>1 THEN RAISE EXCEPTION 'genuine wallet evidence gap hidden';END IF;END $check$;ROLLBACK;")
 # Real full owner-report function; existing auth/calendar/tournament adapters
 # are the same isolated prerequisites used by the maintained stats fixture.
 sql("ALTER TABLE clubs ADD COLUMN lifecycle_status text DEFAULT 'active',ADD COLUMN asset text DEFAULT 'chips';ALTER TABLE rakeback_periods ADD COLUMN deferred_reason text,ADD COLUMN deferred_at timestamptz,ADD COLUMN defer_count integer;ALTER TABLE rakeback_period_payouts ADD COLUMN currency text DEFAULT 'CHIPS',ADD COLUMN failure_reason text,ADD COLUMN created_at timestamptz DEFAULT now();ALTER TABLE wallet_transactions ADD COLUMN created_at timestamptz DEFAULT now();CREATE TABLE tournaments(id uuid,club_id uuid);")
 adapters=(root/'tests/fixtures/stats-financial-reports/bootstrap.sql').read_text()
 for name in ['auth.uid','public.ca_assert_self','public.ca_assert_player_stats_club','public.ca_stats_calendar_bounds']:
  m=re.search(r'CREATE FUNCTION '+re.escape(name)+r'\(.*?\$\$.*?\$\$;',adapters,re.S)
  assert m,name;sql(m.group(0).replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1))
 report_text=sql("BEGIN;SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000301';SELECT ca_player_stats_financial_report(u(301),u(11),NULL,'UTC','chips');COMMIT;")
 report=json.loads(report_text);receipt=report['rakeback']['payout_receipts'][0]
 assert report['rakeback']['paid_amount']==.03 and receipt['wallet_transaction_id']is None
 assert len(receipt['wallet_transactions'])==2 and sum(Decimal(str(t['amount']))for t in receipt['wallet_transactions'])==Decimal('.03')
 sql("BEGIN;SET LOCAL request.jwt.claim.sub='00000000-0000-4000-8000-000000000301';SELECT ca_player_stats_financial_report(u(302),u(11),NULL,'UTC','chips');",'self')
 postimages={r['signature']:sql("SELECT md5(pg_get_functiondef('"+r['signature']+"'::regprocedure))")for r in pre}
 for sig in ['smarter_private.rakeback_payer_plan(jsonb,numeric)','smarter_private.record_rakeback_payer_contracts()','smarter_private.rakeback_certificate_payers(bigint)','smarter_private.split_rakeback_payout_complete(uuid,bigint)']:
  postimages[sig]=sql("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure))")
 sql(candidate,'already exists')
 print(json.dumps({'qualification':'passed','players':5,'total':'0.16','original_mixed_refusal':True,'single_payer_retained':True,'zero_contributor_included':True,'direct_owner_seventy_percent':True,'recognized_cash_and_tournament_sources':True,'real_r3':True,'real_invoice_delivery':10,'deferred_leg_guard':True,'rollback':True,'cached_and_direct_sources':True,'concurrent_original_payments':True,'old_partial_document_refusal':True,'partial_payment_restart_once':True,'original_acl_retained':True,'private_contracts_and_transfers_immutable':True,'actual_C3_evidence_cohort':True,'full_player_report_and_owner_scope':True,'postimages':postimages}))
finally:
 if started:run([a.pg_bin/'pg_ctl','-D',base/'d','-m','immediate','-w','stop'])
 shutil.rmtree(base)
