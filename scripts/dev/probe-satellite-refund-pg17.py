#!/usr/bin/env python3
"""Reproduce the installed ticket outcome and verify the approved cash correction.

Always creates its own local PostgreSQL 17 cluster. It accepts no database URL
and never connects to production. Fixture limits are recorded in README.md.
"""
from pathlib import Path
import importlib.util
import json
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[2]
fixture = repo / 'scripts/dev/fixtures/satellite-refund'
migration = repo / 'supabase/migrations/20260909222303_satellite_unregister_returns_its_funded_cash.sql'
start_migrations = list((repo / 'supabase/migrations').glob('*_seat_first_unregistration_uses_actual_start_truth.sql'))
assert len(start_migrations) == 1, 'Expected one recorded actual-start migration'
pending = start_migrations[0]
configured = os.environ.get('POKER_AUDIT_PG_BIN')
pg = Path(configured) if configured else Path(subprocess.check_output(
    ['brew', '--prefix', 'postgresql@17'], text=True).strip()) / 'bin'
root = Path(tempfile.mkdtemp(prefix='ca-satellite-refund-pg17-'))
cluster, socket = root / 'cluster', root / 'socket'
socket.mkdir()
port = str(35000 + os.getpid() % 10000)
passed = []
started = False

with (root / 'results.log').open('w') as log:
    def run(cmd):
        result = subprocess.run(cmd, stdout=log, stderr=log, text=True, timeout=30)
        log.flush()
        if result.returncode:
            raise AssertionError('Command failed; see ' + str(root / 'results.log'))

    def sql(body):
        run(args + ['-c', body])

    def load(path):
        run(args + ['-f', str(path)])

    def fresh(name):
        global args
        run([str(pg/'createdb'), '-h', str(socket), '-p', port, name])
        args = [str(pg/'psql'), '-h', str(socket), '-p', port, '-d', name,
                '-X', '-qAt', '-v', 'ON_ERROR_STOP=1']
        load(fixture/'fixture.sql')

    def check(name):
        passed.append(name)
        print('PASS ' + name, flush=True)

    try:
        version = subprocess.check_output([str(pg/'postgres'), '--version'], text=True)
        assert ' 17.' in version, version
        run([str(pg/'initdb'), '-D', str(cluster), '--auth=trust', '--no-locale'])
        run([str(pg/'pg_ctl'), '-D', str(cluster), '-o',
             f'-k {socket} -p {port} -c listen_addresses=', '-w', 'start'])
        started = True

        fresh('baseline')
        # Keep only this disposable baseline outcome for migration/replay proof.
        baseline = (fixture/'probe.sql').read_text()
        assert baseline.endswith('ROLLBACK;\n')
        sql("SET test.expect_cash='false';\n" + baseline.removesuffix('ROLLBACK;\n') + 'COMMIT;')
        check('installed code returns a ticket instead of the approved cash')
        load(migration)
        load(fixture/'legacy-check.sql')
        check('historical ticket receipt survives and cannot fund a second refund')

        for case in ['probe', 'wallet_probe', 'ticket_probe']:
            fresh(case)
            load(migration)
            run(args + ['-c', "SET test.expect_cash='true'", '-f', str(fixture/(case+'.sql'))])
            check({'probe':'cash provenance, refusals, replay, fees and escrow',
                   'wallet_probe':'ordinary wallet-funded entry remains correct',
                   'ticket_probe':'redeemed-ticket funding returns cash once'}[case])

        fresh('concurrency')
        load(migration)
        seed = (fixture/'probe.sql').read_text().split('DO $hostile$')[0] + '\nCOMMIT;'
        sql(seed)
        spec = importlib.util.spec_from_file_location('refund_concurrency', fixture/'concurrency.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.verify(args, log)
        check('late receipt failure rolls back wallet and all financial receipts')
        check('observed overlapping requests commit one refund and one replay')

        # The actual-start migration is now installed in production. Execute
        # its recorded receipt/core definitions on the changed row shape.
        # Empty hand/launch read fixtures isolate this cash-compatibility check;
        # their unrelated settlement and scheduling behavior is not certified.
        fresh('pending_start')
        sql("ALTER TABLE public.tournament_unregistration_receipts ADD COLUMN start_authority text NOT NULL DEFAULT 'scheduled_clock'; CREATE TABLE public.hand_history(id uuid,tournament_id uuid,table_id uuid); CREATE TABLE public.tournament_launch_receipts(tournament_id uuid,completed_at timestamptz);")
        source = pending.read_text()
        for name, tag in [
            ('fn_ca_tournament_unregistration_receipt','actual_start_unregistration_receipt'),
            ('fn_ca_unregister_tournament_player_exact','actual_start_unregister_core'),
        ]:
            start = source.index('CREATE OR REPLACE FUNCTION public.' + name + '(')
            delimiter = '$' + tag + '$'
            body_start = source.index(delimiter, start)
            end = source.index(delimiter + ';', body_start + len(delimiter)) + len(delimiter) + 1
            sql(source[start:end])
        load(migration)
        load(migration)  # Required clean-replay boundary, not an extra business test.
        run(args + ['-c', "SET test.expect_cash='true'", '-f', str(fixture/'probe.sql')])
        check('installed start migration and later replay preserve the cash correction')
    finally:
        if started:
            subprocess.run([str(pg/'pg_ctl'), '-D', str(cluster), '-m', 'fast', '-w', 'stop'],
                           stdout=log, stderr=log, check=True, timeout=15)
        shutil.rmtree(cluster, ignore_errors=True)

(root/'results.json').write_text(json.dumps({'passed':passed,'production_database_used':False}, indent=2)+'\n')
print(str(len(passed)) + ' scenario groups passed; evidence: ' + str(root/'results.json'))
