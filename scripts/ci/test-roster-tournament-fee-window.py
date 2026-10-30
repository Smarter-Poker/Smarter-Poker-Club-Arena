#!/usr/bin/env python3
"""Private PG17 physical-index qualification; never connects to production.

Uses the retained fee reader's exact mtt_edges SELECT and source table columns,
constraints and indexes. The FK parent and maintenance/source guards are inert
native adapters. No gameplay, fee recognition or settlement is certified here.
"""
import argparse
from decimal import Decimal
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'scripts/ci/fixtures/roster-tournament-fee-window'
INDEX = 'accounting_tournament_member_charged_cover'


def lit(value):
    return "'" + str(value).replace("'", "''") + "'"


def nodes(plan):
    yield plan
    for child in plan.get('Plans', []):
        yield from nodes(child)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin', type=Path, required=True)
    parser.add_argument('--scratch', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    assert __debug__ and args.scratch.is_dir() and not args.output.exists()
    work = Path(tempfile.mkdtemp(prefix='rfee-', dir=args.scratch.resolve()))
    assert len(str(work).encode()) < 90
    data = work / 'data'
    started = False
    env = {key: value for key, value in os.environ.items() if not key.startswith('PG')}
    env.update(TMPDIR=str(work), TMP=str(work), TEMP=str(work), LC_ALL='C')
    psql = [args.pg_bin / 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', work,
            '-U', 'postgres', '-d', 'postgres']

    def run(command, sql=None, error=None):
        result = subprocess.run(list(map(str, command)), input=sql, text=True,
                                capture_output=True, env=env, timeout=120)
        if error:
            assert result.returncode != 0 and error in result.stderr, result.stderr
        else:
            assert result.returncode == 0, (result.stdout[-2000:], result.stderr[-6000:])
        return result.stdout.strip()

    def q(sql, error=None):
        return run(psql, sql, error)

    authority = json.loads((FIXTURE / 'authority.json').read_text())
    manifest = json.loads((FIXTURE / 'manifest.json').read_text())
    migration = (ROOT / manifest['migration']).read_text()
    preamble, body = migration.split('BEGIN;', 1)
    body = 'BEGIN;' + body
    cases = []
    plans = []
    try:
        assert ' 17.' in run([args.pg_bin / 'postgres', '--version'])
        run([args.pg_bin / 'initdb', '-D', data, '-U', 'postgres', '--auth-local=trust',
             '--auth-host=reject', '--no-locale', '-E', 'UTF8'])
        with (data / 'postgresql.conf').open('a') as config:
            config.write("\nlisten_addresses=''\nunix_socket_directories='" + str(work) +
                         "'\nshared_buffers='16MB'\nwork_mem='16MB'\nmaintenance_work_mem='32MB'\n")
        run([args.pg_bin / 'pg_ctl', '-D', data, '-l', work / 'server.log', '-w', 'start'])
        started = True
        q('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;'
          'CREATE SCHEMA smarter_private;'
          'CREATE TABLE accounting_tournament_fee_batches(rake_record_id uuid PRIMARY KEY);')
        columns = [column['name'] + ' ' + column['type'] +
                   (' NOT NULL' if column['not_null'] else '') +
                   (' DEFAULT ' + column['default'] if column['default'] else '')
                   for column in authority['columns']]
        q('CREATE TABLE accounting_tournament_fee_sources(' + ','.join(columns) + ');')
        for constraint in authority['constraints']:
            q('ALTER TABLE accounting_tournament_fee_sources ADD CONSTRAINT ' +
              constraint['name'] + ' ' + constraint['definition'] + ';')
        for index in authority['indexes']:
            name = re.search(r'INDEX (\w+)', index).group(1)
            if q('SELECT to_regclass(' + lit(name) + ') IS NULL') == 't':
                q(index + ';')
        q('ALTER TABLE accounting_tournament_fee_sources ENABLE ROW LEVEL SECURITY;'
          'GRANT SELECT ON accounting_tournament_fee_sources TO service_role;'
          "CREATE FUNCTION smarter_private.original_inventory_proof_sources_match() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;"
          "CREATE FUNCTION smarter_private.original_inventory_basis_generation() RETURNS text LANGUAGE sql STABLE AS $$SELECT 'native-index-only'::text$$;"
          "CREATE FUNCTION fn_ca_break_window_refuses_migrations(timestamptz) RETURNS text LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('native.refusal',true),'')$$;"
          "CREATE FUNCTION fn_platform_frozen() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT coalesce(current_setting('native.frozen',true),'off')='on'$$;"
          "CREATE FUNCTION fn_active_maintenance_release_boundary() RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT NULL::timestamptz$$;")
        q('SET check_function_bodies=off;' + authority['reader'] + ';')
        # Same physical width and long histories that made the live boundary read
        # walk the player's lifetime. Synthetic keys never leave this cluster.
        q("INSERT INTO accounting_tournament_fee_batches SELECT md5('batch-'||g)::uuid FROM generate_series(1,100000)g;"
          "INSERT INTO accounting_tournament_fee_sources SELECT md5('fee-'||g)::uuid,md5('batch-'||g)::uuid,md5('event')::uuid,md5('player-'||(g%100))::uuid,md5('club')::uuid,NULL,NULL,'NLH',md5('reg-'||g)::uuid,md5('ledger-'||g)::uuid,md5('ent-'||g)::uuid,'2026-01-01Z'::timestamptz+(g%200)*interval '1 day',1.23,jsonb_build_object('retained',repeat(md5(g::text),30)),transaction_timestamp() FROM generate_series(1,100000)g;")
        # Both inclusive lower and exclusive upper boundaries, another club and
        # a member not requested. Zero is a real fee value, never filtered out.
        q("INSERT INTO accounting_tournament_fee_batches SELECT md5('edge-'||g)::uuid FROM generate_series(1,8)g;"
          "INSERT INTO accounting_tournament_fee_sources SELECT md5('edge-fee-'||g)::uuid,md5('edge-'||g)::uuid,md5('edge-event')::uuid,md5('player-'||CASE WHEN g=8 THEN 100 ELSE 0 END)::uuid,md5(CASE WHEN g=7 THEN 'other-club' ELSE 'club' END)::uuid,NULL,NULL,'NLH',md5('edge-reg-'||g)::uuid,md5('edge-ledger-'||g)::uuid,md5('edge-ent-'||g)::uuid,(ARRAY['2026-10-26 00:00Z','2026-10-26 04:59:59.999999Z','2026-10-26 05:00Z','2026-10-30 15:00Z','2026-10-31 00:00Z','2026-10-30 23:59:59.999999Z','2026-10-26 00:00Z','2026-10-26 00:00Z']::timestamptz[])[g],CASE WHEN g=2 THEN 0 ELSE g::numeric/100 END,'{}',transaction_timestamp() FROM generate_series(1,8)g;")
        q('VACUUM ANALYZE accounting_tournament_fee_sources;')
        reader = authority['reader']
        edge = reader.split('mtt_edges AS (', 1)[1].split('), amounts AS (', 1)[0]
        query = "WITH wanted AS MATERIALIZED(SELECT md5('player-'||g)::uuid uid FROM generate_series(0,99)g),b AS MATERIALIZED(SELECT md5('club')::uuid club,'2026-10-26 00:00Z'::timestamptz us,'2026-10-26 05:00Z'::timestamptz s,'2026-10-30 15:00Z'::timestamptz e,'2026-10-31 00:00Z'::timestamptz ue),mtt_edges AS (" + edge.replace('p_club_id', '(SELECT club FROM b)') + ') SELECT * FROM mtt_edges ORDER BY uid'
        original = q(query)
        actual_uid, actual_amount = original.split('|')
        assert actual_uid == q("SELECT md5('player-0')::uuid") and Decimal(actual_amount) == Decimal('-0.11'), original
        before = json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)' + query))
        before_nodes = list(nodes(before[0]['Plan']))
        assert any(node.get('Relation Name') == 'accounting_tournament_fee_sources' for node in before_nodes), before
        assert sum(node.get('Rows Removed by Join Filter', 0) * node.get('Actual Loops', 1) for node in before_nodes) >= 100000
        fingerprint = q("SELECT md5(string_agg(to_jsonb(t)::text,'' ORDER BY id)) FROM accounting_tournament_fee_sources t")
        q(preamble)
        q(body)
        after = json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)' + query))
        scans = [node for node in nodes(after[0]['Plan']) if node.get('Index Name') == INDEX]
        assert scans and all(node['Node Type'] == 'Index Only Scan' for node in scans), scans
        assert all('charged_at' in node.get('Index Cond', '') for node in scans), scans
        assert q(query) == original
        assert q("SELECT md5(string_agg(to_jsonb(t)::text,'' ORDER BY id)) FROM accounting_tournament_fee_sources t") == fingerprint
        cases += ['exact_retained_reader_100_member_before_after_same_boundary_totals',
                  'natural_index_only_scan_bounds_charged_time', 'all_source_rows_unchanged']
        plans = [before, after]
        oid = q('SELECT ' + lit(INDEX) + '::regclass::oid')
        q(preamble)
        q(body)
        assert q('SELECT ' + lit(INDEX) + '::regclass::oid') == oid
        q("BEGIN;UPDATE pg_index SET indisvalid=false WHERE indexrelid=" + lit(INDEX) + '::regclass;' + body, 'exact_catalog_required')
        q(body)
        q("BEGIN;SET LOCAL native.frozen='on';" + body, 'window_refused')
        q(body)
        changed_reader = reader.replace('p_from IS NULL', 'p_from IS NOT NULL')
        assert changed_reader != reader
        q('BEGIN;SET LOCAL check_function_bodies=off;' + changed_reader + ';' + body, 'reader_changed')
        q(body)
        q('DROP INDEX ' + INDEX + ';CREATE INDEX ' + INDEX +
          ' ON accounting_tournament_fee_sources(club_id,player_id) INCLUDE(charged_at,rake_credit);')
        q(body, 'exact_catalog_required')
        q('DROP INDEX ' + INDEX + ';')
        q(preamble)
        q(body)
        for role in ['anon', 'authenticated']:
            q('SET ROLE ' + role + ';SELECT count(*) FROM accounting_tournament_fee_sources;', 'permission denied')
        assert q('SET ROLE service_role;SELECT count(*) FROM accounting_tournament_fee_sources') == '100008'
        cases += ['valid_prefix_resume_preserves_oid', 'invalid_prefix_and_freeze_refuse',
                  'changed_reader_and_valid_wrong_key_refuse', 'existing_private_read_permissions_preserved']
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps({'cases': cases, 'plans': plans,
                                         'limitations': __doc__}, indent=2) + '\n')
        print('ROSTER_FEE_WINDOW_POSTGRES PASS:', ', '.join(cases), flush=True)
    finally:
        if started:
            run([args.pg_bin / 'pg_ctl', '-D', data, '-m', 'immediate', '-w', 'stop'])
        shutil.rmtree(work)


if __name__ == '__main__':
    main()
