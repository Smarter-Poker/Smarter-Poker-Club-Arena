#!/usr/bin/env python3
"""Real original calculator, R3 wallet/ledger and invoice transactions on PG17."""
import argparse,concurrent.futures,json,os,re,shutil,socket,subprocess,tempfile
from decimal import Decimal
from pathlib import Path
ap=argparse.ArgumentParser();ap.add_argument('--pg-bin',type=Path,required=True);ap.add_argument('--scratch',type=Path,required=True)
a=ap.parse_args();root=Path(__file__).resolve().parents[2];draft=root/'supabase/accounting/own-agent-v1';base=Path(tempfile.mkdtemp(prefix='own-agent-',dir=a.scratch));started=False
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
 run([a.pg_bin/'pg_ctl','-D',base/'d','-l',base/'log','-o',f"-h 127.0.0.1 -k '' -p {port}",'-w','start']);started=True
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
 sql("CREATE TABLE ca_guard_def_history(id bigserial PRIMARY KEY,proname text NOT NULL,def_hash text NOT NULL,def_text text NOT NULL,captured_at timestamptz NOT NULL DEFAULT now(),UNIQUE(proname,def_hash));CREATE TABLE ca_guard_defs(proname text PRIMARY KEY,def_hash text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),declared_ref text,declared_at timestamptz);")
 for r in json.loads((root/'scripts/ci/fixtures/historical-rakeback-guard-declaration-preimages.json').read_text()):
  sql(r['definition']);assert sql("SELECT md5(pg_get_functiondef('"+r['signature']+"'::regprocedure))")==r['md5']
 sql("SELECT fn_ca_declare_guard_redefinition('fn_ca_settlement_correctness_check','qualified original fixture')")
 for r in json.loads((root/'scripts/ci/fixtures/unpaid-atomic-cash-contract-dependencies.json').read_text())['definitions']:
  if r['signature']=='fn_accounting_agreement_history_immutable()':sql(r['definition'])
 sql("CREATE CONSTRAINT TRIGGER zz_ca_rakeback_payout_leg_is_documented AFTER INSERT ON public.chip_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.status='posted' AND NEW.category='rakeback' AND NEW.to_type='player_wallet') EXECUTE FUNCTION fn_ca_rakeback_payout_leg_is_documented();")

 sql("CREATE TABLE ca_declared_money_triggers(table_name text NOT NULL,trigger_name text NOT NULL,declared_at timestamptz NOT NULL DEFAULT now(),note text,PRIMARY KEY(table_name,trigger_name))")
 # Reuse actual maintained current pricing + immutable payer registration owners.
 sql(next((root/'supabase/migrations').glob('20261019213557_*')).read_text())
 for sig in ['fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])','fn_rakeback_split_write(uuid,date,date,uuid[])','fn_rakeback_split_check(uuid,date,date,uuid[])']:
  d=sql("SELECT pg_get_functiondef('"+sig+"'::regprocedure)")
  sql(d.replace("CASE WHEN p.deal>0 THEN p.deal WHEN p.member_agent IS NOT NULL THEN p.offer","CASE WHEN COALESCE((p.member->>'player_rakeback_explicit')::boolean,false) OR p.deal>0 THEN p.deal WHEN p.member_agent IS NOT NULL THEN p.offer"))
 sql("CREATE FUNCTION fn_platform_frozen()RETURNS boolean LANGUAGE sql AS $$SELECT false$$;")
 sql(next((root/'supabase/migrations').glob('20261021193318_*')).read_text())
 originals={}
 for n,h in [('fn_calculate_cash_rakeback_periods','4a835bd96653c977e5519f6dcfd7a7c6'),('fn_rakeback_split_check','4255ae4df6902f370d13dc69632277bb'),('fn_rakeback_split_write','d7d52bfca1f480a869ca8018efe3a854')]:
  assert sql("SELECT md5(pg_get_functiondef('"+n+"(uuid,date,date,uuid[])'::regprocedure))")==h
  originals[n]=sql("SELECT pg_get_functiondef('"+n+"(uuid,date,date,uuid[])'::regprocedure)")
 # Same controlled full-period evidence prerequisite boundary as maintained fixture.
 sql("CREATE FUNCTION fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)RETURNS jsonb LANGUAGE sql AS $$SELECT '{\"status\":\"ready\"}'::jsonb$$;ALTER TABLE clubs ADD COLUMN union_id uuid DEFAULT u(1);DROP TABLE accounting_rakeback_period_evidence_checkpoints;CREATE TABLE accounting_rakeback_period_evidence_checkpoints(club_id uuid,period_start date,period_end date,horizon timestamptz,clubs_digest text,settled_records bigint,settled_evidence bigint,settled_incomplete bigint,settled_drifted bigint,built_at timestamptz DEFAULT now(),advanced_at timestamptz,advances bigint DEFAULT 0,PRIMARY KEY(club_id,period_start));CREATE FUNCTION fn_accounting_clubs_scope_digest()RETURNS text LANGUAGE sql AS $$SELECT 'isolated-prerequisite'::text$$;CREATE FUNCTION fn_accounting_commit_horizon()RETURNS timestamptz LANGUAGE sql AS $$SELECT now()$$;CREATE FUNCTION fn_ca_launch_accounting_start(text,uuid,timestamptz)RETURNS timestamptz LANGUAGE sql AS $$SELECT $3$$;CREATE FUNCTION fn_ca_launch_rakeback_period_waived(uuid)RETURNS boolean LANGUAGE sql AS $$SELECT false$$;CREATE FUNCTION fn_cash_period_evidence_since(uuid,timestamptz,timestamptz,uuid,timestamptz,timestamptz)RETURNS TABLE(o_evidence bigint,o_incomplete bigint,o_drifted bigint,o_settled_records bigint,o_settled_evidence bigint,o_settled_incomplete bigint,o_settled_drifted bigint)LANGUAGE sql AS $$SELECT 0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint$$;")


 for f in ['destination-contract.sql','typed-receipts.sql','fn_calculate_cash_rakeback_periods.sql','fn_rakeback_split_check.sql','fn_rakeback_split_write.sql']:sql((draft/f).read_text().rstrip()+';')
 def uid(i):return '00000000-0000-4000-8000-'+f'{i:012d}'
 def source(i,player,own=False,role='player',payer=201,rate='.25',deal='.15',rake='1.00',bad=None):
  member={'club_id':uid(11),'user_id':uid(player),'agent_id':uid(payer) if payer else None,'status':'active','is_active':True,'role':role,'player_rakeback_pct':deal}
  agent={'id':uid(8000+i),'club_id':uid(11),'user_id':uid(player if own else payer),'status':'active','role':'agent','player_rakeback_rate':'.15','commission_rate':rate}
  direct={'agent_id':agent['id'],'depth':1,'role':agent['role'],'rake_basis':rake,'remaining_basis':rake,'amount':str((Decimal(rake)*Decimal(rate)).quantize(Decimal('.01'))),'rate':rate,'user_id':agent['user_id'],'agreement':{'history_id':1000+i,'terms':agent}}
  if bad:direct.update(bad)
  contract={'membership':{'history_id':i,'terms':member},'tiers':[direct]}
  def j(x):return json.dumps(x).replace("'","''")
  sql("INSERT INTO accounting_agreement_history VALUES("+str(i)+",'club_members','"+uid(11)+":"+uid(player)+"','2026-09-01','"+j(member)+"'),("+str(1000+i)+",'agents','"+agent['id']+"','2026-09-01','"+j(agent)+"');INSERT INTO accounting_cash_rake_sources VALUES(u("+str(4000+i)+"),u("+str(5000+i)+"),u("+str(player)+"),u(11),u(1),u(1),'2026-09-08',"+rake+",'"+j(contract)+"');")

 source(1,401,True,'agent');source(2,402,False);source(3,402,True,'agent');source(4,403,False);source(5,404,True,'agent',None);source(6,405,True,'sub_agent')
 sql("INSERT INTO accounting_tournament_fee_sources SELECT id,rake_record_id,u(806),player_id,club_id,union_id,coordinator_union_id,earned_at,rake_credit,contract FROM accounting_cash_rake_sources WHERE id=u(4006);DELETE FROM accounting_cash_rake_sources WHERE id=u(4006);INSERT INTO accounting_tournament_fee_recognitions VALUES(u(806),'2026-09-09','recognized',1,u(1));INSERT INTO accounting_tournament_recognized_sources VALUES(u(4006),u(806),'2026-09-09','earned',1);")
 def owner_source(i,role):
  m={'club_id':uid(11),'user_id':uid(406),'agent_id':uid(901),'status':'active','is_active':True,'role':role,'player_rakeback_pct':'.70'}
  contract={'membership':{'history_id':i,'terms':m},'tiers':[]}
  sql("INSERT INTO accounting_agreement_history VALUES("+str(i)+",'club_members','"+uid(11)+":"+uid(406)+"','2026-09-01','"+json.dumps(m)+"');INSERT INTO accounting_cash_rake_sources VALUES(u("+str(4000+i)+"),u("+str(5000+i)+"),u(406),u(11),u(1),u(1),'2026-09-08',1,'"+json.dumps(contract)+"');")
 owner_source(7,'player');owner_source(8,'agent')
 own={'id':uid(8008),'club_id':uid(11),'user_id':uid(406),'role':'agent','status':'active','commission_rate':'.25','player_rakeback_rate':'.15'}
 sql("INSERT INTO accounting_agreement_history VALUES(1008,'agents','"+own['id']+"','2026-09-01','"+json.dumps(own)+"');INSERT INTO club_members(club_id,user_id,chip_balance,role,status)SELECT u(11),u(n),0,'player','active'FROM unnest(ARRAY[401,402,403,404,405,406])n;")
 sql("ALTER TABLE accounting_agreement_history ADD COLUMN club_id uuid,ADD COLUMN subject_user_id uuid,ADD COLUMN transaction_id bigint DEFAULT 1;UPDATE accounting_agreement_history SET club_id=(after_terms->>'club_id')::uuid,subject_user_id=(after_terms->>'user_id')::uuid;")
 authority=json.loads((root/'scripts/qualification/own-agent-v1/original-owners.json').read_text())
 for r in authority:
  if r['signature'].split('(')[0]in ['fn_accounting_agent_terms_at','fn_accounting_terms_at']:sql(r['definition'].rstrip()+';')
 assert json.loads(sql("SELECT fn_rakeback_split_check(u(11),'2026-09-07','2026-09-13',ARRAY[u(401),u(402),u(403),u(404),u(405),u(406)])"))['players']==6
 sql("SELECT fn_rakeback_split_write(u(11),'2026-09-07','2026-09-13',ARRAY[u(401),u(402),u(403),u(404),u(405),u(406)])")
 assert sql("SELECT rakeback_amount=0 FROM rakeback_periods WHERE user_id=u(401)")=='t'
 assert sql("SELECT rakeback_amount=.15 FROM rakeback_periods WHERE user_id=u(402)")=='t'
 assert sql("SELECT rakeback_amount=1.40 FROM rakeback_periods WHERE user_id=u(406)")=='t'
 assert sql("SELECT count(*)=2 AND sum(amount)=1.40 AND count(DISTINCT destination_kind)=2 AND bool_and(payer_kind='club' AND payer_user_id IS NULL) FROM accounting_rakeback_wallet_contracts")=='t'
 assert sql("SELECT count(*)=0 FROM chip_ledger")=='t'
 assert json.loads(sql("SELECT fn_calculate_cash_rakeback_periods(u(11),'2026-09-07','2026-09-13',ARRAY[u(401),u(402),u(403),u(404),u(405),u(406)])"))['confirmed_players']==6
 assert sql("SELECT jsonb_array_length(source_allocations)=2 AND (source_allocations->0->>'destination_kind')IS NULL AND source_allocations->1->>'destination_kind'='agent_wallet'FROM accounting_rakeback_period_calculations WHERE player_id=u(406)ORDER BY id DESC LIMIT 1")=='t'
 print(json.dumps({'status':'pricing_passed','synthetic_players':6,'mixed_promotion_destination_legs':2,'historical_lookup':'actual current owning functions','boundary':'full-period source prerequisites controlled; payment path qualified separately'}))
finally:
 if started:run([a.pg_bin/'pg_ctl','-D',base/'d','-m','immediate','-w','stop'])
 shutil.rmtree(base)
