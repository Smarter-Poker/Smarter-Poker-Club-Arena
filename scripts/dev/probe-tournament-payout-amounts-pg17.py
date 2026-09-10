#!/usr/bin/env python3
"""Execute the captured installed cash ladder in its own PostgreSQL 17 cluster.

No database URL is accepted. Only synthetic tournament and roster input shapes
are installed; this proves amount derivation, not payment or lifecycle guards.
"""
from pathlib import Path
import json
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[2]
fixture = repo / 'scripts/dev/fixtures/tournament-payout-amounts'
configured = os.environ.get('POKER_AUDIT_PG_BIN') or os.environ.get('PGBIN')
pg = Path(configured) if configured else Path(subprocess.check_output(
    ['brew', '--prefix', 'postgresql@17'], text=True).strip()) / 'bin'
root = Path(tempfile.mkdtemp(prefix='ca-payout-amounts-pg17-'))
cluster, sock = root / 'cluster', root / 'socket'
sock.mkdir()
port = str(35000 + os.getpid() % 10000)
env = dict(os.environ, PGHOST=str(sock), PGHOSTADDR='', PGPORT=port,
           PGUSER='payout_test', PGDATABASE='postgres')
node = os.environ.get('PGNODE')
client = [node, str(repo / 'scripts/ci/probes/chip-journal-atomicity/postgres-runtime/registration-query.mjs')] if node else [
    str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1']
event = 'd3000000-0000-4000-8000-000000000001'
passed = []
started = False
with (root / 'results.log').open('w') as log:
    def command(args):
        subprocess.run(args, stdout=log, stderr=log, check=True, timeout=40)
        log.flush()

    def q(sql, error=None):
        result = subprocess.run(client, input=(json.dumps(sql) if node else sql) + '\n',
                                capture_output=True, text=True, env=env, timeout=15)
        log.write(result.stdout + result.stderr)
        log.flush()
        if error:
            assert result.returncode != 0 and error in result.stderr, result.stderr
        else:
            assert result.returncode == 0, result.stderr
        return result.stdout.strip()

    def literal(value):
        return "'" + str(value).replace("'", "''") + "'"

    def check(name, pool, shares, field, expected=None, bubble=False, buyin=100,
              error=None, variant='mtt'):
        q("TRUNCATE tournaments,tournament_players; INSERT INTO tournaments "
          "(id,prize_pool,payout_structure,variant,tournament_type,is_premium_spin,"
          "spin_multiplier,buy_in_amount,satellite_target_id,satellite_target,bubble_protection) VALUES ("
          + ','.join([literal(event),literal(pool),literal(json.dumps(shares)),
                       literal(variant),"'MTT'","false","NULL",literal(buyin),"NULL","NULL",
                       "true" if bubble else "false"]) + "); "
          + "INSERT INTO tournament_players(tournament_id) SELECT " + literal(event)
          + "::uuid FROM generate_series(1," + str(field) + ");")
        state = "SELECT jsonb_build_object('t',(SELECT jsonb_agg(t) FROM tournaments t),'p',(SELECT jsonb_agg(p) FROM tournament_players p));"
        before = q(state)
        query = "SELECT COALESCE(jsonb_agg(jsonb_build_array(place,amount) ORDER BY place),'[]'::jsonb) FROM public.fn_ca_tournament_place_amounts(" + literal(event) + ");"
        if error:
            q(query, error)
        else:
            first = json.loads(q(query))
            assert first == expected, (name, first, expected)
            assert json.loads(q(query)) == first, 'repeated derivation changed amounts'
        assert q(state) == before, 'amount derivation changed its input rows'
        passed.append(name)
        print('PASS ' + name, flush=True)

    try:
        version = subprocess.check_output([str(pg / 'postgres'), '--version'], text=True)
        assert ' 17.' in version, version
        command([str(pg / 'initdb'), '-D', str(cluster), '-U', 'payout_test', '--auth=trust', '--no-locale'])
        command([str(pg / 'pg_ctl'), '-D', str(cluster), '-o',
                 f'-k {sock} -p {port} -c listen_addresses=', '-w', 'start'])
        started = True
        q((fixture / 'fixture.sql').read_text())
        q((fixture / 'installed.sql').read_text())
        manifest = json.loads((fixture / 'source-manifest.json').read_text())
        actual = q("SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_ca_tournament_place_amounts(uuid)'::regprocedure;")
        assert actual == manifest['body_md5'], (actual, manifest['body_md5'])
        ladder = [dict(place=i+1, percentage=p) for i,p in enumerate([50,30,20])]
        nine = [dict(place=i+1, percentage=p) for i,p in enumerate([30,20,15,10,8,6,5,3.5,2.5])]
        check('513.00 pool allocates its exact final cent',513,nine,9,
              [[1,153.90],[2,102.60],[3,76.95],[4,51.30],[5,41.04],[6,30.78],[7,25.65],[8,17.96],[9,12.82]])
        check('bubble reserve leaves 900.00 for all places',1000,ladder,4,
              [[1,450],[2,270],[3,180]],bubble=True)
        check('disabled bubble reserves nothing',1000,ladder,4,[[1,500],[2,300],[3,200]])
        check('a fully paid field has no stone bubble reserve',1000,ladder,3,
              [[1,500],[2,300],[3,200]],bubble=True)
        check('one cent is spent once',0.01,ladder,3,[[1,0.01],[2,0],[3,0]])
        check('sparse final places preserve one bubble reserve',1000,
              [dict(place=1,percentage=60),dict(place=3,percentage=40)],4,
              [[1,540],[3,360]],bubble=True)
        check('duplicate places retain their first declared share',1000,
              [ladder[0],dict(place=1,percentage=99),*ladder[1:]],4,
              [[1,450],[2,270],[3,180]],bubble=True)
        check('short field normalizes surviving shares and final residual',100,nine,3,
              [[1,46.15],[2,30.77],[3,23.08]])
        check('zero pool derives zero amounts without a bubble promise',0,ladder,3,
              [[1,0],[2,0],[3,0]])
        check('unfundable bubble is refused',50,ladder,4,bubble=True,
              error='exceeds locked prize pool')
        check('fractional pool cent is refused',1000.001,ladder,4,
              error='invalid whole-cent prize pool')
        check('fractional bubble cent is refused',1000,ladder,4,bubble=True,buyin=100.001,
              error='invalid whole-cent buy-in')
        check('malformed ladder is refused',1000,[dict(place=1,percentage=-1)],4,
              error='no usable canonical payout ladder')
        check('empty roster is refused',1000,ladder,0,error='has no roster')
        check('satellite cash ladder is refused',1000,ladder,4,variant='satellite',
              error='is a satellite, not a cash ladder')
    finally:
        if started:
            subprocess.run([str(pg / 'pg_ctl'), '-D', str(cluster), '-m', 'fast', '-w', 'stop'],
                           stdout=log, stderr=log, check=True, timeout=15)
        shutil.rmtree(cluster, ignore_errors=True)
(root / 'results.json').write_text(json.dumps({
    'passed':passed,'body_md5':manifest['body_md5'],'production_database_used':False,
    'scope':'Installed amount derivation only; synthetic tournament and roster input tables.'
}, indent=2) + '\n')
print(str(len(passed)) + ' groups passed; evidence: ' + str(root / 'results.json'))
