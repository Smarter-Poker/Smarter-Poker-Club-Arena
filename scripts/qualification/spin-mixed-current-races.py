#!/usr/bin/env python3
"""Finite synthetic current-terminal races using the maintained Spin Session.

Each mode requires its own fresh allocation. The model contains declared input
receipts; only the real terminal writer produces completion/payment outputs.
No historical recovery, fee-bearing completion or incident closure is claimed.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import time

ROOT = Path(__file__).resolve().parents[2]
BASE = 'scripts/qualification/fixtures/spin-mixed-current/'
OBSERVER = BASE + 'observer.sql'
SESSION_PATH = 'scripts/qualification/spin-expiry-business-races.py'
SESSION_SHA = '619267d012bb64257d639006c133d03c95f16c7e243b334e6af661d5900b95c5'
MANIFEST = 'scripts/qualification/spin-mixed-current.hosted.manifest.json'
OUTPUT = 'mixed-current-races.json'
WORK_SECONDS = 20
CLEANUP_SECONDS = 5
T = '10000000-0000-4000-8000-000000000001'
W = '00000000-0000-4000-8000-000000000003'
TABLE = '20000000-0000-4000-8000-000000000001'
LEGACY = '40000000-0000-4000-8000-000000000001'
CALL = f"SELECT public.fn_complete_tournament_terminal('{T}','{W}','places');"
STATE = "SELECT jsonb_build_object('state',pg_temp.mixed_state(),'estate',pg_temp.whole_cash_estate());"
KEYS = "SELECT jsonb_agg(jsonb_build_object('classid',((k>>32)&4294967295)::oid,'objid',(k&4294967295)::oid) ORDER BY ordinal) FROM unnest(ARRAY[hashtextextended('ca:tournament-terminal-settlement:v1',0),hashtextextended('ca:hand-settlement-barrier:v1',0)]) WITH ORDINALITY q(k,ordinal);"
EXPECTED_REFUSAL = 'ERROR:  P0404: mixed-basis retained history refused: unaccepted_receipt'


def require(value, message):
    if not value:
        raise RuntimeError(message)


def source_preconditions(before):
    rows = [r for r in before['state']['settlement_idempotency_keys']
            if r['table_id'] == TABLE and r['hand_id'] == LEGACY]
    require(len(rows) == 1, 'requires exactly one selected legacy receipt')
    require(rows[0]['status'] == 'succeeded' and rows[0]['error'] is None,
            'source-change control requires a successful error-free preimage')
    tournament, = before['state']['tournaments']
    require(tournament['id'] == T and tournament['status'] == 'RUNNING',
            'source-change control requires the original running parent')
    for name in ('ca_spin_mixed_basis_v1', 'ca_spin_mixed_completion_v1',
                 'ca_spin_mixed_dispatch_v1', 'tournament_terminal_settlements',
                 'tournament_payouts', 'tournament_obligations'):
        require(before['state'][name] == [], 'source-change control requires unsealed input: ' + name)
    return {'table_id': TABLE, 'hand_id': LEGACY, 'status': 'succeeded',
            'error': None, 'running_unsealed': True}


def require_source_refusal(raw):
    errors = re.findall(r'^(?:ERROR|FATAL|PANIC):[^\r\n]*', raw, re.M)
    require(errors == [EXPECTED_REFUSAL], 'source-change control received another or missing SQL error: ' + raw)
    require(raw.count('ERROR:') == 1 and 'FATAL:' not in raw and 'PANIC:' not in raw,
            'source-change control contains additional SQL diagnostics: ' + raw)


def wait_for_initial(observer, blocker, caller, barriers, deadline):
    while time.monotonic() < deadline:
        assert caller.poll() is None, 'caller completed before owned wait proof'
        x = observer.json("SELECT jsonb_build_object('pid',a.pid,'type',a.wait_event_type,'event',a.wait_event,'blockers',pg_blocking_pids(a.pid),'locks',(SELECT coalesce(jsonb_agg(jsonb_build_object('mode',l.mode,'granted',l.granted,'classid',l.classid,'objid',l.objid,'objsubid',l.objsubid)),'[]'::jsonb) FROM pg_locks l WHERE l.pid=a.pid AND l.locktype='advisory'),'data_locks',(SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid=l.relation JOIN pg_namespace n ON n.oid=c.relnamespace WHERE l.pid=a.pid AND n.nspname IN ('public','auth','smarter_private') AND l.mode IN ('RowShareLock','RowExclusiveLock','ShareUpdateExclusiveLock','ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock'))) FROM pg_stat_activity a WHERE a.pid=" + str(caller.pid) + ' AND a.datname=current_database();')
        if x and x['type'] == 'Lock' and x['event'] == 'advisory' and x['blockers'] == [blocker.pid]:
            assert x['data_locks'] == 0
            assert len(x['locks']) == 1
            lock, = x['locks']
            assert lock == {'mode': 'ExclusiveLock', 'granted': False, 'classid': barriers[0]['classid'], 'objid': barriers[0]['objid'], 'objsubid': 1}
            return x
        time.sleep(.01)
    raise TimeoutError('exact initial barrier wait not observed')

def rollback(s):
    s.no_errors(s.command('ROLLBACK;'))

def receipt(raw):
    R.Session.no_errors(raw)
    x = R.exact_json(raw)
    assert x['ok'] and x['fully_settled'] and x['status'] == 'COMPLETED'
    return x


def run(args, events, sessions, deadline):
    db = 'qual_spin_expiry_' + args.execution.replace('-', '')
    observer_source = (ROOT / OBSERVER).read_text()
    functions = re.findall(r'CREATE FUNCTION pg_temp\..*?END \$(?:state|estate)\$;', observer_source, re.S)
    require(len(functions) == 2
            and [re.search(r'pg_temp\.(\w+)\(', text).group(1) for text in functions]
                == ['mixed_state', 'whole_cash_estate']
            and all("SET timezone TO 'UTC'" in text.split('AS $', 1)[0] for text in functions),
            'exact UTC observer functions required')

    def new(name):
        session = R.Session(args.psql, db, 'current_mixed_' + name + '_' + args.execution, deadline)
        sessions.append(session)
        session.pid = session.json('SELECT to_jsonb(pg_backend_pid());')
        require(type(session.pid) is int and session.pid > 0, 'invalid original backend PID')
        session.no_errors(session.command(
            "SET qualification.execution_uuid='" + args.execution + "'; "
            "SET spin_mixed_qualification.execution_uuid='" + args.execution + "'; "
            "SET spin_mixed_qualification.tournament_id='" + T + "'; "
            "SET spin_mixed_qualification.winner_id='" + W + "';\n" + '\n'.join(functions)))
        return session

    observer = new('observer')
    environment = observer.json("SELECT jsonb_build_object('database',current_database(),'user',current_user,'session_user',session_user,'port',current_setting('port'),'address',inet_server_addr(),'listen',current_setting('listen_addresses'),'version',current_setting('server_version_num')::int,'super',(SELECT rolsuper FROM pg_roles WHERE rolname=current_user),'others',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()));")
    R.require_private_endpoint(environment, db)
    require(environment['listen'] == '' and environment['super'] is False, 'private nonsuper allocation required')
    events['environment'] = environment
    barriers = observer.json(KEYS)
    before = observer.json(STATE)
    events['before'] = before
    holder, caller = new('holder'), new('caller')
    assert len({s.pid for s in sessions}) == 3
    events['backend_pids'] = {name: session.pid for name, session in [('observer', observer), ('holder', holder), ('caller', caller)]}
    holder.no_errors(holder.command('CREATE TEMP TABLE original_state AS SELECT pg_temp.mixed_state() AS state;'))
    print(holder.command("SELECT jsonb_build_object('stage','consumer_backend','pid',pg_backend_pid(),'backend_start',(SELECT backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid()));"))
    if args.mode == 'source_change':
        events['source_preconditions'] = source_preconditions(before)
        holder.begin(service_role=True)
        count = holder.json("WITH changed AS (UPDATE public.settlement_idempotency_keys SET status='failed',error='qualification-negative-source' WHERE table_id='20000000-0000-4000-8000-000000000001' AND hand_id='40000000-0000-4000-8000-000000000001' RETURNING 1) SELECT to_jsonb(count(*)) FROM changed;")
        assert count == 1
        caller.begin(service_role=True)
        caller.start(CALL)
        wait = wait_for_initial(observer, holder, caller, barriers, deadline)
        assert observer.json(STATE) == before
        holder.no_errors(holder.command('COMMIT;'))
        refused = caller.wait()
        require_source_refusal(refused)
        rollback(caller)
        after = observer.json(STATE)
        # Compare every field except the exact two committed test-source values.
        expected = before.copy()
        expected['state'] = before['state'].copy()
        expected['state']['settlement_idempotency_keys'] = [r.copy() for r in before['state']['settlement_idempotency_keys']]
        changed, = [r for r in expected['state']['settlement_idempotency_keys'] if r['table_id'] == TABLE and r['hand_id'] == LEGACY]
        changed.update(status='failed', error='qualification-negative-source')
        assert after == expected
        events['cases'].append({'case': 'committed_source_reread_after_wait', 'wait': wait, 'affected_rows': 1, 'exact_refusal': True, 'only_declared_source_change': True})
    else:
        holder.begin(service_role=True)
        count = holder.json("WITH changed AS (UPDATE public.settlement_idempotency_keys SET error='qualification-reversible-writer' WHERE hand_id='40000000-0000-4000-8000-000000000001' RETURNING 1) SELECT to_jsonb(count(*)) FROM changed;")
        assert count == 1
        caller.begin(service_role=True)
        caller.start(CALL)
        wait = wait_for_initial(observer, holder, caller, barriers, deadline)
        assert observer.json(STATE) == before
        rollback(holder)
        receipt(caller.wait())
        rollback(caller)
        assert observer.json(STATE) == before
        events['cases'].append({'case': 'receipt_writer_rollback_then_wrapper', 'wait': wait, 'exact_rollback': True})
        for commit in [False, True]:
            holder.begin(service_role=True)
            first = receipt(holder.command(CALL))
            holder.no_errors(holder.command('RESET ROLE;'))
            held = holder.json("SELECT jsonb_agg(jsonb_build_object('classid',classid,'objid',objid,'mode',mode,'granted',granted,'objsubid',objsubid)) FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory';")
            for key in barriers:
                assert dict(key, mode='ExclusiveLock', granted=True, objsubid=1) in held
            if commit:
                print(holder.command(f"SELECT jsonb_build_object('stage','precommit','before',(SELECT state FROM original_state),'after',pg_temp.mixed_state(),'receipt',public.fn_ca_tournament_terminal_receipt('{T}','{W}'));"))
            caller.begin(service_role=True)
            caller.start(CALL)
            wait = wait_for_initial(observer, holder, caller, barriers, deadline)
            assert observer.json(STATE) == before
            holder.no_errors(holder.command('COMMIT;' if commit else 'ROLLBACK;'))
            second = receipt(caller.wait())
            if commit:
                assert first == second
                caller.no_errors(caller.command('COMMIT;'))
                after = observer.json(STATE)
                holder.begin(service_role=True)
                assert receipt(holder.command(CALL)) == first
                holder.no_errors(holder.command('RESET ROLE;'))
                replay_locks = holder.json("SELECT coalesce(jsonb_agg(jsonb_build_object('classid',classid,'objid',objid,'mode',mode)),'[]'::jsonb) FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory';")
                assert not any(l['mode'] == 'ExclusiveLock' and {'classid': l['classid'], 'objid': l['objid']} in barriers for l in replay_locks)
                print(holder.command("SELECT jsonb_build_object('stage','committed_replay','state',pg_temp.mixed_state());"))
                holder.no_errors(holder.command('COMMIT;'))
                assert observer.json(STATE) == after
            else:
                rollback(caller)
                assert observer.json(STATE) == before
            events['cases'].append({'case': 'concurrent_completion_commit_replay' if commit else 'concurrent_completion_rollback_retry', 'wait': wait, 'exclusive_barriers': held, 'second_receipt': second, 'exact_rollback': not commit, 'exact_replay': commit})
    events['after'] = observer.json(STATE)
    events['passed'] = True

def main():
    global R
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--psql', type=Path, required=True)
    parser.add_argument('--execution', required=True)
    parser.add_argument('--mode', choices=('completion', 'source_change'), required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    require(args.psql.is_absolute() and args.psql.is_file(), 'absolute existing psql required')
    require(args.output == ROOT.parent / 'work' / OUTPUT and not args.output.exists(),
            'new exact owned evidence output required')
    require(hashlib.sha256((ROOT / SESSION_PATH).read_bytes()).hexdigest() == SESSION_SHA,
            'existing Session source differs')
    spec = importlib.util.spec_from_file_location('mixed_current_existing_session', ROOT / SESSION_PATH)
    R = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(R)
    R.canonical_uuid(args.execution)
    manifest = json.loads((ROOT / MANIFEST).read_text())
    sources = {}
    require({str(Path(__file__).relative_to(ROOT)), OBSERVER, SESSION_PATH} <= set(manifest['files']),
            'mixed current direct input inventory incomplete')
    for name, pin in manifest['files'].items():
        path = Path(name)
        require(not path.is_absolute() and '..' not in path.parts
                and str(path) == name and (ROOT / path).resolve() == ROOT / path,
                'unsafe mixed current source path')
        content = (ROOT / path).read_bytes()
        sources[name] = hashlib.sha256(content).hexdigest()
        require(len(content) == pin['bytes'] and sources[name] == pin['sha256'],
                'qualification input changed before session start: ' + name)
    sources[MANIFEST] = hashlib.sha256((ROOT / MANIFEST).read_bytes()).hexdigest()
    events = {'execution': args.execution, 'mode': args.mode,
              'qualification': 'synthetic_current_terminal_zero_fee',
              'passed': False, 'cleanup_verified': False, 'cases': [],
              'work_deadline_seconds': WORK_SECONDS, 'cleanup_deadline_seconds': CLEANUP_SECONDS,
              'source_sha256': sources, 'production_mutation': False,
              'full_qualification': False, 'historical_qualification': False,
              'full_financial_qualification': False, 'fee_bearing_qualification': False,
              'incident_closed': False}
    sessions = []
    try:
        run(args, events, sessions, time.monotonic() + WORK_SECONDS)
    except BaseException as error:
        events['failure'] = {'type': type(error).__name__, 'message': str(error)}
    finally:
        deadline = time.monotonic() + CLEANUP_SECONDS
        events['clients'] = []
        for session in reversed(sessions):
            try:
                events['clients'].append(session.close(deadline))
            except BaseException as error:
                events['clients'].append({'backend_pid': session.pid, 'cleanup_error': str(error)})
        events['transcripts'] = {session.name: bytes(session.raw).decode('utf-8', errors='replace')
                                 for session in sessions}
        verifier = None
        try:
            require(len(sessions) == 3 and all(client.get('client_exit') == 0
                    and 'cleanup_error' not in client for client in events['clients']),
                    'original client terminal success absent')
            require(time.monotonic() < deadline, 'no original cleanup budget remains')
            verifier = R.Session(args.psql, 'qual_spin_expiry_' + args.execution.replace('-', ''),
                                 'current_mixed_cleanup_' + args.execution, deadline)
            verifier.pid = verifier.json('SELECT to_jsonb(pg_backend_pid());')
            ids = ','.join(str(session.pid) for session in sessions if session.pid is not None) or '0'
            R.observe_backend_cleanup(verifier, ids, deadline, events)
            events['cleanup_verified'] = True
        except BaseException as error:
            events['cleanup_failure'] = str(error)
        finally:
            if verifier:
                events['cleanup_transcript'] = bytes(verifier.raw).decode('utf-8', errors='replace')
                try:
                    events['verifier_client'] = verifier.close(deadline)
                    require(events['verifier_client']['client_exit'] == 0, 'cleanup observer exited unsuccessfully')
                except BaseException as error:
                    events['cleanup_verified'] = False
                    events['verifier_cleanup_error'] = str(error)
        events['source_stable'] = True
        events['source_readback'] = {}
        for name, sha in sources.items():
            try:
                actual = hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
                events['source_readback'][name] = {'sha256': actual, 'matches': actual == sha}
                if actual != sha:
                    events['source_stable'] = False
            except OSError as error:
                events['source_stable'] = False
                events['source_readback'][name] = {'read_error': str(error), 'matches': False}
        with args.output.open('x') as output:
            output.write(json.dumps(events, indent=2, default=R.evidence_value, allow_nan=False) + '\n')
            output.flush()
            os.fsync(output.fileno())
    if (not events['passed'] or not events['cleanup_verified'] or not events['source_stable']
            or 'failure' in events):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
