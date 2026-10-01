#!/usr/bin/env python3
"""Capture the live engine-ownership doors for the isolated two-engine probe.

PASSIVE: one read-only catalog SELECT per call through `supabase db query
--linked`, run from a directory that is `supabase link`ed to production. It
reads pg_get_functiondef and information_schema; it never writes, locks a
lease row, or calls a door.

Writes, next to this file:
  live-doors.sql            every captured function, exactly as
                            pg_get_functiondef returns it, one per statement
  live-doors.manifest.json  md5 of each definition, and the column,
                            constraint, index and trigger shape of the three
                            ownership tables, so the probe can prove its
                            isolated copy matches what production runs

Usage: capture-live-doors.py --linked-dir ~/Documents/club-arena
"""
import argparse
import datetime
import hashlib
import json
import pathlib
import subprocess

HERE = pathlib.Path(__file__).resolve().parent

FUNCTIONS = [
    'public.fn_engine_lease_stale_seconds()',
    'public.claim_engine_leadership(text,text,integer)',
    'public.release_engine_leadership(text)',
    'public.claim_table_lease_v2(uuid,text,text,uuid,integer)',
    'public.heartbeat_table_leases_v4(text,jsonb,integer)',
    'public.release_table_leases_v2(text,jsonb)',
    'public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)',
    'public.heartbeat_tournament_leases_v4(text,jsonb,integer)',
    'public.release_tournament_leases_v2(text,jsonb)',
    'public.fn_ca_commit_hand_settlement_exact_before_obligations('
    'uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)',
    'smarter_private.f06_generation_aborted(uuid,uuid)',
    'smarter_private.f06_aborted_generation_guard()',
]
TABLES = ['engine_leader', 'engine_table_leases', 'engine_tournament_leases']


def query(linked_dir: str, sql: str):
    out = subprocess.run(
        ['supabase', 'db', 'query', '--linked', sql, '--output', 'json'],
        cwd=linked_dir, text=True, capture_output=True, check=True, timeout=120,
    ).stdout
    return json.loads(out[out.index('['):])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--linked-dir', required=True)
    args = parser.parse_args()
    literal = ','.join("'%s'::regprocedure" % f for f in FUNCTIONS)
    rows = query(args.linked_dir, (
        'select p.oid::regprocedure::text as sig, pg_get_functiondef(p.oid) as def, '
        'md5(pg_get_functiondef(p.oid)) as md5, pg_get_userbyid(p.proowner) as owner, '
        'coalesce(p.proacl::text, \'\') as acl '
        f'from pg_proc p where p.oid in ({literal}) order by 1'))
    by_sig = {r['sig']: r for r in rows}
    missing = [f for f in FUNCTIONS if f.replace('public.', '') not in by_sig and f not in by_sig]
    if missing:
        raise SystemExit(f'not live: {missing}')
    tables = "','".join(TABLES)
    columns = query(args.linked_dir, (
        'select table_name, column_name, data_type, is_nullable, column_default '
        "from information_schema.columns where table_schema='public' "
        f"and table_name in ('{tables}') order by table_name, ordinal_position"))
    constraints = query(args.linked_dir, (
        'select conrelid::regclass::text as rel, conname, pg_get_constraintdef(oid) as def '
        "from pg_constraint where conrelid in (select oid from pg_class where relnamespace='public'::regnamespace "
        f"and relname in ('{tables}')) order by 1, 2"))
    indexes = query(args.linked_dir, (
        'select indrelid::regclass::text as rel, pg_get_indexdef(indexrelid) as def from pg_index '
        "where indrelid in (select oid from pg_class where relnamespace='public'::regnamespace "
        f"and relname in ('{tables}')) order by 1, 2"))
    triggers = query(args.linked_dir, (
        'select tgrelid::regclass::text as rel, tgname, pg_get_triggerdef(oid) as def from pg_trigger '
        "where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace='public'::regnamespace "
        f"and relname in ('{tables}')) order by 1, 2"))
    sql = ['-- Captured from production by capture-live-doors.py. Do not edit by hand.\n']
    manifest = {
        'captured_at': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
        'how': 'pg_get_functiondef / information_schema read passively with supabase db query --linked',
        'functions': [], 'columns': columns, 'constraints': constraints,
        'indexes': indexes, 'triggers': triggers,
    }
    for sig in FUNCTIONS:
        row = by_sig.get(sig.replace('public.', '')) or by_sig[sig]
        body = row['def']
        assert hashlib.md5(body.encode()).hexdigest() == row['md5'], sig
        sql.append(f"-- {row['sig']} md5 {row['md5']}\n{body};\n")
        manifest['functions'].append({'signature': row['sig'], 'md5': row['md5'],
                                      'owner': row['owner'], 'acl': row['acl']})
    (HERE / 'live-doors.sql').write_text('\n'.join(sql))
    (HERE / 'live-doors.manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f"captured {len(manifest['functions'])} doors and {len(TABLES)} tables")


if __name__ == '__main__':
    main()
