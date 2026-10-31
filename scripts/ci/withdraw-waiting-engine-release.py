#!/usr/bin/env python3
"""Withdraw one waiting original transaction, never a serving engine or wrapper.

The original v1 wrapper owns recovery, its failure tombstone and retirement.
This command supplies only the transaction's existing terminal INT boundary.
It has no image, seal-write, restart, freeze-write or alternate publisher path.
"""
import base64
import datetime
import fcntl
import errno
import json
import hashlib
import importlib.util
import ssl
from urllib.parse import urlencode
import os
from pathlib import Path
import re
import shutil
import shlex
import signal
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request

SHA = re.compile(r'[0-9a-f]{40}')
RUN = re.compile(r'[1-9][0-9]{0,19}-[1-9][0-9]{0,3}')
INSTANCE = re.compile(r'[1-9][0-9]*-[0-9a-f]{8}')
ROOT = Path('/var/lib/club-arena')
PARENT = Path('/usr/local/lib/club-arena')
PROC = Path('/proc')
ENGINE_LOCK = Path('/var/lock/club-arena-engine-up.lock')
SCHEMA = 'waiting-engine-release-withdrawal/v1'


def require(condition):
    if not condition:
        raise ValueError('Exact waiting release admission refused')


def selection(value):
    fields = {'runKey', 'releaseSha', 'controlSha', 'desiredSha', 'instanceId'}
    require(isinstance(value, dict) and set(value) in (fields, fields | {'mode'}))
    require('mode' not in value or value['mode'] == 'cancel_expired_announcement')
    require(all(isinstance(v, str) for v in value.values()))
    require(RUN.fullmatch(value['runKey']) is not None)
    require(all(SHA.fullmatch(value[k]) for k in ('releaseSha', 'controlSha', 'desiredSha')))
    require(INSTANCE.fullmatch(value['instanceId']) is not None)
    require(value['releaseSha'] != value['desiredSha'])
    return dict(value)


def command(args, timeout=5):
    result = subprocess.run(args, capture_output=True, timeout=timeout, check=True)
    require(len(result.stdout) <= 65536)
    return result.stdout.decode().strip()


def regular(path, mode=None):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_size <= 65536)
        require(mode is None or stat.S_IMODE(before.st_mode) == mode)
        data = os.read(fd, 65537)
        after = os.fstat(fd)
        signature = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        require(signature(before) == signature(after) and len(data) <= 65536)
        return data.decode()
    finally:
        os.close(fd)


def properties(unit):
    raw = command(['systemctl', 'show', unit, '-p', 'MainPID', '-p', 'InvocationID',
                   '-p', 'ActiveState', '-p', 'Result', '-p', 'ExecMainStatus'])
    result = dict(line.split('=', 1) for line in raw.splitlines())
    require(set(result) == {'MainPID', 'InvocationID', 'ActiveState', 'Result', 'ExecMainStatus'})
    return result


def process(pid):
    require(type(pid) is int and pid > 1)
    root = PROC / str(pid)
    s = (root / 'stat').read_text().rsplit(')', 1)[1].split()
    argv = (root / 'cmdline').read_bytes().rstrip(b'\0').decode().split('\0')
    return {'pid': pid, 'parent': int(s[1]), 'start': s[19], 'argv': argv}


def bash_command(argv, expected):
    return len(argv) == len(expected) + 1 and argv[0] in ('bash', '/bin/bash', '/usr/bin/bash') and argv[1:] == expected


def healthy(value, request):
    require(value.get('releaseSha') == request['desiredSha'])
    require(value.get('instanceId') == request['instanceId'])
    require(value.get('running') is True and value.get('liveness') == 'ok')
    maintenance = value.get('maintenance') or {}
    require(maintenance.get('active') is False and maintenance.get('phase') == 'idle')


def health_pair(request):
    # No redirects to a caller-selected destination; only these fixed endpoints.
    for url in ('http://127.0.0.1:8080/health', 'https://engine.smarter.poker/health'):
        with urllib.request.urlopen(url + '?withdraw=' + str(time.time_ns()), timeout=5) as response:
            require(response.geturl().split('?', 1)[0] == url)
            raw = response.read(65537)
            require(len(raw) <= 65536)
            healthy(json.loads(raw), request)


def container_identity(request):
    # Inspect only immutable identity fields. A full Docker inspect would also
    # read runtime environment values, which this operation never needs.
    template = ('{"id":{{json .Id}},"startedAt":{{json .State.StartedAt}},'
                '"running":{{json .State.Running}},"image":{{json .Image}},'
                '"releaseSha":{{json (index .Config.Labels "sp.release.sha")}}}')
    d = json.loads(command(['docker', 'container', 'inspect', '--format', template, 'club-arena-engine']))
    require(set(d) == {'id', 'startedAt', 'running', 'image', 'releaseSha'})
    require(d['running'] is True and d['releaseSha'] == request['desiredSha'])
    require(re.fullmatch(r'[0-9a-f]{64}', d['id']) is not None)
    require(re.fullmatch(r'sha256:[0-9a-f]{64}', d['image']) is not None)
    return {'id': d['id'], 'startedAt': d['startedAt'], 'image': d['image']}


def terminal(request, invocation=None):
    result = json.loads(regular(ROOT / 'engine-release-results' / (request['runKey'] + '.json')))
    require(result['result'] == 'failed' and result['transactionExitStatus'] == 130)
    require(result['runId'] == request['runKey'] and result['sha'] == request['releaseSha'])
    require(result['controlSha'] == request['controlSha'])
    require(result['recoveredDesiredSha'] == request['desiredSha'])
    require(re.fullmatch(r'[0-9a-f]{32}', result['invocationId']) is not None)
    require(invocation is None or result['invocationId'] == invocation)
    generation = PARENT / 'engine-control-generations' / request['controlSha']
    command([str(generation / 'engine-release-seal.py'), 'attest-failure', '--sha',
             request['releaseSha'], '--run-id', request['runKey'], '--control-sha',
             request['controlSha'], '--invocation-id', result['invocationId']])
    key = request['runKey']
    for directory, suffixes in [('engine-release-requests', ['intent', 'request', 'break-deadline', 'awaiting-certificate']),
                                ('engine-intake-requests', ['intent', 'request']),
                                ('engine-release-generation-pins', ['generation']),
                                ('engine-image-leases', ['lease'])]:
        require(all(not os.path.lexists(ROOT / directory / (key + '.' + suffix)) for suffix in suffixes))
    for unit in ('club-arena-engine-release-v1@' + key + '.service',
                 'club-arena-engine-intake-v1@' + key + '.service',
                 'club-arena-engine-intake-v1@' + key + '.path'):
        require(not os.path.lexists(Path('/etc/systemd/system/multi-user.target.wants') / unit))
        if unit.endswith('.path'):
            require(command(['systemctl', 'show', unit, '-p', 'ActiveState', '--value']) == 'inactive')
        else:
            d = properties(unit)
            require(d['ActiveState'] in ('inactive', 'failed') and d['MainPID'] == '0')
    health_pair(request)
    return {'schema': SCHEMA, **request, 'result': 'withdrawn-before-mutation',
            'invocationId': result['invocationId'], 'originalTransactionExitStatus': 130,
            'servingInstanceUnchanged': True, 'originalTerminalEdgesRetired': True}


# This narrow capability retires an expired announcement from the pinned
# generation whose original recovery cannot terminalize announcement-only work.
CANCEL_SCHEMA = 'expired-announcement-cancellation/v1'
EMPTY_CANCEL_SCHEMA = 'expired-announcement-cancellation/empty-retry-v1'
CANCEL_CONTROL = 'bd11ad35ca27843fd2f4910e5a8fc6a76d8c9d4e'
CANCEL_HASHES = {
    'engine-release-database-proof.py': '7034aa6f2d42a7a321c1e610fa517acd165367512aa8f3e62aaee719a4703155',
    'engine-release-lightning-hold.py': '401a15fa30f663b8614cf962ed4650c7f55927d29705ab9bdef9dac0638ee6e4',
    'engine-release-seal.py': '7ea266198c0a59e223ba662027352f5a45291d7d9fe25753d3c7dd2ec63916b2',
    'engine-release-transaction.sh': 'fdfb0522c0c3acd218f66544ced70550c9c1ca3e1aee5a56c79f6b1afae30c88',
    'engine-release-recover.sh': 'b6186c0e752ee93c9d57e79cb963c4386ff70ff0ed2a52f141d8373013096b83',
    'engine-release-activation-floor.py': '850c6056e1eb630b8ca6729b5b654c40612f1c25d692999c8cf5fe3b985ddef2',
}
WRAPPER_HASH = 'e9abdbe2c97c3594b32a920285e78858c1e0497f00a8a7edd21b99ba0491dc9c'
SYSTEMD = Path('/etc/systemd/system')
CGROUP = Path('/sys/fs/cgroup')
THAW_STEPS = {'sit_out_at', 'hold_expires_at', 'addon_period_ends_at', 'reversible_until',
              'reveal_deadline_at', 'rebuy_prompt_until', 'bomb_pot_next_due_at',
              'cash_stay_last_tick_at', 'cash_rejoin_expires_at', 'level_started_at',
              'cluster_break_eligible_since', 'cluster_move_expires_at',
              'reconnect_presence', 'reconnect_snapshots', 'lightning_drain_deadline_at'}


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def fsync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)


def save_once(path, value):
    raw = json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n'
    if os.path.lexists(path):
        require(regular(path, 0o600) == raw)
        return
    # Atomic immutable create, never replace another writer's state.
    temporary = path.with_name('.' + path.name + '.' + str(os.getpid()))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w') as output:
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
        os.link(temporary, path, follow_symlinks=False)
        fsync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def source_hash(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_size < 262144)
        raw = os.read(fd, 262144)
        after = os.fstat(fd)
        identity = lambda row: (row.st_dev, row.st_ino, row.st_mode, row.st_uid, row.st_size, row.st_mtime_ns, row.st_ctime_ns)
        require(identity(after) == identity(before) and len(raw) == before.st_size)
        return digest(raw)
    finally: os.close(fd)


def cancel_units(key):
    return ['club-arena-engine-release-v1@' + key + '.service',
            'club-arena-engine-intake-v1@' + key + '.service',
            'club-arena-engine-intake-v1@' + key + '.path']


def own_wants_edge(unit):
    edge = SYSTEMD / 'multi-user.target.wants' / unit
    if not os.path.lexists(edge): return edge
    require(edge.is_symlink())
    template = unit.split('@', 1)[0] + '@.' + unit.rsplit('.', 1)[1]
    require(os.readlink(edge) in {str(SYSTEMD / template), str(SYSTEMD / unit), '../' + template, '../' + unit})
    return edge


def unit_snapshot(unit):
    is_path = unit.endswith('.path')
    names = (['InvocationID', 'ActiveState', 'SubState', 'Result'] if is_path else
             ['MainPID', 'InvocationID', 'ActiveState', 'SubState', 'Result',
              'ExecMainCode', 'ExecMainStatus', 'ControlGroup'])
    args = ['systemctl', 'show', unit, '--all']
    for name in names: args += ['-p', name]
    value = dict(line.split('=', 1) for line in command(args).splitlines())
    require(set(value) == set(names))
    if is_path:
        # Path units have no Service process/Exec/cgroup properties. Null records
        # inapplicability; native GetUnitProcesses supplies actual empty proof.
        value.update(unitType='path', MainPID=None, ExecMainCode=None, ExecMainStatus=None, ControlGroup=None)
    return value


def prove_empty_exec_properties(unit, fields):
    require(bool(fields) and set(fields) <= {'ExecStart', 'ExecStop', 'ExecStopPost'})
    prefix = ['busctl', '--system', '--timeout=5s']
    get_unit = prefix + ['call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
                         'org.freedesktop.systemd1.Manager', 'GetUnit', 's', unit]
    resolved = shlex.split(command(get_unit))
    require(len(resolved) == 2 and resolved[0] == 'o'
            and re.fullmatch(r'/org/freedesktop/systemd1/unit/[A-Za-z0-9_]+', resolved[1]) is not None)
    prop = prefix + ['get-property', 'org.freedesktop.systemd1', resolved[1]]
    identity = prop + ['org.freedesktop.systemd1.Unit', 'Id']
    require(shlex.split(command(identity)) == ['s', unit])
    for field in sorted(fields):
        require(shlex.split(command(prop + ['org.freedesktop.systemd1.Service', field])) == ['a(sasbttttuii)', '0'])
    require(shlex.split(command(identity)) == ['s', unit] and shlex.split(command(get_unit)) == resolved)


def loaded_stop_contract(unit, key, allow_masked=False):
    fields = ['ExecStart', 'ExecStop', 'ExecStopPost', 'KillMode', 'FragmentPath', 'DropInPaths',
              'RequiredBy', 'RequisiteOf', 'BoundBy', 'ConsistsOf', 'PropagatesStopTo']
    args = ['systemctl', 'show', unit, '--all']
    for field in fields: args += ['-p', field]
    result = dict(line.split('=', 1) for line in command(args).splitlines())
    missing = set(fields) - set(result)
    if missing:
        # systemctl's Exec-array printer omits empty arrays even with --all.
        # Only a positive typed D-Bus empty array for this exact unit fills one.
        prove_empty_exec_properties(unit, missing)
        result.update({field: '' for field in missing})
    require(set(result) == set(fields))
    require(result['KillMode'] == 'control-group' and result['DropInPaths'] == '')
    require(all(result[field] == '' for field in ['ExecStop', 'RequiredBy', 'RequisiteOf', 'BoundBy', 'ConsistsOf', 'PropagatesStopTo']))
    if allow_masked and result['FragmentPath'] in {'/dev/null', str(SYSTEMD / unit)}:
        # systemd retains the mask link source as FragmentPath when loading it.
        require(masked([unit]))
        require(all(result[field] == '' for field in ['ExecStart', 'ExecStop', 'ExecStopPost']))
        return {'maskedEmpty': True}
    require(result['FragmentPath'] == str(SYSTEMD / 'club-arena-engine-release-v1@.service'))
    wrapper = str(PARENT / 'engine-release-unit-wrapper-v1.sh')
    for field, expected in [('ExecStart', wrapper + ' start ' + key),
                            ('ExecStopPost', wrapper + ' recover ' + key + ' ${SERVICE_RESULT} ${EXIT_CODE} ${EXIT_STATUS}')]:
        raw = result[field]
        require(raw.count('path=') == 1 and raw.count('argv[]=') == 1)
        path = re.search(r'(?:\{ |; )path=([^;]+) ;', raw)
        argv = re.search(r'argv\[\]=([^;]+) ;', raw)
        require(path is not None and path.group(1).strip() == wrapper and argv is not None)
        actual = argv.group(1).strip()
        for name in ('SERVICE_RESULT', 'EXIT_CODE', 'EXIT_STATUS'):
            actual = actual.replace('$' + name, '${' + name + '}')
        require(actual == expected and 'ignore_errors=no' in raw)
    # Runtime timing/status fields in Exec* change; only command/configuration
    # authority is retained and compared after the masks are loaded.
    return {field: result[field] for field in fields if field not in {'ExecStart', 'ExecStopPost'}}


def cgroup_empty(path):
    require(isinstance(path, str) and path.startswith('/system.slice/') and '..' not in path.split('/'))
    target = CGROUP / path.lstrip('/')
    try: os.lstat(target)
    except FileNotFoundError as error:
        require(error.errno == errno.ENOENT)
        return True
    require(target.resolve(strict=True) == target and target.is_dir())
    values = dict(line.split() for line in (target / 'cgroup.events').read_text().splitlines())
    return values.get('populated') == '0'


def prove_unit_empty(unit):
    """Positive native enumeration includes cgroup descendants and main/control PIDs."""
    before = unit_snapshot(unit)
    is_path = unit.endswith('.path')
    require(before['MainPID'] is None and before.get('unitType') == 'path' if is_path else before['MainPID'] == '0')
    prefix = ['busctl', '--system', '--timeout=5s']
    lookup = prefix + ['call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
                       'org.freedesktop.systemd1.Manager', 'GetUnit', 's', unit]
    resolved = shlex.split(command(lookup))
    require(len(resolved) == 2 and resolved[0] == 'o'
            and re.fullmatch(r'/org/freedesktop/systemd1/unit/[A-Za-z0-9_]+', resolved[1]) is not None)
    prop = prefix + ['get-property', 'org.freedesktop.systemd1', resolved[1]]
    identity = prop + ['org.freedesktop.systemd1.Unit', 'Id']
    require(shlex.split(command(identity)) == ['s', unit])
    if not is_path:
        require(shlex.split(command(prop + ['org.freedesktop.systemd1.Service', 'ControlPID'])) == ['u', '0'])
    require(shlex.split(command(prefix + ['call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
        'org.freedesktop.systemd1.Manager', 'GetUnitProcesses', 's', unit])) == ['a(sus)', '0'])
    if before['ControlGroup']: require(cgroup_empty(before['ControlGroup']))
    require(shlex.split(command(identity)) == ['s', unit] and shlex.split(command(lookup)) == resolved)
    require(unit_snapshot(unit) == before)
    return before


def empty_retry_admission(unit, state, key, evidence):
    require(key == '41177442979-1' and 'engine-release-requests/'+key+'.awaiting-certificate' not in evidence['originals'])
    require(state['MainPID'] == '0' and state['ActiveState'] == 'activating' and state['SubState'] == 'auto-restart')
    raw = command(['systemctl', 'show', unit, '--all', '-p', 'Type', '-p', 'Restart', '-p', 'RestartUSec'])
    require(dict(line.split('=', 1) for line in raw.splitlines()) ==
            {'Type': 'oneshot', 'Restart': 'on-failure', 'RestartUSec': '30s'})
    require(prove_unit_empty(unit) == state)


def quiet_units(units, original_group, native_empty=False):
    states = [unit_snapshot(unit) for unit in units]
    require(all((row['MainPID'] == '0' or (row.get('unitType') == 'path' and row['MainPID'] is None)) and row['ActiveState'] in {'inactive', 'failed'}
                and (not row['ControlGroup'] or cgroup_empty(row['ControlGroup'])) for row in states))
    if native_empty:
        require([prove_unit_empty(unit) for unit in units] == states)
        if original_group is not None: require(cgroup_empty(original_group))
    else:
        require(cgroup_empty(original_group))
        for unit, row in zip(units, states):
            if row.get('unitType') == 'path': require(prove_unit_empty(unit) == row)
    return states


def masked(units):
    return all(os.path.islink(SYSTEMD / unit) and os.readlink(SYSTEMD / unit) == '/dev/null'
               and command(['systemctl', 'show', unit, '-p', 'LoadState', '--value']) == 'masked' for unit in units)


def time_ms(value):
    require(isinstance(value, str))
    parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    require(parsed.tzinfo is not None)
    return round(parsed.timestamp() * 1000)


def prove_thaw(rows, active, stamp, now):
    require(isinstance(rows, list) and len(rows) == 1 and active == [])
    row = rows[0]
    require(row.get('contract_version') == 3 and time_ms(row.get('announced_at')) == stamp
            and time_ms(row.get('freeze_started_at')) == stamp + 120000)
    target = time_ms(row.get('release_target_at'))
    require(target == stamp + 420000 and target < now and stamp + 120000 <= time_ms(row.get('thawed_at')) <= now
            and re.fullmatch(r'[0-9a-fA-F-]{36}', row.get('ownership_token', '')) is not None
            and type(row.get('release_generation')) is int and row['release_generation'] > 0)
    shifted = row.get('shifted')
    require(isinstance(shifted, dict) and shifted.get('complete') is True and shifted.get('_targets_snapshotted') is True and THAW_STEPS <= set(shifted))
    targets = shifted.get('_target_counts')
    require(isinstance(targets, dict) and set(targets) == THAW_STEPS
            and all(type(targets[key]) is int and targets[key] >= 0 and type(shifted[key]) is int
                    and shifted[key] == targets[key] for key in THAW_STEPS))
    require(abs(float(row['frozen_seconds']) * 1000 - (target - stamp - 120000)) <= 2)
    return {'announcedAtMs': stamp, 'freezeStartedAtMs': stamp + 120000,
            'releasedThroughMs': target, 'ownershipToken': row['ownership_token'],
            'generation': row['release_generation']}


def own_thaw(stamp):
    # The fixed canonical store is used only inside this protected host helper.
    # Only bounded GETs, no RPC or production write, and redirects are refused.
    helper = PARENT / 'engine-control-generations' / CANCEL_CONTROL / 'engine-release-database-proof.py'
    require(source_hash(helper) == CANCEL_HASHES[helper.name])
    spec = importlib.util.spec_from_file_location('qualified_withdrawal_database_reader', helper)
    reader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reader)
    values = reader.read_fixed_env(Path('/opt/club-arena/server/.env'))
    require(values.get('SUPABASE_URL', '').rstrip('/') == 'https://kuklfnapbkmacvwxktbh.supabase.co'
            and bool(values.get('SUPABASE_SERVICE_ROLE_KEY')))
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs): return None
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    def get(table, query):
        url = values['SUPABASE_URL'].rstrip('/') + '/rest/v1/' + table + '?' + urlencode(query)
        key = values['SUPABASE_SERVICE_ROLE_KEY']
        request = urllib.request.Request(url, headers={'apikey': key, 'authorization': 'Bearer ' + key,
                                                     'cache-control': 'no-cache, no-store'})
        with opener.open(request, timeout=5) as response:
            raw = response.read(32769)
            require(len(raw) <= 32768)
            return json.loads(raw)
    stamp_iso = datetime.datetime.fromtimestamp(stamp / 1000, datetime.timezone.utc).isoformat()
    rows = get('engine_maintenance_thaws', {'select': 'contract_version,announced_at,freeze_started_at,release_target_at,thawed_at,ownership_token,release_generation,shifted,frozen_seconds',
                                          'announced_at': 'eq.' + stamp_iso, 'limit': '2'})
    active = get('engine_maintenance_break', {'select': 'id', 'id': 'eq.true', 'limit': '2'})
    return prove_thaw(rows, active, stamp, round(time.time() * 1000))


def announcement_evidence(request, after_stop=False):
    require(request['controlSha'] == request['releaseSha'] == CANCEL_CONTROL)
    key = request['runKey']
    generation = PARENT / 'engine-control-generations' / CANCEL_CONTROL
    require(generation.resolve(strict=True) == generation)
    for name, expected in CANCEL_HASHES.items(): require(source_hash(generation / name) == expected)
    require(source_hash(PARENT / 'engine-release-unit-wrapper-v1.sh') == WRAPPER_HASH)
    reqroot = ROOT / 'engine-release-requests'
    originals = {}
    marker_missing = not os.path.lexists(reqroot / (key + '.awaiting-certificate'))
    for suffix in ['request', 'intent', 'awaiting-certificate']:
        if suffix == 'awaiting-certificate' and marker_missing:
            continue
        raw = regular(reqroot / (key + '.' + suffix), 0o600)
        originals['engine-release-requests/' + key + '.' + suffix] = digest(raw.encode())
        if suffix == 'request': lines = raw.splitlines(); request_raw = raw
        elif suffix == 'intent': require(raw == request_raw)
        else: require(raw.strip() == request['releaseSha'])
    require(len(lines) == 6 and lines[0] == request['releaseSha'] and lines[3:5] == [str(generation), CANCEL_CONTROL])
    if marker_missing and not after_stop:
        # The pinned transaction removes this advisory marker on entry/exit.
        # Only this expired original's positive announced disposition replaces it.
        require(key == '41177442979-1' and lines[5] == '1793440868'
                and time.time() > 1793440868)
        require(command(['python3', str(generation / 'engine-release-activation-floor.py'),
                         'disposition', '--repo', '/opt/club-arena', '--target', CANCEL_CONTROL,
                         '--control', CANCEL_CONTROL, '--deadline', lines[5],
                         '--request-root', str(reqroot), '--run-id', key]) == 'announced')
    entry_raw = regular(reqroot / (key + '.activation-entry'), 0o600)
    entry = json.loads(entry_raw)
    require(set(entry) == {'schema', 'runId', 'targetSha', 'controlSha', 'manifestSha256', 'phase'}
            and entry['schema'] == 'engine-release-activation-floor/v2-owner-window' and entry['runId'] == key
            and entry['targetSha'] == entry['controlSha'] == CANCEL_CONTROL and entry['phase'] == 'announcement')
    reservation_raw = regular(ROOT / ('engine-recovery-window-' + key + '.json'), 0o600)
    reservation = json.loads(reservation_raw)
    require(set(reservation) == {'runId', 'sha', 'announcedAt', 'cause'} and reservation['runId'] == key
            and reservation['sha'] == CANCEL_CONTROL and reservation['cause'] == 'urgent')
    stamp = reservation['announcedAt']
    require(type(stamp) is int and stamp + 420000 < time.time() * 1000)
    # Existing immutable floor verifier binds announcement to the qualified manifest/window.
    require(command([str(generation / 'engine-release-activation-floor.py'), 'reservation', '--repo', '/opt/club-arena',
                     '--target', CANCEL_CONTROL, '--control', CANCEL_CONTROL, '--deadline', lines[5],
                     '--run-id', key, '--state-root', str(ROOT)]) == str(stamp))
    require(entry['manifestSha256'] == '6008a4314d7a80e77ad0df28c6cc4dd83777ab813f3e66192108be25e063b0ac')
    for suffix in ['break-deadline', 'legacy-checkpoint-intent', 'main-inspector-retirement-intent', 'lightning-hold.json']:
        require(not os.path.lexists(reqroot / (key + '.' + suffix)))
    released_path = reqroot / (key + '.lightning-hold.json.released')
    released_raw = regular(released_path, 0o600)
    spec = importlib.util.spec_from_file_location('qualified_withdrawal_hold_reader', generation / 'engine-release-lightning-hold.py')
    helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
    released = helper.own_record(released_path, key)
    require(released is not None and released['phase'] == 'released')
    seal = generation / 'engine-release-seal.py'
    require(command([str(seal), 'pending-owner']) == 'none')
    require(command([str(seal), 'get', 'desired-sha']) == request['desiredSha'])
    pin = ROOT / 'engine-release-generation-pins' / (key + '.generation')
    require(regular(pin, 0o600) == str(generation) + '\n' + CANCEL_CONTROL + '\n')
    originals[str(pin.relative_to(ROOT))] = digest(regular(pin, 0o600).encode())
    for directory, suffix in [('engine-intake-requests', 'intent'), ('engine-intake-requests', 'request'), ('engine-image-leases', 'lease')]:
        path = ROOT / directory / (key + '.' + suffix)
        if os.path.lexists(path):
            raw = regular(path, 0o600)
            require(raw.splitlines() == ([request['releaseSha']] if directory == 'engine-image-leases'
                                        else [lines[0], lines[4], lines[1], lines[2], lines[5]]))
            originals[str(path.relative_to(ROOT))] = digest(raw.encode())
    require(not os.path.lexists(ROOT / 'engine-release-results' / (key + '.json')))
    return {'originals': originals, 'entryHash': digest(entry_raw.encode()),
            'reservationHash': digest(reservation_raw.encode()), 'releasedHoldHash': digest(released_raw.encode()), 'thaw': own_thaw(stamp)}


def unchanged_evidence(actual, expected, key):
    actual = dict(actual); expected = dict(expected)
    left = actual.pop('originals'); right = expected.pop('originals')
    missing = set(right) - set(left)
    require(actual == expected and set(left) <= set(right)
            and missing <= {'engine-release-requests/' + key + '.awaiting-certificate'}
            and all(value == right[name] for name, value in left.items()))


def validate_cancellation_reply(answer, request):
    require(isinstance(answer, dict) and answer.get('schema') in {CANCEL_SCHEMA, EMPTY_CANCEL_SCHEMA} and answer.get('request') == request
            and answer.get('result') == 'cancelled-expired-announcement' and answer.get('servingInstanceUnchanged') is True
            and answer.get('originalTerminalEdgesRetired') is True and answer.get('quiescent') is True
            and answer.get('stopDisposition') in {'requested', 'not-needed-already-quiescent'})
    if answer['schema'] == EMPTY_CANCEL_SCHEMA:
        require(answer.get('stopDisposition') == 'not-needed-already-quiescent')
    require(isinstance(answer.get('actualUnitStates'), list) and len(answer['actualUnitStates']) == 3)
    require(all((row.get('MainPID') == '0' or (row.get('unitType') == 'path' and row.get('MainPID') is None)) and row.get('ActiveState') in {'inactive', 'failed'} for row in answer['actualUnitStates']))


def cancellation_directory(directory):
    directory.mkdir(mode=0o700, exist_ok=True)
    require(directory.resolve(strict=True) == directory and directory.stat().st_uid == 0)


def cancellation_child_class(argv, key, evidence):
    generation = PARENT / 'engine-control-generations' / CANCEL_CONTROL
    if bash_command(argv, [str(generation / 'engine-release-transaction.sh'), '--run-id', key]):
        return 'pinned_transaction'
    marker = 'engine-release-requests/' + key + '.awaiting-certificate'
    if (key == '41177442979-1' and marker not in evidence['originals']
            and bash_command(argv, [str(generation / 'engine-release-recover.sh'),
                                    '--run-id', key, '--mode', 'retryable'])):
        return 'pinned_announcement_recovery'
    return 'unproven'


def cancel_announced(request):
    require(os.getuid() == 0)
    key = request['runKey']; units = cancel_units(key)
    quiescence_deadline = None
    directory = ROOT / 'engine-release-cancellations'
    cancellation_directory(directory)
    lockfd = os.open(directory / (key + '.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    enginefd = os.open(ENGINE_LOCK, os.O_RDWR | os.O_NOFOLLOW)
    try:
        fcntl.flock(lockfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(enginefd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        receipt_path = directory / (key + '.receipt.json')
        intent_path = directory / (key + '.intent.json')
        issued_path = directory / (key + '.stop-issued.json')
        quiet_path = directory / (key + '.quiescent.json')
        if os.path.lexists(receipt_path):
            receipt = json.loads(regular(receipt_path, 0o600)); validate_cancellation_reply(receipt, request)
            require(masked(units)); quiet_units(units, receipt['originalControlGroup'], receipt['schema'] == EMPTY_CANCEL_SCHEMA)
            require(container_identity(request) == receipt['container']); health_pair(request)
            return receipt
        for unit in units: own_wants_edge(unit)
        health_pair(request); container = container_identity(request)
        if os.path.lexists(intent_path):
            intent = json.loads(regular(intent_path, 0o600))
            require(intent['request'] == request and intent['container'] == container)
        else:
            evidence = announcement_evidence(request)
            stop_contract = loaded_stop_contract(units[0], key)
            state = unit_snapshot(units[0])
            require(state['ActiveState'] in {'active', 'activating'} and INVOCATION_PATTERN(state['InvocationID']))
            if state['MainPID'] == '0':
                empty_retry_admission(units[0], state, key, evidence)
                for unit in units[1:]:
                    row = prove_unit_empty(unit)
                    require(row['ActiveState'] in {'inactive', 'failed'})
                require(announcement_evidence(request) == evidence and container_identity(request) == container)
                health_pair(request); empty_retry_admission(units[0], state, key, evidence)
                intent = {'schema': EMPTY_CANCEL_SCHEMA, 'admission': 'positive-empty-auto-restart',
                          'request': request, 'container': container, 'evidence': evidence,
                          'originalUnit': state, 'originalProcess': None, 'originalChild': None, 'stopContract': stop_contract}
            else:
                parent = process(int(state['MainPID']))
                require(bash_command(parent['argv'], [str(PARENT / 'engine-release-unit-wrapper-v1.sh'), 'start', key]))
                require(state['ControlGroup'].startswith('/system.slice/') and state['ControlGroup'].endswith('/' + units[0]))
                require((PROC / str(parent['pid']) / 'cgroup').read_text().strip() == '0::' + state['ControlGroup'])
                children = (PROC / str(parent['pid']) / 'task' / str(parent['pid']) / 'children').read_text().split()
                candidates = [process(int(pid)) for pid in children]
                matches = [row for row in candidates if cancellation_child_class(row['argv'], key, evidence) != 'unproven']
                require(len(matches) == 1 and matches[0]['parent'] == parent['pid'])
                require((PROC / str(matches[0]['pid']) / 'cgroup').read_text().strip() == '0::' + state['ControlGroup'])
                engine_pid = command(['docker', 'container', 'inspect', '--format', '{{.State.Pid}}', 'club-arena-engine'])
                require(engine_pid.isdigit() and int(engine_pid) > 1)
                require(not (PROC / engine_pid / 'cgroup').read_text().strip().startswith('0::' + state['ControlGroup']))
                require(all((row['MainPID'] == '0' or (row.get('unitType') == 'path' and row['MainPID'] is None)) and row['ActiveState'] in {'inactive', 'failed'} for row in [unit_snapshot(unit) for unit in units[1:]]))
                require(announcement_evidence(request) == evidence and container_identity(request) == container)
                health_pair(request); require(unit_snapshot(units[0]) == state and process(parent['pid']) == parent)
                intent = {'schema': CANCEL_SCHEMA, 'request': request, 'container': container, 'evidence': evidence,
                          'originalUnit': state, 'originalProcess': parent, 'originalChild': matches[0], 'stopContract': stop_contract}
            save_once(intent_path, intent)
        allowed = {'engine-release-requests/' + key + '.' + suffix for suffix in ('request', 'intent', 'awaiting-certificate')}
        allowed |= {'engine-release-generation-pins/' + key + '.generation', 'engine-image-leases/' + key + '.lease'}
        allowed |= {'engine-intake-requests/' + key + '.' + suffix for suffix in ('request', 'intent')}
        empty_admission = intent.get('schema') == EMPTY_CANCEL_SCHEMA
        schema = intent['schema']
        require(set(intent) == {'schema', 'request', 'container', 'evidence', 'originalUnit', 'originalProcess', 'originalChild', 'stopContract'} | ({'admission'} if empty_admission else set())
                and schema in {CANCEL_SCHEMA, EMPTY_CANCEL_SCHEMA})
        if empty_admission:
            require(intent['admission'] == 'positive-empty-auto-restart' and intent['originalProcess'] is None and intent['originalChild'] is None)
            require(intent['originalUnit']['MainPID'] == '0' and intent['originalUnit']['SubState'] == 'auto-restart')
        original_group = intent['originalUnit']['ControlGroup'] or (None if empty_admission else '')
        require(set(intent['evidence']['originals']) <= allowed and all(re.fullmatch('[0-9a-f]{64}', value) for value in intent['evidence']['originals'].values()))
        if empty_admission and not os.path.lexists(issued_path):
            require(key == '41177442979-1' and 'engine-release-requests/'+key+'.awaiting-certificate' not in intent['evidence']['originals'])
            require(announcement_evidence(request) == intent['evidence'])
            require(container_identity(request) == intent['container']); health_pair(request)
            loaded_stop_contract(units[0], key, allow_masked=masked(units))
            # Mask only. Even a successor racing this point is never signalled.
            for unit in units:
                path = SYSTEMD / unit
                if os.path.lexists(path): require(path.is_symlink() and os.readlink(path) == '/dev/null')
                else: os.symlink('/dev/null', path); fsync_directory(SYSTEMD)
            command(['systemctl', 'daemon-reload']); require(masked(units))
            quiescence_deadline = time.monotonic() + 60
            while True:
                try: quiet_units(units, original_group, native_empty=True); break
                except (ValueError, OSError, subprocess.SubprocessError):
                    if time.monotonic() >= quiescence_deadline:
                        raise ValueError('Empty retry masked; natural quiescence remains unknown; no stop issued')
                    time.sleep(1)
            unchanged_evidence(announcement_evidence(request, after_stop=True), intent['evidence'], key)
        # A bounded expired retry may end after its immutable intent was saved.
        # Prevent another retry without rebinding or signalling a new invocation.
        current = unit_snapshot(units[0])
        if (not empty_admission and not os.path.lexists(issued_path) and current != intent['originalUnit']
                and not (current['MainPID'] == '0' and current['ActiveState'] in {'inactive', 'failed'})):
            require(key == '41177442979-1' and 'engine-release-requests/'+key+'.awaiting-certificate' not in intent['evidence']['originals'])
            for original in [intent['originalProcess'], intent['originalChild']]:
                try:
                    process(original['pid'])
                except FileNotFoundError:
                    # A missing stat/cmdline file is not proof that the PID is gone.
                    try: os.stat(PROC / str(original['pid']), follow_symlinks=False)
                    except FileNotFoundError as error:
                        require(error.errno == errno.ENOENT)
                    else: raise ValueError('Original process directory remains present')
                else:
                    raise ValueError('Original process is present or reused; cancellation remains unproven')
            require(announcement_evidence(request) == intent['evidence'])
            require(container_identity(request) == intent['container']); health_pair(request)
            loaded_stop_contract(units[0], key, allow_masked=masked(units))
            for unit in units:
                path = SYSTEMD / unit
                if os.path.lexists(path): require(path.is_symlink() and os.readlink(path) == '/dev/null')
                else: os.symlink('/dev/null', path); fsync_directory(SYSTEMD)
            command(['systemctl', 'daemon-reload'])
            require(masked(units))
            current = unit_snapshot(units[0])
            if not (current['MainPID'] == '0' and current['ActiveState'] in {'inactive', 'failed'}):
                raise ValueError('Changed invocation masked; waiting for natural quiescence without issuing stop')
            quiet_units(units, original_group, empty_admission)
            unchanged_evidence(announcement_evidence(request, after_stop=True), intent['evidence'], key)
        if not os.path.lexists(issued_path):
            current = unit_snapshot(units[0])
            already_quiet = current['MainPID'] == '0' and current['ActiveState'] in {'inactive', 'failed'}
            if empty_admission: require(already_quiet)
            if already_quiet:
                quiet_units(units, original_group, empty_admission)
                unchanged_evidence(announcement_evidence(request, after_stop=True), intent['evidence'], key)
            else:
                require(announcement_evidence(request) == intent['evidence'])
                require(current == intent['originalUnit'])
                require(process(intent['originalProcess']['pid']) == intent['originalProcess'])
                require(process(intent['originalChild']['pid']) == intent['originalChild'])
            # Per-instance masks survive reboot. No engine or template unit is selected.
            for unit in units:
                path = SYSTEMD / unit
                if os.path.lexists(path): require(path.is_symlink() and os.readlink(path) == '/dev/null')
                else: os.symlink('/dev/null', path); fsync_directory(SYSTEMD)
            command(['systemctl', 'daemon-reload'])
            require(masked(units))
            if already_quiet:
                quiet_units(units, original_group, empty_admission)
                unchanged_evidence(announcement_evidence(request, after_stop=True), intent['evidence'], key)
            else:
                loaded_stop_contract(units[0], key, allow_masked=True)
                require(announcement_evidence(request) == intent['evidence'])
                require(unit_snapshot(units[0]) == intent['originalUnit'])
                require(process(intent['originalProcess']['pid']) == intent['originalProcess'])
                require(process(intent['originalChild']['pid']) == intent['originalChild'])
            health_pair(request); require(container_identity(request) == container)
            save_once(issued_path, {'schema': schema, 'intentHash': digest(regular(intent_path, 0o600).encode()),
                                   'stopDisposition': 'not-needed-already-quiescent' if already_quiet else 'requested'})
            # One stop of this exact release only. A lost response never sends it again.
            if not already_quiet:
                try: command(['systemctl', 'stop', '--no-block', units[0]], timeout=5)
                except (OSError, subprocess.SubprocessError): pass
        else:
            issued = json.loads(regular(issued_path, 0o600))
            require(set(issued) == {'schema', 'intentHash', 'stopDisposition'} and issued['schema'] == schema
                    and issued['intentHash'] == digest(regular(intent_path, 0o600).encode())
                    and issued['stopDisposition'] in {'requested', 'not-needed-already-quiescent'})
        if empty_admission:
            require(json.loads(regular(issued_path, 0o600))['stopDisposition'] == 'not-needed-already-quiescent')
        require(masked(units))
        deadline = quiescence_deadline if quiescence_deadline is not None else time.monotonic() + 60
        while True:
            try: states = quiet_units(units, original_group, empty_admission); break
            except (ValueError, OSError, subprocess.SubprocessError):
                if time.monotonic() >= deadline: raise ValueError('Cancellation stop outcome unknown; no repeat stop')
                time.sleep(1)
        require(container_identity(request) == container); health_pair(request)
        if not os.path.lexists(quiet_path):
            unchanged_evidence(announcement_evidence(request, after_stop=True), intent['evidence'], key)
            save_once(quiet_path, {'schema': schema, 'actualUnitStates': states})
        quiet = json.loads(regular(quiet_path, 0o600))
        # Once the honest quiescence receipt exists, cleanup can resume after any
        # partial unlink. Historical window and announcement entry never change.
        require(digest(regular(ROOT / 'engine-release-requests' / (key + '.activation-entry'), 0o600).encode()) == intent['evidence']['entryHash'])
        require(digest(regular(ROOT / ('engine-recovery-window-' + key + '.json'), 0o600).encode()) == intent['evidence']['reservationHash'])
        require(digest(regular(ROOT / 'engine-release-requests' / (key + '.lightning-hold.json.released'), 0o600).encode()) == intent['evidence']['releasedHoldHash'])
        for relative, expected in intent['evidence']['originals'].items():
            path = ROOT / relative
            if os.path.lexists(path):
                require(digest(regular(path, 0o600).encode()) == expected)
                path.unlink(); fsync_directory(path.parent)
        for unit in units:
            edge = own_wants_edge(unit)
            if os.path.lexists(edge):
                edge.unlink(); fsync_directory(edge.parent)
        require(all(not os.path.lexists(ROOT / relative) for relative in allowed))
        require(masked(units)); quiet_units(units, original_group, empty_admission)
        require(container_identity(request) == container); health_pair(request)
        receipt = {'schema': schema, 'request': request, 'result': 'cancelled-expired-announcement',
                   'servingInstanceUnchanged': True, 'originalTerminalEdgesRetired': True, 'quiescent': True,
                   'container': container, 'originalControlGroup': original_group,
                   'actualUnitStates': quiet['actualUnitStates'], 'stopDisposition': json.loads(regular(issued_path, 0o600))['stopDisposition'], 'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        save_once(receipt_path, receipt)
        return receipt
    finally:
        os.close(enginefd); os.close(lockfd)


def INVOCATION_PATTERN(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{32}', value) is not None



def remote(request):
    if request.get('mode') == 'cancel_expired_announcement':
        return cancel_announced(request)
    require(os.getuid() == 0 and hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'))
    result_path = ROOT / 'engine-release-results' / (request['runKey'] + '.json')
    if os.path.lexists(result_path):
        return terminal(request)  # Lost acknowledgement never repeats the signal.
    key = request['runKey']
    generation = PARENT / 'engine-control-generations' / request['controlSha']
    require(generation.resolve(strict=True) == generation)
    require(regular(generation / 'control-sha').strip() == request['controlSha'])
    request_path = ROOT / 'engine-release-requests' / (key + '.request')
    expected_pin = str(generation) + '\n' + request['controlSha'] + '\n'
    lock_fd = os.open(ENGINE_LOCK, os.O_RDWR | os.O_NOFOLLOW)
    try:
        require(stat.S_ISREG(os.fstat(lock_fd).st_mode) and os.fstat(lock_fd).st_uid == 0)
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        lines = regular(request_path, 0o600).splitlines()
        require(len(lines) == 6 and lines[0] == request['releaseSha'])
        require(lines[3:5] == [str(generation), request['controlSha']])
        require(regular(ROOT / 'engine-release-generation-pins' / (key + '.generation'), 0o600) == expected_pin)
        require(regular(ROOT / 'engine-release-requests' / (key + '.awaiting-certificate')).strip() == request['releaseSha'])
        require(not os.path.lexists(ROOT / 'engine-release-requests' / (key + '.break-deadline')))
        seal = str(generation / 'engine-release-seal.py')
        require(command([seal, 'pending-owner']) == 'none')
        require(command([seal, 'get', 'desired-sha']) == request['desiredSha'])
        unit = 'club-arena-engine-release-v1@' + key + '.service'
        state = properties(unit)
        require(state['ActiveState'] in ('active', 'activating'))
        require(re.fullmatch(r'[0-9a-f]{32}', state['InvocationID']) is not None)
        parent = process(int(state['MainPID']))
        require(bash_command(parent['argv'], [str(PARENT / 'engine-release-unit-wrapper-v1.sh'), 'start', key]))
        children = (PROC / str(parent['pid']) / 'task' / str(parent['pid']) / 'children').read_text().split()
        matches = [process(int(pid)) for pid in children]
        matches = [p for p in matches if bash_command(p['argv'], [str(generation / 'engine-release-transaction.sh'), '--run-id', key])]
        require(len(matches) == 1 and matches[0]['parent'] == parent['pid'])
        child = matches[0]
        pid_fd = os.pidfd_open(child['pid'])
        try:
            before = container_identity(request)
            health_pair(request)
            command([str(generation / 'engine-release-database-proof.py'), '--env-file',
                     '/opt/club-arena/server/.env', '--sha', request['desiredSha'],
                     '--instance-id', request['instanceId'], '--timeout-seconds', '15',
                     '--poll-seconds', '5', '--max-heartbeat-age-seconds', '15'], timeout=17)
            require(properties(unit) == state and process(parent['pid']) == parent and process(child['pid']) == child)
            require(command([seal, 'pending-owner']) == 'none')
            require(container_identity(request) == before)
            health_pair(request)
            # Signal the pidfd-bound transaction, never its wrapper, unit or cgroup.
            signal.pidfd_send_signal(pid_fd, signal.SIGINT)
        finally:
            os.close(pid_fd)
    finally:
        os.close(lock_fd)  # Original wrapper must immediately regain its recovery lock.
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        try:
            answer = terminal(request, state['InvocationID'])
            require(container_identity(request) == before)
            return answer
        except (ValueError, OSError, subprocess.SubprocessError, KeyError):
            time.sleep(1)
    raise ValueError('Original terminal outcome remains unknown; do not replay')


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--remote':
        request = selection(json.loads(base64.b64decode(sys.argv[2], validate=True)))
        print(json.dumps(remote(request)))
        return
    require(len(sys.argv) == 1 and os.environ.get('GITHUB_EVENT_NAME') == 'repository_dispatch')
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    require(event.get('action') == 'withdraw-club-arena-engine')
    request = selection(event.get('client_payload', {}).get('withdrawal'))
    host, key, pin = [os.environ.get(k, '') for k in ('HETZNER_HOST', 'HETZNER_SSH_PRIVATE_KEY', 'HETZNER_HOST_KEY')]
    require(re.fullmatch(r'[A-Za-z0-9.-]+', host) is not None and not host.startswith('-') and key.strip() and pin.strip())
    directory = Path(tempfile.mkdtemp(prefix='engine-withdrawal-', dir=os.environ['RUNNER_TEMP']))
    try:
        for name, content in [('key', key), ('known_hosts', pin)]:
            path = directory / name
            path.write_text(content + '\n')
            path.chmod(0o600)
        for args in [['ssh-keygen', '-y', '-f', str(directory / 'key')], ['ssh-keygen', '-l', '-f', str(directory / 'known_hosts')]]:
            subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=5)
        encoded = base64.b64encode(json.dumps(request).encode()).decode()
        args = ['ssh', '-i', str(directory / 'key'), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
                '-o', 'StrictHostKeyChecking=yes', '-o', 'GlobalKnownHostsFile=/dev/null',
                '-o', 'UserKnownHostsFile=' + str(directory / 'known_hosts'), '-o', 'ConnectTimeout=10',
                'root@' + host, "python3 - --remote '" + encoded + "'"]
        reply = subprocess.run(args, input=Path(__file__).read_bytes(), capture_output=True, timeout=150)
        require(reply.returncode == 0 and len(reply.stdout) <= 4096)
        answer = json.loads(reply.stdout)
        if request.get('mode') == 'cancel_expired_announcement':
            validate_cancellation_reply(answer, request)
            destination = Path('artifacts/engine-withdrawal')
            destination.mkdir(parents=True, exist_ok=True)
            (destination / 'receipt.json').write_text(json.dumps(answer, indent=2) + '\n')
            print('Exact expired announcement cancelled; serving engine unchanged.')
            return
        require(set(answer) == set(request) | {'schema', 'result', 'invocationId',
                'originalTransactionExitStatus', 'servingInstanceUnchanged', 'originalTerminalEdgesRetired'})
        require(all(answer.get(k) == v for k, v in request.items()))
        require(answer.get('schema') == SCHEMA and answer.get('result') == 'withdrawn-before-mutation')
        require(answer.get('originalTransactionExitStatus') == 130)
        require(re.fullmatch(r'[0-9a-f]{32}', answer.get('invocationId', '')) is not None)
        require(answer.get('servingInstanceUnchanged') is True and answer.get('originalTerminalEdgesRetired') is True)
        answer['observedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        destination = Path('artifacts/engine-withdrawal')
        destination.mkdir(parents=True, exist_ok=True)
        (destination / 'receipt.json').write_text(json.dumps(answer, indent=2) + '\n')
        print('Original waiting transaction withdrawn; exact serving instance unchanged.')
    finally:
        shutil.rmtree(directory)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Withdrawal unproved. Read the original exact run before any further action.', file=sys.stderr)
        sys.exit(1)
