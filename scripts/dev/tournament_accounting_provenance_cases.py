"""Original tournament accounting provenance over the existing native money fixture."""
from pathlib import Path
import hashlib,importlib.util,json
root=Path(__file__).resolve().parents[2]
directory=root/'tests/fixtures/tournament-accounting-provenance'
spec=importlib.util.spec_from_file_location('tournament_provenance_candidate',directory/'build-candidate.py')
candidate=importlib.util.module_from_spec(spec);spec.loader.exec_module(candidate)
event='c3000000-0000-4000-8000-000000000001'
club='c2000000-0000-4000-8000-000000000001'
runtime_catalog=[]

def install(q):
    global runtime_catalog
    # Schema additions model the current recorded asset/admission columns only.
    q("DO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role','postgres'] LOOP IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('CREATE ROLE %I',r); END IF; END LOOP; END $$;")
    q("""ALTER TABLE clubs ADD COLUMN IF NOT EXISTS asset text DEFAULT 'chips';
    ALTER TABLE clubs ADD COLUMN IF NOT EXISTS is_platform boolean DEFAULT false;
    ALTER TABLE clubs ADD COLUMN IF NOT EXISTS union_id uuid;
    ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS union_id uuid;
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS diamonds numeric DEFAULT 0;
    CREATE TABLE IF NOT EXISTS ca_mtt_admission_contract(singleton boolean PRIMARY KEY,abi text NOT NULL);
    CREATE TABLE IF NOT EXISTS ca_declared_money_triggers(table_name text,trigger_name text,note text,PRIMARY KEY(table_name,trigger_name));
    CREATE TABLE IF NOT EXISTS tournament_felt_supply_acknowledgements(tournament_id uuid PRIMARY KEY,chips numeric);
    INSERT INTO ca_mtt_admission_contract VALUES(true,'legacy-capacity-v1') ON CONFLICT DO NOTHING;""")
    dependencies=json.loads((directory/'captured-dependencies.json').read_text())
    q('SET check_function_bodies=off;\n'+';\n'.join(r['definition'] for r in dependencies)+';')
    if q("SELECT to_regclass('public.tournament_participant_funding_receipts') IS NULL")=='t':
        q((directory/'new-authority.sql').read_text())
    has_prize_owner=q("SELECT to_regclass('public.ca_manual_adjustments') IS NOT NULL")=='t'
    q(';\n'.join(candidate.candidate(r) for r in candidate.rows
      if has_prize_owner or not r['signature'].startswith('fn_settle_tournament_obligation_before'))+'; RESET check_function_bodies;')
    if has_prize_owner:
        q(candidate.original_acl_sql())
        signatures=','.join("'public."+r['signature']+"'::regprocedure" for r in candidate.rows)
        observed=json.loads(q("SELECT json_agg(json_build_object('signature',oid::regprocedure::text,'definition_md5',md5(pg_get_functiondef(oid)),'body_md5',md5(prosrc),'owner',pg_get_userbyid(proowner),'acl',proacl,'config',proconfig) ORDER BY oid::regprocedure::text) FROM pg_proc WHERE oid IN ("+signatures+");"))
        expected={r['signature']:hashlib.md5(candidate.candidate(r).encode()).hexdigest() for r in candidate.rows}
        assert {r['signature']:r['definition_md5'] for r in observed}==expected
        if runtime_catalog: assert runtime_catalog==observed
        runtime_catalog=observed

def funded_assertions(q,expected):
    facts=json.loads(q("""SELECT jsonb_build_object(
      'receipts',count(*),'exact',count(*) FILTER(WHERE f.ledger_snapshot->>'id'=f.ledger_id::text
        AND f.entitlement_snapshot->>'source_ledger_id'=f.ledger_id::text
        AND f.wallet_snapshot->>'id'=f.wallet_transaction_id::text
        AND f.registration_snapshot->>'id'=f.registration_id::text
        AND f.funding_club_id=(f.ledger_snapshot->>'club_id')::uuid
        AND f.user_id=(f.ledger_snapshot->>'from_entity_id')::uuid),
      'amount',sum(amount)) FROM tournament_participant_funding_receipts f;"""))
    assert facts['receipts']==expected and facts['exact']==expected,facts

def prepare_payout(q):
    from tournament_heads_up_payout_cases import prepare
    prepare(q);install(q)

def verify_payout(q,snapshot,variant,chips,check,overlap):
    from tournament_heads_up_payout_cases import verify_launched
    funded_assertions(q,2)
    verify_launched(q,snapshot,variant,chips,check,overlap)
    facts=json.loads(q("""SELECT jsonb_build_object(
      'payments',(SELECT count(*) FROM tournament_accounting_credit_receipts),
      'actual_credit',(SELECT count(*) FROM tournament_accounting_credit_receipts c
        JOIN chip_ledger l ON l.id=c.ledger_id
        JOIN wallet_transactions w ON w.id=c.wallet_transaction_id
        JOIN tournament_payouts p ON p.id=c.payout_id
        WHERE c.amount=380 AND l.amount=c.amount AND w.amount=c.amount
          AND p.amount=c.amount AND c.idempotency_key=p.idempotency_key
          AND c.credited_club_id=l.club_id AND cardinality(c.entry_receipt_ids)=1),
          'original_debt',(SELECT count(*) FROM tournament_obligation_events WHERE operation='INSERT'
            AND asset='chips' AND (after_row->>'amount_owed')::numeric=380 AND (after_row->>'amount_paid')::numeric=0),
        'exact_paid',(SELECT count(*) FROM tournament_obligation_events e
            JOIN tournament_accounting_credit_receipts c ON c.id=e.credit_receipt_id
            WHERE (e.after_row->>'amount_paid')::numeric-(e.before_row->>'amount_paid')::numeric=c.amount
              AND e.transaction_id=c.transaction_id)
    );"""))
    assert facts==dict(payments=1,actual_credit=1,original_debt=1,exact_paid=1),facts
    for table in ['tournament_participant_funding_receipts','tournament_accounting_credit_receipts','tournament_obligation_events']:
        before=snapshot()
        q('DELETE FROM '+table+';','Original tournament accounting evidence is immutable')
        q('TRUNCATE '+table+';','Original tournament accounting evidence is immutable')
        assert snapshot()==before
    assert q("SELECT has_table_privilege('authenticated','public.tournament_participant_funding_receipts','INSERT') OR has_function_privilege('service_role','public.fn_ca_record_tournament_participant_funding(uuid,text,text,numeric,text,uuid,uuid,jsonb)','EXECUTE')")=='f'
    check(variant+' '+str(chips)+': exact original entry, award, obligation, zero remaining, replay and immutability evidence')

def verify(q,fresh,overlap,register,check):
    # Existing charge/purchase tests retain their transaction and concurrency assertions.
    from tournament_purchase_funding_cases import verify as purchases
    def source_fresh(name,cap=100):
        fresh(name,cap);install(q)
    purchases(q,source_fresh,overlap,register,check,prepare=install,
              after_funded=lambda q,kind:funded_assertions(q,2))
    check('original entry/rebuy/reentry/addon receipts retain exact charged registration and ledger')

    from tournament_heads_up_funding_cases import verify as hu
    hu(q,fresh,overlap,register,check,prepare=prepare_payout,
       after_launch=lambda q,snapshot,variant,chips,check:verify_payout(q,snapshot,variant,chips,check,overlap))

def verify_identity_cases(q,fresh,register,check):
    fresh('original_provenance_identity');install(q)
    original=next(r for r in candidate.rows if r['signature'].startswith('fn_register_for_tournament_before_atomic_capacity'))
    q(original['definition']+';')
    assert json.loads(q(register(1,1))).get('ok') is True
    assert q("SELECT count(*) FROM tournament_participant_funding_receipts")=='0'
    assert q("SELECT count(*) FROM tournament_refund_entitlements WHERE registration_id IS NULL")=='1'
    check('red proof: original admission produces charge evidence with no actual registration binding')
    install(q)
    assert q("SELECT count(*) FROM tournament_participant_funding_receipts")=='0'
    q("""INSERT INTO clubs(id) VALUES('c2000000-0000-4000-8000-000000000002');
    INSERT INTO club_members(club_id,user_id,chip_balance,status,role,joined_at)
    VALUES('c2000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000002',1000,'active','player','2000-01-01');
    UPDATE profiles SET is_horse=true WHERE id='c1000000-0000-4000-8000-000000000002';""")
    assert json.loads(q(register(2,2))).get('ok') is True
    funded_assertions(q,1)
    assert q("SELECT funding_club_id::text FROM tournament_participant_funding_receipts")==club
    before=q("SELECT md5(jsonb_agg(to_jsonb(f))::text) FROM tournament_participant_funding_receipts f")
    q("UPDATE club_members SET status='left' WHERE user_id='c1000000-0000-4000-8000-000000000002' AND club_id='"+club+"'")
    assert q("SELECT md5(jsonb_agg(to_jsonb(f))::text) FROM tournament_participant_funding_receipts f")==before
    check('prospective horse entry binds the charged club exactly; later membership changes cannot rewrite it or backfill the legacy entry')
    tables=['club_members','chip_ledger','wallet_transactions','tournament_refund_entitlements','tournament_escrow','tournament_players','tournaments','rake_records','entry_purchase_idempotency_receipts','tournament_participant_funding_receipts']
    state="SELECT md5(jsonb_build_array("+','.join("(SELECT jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text) FROM "+t+" r)" for t in tables)+")::text)"
    before=q(state)
    capture=next(r for r in candidate.rows if r['signature']=='fn_ca_capture_tournament_charge_entitlement()')
    q(capture['definition']+';')
    q(register(3,3),'Original tournament funding references do not match')
    q(candidate.candidate(capture)+';')
    assert q(state)==before
    check('missing exact original debit reference refuses and rolls back the entire entry transaction')
    q('UPDATE tournaments SET buy_in_amount=0,buy_in_fee=0')
    assert json.loads(q(register(3,3))).get('ok') is True
    assert q("SELECT count(*) FROM tournament_participant_funding_receipts WHERE amount=0 AND ledger_id IS NULL AND entitlement_id IS NULL")=='1'
    assert q("SELECT count(*) FROM chip_ledger")=='2'
    assert q("SELECT count(*) FROM tournament_participant_funding_receipts WHERE transaction_id IS NOT NULL")=='2'
    check('zero-charge original admission retains explicit zero evidence without a fabricated ledger or historical receipt')
    q("UPDATE clubs SET asset='diamonds',is_platform=true WHERE id='"+club+"'")
    assert json.loads(q(register(4,4))).get('ok') is True
    assert q("SELECT count(*) FROM tournament_participant_funding_receipts WHERE amount=0 AND asset='diamonds' AND ledger_id IS NULL AND entitlement_id IS NULL")=='1'
    assert q('SELECT count(*) FROM chip_ledger')=='2'
    check('free entry retains the original Diamond instrument without a chip or custody debit')

def verify_acl(q,fresh,check):
    fresh('original_provenance_acl')
    from tournament_heads_up_payout_cases import install_archive
    install_archive(q,(root/'scripts/dev/fixtures/heads-up-payout/installed.sql').read_text())
    install(q)
    before=q("SELECT jsonb_object_agg(oid::text,proowner::text) FROM pg_proc WHERE pronamespace='public'::regnamespace")
    q(candidate.original_acl_sql())
    assert q("SELECT jsonb_object_agg(oid::text,proowner::text) FROM pg_proc WHERE pronamespace='public'::regnamespace")==before
    for r in candidate.rows:
        sig='public.'+r['signature']
        actual=json.loads(q("SELECT jsonb_build_object('anon',has_function_privilege('anon','"+sig+"','EXECUTE'),'authenticated',has_function_privilege('authenticated','"+sig+"','EXECUTE'),'service_role',has_function_privilege('service_role','"+sig+"','EXECUTE'),'postgres',has_function_privilege('postgres','"+sig+"','EXECUTE'))"))
        assert actual==dict(anon=False,authenticated=False,service_role=r['signature'].startswith('log_wallet_transaction('),postgres=True),(sig,actual)
    for sig in ['fn_ca_tournament_accounting_evidence_immutable()','fn_ca_capture_tournament_credit_ledger()','fn_ca_record_tournament_participant_funding(uuid,text,text,numeric,text,uuid,uuid,jsonb)','fn_ca_record_tournament_accounting_credit(text,uuid,uuid,numeric,uuid,uuid,uuid)','fn_ca_capture_tournament_obligation_event()']:
        assert q("SELECT has_function_privilege('anon','public."+sig+"','EXECUTE') OR has_function_privilege('authenticated','public."+sig+"','EXECUTE') OR has_function_privilege('service_role','public."+sig+"','EXECUTE')")=='f'
        assert q("SELECT has_function_privilege('postgres','public."+sig+"','EXECUTE')")=='t'
    check('explicit original and helper ACLs preserve owner identity, deny browser callers, and retain only the original log-wallet service grant')

def verify_horse(q,fresh,check):
    """Real engine-facing horse caller, including its unchanged wrapper chain."""
    spec=importlib.util.spec_from_file_location('original_horse_candidate',directory/'build-horse-candidate.py')
    horse=importlib.util.module_from_spec(spec);spec.loader.exec_module(horse)
    fresh('original_horse_funding');install(q)
    import re
    schema=(root/'tests/fixtures/full-weekly-accounting/schema.sql').read_text()
    table=re.search(r'CREATE TABLE "public"[.]"tournament_satellite_settlements".*?;',schema,re.S)
    assert table,'Original ticket lookup relation must be retained'
    q(table.group())
    deps=json.loads((directory/'captured-horse-dependencies.json').read_text())
    q('SET check_function_bodies=off;\n'+';\n'.join(r['definition'] for r in deps+horse.rows)+'; RESET check_function_bodies;')
    q("UPDATE profiles SET is_horse=true; SET test.actor='c1000000-0000-4000-8000-000000000001';")
    def register(n):return "SELECT public.fn_register_horse_for_tournament('"+event+"','c1000000-0000-4000-8000-"+str(n).zfill(12)+"');"
    assert json.loads(q(register(1))).get('ok') is True
    assert q('SELECT count(*) FROM tournament_participant_funding_receipts')=='0'
    assert q('SELECT count(*) FROM tournament_refund_entitlements')=='1'
    check('red proof: actual public horse caller charged and registered without an original funding receipt')
    q(horse.candidate()+';')
    assert q('SELECT count(*) FROM tournament_participant_funding_receipts')=='0'
    q("INSERT INTO clubs(id) VALUES('c2000000-0000-4000-8000-000000000002'); INSERT INTO club_members(club_id,user_id,chip_balance,status,role,joined_at) VALUES('c2000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000002',1000,'active','player','2000-01-01');")
    result=json.loads(q(register(2)))
    assert result.get('ok') is True,result
    funded_assertions(q,1)
    assert q("SELECT amount=200 AND funding_club_id='"+club+"' AND registration_id='"+result['registration_id']+"' AND operation='entry' FROM tournament_participant_funding_receipts")=='t'
    assert q("SELECT chip_balance FROM club_members WHERE user_id='c1000000-0000-4000-8000-000000000002' AND club_id='"+club+"'")=='300.00'
    assert q("SELECT chip_balance FROM club_members WHERE club_id='c2000000-0000-4000-8000-000000000002'")=='1000.00'
    tables=['club_members','chip_ledger','wallet_transactions','tournament_refund_entitlements','tournament_escrow','tournament_players','tournaments','rake_records','tournament_participant_funding_receipts']
    state="SELECT md5(jsonb_build_array("+','.join("(SELECT jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text) FROM "+t+" r)" for t in tables)+")::text)"
    before=q(state)
    assert json.loads(q(register(2))).get('reason')=='already_registered'
    assert q(state)==before
    check('actual public horse entry retains one exact charged-club debit and registration; repeat creates no money or second evidence')
    original_capture=next(r for r in candidate.rows if r['signature']=='fn_ca_capture_tournament_charge_entitlement()')
    q(original_capture['definition']+';')
    before=q(state)
    q(register(3),'Original tournament funding references do not match')
    assert q(state)==before
    q(candidate.candidate(original_capture)+';')
    check('missing exact horse debit capture refuses and rolls back every original financial and roster write')
    q("UPDATE tournaments SET buy_in_amount=0,buy_in_fee=0")
    result=json.loads(q(register(3)))
    assert result.get('ok') is True,result
    assert q("SELECT count(*) FROM tournament_participant_funding_receipts WHERE registration_id='"+result['registration_id']+"' AND amount=0 AND asset='chips' AND entitlement_id IS NULL AND ledger_id IS NULL AND wallet_transaction_id IS NULL")=='1'
    assert q('SELECT count(*) FROM chip_ledger')=='2'
    check('original zero-price horse entry has explicit zero evidence and no fabricated debit')
