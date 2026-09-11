#!/usr/bin/env python3
"""Exercise the existing rebuy-window SQL in owned, offline PostgreSQL 17.

This qualifies the client-visible window policy only. It does not replace the
canonical purchase, accepted-knockout, funding or seat-generation authorities.
The function is loaded unchanged from its committed migration. The fixture
projects just the tournament columns read by that function; no financial source
or production connection is accepted by this runner.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin', type=Path, default=Path('/opt/homebrew/opt/postgresql@17/bin'))
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    pg = args.pg_bin.resolve()
    version = subprocess.check_output([str(pg / 'postgres'), '--version'], text=True).strip()
    if not version.startswith('postgres (PostgreSQL) 17.'):
        raise ValueError('PostgreSQL 17 is required')
    source = root / 'supabase/migrations/20260909014433_spin_reserve_settlement_commits_its_journal_or_nothing.sql'
    match = re.search(
        r'CREATE OR REPLACE FUNCTION public\.fn_ca_tournament_rebuy_window\(.*?'
        r'AS \$tournament_rebuy_window\$(.*?)\$tournament_rebuy_window\$;',
        source.read_text(), re.S)
    if not match:
        raise ValueError('The canonical rebuy-window definition is missing')
    function = match.group(0)
    work = root / 'work'
    work.mkdir(exist_ok=True)
    owned = Path(tempfile.mkdtemp(prefix='rebuy-window-', dir=work))
    socket = Path(tempfile.mkdtemp(prefix='ca-rebuy-socket-'))
    env = {key: value for key, value in os.environ.items() if not key.startswith('PG')}
    env['PGTZ'] = 'UTC'
    env['LC_ALL'] = 'C'

    def run(command):
        result = subprocess.run(command, env=env, text=True, capture_output=True, timeout=60)
        if result.returncode:
            raise RuntimeError((result.stderr or result.stdout)[-3000:])
        return result.stdout

    sql_command = [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                   '-h', str(socket), '-p', '55497', '-U', 'postgres', '-d', 'postgres']

    def query(sql):
        return run(sql_command + ['-c', sql]).strip()

    cases = [
        ('zero_rebuy_uses_late_registration', {'rebuy_levels': 0, 'late_reg_levels': 8}, True),
        ('null_rebuy_uses_late_registration', {'rebuy_levels': None, 'late_reg_levels': 8}, True),
        ('explicit_rebuy_cap_takes_priority', {'rebuy_levels': 2, 'late_reg_levels': 8}, False),
        ('fallback_cap_expires_at_boundary', {'rebuy_levels': 0, 'late_reg_levels': 2}, False),
        ('fallback_cap_beats_remaining_minutes', {'rebuy_levels': 0, 'late_reg_levels': 2, 'late_reg_mins': 60}, False),
        ('last_level_inside_fallback_cap', {'rebuy_levels': 0, 'late_reg_levels': 8, 'current_level': 7}, True),
        ('reentry_uses_same_fallback', {'is_rebuy': False, 'is_reentry': True, 'rebuy_levels': 0, 'late_reg_levels': 8}, True),
        ('positive_rebuy_cap', {'rebuy_levels': 8, 'late_reg_levels': 0}, True),
        ('timed_fallback', {'rebuy_levels': 0, 'late_reg_levels': 0, 'late_reg_mins': 10}, True),
        ('null_caps_use_timed_fallback', {'rebuy_levels': None, 'late_reg_levels': None, 'late_reg_mins': 10}, True),
        ('timed_fallback_expired', {'rebuy_levels': 0, 'late_reg_levels': 0, 'late_reg_mins': 1}, False),
        ('unconfigured_window', {'rebuy_levels': 0, 'late_reg_levels': 0}, False),
        ('triggered_addon_extends_closed_cap', {'rebuy_levels': 2, 'add_on_available': True, 'addon_period_triggered': True}, True),
        ('untriggered_addon_does_not_extend_cap', {'rebuy_levels': 2, 'add_on_available': True}, False),
        ('unavailable_addon_does_not_extend_cap', {'rebuy_levels': 2, 'addon_period_triggered': True}, False),
        ('finalized_pool_refuses', {'prize_pool_finalized': True}, False),
        ('nonrunning_event_refuses', {'status': 'COMPLETING'}, False),
        ('nonrebuy_event_refuses', {'is_rebuy': False}, False),
        ('unknown_level_refuses', {'current_level': None}, False),
        ('activated_addon_without_level', {'current_level': None, 'add_on_available': True, 'addon_period_triggered': True}, True),
    ]
    defaults = {'status': 'RUNNING', 'prize_pool_finalized': False,
                'is_rebuy': True, 'is_reentry': False, 'rebuy_levels': 8,
                'late_reg_levels': 0, 'current_level': 2, 'late_reg_mins': 0,
                'add_on_available': False, 'addon_period_triggered': False}

    def literal(value):
        if value is None:
            return 'NULL'
        if isinstance(value, bool):
            return str(value).lower()
        if isinstance(value, int):
            return str(value)
        return "'" + value.replace("'", "''") + "'"

    started = False
    try:
        run([str(pg / 'initdb'), '-D', str(owned / 'data'), '-U', 'postgres',
             '--auth-local=trust', '--auth-host=reject', '--no-locale', '-E', 'UTF8'])
        run([str(pg / 'pg_ctl'), '-D', str(owned / 'data'), '-l', str(owned / 'postgres.log'),
             '-o', "-h '' -k " + str(socket) + ' -p 55497', '-w', 'start'])
        started = True
        query('''CREATE TABLE public.tournaments (
          id uuid PRIMARY KEY, status text, prize_pool_finalized boolean,
          is_rebuy boolean, is_reentry boolean, rebuy_levels integer,
          late_reg_levels integer, current_level integer, late_reg_mins integer,
          add_on_available boolean, addon_period_triggered boolean,
          addon_period_started_at timestamptz, addon_period_ends_at timestamptz,
          started_at timestamptz);
          CREATE TABLE expected_windows(id uuid PRIMARY KEY, name text, expected boolean);''')
        query(function)
        native_md5 = query("SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_ca_tournament_rebuy_window(uuid)'::regprocedure")
        if native_md5 != hashlib.md5(match.group(1).encode()).hexdigest():
            raise AssertionError('Native function body differs from canonical source')
        for index, (name, fields, expected) in enumerate(cases, 1):
            row = {'id': '00000000-0000-4000-8000-' + f'{index:012d}', **defaults, **fields}
            query('INSERT INTO tournaments (' + ','.join(row) + ',started_at,addon_period_started_at,addon_period_ends_at) VALUES ('
                  + ','.join(literal(value) for value in row.values())
                  + ",clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 minute');"
                  + 'INSERT INTO expected_windows VALUES (' + literal(row['id']) + ',' + literal(name) + ',' + literal(expected) + ');')
        fingerprint = "SELECT md5(jsonb_agg(to_jsonb(t) ORDER BY id)::text) FROM tournaments t"
        before = query(fingerprint)
        read = "SELECT jsonb_agg(jsonb_build_object('name',e.name,'expectedOpen',e.expected,'result',public.fn_ca_tournament_rebuy_window(e.id)) ORDER BY e.id) FROM expected_windows e"
        first = json.loads(query(read))
        replay = json.loads(query(read))
        for attempt in (first, replay):
            for case in attempt:
                if case['result']['open'] is not case['expectedOpen']:
                    raise AssertionError(case)
        if before != query(fingerprint):
            raise AssertionError('The window read changed the tournament')
        receipt = {
            'status': 'passed', 'observedAt': datetime.now(timezone.utc).isoformat(),
            'postgres': version, 'scope': 'native rebuy-window policy; projected tournament fixture',
            'functionSource': str(source.relative_to(root)), 'functionBodyMd5': native_md5,
            'functionDefinitionSha256': hashlib.sha256(function.encode()).hexdigest(),
            'cases': first, 'caseCount': len(first), 'replayCount': len(replay),
            'unchangedTournamentRows': before, 'productionWrites': 0,
            'financialPurchaseQualification': False,
        }
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(receipt, indent=2) + '\n')
        print(json.dumps({'status': 'passed', 'cases': len(first), 'replays': len(replay),
                          'receipt': str(args.output.resolve())}))
    finally:
        if started:
            run([str(pg / 'pg_ctl'), '-D', str(owned / 'data'), '-m', 'fast', '-w', 'stop'])
        socket.rmdir()


if __name__ == '__main__':
    main()
