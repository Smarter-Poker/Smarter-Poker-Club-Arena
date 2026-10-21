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
 sql("CREATE TABLE ca_guard_def_history(id bigserial PRIMARY KEY,proname text NOT NULL,def_hash text NOT NULL,def_text text NOT NULL,captured_at timestamptz NOT NULL DEFAULT now(),UNIQUE(proname,def_hash));CREATE TABLE ca_guard_defs(proname text PRIMARY KEY,def_hash text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),declared_ref text,declared_at timestamptz);")
 for r in json.loads((root/'scripts/ci/fixtures/historical-rakeback-guard-declaration-preimages.json').read_text()):
  sql(r['definition']);assert sql("SELECT md5(pg_get_functiondef('"+r['signature']+"'::regprocedure))")==r['md5']
 sql("SELECT fn_ca_declare_guard_redefinition('fn_ca_settlement_correctness_check','qualified original fixture')")
 for r in json.loads((root/'scripts/ci/fixtures/unpaid-atomic-cash-contract-dependencies.json').read_text())['definitions']:
  if r['signature']=='fn_accounting_agreement_history_immutable()':sql(r['definition'])
 sql("CREATE CONSTRAINT TRIGGER zz_ca_rakeback_payout_leg_is_documented AFTER INSERT ON public.chip_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.status='posted' AND NEW.category='rakeback' AND NEW.to_type='player_wallet') EXECUTE FUNCTION fn_ca_rakeback_payout_leg_is_documented();")
 # Source records represent two earning-time agents, an agent/club change,
 # and an unchanged payer. The .015 products expose double rounding.
 for i,player,payer,rake in [(1,301,201,'.10'),(2,301,202,'.10'),(3,302,201,'.10'),(4,302,None,'.30'),(5,303,201,'.10'),(6,303,201,'.10'),(7,304,201,'.10'),(8,304,202,'.10'),(9,305,901,'.10')]:
  member={'club_id':'00000000-0000-4000-8000-000000000011','user_id':f'00000000-0000-4000-8000-{player:012d}','agent_id':f'00000000-0000-4000-8000-{payer:012d}'if payer else None,'status':'active','is_active':True,'player_rakeback_pct':.15 if payer else 0}
  agent={'club_id':member['club_id'],'user_id':member['agent_id'],'status':'active','player_rakeback_rate':.15,'commission_rate':.25}
  contract={'membership':{'history_id':i,'terms':member},'tiers':[{'depth':1,'rate':.25,'user_id':member['agent_id'],'agreement':{'history_id':100+i,'terms':agent}}]if payer else []}
  if player==304:member['player_rakeback_pct']=0;member['player_rakeback_explicit']=True
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
 assert sql("SELECT def_hash=md5(pg_get_functiondef('public.fn_ca_settlement_correctness_check()'::regprocedure)) AND declared_ref='migration 20261019213557_weekly_rakeback_preserves_every_historical_payer_share' FROM ca_guard_defs WHERE proname='fn_ca_settlement_correctness_check'")=='t'
 assert sql("SELECT count(*)FROM ca_guard_def_history WHERE proname='fn_ca_settlement_correctness_check'")=='2'
 for sig,acl in original_acl.items():assert sql("SELECT proacl::text FROM pg_proc WHERE oid='"+sig+"'::regprocedure")==acl
 # Preserve the currently installed explicit-zero agreement predicate in all three original owners.
 for explicit_signature in ['fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])','fn_rakeback_split_write(uuid,date,date,uuid[])','fn_rakeback_split_check(uuid,date,date,uuid[])']:
  explicit_definition=sql("SELECT pg_get_functiondef('"+explicit_signature+"'::regprocedure)")
  assert explicit_definition.count("CASE WHEN p.deal>0 THEN p.deal WHEN p.member_agent IS NOT NULL THEN p.offer")==1
  sql(explicit_definition.replace("CASE WHEN p.deal>0 THEN p.deal WHEN p.member_agent IS NOT NULL THEN p.offer","CASE WHEN COALESCE((p.member->>'player_rakeback_explicit')::boolean,false) OR p.deal>0 THEN p.deal WHEN p.member_agent IS NOT NULL THEN p.offer"))
 assert sql("SELECT md5(pg_get_functiondef('fn_rakeback_split_check(uuid,date,date,uuid[])'::regprocedure))")=='4255ae4df6902f370d13dc69632277bb'
 check=json.loads(sql("SELECT fn_rakeback_split_check(u(11),'2026-09-07','2026-09-13',NULL)"));assert check['players']==5
 sql("SELECT fn_rakeback_split_write(u(11),'2026-09-07','2026-09-13',NULL)")
 assert sql('SELECT sum(rakeback_amount)FROM rakeback_periods')=='0.16'
 assert sql("SELECT rakeback_amount=0 AND rake_generated=.20 FROM rakeback_periods WHERE user_id=u(304)")=='t','explicit zero must not inherit either historical agent offer'
 assert sql("SELECT count(*)FROM accounting_rakeback_period_calculations WHERE payer_kind='split'")=='3'
 # Reproduce unchanged legacy certificates that predate the payer trigger.
 sql("ALTER TABLE accounting_rakeback_payer_contracts DISABLE TRIGGER accounting_rakeback_payer_contract_immutable;DELETE FROM accounting_rakeback_payer_contracts;ALTER TABLE accounting_rakeback_payer_contracts ENABLE TRIGGER accounting_rakeback_payer_contract_immutable;")
 cert_before=sql("SELECT md5(jsonb_agg(to_jsonb(c)ORDER BY id)::text)FROM accounting_rakeback_period_calculations c")
 sql("SELECT fn_rakeback_split_write(u(11),'2026-09-07','2026-09-13',NULL)")
 assert sql('SELECT count(*)FROM accounting_rakeback_payer_contracts')=='0','old shortcut unexpectedly admitted receipts'
 migration=next((root/'supabase/migrations').glob('20261021172808_*')).read_text()
 source_only=migration
 sql("CREATE FUNCTION fn_platform_frozen()RETURNS boolean LANGUAGE sql AS $$SELECT COALESCE(current_setting('test.confirmed_frozen',true),'')='on'$$;")
 sql("BEGIN;SET LOCAL test.confirmed_frozen='on';"+source_only,'confirmed_payer_install_frozen')
 assert sql("SELECT to_regprocedure('smarter_private.ensure_rakeback_payer_contracts(bigint)')IS NULL")=='t'
 wrong_preimage=source_only.replace("IS DISTINCT FROM 'fa6d2e8eac30dc1f7e19431d461e9826'","IS DISTINCT FROM '00000000000000000000000000000000'",1)
 assert wrong_preimage!=source_only
 sql(wrong_preimage,'confirmed_payer_preimage_changed')
 assert sql("SELECT to_regprocedure('smarter_private.ensure_rakeback_payer_contracts(bigint)')IS NULL")=='t'
 sql(source_only)
 assert sql("SELECT has_function_privilege('service_role','smarter_private.ensure_rakeback_payer_contracts(bigint)','EXECUTE')")=='f'
 # Deployment identities are finite immutable data. In isolation replace ONLY
 # the 130 production manifest literal with the five actual fixture certificates;
 # the entire private native validator/transition body remains unchanged.
 legacy_original_hash=sql("SELECT md5(pg_get_functiondef('smarter_private.admit_legacy_rakeback_payer_contracts(bigint[])'::regprocedure))")
 legacy_original=sql("SELECT pg_get_functiondef('smarter_private.admit_legacy_rakeback_payer_contracts(bigint[])'::regprocedure)")
 local_manifest=sql("SELECT jsonb_agg(jsonb_build_object('id',c.id,'certificate_md5',md5(to_jsonb(c)::text),'club_id',c.club_id,'player_id',c.player_id,'period_start',c.period_start,'period_end',c.period_end,'source_fingerprint',c.source_fingerprint,'expected_plan_text',smarter_private.rakeback_payer_plan(c.source_allocations,c.rakeback_amount)::text)ORDER BY c.id)FROM accounting_rakeback_period_calculations c")
 manifest_match=re.search(r"expected jsonb:='(.*?)'::jsonb",legacy_original,re.S);assert manifest_match
 fixture_legacy=legacy_original[:manifest_match.start(1)]+local_manifest.replace("'","''")+legacy_original[manifest_match.end(1):]
 sql(fixture_legacy)
 assert sql("SELECT has_function_privilege('service_role','smarter_private.admit_legacy_rakeback_payer_contracts(bigint[])','EXECUTE')")=='f'
 ids=sql('SELECT array_agg(id ORDER BY id)::text FROM accounting_rakeback_period_calculations')
 admission="SELECT smarter_private.admit_legacy_rakeback_payer_contracts('"+ids+"'::bigint[]);"
 sql("SELECT smarter_private.admit_legacy_rakeback_payer_contracts(ARRAY[999999]::bigint[])",'legacy_payer_admission_identity_not_qualified')
 sql("SELECT smarter_private.admit_legacy_rakeback_payer_contracts(ARRAY[(SELECT min(id)FROM accounting_rakeback_period_calculations),(SELECT min(id)FROM accounting_rakeback_period_calculations)])",'legacy_payer_admission_identity_not_qualified')
 sql("BEGIN;DELETE FROM accounting_agreement_history;"+admission,'legacy_payer_original_sources_not_verified')
 assert sql('SELECT count(*)FROM accounting_rakeback_payer_contracts')=='0'
 sql("BEGIN;"+admission+"DO $$BEGIN RAISE EXCEPTION 'qualified_legacy_admission_rollback';END$$;",'qualified_legacy_admission_rollback')
 assert sql('SELECT count(*)FROM accounting_rakeback_payer_contracts')=='0'
 with concurrent.futures.ThreadPoolExecutor(max_workers=2)as pool:
  futures=[pool.submit(sql,admission)for _ in range(2)]
  for future in futures:future.result()
 assert sql('SELECT count(*)FROM accounting_rakeback_payer_contracts')=='8'
 # Restore missing legacy fixture again to exercise the actual writer path.
 sql("ALTER TABLE accounting_rakeback_payer_contracts DISABLE TRIGGER accounting_rakeback_payer_contract_immutable;DELETE FROM accounting_rakeback_payer_contracts;ALTER TABLE accounting_rakeback_payer_contracts ENABLE TRIGGER accounting_rakeback_payer_contract_immutable;")
 # Actual original source check provides the legacy full historical validation.
 validated=json.loads(sql("SELECT fn_rakeback_split_check(u(11),'2026-09-07','2026-09-13',NULL)"));assert validated['players']==5 and validated['same']==5,validated
 sql("BEGIN;SELECT fn_rakeback_split_write(u(11),'2026-09-07','2026-09-13',NULL);DO $$BEGIN IF(SELECT count(*)FROM accounting_rakeback_payer_contracts)=0 THEN RAISE EXCEPTION 'no payer admission';END IF;RAISE EXCEPTION 'qualified_legacy_receipt_rollback';END$$;",'qualified_legacy_receipt_rollback')
 assert sql('SELECT count(*)FROM accounting_rakeback_payer_contracts')=='0'
 sql("SELECT fn_rakeback_split_write(u(11),'2026-09-07','2026-09-13',NULL)")
 assert sql('SELECT count(*)FROM accounting_rakeback_payer_contracts')=='8'
 assert sql("SELECT md5(jsonb_agg(to_jsonb(c)ORDER BY id)::text)FROM accounting_rakeback_period_calculations c")==cert_before
 payer_before=sql("SELECT md5(jsonb_agg(to_jsonb(c)ORDER BY calculation_id,payer_kind,payer_entity_id)::text)FROM accounting_rakeback_payer_contracts c")
 sql("SELECT fn_rakeback_split_write(u(11),'2026-09-07','2026-09-13',NULL)")
 assert sql("SELECT md5(jsonb_agg(to_jsonb(c)ORDER BY calculation_id,payer_kind,payer_entity_id)::text)FROM accounting_rakeback_payer_contracts c")==payer_before
 assert sql('SELECT count(*)FROM chip_ledger')=='0' and sql('SELECT count(*)FROM wallet_transactions')=='0' and sql('SELECT count(*)FROM rakeback_period_payouts')=='0'
 # Private helper refuses conflicting immutable contracts rather than repairing them.
 sql("BEGIN;ALTER TABLE accounting_rakeback_payer_contracts DISABLE TRIGGER accounting_rakeback_payer_contract_immutable;UPDATE accounting_rakeback_payer_contracts SET amount=amount+.01;SELECT smarter_private.ensure_rakeback_payer_contracts((SELECT min(id)FROM accounting_rakeback_period_calculations));",'existing_rakeback_payer_contract_disagrees')
 sql("BEGIN;DELETE FROM accounting_agreement_history;SELECT fn_rakeback_split_write(u(11),'2026-09-07','2026-09-13',NULL);",'period_membership_contract_invalid')
 sql(source_only,'already exists')
 # Explicit unrelated full-period evidence gates: these do not qualify cash
 # conservation. The real SECURITY DEFINER full calculator and its unchanged
 # certificate branch execute against the same immutable source fixture.
 sql("CREATE FUNCTION fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)RETURNS jsonb LANGUAGE sql AS $$SELECT '{\"status\":\"ready\"}'::jsonb$$;ALTER TABLE clubs ADD COLUMN union_id uuid DEFAULT u(1);DROP TABLE accounting_rakeback_period_evidence_checkpoints;CREATE TABLE accounting_rakeback_period_evidence_checkpoints(club_id uuid,period_start date,period_end date,horizon timestamptz,clubs_digest text,settled_records bigint,settled_evidence bigint,settled_incomplete bigint,settled_drifted bigint,built_at timestamptz DEFAULT now(),advanced_at timestamptz,advances bigint DEFAULT 0,PRIMARY KEY(club_id,period_start));CREATE FUNCTION fn_accounting_clubs_scope_digest()RETURNS text LANGUAGE sql AS $$SELECT 'isolated-prerequisite'::text$$;CREATE FUNCTION fn_accounting_commit_horizon()RETURNS timestamptz LANGUAGE sql AS $$SELECT now()$$;CREATE FUNCTION fn_ca_launch_accounting_start(text,uuid,timestamptz)RETURNS timestamptz LANGUAGE sql AS $$SELECT $3$$;CREATE FUNCTION fn_ca_launch_rakeback_period_waived(uuid)RETURNS boolean LANGUAGE sql AS $$SELECT false$$;CREATE FUNCTION fn_cash_period_evidence_since(uuid,timestamptz,timestamptz,uuid,timestamptz,timestamptz)RETURNS TABLE(o_evidence bigint,o_incomplete bigint,o_drifted bigint,o_settled_records bigint,o_settled_evidence bigint,o_settled_incomplete bigint,o_settled_drifted bigint)LANGUAGE sql AS $$SELECT 0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint$$;")
 sql("ALTER TABLE accounting_rakeback_payer_contracts DISABLE TRIGGER accounting_rakeback_payer_contract_immutable;DELETE FROM accounting_rakeback_payer_contracts;ALTER TABLE accounting_rakeback_payer_contracts ENABLE TRIGGER accounting_rakeback_payer_contract_immutable;")
 full_result=json.loads(sql("SELECT fn_calculate_cash_rakeback_periods(u(11),'2026-09-07','2026-09-13',ARRAY[u(301),u(302),u(303),u(304),u(305)])"))
 assert full_result['status']=='ready' and full_result['confirmed_players']==5,full_result
 assert sql('SELECT count(*)FROM accounting_rakeback_payer_contracts')=='8'
 # Existing paid-period refusal precedes every legitimate certificate INSERT.
 paid_result=json.loads(sql("BEGIN;UPDATE rakeback_periods SET status='paid';SELECT fn_calculate_cash_rakeback_periods(u(11),'2026-09-07','2026-09-13',ARRAY[u(301),u(302),u(303),u(304),u(305)]);ROLLBACK;"))
 assert paid_result['reason']=='legacy_or_paid_period_requires_reconciliation',paid_result
 sql("BEGIN;UPDATE rakeback_periods SET status='paid';SELECT fn_rakeback_split_write(u(11),'2026-09-07','2026-09-13',NULL);",'certified_period_drift_requires_reconciliation')
 # The real INSERT trigger delegates to the same owner without changing
 # old certificates or using the current membership/agent hierarchy.
 sql("INSERT INTO accounting_rakeback_period_calculations(period_id,source_fingerprint,club_id,player_id,coordinator_union_id,period_start,period_end,rake_generated,rakeback_amount,display_rate,payer_kind,payer_user_id,source_allocations)SELECT period_id,source_fingerprint,club_id,player_id,coordinator_union_id,period_start,period_end,rake_generated,rakeback_amount,display_rate,payer_kind,payer_user_id,source_allocations FROM accounting_rakeback_period_calculations ORDER BY id LIMIT 1")
 assert sql("SELECT count(*)FROM accounting_rakeback_payer_contracts WHERE calculation_id=(SELECT max(id)FROM accounting_rakeback_period_calculations)")!='0'
 sql("SET ROLE service_role;SELECT smarter_private.ensure_rakeback_payer_contracts(1);",'permission denied')
 sql("SET ROLE service_role;SELECT smarter_private.admit_legacy_rakeback_payer_contracts(ARRAY[1]::bigint[]);",'permission denied')
 sql("SELECT smarter_private.admit_legacy_rakeback_payer_contracts(ARRAY[]::bigint[]);",'legacy_payer_admission_identity_not_qualified')
 sql("SELECT smarter_private.admit_legacy_rakeback_payer_contracts(array_fill(1::bigint,ARRAY[17]));",'legacy_payer_admission_identity_not_qualified')
 post={r['signature']:sql("SELECT md5(pg_get_functiondef('"+r['signature']+"'::regprocedure))")for r in json.loads((root/'scripts/ci/fixtures/confirmed-rakeback-payer-preimages.json').read_text())}
 post['smarter_private.admit_legacy_rakeback_payer_contracts(bigint[])']=legacy_original_hash
 post['smarter_private.ensure_rakeback_payer_contracts(bigint)']=sql("SELECT md5(pg_get_functiondef('smarter_private.ensure_rakeback_payer_contracts(bigint)'::regprocedure))")
 print(json.dumps({'qualification':'passed','actual_original_splitwrite_fail_before':True,'unchanged_certificate_admission':True,'full_immutable_source_history_check':True,'all_existing_payer_contracts_preserved':True,'no_financial_writes':True,'rollback':True,'replay_refused':True,'conflicting_contract_refused':True,'source_history_missing_refused':True,'private_acl':True,'actual_full_security_definer_calculator':True,'original_paid_period_refusal_preserved':True,'unrelated_fullperiod_evidence_gates_stubbed':True,'native_batched_legacy_admission':True,'concurrent_admission_once':True,'invalid_duplicate_id_refused':True,'postimages':post}))
finally:
 if started:run([a.pg_bin/'pg_ctl','-D',base/'d','-m','immediate','-w','stop'])
 shutil.rmtree(base)
