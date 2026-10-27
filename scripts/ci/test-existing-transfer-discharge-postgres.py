#!/usr/bin/env python3
"""Existing owner-confirmed sends discharge the same certified week once.

Native PostgreSQL17 exact migration rollback/install/postimage/ACL qualification;
actual original main/cached/v3 R2 and R3, original invoice/transfer-document owners,
concurrent commits, replay and financial conservation. Notification transport is
an isolated native adapter. Positive direct-player liability from the commission
subject is deliberately refused pending net-discharge support. No production access.
Financial rollback probes force SET CONSTRAINTS ALL IMMEDIATE before ROLLBACK.
"""
import argparse, concurrent.futures, json, os, shutil, socket, subprocess, sys, tempfile, time
from pathlib import Path
from decimal import Decimal

P=argparse.ArgumentParser()
P.add_argument('--repo',type=Path,default=Path(__file__).resolve().parents[2])
P.add_argument('--pg-bin',type=Path,default=Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin')))
P.add_argument('--scratch-root',type=Path,default=Path(os.environ.get('RUNNER_TEMP',tempfile.gettempdir())))
P.add_argument('--output',type=Path,default=None)
A=P.parse_args()
R=A.repo; F=R/'scripts/ci/fixtures/commission-agent-wallet'; BASE=R/'tests/fixtures/weekly-close-scale'; DR=R/'scripts/ci/fixtures/deleted-weekly-routing'
MIG=next((R/'supabase/migrations').glob('20261022164439_*.sql'))
E={k:v for k,v in os.environ.items() if not k.startswith('PG')};E.update(LC_ALL='C',LANG='C',PGTZ='UTC')
os.environ.update(LC_ALL='C',LANG='C')
A.scratch_root.mkdir(parents=True,exist_ok=True)
W=Path(tempfile.mkdtemp(prefix='caw-',dir=A.scratch_root));D=W/'data';started=False;results=[]
with socket.socket() as sk: sk.bind(('127.0.0.1',0)); port=str(sk.getsockname()[1])
def cmd(a): return subprocess.run(list(map(str,a)),env=E,text=True,capture_output=True,check=True,timeout=120)
def q(sql,check=True):
    with tempfile.TemporaryFile(mode='w+',dir=W) as f:
        f.write(sql); f.seek(0)
        r=subprocess.run([str(A.pg_bin/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-h','127.0.0.1','-p',port,'-d','postgres'],env=E,text=True,stdin=f,capture_output=True,timeout=300)
    if check and r.returncode: raise RuntimeError(r.stderr[-6000:])
    return r
def load(p): q('SET check_function_bodies=off;\n'+Path(p).read_text().rstrip()+';\n')
R2="public.fn_settle_accounting_commission_stage('club',caw_u('club'),'2026-10-05 07:00+00','2026-10-12 07:00+00')"
R2V3=R2.replace('commission_stage(','commission_stage_v3(')
R3="public.fn_settle_accounting_rakeback_stage('club',caw_u('club'),'2026-10-05 07:00+00','2026-10-12 07:00+00')"
def bal(who,col='chip_balance'):
    t='club_members' if col=='chip_balance' else 'agents'
    return f"(SELECT {col} FROM public.{t} WHERE club_id=caw_u('club') AND user_id=caw_u('{who}'))"
BANK="(SELECT chip_treasury FROM public.clubs WHERE id=caw_u('club'))"
def case(name,sql,refusal=None):
    before=q('SELECT caw_money();').stdout.strip()
    r=q('BEGIN;\nSELECT caw_seed('+('true' if 'deleted' in name else 'false')+');\nCREATE TEMP TABLE caw_open AS SELECT caw_balances() b;CREATE TEMP TABLE caw_open_legs AS SELECT id FROM public.chip_ledger;\n'+sql+
        ('\nSELECT caw_assert_conserved((SELECT b FROM caw_open));\nSET CONSTRAINTS ALL IMMEDIATE;' if not refusal else '')+'\nROLLBACK;\n',check=False)
    if refusal: assert r.returncode and refusal in r.stderr,(name,r.stdout[-2000:],r.stderr[-4000:])
    else: assert r.returncode==0,(name,r.stdout[-2000:],r.stderr[-6000:])
    assert q('SELECT caw_money();').stdout.strip()==before,(name,'rolled-back case changed financial rows')
    results.append({'case':name,'passed':True,'expected_refusal':refusal})
    print('PASS',name,flush=True)
try:
    assert '17.' in cmd([A.pg_bin/'postgres','--version']).stdout,'PostgreSQL 17 required'
    cmd([A.pg_bin/'initdb','-D',D,'-U','postgres','-A','trust','--no-locale','-E','UTF8'])
    cmd([A.pg_bin/'pg_ctl','-D',D,'-l',W/'server.log','-w','start','-o',f"-k '' -p {port} -h 127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off"]);started=True
    load(BASE/'prelude.sql');load(BASE/'schema-tables.sql');load(DR/'platform-boundaries.sql')
    q("DROP FUNCTION public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamptz,timestamptz);")
    for n in ['fn_caller_is_engine','fn_union_week_start','fn_lock_rakeback_payer_clubs','fn_resolve_accounting_routing_scope','fn_agent_commission_rollup_recompute']: load(BASE/'preimage'/f'{n}.sql')
    for n in ['fn_guard_membership_lifecycle_write','fn_block_browser_balance_writes','fn_club_members_ledger_writer','fn_ca_declare_ledger','fn_ca_chip_ledger_enrich','fn_calculate_cash_rakeback_periods','fn_rakeback_split_write']: load(DR/f'{n}.sql')
    load(F/'schema.sql')
    pre=json.loads((F/'live-preimages-20261022.json').read_text())
    for row in pre:
        q('SET check_function_bodies=off;'+row['definition']+';')
        got=q(f"SELECT md5(pg_get_functiondef('{row['signature']}'::regprocedure));").stdout.strip()
        assert got==row['md5'],('live preimage did not load byte-exact',row['signature'],got)
        q(f"REVOKE ALL ON FUNCTION {row['signature']} FROM PUBLIC,anon,authenticated,service_role;"+(f"GRANT EXECUTE ON FUNCTION {row['signature']} TO service_role;" if row['acl'] and 'service_role=X' in row['acl'] else ''))
    load(F/'triggers.sql');load(DR/'ledger-enrichment-wiring.sql');load(DR/'authority-and-triggers.sql');load(DR/'receipt-boundary.sql');load(F/'seed.sql')
    q('SET check_function_bodies=off;'+MIG.read_text())
    for row in json.loads((R/'scripts/ci/fixtures/existing-transfer-discharge/original-owners.json').read_text()):
        q('SET check_function_bodies=off;'+row['definition'])
    q("ALTER TABLE chip_transactions ADD COLUMN is_reversed boolean DEFAULT false,ADD COLUMN clawed_back boolean DEFAULT false,ADD COLUMN reversible_until timestamptz;CREATE TABLE cashier_rpc_operation_intents(operation_id uuid PRIMARY KEY,actor_user_id uuid,action text,club_id uuid,operation_intent jsonb,intent_fingerprint text,receipt jsonb,created_at timestamptz DEFAULT now(),completed_at timestamptz);CREATE TABLE ca_declared_money_triggers(table_name text,trigger_name text,note text,PRIMARY KEY(table_name,trigger_name));")
    for row in json.loads((R/'scripts/ci/fixtures/unpaid-atomic-cash-contract-dependencies.json').read_text())['definitions']:
        if row['signature']=='fn_accounting_agreement_history_immutable()':q(row['definition'])
    q("DROP TRIGGER wcs_receipt ON chip_ledger;ALTER TABLE agents ADD COLUMN role text DEFAULT 'agent';CREATE TABLE union_wallets(id uuid,union_id uuid);CREATE TABLE accounting_correction_documents(id uuid,source_ledger_id uuid,invoice_id uuid,club_id uuid,issuer_type text,issuer_id uuid,payee_type text,payee_id uuid,amount numeric,issued_at timestamptz);CREATE FUNCTION fn_ca_launch_is_internal_transfer(uuid)RETURNS boolean LANGUAGE sql AS $$SELECT false$$;")
    q("CREATE FUNCTION fn_deliver_accounting_invoice(p_id uuid)RETURNS void LANGUAGE plpgsql AS $$DECLARE i settlement_invoices%ROWTYPE;msg uuid;note uuid;BEGIN IF current_setting('dr.refuse_invoice',true)='on'THEN RETURN;END IF;SELECT * INTO i FROM settlement_invoices WHERE id=p_id;IF i.message_sent THEN RETURN;END IF;IF current_setting('ed.pause_woo_invoice',true)='on'AND EXISTS(SELECT FROM chip_ledger l WHERE l.id=i.source_ledger_id AND l.metadata->>'beneficiary_id'=caw_u('P3')::text AND l.metadata->>'payment_method'='owner_confirmed_existing_transfer')THEN PERFORM pg_advisory_xact_lock(8934254);END IF;INSERT INTO social_messages(content,message_type,media_metadata)VALUES('receipt','invoice',jsonb_build_object('invoice_id',i.id))RETURNING id INTO msg;INSERT INTO notifications(user_id,type,title,data,metadata)VALUES(i.to_entity_id::uuid,'accounting_invoice','Invoice',jsonb_build_object('invoice_id',i.id),jsonb_build_object('invoice_id',i.id))RETURNING id INTO note;INSERT INTO accounting_invoice_deliveries(invoice_id,recipient_id,message_id,notification_id)VALUES(i.id,i.to_entity_id::uuid,msg,note);UPDATE settlement_invoices SET message_sent=true WHERE id=i.id;END$$;")
    load(R/'scripts/ci/fixtures/existing-transfer-discharge/original-ledger-invoice.sql')
    load(R/'scripts/ci/fixtures/existing-transfer-discharge/original-transfer-document.sql')
    q("CREATE TRIGGER actual_accounting_transfer_document AFTER INSERT ON chip_ledger FOR EACH ROW WHEN(NEW.status='posted'AND NEW.from_type IN('club_treasury','player_wallet','agent_wallet')AND NEW.to_type IN('club_treasury','player_wallet','agent_wallet'))EXECUTE FUNCTION fn_accounting_transfer_document_on_insert();")
    q("CREATE TABLE accounting_period_recompute_requests(id uuid DEFAULT gen_random_uuid(),club_id uuid,period_start date,period_end date,status text,last_requested_at timestamptz,attempted_at timestamptz,last_result jsonb,UNIQUE(club_id,period_start,period_end));ALTER TABLE accounting_cash_rake_sources ADD COLUMN IF NOT EXISTS recorded_at timestamptz;ALTER TABLE accounting_cash_rake_sources ALTER COLUMN recorded_at SET DEFAULT '2026-10-06';ALTER TABLE accounting_tournament_fee_sources ADD COLUMN IF NOT EXISTS recorded_at timestamptz;ALTER TABLE accounting_tournament_fee_sources ALTER COLUMN recorded_at SET DEFAULT '2026-10-06';CREATE TABLE accounting_cash_atomic_contract_admissions(source_id uuid,admitted_at timestamptz);CREATE TABLE accounting_cash_funding_contract_admissions(source_id uuid,funding_club_id uuid,admitted_at timestamptz);")
    for row in json.loads((R/'scripts/ci/fixtures/existing-transfer-discharge/original-clawback-guards.json').read_text()):
        if row['signature'].startswith('fn_agent_wallet_claim_back_phase2_core_20260831('):q('SET check_function_bodies=off;'+row['definition']+';')
    for row in json.loads((R/'scripts/ci/fixtures/existing-transfer-discharge/original-main-round2.json').read_text()):
        q('SET check_function_bodies=off;'+row['definition']+';')
    q("CREATE TABLE ca_guard_def_history(id bigserial PRIMARY KEY,proname text,def_hash text,def_text text,captured_at timestamptz DEFAULT now(),UNIQUE(proname,def_hash));CREATE TABLE ca_guard_defs(proname text PRIMARY KEY,def_hash text,updated_at timestamptz DEFAULT now(),declared_ref text,declared_at timestamptz);")
    for row in json.loads((R/'scripts/ci/fixtures/existing-transfer-discharge/original-guard-declaration.json').read_text()):q('SET check_function_bodies=off;'+row['definition']+';')
    discharge_migration=R/'supabase/migrations/20261027034254_existing_player_transfers_discharge_the_same_week_once.sql'
    exact_sql=discharge_migration.read_text()
    # Real exact installer rollback: no audit table or guard baseline persists.
    q(exact_sql.replace('COMMIT;','ROLLBACK;'))
    assert q("SELECT to_regclass('smarter_private.existing_rakeback_transfer_allocations')IS NULL").stdout.strip()=='t'
    assert q('SELECT count(*)FROM ca_guard_defs').stdout.strip()=='0'
    load(discharge_migration)
    assert q("SELECT count(*)FROM smarter_private.existing_rakeback_transfer_instructions").stdout.strip()=='2'
    assert q("SELECT def_hash=md5(pg_get_functiondef('fn_ca_settlement_correctness_check()'::regprocedure))FROM ca_guard_defs WHERE proname='fn_ca_settlement_correctness_check'").stdout.strip()=='t'
    assert q("SELECT NOT has_function_privilege('anon','fn_ca_settlement_correctness_check()','EXECUTE')AND NOT has_function_privilege('authenticated','fn_ca_settlement_correctness_check()','EXECUTE')AND has_function_privilege('service_role','fn_ca_settlement_correctness_check()','EXECUTE')AND NOT has_function_privilege('anon','ca_player_stats_financial_report(uuid,uuid,integer,text,text)','EXECUTE')AND has_function_privilege('authenticated','ca_player_stats_financial_report(uuid,uuid,integer,text,text)','EXECUTE')").stdout.strip()=='t'
    replay=q(exact_sql,check=False)
    assert replay.returncode and 'existing_transfer_owner_preimage_changed' in replay.stderr
    assert q("SELECT count(*)FROM smarter_private.existing_rakeback_transfer_instructions").stdout.strip()=='2'
    results.append({'case':'exact-migration-rollback-install-postimages-acl-and-replay-refusal','passed':True})
    print('SUPPORT_AND_ACTUAL_OWNER_COMPILE_PASS',flush=True)
    q("CREATE TABLE accounting_close_partials(kind text,union_id uuid,period_start timestamptz,period_end timestamptz,window_start timestamptz,window_end timestamptz,value jsonb,cash_ids uuid[],cash_md5 bytea,fee_ids uuid[],fee_md5 bytea,computed_at timestamptz,PRIMARY KEY(kind,union_id,period_start,period_end,window_start));")
    for row in json.loads((R/'scripts/ci/fixtures/existing-transfer-discharge/original-window-helpers.json').read_text())+json.loads((R/'scripts/ci/fixtures/existing-transfer-discharge/original-commission-proof-owners.json').read_text()):q(row['definition']+';')
    load(R/'scripts/ci/fixtures/existing-transfer-discharge/native-seed.sql')
    def ed_case(name,body,refusal=None):
        before=q("SELECT caw_money()||':'||(SELECT count(*)FROM smarter_private.existing_rakeback_transfer_allocations)||':'||(SELECT count(*)FROM smarter_private.existing_rakeback_transfer_instructions)").stdout.strip()
        r=q('BEGIN;SELECT ed_seed();CREATE TEMP TABLE caw_open AS SELECT caw_balances()b;CREATE TEMP TABLE caw_open_legs AS SELECT id FROM chip_ledger;'+body+('SELECT caw_assert_conserved((SELECT b FROM caw_open));SET CONSTRAINTS ALL IMMEDIATE;'if not refusal else '')+'ROLLBACK;',check=False)
        if refusal:assert r.returncode and refusal in r.stderr,(name,r.stdout[-1000:],r.stderr[-6000:])
        else:assert not r.returncode,(name,r.stdout[-1000:],r.stderr[-7000:])
        assert q("SELECT caw_money()||':'||(SELECT count(*)FROM smarter_private.existing_rakeback_transfer_allocations)||':'||(SELECT count(*)FROM smarter_private.existing_rakeback_transfer_instructions)").stdout.strip()==before,name
        results.append({'case':name,'passed':True,'expected_refusal':refusal});print('PASS',name,flush=True)
    for label,call in [('main',R2),('v3',R2V3),('cached-main',R2)]:
        ed_case('actual-'+label+'-then-R3-no-duplicate-and-real-reimbursement',
          ("SET LOCAL app.weekly_accounting_chunked='on';SET LOCAL app.weekly_accounting_scope_deadline='2099-01-01';INSERT INTO accounting_close_partials SELECT 'round2_club_window',caw_u('club'),'2026-10-05 07:00Z','2026-10-12 07:00Z',w.window_start,w.window_end,p.value,p.cash_ids,p.cash_md5,p.fee_ids,p.fee_md5,clock_timestamp()FROM fn_accounting_close_windows('2026-10-05 07:00Z','2026-10-12 07:00Z')w CROSS JOIN LATERAL fn_settle_accounting_commission_window(NULL,caw_u('club'),ARRAY[caw_u('club')],w.window_start,w.window_end)p;"if label=='cached-main'else'')+'SELECT '+call+';'+("SELECT caw_assert((SELECT count(*)=84 FROM pg_temp._close_r2_windows),'actual84windowcombineexecuted');"if label=='cached-main'else'')+'SELECT '+R3+';'+
          "SELECT caw_assert((SELECT chip_balance=1000 FROM club_members WHERE user_id=caw_u('P3')),'Woo prior1000 retained no newcredit');"+
          "SELECT caw_assert((SELECT chip_balance=425 FROM club_members WHERE user_id=caw_u('S')),'Mikey prior125 retained no newcredit');"+
          "SELECT caw_assert((SELECT agent_wallet_balance=0 FROM agents WHERE user_id=caw_u('S')),'Mikey genuine40pass-through netzeroown');"+
          "SELECT caw_assert((SELECT agent_wallet_balance=1343.02 FROM agents WHERE user_id=caw_u('O')),'owner actual468.02reimbursement');"+
          "SELECT caw_assert((SELECT chip_treasury=482.98 FROM clubs WHERE id=caw_u('club')),'strict originalclubbank fundsactualobligation');"+
          "SELECT caw_assert((SELECT count(*)=3 AND sum(amount)=468.02 FROM smarter_private.existing_rakeback_transfer_allocations),'three discharges426.03+32.26+9.73');"+
          "SELECT caw_assert((SELECT sum(amount)=41.99 FROM smarter_private.existing_rakeback_transfer_allocations WHERE original_ledger_id=caw_u('ledger-Mikey')),'same125 allocated41.99only');"+
          "SELECT caw_assert(NOT EXISTS(SELECT FROM smarter_private.existing_rakeback_transfer_allocations WHERE original_ledger_id=caw_u('ledger-Woo-extra')),'second500evidenceunallocated');"+
          "SELECT caw_assert(NOT EXISTS(SELECT FROM wallet_transactions WHERE user_id IN(caw_u('P3'),caw_u('S'))AND type='credit'),'no newbeneficiarywalletjournal');"+
          "SELECT caw_assert((SELECT bool_and(smarter_private.existing_rakeback_transfer_complete(obligation_role,obligation_id))FROM smarter_private.existing_rakeback_transfer_allocations),'allrealreceiptchainscomplete');"+
          'SELECT '+call+';SELECT '+R3+';')
    ed_case('actual-original-expired-clawback-core-refuses-after-discharge','SELECT '+R2+";SELECT set_config('request.jwt.claim.sub',caw_u('O')::text,true);SELECT caw_assert((fn_agent_wallet_claim_back_phase2_core_20260831(caw_u('club'),caw_u('tx-Mikey'),NULL,'native-expired',gen_random_uuid())->>'error')LIKE'%Ten Minute Window%','actual originalsendclawbackexpired');")
    negatives=[
      ('empty-certificates-not-zero-without-whole-request',"DELETE FROM accounting_period_recompute_requests;SELECT "+R2+';','existing_transfer_current_whole_club_calculation_required'),
      ('partial-request-not-whole-club-proof',"UPDATE accounting_period_recompute_requests SET status='pending';SELECT "+R2+';','existing_transfer_current_whole_club_calculation_required'),
      ('later-source-invalidates-commission-zero-proof',"UPDATE accounting_cash_rake_sources SET recorded_at=now()WHERE id=caw_u('s5');SELECT "+R2+';','existing_transfer_current_whole_club_calculation_required'),
      ('later-atomic-admission-invalidates-zero-proof',"INSERT INTO accounting_cash_atomic_contract_admissions VALUES(caw_u('s5'),now());SELECT "+R2+';','existing_transfer_current_whole_club_calculation_required'),
      ('later-funding-admission-invalidates-zero-proof',"INSERT INTO accounting_cash_funding_contract_admissions VALUES(caw_u('s5'),caw_u('club'),now());SELECT "+R2+';','existing_transfer_current_whole_club_calculation_required'),
      ('browser-auth-refused',"SET LOCAL request.jwt.claim.role='authenticated';SELECT "+R2+';','service_role_required'),
      ('platform-freeze-refused',"UPDATE dr_controls SET frozen=true;SELECT "+R2+';','existing_transfer_original_stage_context_required'),
      ('private-leaf-has-no-service-rpc',"SET LOCAL ROLE service_role;SELECT smarter_private.apply_existing_rakeback_transfer('club',caw_u('club'),'2026-10-05 07:00Z','2026-10-12 07:00Z','commission',caw_u('club'),caw_u('S'));",'permission denied'),
      ('leaf-outside-original-stage-refused',"SELECT smarter_private.apply_existing_rakeback_transfer('club',caw_u('club'),'2026-10-05 07:00Z','2026-10-12 07:00Z','commission',caw_u('club'),caw_u('S'));",'existing_transfer_original_stage_context_required'),
      ('reversed-original-transfer-refused',"UPDATE chip_transactions SET is_reversed=true WHERE id=caw_u('tx-Mikey');SELECT "+R2+';','existing_transfer_unreversed_original_transaction_required'),
      ('claimed-back-original-transfer-refused',"UPDATE chip_transactions SET metadata=jsonb_set(metadata,'{claimed_back}','1')WHERE id=caw_u('tx-Mikey');SELECT "+R2+';','existing_transfer_unreversed_original_transaction_required'),
      ('original-wallet-role-mismatch-refused',"UPDATE chip_ledger SET from_type='player_wallet'WHERE id=caw_u('ledger-Mikey');SELECT "+R2+';','existing_transfer_original_credit_required'),
      ('original-beneficiary-mismatch-refused',"UPDATE chip_ledger SET to_entity_id=caw_u('P1')WHERE id=caw_u('ledger-Mikey');SELECT "+R2+';','existing_transfer_original_credit_required'),
      ('cashier-receipt-missing-refused',"DELETE FROM cashier_rpc_operation_intents WHERE operation_id=caw_u('op-Mikey');SELECT "+R2+';','existing_transfer_completed_cashier_receipt_required'),
      ('cashier-receipt-amount-mismatch-refused',"UPDATE cashier_rpc_operation_intents SET receipt=jsonb_set(receipt,'{amount}','126')WHERE operation_id=caw_u('op-Mikey');SELECT "+R2+';','existing_transfer_completed_cashier_receipt_required'),
      ('cashier-source-debit-mismatch-refused',"UPDATE cashier_rpc_operation_intents SET receipt=jsonb_set(receipt,'{agent_wallet_before}',receipt->'agent_wallet_after')WHERE operation_id=caw_u('op-Mikey');SELECT "+R2+';','existing_transfer_completed_cashier_receipt_required'),
      ('still-reversible-original-send-refused',"UPDATE chip_transactions SET reversible_until=now()+interval '1 day'WHERE id=caw_u('tx-Mikey');SELECT "+R2+';','existing_transfer_unreversed_original_transaction_required'),
      ('invoice-delivery-fault-atomic-rollback',"SET LOCAL dr.refuse_invoice='on';SELECT "+R2+';','existing_transfer_reimbursement_invoice_required'),
      ('bank-underfunding-atomic-rollback',"UPDATE clubs SET chip_treasury=1 WHERE id=caw_u('club');SELECT "+R2+';','existing_transfer_reimbursement_accounts_invalid'),
      ('latest-certificate-fingerprint-tamper-refused',"UPDATE accounting_rakeback_period_calculations SET source_fingerprint=md5('tampered')WHERE player_id=caw_u('P3');SELECT "+R2+';SELECT '+R3+';','existing_transfer_latest_owner_payer_certificate_required'),
      ('allocation-cannot-be-updated',"SELECT "+R2+";UPDATE smarter_private.existing_rakeback_transfer_allocations SET amount=amount+.01;",'accounting_agreement_history_is_immutable'),
      ('allocation-cannot-be-truncated',"SELECT "+R2+";SET CONSTRAINTS ALL IMMEDIATE;TRUNCATE smarter_private.existing_rakeback_transfer_allocations;",'accounting_agreement_history_is_immutable'),
      ('reimbursement-receipt-deletion-caught-at-commit',"SELECT "+R2+";DELETE FROM settlement_invoices WHERE source_ledger_id IN(SELECT reimbursement_ledger_id FROM smarter_private.existing_rakeback_transfer_allocations);SET CONSTRAINTS ALL IMMEDIATE;",'existing_transfer_discharge_evidence_incomplete'),
      ('lost-reimbursement-method-rejected-by-private-completion',"SELECT "+R2+";UPDATE chip_ledger SET metadata=metadata-'payment_method'WHERE metadata->>'payment_method'='owner_confirmed_existing_transfer';SET CONSTRAINTS ALL IMMEDIATE;",'existing_transfer_discharge_evidence_incomplete'),
      ('wrong-reimbursement-week-rejected-by-private-completion',"SELECT "+R2+";UPDATE chip_ledger SET metadata=jsonb_set(metadata,'{period_start}',to_jsonb('2026-10-19 07:00Z'::text))WHERE metadata->>'payment_method'='owner_confirmed_existing_transfer';SET CONSTRAINTS ALL IMMEDIATE;",'existing_transfer_discharge_evidence_incomplete'),
      ('null-period-paid-date-refuses-complete-receipt',"SELECT "+R2+";SELECT "+R3+";UPDATE rakeback_periods SET paid_at=NULL WHERE user_id=caw_u('P3');SET CONSTRAINTS ALL IMMEDIATE;",'existing_transfer_discharge_evidence_incomplete'),
      ('null-payout-paid-date-refuses-complete-receipt',"SELECT "+R2+";SELECT "+R3+";UPDATE rakeback_period_payouts SET paid_at=NULL WHERE user_id=caw_u('P3');SET CONSTRAINTS ALL IMMEDIATE;",'existing_transfer_discharge_evidence_incomplete'),
      ('null-commission-paid-date-refused-by-original-not-null-constraint',"SELECT "+R2+";UPDATE agent_commission_settlements SET paid_at=NULL WHERE user_id=caw_u('S');SET CONSTRAINTS ALL IMMEDIATE;",'null value in column \"paid_at\"'),
    ]
    for name,body,refusal in negatives:ed_case(name,body,refusal)
    over="UPDATE accounting_cash_rake_sources SET rake_credit=1000,contract=jsonb_set(contract,'{tiers,0,amount}','500')WHERE id=caw_u('s5');UPDATE agent_commissions SET amount=500 WHERE source_id=caw_u('s5');UPDATE rakeback_periods SET rake_generated=1000,total_rake_paid=1000,rakeback_rate=.12,rakeback_amount=120,rakeback_earned=120 WHERE user_id=caw_u('S');UPDATE accounting_rakeback_period_calculations SET rake_generated=1000,display_rate=.12,rakeback_amount=120,source_allocations=jsonb_set(jsonb_set(source_allocations,'{0,rake_credit}','1000'),'{0,rate}','0.12')WHERE player_id=caw_u('S');UPDATE accounting_rakeback_period_calculations SET source_fingerprint=md5(jsonb_build_object('allocations',source_allocations,'rake',rake_generated,'amount',rakeback_amount,'rate',display_rate)::text)WHERE player_id=caw_u('S');"
    ed_case('combined-player-and-commission-cannot-overallocate-the-same125',over+'SELECT '+R2+';SELECT '+R3+';','existing_transfer_credit_already_allocated')
    positive_player="UPDATE accounting_cash_rake_sources SET contract=jsonb_set(jsonb_set(contract,'{membership,terms,agent_id}',to_jsonb(caw_u('S'))),'{tiers}',(contract->'tiers')-0)WHERE id=caw_u('s1');DELETE FROM agent_commissions WHERE source_id=caw_u('s1')AND user_id=caw_u('A');UPDATE accounting_cash_rake_sources SET contract=jsonb_set(jsonb_set(contract,'{tiers,0,amount}','20'),'{tiers,0,rate}','0.2')WHERE id=caw_u('s1');UPDATE agent_commissions SET amount=20,commission_rate=.2 WHERE source_id=caw_u('s1')AND user_id=caw_u('S');UPDATE accounting_rakeback_period_calculations SET payer_user_id=caw_u('S'),source_allocations=jsonb_set(source_allocations,'{0,payer_user_id}',to_jsonb(caw_u('S')))WHERE player_id=caw_u('P1');UPDATE accounting_rakeback_period_calculations SET source_fingerprint=md5(jsonb_build_object('allocations',source_allocations,'rake',rake_generated,'amount',rakeback_amount,'rate',display_rate)::text)WHERE player_id=caw_u('P1');"
    ed_case('positive-other-player-funding-is-not-mistaken-for-personal-commission',positive_player+'SELECT '+R2+';','existing_transfer_commission_player_pass_through_requires_net_discharge')
    # Two real sessions for each original money stage; R2 persists before R3.
    q('BEGIN;SELECT ed_seed();COMMIT;')
    concurrent_open=q('SELECT caw_balances()').stdout.strip()
    concurrent_open_legs=q("SELECT jsonb_agg(id ORDER BY id)FROM chip_ledger").stdout.strip()
    for phase,call in [('R2',R2),('R3',R3)]:
        pause=None
        if phase=='R3':
            pause=subprocess.Popen([str(A.pg_bin/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-h','127.0.0.1','-p',port,'-d','postgres'],env=E,text=True,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,bufsize=1)
            pause.stdin.write("SELECT pg_advisory_lock(8934254);SELECT 'locked';\n");pause.stdin.flush()
            assert pause.stdout.readline().strip()=='' and pause.stdout.readline().strip()=='locked'
        def concurrent_call(_):return json.loads(q("BEGIN;SET LOCAL application_name='ed-unrelated-beneficiary-concurrency';"+("SET LOCAL ed.pause_woo_invoice='on';"if phase=='R3'else'')+'SELECT '+call+';SET CONSTRAINTS ALL IMMEDIATE;COMMIT;').stdout.strip())
        with concurrent.futures.ThreadPoolExecutor(max_workers=2)as pool:
            pending=[pool.submit(concurrent_call,i)for i in range(2)]
            if phase=='R3':
                try:
                    deadline=time.monotonic()+10
                    while q("SELECT EXISTS(SELECT FROM pg_stat_activity WHERE application_name='ed-unrelated-beneficiary-concurrency'AND wait_event='advisory')").stdout.strip()!='t':
                        assert time.monotonic()<deadline,'R3 did not reach the real reimbursement invoice barrier'
                        time.sleep(.02)
                    # Genuine concurrent unrelated member-to-member credit with its
                    # own balanced ledger; no club-bank/owner-agent lock is taken.
                    q("BEGIN;SET LOCAL lock_timeout='2s';SET LOCAL app.ledger_autoskip_club_members='1';UPDATE club_members SET chip_balance=chip_balance-1 WHERE club_id=caw_u('club')AND user_id=caw_u('A');UPDATE club_members SET chip_balance=chip_balance+1 WHERE club_id=caw_u('club')AND user_id=caw_u('P3');INSERT INTO chip_ledger(id,performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,description,idempotency_key,metadata,pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)VALUES(caw_u('unrelated-leg'),caw_u('A'),'player_wallet',caw_u('A'),'player_wallet',caw_u('P3'),1,'treasury_transfer',caw_u('club'),'Unrelated concurrent wallet transfer','native-unrelated-wallet-transfer','{}',1000,999,1000,1001);INSERT INTO wallet_transactions(user_id,wallet_type,amount,type,category,related_entity_id,balance_after)VALUES(caw_u('P3'),'PLAYER',1,'credit','transfer',caw_u('unrelated-leg'),1001);SET CONSTRAINTS ALL IMMEDIATE;COMMIT;")
                finally:
                    pause.stdin.write("SELECT pg_advisory_unlock(8934254);\n\\q\n");pause.stdin.flush();pause.communicate(timeout=10)
            answers=[f.result(timeout=30)for f in pending]
        assert sum(v.get('duplicate',False)for v in answers)==1,(phase,answers)
        results.append({'case':'concurrent-original-'+phase+'-one-settlement-one-replay','passed':True})
    assert q("SELECT chip_balance FROM club_members WHERE user_id=caw_u('P3')").stdout.strip()=='1001.00'
    assert q("SELECT chip_balance FROM club_members WHERE user_id=caw_u('A')").stdout.strip()=='999.00'
    assert q("SELECT count(*)FROM chip_ledger WHERE id=caw_u('unrelated-leg')").stdout.strip()=='1'
    results.append({'case':'actual-concurrent-unrelated-beneficiary-credit-does-not-abort-or-lose-update','passed':True})
    assert q("SELECT count(*)||':'||sum(amount)FROM smarter_private.existing_rakeback_transfer_allocations").stdout.strip()=='3:468.02'
    assert q("SELECT count(*)FROM chip_ledger WHERE metadata->>'payment_method'='owner_confirmed_existing_transfer'").stdout.strip()=='3'
    assert q("SELECT count(*)FROM wallet_transactions WHERE user_id IN(caw_u('S'),caw_u('P3'))AND type='credit'AND category='rakeback'").stdout.strip()=='0'
    assert Decimal(q("SELECT agent_wallet_balance FROM agents WHERE user_id=caw_u('S')").stdout.strip())==0
    q("CREATE TEMP TABLE caw_open_legs AS SELECT value::uuid id FROM jsonb_array_elements_text('"+concurrent_open_legs.replace("'","''")+"'::jsonb);SELECT caw_assert_conserved('"+concurrent_open.replace("'","''")+"'::jsonb);")
    print('PASS concurrent-committed-R2-then-R3-no-double-allocation-or-reimbursement',flush=True)
    # Full existing self-authorized financial report, with its maintained
    # calendar/auth adapters, exposes the actual receipt without owner balances.
    q("CREATE TABLE IF NOT EXISTS tournaments(id uuid,club_id uuid);ALTER TABLE rakeback_periods ADD COLUMN IF NOT EXISTS deferred_reason text,ADD COLUMN IF NOT EXISTS deferred_at timestamptz,ADD COLUMN IF NOT EXISTS defer_count integer;ALTER TABLE rakeback_period_payouts ADD COLUMN IF NOT EXISTS currency text DEFAULT 'CHIPS',ADD COLUMN IF NOT EXISTS failure_reason text,ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();")
    import re
    adapters=(R/'tests/fixtures/stats-financial-reports/bootstrap.sql').read_text()
    for name in ['public.ca_assert_self','public.ca_assert_player_stats_club','public.ca_stats_calendar_bounds']:
        m=re.search(r'CREATE FUNCTION '+re.escape(name)+r'\(.*?\$\$.*?\$\$;',adapters,re.S);assert m,name;q(m.group(0).replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1))
    report=json.loads(q("SET request.jwt.claim.sub='"+q("SELECT caw_u('S')").stdout.strip()+"';SELECT ca_player_stats_financial_report(caw_u('S'),caw_u('club'),NULL,'UTC','chips');").stdout)
    receipt=report['rakeback']['payout_receipts'][0]
    assert receipt['existing_transfer_discharge']['verified']is True and receipt['existing_transfer_discharge']['allocated_amount']==32.26
    assert receipt['existing_transfer_discharge']['original_credit']==125 and receipt['existing_transfer_discharge']['actual_prior_destination']=='player_wallet'
    assert receipt['wallet_transaction_id']is None and receipt['wallet_transactions']==[]
    assert 'original_evidence'not in receipt['existing_transfer_discharge']
    results.append({'case':'actual-authorized-financial-report-exposes-real-prior-transfer','passed':True})
    # Actual old/new C3 cohorts preserve a genuine gap, recognizing only the
    # complete new evidence method for the two NULL-wallet-pointer receipts.
    q('CREATE TABLE IF NOT EXISTS rakeback_distributions(id uuid,club_id uuid,status text,transferred_at timestamptz,chip_transfer_id uuid,rakeback_amount numeric);')
    def c3(s):
        start=s.index("SELECT 'period_payout' AS src");return s[start:s.index('LIMIT 20',start)+len('LIMIT 20')]
    old_check=next(r['definition']for r in json.loads((R/'scripts/ci/fixtures/existing-transfer-discharge/original-owners.json').read_text())if r['signature']=='fn_ca_settlement_correctness_check()')
    new_check=q("SELECT pg_get_functiondef('fn_ca_settlement_correctness_check()'::regprocedure)").stdout
    assert q('SELECT count(*)FROM('+c3(old_check)+')g').stdout.strip()=='2'
    assert q('SELECT count(*)FROM('+c3(new_check)+')g').stdout.strip()=='0'
    results.append({'case':'actual-correctness-cohort-recognizes-only-complete-existing-transfers','passed':True})
    rows=json.loads(q("SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'md5',md5(pg_get_functiondef(p.oid)),'acl',p.proacl::text,'owner',pg_get_userbyid(p.proowner),'proconfig',p.proconfig,'volatility',p.provolatile)ORDER BY p.oid::regprocedure::text)FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE(n.nspname='smarter_private'AND(p.proname LIKE'existing_%'OR p.proname='apply_existing_rakeback_transfer'))OR p.oid=ANY(ARRAY['fn_settle_accounting_commission_stage(text,uuid,timestamptz,timestamptz)'::regprocedure,'fn_settle_accounting_commission_stage_v3(text,uuid,timestamptz,timestamptz)'::regprocedure,'fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure,'fn_ca_settlement_correctness_check()'::regprocedure,'ca_player_stats_financial_report(uuid,uuid,integer,text,text)'::regprocedure])").stdout)
    if A.output:
        A.output.parent.mkdir(parents=True,exist_ok=True)
        A.output.with_suffix('.postimages.json').write_text(json.dumps(rows,indent=2))
        A.output.write_text(json.dumps({'status':'passed','cases':results,'notification_delivery_boundary':'controlled-native-adapter'},indent=2)+'\n')
    print(json.dumps({'status':'passed','cases':results,'actual_original_R2_main_and_v3':True,'actual_original_R3':True,'actual_original_invoice_owner':True,'notification_delivery_boundary':'controlled-native-adapter'}),flush=True)
finally:
    if started: subprocess.run([str(A.pg_bin/'pg_ctl'),'-D',str(D),'-m','immediate','stop'],env=E,capture_output=True)
    shutil.rmtree(W,ignore_errors=True)
