#!/usr/bin/env python3
"""SOURCE ONLY / UNRUN: bounded actual PostgreSQL expiry order/timeout schedules.

This is NOT a provider, admission client, installer, creator or funding fixture.
The protected owner must supply the exact current, isolated, genuinely funded
and naturally aged allocation described in spin-expiry-business-races.md.
No scenario commits. Separate allocations must provide preimage and candidate.
"""
import argparse
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import time
import uuid


ROOT = Path(__file__).resolve().parents[2]
PINS = ROOT / 'scripts/qualification/spin-expiry-lock-order.authority.json'
STATE = Path(__file__).with_name('spin-expiry-business-state.sql')
MAX_STREAM = 8 * 1024 * 1024


def require(value, message):
    if not value:
        raise RuntimeError(message)


def exact_json(text):
    # PostgreSQL numeric observations never pass through binary floating point.
    # Integers keep their integer identity; original transcripts retain wire text.
    def invalid_constant(value):
        raise ValueError('non-JSON numeric constant: ' + value)
    return json.loads(text, parse_float=Decimal, parse_constant=invalid_constant)


def evidence_value(value):
    if isinstance(value, Decimal):
        return {'$decimal': str(value)}
    raise TypeError('unsupported evidence value: ' + type(value).__name__)


def numeric_controls():
    # Parser-only controls; these values are never fixtures or database writes.
    low = exact_json('{"amount":9007199254740992.01,"id":9007199254740993}')
    high = exact_json('{"amount":9007199254740992.02,"id":9007199254740993}')
    require(low != high and high['amount']-low['amount'] == Decimal('0.01'),
            'large-magnitude cent change was hidden by parsing')
    require(type(low['id']) is int and low['id'] == 9007199254740993,
            'integer identity changed')
    tiny = exact_json('[0.00000000000000000001,0.00000000000000000002,1.2300]')
    require(tiny[0] != tiny[1] and evidence_value(tiny[2]) == {'$decimal':'1.2300'},
            'sub-cent value or decimal scale lost')
    encoded = json.dumps(low, default=evidence_value, allow_nan=False)
    require(json.loads(encoded) == {
        'amount':{'$decimal':'9007199254740992.01'},'id':9007199254740993},
        'lossless evidence representation differs')
    return ['large exact cent difference','integer identity','sub-cent difference',
            'decimal scale tag','lossless serialized evidence']


def canonical_uuid(value):
    parsed = str(uuid.UUID(value))
    require(parsed == value and parsed[14] in '12345678' and parsed[19] in '89ab',
            'requires a canonical operation/fixture UUID')
    return parsed


def psql_environment(name):
    # Reuse the provider's fresh private home. libpq requires a plain password
    # file; /dev/null emits a warning into the deliberately strict transcript.
    home = ROOT.parent / 'work' / 'home'
    require(os.environ.get('HOME') == str(home) and home.is_absolute()
            and home.resolve() == home, 'exact private provider home required')
    info = home.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid()
            and stat.S_IMODE(info.st_mode) == 0o700, 'unsafe provider home')
    passfile = home / '.spin-expiry.pgpass'
    try:
        fd = os.open(passfile, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        fd = os.open(passfile, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size == 0,
                'private password file must remain regular, empty and mode0600')
    finally:
        os.close(fd)
    return {'LC_ALL': 'C', 'PGCONNECT_TIMEOUT': '2', 'PGAPPNAME': name,
            'HOME': str(home), 'PGPASSFILE': str(passfile), 'PSQL_HISTORY': '/dev/null'}


class Session:
    """One persistent psql backend; each command has an exact end marker.

    stdout and stderr are read together, preserving verbose server errors.
    ON_ERROR_STOP stays off so an expected transaction error can be rolled back;
    Python must explicitly accept every error. No return code means SQL success.
    """
    def __init__(self, executable, database, name, deadline):
        env = psql_environment(name)
        self.name, self.deadline = name, deadline
        self.raw, self.pending, self.pid = bytearray(), None, None
        self.selector = selectors.DefaultSelector()
        self.process = subprocess.Popen(
            [str(executable), '-X', '-w', '-qAt', '-h', '127.0.0.1', '-p', '5432',
             '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=off',
             '-v', 'VERBOSITY=verbose'], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env)
        os.set_blocking(self.process.stdout.fileno(), False)
        self.selector.register(self.process.stdout, selectors.EVENT_READ)

    def begin(self, *, service_role=False):
        setup = "BEGIN; SET LOCAL statement_timeout='8s'; " \
            "SET LOCAL lock_timeout='4s'; SET LOCAL idle_in_transaction_session_timeout='12s'; " \
            "SET LOCAL timezone='UTC'; SET LOCAL search_path=public,pg_temp; " \
            "SET LOCAL request.jwt.claims='{}'; SET LOCAL request.jwt.claim.role=''; " \
            "SET LOCAL request.jwt.claim.sub='';"
        if service_role:
            # Match the real engine RPC caller, including EXECUTE privileges.
            # Observers and the parent-lock-only control keep postgres authority.
            setup += " SET LOCAL ROLE service_role; " \
                "SET LOCAL request.jwt.claims='{\"role\":\"service_role\"}'; " \
                "SET LOCAL request.jwt.claim.role='service_role';"
        result = self.command(setup)
        self.no_errors(result)
        if service_role:
            require(self.json("SELECT jsonb_build_object('user',current_user,'role',auth.role(),'uid',auth.uid());")
                    == {'user': 'service_role', 'role': 'service_role', 'uid': None},
                    'business request must match the engine service role without a user')

    @staticmethod
    def no_errors(result):
        require('ERROR:' not in result and 'FATAL:' not in result and 'PANIC:' not in result,
                'unexpected SQL failure: ' + result[-2000:])

    def start(self, sql):
        require(self.pending is None, 'session already has pending work')
        marker = '__spin_' + uuid.uuid4().hex + '__'
        self.pending = (marker.encode(), len(self.raw))
        self.process.stdin.write((sql + '\n\\echo ' + marker + '\n').encode())
        self.process.stdin.flush()

    def poll(self):
        if self.pending is None:
            return None
        for _key, _mask in self.selector.select(0):
            chunk = os.read(self.process.stdout.fileno(), 65536)
            require(chunk, 'psql terminated before command acknowledgement')
            self.raw.extend(chunk)
            require(len(self.raw) <= MAX_STREAM, 'session output bound exceeded')
        marker, start = self.pending
        data = bytes(self.raw[start:])
        end = data.find(marker + b'\n')
        if end < 0:
            return None
        self.pending = None
        return data[:end].decode('utf-8', errors='strict').strip()

    def wait(self):
        while time.monotonic() < self.deadline:
            result = self.poll()
            if result is not None:
                return result
            time.sleep(0.01)
        raise TimeoutError('original 20 second schedule deadline exceeded')

    def command(self, sql):
        self.start(sql)
        return self.wait()

    def json(self, sql):
        result = self.command(sql)
        self.no_errors(result)
        return exact_json(result)

    def close(self, cleanup_deadline):
        # Closing/killing the client is not proof the server backend is gone.
        # main independently observes every recorded backend after these calls.
        try:
            self.process.stdin.close()
        except (BrokenPipeError, OSError):
            pass
        for action in (None, self.process.terminate, self.process.kill):
            if self.process.poll() is not None:
                break
            if action is not None:
                action()
            remaining = cleanup_deadline - time.monotonic()
            if remaining <= 0:
                continue
            try:
                self.process.wait(timeout=min(0.25, remaining))
            except subprocess.TimeoutExpired:
                pass
        require(self.process.poll() is not None, 'client terminal exit not observed before cleanup deadline')
        self.selector.close()
        return {'client_exit': self.process.returncode, 'backend_pid': self.pid}


def authority(observer, image):
    pins = exact_json(PINS.read_text())
    expected = [{k: v for k, v in p.items() if k != 'observed_at'} for p in pins['functions']]
    for p in expected:
        if p['signature'] == 'fn_spin_expire_unfilled(integer)' and image == 'candidate':
            p['definition'] = p['definition'].replace(
                '  LOOP\n    -- The scan is only a candidate list.',
                '  LOOP\n    -- Cancellation takes global settlement G -> B before the parent.\n'
                '    -- Acquire the same lane here before any parent row lock; otherwise an\n'
                '    -- expiry holding the parent can deadlock with a terminal lane owner.\n'
                '    PERFORM public.fn_ca_lock_settlement_lane_global();\n'
                '    -- The scan is only a candidate list.')
            p['md5'] = pins['postimage_md5']
            require(hashlib.md5(p['definition'].encode()).hexdigest() == p['md5'],
                    'exact frozen postimage reconstruction differs')
    actual = observer.json("""SELECT jsonb_agg(jsonb_build_object(
      'signature',p.oid::regprocedure::text,'md5',md5(pg_get_functiondef(p.oid)),
      'definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),
      'language',l.lanname,'prokind',p.prokind,'result_type',pg_get_function_result(p.oid),
      'prosecdef',p.prosecdef,'proisstrict',p.proisstrict,'proretset',p.proretset,
      'proleakproof',p.proleakproof,'provolatile',p.provolatile,'proparallel',p.proparallel,
      'pronargs',p.pronargs,'pronargdefaults',p.pronargdefaults,
      'proconfig',p.proconfig,'proacl',p.proacl::text) ORDER BY p.oid::regprocedure::text)
      FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid IN (
      'public.atomic_cancel_tournament(uuid,uuid)'::regprocedure,
      'public.fn_ca_lock_settlement_lane_global()'::regprocedure,
      'public.fn_spin_expire_unfilled(integer)'::regprocedure,
      'public.fn_sync_seat_first_player_count(uuid)'::regprocedure);""")
    require(actual == sorted(expected, key=lambda p: p['signature']), 'selected authority drift')
    bindings = observer.json("""SELECT jsonb_agg(jsonb_build_object(
      'relation',c.relname,'tgname',t.tgname,'tgenabled',t.tgenabled,'tgtype',t.tgtype,
      'tgdeferrable',t.tgdeferrable,'tginitdeferred',t.tginitdeferred,
      'function',t.tgfoid::regprocedure::text,'function_md5',md5(pg_get_functiondef(t.tgfoid)),
      'definition',pg_get_triggerdef(t.oid,true)) ORDER BY c.relname,t.tgname)
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal
      AND n.nspname='public' AND c.relname IN ('tournaments','table_seats',
        'tournament_players','spin_draw_receipts','tournament_cancellation_receipts');""")
    require(isinstance(bindings,list), 'critical bindings unavailable')
    for pin in pins['critical_bindings']:
        require([b for b in bindings if (b['relation'],b['tgname']) ==
                 (pin['relation'],pin['tgname'])] == [pin], 'selected critical binding drift')
    return {'functions':actual,'all_bindings_on_five_relations':bindings}


def waits(observer, sessions):
    pids = ','.join(str(s.pid) for s in sessions)
    require(observer.json("SELECT to_jsonb(count(*)) FROM pg_stat_activity "
        f"WHERE datname=current_database() AND pid NOT IN ({pids},{observer.pid});") == 0,
        'unowned backend entered the supposedly exclusive allocation')
    return observer.json("SELECT COALESCE(jsonb_agg(jsonb_build_object('pid',pid,"
        "'state',state,'wait_type',wait_event_type,'wait_event',wait_event,"
        "'blockers',pg_blocking_pids(pid)) ORDER BY pid),'[]'::jsonb) "
        f"FROM pg_stat_activity WHERE pid IN ({pids});")


def expiry_sql():
    # SET CONSTRAINTS checks the real deferred refund/seat closure guards before
    # rollback. This is not a committed cancellation or replay proof.
    return "SELECT public.fn_spin_expire_unfilled(1)::text; SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;"


def run(args, events, sessions, deadline):
    database = 'qual_spin_expiry_' + args.execution.replace('-', '')
    def open_session(suffix):
        s = Session(args.psql, database, 'spin5_' + args.execution + '_' + suffix, deadline)
        sessions.append(s)
        s.pid = s.json('SELECT to_jsonb(pg_backend_pid());')
        require(type(s.pid) is int and s.pid > 0, 'invalid actual backend identity')
        return s
    observer = open_session('observer')
    environment = observer.json("""SELECT jsonb_build_object('database',current_database(),
      'user',current_user,'session_user',session_user,'port',current_setting('port'),
      'address',inet_server_addr(),'version',current_setting('server_version_num')::int,
      'deadlock_ms',extract(epoch FROM current_setting('deadlock_timeout')::interval)*1000,
      'others',(SELECT count(*) FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid()));""")
    events['environment'] = environment
    require(environment['database'] == database and environment['user'] == 'postgres'
            and environment['session_user'] == 'postgres' and environment['port'] == '5432'
            and environment['address'] == '127.0.0.1'
            and 170000 <= environment['version'] < 180000 and environment['others'] == 0
            and 0 < environment['deadlock_ms'] < 4000, 'private provider tripwire differs')
    observer.no_errors(observer.command("SET statement_timeout='3s'; SET timezone='UTC'; "
                                       "SET search_path=public,pg_temp;" + STATE.read_text()))
    events['authority_before'] = authority(observer, args.image)
    events['fixture_before'] = observer.json(
        f"SELECT pg_temp.spin_expiry_fixture('{args.tournament}'::uuid);")
    before = observer.json('SELECT pg_temp.spin_expiry_business_state();')
    events['selected_before'] = before
    a, b = open_session('expiry'), open_session('terminal_order')
    a.begin(service_role=True); b.begin()
    b.no_errors(b.command('SELECT public.fn_ca_lock_settlement_lane_global();'))
    a.start(expiry_sql())
    samples = []
    while time.monotonic() < deadline:
        sample = waits(observer, [a, b]); samples.append(sample)
        current = next((x for x in sample if x['pid'] == a.pid), None)
        require(a.poll() is None, 'expiry completed before observed global wait')
        if current and current['wait_event'] == 'advisory' and b.pid in current['blockers']:
            break
        time.sleep(0.02)
    else:
        raise TimeoutError('never observed expiry waiting on the owned global lane')
    events['initial_waits'] = samples
    if args.case == 'order':
        b.start(f"SELECT id::text FROM public.tournaments WHERE id='{args.tournament}'::uuid FOR UPDATE;")
        cycle, result_b = [], None
        while time.monotonic() < deadline:
            sample = waits(observer, [a, b]); cycle.append(sample)
            result_b = b.poll()
            if result_b is not None:
                break
            time.sleep(0.02)
        require(result_b is not None, 'parent step did not terminate within schedule deadline')
        events['parent_waits'], events['parent_result'] = cycle, result_b
        if args.image == 'candidate':
            b.no_errors(result_b)
            require(result_b == args.tournament, 'candidate parent lock returned wrong identity')
            require(a.poll() is None, 'expiry escaped held global lane before release')
        b.no_errors(b.command('ROLLBACK;'))
        result_a = a.wait()
        events['expiry_result'] = result_a
        if args.image == 'preimage':
            observed_cycle = any(len(s) == 2 and
                all(next(x for x in s if x['pid'] == owner)['pid'] in
                    next(x for x in s if x['pid'] == waiter)['blockers']
                    for owner, waiter in [(a.pid,b.pid),(b.pid,a.pid)]) for s in cycle)
            require(observed_cycle and 'deadlock detected' in (result_a + result_b),
                    'negative control inconclusive: require observed real cycle AND deadlock')
            require(all(code in ('40P01','25P02') for code in
                    re.findall(r'ERROR:\s+([0-9A-Z]{5}):',result_a+'\n'+result_b)),
                    'unrelated SQL error cannot qualify the negative control')
            require('FATAL:' not in result_a+result_b and 'PANIC:' not in result_a+result_b,
                    'backend failure is not a deadlock qualification')
        else:
            a.no_errors(result_a)
            lines = result_a.splitlines()
            receipt = exact_json(lines[0])
            require(receipt.get('ok') is True and receipt.get('expired') == 1
                    and receipt.get('failed') == 0 and receipt.get('skipped_raced') == 0
                    and receipt.get('tournament_ids') == [args.tournament],
                    'actual candidate cancellation/constraint control did not succeed exactly once')
    else:
        require(args.image == 'candidate', 'timeout case is candidate-only')
        result_a = a.wait()
        events['expiry_result'] = result_a
        require('ERROR:  55P03:' in result_a and 'lock timeout' in result_a,
                'require propagated global lock timeout, not a returned failed counter')
        require(re.findall(r'ERROR:\s+([0-9A-Z]{5}):',result_a) == ['55P03','25P02']
                and 'fn_ca_lock_settlement_lane_global' in result_a,
                'require only original global timeout and expected aborted constraint command')
        require(not any(line.startswith('{') for line in result_a.splitlines()),
                'timeout must not return a success-shaped expiry receipt')
        b.no_errors(b.command('ROLLBACK;'))
    events['selected_after'] = observer.json('SELECT pg_temp.spin_expiry_business_state();')
    require(events['selected_after'] == before, 'selected business rows changed after rollback')
    events['authority_after'] = authority(observer, args.image)
    require(events['authority_after'] == events['authority_before'], 'selected catalog changed')
    require(all(x['state'] == 'idle' and not x['blockers']
                for x in waits(observer, [a,b])), 'scenario sessions retain work/transaction')
    events['scenario_observed'] = True
    # No full-provider, original22, committed refund or release success flag.


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--psql', type=Path, required=True)
    p.add_argument('--execution', type=canonical_uuid, required=True)
    p.add_argument('--tournament', type=canonical_uuid, required=True)
    p.add_argument('--image', choices=['preimage','candidate'], required=True)
    p.add_argument('--case', choices=['order','timeout'], required=True)
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    require(args.psql.is_absolute() and args.psql.is_file(), 'explicit protected psql path required')
    require(args.output.is_absolute() and args.output.parent.is_dir()
            and not args.output.exists(), 'new absolute evidence file in owned output directory required')
    deadline, sessions = time.monotonic()+20, []
    events = {'scope':'FIFO5 order/timeout selected-state controls only',
              'execution':args.execution,'fixture_tournament':args.tournament,
              'image':args.image,'case':args.case,'scenario_observed':False,
              'cleanup_verified':False,'full_business_qualification':False,
              'psql_path':str(args.psql.resolve()),
              'psql_sha256':hashlib.sha256(args.psql.read_bytes()).hexdigest(),
              'source_sha256':{str(f.relative_to(ROOT)):hashlib.sha256(f.read_bytes()).hexdigest()
                for f in [Path(__file__),STATE,PINS]}}
    failed = None
    try:
        events['numeric_controls'] = numeric_controls()
        run(args, events, sessions, deadline)
    except BaseException as error:
        failed = error
        events['failure'] = {'type':type(error).__name__,'message':str(error)}
    finally:
        cleanup_deadline = time.monotonic()+5
        events['clients'] = []
        for s in reversed(sessions):
            try:
                events['clients'].append(s.close(cleanup_deadline))
            except BaseException as error:
                events['clients'].append({'backend_pid':s.pid,'cleanup_error':str(error)})
        events['clients_verified'] = (len(events['clients']) == len(sessions)
            and all('cleanup_error' not in client and client.get('client_exit') is not None
                    for client in events['clients']))
        events['transcripts'] = {s.name:bytes(s.raw).decode('utf-8',errors='replace') for s in sessions}
        # Client exit is not server rollback proof. A fresh read observes no
        # original backend and no locks owned by it; owner independently observes
        # this final reader's exit plus whole-allocation teardown separately.
        verifier = None
        try:
            require(time.monotonic() < cleanup_deadline, 'no cleanup budget remains for server observation')
            verifier = Session(args.psql, 'qual_spin_expiry_'+args.execution.replace('-',''),
                               'spin5_cleanup_'+args.execution, cleanup_deadline)
            verifier.pid = verifier.json('SELECT to_jsonb(pg_backend_pid());')
            require(type(verifier.pid) is int and verifier.pid > 0, 'invalid cleanup backend identity')
            ids = ','.join(str(s.pid) for s in sessions if s.pid is not None) or '0'
            remaining = verifier.json("SELECT jsonb_build_object('backends',"
                "(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() "
                "AND pid<>pg_backend_pid()),"
                f"'locks',(SELECT count(*) FROM pg_locks WHERE pid IN ({ids})));" )
            events['backend_cleanup'] = remaining
            require(remaining == {'backends':0,'locks':0}, 'original backends/locks not cleared')
            require(events['clients_verified'],
                    'original client terminal exit was not independently observed')
            events['cleanup_verified'] = events['clients_verified']
        except BaseException as error:
            events['cleanup_failure'] = str(error)
        finally:
            if verifier:
                try:
                    events['verifier_client'] = verifier.close(cleanup_deadline)
                except BaseException as error:
                    events['cleanup_verified'] = False
                    events['verifier_cleanup_error'] = str(error)
        events['source_stable'] = True
        events['source_readback'] = {}
        for name, expected in events['source_sha256'].items():
            try:
                actual = hashlib.sha256((ROOT/name).read_bytes()).hexdigest()
                events['source_readback'][name] = {'sha256':actual,'matches':actual==expected}
                if actual != expected:
                    events['source_stable'] = False
            except (OSError, ValueError) as error:
                events['source_stable'] = False
                events['source_readback'][name] = {'read_error':str(error),'matches':False}
        # Do not clobber another operation's evidence if the path raced creation.
        with args.output.open('x') as output:
            output.write(json.dumps(events,indent=2,default=evidence_value,allow_nan=False)+'\n')
    if failed or not events['cleanup_verified'] or not events['source_stable']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
