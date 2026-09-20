"""Direct native controls for the finite original Breakfast request.

This module only receives the existing private PG17 Execution owner. It has no
connection, credential, production command or alternate execution interface.
"""
import json
from breakfast_original_witness import js, literal

EVENT = 'f370585d-40ea-4085-bb8f-c7e8c74f3fb4'
TARGET = '9ee591b7-2360-4ea8-ad3b-942ef829fbda'
WINNER = 'ae0bc48d-f98c-4b25-a9fa-e3522f986173'
OPERATION = 'b0000000-0000-4000-8000-000000000001'

SNAPSHOT = """
CREATE FUNCTION pg_temp.breakfast_state() RETURNS jsonb LANGUAGE plpgsql AS $state$
DECLARE r record; v jsonb; result jsonb := '{}';
BEGIN
 FOR r IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN ('public','auth','smarter_private') AND c.relkind IN ('r','p') ORDER BY 1,2 LOOP
  EXECUTE format('SELECT jsonb_build_object(''count'',count(*),''md5'',md5(COALESCE(string_agg(to_jsonb(t)::text,E''\\n'' ORDER BY to_jsonb(t)::text),''''))) FROM %I.%I t',r.nspname,r.relname) INTO v;
  result := result || jsonb_build_object(r.nspname||'.'||r.relname,v);
 END LOOP;
 RETURN result;
END $state$;
"""


def state(e, db, label):
    _, stdout, _ = e.sql(db, SNAPSHOT+'SELECT pg_temp.breakfast_state();', label=label)
    return json.loads(stdout.strip())


def qualify_installer(e, template, migration):
    cases = [
        ('guard-body', "DO $drift$ DECLARE d text; BEGIN SELECT pg_get_functiondef('smarter_private.f06_source_guard()'::regprocedure) INTO d; IF position('RETURN NEW' IN d)=0 THEN RAISE EXCEPTION 'guard seam absent'; END IF; EXECUTE replace(d,'RETURN NEW','RETURN NULL'); END $drift$;", 'BREAKFAST_INSTALLED_AUTHORITY_CHANGED'),
        ('guard-disabled', 'ALTER TABLE public.table_seats DISABLE TRIGGER a00_f06_source_seat;', 'BREAKFAST_INSTALLED_GUARD_CHANGED'),
        ('guard-acl', 'GRANT EXECUTE ON FUNCTION smarter_private.f06_source_guard() TO authenticated;', 'BREAKFAST_INSTALLED_AUTHORITY_CHANGED'),
    ]
    for label, mutation, message in cases:
        db=e.database(template)
        e.sql(db,mutation,label='installer-drift-'+label)
        before=state(e,db,'installer-data-before-'+label)
        before_catalog=e.catalog_snapshot(db,'installer-catalog-before-'+label)
        private_query="SELECT coalesce(jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),p.proacl,p.proconfig) ORDER BY p.oid),'[]') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='smarter_private' AND p.prokind='f';"
        _, private_before, _=e.sql(db,private_query,label='installer-private-before-'+label)
        code,_,stderr=e.sql(db,file=migration,label='installer-refuse-'+label,check=False)
        if code!=3 or message not in stderr:
            raise AssertionError('installer did not refuse exact dependency drift: '+label)
        if before!=state(e,db,'installer-data-after-'+label) or before_catalog!=e.catalog_snapshot(db,'installer-catalog-after-'+label):
            raise AssertionError('failed installer changed data/catalog: '+label)
        _, private_after, _=e.sql(db,private_query,label='installer-private-after-'+label)
        if private_before!=private_after:
            raise AssertionError('failed installer changed private authority')
        e.discard(db)
        e.report['migration_refusals'].append({'case':label,'passed':True,'catalog_and_data_unchanged':True})


def call(expected, operation=OPERATION):
    return "public.fn_complete_breakfast_original_witness('"+operation+"',"+js(expected)+")"


def refusal(e, db, label, expression, expected_error, setup='', role='service_role'):
    # State corruption is a private fixture precondition, not a weakened live
    # guard. The attempted request always runs with every trigger enabled.
    sql = "BEGIN;\n" + SNAPSHOT
    if setup:
        sql += "SET LOCAL session_replication_role=replica;\n"+setup+"\nSET LOCAL session_replication_role=origin;\n"
    sql += "SELECT set_config('request.jwt.claims',"+js({'role': role})+"::text,true);\n"
    sql += "DO $test$ DECLARE before_state jsonb; msg text; BEGIN\n before_state:=pg_temp.breakfast_state();\n BEGIN\n PERFORM "+expression+";\n RAISE EXCEPTION 'EXPECTED_REFUSAL_DID_NOT_OCCUR';\n EXCEPTION WHEN OTHERS THEN\n GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;\n IF position("+literal(expected_error)+" IN msg)=0 THEN RAISE EXCEPTION 'WRONG_REFUSAL: %',msg; END IF;\n END;\n IF pg_temp.breakfast_state() IS DISTINCT FROM before_state THEN RAISE EXCEPTION 'FAILED_REQUEST_CHANGED_STATE'; END IF;\n RAISE NOTICE 'BREAKFAST_CASE_PASS: "+label+"';\n END $test$;\nROLLBACK;\n"
    path=e.output/(label+'.sql');path.write_text(sql)
    _,_,stderr=e.sql(db,file=path,label=label)
    if 'BREAKFAST_CASE_PASS: '+label not in stderr:
        raise AssertionError('native completion marker absent: '+label)
    e.report['native'].append({'case':label,'passed':True,'rollback_all_public_auth_private_rows':True})


def qualify_refusals(e, db, expected):
    expression=call(expected)
    refusal(e,db,'unprivileged-request',expression,'service authority required',role='authenticated')
    refusal(e,db,'operation-required',"public.fn_complete_breakfast_original_witness(NULL,"+js(expected)+")",'BREAKFAST_REQUEST_REQUIRED')
    refusal(e,db,'expected-object-required',"public.fn_complete_breakfast_original_witness('"+OPERATION+"',NULL)",'BREAKFAST_REQUEST_REQUIRED')
    variants=[
      ('maintenance-freeze',"INSERT INTO public.engine_maintenance_break(id,phase,announced_at,reason,updated_at,enforce_freeze,ownership_token) VALUES(true,'last_hand',clock_timestamp()-interval '3 minutes','private regression',now(),true,gen_random_uuid()) ON CONFLICT(id) DO UPDATE SET phase='last_hand',announced_at=excluded.announced_at,break_started_at=NULL,break_ends_at=NULL,enforce_freeze=true;",'PLATFORM_FROZEN'),
      ('event-pool-drift',"UPDATE public.tournaments SET prize_pool=154 WHERE id='"+EVENT+"';",'BREAKFAST_EVENT_CHANGED'),
      ('event-positive-field-drift',"UPDATE public.tournaments SET current_players=3 WHERE id='"+EVENT+"';",'BREAKFAST_EVENT_CHANGED'),
      ('target-positive-drift',"UPDATE public.tournament_players SET chips=1 WHERE tournament_id='"+EVENT+"' AND user_id='"+TARGET+"';",'BREAKFAST_ORIGINAL_ROSTER_OR_ENTRY_CHANGED'),
      ('original-standing-drift',"UPDATE public.tournament_players SET position=21 WHERE tournament_id='"+EVENT+"' AND position=22;",'BREAKFAST_ORIGINAL_ROSTER_OR_ENTRY_CHANGED'),
      ('original-entry-drift',"UPDATE public.tournament_entry_close_receipts SET final_prize_pool=154 WHERE tournament_id='"+EVENT+"';",'BREAKFAST_ORIGINAL_ROSTER_OR_ENTRY_CHANGED'),
      ('original-paid-drift',"UPDATE public.tournament_payouts SET amount=amount+0.01 WHERE tournament_id='"+EVENT+"' AND position=2;",'BREAKFAST_PAID_EVIDENCE_CHANGED'),
      ('original-obligation-drift',"UPDATE public.tournament_obligations SET amount_paid=amount_paid-0.01 WHERE tournament_id='"+EVENT+"' AND place=2;",'BREAKFAST_OBLIGATIONS_CHANGED'),
      ('original-credit-key-drift',"DELETE FROM public.wallet_credit_idempotency WHERE key LIKE 'tourney:"+EVENT+":%' AND key=(SELECT min(key) FROM public.wallet_credit_idempotency WHERE key LIKE 'tourney:"+EVENT+":%');",'BREAKFAST_CREDIT_EVIDENCE_CHANGED'),
      ('original-fee-charge-drift',"UPDATE public.rake_records SET rake_amount=rake_amount+0.01 WHERE tournament_id='"+EVENT+"' AND id=(SELECT min(id::text)::uuid FROM public.rake_records WHERE tournament_id='"+EVENT+"');",'BREAKFAST_FEE_CHARGE_CHANGED'),
      ('physical-seat-incarnation-drift',"UPDATE public.table_seats SET occupancy_id=gen_random_uuid() WHERE id='41cef73d-6c47-4241-a2da-9ed9572059ad';",'BREAKFAST_PHYSICAL_ROSTER_CHANGED'),
      ('physical-current-table-drift',"UPDATE public.tables SET f06_lifecycle=f06_lifecycle+1 WHERE id='dd835bad-d3c8-4984-ab2f-5ed52d1fb664';",'BREAKFAST_PHYSICAL_ROSTER_CHANGED'),
      ('retained-historical-snapshot-drift',"UPDATE public.hand_state_snapshots SET state_json=state_json||'{\"fixture_drift\":true}'::jsonb WHERE id='b563669d-16fe-4d1b-90f3-dde43810aa4d';",'BREAKFAST_LATER_AUTHORITY_OR_HAND_STATE'),
      ('new-table-owner',"INSERT INTO public.engine_table_leases(table_id,instance_id,protocol_version) VALUES('dd835bad-d3c8-4984-ab2f-5ed52d1fb664','fixture-new-owner',2);",'BREAKFAST_LATER_AUTHORITY_OR_HAND_STATE'),
      ('new-accepted-hand',"INSERT INTO public.hand_history(table_id,tournament_id,hand_number) VALUES('dd835bad-d3c8-4984-ab2f-5ed52d1fb664','"+EVENT+"',9000000);",'BREAKFAST_LATER_AUTHORITY_OR_HAND_STATE'),
      ('new-original-hand-permit',"INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation,state) VALUES(gen_random_uuid(),'"+EVENT+"','dd835bad-d3c8-4984-ab2f-5ed52d1fb664',9657,9000000,gen_random_uuid(),'9ed1f403-1f1c-47df-98f6-07a2aa99f500','reserved');",'BREAKFAST_LATER_AUTHORITY_OR_HAND_STATE'),
      ('funding-changed',"UPDATE public.tournament_escrow SET gross_in=gross_in+1 WHERE tournament_id='"+EVENT+"';",'BREAKFAST_FUNDING_CHANGED'),
    ]
    for label,setup,error in variants:
        refusal(e,db,label,expression,error,setup)
    changed=json.loads(json.dumps(expected));changed['manager']=[]
    refusal(e,db,'manager-cannot-be-inferred-absent',call(changed),'BREAKFAST_MANAGER_CHANGED')
    changed=json.loads(json.dumps(expected));changed['roster']=changed['roster'][1:]
    refusal(e,db,'partial-roster-refused',call(changed),'BREAKFAST_ORIGINAL_ROSTER_OR_ENTRY_CHANGED')


def closure_sql(root):
    """Independent fixed expected amounts; no derivation from returned success."""
    from breakfast_original_witness import DATA
    old_ledger=json.loads((root/DATA/'full-chip-ledger.json').read_text())['evidence']['ledger']
    old_wallets=json.loads((root/DATA/'full-wallet-transactions.json').read_text())['evidence']['wallets']
    return """DO $closed$
DECLARE r jsonb; retained jsonb; original jsonb; actual jsonb; fee jsonb;
BEGIN
 retained:=smarter_private.breakfast_retained_case();
 r:=public.fn_ca_tournament_terminal_receipt('"""+EVENT+"""','"""+WINNER+"""');
 IF r->>'ok' IS DISTINCT FROM 'true'
 OR r->>'player_result' IS DISTINCT FROM 'final'
 OR r->>'fully_settled' IS DISTINCT FROM 'false'
 OR r->>'accounting_complete' IS DISTINCT FROM 'false'
 OR r->>'accounting_state' IS DISTINCT FROM 'fee_custody_unresolved'
 OR r->>'receipt_version' IS DISTINCT FROM '3'
 OR NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id='"""+EVENT+"""' AND status='COMPLETED')
 OR (SELECT count(*) FROM public.tournament_terminal_settlements WHERE tournament_id='"""+EVENT+"""')<>1
 OR (SELECT count(*) FROM smarter_private.breakfast_original_witness WHERE tournament_id='"""+EVENT+"""')<>1
 OR (SELECT cash_receipt->'original_witness' FROM public.tournament_terminal_settlements WHERE tournament_id='"""+EVENT+"""')
 IS DISTINCT FROM smarter_private.breakfast_standings_witness('"""+EVENT+"""','"""+WINNER+"""') THEN
 RAISE EXCEPTION 'BREAKFAST_REAL_TERMINAL_RECEIPT_MISSING'; END IF;
 SELECT jsonb_agg(v ORDER BY v->>'id') INTO original FROM jsonb_array_elements(retained->'roster') v
 WHERE v->>'user_id' NOT IN('"""+TARGET+"""','"""+WINNER+"""');
 SELECT jsonb_agg(v ORDER BY v->>'id') INTO actual FROM jsonb_array_elements(smarter_private.breakfast_roster('"""+EVENT+"""')) v
 WHERE v->>'user_id' NOT IN('"""+TARGET+"""','"""+WINNER+"""');
 IF actual IS DISTINCT FROM original OR jsonb_array_length(actual)<>32
 OR NOT EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id='"""+EVENT+"""' AND user_id='"""+TARGET+"""' AND status='eliminated' AND position=21 AND chips=0 AND prize=0)
 OR NOT EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id='"""+EVENT+"""' AND user_id='"""+WINNER+"""' AND status='winner' AND position=1 AND chips=430255 AND prize=53.12)
 OR (SELECT count(DISTINCT position) FROM public.tournament_players WHERE tournament_id='"""+EVENT+"""')<>34 THEN
 RAISE EXCEPTION 'BREAKFAST_ORIGINAL_PLACES_OR_CHIPS_REWRITTEN'; END IF;
 SELECT jsonb_agg(v-'terminal_closed_at' ORDER BY v->>'id') INTO original FROM jsonb_array_elements(retained->'payouts') v;
 SELECT jsonb_agg(to_jsonb(p)-'terminal_closed_at' ORDER BY id) INTO actual FROM public.tournament_payouts p
 WHERE tournament_id='"""+EVENT+"""' AND position BETWEEN 2 AND 5;
 IF actual IS DISTINCT FROM original OR jsonb_array_length(actual)<>4
 OR (SELECT count(*) FROM public.tournament_payouts WHERE tournament_id='"""+EVENT+"""')<>5
 OR (SELECT sum(amount) FROM public.tournament_payouts WHERE tournament_id='"""+EVENT+"""')<>153
 OR (SELECT count(*) FROM public.tournament_payouts WHERE tournament_id='"""+EVENT+"""' AND user_id='"""+WINNER+"""' AND amount=53.12 AND position=1)<>1 THEN
 RAISE EXCEPTION 'BREAKFAST_PAID_PRIZES_CHANGED_OR_DUPLICATED'; END IF;
 SELECT jsonb_agg(v-'terminal_closed_at' ORDER BY v->>'id') INTO original FROM jsonb_array_elements(retained->'obligations') v;
 SELECT jsonb_agg(to_jsonb(o)-'terminal_closed_at' ORDER BY id) INTO actual FROM public.tournament_obligations o
 WHERE tournament_id='"""+EVENT+"""' AND place BETWEEN 2 AND 5;
 IF actual IS DISTINCT FROM original THEN RAISE EXCEPTION 'BREAKFAST_PAID_OBLIGATIONS_REWRITTEN'; END IF;
 SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) INTO actual FROM public.hand_state_snapshots s
 WHERE s.id IN(SELECT (v->>'id')::uuid FROM jsonb_array_elements(retained->'historical_snapshots') v);
 IF actual IS DISTINCT FROM retained->'historical_snapshots' THEN RAISE EXCEPTION 'BREAKFAST_OLD_SNAPSHOTS_CHANGED'; END IF;
 IF EXISTS(SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id WHERE t.tournament_id='"""+EVENT+"""' AND (s.left_at IS NULL OR s.status<>'left'))
 OR EXISTS(SELECT 1 FROM public.tables WHERE tournament_id='"""+EVENT+"""' AND status<>'closed')
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits a JOIN public.tables t ON t.id=a.table_id WHERE t.tournament_id='"""+EVENT+"""')
 OR EXISTS(SELECT 1 FROM public.tournament_knockout_candidates WHERE tournament_id='"""+EVENT+"""') THEN
 RAISE EXCEPTION 'BREAKFAST_PHYSICAL_CLOSURE_OR_FICTIONAL_HAND'; END IF;
 -- Player prizes are final while the original fee stays visibly unresolved.
 -- This must not encourage draining fees to manufacture a zero-escrow result.
 IF NOT EXISTS(SELECT 1 FROM public.tournament_escrow WHERE tournament_id='"""+EVENT+"""'
 AND prize_out=153 AND prize_balance=0 AND fee_balance=17 AND fee_out=0
 AND bounty_balance=0 AND closed_at IS NULL AND terminal_closed_at IS NOT NULL)
 OR NOT EXISTS(SELECT 1 FROM public.tournament_terminal_settlements WHERE tournament_id='"""+EVENT+"""'
 AND receipt_version=3 AND accounting_state='fee_custody_unresolved'
 AND rake_destination='tournament_escrow' AND rake_amount=17 AND rake_settled_at IS NULL
 AND rake_attributed_at IS NULL AND rake_attributed_users=0 AND escrow_closed_at IS NULL)
 OR EXISTS(SELECT 1 FROM public.tournament_rake_settlements WHERE tournament_id='"""+EVENT+"""')
 OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions WHERE tournament_id='"""+EVENT+"""')
 OR EXISTS(SELECT 1 FROM public.accounting_tournament_recognized_sources WHERE tournament_id='"""+EVENT+"""')
 OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_custody_resolutions WHERE tournament_id='"""+EVENT+"""')
 OR (SELECT count(*) FROM public.accounting_tournament_fee_custody_obligations WHERE tournament_id='"""+EVENT+"""')<>1 THEN
 RAISE EXCEPTION 'BREAKFAST_ORIGINAL_FEE_CUSTODY_CHANGED'; END IF;
 fee:=public.fn_ca_tournament_fee_custody_receipt('"""+EVENT+"""');
 IF fee->>'status' IS DISTINCT FROM 'fee_custody_unresolved'
 OR fee->>'source_fingerprint' IS DISTINCT FROM 'f67bf12ee0b00c954b6f8403de9718fe'
 OR fee->>'source_count' IS DISTINCT FROM '34'
 OR (fee->>'held_amount')::numeric IS DISTINCT FROM 17::numeric
 OR (fee->>'current_held_amount')::numeric IS DISTINCT FROM 17::numeric
 OR (fee->>'bank_amount')::numeric IS DISTINCT FROM 0::numeric
 OR fee->>'banked_at' IS NOT NULL OR fee->>'bank_receipt_id' IS NOT NULL
 OR fee->>'accounting_complete' IS DISTINCT FROM 'false' OR fee->>'payable' IS DISTINCT FROM 'false'
 OR NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_custody_obligations o
 WHERE o.id=(fee->>'obligation_id')::uuid AND o.tournament_id='"""+EVENT+"""'
 AND o.amount=17 AND o.source_fingerprint='f67bf12ee0b00c954b6f8403de9718fe'
 AND jsonb_array_length(o.original_fees)=34 AND jsonb_array_length(o.original_funding)=34) THEN
 RAISE EXCEPTION 'BREAKFAST_EXACT_UNRESOLVED_OBLIGATION_MISSING'; END IF;
 SELECT jsonb_agg(v ORDER BY v->>'id') INTO original FROM jsonb_array_elements("""+js(old_ledger)+""") v;
 SELECT jsonb_agg(to_jsonb(l) ORDER BY id) INTO actual FROM public.chip_ledger l WHERE id IN(SELECT (v->>'id')::uuid FROM jsonb_array_elements("""+js(old_ledger)+""") v);
 IF actual IS DISTINCT FROM original THEN RAISE EXCEPTION 'BREAKFAST_OLD_LEDGER_REWRITTEN'; END IF;
 SELECT jsonb_agg(v-'terminal_closed_at' ORDER BY v->>'id') INTO original FROM jsonb_array_elements("""+js(old_wallets)+""") v;
 SELECT jsonb_agg(to_jsonb(w)-'terminal_closed_at' ORDER BY id) INTO actual FROM public.wallet_transactions w WHERE id IN(SELECT (v->>'id')::uuid FROM jsonb_array_elements("""+js(old_wallets)+""") v);
 IF actual IS DISTINCT FROM original THEN RAISE EXCEPTION 'BREAKFAST_OLD_WALLETS_REWRITTEN'; END IF;
 IF (SELECT count(*) FROM public.wallet_transactions WHERE related_entity_id='"""+EVENT+"""' AND type='credit' AND category='prize')<>5
 OR (SELECT sum(amount) FROM public.wallet_transactions WHERE related_entity_id='"""+EVENT+"""' AND type='credit' AND category='prize')<>153 THEN
 RAISE EXCEPTION 'BREAKFAST_WALLET_PRIZE_NOT_EXACT'; END IF;
 RAISE NOTICE 'BREAKFAST_FULL_CLOSURE_PASS';
END $closed$;
"""
