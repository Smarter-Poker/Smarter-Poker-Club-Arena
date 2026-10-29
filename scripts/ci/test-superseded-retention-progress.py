#!/usr/bin/env python3
"""Finite retention progress, actual disposal owners and PG17 simple-query wiring.

Only a fresh Unix-socket cluster is used. Cron's catalog/API is represented by
its documented row/update shape; psql -c sends the entire exact job command in
one libpq simple-query message, including all three transaction boundaries.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import sys
import threading
import time
sys.dont_write_bytecode = True
from satellite_qualifier_fixture import module, lit, sha
ROOT = Path(__file__).resolve().parents[2]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pg-bin', type=Path, required=True)
    ap.add_argument('--evidence', type=Path, required=True)
    args = ap.parse_args()
    out = args.evidence.resolve()
    out.mkdir(parents=True, exist_ok=False)
    tmp = Path(os.environ.get('TMPDIR', '/tmp'))
    if sys.platform == 'darwin' and not str(tmp.resolve()).startswith('/Volumes/SmarterWork/agent-work/'):
        raise SystemExit('External task-owned TMPDIR required')
    native = module(ROOT/'scripts/ci/test-mtt-unlimited.py', 'progress_native')
    doors = module(ROOT/'scripts/ci/test-hand-submission-disposal.py', 'progress_doors')
    actions = module(ROOT/'scripts/ci/test-superseded-horse-actions.py', 'progress_actions')
    migration = next((ROOT/'supabase/migrations').glob('*_superseded_action_retention_progresses_at_its_existing_owner.sql'))
    e = native.Execution(ROOT, out, args.pg_bin.resolve(), tmp, 180, socket_parent=str(tmp))
    checks = []
    threads = []
    def sql(db, text, label):
        return e.sql(db, text, label=label)[1].strip()
    def expect(label, condition):
        checks.append({'name': label, 'passed': bool(condition)})
        if not condition:
            raise AssertionError(label)
    def simple(db, command, label, check=True):
        return e.run(label, [e.pg/'psql','-X','-qAt','-h',e.socket,'-p',e.port,'-U','postgres','-d',db,'-v','ON_ERROR_STOP=1','-c',command], check=check)
    captured_job = json.loads(actions.PREIMAGE.read_text())['retention_cron_preimage']
    budget_migration = ROOT/'supabase/migrations/20261029083417_retention_discovery_commits_bounded_chunks_within_its_budget.sql'
    original = captured_job['command']
    assert len(original.encode()) == 301
    assert hashlib.md5(original.encode()).hexdigest() == captured_job['command_md5'] == '96244362bf46b39e75ef1100b1372203'
    assert {k: captured_job[k] for k in ['jobid', 'jobname', 'schedule', 'active', 'username']} == {'jobid': 117, 'jobname': 'sp_prune_hand_history_10m', 'schedule': '30 seconds', 'active': True, 'username': 'postgres'}

    try:
        e.start()
        e.env['PGOPTIONS']='-c cron.use_background_workers=off'
        base=e.database()
        e.sql(base,file=ROOT/doors.WORLD,label='actual-disposal-world')
        sql(base,actions.SUPPLEMENT,'unchanged-read-dependencies')
        sql(base,doors.resume_base(ROOT),'actual-resume-preimage')
        sql(base,doors.snapshot_guard_base(ROOT),'actual-snapshot-preimage')
        e.sql(base,file=ROOT/doors.MIGRATION,label='original-disposal-migration')
        for row in json.loads(actions.PREIMAGE.read_text())['rows']:
            expect('captured source digest '+row['signature'], hashlib.md5(row['definition'].encode()).hexdigest()==row['md5'])
            sql(base,row['definition']+';','captured-'+row['signature'].split('(')[0].replace('.','-'))
            sql(base,'REVOKE ALL ON FUNCTION '+row['signature']+' FROM PUBLIC,anon,authenticated,service_role;'+('' if row['signature'].startswith('smarter_private.') else 'GRANT EXECUTE ON FUNCTION '+row['signature']+' TO service_role;'),'owner-acl')
        sql(base,"CREATE TRIGGER hand_submission_immutable BEFORE UPDATE OR DELETE ON smarter_private.hand_submissions FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_submission_immutable(); CREATE TRIGGER hand_submission_no_truncate BEFORE TRUNCATE ON smarter_private.hand_submissions FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.hand_submission_immutable();",'actual-immutable-triggers')
        e.sql(base,file=actions.MIGRATION,label='installed-8445-baseline')
        sql(base,"CREATE SCHEMA cron; CREATE TABLE cron.job(jobid bigint PRIMARY KEY,jobname text,schedule text,active boolean,username text,command text); CREATE FUNCTION cron.alter_job(job_id bigint,command text) RETURNS void LANGUAGE sql AS $$ UPDATE cron.job SET command=$2 WHERE jobid=$1 $$; CREATE TABLE public.progress_prune_receipts(n integer); CREATE FUNCTION public.sp_prune_hand_history(integer) RETURNS integer LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.progress_prune_receipts VALUES($1); RETURN 0; END $$; INSERT INTO cron.job VALUES(117,'sp_prune_hand_history_10m','30 seconds',true,'postgres',"+lit(original)+");",'existing-cron-shape-only')
        unsupported=e.database(base)
        code,_,err=e.sql(unsupported,"SET cron.use_background_workers='on';"+migration.read_text(),label='unsupported-cron-mode-refusal',check=False)
        expect('unsupported cron execution mode refuses before DDL',code!=0 and 'SUPERSEDED_RETENTION_REQUIRES_CRON_LIBPQ_MODE' in err and sql(unsupported,"SELECT to_regclass('smarter_private.superseded_action_retention_due') IS NULL;",'unsupported-mode-no-schema')=='t')
        e.discard(unsupported)
        before_pins=json.loads(sql(base,"SELECT split_part(pg_get_functiondef('smarter_private.original_hand_correction_sources_match()'::regprocedure),'$sourcepins$',2)::jsonb;",'before-pins'))
        before_sources=json.loads(sql(base,"SELECT jsonb_object_agg(oid::regprocedure::text,md5(pg_get_functiondef(oid))) FROM pg_proc WHERE oid IN ('smarter_private.superseded_horse_actions_eligible(uuid)'::regprocedure,'smarter_private.compact_superseded_horse_actions(uuid[])'::regprocedure,'smarter_private.assert_retained_hand_submission(jsonb)'::regprocedure);",'unchanged-authorities'))
        # Demonstrate the actual old invocation can see no eight-day work later.
        before_global=sql(base,'SELECT smarter_private.original_hand_correction_sources_match();','before-global-matcher')
        old_private=sql(base,"SELECT pg_get_functiondef('smarter_private.hand_submission_dispose_dealt_past(uuid,bigint)'::regprocedure);",'old-executing-producer-body')
        empty=e.database(base)
        for label, changed_command in [('old-spacing', original.replace('>= 0', '>=0')), ('changed-batch', original.replace('(5000)', '(5001)'))]:
            refused = e.database(empty)
            sql(refused, 'UPDATE cron.job SET command=' + lit(changed_command) + ' WHERE jobid=117;', label+'-fixture-command')
            code, _, err = e.sql(refused, 'BEGIN;' + migration.read_text() + 'COMMIT;', label=label+'-candidate-refusal', check=False)
            expect(label+' exact cron preimage refuses', code != 0 and 'SUPERSEDED_RETENTION_CRON_PREIMAGE_CHANGED' in err)
            expect(label+' transaction leaves no partial schema', sql(refused, "SELECT to_regclass('smarter_private.superseded_action_retention_due') IS NULL AND to_regclass('smarter_private.superseded_action_retention_cursor') IS NULL AND to_regprocedure('smarter_private.progress_superseded_action_retention()') IS NULL;", label+'-no-partial-schema') == 't')
            expect(label+' original command remains unchanged', sql(refused, 'SELECT command FROM cron.job WHERE jobid=117;', label+'-original-command') == changed_command.strip())
            expect(label+' original owner remains unchanged', sql(refused, "SELECT pg_get_functiondef('smarter_private.hand_submission_dispose_dealt_past(uuid,bigint)'::regprocedure);", label+'-original-owner') == old_private)
            expect(label+' original source pins remain unchanged', json.loads(sql(refused, "SELECT split_part(pg_get_functiondef('smarter_private.original_hand_correction_sources_match()'::regprocedure),'$sourcepins$',2)::jsonb;", label+'-original-pins')) == before_pins)
            e.discard(refused)
        sql(base,actions.SEED,'aged-authoritative-receipt')
        expect('BEFORE no future age owner exists',sql(base,"SELECT to_regprocedure('smarter_private.progress_superseded_action_retention()') IS NULL;",'before-missing-owner')=='t')
        e.sql(base,file=migration,label='exact-progress-candidate')
        e.sql(base,file=budget_migration,label='budgeted-discovery-upgrade')
        after_pins=json.loads(sql(base,"SELECT split_part(pg_get_functiondef('smarter_private.original_hand_correction_sources_match()'::regprocedure),'$sourcepins$',2)::jsonb;",'after-pins'))
        sig='smarter_private.hand_submission_dispose_dealt_past(uuid,bigint)'
        expect('exactly one existing source pin advances',len(before_pins)==26 and [x for x in before_pins if x['signature']!=sig]==[x for x in after_pins if x['signature']!=sig] and before_pins!=after_pins)
        after_sources=json.loads(sql(base,"SELECT jsonb_object_agg(oid::regprocedure::text,md5(pg_get_functiondef(oid))) FROM pg_proc WHERE oid IN ('smarter_private.superseded_horse_actions_eligible(uuid)'::regprocedure,'smarter_private.compact_superseded_horse_actions(uuid[])'::regprocedure,'smarter_private.assert_retained_hand_submission(jsonb)'::regprocedure);",'preserved-authorities'))
        expect('qualifier compactor and replay authority byte unchanged',before_sources==after_sources)
        expect('preexisting false global source matcher remains false',before_global=='f' and sql(base,'SELECT smarter_private.original_hand_correction_sources_match();','after-global-matcher')=='f')
        expect('first postcommit invocation establishes old-transaction barrier',sql(base,'SELECT smarter_private.discover_superseded_action_retention(); SELECT discovery_cutoff IS NOT NULL AND last_table_id IS NULL FROM smarter_private.superseded_action_retention_cursor;','postcommit-barrier').endswith('t'))
        expect('historical discovery enqueues without touching request',sql(base,'SELECT smarter_private.discover_superseded_action_retention(); SELECT count(*) FROM smarter_private.superseded_action_retention_due;','historical-discovery').endswith('1'))
        expect('historical aged request compacts',sql(base,'SELECT smarter_private.progress_superseded_action_retention();','historical-due')=='1')
        expect('successful queue bookkeeping removed',sql(base,'SELECT count(*) FROM smarter_private.superseded_action_retention_due;','queue-empty')=='0')
        expect('immutable certificate retained',sql(base,'SELECT count(*) FROM smarter_private.superseded_horse_action_certificates;','permanent-certificate')=='1')
        expect('historical finite pass completes',sql(base,'SELECT smarter_private.discover_superseded_action_retention(); SELECT completed FROM smarter_private.superseded_action_retention_cursor;','finite-pass').endswith('t'))
        expect('malformed infinite or unrelated receipts do not queue',sql(base,"SELECT count(*) FROM (VALUES ('{}'::jsonb),('{\"kind\":\"retention_pruned_settled_hand\",\"retained_at\":\"2020-01-01\"}'),('{\"kind\":\"superseded_by_later_commit\",\"retained_at\":\"infinity\"}'),('{\"kind\":\"superseded_retained_submission\",\"retained_at\":\"bad\"}')) v(x) WHERE smarter_private.superseded_action_retention_due_at(x) IS NOT NULL;",'bad-due')=='0')
        expect('due time reads current owner retention config',sql(base,"BEGIN; UPDATE public.hand_history_retention_policy SET horse_retention_days=10; SELECT smarter_private.superseded_action_retention_due_at('{\"kind\":\"superseded_retained_submission\",\"retained_at\":\"2020-01-01T00:00:00Z\"}')='2020-01-11T00:00:00Z'::timestamptz; ROLLBACK;",'configured-due-time')=='t')
        expect('unknown retention config does not invent a due time',sql(base,"BEGIN; UPDATE public.hand_history_retention_policy SET horse_retention_days=NULL; SELECT smarter_private.superseded_action_retention_due_at('{\"kind\":\"superseded_retained_submission\",\"retained_at\":\"2020-01-01T00:00:00Z\"}') IS NULL; ROLLBACK;",'unknown-due-time')=='t')
        expect('public original limit remains unchanged',sql(base,"SELECT position('LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 2000), 20000))' IN pg_get_functiondef('public.fn_ca_dispose_superseded_hand_submissions(uuid,uuid,text,integer)'::regprocedure))>0;",'public-cap')=='t')
        expect('all new helpers inaccessible to service role',sql(base,"SELECT bool_and(NOT has_function_privilege('service_role',oid,'execute')) FROM pg_proc WHERE pronamespace='smarter_private'::regnamespace AND proname IN ('progress_superseded_action_retention','discover_superseded_action_retention','superseded_action_retention_due_at');",'helper-acl')=='t')
        e.sql(empty,file=migration,label='empty-progress-candidate')
        e.sql(empty,file=budget_migration,label='empty-budgeted-upgrade')
        replay=e.database(empty)
        replay_before=sql(replay,"SELECT jsonb_build_object('body',pg_get_functiondef(p.oid),'owner',proowner,'acl',proacl,'config',proconfig,'secdef',prosecdef,'cursor',(SELECT to_jsonb(c) FROM smarter_private.superseded_action_retention_cursor c)) FROM pg_proc p WHERE p.oid='smarter_private.discover_superseded_action_retention()'::regprocedure;",'budget-replay-before')
        replay_code,_,replay_error=e.sql(replay,budget_migration.read_text(),label='budget-replay-refusal',check=False)
        expect('budget upgrade replay refuses exact prior body mismatch',replay_code!=0 and 'RETENTION_DISCOVERY_BUDGET_PREIMAGE_CHANGED' in replay_error)
        expect('budget upgrade replay retains body authority and cursor atomically',replay_before==sql(replay,"SELECT jsonb_build_object('body',pg_get_functiondef(p.oid),'owner',proowner,'acl',proacl,'config',proconfig,'secdef',prosecdef,'cursor',(SELECT to_jsonb(c) FROM smarter_private.superseded_action_retention_cursor c)) FROM pg_proc p WHERE p.oid='smarter_private.discover_superseded_action_retention()'::regprocedure;",'budget-replay-after'))
        e.discard(replay)

        for owner in ['private','public']:
            future=e.database(empty)
            seed=actions.SEED.split('INSERT INTO smarter_private.hand_submission_disposals')[0].replace("interval '10 days'", "interval '1 day'")
            sql(future,seed+f"INSERT INTO public.hand_atomic_commits(table_id,hand_number,hand_id,payload_hash,stack_result,committed_at) VALUES({lit(actions.TABLE)},1000002,{lit(actions.WITNESS)},repeat('0',64),'{{}}',now());",owner+'-future-seed')
            before=sql(future,"SELECT jsonb_build_object('identity',to_jsonb(s)-'request','request',request) FROM smarter_private.hand_submissions s;",owner+'-before')
            if owner=='private':
                answer=sql(future,f"SELECT smarter_private.hand_submission_dispose_dealt_past({lit(actions.TABLE)},1000001);",'actual-private-door')
                expect('private original count retained',answer=='1')
            else:
                answer=json.loads(sql(future,actions.AUTH+f"SELECT public.fn_ca_dispose_superseded_hand_submissions({lit(actions.TABLE)},{lit(actions.RECEIPT)},'Native future retention disposal preserves every original financial obligation.',1);",'actual-public-door'))
                expect('public original count and credit retained',answer['disposed']==1 and answer['credit']==0)
            expect(owner+' unreferenced DML CTE enqueues exactly new receipt',sql(future,"SELECT count(*)=1 AND bool_and(due_at>now()+interval '6 days' AND due_at=next_at) FROM smarter_private.superseded_action_retention_due;",owner+'-due-queue')=='t')
            expect(owner+' underage full original source unchanged',before==sql(future,"SELECT jsonb_build_object('identity',to_jsonb(s)-'request','request',request) FROM smarter_private.hand_submissions s;",owner+'-after'))
            sql(future,'SELECT smarter_private.progress_superseded_action_retention();',owner+'-underage-tick')
            expect(owner+' no early certificate',sql(future,'SELECT count(*) FROM smarter_private.superseded_horse_action_certificates;',owner+'-no-early-certificate')=='0')
            e.discard(future)
        backlog=e.database(empty)
        sql(backlog,'SELECT smarter_private.discover_superseded_action_retention();','backlog-postcommit-barrier')
        sql(backlog,actions.SEED+f"INSERT INTO smarter_private.superseded_action_retention_due SELECT submission_id,now()-interval '1 day',now()-interval '1 day' FROM smarter_private.hand_submissions; INSERT INTO smarter_private.hand_submission_disposals(table_id,hand_number,submission_id,receipt_id,witness_hand_number,reason,expected) SELECT '10000000-0000-4000-8000-000000000001',2000000+n,('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,{lit(actions.RECEIPT)},3000000,'Native immutable settled receipt is never an eligible superseded action request.',jsonb_build_object('kind','retention_pruned_settled_hand') FROM generate_series(1,5001)n;",'due-with-raw-backlog')
        expect('due work drains before five-thousand raw page',sql(backlog,'SELECT smarter_private.progress_superseded_action_retention();','due-before-backlog')=='1')
        expect('separate historical transaction examines bounded page',sql(backlog,'SELECT smarter_private.discover_superseded_action_retention();','separate-backlog-page')=='5000')
        expect('cursor advances only exact first five-thousand keys',sql(backlog,"SELECT last_table_id='10000000-0000-4000-8000-000000000001' AND last_hand_number=2005000 AND NOT completed FROM smarter_private.superseded_action_retention_cursor;",'page-examined-keys')=='t')
        expect('settled receipts never pollute due queue',sql(backlog,'SELECT count(*) FROM smarter_private.superseded_action_retention_due;','settled-not-queued')=='0')
        slow=e.database(backlog)
        sql(slow,"UPDATE smarter_private.superseded_action_retention_cursor SET last_table_id=NULL,last_hand_number=NULL; CREATE FUNCTION public.slow_retention_chunk() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN NULL; END $$; CREATE TRIGGER slow_retention_chunk BEFORE INSERT ON smarter_private.superseded_action_retention_due FOR EACH STATEMENT EXECUTE FUNCTION public.slow_retention_chunk();",'controlled-slow-chunk')
        slow_count=int(sql(slow,'SELECT smarter_private.discover_superseded_action_retention();','budgeted-slow-page'))
        expect('slow chunks stop before full page without timeout',250<=slow_count<5000 and slow_count%250==0)
        expect('slow completed chunks advance exact cursor',int(sql(slow,'SELECT last_hand_number FROM smarter_private.superseded_action_retention_cursor;','slow-committed-cursor'))==2000000+slow_count)
        next_count=int(sql(slow,'SELECT smarter_private.discover_superseded_action_retention();','next-budgeted-slow-page'))
        expect('next invocation continues completed chunk keys',next_count>=250 and int(sql(slow,'SELECT last_hand_number FROM smarter_private.superseded_action_retention_cursor;','next-slow-cursor'))==2000000+slow_count+next_count)
        e.discard(slow)
        e.discard(backlog)
        late=e.database(empty)
        sql(late,old_private.replace('FUNCTION smarter_private.hand_submission_dispose_dealt_past(', 'FUNCTION smarter_private.native_old_disposal(')+';', 'native-preserved-old-body')
        seed=actions.SEED.split('INSERT INTO smarter_private.hand_submission_disposals')[0].replace("interval '10 days'", "interval '1 day'")
        sql(late,seed+f"INSERT INTO public.hand_atomic_commits(table_id,hand_number,hand_id,payload_hash,stack_result,committed_at) VALUES({lit(actions.TABLE)},1000002,{lit(actions.WITNESS)},repeat('0',64),'{{}}',now());",'old-body-late-receipt-seed')
        sql(late,actions.SEED.replace('9d700000-','9d710000-').replace('FROM smarter_private.hand_submissions;',"FROM smarter_private.hand_submissions WHERE submission_id='9d710000-0000-4000-8000-000000000002';")+"INSERT INTO smarter_private.superseded_action_retention_due SELECT submission_id,now()-interval '1 day',now()-interval '1 day' FROM smarter_private.hand_submissions WHERE submission_id='9d710000-0000-4000-8000-000000000002';",'due-work-during-old-transaction')
        def old_inflight():
            e.sql(late,f"BEGIN; SELECT pg_advisory_xact_lock(789004,1); SELECT pg_sleep(1.5); SELECT smarter_private.native_old_disposal({lit(actions.TABLE)},1000001); COMMIT;",label='actual-old-body-inflight')
        old_thread=threading.Thread(target=old_inflight)
        threads.append(old_thread)
        old_thread.start()
        until=time.monotonic()+2
        while time.monotonic()<until:
            if sql(late,"SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=789004 AND objid=1 AND granted);",'old-body-admitted')=='t': break
        else: raise AssertionError('old producer did not enter transaction')
        expect('due work progresses while old transaction blocks discovery',sql(late,'SELECT smarter_private.progress_superseded_action_retention();','due-during-old-transaction')=='1')
        sql(late,'SELECT smarter_private.discover_superseded_action_retention();','old-transaction-barrier')
        expect('old in-flight producer prevents historical cursor passing late key',sql(late,'SELECT last_table_id IS NULL AND NOT completed AND discovery_cutoff IS NOT NULL FROM smarter_private.superseded_action_retention_cursor;','barrier-keeps-first-key')=='t')
        old_thread.join()
        expect('old body naturally has no new enqueue',sql(late,'SELECT count(*) FROM smarter_private.superseded_action_retention_due;','old-body-no-queue')=='0')
        sql(late,'SELECT smarter_private.discover_superseded_action_retention();','discover-late-old-receipt')
        expect('first post-barrier page captures late old-body receipt',sql(late,f'SELECT count(*) FROM smarter_private.superseded_action_retention_due WHERE submission_id={lit(actions.HAND)};','late-old-receipt-queued')=='1')
        e.discard(late)
        held=e.database(empty)
        sql(held,actions.SEED+actions.SEED.replace('9d700000-','9d710000-').replace('FROM smarter_private.hand_submissions;',"FROM smarter_private.hand_submissions WHERE submission_id='9d710000-0000-4000-8000-000000000002';")+"INSERT INTO smarter_private.superseded_action_retention_due SELECT submission_id,now()-interval '1 day',now()-interval '1 day' FROM smarter_private.hand_submissions;",'two-due-requests')
        started=threading.Event()
        def hold_source():
            started.set()
            e.sql(held,f"BEGIN; SELECT 1 FROM smarter_private.hand_submissions WHERE submission_id={lit(actions.HAND)} FOR UPDATE; SELECT pg_advisory_xact_lock(789003,1); SELECT pg_sleep(1.5); COMMIT;",label='actual-source-row-holder')
        thread=threading.Thread(target=hold_source)
        threads.append(thread)
        thread.start()
        started.wait()
        # Observe the holder's actual advisory lock instead of a guessed wait.
        until=time.monotonic()+2
        while time.monotonic()<until:
            if sql(held,"SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=789003 AND objid=1 AND granted);",'holder-admitted')=='t': break
        else: raise AssertionError('source row holder never admitted')
        expect('locked source does not starve another due ID',sql(held,'SELECT smarter_private.progress_superseded_action_retention();','skip-held-source')=='1')
        expect('locked source keeps bookkeeping and evidence for later',sql(held,f"SELECT EXISTS(SELECT 1 FROM smarter_private.superseded_action_retention_due WHERE submission_id={lit(actions.HAND)} AND next_at>now()) AND EXISTS(SELECT 1 FROM smarter_private.hand_submissions WHERE submission_id={lit(actions.HAND)} AND request#>'{{p_hand_row,actions}}' IS NOT NULL);",'held-source-preserved')=='t')
        thread.join()
        sql(held,'UPDATE smarter_private.superseded_action_retention_due SET next_at=now();','explicit-native-next-turn')
        expect('released source compacts on next admitted turn',sql(held,'SELECT smarter_private.progress_superseded_action_retention();','released-turn')=='1')
        e.discard(held)
        fairness=e.database(empty)
        sql(fairness,actions.SEED+"INSERT INTO smarter_private.superseded_action_retention_due SELECT ('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,now()-interval '2 days',now()-interval '2 days' FROM generate_series(1,100)n; INSERT INTO smarter_private.superseded_action_retention_due SELECT submission_id,now()-interval '1 day',now()-interval '1 day' FROM smarter_private.hand_submissions;",'hundred-refused-before-valid')
        expect('one bounded turn never exceeds hundred due IDs',sql(fairness,'SELECT smarter_private.progress_superseded_action_retention();','refused-first-turn')=='0')
        expect('refused rows retry without starving ID after first hundred',sql(fairness,'SELECT smarter_private.progress_superseded_action_retention();','valid-next-turn')=='1')
        expect('generic false eligibility keeps all hundred retry entries',sql(fairness,'SELECT count(*) FROM smarter_private.superseded_action_retention_due WHERE next_at>now();','refused-kept')=='100')
        e.discard(fairness)
        cost=e.database(empty)
        compressible=actions.SEED.replace("'seq',n,'action','call','amount',n,'event_digest',md5(n::text)||md5((n*37)::text)||md5((n*47)::text)","'action','call','amount',10")
        if compressible==actions.SEED: raise AssertionError('compressible seed replacement missing')
        sql(cost,compressible+"INSERT INTO smarter_private.superseded_action_retention_due SELECT submission_id,now()-interval '1 day',now()-interval '1 day' FROM smarter_private.hand_submissions;",'net-negative-source')
        cost_before=sql(cost,"SELECT jsonb_build_object('source',to_jsonb(s),'disposal',(SELECT to_jsonb(d) FROM smarter_private.hand_submission_disposals d)) FROM smarter_private.hand_submissions s;",'net-negative-before')
        expect('net-negative request passes semantic eligibility',sql(cost,f'SELECT smarter_private.superseded_horse_actions_eligible({lit(actions.HAND)});','net-negative-qualifier')=='t')
        expect('net-negative stored benefit refuses compaction',sql(cost,'SELECT smarter_private.progress_superseded_action_retention();','net-negative-turn')=='0')
        expect('net-negative source and disposal remain byte identical',cost_before==sql(cost,"SELECT jsonb_build_object('source',to_jsonb(s),'disposal',(SELECT to_jsonb(d) FROM smarter_private.hand_submission_disposals d)) FROM smarter_private.hand_submissions s;",'net-negative-after'))
        expect('net-negative retry retains queue without certificate',sql(cost,'SELECT (SELECT count(*) FROM smarter_private.superseded_action_retention_due WHERE next_at>now())=1 AND NOT EXISTS(SELECT 1 FROM smarter_private.superseded_horse_action_certificates);','net-negative-retry')=='t')
        e.discard(cost)
        frozen=e.database(empty)
        sql(frozen,actions.SEED+"INSERT INTO smarter_private.superseded_action_retention_due SELECT submission_id,now()-interval '1 day',now()-interval '1 day' FROM smarter_private.hand_submissions;",'frozen-seed')
        expect('freeze declines both phases without cursor or certificate mutation',sql(frozen,"SET app.test_platform_frozen='true'; SELECT smarter_private.progress_superseded_action_retention()=0 AND smarter_private.discover_superseded_action_retention()=0 AND NOT EXISTS(SELECT 1 FROM smarter_private.superseded_horse_action_certificates) AND (SELECT discovery_cutoff IS NULL FROM smarter_private.superseded_action_retention_cursor);",'freeze-refusal')=='t')
        e.discard(frozen)
        human=e.database(empty)
        sql(human,actions.SEED.replace("'has_human',false", "'has_human',true")+"INSERT INTO smarter_private.superseded_action_retention_due SELECT submission_id,now()-interval '1 day',now()-interval '1 day' FROM smarter_private.hand_submissions;",'immutable-human-noncandidate')
        human_before=sql(human,'SELECT to_jsonb(s) FROM smarter_private.hand_submissions s;','human-before')
        sql(human,'SELECT smarter_private.progress_superseded_action_retention();','human-due-turn')
        expect('immutable noncandidate discards only derived queue entry',sql(human,'SELECT count(*) FROM smarter_private.superseded_action_retention_due;','human-queue-empty')=='0' and sql(human,'SELECT count(*) FROM smarter_private.superseded_horse_action_certificates;','human-no-certificate')=='0' and human_before==sql(human,'SELECT to_jsonb(s) FROM smarter_private.hand_submissions s;','human-after'))
        e.discard(human)
        rolled=e.database(empty)
        sql(rolled,actions.SEED,'rollback-seed')
        sql(rolled,'BEGIN; SELECT smarter_private.discover_superseded_action_retention(); ROLLBACK;','rollback-discovery')
        expect('rolled-back discovery advances neither cursor nor queue',sql(rolled,'SELECT last_table_id IS NULL AND NOT completed AND NOT EXISTS(SELECT 1 FROM smarter_private.superseded_action_retention_due) FROM smarter_private.superseded_action_retention_cursor;','rollback-cursor')=='t')
        sql(rolled,'BEGIN; SELECT pg_advisory_xact_lock(530090,2); ROLLBACK;','native-reservation-shape')
        e.discard(rolled)
        command=sql(base,'SELECT command FROM cron.job WHERE jobid=117;','exact-installed-job')
        expect('original prune command preserved byte for byte',command.startswith('BEGIN;'+original+'COMMIT; BEGIN;'))
        code,stdout,stderr=simple(base,command,'simple-query-normal')
        expect('same job runs original prune',code==0 and sql(base,'SELECT count(*) FROM public.progress_prune_receipts;','prune-count')=='1')
        late_timeout=e.database(empty)
        sql(late_timeout,actions.SEED+"INSERT INTO smarter_private.superseded_action_retention_due SELECT submission_id,now()-interval '1 day',now()-interval '1 day' FROM smarter_private.hand_submissions; CREATE OR REPLACE FUNCTION smarter_private.discover_superseded_action_retention() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(10); RETURN 0; END $$;",'historical-timeout-injection-only-native')
        started=time.monotonic()
        code,_,err=simple(late_timeout,command,'simple-query-third-phase-timeout',False)
        third_elapsed=time.monotonic()-started
        expect('historical timeout is bounded and remains visible',code!=0 and 'statement timeout' in err and 1.8<third_elapsed<3.5)
        expect('historical timeout preserves original prune commit',sql(late_timeout,'SELECT count(*) FROM public.progress_prune_receipts;','third-prune-survives')=='1')
        expect('historical timeout preserves due certificate and queue commit',sql(late_timeout,'SELECT (SELECT count(*) FROM smarter_private.superseded_horse_action_certificates)=1 AND NOT EXISTS(SELECT 1 FROM smarter_private.superseded_action_retention_due);','third-due-survives')=='t')
        e.discard(late_timeout)
        sql(base,"CREATE OR REPLACE FUNCTION smarter_private.progress_superseded_action_retention() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(10); RETURN 0; END $$;",'timeout-injection-only-native')
        started=__import__('time').monotonic()
        code,stdout,stderr=simple(base,command,'simple-query-second-phase-timeout',False)
        elapsed=__import__('time').monotonic()-started
        expect('new phase hard deadline fires visibly',code!=0 and 'statement timeout' in stderr and 1.8<elapsed<3.5)
        expect('first transaction survives second phase timeout',sql(base,'SELECT count(*) FROM public.progress_prune_receipts;','prune-survives')=='2')
        sql(base,"CREATE OR REPLACE FUNCTION public.sp_prune_hand_history(integer) RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ORIGINAL_PRUNE_FAILED'; END $$; CREATE OR REPLACE FUNCTION smarter_private.progress_superseded_action_retention() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.progress_prune_receipts VALUES(99); RETURN 0; END $$;",'original-failure-injection-only-native')
        code,_,err=simple(base,command,'simple-query-first-phase-failure',False)
        expect('original failure prevents new phase',code!=0 and 'ORIGINAL_PRUNE_FAILED' in err and sql(base,'SELECT count(*) FROM public.progress_prune_receipts;','first-failure-readback')=='2')
        e.report.update(status='passed',checks=checks,source_sha256={str(path.relative_to(ROOT)):sha(path) for path in [migration,budget_migration,Path(__file__),actions.MIGRATION,actions.PREIMAGE,ROOT/doors.WORLD,ROOT/doors.MIGRATION]},simple_query_timeout_seconds=elapsed)
    except BaseException as exc:
        e.report.update(status='failed',failure=repr(exc))
        raise
    finally:
        for thread in threads:
            thread.join(timeout=5)
        e.close()
        e.report['checks']=checks
        (out/'result.json').write_text(json.dumps(e.report,indent=2)+'\n')
    print(json.dumps({'status':e.report['status'],'checks':len(checks),'evidence':str(out)}))
if __name__=='__main__':
    main()
