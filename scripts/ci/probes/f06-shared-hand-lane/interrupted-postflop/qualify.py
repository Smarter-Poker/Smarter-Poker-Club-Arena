"""Native proof of the exact event-owned interrupted-hand void transaction."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time


def qualify(root, out, cmd, command, run, probe, require, results):
    migration=root/'supabase/migrations/20261028233452_interrupted_postflop_void_preserves_original_principal.sql'
    here=root/'scripts/ci/probes/f06-shared-hand-lane/abandoned-addon'
    results['interruptedPostflopInputs']={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [migration,Path(__file__),Path(__file__).with_name('fixture.sql'),root/'scripts/ci/test-f06-shared-hand-lane.py']}
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
        run('postflop-originals','SELECT fixture_seed(); SELECT fixture_postflop();')
        before=run('postflop-principal-before',"SELECT jsonb_build_object('chairs',(SELECT jsonb_agg(s ORDER BY id) FROM table_seats s),'regs',(SELECT jsonb_agg(p ORDER BY id) FROM tournament_players p),'lease',(SELECT jsonb_agg(l) FROM engine_tournament_leases l),'history',(SELECT jsonb_agg(h) FROM hand_history h),'atomic',(SELECT jsonb_agg(a) FROM hand_atomic_commits a));")
        probe('postflop-fails-before',service+'SELECT '+call+';',error='F06_ABORT_SAVED_STACKS_CHANGED')
        run('postflop-install',migration.read_text())
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
        fence=fence[fence.index('CREATE OR REPLACE FUNCTION smarter_private.f06_aborted_hand_guard()'):fence.index('REVOKE ALL ON FUNCTION smarter_private.f06_aborted_hand_guard()')]
        run('postflop-existing-late-fence',"CREATE TABLE smarter_private.f06_unsettled_hand_aborts(table_id uuid,hand_number bigint); CREATE TABLE smarter_private.f06_mixed_abort_hands(table_id uuid,hand_number bigint);"+fence+"CREATE TRIGGER existing_aborted_fence BEFORE INSERT ON hand_atomic_commits FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_aborted_hand_guard(); CREATE TRIGGER existing_history_fence BEFORE INSERT ON hand_history FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_aborted_hand_guard();")
        probe('postflop-late-commit-fenced',"INSERT INTO hand_atomic_commits(table_id,hand_number) VALUES(md5('addon-table')::uuid,11);",error='F06_ABORTED_HAND_FENCED')
        probe('postflop-late-history-fenced',"INSERT INTO hand_history(table_id,hand_number) VALUES(md5('addon-table')::uuid,11);",error='F06_ABORTED_HAND_FENCED')
        run('postflop-ruling-is-honest' ,"SELECT expected->>'ruling'||'|'||(expected->>'shape') FROM smarter_private.f06_generation_abort_hands WHERE table_id=md5('addon-table')::uuid;",'misdeal_voided|interrupted_postflop_principal_preserved')
        after=run('postflop-principal-after',"SELECT jsonb_build_object('chairs',(SELECT jsonb_agg(s ORDER BY id) FROM table_seats s),'regs',(SELECT jsonb_agg(p ORDER BY id) FROM tournament_players p),'lease',(SELECT jsonb_agg(l) FROM engine_tournament_leases l),'history',(SELECT jsonb_agg(h) FROM hand_history h),'atomic',(SELECT jsonb_agg(a) FROM hand_atomic_commits a));")
        require(before==after,'Void changed a chair, registration, current lease, history or atomic commit')
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
