"""Native original standalone bank funding and immutable weekly-statement contract."""
from pathlib import Path
import argparse,hashlib,json,os,re,subprocess,tempfile
ROOT=Path(__file__).resolve().parents[2]
FX=ROOT/'scripts/ci/fixtures/standalone-weekly-statement-funding'
OLD=ROOT/'tests/fixtures/weekly-close-scale'
MIG=ROOT/'supabase/migrations/20261020174041_standalone_weekly_statement_proves_original_bank_funding.sql'
p=argparse.ArgumentParser();p.add_argument('--pg-bin',default='/opt/homebrew/opt/postgresql@17/bin');p.add_argument('--scratch',type=Path,required=True);p.add_argument('--derive',action='store_true');a=p.parse_args()
a.scratch.mkdir(parents=True,exist_ok=True);pg=Path(a.pg_bin)
def lit(s):return "'"+s.replace("'","''")+"'"
originals=json.loads((FX/'actual-connected-preimages.json').read_text());summary=originals[0]
raw=MIG.read_text();definition=raw.split('$definition$',2)[1];cases=[]
with tempfile.TemporaryDirectory(prefix='sf-',dir=a.scratch) as tmp:
 root=Path(tmp);socket=root/'s';socket.mkdir();data=root/'d'
 env=dict(os.environ,PGHOST=str(socket),PGUSER='postgres',PGDATABASE='postgres',PGSSLMODE='disable')
 def run(cmd,sql=None,refuse=None):
  r=subprocess.run(list(map(str,cmd)),input=sql,text=True,capture_output=True,env=env,timeout=45)
  if refuse:assert r.returncode and refuse in r.stderr,(refuse,r.stdout,r.stderr)
  else:assert r.returncode==0,(r.stdout,r.stderr)
  return r.stdout.strip()
 ps=[pg/'psql','-X','-Atq','-v','ON_ERROR_STOP=1']
 def q(s,refuse=None):return run(ps,s,refuse)
 def js(s):return json.loads(q(s),parse_float=str)
 def report(prefix=''):return js(prefix+"SELECT public.fn_club_weekly_accounting_summary(fixture.u(2));")
 def rec(name):cases.append(name)
 def h():return q("SELECT md5(pg_get_functiondef('fn_club_weekly_accounting_summary(uuid)'::regprocedure));")
 run([pg/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'])
 with (data/'postgresql.conf').open('a') as f:f.write("\ntimezone='UTC'\nlisten_addresses=''\nunix_socket_directories='"+str(socket)+"'\n")
 run([pg/'pg_ctl','-D',data,'-l',root/'server.log','-w','start'])
 try:
  q((OLD/'prelude.sql').read_text());q((OLD/'schema-tables.sql').read_text());q((FX/'setup.sql').read_text())
  q((OLD/'preimage/fn_union_week_start.sql').read_text())
  for item in originals:
   q(item['definition']+';')
   assert q('SELECT md5(pg_get_functiondef('+lit('public.'+item['signature'])+'::regprocedure));')==item['md5'],item['signature']
  q("REVOKE ALL ON FUNCTION fn_club_weekly_accounting_summary(uuid) FROM PUBLIC,anon;GRANT EXECUTE ON FUNCTION fn_club_weekly_accounting_summary(uuid) TO authenticated,service_role;")
  q("CREATE TRIGGER fixture_native_autoledger AFTER INSERT OR UPDATE OF chip_treasury,chip_pool,promo_balance,insurance_balance ON clubs FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger('chip_treasury=club_treasury','chip_pool=club_treasury','promo_balance=promo_wallet','insurance_balance=insurance_bank');CREATE TRIGGER fixture_native_enrich BEFORE INSERT ON chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_ca_chip_ledger_enrich();")
  # All calls use controlled engine claims, not a replacement financial door.
  call="SET request.jwt.claim.role='service_role';SELECT fn_bank_standalone_week_rake(fixture.u(1),'2026-10-12 07:00Z','2026-10-19 07:00Z');"
  bank=js(call);assert str(bank['amount'])=='4078.94' and str(bank['cash_rake'])=='3759.56' and str(bank['tournament_fees'])=='319.38',bank
  assert js(call)['replayed'] is True
  assert q("SELECT count(*)||':'||(SELECT count(*) FROM ca_mint_ledger)||':'||(SELECT chip_treasury FROM clubs WHERE id=fixture.u(1)) FROM chip_ledger WHERE category='mint';")=='1:1:5078.94'
  rec('original_native_bank_fund_autoledger_enrich_register_and_replay')
  old=report("SET request.jwt.claim.role='service_role';");assert str(old['total_rake_funding'])=='0' and str(old['retained_by_club'])=='-204.02' and old['ready_to_issue'] is True,old
  rec('actual_original_summary_reproduces_omitted_4078_94_funding')
  q(definition+';');post=h()
  if a.derive:print(json.dumps({'actual_postimage':post,'old_report':old,'new_report':report("SET request.jwt.claim.role='service_role';")}));raise SystemExit(0)
  assert '__NATIVE_POSTIMAGE__' not in raw and post in raw,'native postimage must be derived and pinned'
  q(summary['definition']+';')
  q(raw.replace(post,'0'*32),'standalone_statement_native_postimage_required');assert h()==summary['md5'];rec('postimage_fault_atomic_rollback')
  # Wrong current producer/metadata/binding refuses without replacing the owner.
  for name,change,error in [
   ('installer_bank_preimage',"ALTER FUNCTION fn_ca_fund_club(uuid,numeric,text,text) SECURITY INVOKER;",'standalone_statement_original_bank_contract_changed'),
   ('installer_acl_preimage','GRANT EXECUTE ON FUNCTION fn_club_weekly_accounting_summary(uuid) TO anon;','standalone_statement_original_authority_changed'),
   ('installer_security_preimage','ALTER FUNCTION fn_club_weekly_accounting_summary(uuid) SECURITY INVOKER;','standalone_statement_original_summary_preimage_changed'),
   ('installer_watchlist_binding',"CREATE OR REPLACE FUNCTION fn_ca_guard_watchlist() RETURNS text[] LANGUAGE sql STABLE AS $$SELECT ARRAY['fn_club_weekly_accounting_summary']::text[]$$;",'standalone_statement_summary_guard_binding_changed')]:
   q('BEGIN;'+change+raw,error);assert h()==summary['md5'];rec(name)
  q(raw);assert h()==post
  q(raw,'standalone_statement_original_summary_preimage_changed');assert h()==post;rec('guarded_install_and_replay_refusal')
  new=report("SET request.jwt.claim.role='service_role';")
  expected={'standalone_rake_funding':'4078.94','total_rake_funding':'4078.94','retained_by_club':'3874.92','total_paid_by_club':'204.02','private_rake_earned':'4078.94','private_rake_burned':'4078.94','private_rake_banked':'0'}
  for k,v in expected.items():assert str(new[k])==v,(k,new[k],v)
  assert new['ready_to_issue'] is True and new['transfer_count']==119 and len(new['standalone_bank_ledger_ids'])==len(new['standalone_bank_mint_ids'])==1,new
  for k,v in old.items():
   if k not in ('total_rake_funding','retained_by_club','note'):assert new[k]==v,(k,new[k],v)
  rec('exact_native_statement_119_paid_receipts_and_private_retirement_preserved')
  # Local transactional faults are never applied to production.
  def fault(name,sql):
   got=report("BEGIN;SET LOCAL request.jwt.claim.role='service_role';"+sql)
   # The isolated psql connection rolls the open transaction back on exit.
   assert got['ready_to_issue'] is False and got['source_issue_count']>0,(name,got)
   rec(name)
  leg="WHERE id=(SELECT chip_ledger_id FROM ca_mint_ledger)"
  for name,sql in [
   ('duplicate_native_lineage',"ALTER TABLE ca_mint_ledger DROP CONSTRAINT ca_mint_ledger_op_id_key;DROP INDEX ca_mint_ledger_chip_leg_uidx;INSERT INTO ca_mint_ledger(op_id,action,asset,holder_type,holder_id,amount,chip_ledger_id) SELECT op_id,action,asset,holder_type,holder_id,amount,chip_ledger_id FROM ca_mint_ledger;"),
   ('wrong_mint_status',"UPDATE chip_ledger SET status='correction' "+leg+';'),
   ('wrong_mint_union','UPDATE chip_ledger SET union_id=fixture.u(500) '+leg+';'),
   ('register_missing_balances','UPDATE ca_mint_ledger SET balance_before=NULL;'),
   ('register_nonfinite_amount',"UPDATE ca_mint_ledger SET amount='NaN';"),
   ('missing_register','DELETE FROM ca_mint_ledger;'),('missing_native_mint','DELETE FROM chip_ledger '+leg+';'),
   ('wrong_mint_key',"UPDATE chip_ledger SET idempotency_key='unrelated' "+leg+';'),
   ('wrong_week_key',"UPDATE chip_ledger SET idempotency_key=replace(idempotency_key,'2026-10-12','2026-10-05') "+leg+';'),
   ('wrong_club','UPDATE chip_ledger SET club_id=fixture.u(999) '+leg+';'),
   ('wrong_mint_category',"UPDATE chip_ledger SET category='transfer' "+leg+';'),
   ('wrong_mint_counterparty',"UPDATE chip_ledger SET from_type='settlement_suspense' "+leg+';'),
   ('wrong_destination','UPDATE chip_ledger SET to_entity_id=fixture.u(999) '+leg+';'),
   ('wrong_mint_amount','UPDATE chip_ledger SET amount=4078.93 '+leg+';'),
   ('wrong_destination_delta','UPDATE chip_ledger SET post_to_balance=5078.93 '+leg+';'),
   ('missing_destination_before','UPDATE chip_ledger SET pre_to_balance=NULL '+leg+';'),
   ('mint_before_week_closed',"UPDATE chip_ledger SET created_at='2026-10-18' "+leg+';'),
   ('register_wrong_key',"UPDATE ca_mint_ledger SET op_id='unrelated';"),
   ('register_wrong_link','UPDATE ca_mint_ledger SET chip_ledger_id=fixture.u(999);'),
   ('register_wrong_action',"UPDATE ca_mint_ledger SET action='burn';"),
   ('register_wrong_asset',"UPDATE ca_mint_ledger SET asset='diamonds';"),
   ('register_wrong_holder',"UPDATE ca_mint_ledger SET holder_type='union';"),
   ('register_wrong_holder_id','UPDATE ca_mint_ledger SET holder_id=fixture.u(999);'),
   ('register_wrong_amount','UPDATE ca_mint_ledger SET amount=4078.93;'),
   ('register_wrong_balances','UPDATE ca_mint_ledger SET balance_before=999;'),
   ('register_wrong_native_producer',"UPDATE ca_mint_ledger SET performed_by_label='other';"),
   ('register_predates_leg',"UPDATE ca_mint_ledger SET created_at='2026-10-19 08:00Z';"),
   ('native_bank_component_disagrees','UPDATE tournament_rake_settlements SET amount=319.37;'),
   ('missing_original_disposition','DELETE FROM accounting_cash_bank_receipts;')]:fault(name,sql)
  # A different valid treasury mint never enters this exact weekly funding.
  unrelated=report("BEGIN;SET LOCAL request.jwt.claim.role='service_role';SELECT fn_ca_fund_club(fixture.u(1),10,'Unrelated treasury funding','unrelated-mint');".replace("SELECT fn_ca_fund_club(fixture.u(1),10,'Unrelated treasury funding','unrelated-mint');","DO $$BEGIN PERFORM fn_ca_fund_club(fixture.u(1),10,'Unrelated treasury funding','unrelated-mint');END$$;"))
  assert unrelated==new;rec('unrelated_original_mint_excluded')
  # Union-coordinated private retirement is still not standalone funding.
  union_scope="""BEGIN;SET LOCAL request.jwt.claim.role='service_role';
UPDATE settlement_periods SET union_id=fixture.u(500);
UPDATE union_accounting_runs SET union_id=fixture.u(500),standalone_club_id=NULL;
UPDATE accounting_routed_settlement_runs SET union_id=fixture.u(500),standalone_club_id=NULL,result=result||jsonb_build_object('scope_kind','union','scope_id',fixture.u(500));
UPDATE accounting_cash_rake_sources SET coordinator_union_id=fixture.u(500);
UPDATE accounting_tournament_fee_sources SET coordinator_union_id=fixture.u(500);
UPDATE chip_ledger SET union_id=fixture.u(500),metadata=metadata||jsonb_build_object('accounting_scope_kind','union','accounting_scope_id',fixture.u(500)) WHERE category='rakeback';
INSERT INTO ca_settlements(settlement_type,external_ref,state,union_id,totals) VALUES('union_rakeback_close',fixture.u(500)::text||':2026-10-12T07:00:00Z..2026-10-19T07:00:00Z','final',fixture.u(500),jsonb_build_object('accounting_version',3,'basis_by_club',jsonb_build_object(fixture.u(1)::text,100),'payout_by_club',jsonb_build_object(fixture.u(1)::text,90)));
INSERT INTO accounting_cash_rake_sources(id,rake_record_id,player_id,club_id,union_id,coordinator_union_id,earned_at,rake_credit,contract) VALUES(fixture.u(501),fixture.u(502),fixture.u(14),fixture.u(1),fixture.u(500),fixture.u(500),'2026-10-17 12:00Z',100,'{}');
INSERT INTO chip_ledger(id,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,metadata) VALUES(fixture.u(503),'union_wallet',fixture.u(500),'club_treasury',fixture.u(1),90,'rakeback',fixture.u(1),fixture.u(500),jsonb_build_object('period_start','2026-10-12T07:00:00Z','period_end','2026-10-19T07:00:00Z'));
INSERT INTO settlement_invoices(club_id,invoice_type,from_entity_type,from_entity_id,to_entity_type,to_entity_id,net_amount,status,chips_transferred,message_sent,source_ledger_id) VALUES(fixture.u(1),'transaction_receipt','union',fixture.u(500)::text,'club',fixture.u(1)::text,90,'paid',true,true,fixture.u(503));
"""
  union_new=report(union_scope)
  union_old=report(union_scope+summary['definition']+';')
  assert union_new['ready_to_issue'] is True and str(union_new['total_rake_funding'])=='90.00' and str(union_new['standalone_rake_funding'])=='0' and str(union_new['private_rake_burned'])=='4078.94',union_new
  for k,v in union_old.items():
   if k!='note':assert union_new[k]==v,(k,union_new[k],v)
  rec('union_90_percent_and_coordinated_private_retirement_unchanged')
  # Zero earning week has no mint requirement; positive missing funding never passes.
  zero=report("BEGIN;SET LOCAL request.jwt.claim.role='service_role';TRUNCATE accounting_cash_rake_sources,accounting_tournament_fee_sources CASCADE;DELETE FROM accounting_cash_bank_receipts;DELETE FROM accounting_tournament_fee_recognitions;DELETE FROM tournament_rake_settlements;DELETE FROM chip_ledger WHERE category='mint';DELETE FROM ca_mint_ledger;")
  assert zero['ready_to_issue'] is True and str(zero['standalone_rake_funding'])=='0',zero;rec('zero_source_week_does_not_invent_funding')
  # Native issuer consumes funding/net without an alternate money path.
  issuance=js("SET request.jwt.claim.role='service_role';SET app.accounting_validated_scope='club:10000000-0000-0000-0000-000000000001:2026-10-12 07:00:00+00:2026-10-19 07:00:00+00';SELECT fn_issue_scope_weekly_accounting('club',fixture.u(1),'2026-10-12 07:00Z','2026-10-19 07:00Z');")
  assert issuance['issued']==1,issuance
  assert q("SELECT gross_amount||':'||net_amount||':'||deductions FROM settlement_invoices WHERE invoice_type='club_weekly_accounting';")=='4078.94:3874.92:204.02'
  frozen=report("BEGIN;SET LOCAL request.jwt.claim.role='service_role';DELETE FROM ca_mint_ledger;");assert frozen==new|{'status':'complete'},frozen;rec('original_issuer_amounts_and_immutable_issued_history')
  assert q("SELECT proacl::text FROM pg_proc WHERE oid='fn_club_weekly_accounting_summary(uuid)'::regprocedure;")=='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
  q("SET ROLE anon;SELECT fn_club_weekly_accounting_summary(NULL);",'permission denied');rec('original_acl_preserved_anon_refused')
  print(json.dumps({'qualification':'passed','actual_old_md5':summary['md5'],'actual_postimage':post,'migration_sha256':hashlib.sha256(MIG.read_bytes()).hexdigest(),'cases':cases,'new_report':new,'limits':'Actual original bank/fund/autoledger/enrich/summary/issuer bodies and captured source/view schema; authorization, quality, epoch, routing, delivery collaborators controlled. Local mint constraints model native uniqueness; complete production issuance policy graph and real R2/R3 producers are not rerun. Production install and full scope receipt still pending.'}))
 finally:run([pg/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
