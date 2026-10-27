#!/usr/bin/env python3
"""An empty former-standalone book independently validates a paid Union book.

Exact52225 rollback/install/postimages/ACL/replay, actual main/v3 and original
cached/direct financial owners, source-effective funding admissions, genuine84
window proofs and actual foreign CS/ledger/invoice/discharge receipts. No paid
receipt is manufactured. OriginalR3 foreign-period exclusion and direct C3 /
coordinator predicates are exercised. Full inventory/launch/source40 boundaries
are explicit controlled fixture adapters, not production certification.
"""
import argparse, concurrent.futures, json, os, shutil, socket, subprocess, sys, tempfile, time
from pathlib import Path
from decimal import Decimal

P=argparse.ArgumentParser()
P.add_argument('--repo',type=Path,default=Path(__file__).resolve().parents[2])
P.add_argument('--pg-bin',type=Path,default=Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin')))
P.add_argument('--scratch-root',type=Path,required=True)
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
    results.append({'case':'base34254-exact-migration-rollback-install-postimages-acl-and-replay-refusal','passed':True})
    print('SUPPORT_AND_ACTUAL_OWNER_COMPILE_PASS',flush=True)
    q("CREATE TABLE accounting_close_partials(kind text,union_id uuid,period_start timestamptz,period_end timestamptz,window_start timestamptz,window_end timestamptz,value jsonb,cash_ids uuid[],cash_md5 bytea,fee_ids uuid[],fee_md5 bytea,computed_at timestamptz,PRIMARY KEY(kind,union_id,period_start,period_end,window_start));")
    for row in json.loads((R/'scripts/ci/fixtures/existing-transfer-discharge/original-window-helpers.json').read_text())+json.loads((R/'scripts/ci/fixtures/existing-transfer-discharge/original-commission-proof-owners.json').read_text()):q(row['definition']+';')
    load(R/'scripts/ci/fixtures/existing-transfer-discharge/native-seed.sql')
    Z=R/'scripts/ci/fixtures/zero-standalone-foreign'
    q("CREATE TABLE ca_mint_ledger(op_id text,chip_ledger_id uuid,amount numeric);ALTER TABLE accounting_cash_atomic_contract_admissions ADD COLUMN admitted_contract jsonb;ALTER TABLE accounting_cash_funding_contract_admissions ADD COLUMN admitted_contract jsonb;CREATE TABLE zero_cutoffs(club_id uuid,cutoff_at timestamptz);CREATE FUNCTION fn_ca_launch_accounting_club_cutoffs()RETURNS TABLE(club_id uuid,cutoff_at timestamptz)LANGUAGE sql STABLE AS $$SELECT * FROM zero_cutoffs$$;")
    q('CREATE VIEW accounting_effective_cash_rake_sources AS '+(Z/'effective-cash-view.sql').read_text())
    q('CREATE OR REPLACE VIEW accounting_payable_earning_sources AS '+(Z/'payable-view.sql').read_text())
    load(Z/'original-routing-resolver.sql')
    # Explicit unchanged full-inventory boundary isolation, like source40 and
    # launch controls above. Actual effective source/window/entitlement and
    # every foreign financial owner/receipt remain real, not fabricated.
    q("CREATE FUNCTION fn_accounting_union_earned_plan(uuid,timestamptz,timestamptz)RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN IF NOT EXISTS(SELECT FROM unions WHERE id=$1)OR $2 IS DISTINCT FROM '2026-10-05 07:00Z'::timestamptz OR $3 IS DISTINCT FROM '2026-10-12 07:00Z'::timestamptz OR NOT(SELECT sealed FROM dr_controls)THEN RAISE EXCEPTION 'native_original_inventory_boundary_refused';END IF;RETURN jsonb_build_object('fixture_boundary','unchanged_full_inventory');END$$;")
    q("CREATE FUNCTION zero_seed()RETURNS void LANGUAGE plpgsql AS $$BEGIN PERFORM ed_seed();INSERT INTO unions(id,name,owner_id,slug)VALUES(caw_u('union'),'Foreign original union',caw_u('O'),'foreign-original-union');INSERT INTO union_clubs(union_id,club_id)VALUES(caw_u('union'),caw_u('club'));UPDATE accounting_cash_rake_sources SET union_id=caw_u('union'),coordinator_union_id=caw_u('union'),contract=contract||jsonb_build_object('union_id',caw_u('union'),'coordinator_union_id',caw_u('union'));UPDATE accounting_rakeback_period_calculations SET coordinator_union_id=caw_u('union');END$$;")
    U2=R2.replace("'club',caw_u('club')","'union',caw_u('union')")
    U3=R3.replace("'club',caw_u('club')","'union',caw_u('union')")
    def windows(kind,identifier):return "SET LOCAL app.weekly_accounting_chunked='on';SET LOCAL app.weekly_accounting_scope_deadline='2099-01-01';INSERT INTO accounting_close_partials SELECT 'round2_"+kind+"_window',caw_u('"+identifier+"'),'2026-10-05 07:00Z','2026-10-12 07:00Z',w.window_start,w.window_end,p.value,p.cash_ids,p.cash_md5,p.fee_ids,p.fee_md5,clock_timestamp()FROM fn_accounting_close_windows('2026-10-05 07:00Z','2026-10-12 07:00Z')w CROSS JOIN LATERAL fn_settle_accounting_commission_window("+("caw_u('union'),NULL"if kind=='union'else"NULL,caw_u('club')")+",ARRAY[caw_u('club')],w.window_start,w.window_end)p;"
    def zcase(name,body,refusal=None):
        body=body.replace('CLUB_EXPECTED','1'if 'v3-direct'in name else'0')
        before=q("SELECT caw_money()||':'||(SELECT count(*)FROM smarter_private.existing_rakeback_transfer_allocations)").stdout.strip()
        text='BEGIN;SELECT zero_seed();'+windows('union','union')+'SELECT '+U2+';SELECT '+U3+';'+body+('SET CONSTRAINTS ALL IMMEDIATE;'if not refusal else'')+'ROLLBACK;'
        ans=q(text,check=False)
        if refusal:assert ans.returncode and refusal in ans.stderr,(name,ans.stdout[-1000:],ans.stderr[-6000:])
        else:assert not ans.returncode,(name,ans.stdout[-1000:],ans.stderr[-6000:])
        assert q("SELECT caw_money()||':'||(SELECT count(*)FROM smarter_private.existing_rakeback_transfer_allocations)").stdout.strip()==before
        results.append({'case':name,'passed':True,'expected_refusal':refusal});print('PASS',name,flush=True)
    # Reproduce the actual old false legacy refusal after the other scope paid.
    zcase('preimage-refuses-proven-zero-standalone-after-canonical-foreign-payment','SELECT '+R2+';','legacy_commission_payment_requires_reconciliation')
    zero_migration=R/'supabase/migrations/20261027052225_zero_standalone_books_validate_foreign_paid_commission_receipts.sql'
    zero_sql=zero_migration.read_text()
    q(zero_sql.replace('COMMIT;','ROLLBACK;'))
    assert q("SELECT to_regprocedure('smarter_private.zero_standalone_foreign_commissions_proven(uuid,timestamptz,timestamptz)')IS NULL").stdout.strip()=='t'
    load(zero_migration)
    again=q(zero_sql,check=False)
    assert again.returncode and 'zero_standalone_original_owner_preimage_changed'in again.stderr
    assert q("SELECT NOT has_function_privilege('service_role','smarter_private.zero_standalone_foreign_commissions_proven(uuid,timestamptz,timestamptz)','EXECUTE')AND NOT has_function_privilege('authenticated','smarter_private.zero_standalone_foreign_commissions_proven(uuid,timestamptz,timestamptz)','EXECUTE')AND NOT has_function_privilege('anon','smarter_private.zero_standalone_foreign_commissions_proven(uuid,timestamptz,timestamptz)','EXECUTE')").stdout.strip()=='t'
    results.append({'case':'exact52225-migration-rollback-install-postimages-acl-replay-refusal','passed':True})
    for label,call in [('main-direct',R2),('v3-direct',R2V3),('main-cached',R2)]:
        zcase('original-'+label+'-zero-book-preserves-paid-foreign-wallets',
          (windows('club','club')if label=='main-cached'else'')+"CREATE TEMP TABLE zero_before AS SELECT caw_money()m;CREATE TEMP TABLE zero_balances AS SELECT caw_balances()b;SELECT "+call+";SELECT caw_assert((SELECT count(*)=0 FROM pg_temp._routed_nodes),'ownnodesrestored');SELECT caw_assert((SELECT count(*)=0 FROM pg_temp._routed_edges),'ownedgesrestored');SELECT caw_assert((SELECT count(*)=CLUB_EXPECTED FROM pg_temp._routed_clubs),'ownclubsrestored');SELECT caw_assert((SELECT result->>'sources'='0'AND result->>'amount'='0'AND result->>'own_commission_amount'='0'FROM accounting_routed_settlement_runs WHERE scope_kind='club'AND scope_id=caw_u('club')AND round_no=2),'actualoriginalzeroreceipt');SELECT caw_assert(caw_balances()=(SELECT b FROM zero_balances),'zeroownnoWalletmovement');SELECT "+call+";SELECT caw_assert(caw_balances()=(SELECT b FROM zero_balances),'replaynoWalletmovement');"+
          ("SELECT caw_assert((SELECT count(*)=84 AND bool_and((value->>'sources')::bigint=0)FROM pg_temp._close_r2_windows),'all84ownwindowsrestored');"if label=='main-cached'else("SELECT caw_assert((SELECT count(*)=84 FROM pg_temp._close_r2_windows),'originalv3windowstaterestored');"if label=='v3-direct'else"SELECT caw_assert((SELECT count(*)=0 FROM pg_temp._close_r2_windows),'ownemptywindowstaterestored');")).replace('CLUB_EXPECTED','1'if label=='v3-direct'else'0'))
    zcase('original-zero-R2-then-original-zero-R3-do-not-repay-Union-periods',
      "CREATE TEMP TABLE zero_wallets AS SELECT caw_balances()b;CREATE TEMP TABLE zero_payouts AS SELECT count(*)n FROM rakeback_period_payouts;SELECT "+R2+";SELECT "+R3+";SELECT "+R3+";SELECT caw_assert(caw_balances()=(SELECT b FROM zero_wallets),'zeroR3noUnionrepaid');SELECT caw_assert((SELECT count(*)=(SELECT n FROM zero_payouts)FROM rakeback_period_payouts),'noDuplicatePlayerReceipt');SELECT caw_assert((SELECT result->>'amount'='0'AND result->>'payees'='0'FROM accounting_routed_settlement_runs WHERE scope_kind='club'AND scope_id=caw_u('club')AND round_no=3),'originalzeroR3receipt');")
    negatives=[
      ('missing-foreign-original-window',"DELETE FROM accounting_close_partials WHERE kind='round2_union_window'AND window_start='2026-10-05 07:00Z';",'zero_standalone_current_original_foreign_windows_required'),
      ('expired-foreign-original-windows',"UPDATE accounting_close_partials SET computed_at=clock_timestamp()-fn_accounting_close_proof_lifetime()-interval '1 second'WHERE kind='round2_union_window';",'zero_standalone_current_original_foreign_windows_required'),
      ('foreign-source-fingerprint-mismatch',"UPDATE accounting_routed_settlement_runs SET source_fingerprint=md5('changed')WHERE scope_kind='union'AND round_no=2;",'zero_standalone_current_original_foreign_windows_required'),
      ('foreign-aggregate-preserving-cs-own-tamper',"UPDATE agent_commission_settlements SET amount=amount+CASE WHEN user_id=caw_u('A')THEN 1 ELSE -1 END WHERE user_id IN(caw_u('A'),caw_u('S'));",'zero_standalone_foreign_own_rows_not_bound'),
      ('foreign-original-runkey-tamper',"UPDATE agent_commission_settlements SET settlement_ref='wrong'WHERE user_id=caw_u('A');",'zero_standalone_foreign_own_rows_not_bound'),
      ('foreign-rows-count-tamper',"UPDATE agent_commission_settlements SET rows_count=rows_count+1 WHERE user_id=caw_u('A');",'zero_standalone_foreign_own_rows_not_bound'),
      ('foreign-actual-edge-invoice-missing',"UPDATE settlement_invoices SET message_sent=false WHERE source_ledger_id IN(SELECT id FROM chip_ledger WHERE category='commission'AND to_entity_id=caw_u('A'));",'zero_standalone_foreign_actual_edge_receipt_not_bound'),
      ('foreign-actual-edge-delta-tamper',"UPDATE chip_ledger SET post_from_balance=post_from_balance-1 WHERE category='commission'AND to_entity_id=caw_u('A');",'zero_standalone_foreign_actual_edge_receipt_not_bound'),
      ('foreign-unreceipted-legacy-row',"DELETE FROM accounting_routed_settlement_runs WHERE scope_kind='union'AND round_no=2;",'zero_standalone_canonical_foreign_round_required'),
      ('foreign-null-scope-legacy-row',"UPDATE agent_commission_settlements SET union_id=NULL WHERE user_id=caw_u('A');",'zero_standalone_legacy_or_partial_foreign_settlement'),
      ('foreign-discharge-source-binding-tamper',"UPDATE chip_ledger SET metadata=jsonb_set(metadata,'{source_fingerprint}',to_jsonb('wrong'::text))WHERE metadata->>'obligation_role'='commission';",'zero_standalone_foreign_prior_discharge_not_bound'),
      ('positive-own-source-not-accepted',"INSERT INTO accounting_cash_rake_sources(id,rake_record_id,club_id,player_id,earned_at,rake_credit,contract)SELECT caw_u('own-source'),caw_u('own-record'),club_id,player_id,earned_at,rake_credit,contract FROM accounting_cash_rake_sources WHERE id=caw_u('s2');",'legacy_commission_payment_requires_reconciliation'),
      ('positive-or-unknown-standalone-bank-refused',"INSERT INTO ca_mint_ledger(op_id,amount)VALUES('standalone-rake-bank:'||caw_u('club')::text||':2026-10-05T07:00:00Z..2026-10-12T07:00:00Z',1);",'zero_standalone_positive_or_unknown_bank_basis_refused'),
      ('private-validator-not-an-RPC',"SET LOCAL ROLE service_role;SELECT smarter_private.zero_standalone_foreign_commissions_proven(caw_u('club'),'2026-10-05 07:00Z','2026-10-12 07:00Z');",'permission denied'),
      ('private-validator-outside-original-stage-refused',"SELECT smarter_private.zero_standalone_foreign_commissions_proven(caw_u('club'),'2026-10-05 07:00Z','2026-10-12 07:00Z');",'zero_standalone_original_stage_required'),
    ]
    negatives.append(('foreign-partial-week-refused',"UPDATE agent_commission_settlements SET period_start=period_start-interval '1 day'WHERE user_id=caw_u('A');",'zero_standalone_legacy_or_partial_foreign_settlement'))
    negatives.append(('foreign-original-proof-flags-refused',"UPDATE accounting_close_partials SET value=jsonb_set(value,'{tiers_failed}','true')WHERE kind='round2_union_window'AND window_start='2026-10-05 07:00Z';",'zero_standalone_current_original_foreign_windows_required'))
    negatives.append(('foreign-own-CS-transaction-time-drift-refused',"UPDATE agent_commission_settlements SET paid_at=paid_at+interval '1 second'WHERE user_id=caw_u('A');",'zero_standalone_foreign_original_transaction_not_bound'))
    negatives.append(('foreign-actual-edge-transaction-time-drift-refused',"UPDATE chip_ledger SET created_at=created_at+interval '1 second'WHERE category='commission'AND to_entity_id=caw_u('A');",'zero_standalone_foreign_actual_edge_receipt_not_bound'))
    negatives.append(('unbound-original-transaction-edge-refused',"INSERT INTO chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,description,idempotency_key,metadata,pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)VALUES(caw_u('O'),'club_treasury',caw_u('club'),'agent_wallet',caw_u('A'),1,'commission',caw_u('club'),'Unknown edge in the same original transaction','unbound-original-tx-edge','{}',100,99,0,1);",'zero_standalone_foreign_actual_edge_receipt_not_bound'))
    for name,change,refusal in negatives:zcase(name,change+'SELECT '+R2+';',refusal)
    own_change=next(x[1]for x in negatives if x[0]=='positive-own-source-not-accepted')
    zcase('positive-own-v3-refusal-preserved',own_change+'SELECT '+R2V3+';','legacy_commission_payment_requires_reconciliation')
    zcase('positive-own-cached-refusal-preserved',own_change+windows('club','club')+'SELECT '+R2+';','legacy_commission_payment_requires_reconciliation')
    zcase('original-v3-restores-full-inherited-temp-rows-and-context',
      "CREATE TEMP TABLE zero_saved_temp AS SELECT(SELECT jsonb_agg(to_jsonb(w)ORDER BY window_start)FROM pg_temp._close_r2_windows w)windows,(SELECT jsonb_agg(to_jsonb(c)ORDER BY club_id)FROM pg_temp._routed_clubs c)clubs;SET LOCAL app.accounting_routing_context='native-parent-context';SELECT "+R2V3+";SELECT caw_assert((SELECT windows IS NOT DISTINCT FROM(SELECT jsonb_agg(to_jsonb(w)ORDER BY window_start)FROM pg_temp._close_r2_windows w)AND clubs IS NOT DISTINCT FROM(SELECT jsonb_agg(to_jsonb(c)ORDER BY club_id)FROM pg_temp._routed_clubs c)FROM zero_saved_temp),'allOriginalTempRowsRestored');SELECT caw_assert(current_setting('app.accounting_routing_context')='native-parent-context','originalContextRestored');")
    zcase('effective-funding-admission-not-raw-host-defines-zero-own',
      "INSERT INTO clubs(id,name,owner_id,chip_treasury,is_union,asset,lifecycle_status)VALUES(caw_u('other'),'Other funding club',caw_u('O'),1000,false,'chips','active');INSERT INTO accounting_cash_rake_sources(id,rake_record_id,club_id,player_id,earned_at,rake_credit,contract)SELECT caw_u('admitted-source'),caw_u('admitted-record'),club_id,player_id,earned_at,rake_credit,contract FROM accounting_cash_rake_sources WHERE id=caw_u('s2');INSERT INTO accounting_cash_funding_contract_admissions(source_id,funding_club_id,admitted_at,admitted_contract)SELECT id,caw_u('other'),now()-interval '1 hour',jsonb_set(contract,'{club_id}',to_jsonb(caw_u('other')))FROM accounting_cash_rake_sources WHERE id=caw_u('admitted-source');SELECT caw_assert((SELECT count(*)=1 FROM accounting_cash_rake_sources WHERE club_id=caw_u('club')AND coordinator_union_id IS NULL),'rawHostCandidateExists');SELECT caw_assert((SELECT count(*)=0 FROM accounting_payable_earning_sources WHERE club_id=caw_u('club')AND coordinator_union_id IS NULL),'effectiveOwnIsActuallyZero');SELECT "+R2+";")
    # Exact consumer clauses, no unrelated correctness/inventory audit.
    zcase('actual-standalone-coordinator-and-C3-receipt-predicates-accept-zero',
      "SELECT "+R2+";SELECT "+R3+";SELECT caw_assert((SELECT count(*)=2 FROM accounting_routed_settlement_runs r WHERE r.scope_kind='club'AND r.scope_id=caw_u('club')AND r.period_start='2026-10-05 07:00Z'AND r.period_end='2026-10-12 07:00Z'AND r.round_no IN(2,3)AND r.result->>'success'='true'AND r.result->>'routing_version'='3'AND r.result->>'source_version'='2'AND r.result->'shortfalls'='0'::jsonb),'actualCoordinatorReceiptPredicate');SELECT caw_assert(NOT EXISTS(SELECT FROM rakeback_period_payouts p WHERE p.status='paid'AND p.paid_at>now()-interval '7 days'AND p.wallet_transaction_id IS NULL AND p.payout_amount>0 AND NOT EXISTS(SELECT FROM smarter_private.existing_rakeback_transfer_allocations a WHERE a.obligation_role='player'AND a.obligation_id=p.rakeback_period_id AND smarter_private.existing_rakeback_transfer_complete('player',p.rakeback_period_id))AND NOT EXISTS(SELECT FROM(SELECT c.id,c.payer_kind FROM accounting_rakeback_period_calculations c WHERE c.period_id=p.rakeback_period_id ORDER BY c.id DESC LIMIT 1)cert WHERE cert.payer_kind='split'AND smarter_private.split_rakeback_payout_complete(p.id,cert.id))),'actualC3PositivePayoutPredicate');")
    # Two committed original callers for each zero stage. Foreign payments were
    # produced by the actual original owners, never manufactured receipt rows.
    q('BEGIN;SELECT zero_seed();'+windows('union','union')+'SELECT '+U2+';SELECT '+U3+';COMMIT;')
    before_bal=q('SELECT caw_balances()').stdout.strip()
    before_legs=q("SELECT jsonb_agg(id ORDER BY id)FROM chip_ledger").stdout.strip()
    before_payouts=q('SELECT count(*)FROM rakeback_period_payouts').stdout.strip()
    before_cs=q('SELECT count(*)FROM agent_commission_settlements').stdout.strip()
    for label,call in [('R2',R2),('R3',R3)]:
        def original_call(_):return json.loads(q("BEGIN;SET LOCAL app.weekly_accounting_chunked='on';SET LOCAL app.weekly_accounting_scope_deadline='2099-01-01';SELECT "+call+';SET CONSTRAINTS ALL IMMEDIATE;COMMIT;').stdout.strip())
        with concurrent.futures.ThreadPoolExecutor(max_workers=2)as pool:answers=list(pool.map(original_call,[0,1]))
        assert sum(x.get('duplicate',False)for x in answers)==1,(label,answers)
        assert q('SELECT caw_balances()').stdout.strip()==before_bal
        assert q("SELECT jsonb_agg(id ORDER BY id)FROM chip_ledger").stdout.strip()==before_legs
        assert q('SELECT count(*)FROM rakeback_period_payouts').stdout.strip()==before_payouts
        assert q('SELECT count(*)FROM agent_commission_settlements').stdout.strip()==before_cs
        results.append({'case':'concurrent-original-zero-'+label+'-one-real-receipt-one-replay-no-money','passed':True})
    metadata=json.loads(q("SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'proconfig',p.proconfig,'acl',p.proacl::text,'volatility',p.provolatile)ORDER BY p.oid::regprocedure::text)FROM pg_proc p WHERE p.oid=ANY(ARRAY['public.fn_settle_accounting_commission_stage(text,uuid,timestamptz,timestamptz)'::regprocedure,'public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamptz,timestamptz)'::regprocedure,'smarter_private.zero_standalone_foreign_commissions_proven(uuid,timestamptz,timestamptz)'::regprocedure])").stdout)
    if A.output:
        A.output.parent.mkdir(parents=True,exist_ok=True);A.output.with_suffix('.postimages.json').write_text(json.dumps(metadata,indent=2));A.output.write_text(json.dumps({'status':'passed','cases':results,'full_inventory_boundary':'controlled native adapter','actual_effective_source_and_original_financial_owners':True,'production_own_basis':'unknown'},indent=2)+'\n')
    print(json.dumps({'status':'passed','cases':results,'actual_main_v3_foreign_paid_original':True,'actual_effective_payable_views':True,'production_own_basis':'unknown'}),flush=True)
finally:
    if started:subprocess.run([str(A.pg_bin/'pg_ctl'),'-D',str(D),'-m','immediate','stop'],env=E,capture_output=True)
    shutil.rmtree(W,ignore_errors=True)
