"""Native proof of the exact event-owned interrupted-hand void transaction."""
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
import time


def qualify(root, out, cmd, command, run, probe, require, results):
    migration=root/'supabase/migrations/20261029011340_legacy_postflop_void_preserves_original_principal.sql'
    here=root/'scripts/ci/probes/f06-shared-hand-lane/abandoned-addon'
    results['interruptedPostflopInputs']={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [migration,Path(__file__),Path(__file__).with_name('fixture.sql'),root/'scripts/ci/test-f06-shared-hand-lane.py',*sorted((Path(__file__).parent).glob('*.sql')),Path(__file__).with_name('prerequisite-provenance.json')]}
    previous=cmd[-1]
    run('postflop-database','CREATE DATABASE interrupted_postflop;')
    cmd[-1]='interrupted_postflop'
    service="SET request.jwt.claims='{\"role\":\"service_role\"}'; SET app.smarter_data_actor='tournament-manager';"
    call="public.fn_f06_abort_abandoned_generation(md5('addon-event')::uuid,md5('old-generation')::uuid,md5('river-receipt')::uuid,'native interrupted postflop original principal disposition',false)"
    try:
        run('postflop-fixture',(here/'fixture.sql').read_text())
        run('postflop-prior-schema', (root/'scripts/ci/probes/f06-shared-hand-lane/interrupted-postflop/fixture.sql').read_text())
        run('postflop-old-door',(here/'preimage.sql').read_text()+"; REVOKE ALL ON FUNCTION public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean) TO service_role;")
        run('postflop-current-door',(root/'supabase/migrations/20261018152437_a_documented_addon_does_not_strand_an_abandoned_misdeal.sql').read_text())
        run('postflop-recorded-emergency-preimage',(Path(__file__).with_name('installed-emergency-preimage.sql')).read_text())
        probe('postflop-floor-required',migration.read_text().replace('BEGIN;','').replace('COMMIT;',''),error='INTERRUPTED_POSTFLOP_PREIMAGE_DRIFT')
        run('postflop-clock-floor-prerequisite',(Path(__file__).with_name('floor-prerequisite.sql')).read_text())
        run('postflop-originals','SELECT fixture_seed(); SELECT fixture_postflop();')
        run('postflop-guard-schema',(Path(__file__).with_name('guard-schema.sql')).read_text())
        run('postflop-actual-guards',(Path(__file__).with_name('actual-disposition-guards.sql')).read_text())
        run('postflop-bind-actual-guards',"SELECT string_agg(md5(pg_get_functiondef(oid)),',' ORDER BY proname) FROM pg_proc WHERE pronamespace='smarter_private'::regnamespace AND proname IN ('f06_cancelled_preparation_writer_guard','hand_submission_snapshot_guard','f06_retained_submission_guard','f06_immutable_identity','f06_mixed_preparation_guard');",'3219dd0db0c0de9e8f9c02f4609eaaf8,0fe40a0711ef6d196c6883d3b9e8b86f,bcbdb70741099a7806acd90e838cc03f,8effe23bf967551f427628433dab6191,1c7cebb494c87906a20a7aecdd0338d7')
        run('postflop-trigger-bindings',"CREATE TRIGGER a00_f06_cancelled_preparation BEFORE INSERT OR UPDATE ON hand_state_snapshots FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_cancelled_preparation_writer_guard(); CREATE TRIGGER hand_submission_snapshot_guard AFTER INSERT OR UPDATE OF is_complete ON hand_state_snapshots FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_submission_snapshot_guard(); CREATE TRIGGER f06_retained_submission_guard AFTER UPDATE OF state ON smarter_private.f06_hand_permits FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_retained_submission_guard(); CREATE TRIGGER f06_hand_permits_immutable BEFORE UPDATE OR DELETE ON smarter_private.f06_hand_permits FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_immutable_identity(); CREATE TRIGGER f06_mixed_preparation_custody BEFORE INSERT OR UPDATE ON smarter_private.f06_hand_permits FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_mixed_preparation_guard();")
        before=run('postflop-principal-before',"SELECT jsonb_build_object('chairs',(SELECT jsonb_agg(s ORDER BY id) FROM table_seats s),'regs',(SELECT jsonb_agg(p ORDER BY id) FROM tournament_players p),'lease',(SELECT jsonb_agg(l) FROM engine_tournament_leases l),'history',(SELECT jsonb_agg(h) FROM hand_history h),'atomic',(SELECT jsonb_agg(a) FROM hand_atomic_commits a));")
        probe('postflop-fails-before',service+'SELECT '+call+';',error='F06_ABORT_SAVED_STACKS_CHANGED')
        # This is the continuation owner's exact unique-disposition contract,
        # not an independent EXISTS-only imitation of its retained fence.
        guard_start=migration.read_text().index(' -- The floor alone is not continuation authority.')
        guard_end=migration.read_text().index(' prior:=p.definition;',guard_start)
        unhardened=migration.read_text()[:guard_start]+migration.read_text()[guard_end:]
        probe('postflop-unhardened-floor-alone-baseline-installs',unhardened.replace('BEGIN;','').replace('COMMIT;',''))
        probe('postflop-floor-alone-cannot-install',migration.read_text().replace('BEGIN;','').replace('COMMIT;',''),error='INTERRUPTED_POSTFLOP_CONTINUATION_CONTRACT_UNPROVEN')
        run('postflop-capsule-disposition-contract',Path(__file__).with_name('capsule-disposition-contract.sql').read_text())
        install=migration.read_text().replace('BEGIN;','').replace('COMMIT;','')
        for name,change in [
            ('missing-capsule-assertion', 'DROP FUNCTION smarter_private.assert_hand_continuation_disposition(uuid,bigint);'),
            ('missing-permit-guard', 'DROP TRIGGER f06_retained_submission_guard ON smarter_private.f06_hand_permits;'),
            ('disabled-permit-guard', 'ALTER TABLE smarter_private.f06_hand_permits DISABLE TRIGGER f06_retained_submission_guard;'),
            ('disabled-snapshot-guard', 'ALTER TABLE hand_state_snapshots DISABLE TRIGGER hand_submission_snapshot_guard;'),
            ('noop-capsule-assertion', "CREATE OR REPLACE FUNCTION smarter_private.assert_hand_continuation_disposition(tab uuid,hn bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN RETURN; END $$;"),
        ]:
            probe('postflop-install-'+name+'-refused',change+install,error='INTERRUPTED_POSTFLOP_CONTINUATION_CONTRACT_UNPROVEN')
        run('postflop-install',migration.read_text())
        # Execute the actual declared header in the ledger reader's UNION shape.
        # A standalone SELECT/alias/semicolon is not a scalar boolean expression.
        declared=re.findall(r'^-- @live-proof: (.*)$',migration.read_text(),re.M)
        require(len(declared)==1,'Postflop migration must declare exactly one live proof')
        reader=(root/'scripts/ci/check-migrations-are-live.mjs').read_text()
        require("`select ${i} as i, coalesce((select (${p}))::text, 'null') as answer`" in reader,'Ledger proof wrapper changed; review native qualification')
        wrapped="select 0 as i, coalesce((select ("+declared[0]+"))::text, 'null') as answer union all select 1 as i, coalesce((select (true))::text, 'null') as answer"
        run('postflop-declared-live-proof-reader-wrapper',wrapped,'0|true\n1|true')
        retained="INSERT INTO smarter_private.hand_continuations(table_id,hand_number,tournament_id,permit_id,original_generation,writer_generation,sequence,payload,payload_sha256) VALUES(md5('addon-table')::uuid,11,md5('addon-event')::uuid,md5('addon-permit')::uuid,md5('old-generation')::uuid,md5('new-generation')::uuid,1,'native-original-capsule','"+hashlib.sha256(b'native-original-capsule').hexdigest()+"'); INSERT INTO smarter_private.hand_continuation_dispositions VALUES(md5('addon-table')::uuid,11,'retained');"
        probe('postflop-retained-modern-original-refuses',retained+service+'SELECT '+call+';',error='HAND_CONTINUATION_UNSETTLED')
        probe('postflop-foreign-disposed-permit-refuses',"INSERT INTO smarter_private.hand_submission_dispositions(table_id,hand_number,disposition,submission_id,permit_id) VALUES(md5('addon-table')::uuid,11,'disposed',NULL,md5('foreign-permit')::uuid);"+service+'SELECT '+call+';',error='F06_RETAINED_HAND_SUBMISSION_REQUIRES_ACCEPTED_DISPOSITION')
        run('postflop-capsule-refusal-is-atomic',"SELECT (SELECT count(*) FROM smarter_private.hand_continuations)||'|'||(SELECT count(*) FROM smarter_private.hand_continuation_dispositions)||'|'||(SELECT count(*) FROM smarter_private.f06_generation_aborts)||'|'||(SELECT count(*) FROM smarter_private.f06_hand_permits WHERE state='reserved');",'0|0|0|3')
        run('postflop-clock-resolver-fixture',"CREATE FUNCTION public.fn_resolve_tournament_blinds(jsonb,integer,text,text,jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('small_blind',power(2,$2),'big_blind',2*power(2,$2),'ante',0) $$;")
        probe('postflop-preserves-higher-played-clock-floor',"UPDATE tournaments SET current_level=2; UPDATE hand_history SET small_blind=2,big_blind=4 WHERE table_id=md5('preflop-table1')::uuid;"+service+'SELECT ('+call+")->'level'->>'to_level';",'1')
        success=service+'SELECT ('+call+")->>'misdeals_voided';"
        probe('postflop-river-principal-passes',success,'1')
        probe('postflop-bad-sibling-atomic-rollback',"UPDATE hand_state_snapshots SET state_json=jsonb_set(state_json,'{pot}','1') WHERE table_id=md5('preflop-table1')::uuid;"+service+'SELECT '+call+';',error='F06_ABORT_SAVED_STACKS_CHANGED')
        run('postflop-no-partial-disposition',"SELECT (SELECT count(*) FROM smarter_private.f06_generation_aborts)||'|'||(SELECT count(*) FROM smarter_private.f06_hand_permits WHERE state='reserved')||'|'||(SELECT count(*) FROM hand_state_snapshots WHERE NOT is_complete);",'0|3|3')
        for stage in ['flop','turn']:
            probe('postflop-'+stage+'-passes',"UPDATE hand_state_snapshots SET stage='"+stage+"',state_json=jsonb_set(state_json,'{stage}','\""+stage+"\"') WHERE table_id=md5('addon-table')::uuid;"+success,'1')
        for name,change,error in [
          ('unknown-variant',"UPDATE hand_state_snapshots SET config_json='{}';",'F06_INTERRUPTED_PRINCIPAL_UNPROVEN'),
          ('one-chip-principal',"UPDATE table_seats SET stack=stack+1 WHERE seat_number=1 AND table_id=md5('addon-table')::uuid; UPDATE tournament_players SET chips=chips+1 WHERE seat_number=1 AND table_id=md5('addon-table')::uuid;",'F06_INTERRUPTED_PRINCIPAL_UNPROVEN'),
          ('prior-written',"UPDATE hand_atomic_commits SET stack_result=jsonb_set(stack_result,ARRAY['written',md5('addon-user1')::uuid::text],'2999');",'F06_INTERRUPTED_PRIOR_BOUNDARY_UNPROVEN'),
          ('committed-at-missing',"UPDATE hand_atomic_commits SET committed_at=NULL;",'F06_INTERRUPTED_PRIOR_BOUNDARY_UNPROVEN'),
          ('postcommit-missing',"UPDATE hand_atomic_commits SET post_commit_completed_at=NULL;",'F06_INTERRUPTED_PRIOR_BOUNDARY_UNPROVEN'),
          ('late-chair-old',"UPDATE table_seats SET joined_at=now()-interval '2 hours' WHERE user_id=md5('late')::uuid;",'F06_INTERRUPTED_PRINCIPAL_UNPROVEN'),
          ('late-chair-card',"INSERT INTO table_hole_cards VALUES(md5('addon-table')::uuid,11,md5('late')::uuid);",'F06_INTERRUPTED_PRINCIPAL_UNPROVEN'),
          ('retained',"INSERT INTO smarter_private.hand_submissions VALUES(md5('addon-table')::uuid,11);",'F06_ABANDONED_HAND_HAS_A_RETAINED_SUBMISSION'),
          ('accepted',"INSERT INTO hand_atomic_commits(table_id,hand_number) VALUES(md5('addon-table')::uuid,11);",'F06_ABORT_COMMITTED_OR_DISPATCHED'),
          ('private',"INSERT INTO hand_private_state VALUES(md5('addon-table')::uuid,11);",'F06_ABORT_COMMITTED_OR_DISPATCHED'),
          ('dispatch',"INSERT INTO smarter_private.f06_hand_dispatch VALUES(md5('addon-permit')::uuid,1);",'F06_ABORT_COMMITTED_OR_DISPATCHED'),
          ('live-owner',"UPDATE engine_tournament_leases SET lease_generation=md5('old-generation')::uuid;",'F06_GENERATION_STILL_LIVE'),
          ('wrong-occupancy',"UPDATE table_seats SET id=md5('replacement-seat')::uuid WHERE seat_number=1 AND table_id=md5('addon-table')::uuid;",'F06_INTERRUPTED_PRIOR_BOUNDARY_UNPROVEN'),
        ]:
            probe('postflop-'+name+'-refused',change+service+'SELECT '+call+';',error=error)
        probe('postflop-browser-refused',"SET request.jwt.claims='{\"role\":\"authenticated\"}';SELECT "+call+';',error='F06_ABANDONED_SERVICE_REQUIRED')
        probe('postflop-wrong-actor-refused',"SET request.jwt.claims='{\"role\":\"service_role\"}';SET app.smarter_data_actor='browser';SELECT "+call+';',error='F06_ABANDONED_SERVICE_REQUIRED')
        probe('postflop-freeze-refused',"CREATE OR REPLACE FUNCTION public.fn_platform_frozen() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;"+service+'SELECT '+call+';',error='PLATFORM_FROZEN')
        probe('postflop-reinstall-refused',migration.read_text().replace('BEGIN;','').replace('COMMIT;',''),error='INTERRUPTED_POSTFLOP_PREIMAGE_DRIFT')
        # Two original transaction calls compete for the SAME receipt, not
        # a synthetic replacement implementation of the idempotency rule.
        first=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env={k:v for k,v in os.environ.items() if not k.startswith('PG')})
        second=None
        try:
            first.stdin.write('BEGIN;'+success+"SELECT pg_advisory_lock(28233452);\n")
            first.stdin.flush()
            until=time.monotonic()+5
            while command(cmd,"SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=28233452 AND granted);").stdout.strip()!='t':
                require(first.poll() is None and time.monotonic()<until,'Original void transaction barrier unavailable')
                time.sleep(.02)
            second=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env={k:v for k,v in os.environ.items() if not k.startswith('PG')})
            second.stdin.write(service+'SELECT ('+call+")->>'replayed';\n")
            second.stdin.close()
            until=time.monotonic()+5
            while command(cmd,"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%river-receipt%');").stdout.strip()!='t':
                require(second.poll() is None and time.monotonic()<until,'Competing original receipt did not wait')
                time.sleep(.02)
            first.stdin.write('COMMIT;\n');first.stdin.close();first.wait(timeout=5)
            second.wait(timeout=5)
            require(first.returncode==0 and second.returncode==0,'Concurrent receipt transaction failed')
            require(second.stdout.read().strip()=='true','Second original transaction failed to replay')
            results['cases'].append({'name':'postflop-concurrent-same-receipt-replays','passed':True})
        finally:
            for process in [first,second]:
                if process is not None and process.poll() is None:
                    process.kill();process.wait()

        run('postflop-same-receipt-replays',service+'SELECT ('+call+")->>'replayed';",'true')
        run('postflop-exact-terminal',"SELECT count(*) FROM smarter_private.f06_hand_permits WHERE state='aborted_unsettled' AND evidence_id=md5('river-receipt')::uuid;",'3')
        # Install and execute the existing production late-hand fence itself.
        fence=(root/'supabase/migrations/20260918065923_mixed_generation_disposition_preserves_committed_stacks.sql').read_text()
        fence=fence[fence.index('CREATE OR REPLACE FUNCTION smarter_private.f06_aborted_hand_guard()'):fence.index('REVOKE ALL ON FUNCTION smarter_private.f06_aborted_hand_guard()')].replace("RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001'","RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='55P03'")
        run('postflop-existing-late-fence',""+fence+"CREATE TRIGGER existing_aborted_fence BEFORE INSERT ON hand_atomic_commits FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_aborted_hand_guard(); CREATE TRIGGER existing_history_fence BEFORE INSERT ON hand_history FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_aborted_hand_guard();")
        run('postflop-actual-late-fence',"SELECT md5(pg_get_functiondef('smarter_private.f06_aborted_hand_guard()'::regprocedure));",'49046cee6eb91ce98c44564e0590e452')
        probe('postflop-late-commit-fenced',"INSERT INTO hand_atomic_commits(table_id,hand_number) VALUES(md5('addon-table')::uuid,11);",error='F06_ABORTED_HAND_FENCED')
        probe('postflop-late-history-fenced',"INSERT INTO hand_history(table_id,hand_number) VALUES(md5('addon-table')::uuid,11);",error='F06_ABORTED_HAND_FENCED')
        run('postflop-ruling-is-honest' ,"SELECT expected->>'ruling'||'|'||(expected->>'shape') FROM smarter_private.f06_generation_abort_hands WHERE table_id=md5('addon-table')::uuid;",'misdeal_voided|interrupted_postflop_principal_preserved')
        after=run('postflop-principal-after',"SELECT jsonb_build_object('chairs',(SELECT jsonb_agg(s ORDER BY id) FROM table_seats s),'regs',(SELECT jsonb_agg(p ORDER BY id) FROM tournament_players p),'lease',(SELECT jsonb_agg(l) FROM engine_tournament_leases l),'history',(SELECT jsonb_agg(h) FROM hand_history h),'atomic',(SELECT jsonb_agg(a) FROM hand_atomic_commits a));")
        require(before==after,'Void changed a chair, registration, current lease, history or atomic commit')
        run('postflop-exact-three-disposed',"SELECT (SELECT count(*) FROM smarter_private.hand_submission_dispositions WHERE disposition='disposed' AND submission_id IS NULL)||'|'||(SELECT count(*) FROM smarter_private.hand_continuation_dispositions WHERE disposition='disposed')||'|'||(SELECT count(*) FROM smarter_private.hand_continuations);",'3|3|0')
        results['interruptedPostflop']={'passed':True,'scope':'Original principal retained; no accepted hand, profit or exact controller resume claim'}
    finally:
        cmd[-1]=previous

if __name__ == '__main__':
    root = Path(__file__).resolve().parents[5]
    out = Path(os.environ['INTERRUPTED_EVIDENCE']).resolve()
    out.mkdir(parents=True, exist_ok=False)
    pg = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
    cluster = Path(tempfile.mkdtemp(prefix='postflop-', dir=os.environ['TMPDIR']))
    socket = cluster / 's'
    socket.mkdir(mode=0o700)
    env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
    env['LC_ALL'] = 'C'
    cmd = [str(pg/'psql'), '-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', str(socket), '-p', '55698', '-U', 'postgres', '-d', 'postgres']
    results = {'cases': [], 'passed': False}
    def command(argv, sql=None):
        return subprocess.run([str(x) for x in argv], input=sql, capture_output=True, text=True, env=env, timeout=30)
    def require(ok, message):
        if not ok:
            raise RuntimeError(message)
    def run(name, sql, expected=None, error=None):
        r = command(cmd, sql)
        (out/(name+'.log')).write_text(r.stdout+r.stderr)
        good = (r.returncode != 0 and error in r.stderr) if error else r.returncode == 0
        if expected is not None:
            good = good and r.stdout.rstrip('\n') == expected
        results['cases'].append({'name': name, 'passed': good})
        require(good, name+': '+r.stdout[-500:]+r.stderr[-1500:])
        return r.stdout.rstrip('\n')
    def probe(name, sql, expected=None, error=None):
        return run(name, 'BEGIN;\n'+sql+'\nROLLBACK;', expected, error)
    try:
        r = command([pg/'initdb', '-D', cluster/'d', '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
        require(r.returncode == 0, r.stderr)
        with (cluster/'d/postgresql.conf').open('a') as f:
            f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(socket)+"'\nport=55698\nshared_buffers='16MB'\n")
        r = command([pg/'pg_ctl', '-D', cluster/'d', '-l', cluster/'pg.log', '-w', 'start'])
        require(r.returncode == 0, r.stderr)
        run('addon-roles', 'CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;')
        qualify(root, out, cmd, command, run, probe, require, results)
        results['passed'] = True
    finally:
        command([pg/'pg_ctl', '-D', cluster/'d', '-m', 'immediate', '-w', 'stop'])
        (out/'result.json').write_text(json.dumps(results, indent=2)+'\n')
        shutil.rmtree(cluster)
