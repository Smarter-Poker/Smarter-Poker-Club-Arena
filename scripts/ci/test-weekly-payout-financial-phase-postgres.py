#!/usr/bin/env python3
"""Exact current R2/R3 and owned global phase on the existing native board.
Also: every prepared scope is paid and owed scopes catch up hourly (20261031190020);
refusals and deferrals reach Production Alerts (20261031201339).
Reuse only the maintained family's setup, not its unrelated cases. The original
standalone bank owner runs; its external mint and precomputed inventory/prep are
explicit adapters. Wallet/ledger/invoice execution and ordering are real PG17.
No production access or large-week capacity claim.
"""
from pathlib import Path
R=Path(__file__).resolve().parents[2]
base=R/'scripts/ci/test-zero-standalone-foreign-postgres.py'
source=base.read_text()
marker="    for label,call in [('main-direct',R2),('v3-direct',R2V3),('main-cached',R2)]:"
assert source.count(marker)==1
source=source[:source.index(marker)]
old="    zcase('preimage-refuses-proven-zero-standalone-after-canonical-foreign-payment','SELECT '+R2+';','legacy_commission_payment_requires_reconciliation')\n"
assert source.count(old)==1;source=source.replace(old,'')
extra=r'''
    PF=R/'scripts/ci/fixtures/weekly-payout-owned-phase'
    q("CREATE SCHEMA IF NOT EXISTS extensions;CREATE PUBLICATION supabase_realtime;ALTER TABLE union_wallets ADD COLUMN chip_balance numeric,ADD COLUMN rake_wallet numeric;")
    def original_function(version,name):
        t=next((R/'supabase/migrations').glob(version+'_*')).read_text();start=t.index('FUNCTION public.'+name+'(');start=t.rfind('CREATE ',0,start);end=t.index('$function$;',start)+len('$function$;');return t[start:end].replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1)
    for version,name in [('20260907044041','fn_union_prev_week_start'),('20260914110557','fn_union_accounting_run_at'),('20261016142840','fn_weekly_accounting_attempt_begin'),('20260928164258','fn_weekly_accounting_deadline_check'),('20260928211132','fn_weekly_accounting_attempt_end')]:q(original_function(version,name))
    for owner in json.loads((PF/'owner-authority.json').read_text()):
        sig=owner['signature'];q('SET check_function_bodies=false;'+owner['definition']+';REVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC,anon,authenticated,service_role;'+('GRANT EXECUTE ON FUNCTION '+sig+' TO service_role;'if any(a.startswith('service_role=X')for a in owner['acl'])else''))
    q("CREATE TABLE engine_table_leases(table_id uuid PRIMARY KEY,instance_id text,engine_version text,acquired_at timestamptz,heartbeat_at timestamptz,lease_generation uuid,protocol_version integer);CREATE TABLE engine_tournament_leases(tournament_id uuid PRIMARY KEY,instance_id text,engine_version text,acquired_at timestamptz,heartbeat_at timestamptz,lease_generation uuid,protocol_version integer);")
    migration=next((R/'supabase/migrations').glob('20261028162126_*')).read_text()
    q('SET check_function_bodies=true;'+migration)
    # The later owned-slot migration: every prepared scope is paid and the rest
    # catch up. Its exact native section (the production authority guard pins
    # production bodies and is outside it) replaces the three owners here, so
    # every case below runs the CURRENT owners.
    catch_up=next((R/'supabase/migrations').glob('20261031190020_*')).read_text()
    q(catch_up[catch_up.index('-- native:begin'):catch_up.index('-- native:end')])
    # Slot refusals and deferrals reach Production Alerts (20261031201339).
    alerts=next((R/'supabase/migrations').glob('20261031201339_*')).read_text()
    q(alerts[alerts.index('-- native:begin'):alerts.index('-- native:end')])
    # The complete original financial owners execute. Only existing external
    # precomputation and mint transport are adapters, explicitly not live proof.
    q("CREATE FUNCTION caw2_u(label text)RETURNS uuid LANGUAGE sql IMMUTABLE AS $$SELECT md5('owned-phase-second-board:'||label)::uuid$$;")
    for name,signature in [('caw_seed','caw_seed(boolean)'),('caw_alloc','caw_alloc(text,text,numeric,text,uuid)'),('caw_period','caw_period(text,jsonb,numeric,numeric,text,uuid,numeric)')]:
        body=q("SELECT pg_get_functiondef('"+signature+"'::regprocedure)").stdout.strip();body=body.replace('caw_','caw2_').replace('Owner rules native','Second owner rules native');body=body.replace("VALUES(true,'2026-08-01');","VALUES(true,'2026-08-01')ON CONFLICT(singleton)DO NOTHING;");body=body.replace("WHERE (t->>'amount')::numeric>0","WHERE s.club_id=c AND (t->>'amount')::numeric>0");q(body)
    load(PF/'financial-board.sql')
    # A single explicit native clock adapter: the historical calendar is real,
    # while statement time is observed from the controlled clock. Money owners
    # and all their receipt/rate/rounding/conservation queries remain exact.
    exact=q("SELECT pg_get_functiondef('smarter_private.weekly_payout_execute(uuid)'::regprocedure)").stdout.strip()
    assert exact.count('statement_timestamp()')==1
    q(exact.replace('statement_timestamp()','smarter_private.weekly_payout_clock()'))
    def owned_case(name,body,refusal=None):
        before=q('SELECT md5(dr_money()::text);').stdout.strip()
        ans=q("BEGIN;SET LOCAL statement_timeout='240s';SET LOCAL app.weekly_accounting_chunked='on';SET LOCAL app.weekly_accounting_scope_budget='3 minutes';SELECT fixture_owned_seed();"+body+('SET CONSTRAINTS ALL IMMEDIATE;'if not refusal else'')+'ROLLBACK;',check=False)
        if refusal:assert ans.returncode and refusal in ans.stderr,(name,ans.stdout[-2000:],ans.stderr[-7000:])
        else:assert not ans.returncode,(name,ans.stdout[-2000:],ans.stderr[-7000:])
        assert q('SELECT md5(dr_money()::text);').stdout.strip()==before,(name,'financial state escaped rollback')
        print('PASS',name,flush=True)
    run="SELECT fixture_owned_ack();UPDATE fixture_clock SET n='2026-10-12 09:00Z';UPDATE engine_table_leases SET heartbeat_at='2026-10-12 09:00Z';SELECT smarter_private.weekly_payout_execute(caw_u('owned-run'));"
    owned_case('two-clubs-real-all-agent-gross-before-any-player-horse',run+"SET CONSTRAINTS ALL IMMEDIATE;SELECT fixture_owned_assert();")
    owned_case('same-run-replay-no-new-wallet-ledger-invoice',run+"CREATE TEMP TABLE replay_before AS SELECT md5(dr_money()::text)m;SELECT smarter_private.weekly_payout_execute(caw_u('owned-run'));SELECT caw_assert((SELECT m FROM replay_before)=md5(dr_money()::text),'same-run-no-new-money');")
    # Post-money books re-enter the ORIGINAL public rounds after the private
    # capability is retired. Their canonical duplicate receipts precede the
    # injected money admission; no new paid-replay bypass is needed.
    replay="CREATE TEMP TABLE released_replay_before AS SELECT md5(dr_money()::text)m;SELECT caw_assert(NOT EXISTS(SELECT FROM smarter_private.weekly_payout_owned_transactions),'released-replay-has-no-capability');"
    for club in ["caw_u('club')","caw2_u('club')"]:
        for owner in ['fn_settle_accounting_commission_stage','fn_settle_accounting_commission_stage_v3','fn_settle_accounting_rakeback_stage']:
            replay+="SELECT caw_assert((public."+owner+"('club',"+club+",'2026-10-05 07:00Z','2026-10-12 07:00Z')->>'duplicate')='true','released-original-round-duplicate');"
    replay+="SELECT caw_assert((SELECT m FROM released_replay_before)=md5(dr_money()::text),'released-original-rounds-no-new-money-or-invoices');"
    owned_case('released-original-public-round2-wrapper-v3-round3-replay-without-capability',run+replay)
    owned_case('unpaid-original-public-round2-still-requires-owned-phase','SELECT '+R2+';','weekly_payout_original_owned_phase_required')
    owned_case('unpaid-original-public-round3-still-requires-owned-phase','SELECT '+R3+';','weekly_payout_original_owned_phase_required')
    owned_case('ordinary-money-still-refused-during-owned-freeze',"UPDATE clubs SET chip_treasury=chip_treasury+1 WHERE id=caw_u('club');",'PLATFORM_FROZEN')
    owned_case('missing-whole-fleet-ack-refuses-every-wallet-at-original-reserve',"UPDATE fixture_clock SET n='2026-10-12 09:01Z';SELECT smarter_private.weekly_payout_execute(caw_u('owned-run'));",'weekly_payout_not_prepared_and_parked_at_four')
    owned_case('foreign-fresh-engine-refuses-all-money',"SELECT fixture_owned_ack();UPDATE fixture_clock SET n='2026-10-12 09:00Z';UPDATE engine_table_leases SET instance_id='foreign',heartbeat_at='2026-10-12 09:00Z';SELECT smarter_private.weekly_payout_execute(caw_u('owned-run'));",'weekly_payout_not_prepared_and_parked_at_four')
    owned_case('global-r3-fault-rolls-back-earlier-real-r1-r2',"SELECT fixture_owned_ack();UPDATE fixture_clock SET n='2026-10-12 09:00Z';UPDATE engine_table_leases SET heartbeat_at='2026-10-12 09:00Z';SET LOCAL fixture.refuse_player='on';SELECT smarter_private.weekly_payout_execute(caw_u('owned-run'));",'fixture-player-fault')
    owned_case('original-due-fault-recorded-with-no-partial-wallets',"CREATE TEMP TABLE before_fault AS SELECT caw_balances()b,(SELECT count(*)FROM chip_ledger)n;SELECT fixture_owned_ack();UPDATE fixture_clock SET n='2026-10-12 09:00Z';UPDATE engine_table_leases SET heartbeat_at='2026-10-12 09:00Z';SET LOCAL fixture.refuse_player='on';SELECT smarter_private.weekly_payout_due();SELECT caw_assert((SELECT b FROM before_fault)=caw_balances()AND(SELECT n FROM before_fault)=(SELECT count(*)FROM chip_ledger),'failed-due-has-no-partial-money');SELECT caw_assert((SELECT phase='released'AND result->>'paid'='false'AND result->>'reason'='fixture-player-fault'FROM weekly_accounting_payout_pauses),'failed-due-durable-result');")
    # EVERY PREPARED SCOPE IS PAID; THE REST CATCH UP (20261031190020).
    two="jsonb_build_array(jsonb_build_object('kind','club','id',caw_u('club'),'period_start','2026-10-05T07:00:00+00:00','period_end','2026-10-12T07:00:00+00:00'),jsonb_build_object('kind','club','id',caw2_u('club'),'period_start','2026-10-05T07:00:00+00:00','period_end','2026-10-12T07:00:00+00:00'))"
    owed=("CREATE OR REPLACE FUNCTION smarter_private.weekly_payout_scope_plan(p_end timestamptz,p_now timestamptz)RETURNS jsonb LANGUAGE sql AS $f$SELECT COALESCE(jsonb_agg(j ORDER BY o),'[]'::jsonb)FROM jsonb_array_elements("+two+")WITH ORDINALITY x(j,o)"
     " WHERE NOT EXISTS(SELECT FROM smarter_private.weekly_payout_financial_receipts r WHERE r.scope_kind=j->>'kind' AND r.scope_id=(j->>'id')::uuid AND r.period_start=(j->>'period_start')::timestamptz)$f$;"
     "CREATE OR REPLACE FUNCTION public.fn_accounting_close_windows_pending(uuid,uuid,timestamptz,timestamptz)RETURNS boolean LANGUAGE sql AS $f$SELECT false$f$;"
     "CREATE OR REPLACE FUNCTION public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)RETURNS jsonb LANGUAGE sql AS $f$SELECT CASE WHEN $2=caw2_u('club')AND current_setting('fixture.refuse_club2',true)='on' THEN jsonb_build_object('success',false,'problems',jsonb_build_array(jsonb_build_object('reason','fixture_still_preparing'))) ELSE jsonb_build_object('success',true,'fixture_boundary','precomputed-original-inventory')END$f$;"
     # Per-club order: each paid club's agent round precedes its own players.
     "CREATE OR REPLACE FUNCTION fixture_observe_money()RETURNS trigger LANGUAGE plpgsql AS $f$BEGIN IF NEW.category='commission'AND NEW.status='posted' THEN INSERT INTO fixture_order(kind,club_id)VALUES('agent',NEW.club_id);"
     " ELSIF NEW.category='rakeback'AND NEW.status='posted' THEN IF NOT EXISTS(SELECT FROM accounting_routed_settlement_runs WHERE round_no=2 AND scope_id=NEW.club_id)THEN RAISE EXCEPTION 'player-before-own-agent-round';END IF;"
     " INSERT INTO fixture_order(kind,club_id)VALUES('player',NEW.club_id);END IF;RETURN NEW;END$f$;")
    def at(t):return "UPDATE fixture_clock SET n='"+t+"';UPDATE engine_table_leases SET heartbeat_at='"+t+"';"
    def ack(attempt):return ("SELECT public.fn_weekly_accounting_payout_pause_ack(p.run_id,p.ownership_token,'fixture-engine',jsonb_build_array(jsonb_build_object('scope','cash','table_id',caw_u('table'),'tournament_id',NULL,'lease_generation',caw_u('lease'))))"
     " FROM weekly_accounting_payout_pauses p WHERE p.attempt_no="+str(attempt)+";")
    def paid(club):return ("SELECT caw_assert((SELECT chip_treasury=1421 FROM clubs WHERE id="+club+")AND EXISTS(SELECT FROM smarter_private.weekly_payout_financial_receipts WHERE scope_id="+club+")"
     " AND (SELECT count(*)=2 FROM accounting_routed_settlement_runs WHERE scope_id="+club+"),'paid-'||"+club+"::text);")
    def unpaid(club):return ("SELECT caw_assert(NOT EXISTS(SELECT FROM smarter_private.weekly_payout_financial_receipts WHERE scope_id="+club+")AND NOT EXISTS(SELECT FROM accounting_routed_settlement_runs WHERE scope_id="+club+")"
     " AND NOT EXISTS(SELECT FROM fixture_order WHERE club_id="+club+"),'unpaid-'||"+club+"::text);")
    stage=lambda expected,label:"SELECT caw_assert((smarter_private.weekly_payout_due())->>'stage'='"+expected+"','"+label+"');"
    owned_case('subset-boundary-pays-its-prepared-club-and-leaves-the-other-owed',owed+
     "UPDATE weekly_accounting_payout_pauses SET scope_plan=jsonb_build_array(scope_plan->0);"+ack(1)+at('2026-10-12 09:00Z')+
     "SELECT caw_assert((smarter_private.weekly_payout_execute(caw_u('owned-run'))->>'success')='true','subset-run');"+paid("caw_u('club')")+unpaid("caw2_u('club')"))
    owned_case('revalidation-change-defers-only-that-club-then-next-hour-pays-it',owed+"SET LOCAL fixture.refuse_club2='on';"+ack(1)+at('2026-10-12 09:00Z')+
     "SELECT caw_assert(jsonb_array_length(smarter_private.weekly_payout_execute(caw_u('owned-run'))->'deferred_scopes')=1,'one-deferred');"+paid("caw_u('club')")+unpaid("caw2_u('club')")+
     "SELECT caw_assert((SELECT jsonb_array_length(scope_plan)=1 AND phase='released' FROM weekly_accounting_payout_pauses WHERE attempt_no=1),'boundary-owned-only-paid-club');"+
     "SET LOCAL fixture.refuse_club2='off';"+at('2026-10-12 09:06Z')+stage('weekly_payout_prepared','catch-up-prepared')+
     "SELECT caw_assert((SELECT money_starts_at='2026-10-12 10:00Z' AND announced_at='2026-10-12 09:58Z' AND scope_plan->0->>'id'=caw2_u('club')::text AND jsonb_array_length(scope_plan)=1 FROM weekly_accounting_payout_pauses WHERE attempt_no=2),'second-slot-owns-the-owed-club');"+
     at('2026-10-12 09:30Z')+stage('weekly_payout_prepared','waits-for-own-slot')+
     "SELECT caw_assert(((public.fn_weekly_accounting_payout_pause_state())->'boundary'->>'money_starts_at')::timestamptz='2026-10-12 10:00Z','engine-reads-the-second-slot');"+
     at('2026-10-12 09:58:30Z')+ack(2)+at('2026-10-12 10:00Z')+
     "SELECT caw_assert((smarter_private.weekly_payout_due()->>'success')='true','second-slot-paid');"+paid("caw_u('club')")+paid("caw2_u('club')")+
     "SELECT caw_assert((SELECT count(*)=2 AND sum(amount)=1000 FROM ca_mint_ledger),'each-club-banked-once');"+
     "SELECT caw_assert((SELECT count(*)=4 FROM accounting_routed_settlement_runs),'four-stage-receipts-no-duplicate');"+
     at('2026-10-12 10:06Z')+"SELECT caw_assert(smarter_private.weekly_payout_due() IS NULL,'nothing-owed-docs-continue');")
    owned_case('a-missed-first-slot-prepares-the-next-hour-instead-of-owning-every-tick',owed+"DELETE FROM weekly_accounting_payout_pauses;"+at('2026-10-12 09:07Z')+
     stage('weekly_payout_prepared','late-prepared')+
     "SELECT caw_assert((SELECT attempt_no=2 AND money_starts_at='2026-10-12 10:00Z' AND jsonb_array_length(scope_plan)=2 FROM weekly_accounting_payout_pauses),'late-row');")
    owned_case('final-ticks-own-the-slot-with-ready-scopes-only',owed+"DELETE FROM weekly_accounting_payout_pauses;SET LOCAL fixture.refuse_club2='on';"+at('2026-10-12 08:40Z')+
     stage('weekly_payout_preparing','early-waits-for-all')+"SELECT caw_assert(NOT EXISTS(SELECT FROM weekly_accounting_payout_pauses),'no-early-subset');"+
     at('2026-10-12 08:52Z')+stage('weekly_payout_prepared','final-subset')+
     "SELECT caw_assert((SELECT attempt_no=1 AND jsonb_array_length(scope_plan)=1 AND scope_plan->0->>'id'=caw_u('club')::text FROM weekly_accounting_payout_pauses),'final-row-ready-only');")
    owned_case('a-refused-slot-is-prepared-again-for-the-next-hour',owed+at('2026-10-12 09:01Z')+stage('weekly_payout_financial_refused','unacknowledged-refused')+
     "SELECT caw_assert((SELECT phase='released' FROM weekly_accounting_payout_pauses WHERE attempt_no=1),'refused-released');"+unpaid("caw_u('club')")+unpaid("caw2_u('club')")+
     at('2026-10-12 09:10Z')+stage('weekly_payout_prepared','retry-prepared')+
     "SELECT caw_assert((SELECT jsonb_array_length(scope_plan)=2 FROM weekly_accounting_payout_pauses WHERE attempt_no=2),'retry-owns-both');")
    owned_case('owned-slots-end-after-eight',owed+"DELETE FROM weekly_accounting_payout_pauses;"+at('2026-10-12 15:50Z')+stage('weekly_payout_prepared','eighth-slot')+
     "SELECT caw_assert((SELECT attempt_no FROM weekly_accounting_payout_pauses)=8,'eighth');DELETE FROM weekly_accounting_payout_pauses;"+at('2026-10-12 15:58Z')+
     "SELECT caw_assert(smarter_private.weekly_payout_due() IS NULL,'no-ninth-slot');")
    owned_case('one-unreleased-boundary-per-week',"INSERT INTO weekly_accounting_payout_pauses(period_start,period_end,attempt_no,announced_at,money_starts_at,money_deadline_at,expires_at,scope_plan)"
     "VALUES('2026-10-05 07:00Z','2026-10-12 07:00Z',2,'2026-10-12 09:58Z','2026-10-12 10:00Z','2026-10-12 10:04Z','2026-10-12 10:05Z','[{}]');",'weekly_accounting_payout_pauses_one_unreleased')
    owned_case('a-slot-is-on-its-own-hour',"UPDATE weekly_accounting_payout_pauses SET phase='released';INSERT INTO weekly_accounting_payout_pauses(period_start,period_end,attempt_no,announced_at,money_starts_at,money_deadline_at,expires_at,scope_plan)"
     "VALUES('2026-10-05 07:00Z','2026-10-12 07:00Z',2,'2026-10-12 08:58Z','2026-10-12 09:00Z','2026-10-12 09:04Z','2026-10-12 09:05Z','[{}]');",'weekly_accounting_payout_pauses_slot_check')
    owned_case('a-boundary-cannot-own-a-scope-the-week-no-longer-owes',owed+"UPDATE weekly_accounting_payout_pauses SET scope_plan=scope_plan||jsonb_build_array(scope_plan->0);"+ack(1)+at('2026-10-12 09:00Z')+
     "SELECT smarter_private.weekly_payout_execute(caw_u('owned-run'));",'weekly_payout_prepared_scope_changed')
    sink=("CREATE TEMP TABLE fixture_alerts(source text,event_key text,alertname text,status text,severity text,payload jsonb);"
     "CREATE OR REPLACE FUNCTION public.fn_record_operational_alert(p_source text,p_event_key text,p_alertname text,p_status text,p_severity text,p_payload jsonb)RETURNS bigint LANGUAGE sql AS $f$INSERT INTO fixture_alerts VALUES(p_source,p_event_key,p_alertname,p_status,p_severity,p_payload)RETURNING 1::bigint$f$;")
    def alerted(name,status,severity,n=1):return "SELECT caw_assert((SELECT count(*) FROM fixture_alerts WHERE source='weekly-payout' AND alertname='"+name+"' AND status='"+status+"' AND severity='"+severity+"')="+str(n)+",'alert-"+name+"');"
    owned_case('a-refused-slot-reaches-production-alerts-once',owed+sink+at('2026-10-12 09:01Z')+stage('weekly_payout_financial_refused','refused')+alerted('WeeklyPayoutSlotRefused','firing','warning')+
     at('2026-10-12 09:10Z')+stage('weekly_payout_prepared','retry-prepared')+alerted('WeeklyPayoutSlotRefused','firing','warning'))
    owned_case('a-scope-deferred-at-execution-reaches-production-alerts',owed+sink+"SET LOCAL fixture.refuse_club2='on';"+ack(1)+at('2026-10-12 09:00Z')+
     "SELECT caw_assert((smarter_private.weekly_payout_due()->>'success')='true','subset-paid');"+alerted('WeeklyPayoutScopeDeferred','firing','warning')+paid("caw_u('club')"))
    owned_case('a-scope-deferred-at-preparation-reaches-production-alerts',owed+sink+"DELETE FROM weekly_accounting_payout_pauses;SET LOCAL fixture.refuse_club2='on';"+at('2026-10-12 08:52Z')+
     stage('weekly_payout_prepared','final-subset')+alerted('WeeklyPayoutScopeDeferred','firing','warning'))
    owned_case('a-week-owing-after-its-last-slot-reaches-production-alerts',owed+sink+"DELETE FROM weekly_accounting_payout_pauses;"+at('2026-10-12 15:58Z')+
     "SELECT caw_assert(smarter_private.weekly_payout_due() IS NULL,'no-ninth');"+alerted('WeeklyPayoutUnpaidAfterLastSlot','firing','critical'))
    owned_case('an-alert-failure-never-changes-the-payout-outcome',owed+"CREATE OR REPLACE FUNCTION public.fn_record_operational_alert(text,text,text,text,text,jsonb)RETURNS bigint LANGUAGE plpgsql AS $f$BEGIN RAISE EXCEPTION 'fixture-alert-down';END$f$;"+
     at('2026-10-12 09:01Z')+stage('weekly_payout_financial_refused','refused-without-alert')+"SELECT caw_assert((SELECT phase='released' FROM weekly_accounting_payout_pauses WHERE attempt_no=1),'released-anyway');"+
     at('2026-10-12 09:10Z')+stage('weekly_payout_prepared','next-slot-anyway'))
    # Commit only this isolated synthetic board so a second PostgreSQL backend
    # can ACK the original DUE while its original statement is waiting. The
    # observed server wait event supplies synchronization; no guessed delay.
    q("BEGIN;SET LOCAL app.freeze_bypass='on';SELECT fixture_owned_seed();UPDATE fixture_clock SET n='2026-10-12 09:00Z';UPDATE engine_table_leases SET heartbeat_at='2026-10-12 09:00Z';COMMIT;")
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        original=pool.submit(q,"SET application_name='weekly-native-original-due';BEGIN;SET LOCAL statement_timeout='240s';SET LOCAL app.weekly_accounting_chunked='on';SET LOCAL app.weekly_accounting_scope_budget='3 minutes';SELECT smarter_private.weekly_payout_due();COMMIT;")
        waiting=False
        for observation in range(200):
            waiting=q("SELECT EXISTS(SELECT FROM pg_stat_activity WHERE application_name='weekly-native-original-due'AND wait_event='PgSleep');").stdout.strip()=='t'
            if waiting:break
            if original.done():break
            time.sleep(0.01)
        assert waiting,'original DUE did not reach its bounded ACK wait'
        q("SELECT fixture_owned_ack();")
        answer=original.result(timeout=30)
        assert '"success": true' in answer.stdout,(answer.stdout,answer.stderr)
    q("SELECT fixture_owned_assert();SELECT caw_assert((SELECT acknowledged_at=money_starts_at AND money_deadline_at=money_starts_at+interval '240 seconds'AND expires_at=money_starts_at+interval '5 minutes'FROM weekly_accounting_payout_pauses),'concurrent-ack-original-deadlines');")
    print('PASS original-DUE-waits-without-row-lock-for-concurrent-at-four-ACK-real-all-rounds',flush=True)
    print('PASS focused actual financial owners/global phase; external mint/preparation adapters and runtime/capacity limits retained',flush=True)
'''
source+=extra+"\nfinally:\n    if started:cmd([A.pg_bin/'pg_ctl','-D',D,'-m','fast','-w','stop'])\n    shutil.rmtree(W)\n"
exec(compile(source,str(base),'exec'),{'__name__':'__main__','__file__':str(base)})
