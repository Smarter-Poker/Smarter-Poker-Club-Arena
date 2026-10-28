#!/usr/bin/env python3
"""Actual event guard and unchanged private reserve TEMP privilege regression.
Controlled native clock/governance boundaries; no production access.
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
    cmd([A.pg_bin/'pg_ctl','-D',D,'-l',W/'server.log','-w','start','-o',f"-k '' -p {port} -h 127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c track_functions=all"]);started=True
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
    fixture=R/'scripts/ci/fixtures/runtime-privileges'
    load(R/'supabase/migrations/20261027070115_historical_agent_roles_keep_their_earned_commission.sql')
    for n in ['rakeback_certificate_payers','deleted_wallet_published_rakeback_reserve']:load(fixture/(n+'.sql'))
    load(fixture/'installed-reserve-migration.sql')
    assert q("SELECT md5(pg_get_functiondef('smarter_private.deleted_reserve_certificate_payers(bigint)'::regprocedure))").stdout.strip()=='c2a3aedb97cf5782be7e9bc7a2a6e03b'
    q("""CREATE TABLE ca_break_window_migration_overrides(txid bigint,reason text,session_role text,application_name text,first_command text,query_snippet text);
    CREATE SCHEMA IF NOT EXISTS supabase_migrations;CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations(version text,name text);
    CREATE FUNCTION fn_ca_break_window_governs(text,text)RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
    CREATE FUNCTION fn_ca_break_window_refuses_migrations(timestamptz)RETURNS text LANGUAGE sql STABLE AS $$SELECT CASE WHEN current_setting('test.ddl_boundary',true)IN('break','freeze')THEN 'controlled original break/freeze boundary'END$$;
    CREATE FUNCTION fn_ca_stage_b_ledger_bootstrap_allowed(text,text,text)RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.bootstrap',true)='on'$$;
    CREATE TABLE persistent_guard_target(x int);
    """)
    load(fixture/'original-event-guard.sql')
    q("REVOKE ALL ON FUNCTION fn_ca_break_window_ddl_guard()FROM PUBLIC,anon,authenticated;GRANT EXECUTE ON FUNCTION fn_ca_break_window_ddl_guard()TO service_role;CREATE EVENT TRIGGER native_ddl_guard ON ddl_command_end EXECUTE FUNCTION fn_ca_break_window_ddl_guard();CREATE EVENT TRIGGER native_drop_guard ON sql_drop EXECUTE FUNCTION fn_ca_break_window_ddl_guard();")
    meta=lambda:q("SELECT jsonb_build_array(proowner,prosecdef,proconfig,proacl::text,provolatile,proparallel,proisstrict,proretset)FROM pg_proc WHERE oid='fn_ca_break_window_ddl_guard()'::regprocedure").stdout.strip()
    original_meta=meta()
    helper="SELECT *FROM smarter_private.deleted_reserve_certificate_payers((SELECT id FROM accounting_rakeback_period_calculations WHERE payer_kind='split'LIMIT 1));"
    seed="BEGIN;SELECT ed_seed();SET LOCAL test.ddl_boundary='break';"
    old=q(seed+helper+'ROLLBACK;',check=False)
    assert old.returncode and 'migration refused' in old.stderr and 'REVOKE was refused' in old.stderr,old.stderr
    results.append({'case':'actual-original-event-guard-refuses-actual-reserve-temp-REVOKE','passed':True})
    migration=(R/'supabase/migrations/20261027165306_privilege_changes_do_not_reload_the_schema.sql').read_text()
    
    q(migration.rsplit('COMMIT;',1)[0]+'ROLLBACK;')
    assert q("SELECT md5(pg_get_functiondef('fn_ca_break_window_ddl_guard()'::regprocedure))").stdout.strip()=='40659a691919fbc55fe90f18827c834a'
    q(migration);assert meta()==original_meta
    replay=q(migration,check=False);assert replay.returncode and 'runtime_privilege_guard_preimage_changed'in replay.stderr
    results.append({'case':'exact-atomic-rollback-install-postimage-all-metadata-ACL-replay-refusal','passed':True})
    actual=q(seed+helper+"SELECT caw_assert(NOT has_table_privilege('service_role','pg_temp._deleted_reserve_payer_proofs','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),'privatecacheACLretained');SELECT caw_assert((SELECT count(*)FROM pg_temp._deleted_reserve_payer_proofs)=1,'actualvalidatorcache');ROLLBACK;",check=False)
    assert actual.returncode==0,actual.stderr
    assert q("SELECT md5(pg_get_functiondef('smarter_private.deleted_reserve_certificate_payers(bigint)'::regprocedure))").stdout.strip()=='c2a3aedb97cf5782be7e9bc7a2a6e03b'
    results.append({'case':'actual-unchanged-reserve-helper-and-validator-complete-during-break-with-private-ACL','passed':True})
    for boundary in ['break','freeze']:
        for command in ['CREATE TABLE public.must_refuse(x int);','ALTER TABLE public.persistent_guard_target ADD COLUMN must_refuse int;','DROP TABLE public.persistent_guard_target;']:
            refused=q("SET test.ddl_boundary='"+boundary+"';"+command,check=False);assert refused.returncode and 'migration refused'in refused.stderr,(command,refused.stderr)
            results.append({'case':boundary+'-public-'+command.split()[0]+'-still-refuses','passed':True})
    q("SET test.ddl_boundary='break';CREATE TEMP TABLE runtime_acl(x int);GRANT SELECT ON runtime_acl TO service_role;REVOKE ALL ON runtime_acl FROM service_role;GRANT SELECT ON public.persistent_guard_target TO service_role;REVOKE ALL ON public.persistent_guard_target FROM service_role;")
    results.append({'case':'temp-and-public-privilege-churn-follows-existing-owner-rule5','passed':True})
    mixed=q("BEGIN;SET LOCAL test.ddl_boundary='break';CREATE TEMP TABLE mixed_temp(x int);GRANT SELECT ON mixed_temp TO service_role;REVOKE SELECT ON mixed_temp FROM service_role;CREATE TABLE public.must_refuse(x int);COMMIT;",check=False)
    assert mixed.returncode and 'migration refused'in mixed.stderr,mixed.stderr
    assert q("SELECT to_regclass('public.must_refuse')IS NULL").stdout.strip()=='t'
    assert q("SELECT count(*)FROM ca_break_window_migration_overrides").stdout.strip()=='0'
    results.append({'case':'mixed-ACL-then-public-DDL-refuses-entire-transaction-no-override-marker','passed':True})
    q("SET test.ddl_boundary='break';SET ca.break_window_migration_override='on';CREATE TABLE public.must_refuse(x int);",check=False)
    assert q("SELECT to_regclass('public.must_refuse')IS NULL").stdout.strip()=='t'
    results.append({'case':'boolean-override-still-cannot-admit-public-DDL','passed':True})
    q("BEGIN;SET LOCAL test.ddl_boundary='break';SET LOCAL ca.break_window_migration_override='native original emergency contract';CREATE TABLE public.existing_emergency_contract(x int);COMMIT;")
    assert q("SELECT count(*)FROM ca_break_window_migration_overrides WHERE reason='native original emergency contract'").stdout.strip()=='1'
    results.append({'case':'original-explicit-emergency-reason-audit-persists-unchanged','passed':True})
    q("BEGIN;SET LOCAL test.ddl_boundary='break';SET LOCAL test.bootstrap='on';ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS name text;COMMIT;")
    assert q("SELECT count(*)FROM ca_break_window_migration_overrides WHERE reason LIKE'Stage-B transport:%'").stdout.strip()=='1'
    results.append({'case':'original-narrow-bootstrap-audit-preserved','passed':True})
    q("CREATE TABLE public.outside_window(x int);ALTER TABLE public.outside_window ADD COLUMN y int;DROP TABLE public.outside_window;")
    results.append({'case':'outside-boundary-public-DDL-still-works','passed':True})
    rows=q("SELECT jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(proowner),'config',proconfig,'acl',proacl::text,'definer',prosecdef,'volatility',provolatile,'parallel',proparallel,'strict',proisstrict,'set',proretset)FROM pg_proc p WHERE oid='fn_ca_break_window_ddl_guard()'::regprocedure").stdout.strip()
    result={'status':'passed','cases':results,'guard_postimage':json.loads(rows),'actual_postgresql_event_triggers':True,'actual_reserve_helper_unchanged':True,'clock_governance_bootstrap_boundary':'controlled-native-adapters-not-production-certification'}
    if A.output:A.output.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result),flush=True)
finally:
    if started: subprocess.run([str(A.pg_bin/'pg_ctl'),'-D',str(D),'-m','immediate','stop'],env=E,capture_output=True)
    shutil.rmtree(W,ignore_errors=True)
