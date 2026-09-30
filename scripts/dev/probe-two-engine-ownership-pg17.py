#!/usr/bin/env python3
"""Two locally built engine processes contend for one fleet on an isolated PostgreSQL 17.

Phase 11 line 3 ("one engine owner per table and safe release/recovery").
Production is never touched: the cluster listens on a Unix socket inside
--work-dir only, every engine reaches it through a loopback shim, and the
engine process refuses to start unless SUPABASE_URL is that loopback shim.

What runs:
  * the live ownership doors, byte-for-byte (md5(pg_get_functiondef) is
    compared with two-engine-ownership/live-doors.manifest.json, which
    capture-live-doors.py reads passively from production), on the live
    table shapes (columns, constraints and indexes compared too);
  * the engine's own leadership.js, tableLease.js and tournamentLease.js from
    server/dist (build it first: npx tsc --project tsconfig.emit.json in server/);
  * a fleet of chip and Diamond cash tables and chip and Diamond tournaments.

Scenarios, each the shape of a real production event:
  R1 release cutover   leader parks (the break), SIGTERM (docker stop), the
                       replacement boots and adopts the released fleet
  R2 crash restart     SIGKILL mid-hand; the restarted process waits out the
                       staleness window and adopts the fleet
  R3 partition         a second container appears (the 2026-08-16/23 shape),
                       then the leader loses its database: it must stop dealing
                       at its proof deadline, before anyone can take over, and
                       every late write it sent must be refused when it lands
  R4 two leaders       leadership bypassed: both processes claim everything
  R5 busy settlement   a takeover waits for a settlement that holds the lease

Verdict lines are printed as PASS:/FAIL:, the numbers go to
<work-dir>/summary.json, and the exit status is non-zero on any FAIL.

Usage:
  (cd server && npx tsc --project tsconfig.emit.json)
  python3 scripts/dev/probe-two-engine-ownership-pg17.py --work-dir <empty dir>
"""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.request
import uuid

HERE = pathlib.Path(__file__).resolve().parent
ASSETS = HERE / 'two-engine-ownership'
REPO = HERE.parents[1]
FAILURES = []
SUMMARY = {}
KILLS = []
ENGINES = []


def verdict(ok, text):
    print(('PASS: ' if ok else 'FAIL: ') + text, flush=True)
    if not ok:
        FAILURES.append(text)


def say(text):
    print(f'[{time.strftime("%H:%M:%S")}] {text}', flush=True)


class Cluster:
    def __init__(self, pg_bin, work, port):
        self.pg_bin, self.work, self.port = pg_bin, work, port
        self.data, self.sock = work / 'data', work / 'sock'
        self.db = 'ownership'

    def env(self):
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(('PG', 'SUPABASE', 'DATABASE_URL', 'ENGINE_PG'))}
        env.update(PGHOST=str(self.sock), PGPORT=str(self.port), PGUSER='postgres', PGDATABASE=self.db)
        return env

    def start(self):
        self.sock.mkdir(parents=True)
        # The macOS postmaster refuses to start multithreaded without a locale.
        env = dict(os.environ, LC_ALL='C', LANG='C')
        subprocess.run([f'{self.pg_bin}/initdb', '-D', str(self.data), '-U', 'postgres', '-A', 'trust',
                        '--locale=C', '-E', 'UTF8', '--no-instructions'], check=True, capture_output=True, env=env)
        with open(self.data / 'postgresql.conf', 'a') as conf:
            conf.write(f"\nlisten_addresses = ''\nunix_socket_directories = '{self.sock}'\n"
                       f"port = {self.port}\nmax_connections = 120\nfsync = off\n"
                       "log_min_messages = warning\n")
        subprocess.run([f'{self.pg_bin}/pg_ctl', '-D', str(self.data), '-l', str(self.work / 'postgres.log'),
                        '-w', 'start'], check=True, capture_output=True, env=env)
        subprocess.run([f'{self.pg_bin}/createdb', '-h', str(self.sock), '-p', str(self.port),
                        '-U', 'postgres', self.db], check=True)

    def stop(self):
        subprocess.run([f'{self.pg_bin}/pg_ctl', '-D', str(self.data), '-m', 'fast', 'stop'],
                       capture_output=True)

    def psql(self, sql=None, file=None, timeout=120):
        cmd = [f'{self.pg_bin}/psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-P', 'pager=off']
        cmd += ['-f', str(file)] if file else ['-c', sql]
        r = subprocess.run(cmd, env=self.env(), text=True, capture_output=True, timeout=timeout)
        if r.returncode:
            raise RuntimeError(f'psql failed: {r.stderr.strip()}')
        return r.stdout.strip()

    def json(self, sql):
        return json.loads(self.psql(f'select coalesce(jsonb_agg(to_jsonb(q)), \'[]\'::jsonb) from ({sql}) q'))


def fidelity(cluster):
    manifest = json.loads((ASSETS / 'live-doors.manifest.json').read_text())
    SUMMARY['live_capture'] = manifest['captured_at']
    mismatched = []
    for f in manifest['functions']:
        sig = f['signature'] if '.' in f['signature'].split('(')[0] else 'public.' + f['signature']
        local = cluster.psql(f"select md5(pg_get_functiondef('{sig}'::regprocedure))")
        if local != f['md5']:
            mismatched.append(sig)
    verdict(not mismatched, f"all {len(manifest['functions'])} ownership doors run byte-for-byte as production "
            f"(md5 of pg_get_functiondef, captured {manifest['captured_at']})" + (f' MISMATCH {mismatched}' if mismatched else ''))
    names = "'engine_leader','engine_table_leases','engine_tournament_leases'"
    columns = cluster.json(
        'select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns '
        f"where table_schema='public' and table_name in ({names}) order by table_name, ordinal_position")
    constraints = cluster.json(
        'select conrelid::regclass::text as rel, conname, pg_get_constraintdef(oid) as def from pg_constraint '
        f"where conrelid in (select oid from pg_class where relnamespace='public'::regnamespace and relname in ({names})) "
        'order by 1, 2')
    indexes = cluster.json(
        'select indrelid::regclass::text as rel, pg_get_indexdef(indexrelid) as def from pg_index '
        f"where indrelid in (select oid from pg_class where relnamespace='public'::regnamespace and relname in ({names})) "
        'order by 1, 2')
    triggers = [t for t in cluster.json(
        'select tgrelid::regclass::text as rel, tgname, pg_get_triggerdef(oid) as def from pg_trigger '
        f"where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace='public'::regnamespace "
        f"and relname in ({names})) order by 1, 2") if not t['tgname'].startswith('zz_isolated')]
    live_triggers = [t for t in manifest['triggers'] if t['tgname'] != 'a00_f06_retired_origin_claim']
    verdict(columns == manifest['columns'] and constraints == manifest['constraints']
            and indexes == manifest['indexes'] and triggers == live_triggers,
            'the three ownership tables have the live columns, constraints, indexes and F06 abort trigger '
            '(the retired-origin trigger applies only to F06 retired cohorts, none exist here)')


def seed_fleet(cluster):
    """Six chip and four Diamond cash tables; two chip tournaments and one
    Diamond tournament of two tables each."""
    fleet = {'tables': [], 'tournaments': []}
    for asset, count in (('chips', 6), ('diamonds', 4)):
        for _ in range(count):
            fleet['tables'].append({'id': str(uuid.uuid4()), 'tournamentId': None, 'asset': asset})
    for asset in ('chips', 'chips', 'diamonds'):
        tid = str(uuid.uuid4())
        fleet['tournaments'].append({'id': tid, 'asset': asset})
        for _ in range(2):
            fleet['tables'].append({'id': str(uuid.uuid4()), 'tournamentId': tid, 'asset': asset})
    values = ','.join(f"('{t['id']}','{t['asset']}')" for t in fleet['tournaments'])
    cluster.psql(f'insert into public.tournaments(id, asset) values {values}')
    values = ','.join("('%s',%s,'%s')" % (t['id'], f"'{t['tournamentId']}'" if t['tournamentId'] else 'null',
                                          t['asset']) for t in fleet['tables'])
    cluster.psql(f'insert into public.tables(id, tournament_id, asset) values {values}')
    return fleet


class Shim:
    def __init__(self, name, port, cluster, work):
        self.name, self.port = name, port
        env = cluster.env()
        env.update(SHIM_NAME=name, SHIM_PORT=str(port),
                   ENGINE_NODE_MODULES=str(REPO / 'server' / 'node_modules'))
        self.log = open(work / f'shim-{name}.jsonl', 'w')
        self.proc = subprocess.Popen(['node', str(ASSETS / 'rpc-shim.mjs')], env=env,
                                     stdout=self.log, stderr=subprocess.STDOUT)
        for _ in range(100):
            try:
                self.fault('ok')
                return
            except OSError:
                time.sleep(0.1)
        raise RuntimeError(f'shim {name} did not start')

    def fault(self, mode):
        req = urllib.request.Request(f'http://127.0.0.1:{self.port}/__fault', method='POST',
                                     data=json.dumps({'mode': mode}).encode(),
                                     headers={'content-type': 'application/json'})
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())

    def stop(self):
        self.proc.terminate()
        self.proc.wait(10)
        self.log.close()


class Engine:
    """One engine 'container': a supervisor restarts it after exit 75, as the
    production restart policy does, and each boot is a new process with a new
    instance id."""

    def __init__(self, name, mode, shim, fleet, work, dist):
        self.name, self.mode, self.shim, self.fleet, self.work, self.dist = name, mode, shim, fleet, work, dist
        self.boots, self.proc, self.log = 0, None, None
        self.supervise = True
        ENGINES.append(self)
        self._boot()
        self.thread = threading.Thread(target=self._watch, daemon=True)
        self.thread.start()

    def _boot(self):
        self.boots += 1
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(('PG', 'SUPABASE', 'DATABASE_URL', 'ENGINE_PG', 'ALERT_'))}
        env.update(SUPABASE_URL=f'http://127.0.0.1:{self.shim.port}', ENGINE_DIST=str(self.dist),
                   PROBE_NAME=f'{self.name}{self.boots}', PROBE_MODE=self.mode,
                   PROBE_FLEET=json.dumps(self.fleet), GIT_COMMIT_SHA='probe-local-build')
        self.log = open(self.work / f'engine-{self.name}{self.boots}.jsonl', 'w')
        self.proc = subprocess.Popen(['node', str(ASSETS / 'engine-process.mjs')], env=env,
                                     stdout=self.log, stderr=subprocess.DEVNULL)
        say(f'engine {self.name}{self.boots} started (mode {self.mode}, pid {self.proc.pid})')

    def _watch(self):
        while True:
            code = self.proc.wait()
            say(f'engine {self.name}{self.boots} exited {code}')
            if code == 75 and self.supervise:
                self._boot()
                continue
            return

    def signal(self, sig):
        if sig == signal.SIGKILL:
            KILLS.append({'engine': f'{self.name}{self.boots}', 'at': int(time.time() * 1000)})
        self.proc.send_signal(sig)

    def alive(self):
        return self.proc.poll() is None

    def current(self):
        return f'{self.name}{self.boots}'

    def stop(self):
        self.supervise = False
        if self.alive():
            self.signal(signal.SIGTERM)
            try:
                self.proc.wait(30)
            except subprocess.TimeoutExpired:
                self.signal(signal.SIGKILL)
        self.thread.join(5)


def events(work, pattern='engine-*.jsonl'):
    rows = []
    for path in sorted(work.glob(pattern)):
        for line in path.read_text().splitlines():
            line = line.strip()
            if line.startswith('{'):
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return rows


def wait_for(what, predicate, timeout, poll=0.5):
    start = time.time()
    while time.time() - start < timeout:
        value = predicate()
        if value:
            return time.time() - start
        time.sleep(poll)
    raise TimeoutError(f'waited {timeout}s for {what}')


def holders(cluster):
    """Fresh holders by subject, as the database sees them right now."""
    rows = cluster.json(
        "select 'table' as scope, table_id::text as id, instance_id from engine_table_leases "
        "where heartbeat_at >= clock_timestamp() - interval '30 seconds' union all "
        "select 'tournament', tournament_id::text, instance_id from engine_tournament_leases "
        "where heartbeat_at >= clock_timestamp() - interval '30 seconds' union all "
        "select 'leader', 'leader', instance_id from engine_leader "
        "where heartbeat_at >= clock_timestamp() - interval '30 seconds'")
    return {(r['scope'], r['id']): r['instance_id'] for r in rows}


def fleet_held_by_one(cluster, fleet):
    h = holders(cluster)
    subjects = [('table', t['id']) for t in fleet['tables'] if not t['tournamentId']]
    subjects += [('tournament', t['id']) for t in fleet['tournaments']]
    owners = {h.get(s) for s in subjects}
    return next(iter(owners)) if len(owners) == 1 and None not in owners else None


def reboot(engine):
    """The same container name started again: docker run after docker rm, or
    the restart policy after a crash. A new process, so a new instance id."""
    engine.supervise = True
    engine._boot()
    engine.thread = threading.Thread(target=engine._watch, daemon=True)
    engine.thread.start()


def engine_event(work, engine_name, ev):
    return next((e for e in events(work, f'engine-{engine_name}.jsonl') if e['ev'] == ev), None)


def scenario(name):
    SUMMARY.setdefault('scenarios', {})[name] = {'start': int(time.time() * 1000)}
    say(f'--- {name} ---')


def end_scenario(name, **facts):
    SUMMARY['scenarios'][name].update(end=int(time.time() * 1000), **facts)


def boot_instance(work, engine_name):
    boot = engine_event(work, engine_name, 'boot')
    return boot['instance'] if boot else None


def held_by_engine(cluster, fleet, work, engine, first_boot):
    """The instance that holds the whole fleet, if it is a boot of `engine`
    numbered first_boot or later."""
    owner = fleet_held_by_one(cluster, fleet)
    mine = {boot_instance(work, f'{engine.name}{n}') for n in range(first_boot, engine.boots + 1)}
    return owner if owner and owner in mine else None


def run_scenarios(cluster, fleet, work, dist, shim_a, shim_b):
    scenario('R1 release cutover')
    a = Engine('A', 'leader', shim_a, fleet, work, dist)
    wait_for('A1 to hold the whole fleet', lambda: held_by_engine(cluster, fleet, work, a, 1), 60)
    time.sleep(10)
    outgoing = a.current()
    a.signal(signal.SIGUSR1)
    wait_for(f'{outgoing} to park', lambda: engine_event(work, outgoing, 'parked'), 20)
    a.signal(signal.SIGTERM)
    a.proc.wait(30)
    released_at = int(time.time() * 1000)
    first = a.boots + 1
    reboot(a)
    took = wait_for('the replacement to hold the whole fleet', lambda: held_by_engine(cluster, fleet, work, a, first), 60)
    end_scenario('R1 release cutover', outgoing=outgoing, replacement=a.current(), released_at=released_at,
                 replacement_held_fleet_after_s=round(took, 1),
                 parked=engine_event(work, outgoing, 'parked'), stopped=engine_event(work, outgoing, 'stopped'))

    scenario('R2 crash restart')
    time.sleep(10)
    crashed = a.current()
    a.signal(signal.SIGKILL)
    killed_at = int(time.time() * 1000)
    time.sleep(0.5)
    first = a.boots + 1
    reboot(a)
    took = wait_for('the restarted engine to hold the whole fleet',
                    lambda: held_by_engine(cluster, fleet, work, a, first), 150)
    end_scenario('R2 crash restart', crashed=crashed, restarted=a.current(), killed_at=killed_at,
                 restarted_held_fleet_after_s=round(took, 1))

    scenario('R3 partition')
    time.sleep(5)
    partitioned = a.current()
    b = Engine('B', 'leader', shim_b, fleet, work, dist)
    time.sleep(5)
    shim_a.fault('hold')
    partitioned_at = int(time.time() * 1000)
    took = wait_for('the second container to hold the whole fleet',
                    lambda: held_by_engine(cluster, fleet, work, b, 1), 180)
    time.sleep(8)
    shim_a.fault('heal')
    healed_at = int(time.time() * 1000)
    wait_for(f'{partitioned} to stand down', lambda: engine_event(work, partitioned, 'leadership_shutdown'), 90)
    wait_for('the restarted A to report its role', lambda: a.current() != partitioned
             and engine_event(work, a.current(), 'role'), 120)
    end_scenario('R3 partition', partitioned=partitioned, successor=b.current(), partitioned_at=partitioned_at,
                 healed_at=healed_at, successor_held_fleet_after_s=round(took, 1),
                 restarted_a=a.current(), restarted_a_role=engine_event(work, a.current(), 'role')['role'])
    a.stop()
    b.stop()

    scenario('R4 two leaders at once')
    c = Engine('C', 'contend', shim_a, fleet, work, dist)
    d = Engine('D', 'contend', shim_b, fleet, work, dist)
    time.sleep(30)
    split = holders(cluster)
    c.supervise = False
    c.signal(signal.SIGKILL)
    killed_at = int(time.time() * 1000)
    took = wait_for('D to hold the whole fleet', lambda: held_by_engine(cluster, fleet, work, d, 1), 150)
    time.sleep(5)
    d.stop()
    c_instance, d_instance = boot_instance(work, 'C1'), boot_instance(work, 'D1')
    end_scenario('R4 two leaders at once', killed='C1', killed_at=killed_at,
                 survivor_held_fleet_after_s=round(took, 1),
                 split_while_both_ran={'C1': sum(1 for k, v in split.items() if v == c_instance and k[0] != 'leader'),
                                       'D1': sum(1 for k, v in split.items() if v == d_instance and k[0] != 'leader')})


def busy_settlement(cluster):
    scenario('R5 busy settlement')
    table, tournament = str(uuid.uuid4()), None
    g1, g2 = str(uuid.uuid4()), str(uuid.uuid4())
    cluster.psql(f"insert into public.tables(id, tournament_id, asset) values ('{table}', null, 'diamonds')")
    granted = cluster.psql(f"select granted from claim_table_lease_v2('{table}','probe-settling','probe','{g1}',30)")
    settle = subprocess.Popen(
        [f'{cluster.pg_bin}/psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c',
         f"select isolated_commit_hand('{table}', 1000001, 'probe-settling', '{g1}', 6)->>'success', "
         "clock_timestamp()"],
        env=cluster.env(), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    time.sleep(1)
    cluster.psql("update engine_table_leases set heartbeat_at = clock_timestamp() - interval '31 seconds' "
                 f"where table_id = '{table}'")
    started = time.time()
    successor = cluster.psql(f"select granted, clock_timestamp() from claim_table_lease_v2('{table}',"
                             f"'probe-successor','probe','{g2}',30)")
    waited = time.time() - started
    settled, _ = settle.communicate(30)
    late = cluster.psql(f"select isolated_commit_hand('{table}', 1000002, 'probe-settling', '{g1}')->>'reason'")
    commits = cluster.json(f"select hand_number, ref from isolated_hand_commits where table_id = '{table}'")
    facts = dict(first_claim_granted=granted == 't', successor_waited_s=round(waited, 2),
                 successor_granted=successor.startswith('t|'), settling_commit=settled.strip(),
                 late_commit_after_takeover=late, commits=commits)
    end_scenario('R5 busy settlement', **facts)
    verdict(granted == 't' and settled.split('|')[0] == 'true' and waited >= 4.0 and successor.startswith('t|')
            and late == 'hand_lease_lost' and len(commits) == 1,
            f'R5: a takeover of a stale Diamond table waited {waited:.1f}s for the settlement holding its lease, '
            'the settlement committed first, the successor was granted after it, and the old generation\'s next '
            f'commit was refused ({late})')


def analyse(cluster, fleet, work, kills):
    evs = events(work)
    asset_of = {('table', t['id']): t['asset'] for t in fleet['tables'] if not t['tournamentId']}
    asset_of.update({('tournament', t['id']): t['asset'] for t in fleet['tournaments']})
    subject_of_table = {t['id']: (('tournament', t['tournamentId']) if t['tournamentId'] else ('table', t['id']))
                        for t in fleet['tables']}
    killed = {k['engine']: k['at'] for k in kills}
    last_seen = {}
    for e in evs:
        last_seen[e['engine']] = max(last_seen.get(e['engine'], 0), e['t'])

    # 1. Dealing authority, as each engine process itself held it.
    intervals = {}
    for e in evs:
        if e['ev'] not in ('authority_start', 'authority_extend', 'authority_end'):
            continue
        k = (e['engine'], e['instance'], e['scope'], e['id'], e['gen'])
        iv = intervals.setdefault(k, {'engine': e['engine'], 'instance': e['instance'], 'subject': (e['scope'], e['id']),
                                      'gen': e['gen'], 'start': None, 'deadline': None, 'end': None, 'why': None})
        if e['ev'] == 'authority_start':
            iv['start'], iv['deadline'] = e['startWall'], e['deadlineWall']
        elif e['ev'] == 'authority_extend':
            iv['deadline'] = max(iv['deadline'] or 0, e['deadlineWall'])
        else:
            iv['end'], iv['why'] = e['endWall'], e['reason']
    for iv in intervals.values():
        if iv['end'] is None:
            died = killed.get(iv['engine'], last_seen.get(iv['engine']))
            iv['end'], iv['why'] = min(iv['deadline'], died), 'process_killed' if iv['engine'] in killed else 'open'
    by_subject = {}
    for iv in intervals.values():
        if iv['start'] is not None:
            by_subject.setdefault(iv['subject'], []).append(iv)
    overlaps, handovers = [], []
    for subject, ivs in by_subject.items():
        ivs.sort(key=lambda iv: iv['start'])
        for i, x in enumerate(ivs):
            for y in ivs[i + 1:]:
                if x['instance'] != y['instance'] and min(x['end'], y['end']) > max(x['start'], y['start']):
                    overlaps.append({'subject': subject, 'a': x, 'b': y})
        for x, y in zip(ivs, ivs[1:]):
            if x['instance'] != y['instance']:
                handovers.append({'subject': subject, 'asset': asset_of[subject], 'from': x['engine'],
                                  'to': y['engine'], 'why': x['why'], 'gap_ms': y['start'] - x['end'], 'at': y['start']})
    verdict(not overlaps, f'no subject was ever held by two engine processes at once: {len(intervals)} authority '
            f'intervals over {len(by_subject)} tables and tournaments, {len(overlaps)} overlaps')
    SUMMARY['authority_intervals'] = len(intervals)
    SUMMARY['overlaps'] = overlaps[:5]

    # 2. Every hand, as the database recorded it, against the lease the database held at that moment.
    commits = cluster.json(
        'select c.table_id::text as table_id, c.hand_number, c.ref, '
        "(extract(epoch from c.committed_at) * 1000)::bigint as at, "
        '(select h.instance_id || \'|\' || h.lease_generation::text from isolated_lease_history h '
        "  where h.scope = case when t.tournament_id is null then 'engine_table_leases' else 'engine_tournament_leases' end "
        '    and h.subject = coalesce(t.tournament_id, t.id)::text and h.op <> \'DELETE\' and h.at <= c.committed_at '
        '  order by h.at desc, h.id desc limit 1) as lease_then '
        'from isolated_hand_commits c join public.tables t on t.id = c.table_id')
    fleet_ids = {t['id'] for t in fleet['tables']}
    commits = [c for c in commits if c['table_id'] in fleet_ids]
    wrong_holder = [c for c in commits if c['lease_then'] != c['ref']]
    verdict(commits and not wrong_holder,
            f'every one of {len(commits)} committed hands was committed by the engine holding that table\'s '
            f'lease generation at that instant ({len(wrong_holder)} exceptions)')
    fenced = []
    for tid in fleet_ids:
        seq = sorted((c for c in commits if c['table_id'] == tid), key=lambda c: (c['at'], c['hand_number']))
        seen = []
        for c in seq:
            if c['ref'] in seen and seen[-1] != c['ref']:
                fenced.append(c)
            if not seen or seen[-1] != c['ref']:
                seen.append(c['ref'])
    verdict(not fenced, f'no older lease generation committed a hand after a newer one had '
            f'({len(fenced)} resurrections across {len(fleet_ids)} tables)')

    results = [e for e in evs if e['ev'] == 'commit_result']
    accepted = {(e['table'], e['hand']) for e in results if e['accepted']}
    in_db = {(c['table_id'], c['hand_number']) for c in commits}
    duplicates = [e for e in results if e.get('reason') == 'hand_number_already_committed']
    missing = accepted - in_db
    unacknowledged = sorted(in_db - accepted)
    verdict(not duplicates and not missing,
            f'no hand number was dealt twice and no hand an engine saw accepted is missing '
            f'({len(accepted)} accepted, {len(duplicates)} duplicates, {len(missing)} missing)')
    refused = {}
    for e in results:
        if not e['accepted']:
            refused[e.get('reason') or 'unknown'] = refused.get(e.get('reason') or 'unknown', 0) + 1
    SUMMARY['hands'] = {
        'committed': len(commits),
        'committed_by_asset': {a: sum(1 for c in commits if asset_of[subject_of_table[c['table_id']]] == a)
                               for a in ('chips', 'diamonds')},
        'engine_saw_refused': refused,
        'committed_but_engine_never_heard': len(unacknowledged),
        'committed_but_engine_never_heard_list': unacknowledged[:20],
    }

    # 3. Writes that reached the database after their sender had lost the table.
    late = [r for r in (json.loads(l) for l in (work / 'shim-A.jsonl').read_text().splitlines() if l.startswith('{'))
            if r.get('ev') == 'rpc' and r.get('late')]
    late_by_fn = {}
    for r in late:
        body = r['body']
        if r['fn'] == 'isolated_commit_hand':
            outcome = 'accepted' if isinstance(body, dict) and body.get('success') else (body or {}).get('reason')
        elif r['fn'] == 'claim_engine_leadership' or r['fn'].startswith('claim_'):
            outcome = 'granted' if isinstance(body, list) and body and body[0].get('granted') else 'refused'
        elif r['fn'].startswith('heartbeat_'):
            states = sorted({row['state'] for row in body}) if isinstance(body, list) else ['error']
            outcome = '+'.join(states) if states else 'empty'
        else:
            outcome = 'status %s' % r['status']
        late_by_fn.setdefault(r['fn'], {}).setdefault(str(outcome), 0)
        late_by_fn[r['fn']][str(outcome)] += 1
    late_accepted = late_by_fn.get('isolated_commit_hand', {}).get('accepted', 0)
    late_granted = sum(v.get('granted', 0) for k, v in late_by_fn.items() if k.startswith('claim_'))
    late_kept = sum(v for k, fn in late_by_fn.items() if k.startswith('heartbeat_')
                    for o, v in fn.items() if 'kept' in o)
    SUMMARY['late_writes_after_partition'] = late_by_fn
    verdict(late and late_accepted == 0 and late_granted == 0 and late_kept == 0,
            f'every one of {len(late)} writes the partitioned engine sent, delivered only after the successor '
            f'took over, was refused: {json.dumps(late_by_fn, sort_keys=True)}')

    # 4. A standby claims nothing, and leadership moved only when released or stale.
    standby_engines = {e['engine'] for e in evs if e['ev'] == 'role' and e['role'] == 'standby'}
    standby_claims = [e for e in evs if e['engine'] in standby_engines
                      and e['ev'] in ('authority_start', 'claim_refused', 'commit_start')]
    verdict(standby_engines and not standby_claims,
            f'{len(standby_engines)} engine process(es) that booted as standby ({sorted(standby_engines)}) claimed, '
            f'dealt and committed nothing')
    leaders = cluster.json("select at, op, instance_id from isolated_lease_history where scope = 'engine_leader' "
                           "and op in ('INSERT','DELETE') or (scope = 'engine_leader' and op = 'UPDATE' and "
                           "instance_id is distinct from (select h2.instance_id from isolated_lease_history h2 "
                           "where h2.scope = 'engine_leader' and h2.id < isolated_lease_history.id order by h2.id desc limit 1)) "
                           "order by id")
    SUMMARY['leadership_changes'] = leaders

    # 5. Handover gaps, per scenario and per asset.
    per = {}
    for name, sc in SUMMARY.get('scenarios', {}).items():
        hs = [h for h in handovers if sc['start'] <= h['at'] <= sc.get('end', 10 ** 15)]
        per[name] = {asset: {'handovers': len(g), 'min_gap_ms': min(x['gap_ms'] for x in g),
                             'max_gap_ms': max(x['gap_ms'] for x in g),
                             'from_reasons': sorted({x['why'] for x in g})}
                     for asset in ('chips', 'diamonds')
                     for g in [[h for h in hs if h['asset'] == asset]] if g}
    SUMMARY['handovers'] = per

    # 6. The database's own view: a live row changed hands only after it was stale.
    takeovers = cluster.json(
        'select scope, subject, id, instance_id, acquired_at, prev_instance, prev_heartbeat, '
        "extract(epoch from acquired_at - prev_heartbeat) as stale_for_s from ("
        '  select h.*, lag(instance_id) over w as prev_instance, lag(heartbeat_at) over w as prev_heartbeat '
        '  from isolated_lease_history h window w as (partition by scope, subject order by id)'
        ") x where op = 'UPDATE' and instance_id is distinct from prev_instance order by id")
    early = [t for t in takeovers if float(t['stale_for_s']) < 30]
    SUMMARY['database_takeovers'] = {'count': len(takeovers),
                                     'min_stale_for_s': min((float(t['stale_for_s']) for t in takeovers), default=None)}
    verdict(takeovers and not early,
            f'the database let a live lease change hands {len(takeovers)} times, never before the holder had '
            f'been silent for 30 s (shortest: {SUMMARY["database_takeovers"]["min_stale_for_s"]:.1f} s)')
    sc = SUMMARY['scenarios']
    r1 = sc['R1 release cutover']
    verdict(r1['parked']['handsInFlight'] == 0 and r1['stopped']['handsInFlightAtRelease'] == 0
            and r1['stopped']['tables'] == {'status': 'confirmed', 'releasedCount': 10, 'attempts': 1}
            and r1['stopped']['tournaments'] == {'status': 'confirmed', 'releasedCount': 3, 'attempts': 1}
            and r1['stopped']['leadership'] == 'released'
            and all(v['max_gap_ms'] < 5000 for v in per['R1 release cutover'].values()),
            f"R1: the outgoing engine parked with 0 hands in the air, released 10 cash tables, 3 tournaments and "
            f"leadership, and the replacement held the whole fleet {r1['replacement_held_fleet_after_s']} s later "
            f"(per-table gap {min(v['min_gap_ms'] for v in per['R1 release cutover'].values())}-"
            f"{max(v['max_gap_ms'] for v in per['R1 release cutover'].values())} ms)")
    r2 = per['R2 crash restart']
    verdict(all(v['from_reasons'] == ['process_killed'] and v['min_gap_ms'] >= 25000 for v in r2.values()),
            f"R2: after a crash the restarted engine took each table only once its lease was stale "
            f"(gap {min(v['min_gap_ms'] for v in r2.values())}-{max(v['max_gap_ms'] for v in r2.values())} ms)")
    r3 = per['R3 partition']
    verdict(all(v['from_reasons'] == ['proof_expired'] and v['min_gap_ms'] >= 9000 for v in r3.values()),
            f"R3: the partitioned engine stopped dealing at its own proof deadline, "
            f"{min(v['min_gap_ms'] for v in r3.values())}-{max(v['max_gap_ms'] for v in r3.values())} ms before "
            "the second container could take any table")
    negative = [h for h in handovers if h['gap_ms'] < 0]
    verdict(not negative, f'{len(handovers)} handovers between processes, every one after the previous '
            f'holder had stopped (smallest gap {min(h["gap_ms"] for h in handovers)} ms)')
    return per


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--work-dir', required=True, type=pathlib.Path)
    parser.add_argument('--pg-bin', default=os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
    parser.add_argument('--engine-dist', type=pathlib.Path, default=REPO / 'server' / 'dist')
    parser.add_argument('--pg-port', type=int, default=55491)
    parser.add_argument('--shim-ports', default='55501,55502')
    args = parser.parse_args()
    work = args.work_dir.resolve()
    if work.exists() and any(work.iterdir()):
        raise SystemExit(f'{work} is not empty; give the probe an empty directory')
    work.mkdir(parents=True, exist_ok=True)
    for module in ('tableLease.js', 'tournamentLease.js', 'leadership.js'):
        if not (args.engine_dist / 'services' / module).exists():
            raise SystemExit(f'build the engine first: {args.engine_dist}/services/{module} is missing')
    version = subprocess.run([f'{args.pg_bin}/postgres', '--version'], text=True, capture_output=True).stdout
    if ' 17.' not in version:
        raise SystemExit(f'PostgreSQL 17 is required, found {version.strip()}')
    SUMMARY.update(started=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), postgres=version.strip(),
                   node=subprocess.run(['node', '--version'], text=True, capture_output=True).stdout.strip(),
                   engine_dist=str(args.engine_dist),
                   engine_commit=subprocess.run(['git', '-C', str(REPO), 'rev-parse', 'HEAD'], text=True,
                                                capture_output=True).stdout.strip())
    cluster = Cluster(args.pg_bin, work, args.pg_port)
    shims = []
    try:
        cluster.start()
        cluster.psql(file=ASSETS / 'isolated-schema.sql')
        cluster.psql(file=ASSETS / 'live-doors.sql')
        cluster.psql(file=ASSETS / 'isolated-doors.sql')
        fidelity(cluster)
        fleet = seed_fleet(cluster)
        SUMMARY['fleet'] = {'cash_tables': {a: sum(1 for t in fleet['tables'] if not t['tournamentId'] and t['asset'] == a)
                                            for a in ('chips', 'diamonds')},
                            'tournaments': {a: sum(1 for t in fleet['tournaments'] if t['asset'] == a)
                                            for a in ('chips', 'diamonds')},
                            'tournament_tables': sum(1 for t in fleet['tables'] if t['tournamentId'])}
        port_a, port_b = (int(p) for p in args.shim_ports.split(','))
        shim_a, shim_b = Shim('A', port_a, cluster, work), Shim('B', port_b, cluster, work)
        shims = [shim_a, shim_b]
        run_scenarios(cluster, fleet, work, args.engine_dist, shim_a, shim_b)
        busy_settlement(cluster)
        analyse(cluster, fleet, work, KILLS)
    finally:
        for engine in ENGINES:
            engine.supervise = False
            if engine.alive():
                engine.proc.kill()
        for shim in shims:
            shim.stop()
        cluster.stop()
        (work / 'summary.json').write_text(json.dumps(SUMMARY, indent=2, default=str) + '\n')
    print(json.dumps({k: SUMMARY[k] for k in ('fleet', 'hands', 'handovers', 'late_writes_after_partition')
                      if k in SUMMARY}, indent=2, default=str))
    if FAILURES:
        print(f'{len(FAILURES)} FAILED', flush=True)
        sys.exit(1)
    print('TWO-ENGINE OWNERSHIP PROBE PASSED', flush=True)


if __name__ == '__main__':
    main()
