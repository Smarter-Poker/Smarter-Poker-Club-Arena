#!/usr/bin/env python3
"""Test the installed MTT percentage generator in a private PostgreSQL 17 cluster.

Accepts no database URL. This proves the percentage ladder, not money allocation,
funding, finalization, payment, or production deployment.
"""
from pathlib import Path
import json
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[2]
capture = repo / 'scripts/dev/fixtures/heads-up-funding/dependencies.json'
signature = 'fn_ca_payout_structure(integer,integer)'
expected_md5 = '869a4e87108481934c4cdb985d489051'
sources = [row for row in json.loads(capture.read_text()) if row['signature'] == signature]
assert len(sources) == 1 and sources[0]['body_md5'] == expected_md5
configured = os.environ.get('POKER_AUDIT_PG_BIN') or os.environ.get('PGBIN')
pg = Path(configured) if configured else Path(subprocess.check_output(
    ['brew', '--prefix', 'postgresql@17'], text=True).strip()) / 'bin'
# Short prefix keeps macOS's Unix-domain socket path within its 103-byte limit.
root = Path(tempfile.mkdtemp(prefix='ca-ps-'))
cluster, sock = root / 'db', root / 's'
sock.mkdir()
port = str(35000 + os.getpid() % 10000)
env = dict(os.environ, PGHOST=str(sock), PGHOSTADDR='', PGPORT=port,
           PGUSER='payout_structure_test', PGDATABASE='postgres')
passed = []
started = False
with (root / 'results.log').open('w') as log:
    def command(args):
        subprocess.run(args, stdout=log, stderr=log, check=True, timeout=40)
        log.flush()

    def q(sql):
        # A file-backed input cannot deadlock while psql emits many notices.
        with tempfile.TemporaryFile(mode='w+') as request:
            request.write(sql + '\n')
            request.seek(0)
            result = subprocess.run(
                [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'],
                stdin=request, capture_output=True, text=True, env=env, timeout=60)
        log.write(result.stdout + result.stderr)
        log.flush()
        assert result.returncode == 0, result.stderr
        return result.stdout.strip()

    def check(name):
        passed.append(name)
        print('PASS ' + name, flush=True)

    try:
        version = subprocess.check_output([str(pg / 'postgres'), '--version'], text=True)
        assert ' 17.' in version, version
        command([str(pg / 'initdb'), '-D', str(cluster), '-U', 'payout_structure_test',
                 '--auth=trust', '--no-locale'])
        command([str(pg / 'pg_ctl'), '-D', str(cluster), '-o',
                 f'-k {sock} -p {port} -c listen_addresses=', '-w', 'start'])
        started = True
        q(sources[0]['definition'] + ';')
        actual = q("SELECT md5(prosrc) FROM pg_proc WHERE oid='" + signature + "'::regprocedure;")
        assert actual == expected_md5, (actual, expected_md5)
        check('installed payout generator body matches the September 13 production authority')

        q("""DO $$ DECLARE n int; p int; ladder jsonb; expected int; BEGIN
          FOREACH n IN ARRAY ARRAY[1,2,3,6,9,10,11,19,20,21,25,60,100,167,334,500,1000,9999,10000] LOOP
            FOREACH p IN ARRAY ARRAY[10,15,20] LOOP
              ladder := fn_ca_payout_structure(n,p);
              expected := ceil(n*p/100.0)::int;
              IF jsonb_array_length(ladder) <> expected THEN
                RAISE EXCEPTION 'wrong paid depth for % entrants / % percent',n,p;
              END IF;
              IF ladder IS DISTINCT FROM fn_ca_payout_structure(n,p) THEN
                RAISE EXCEPTION 'percentage generation changed on replay';
              END IF;
            END LOOP;
          END LOOP;
          IF fn_ca_payout_structure(0,10) <> '[]'::jsonb
             OR fn_ca_payout_structure(-1,10) <> '[]'::jsonb
             OR fn_ca_payout_structure(NULL,10) <> '[]'::jsonb THEN
            RAISE EXCEPTION 'an empty field received a payout ladder';
          END IF;
          FOREACH p IN ARRAY ARRAY[NULL,0,-1,14,100] LOOP
            IF fn_ca_payout_structure(334,p) <> fn_ca_payout_structure(334,10) THEN
              RAISE EXCEPTION 'unsupported payout percent did not use the installed default';
            END IF;
          END LOOP;
        END $$;""")
        check('10/15/20 percent depths, replay, small fields and installed fallback semantics')

        # The function depends only on the paid depth after its first calculation.
        # 20% of 5*n spans every depth through the creators' 10,000-player ceiling.
        for first in range(1, 2001, 100):
            last = min(2000, first + 99)
            q(f"""DO $$ DECLARE n int; ladder jsonb; BEGIN
              FOR n IN {first}..{last} LOOP
                ladder := fn_ca_payout_structure(n*5,20);
                IF jsonb_array_length(ladder) <> n OR EXISTS (
                  SELECT 1 FROM (
                    SELECT (entry->>'place')::int place, ord,
                      (entry->>'percentage')::numeric pct,
                      lag((entry->>'percentage')::numeric) OVER (ORDER BY ord) prev
                    FROM jsonb_array_elements(ladder) WITH ORDINALITY a(entry,ord)
                  ) s WHERE place <> ord OR pct <= 0 OR pct > prev OR pct*100 <> trunc(pct*100)
                ) OR (SELECT sum((entry->>'percentage')::numeric)
                      FROM jsonb_array_elements(ladder) entry) <> 100 THEN
                  RAISE EXCEPTION 'invalid or inverted ladder at paid depth %: %',n,ladder;
                END IF;
              END LOOP;
            END $$;""")
            check(f'paid depths {first}-{last}: positive, ordered, consecutive, exact 100 percent')
    finally:
        if started:
            subprocess.run([str(pg / 'pg_ctl'), '-D', str(cluster), '-m', 'fast', '-w', 'stop'],
                           stdout=log, stderr=log, check=True, timeout=30)
        shutil.rmtree(cluster, ignore_errors=True)

(root / 'results.json').write_text(json.dumps({
    'passed': passed, 'body_md5': expected_md5, 'source': str(capture.relative_to(repo)),
    'production_database_used': False, 'paid_depths_checked': 2000,
    'scope': 'Installed percentage generation only; no money or lifecycle writes.'
}, indent=2) + '\n')
print(f'{len(passed)} groups passed; evidence: {root / "results.json"}')
