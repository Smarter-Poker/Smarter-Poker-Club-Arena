"""Run one source-bound native fixture using an owned workspace socket directory."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import re
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--fixture', required=True, type=Path)
parser.add_argument('--candidate', required=True, type=Path)
parser.add_argument('--work-root', type=Path)
parser.add_argument('--pg-bin', type=Path, default=Path(os.environ.get('PG_BIN', '/opt/homebrew/bin')))
args = parser.parse_args()
fixture = args.fixture.read_text()
candidate = args.candidate.read_text()
pattern = r'CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\([^;]*?\s+AS\s+(\$[^$]*\$)(.*?)\2;'
def bodies(sql):
    return {m.group(1): m.group(3) for m in re.finditer(pattern, sql, re.S | re.I)}
candidate_bodies = bodies(candidate)
fixture_bodies = bodies(fixture)
matched = []
for name, body in fixture_bodies.items():
    if name in candidate_bodies:
        if body != candidate_bodies[name]:
            raise SystemExit('Fixture does not test the candidate postimage: ' + name)
        matched.append(name)
if not matched:
    raise SystemExit('Fixture has no candidate source binding')
# Bind additive RLS and immutable storage schemas too; source-equivalent functions alone do not prove a policy.
policies = re.findall(r'CREATE POLICY ([a-z0-9_]+)\b[^;]*;', fixture, re.S | re.I)
for name in policies:
    pattern_policy = r'CREATE POLICY ' + re.escape(name) + r'\b[^;]*;'
    current = re.search(pattern_policy, candidate, re.S | re.I)
    tested = re.search(pattern_policy, fixture, re.S | re.I)
    if (name.startswith('launch_') and current is None) or (current and re.sub(r'\s+', ' ', current.group(0)).strip() != re.sub(r'\s+', ' ', tested.group(0)).strip()):
        raise SystemExit('Fixture does not test the candidate policy: ' + name)
for name in re.findall(r'CREATE TABLE public\.(ca_launch_accounting_[a-z0-9_]+|ca_launch_profile_hand_baselines)\b', fixture, re.I):
    pattern_table = r'CREATE TABLE public\.' + re.escape(name) + r'\b[^;]*;'
    current = re.search(pattern_table, candidate, re.S | re.I)
    tested = re.search(pattern_table, fixture, re.S | re.I)
    if current is None or re.sub(r'\s+', ' ', current.group(0)).strip() != re.sub(r'\s+', ' ', tested.group(0)).strip():
        raise SystemExit('Fixture does not test the candidate storage schema: ' + name)

# Default is the fixture's owned workspace directory, never the system temp directory.
parent = args.work_root or args.fixture.resolve().parent
parent.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='lac-', dir=parent) as folder:
    root = Path(folder)
    socket = root / 's'
    socket.mkdir(mode=0o700)
    data = root / 'data'
    env = dict(os.environ, PGHOST=str(socket), PGUSER='fixture', PGDATABASE='postgres', PGPORT='5432')
    def run(command, sql=None):
        result = subprocess.run([str(x) for x in command], input=sql, text=True, capture_output=True, env=env, timeout=60)
        if result.returncode:
            raise RuntimeError(result.stderr)
        return result.stdout
    run([args.pg_bin/'initdb', '-D', data, '-U', 'fixture', '--auth-local=trust', '--auth-host=reject', '--no-locale'])
    with (data/'postgresql.conf').open('a') as config:
        config.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) + "'\n")
    started = False
    try:
        run([args.pg_bin/'pg_ctl', '-D', data, '-l', root/'server.log', '-w', 'start'])
        started = True
        output = run([args.pg_bin/'psql', '-X', '-v', 'ON_ERROR_STOP=1'], fixture)
        print(json.dumps({'native_fixture': 'passed', 'fixture': args.fixture.name,
            'fixture_sha256': hashlib.sha256(fixture.encode()).hexdigest(),
            'candidate_sha256': hashlib.sha256(candidate.encode()).hexdigest(),
            'bound_postimages': sorted(matched), 'production_installation': False}))
    finally:
        if started:
            run([args.pg_bin/'pg_ctl', '-D', data, '-m', 'immediate', '-w', 'stop'])
