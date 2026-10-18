"""Native PostgreSQL qualification of the complete event-owned recovery door."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def qualify(root, out, cmd, command, run, probe, require, results):
    here = root / 'scripts/ci/probes/f06-shared-hand-lane/abandoned-addon'
    migration = root / 'supabase/migrations/20261018152437_a_documented_addon_does_not_strand_an_abandoned_misdeal.sql'
    inputs = list(here.glob('*')) + [migration]
    results['abandonedAddonInputs'] = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
                                      for p in inputs if p.is_file()}
    run('addon-database', 'CREATE DATABASE abandoned_addon;')
    previous_db = cmd[-1]
    cmd[-1] = 'abandoned_addon'
    try:
        run('addon-fixture', (here / 'fixture.sql').read_text())
        run('addon-installed-preimage', (here / 'preimage.sql').read_text() + ";\nREVOKE ALL ON FUNCTION public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean) TO service_role;")
        seed = 'SELECT fixture_seed();'
        service = "SET request.jwt.claims='{\"role\":\"service_role\"}'; SET app.smarter_data_actor='tournament-manager';"
        call = "public.fn_f06_abort_abandoned_generation(md5('addon-event')::uuid,md5('old-generation')::uuid,md5('addon-receipt')::uuid,'native qualification of exact purchased addon recovery',false)"
        money = "SELECT jsonb_build_object('seats',(SELECT jsonb_agg(s ORDER BY id) FROM table_seats s),'registrations',(SELECT jsonb_agg(p ORDER BY id) FROM tournament_players p),'leases',(SELECT jsonb_agg(l) FROM engine_tournament_leases l));"
        run('addon-seed', seed)
        before = run('addon-player-state-before', money)
        probe('addon-fails-before', service + 'SELECT ' + call + ';', error='F06_ABANDONED_CARDS_WITHOUT_SNAPSHOT')
        probe('addon-unknown-preimage-refused', "ALTER FUNCTION public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean) SET search_path=public;\n" + migration.read_text().replace('BEGIN;', '').replace('COMMIT;', ''), error='ABANDONED_ADDON_PREIMAGE_DRIFT')
        run('addon-install', migration.read_text())
        probe('addon-replay-install-refused', migration.read_text().replace('BEGIN;', '').replace('COMMIT;', ''), error='ABANDONED_ADDON_PREIMAGE_DRIFT')
        success = service + 'SELECT (' + call + ")->>'misdeals_voided';"
        probe('addon-exact-purchase-passes', success, '1')
        probe('addon-unchanged-stacks-pass', "UPDATE table_seats SET stack=3000; UPDATE tournament_players SET chips=3000,add_on=false;" + success, '1')
        for name, change, error in [
            ('unpurchased', 'UPDATE tournament_players SET add_on=false;', 'F06_ABANDONED_CARDS_WITHOUT_SNAPSHOT'),
            ('wrong-delta', 'UPDATE table_seats SET stack=13001; UPDATE tournament_players SET chips=13001;', 'F06_ABANDONED_CARDS_WITHOUT_SNAPSHOT'),
            ('double-addon', 'UPDATE table_seats SET stack=23000; UPDATE tournament_players SET chips=23000;', 'F06_ABANDONED_CARDS_WITHOUT_SNAPSHOT'),
            ('zero-addon', 'UPDATE tournaments SET addon_chips=0;', 'F06_ABANDONED_CARDS_WITHOUT_SNAPSHOT'),
            ('roster-mismatch', 'UPDATE tournament_players SET chips=13001;', 'F06_ABANDONED_ROSTER_CHANGED'),
            ('unknown-card', "INSERT INTO table_hole_cards VALUES(md5('addon-table')::uuid,11,md5('unknown')::uuid);", 'F06_ABANDONED_CARDS_WITHOUT_SNAPSHOT'),
            ('retained-submission', "INSERT INTO smarter_private.hand_submissions VALUES(md5('addon-table')::uuid,11);", 'F06_ABANDONED_HAND_HAS_A_RETAINED_SUBMISSION'),
            ('accepted-hand', "INSERT INTO hand_atomic_commits VALUES(md5('addon-table')::uuid,11);", 'F06_ABORT_COMMITTED_OR_DISPATCHED'),
            ('live-generation', "UPDATE engine_tournament_leases SET lease_generation=md5('old-generation')::uuid;", 'F06_GENERATION_STILL_LIVE'),
        ]:
            probe('addon-' + name + '-refused', change + service + 'SELECT ' + call + ';', error=error)
        probe('addon-browser-refused', "SET request.jwt.claims='{\"role\":\"authenticated\"}'; SELECT " + call + ';', error='F06_ABANDONED_SERVICE_REQUIRED')
        run('addon-commit-local', service + 'SELECT (' + call + ")->>'misdeals_voided';", '1')
        run('addon-identical-receipt-replays', service + 'SELECT (' + call + ")->>'replayed';", 'true')
        run('addon-permit-fenced', "SELECT state||'|'||(evidence_id=md5('addon-receipt')::uuid)::text FROM smarter_private.f06_hand_permits;", 'aborted_unsettled|true')
        require(run('addon-player-state-after', money) == before, 'Recovery changed chips, registration or current lease')
        results['abandonedAddon'] = {'passed': True, 'scope': 'Complete recovery function, minimal native dependencies; no production financial effects'}
    finally:
        cmd[-1] = previous_db


if __name__ == '__main__':
    root = Path(__file__).resolve().parents[5]
    out = Path(os.environ['ADDON_EVIDENCE']).resolve()
    out.mkdir(parents=True, exist_ok=False)
    pg = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
    cluster = Path(tempfile.mkdtemp(prefix='addon-', dir=os.environ['TMPDIR']))
    socket = cluster / 's'
    socket.mkdir(mode=0o700)
    env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
    env['LC_ALL'] = 'C'
    cmd = [str(pg/'psql'), '-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', str(socket), '-p', '55697', '-U', 'postgres', '-d', 'postgres']
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
            f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(socket)+"'\nport=55697\nshared_buffers='16MB'\n")
        r = command([pg/'pg_ctl', '-D', cluster/'d', '-l', cluster/'pg.log', '-w', 'start'])
        require(r.returncode == 0, r.stderr)
        run('addon-roles', 'CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;')
        qualify(root, out, cmd, command, run, probe, require, results)
        results['passed'] = True
    finally:
        command([pg/'pg_ctl', '-D', cluster/'d', '-m', 'immediate', '-w', 'stop'])
        (out/'result.json').write_text(json.dumps(results, indent=2)+'\n')
        shutil.rmtree(cluster)
