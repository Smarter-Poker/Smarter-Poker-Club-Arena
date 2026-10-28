#!/usr/bin/env python3
"""Exact current R2/R3 and owned global phase on the existing native board.
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
    owned_case('ordinary-money-still-refused-during-owned-freeze',"UPDATE clubs SET chip_treasury=chip_treasury+1 WHERE id=caw_u('club');",'PLATFORM_FROZEN')
    owned_case('missing-whole-fleet-ack-refuses-every-wallet-at-original-reserve',"UPDATE fixture_clock SET n='2026-10-12 09:01Z';SELECT smarter_private.weekly_payout_execute(caw_u('owned-run'));",'weekly_payout_not_prepared_and_parked_at_four')
    owned_case('foreign-fresh-engine-refuses-all-money',"SELECT fixture_owned_ack();UPDATE fixture_clock SET n='2026-10-12 09:00Z';UPDATE engine_table_leases SET instance_id='foreign',heartbeat_at='2026-10-12 09:00Z';SELECT smarter_private.weekly_payout_execute(caw_u('owned-run'));",'weekly_payout_not_prepared_and_parked_at_four')
    owned_case('global-r3-fault-rolls-back-earlier-real-r1-r2',"SELECT fixture_owned_ack();UPDATE fixture_clock SET n='2026-10-12 09:00Z';UPDATE engine_table_leases SET heartbeat_at='2026-10-12 09:00Z';SET LOCAL fixture.refuse_player='on';SELECT smarter_private.weekly_payout_execute(caw_u('owned-run'));",'fixture-player-fault')
    owned_case('original-due-fault-recorded-with-no-partial-wallets',"CREATE TEMP TABLE before_fault AS SELECT caw_balances()b,(SELECT count(*)FROM chip_ledger)n;SELECT fixture_owned_ack();UPDATE fixture_clock SET n='2026-10-12 09:00Z';UPDATE engine_table_leases SET heartbeat_at='2026-10-12 09:00Z';SET LOCAL fixture.refuse_player='on';SELECT smarter_private.weekly_payout_due();SELECT caw_assert((SELECT b FROM before_fault)=caw_balances()AND(SELECT n FROM before_fault)=(SELECT count(*)FROM chip_ledger),'failed-due-has-no-partial-money');SELECT caw_assert((SELECT phase='released'AND result->>'paid'='false'AND result->>'reason'='fixture-player-fault'FROM weekly_accounting_payout_pauses),'failed-due-durable-result');")
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
