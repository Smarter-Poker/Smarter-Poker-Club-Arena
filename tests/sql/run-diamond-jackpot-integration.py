#!/usr/bin/env python3
"""Qualify Diamond rake and jackpots at the real accepted-hand SQL boundary.

Only private, socket-only PostgreSQL 17 is reachable. Production definitions,
column types and uniqueness contracts are retained in adjacent fixture inputs;
money writers and the accepted-hand wrappers are loaded verbatim. No wallet,
settlement or payout authority is replaced by a test implementation.
"""
import argparse
import importlib.util
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
SQL = ROOT / 'tests/sql'
PORT = '55899'
DB = 'poker_diamond_phase3_test'
MIGRATION = ROOT / 'supabase/migrations/20261012191143_diamond_cash_jackpots_settle_with_the_accepted_hand.sql'


def prefix(text, marker):
    if text.count(marker) != 1:
        raise RuntimeError('fixture boundary moved: ' + marker)
    return text.split(marker)[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bindir')
    ap.add_argument('--keep', action='store_true')
    ap.add_argument('--prepare-only', action='store_true', help='diagnostic setup only; never a verdict')
    args = ap.parse_args()
    spec = importlib.util.spec_from_file_location('diamond_bbj_fixture', SQL / 'run-diamond-bad-beat-jackpot.py')
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    bindir, version = helper.find_bindir(args.bindir or os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
    print('using ' + version, flush=True)
    temp = pathlib.Path(tempfile.mkdtemp(prefix='diamond-jackpot-integration-', dir=ROOT.parent))
    data, sock = temp / 'data', temp / 'sock'
    # macOS limits sockaddr_un to 104 bytes. Keep the owned database under
    # TMPDIR, but put its socket in a short sibling of that task directory.
    if len(str(sock)) + len('/.s.PGSQL.' + PORT + '.lock') > 104:
        sock = pathlib.Path(tempfile.mkdtemp(prefix='jps-', dir=temp.parent.parent))
    else:
        sock.mkdir(mode=0o700)
    os.chmod(temp, 0o700)
    env = dict(os.environ, LC_ALL='C', PGTZ='UTC')
    started = False
    sequence = 0

    def run(argv, **kwargs):
        result = subprocess.run([str(x) for x in argv], env=env, text=True,
                                capture_output=True, timeout=180, **kwargs)
        if result.returncode:
            raise RuntimeError(result.stdout + result.stderr)
        return result.stdout + result.stderr

    try:
        run([bindir / 'initdb', '-D', data, '-U', 'postgres', '--auth-local=trust',
             '--auth-host=reject', '--encoding=UTF8', '--no-locale'])
        with (data / 'postgresql.conf').open('a') as f:
            f.write("\nlisten_addresses=''\nport=%s\nunix_socket_directories='%s'\n"
                    "unix_socket_permissions=0700\nmax_connections=12\nshared_buffers='64MB'\n"
                    "fsync=off\nsynchronous_commit=off\nfull_page_writes=off\n" % (PORT, sock))
        run([bindir / 'pg_ctl', '-D', data, '-l', temp / 'postgres.log', '-w', 'start'])
        started = True
        psql = [bindir / 'psql', '-X', '-q', '-h', sock, '-p', PORT, '-U', 'postgres',
                '-v', 'ON_ERROR_STOP=1', '-P', 'pager=off']
        run(psql + ['-d', 'postgres', '-c', 'CREATE DATABASE ' + DB + ' TEMPLATE template0'])
        if run(psql + ['-d', DB, '-At', '-c', 'SELECT inet_server_addr() IS NULL']).strip() != 't':
            raise RuntimeError('fixture escaped its private socket')

        def load(text, label):
            nonlocal sequence
            sequence += 1
            path = temp / ('input-%03d.sql' % sequence)
            text = re.sub(r'^\\ir[ \t]+([^\n]+)$',
                          lambda match: "\\ir '" + str((SQL / match.group(1).strip().strip("'")).resolve()) + "'",
                          text, flags=re.MULTILINE)
            path.write_text(text)
            out = run(psql + ['-d', DB, '-f', path], cwd=SQL)
            for line in out.splitlines():
                if 'PASS:' in line:
                    print('PASS: ' + line.split('PASS:', 1)[1].strip(), flush=True)
            print('loaded ' + label, flush=True)

        base = prefix((SQL / 'poker-diamond-custody.sql').read_text(), 'CREATE TEMP TABLE receipts AS')
        guard = "current_setting('port')<>'" + '554' + "72'"
        if base.count(guard) != 1:
            raise RuntimeError('base no longer pins its isolated port')
        load(base.replace(guard, "current_setting('port')<>'%s'" % PORT), 'real custody foundation')
        load((SQL / 'poker-diamond-cash-custody-setup.sql').read_text(), 'real cash custody setup')
        load((SQL / 'poker-diamond-bad-beat-jackpot-fixture.sql').read_text(), 'four-player jackpot fixture')
        shared = (ROOT / 'supabase/migrations/20261005151918_diamond_economics_records_the_owner_answers.sql').read_text()
        load(shared[shared.index('BEGIN;'):shared.index('-- 7. EVERY EDIT LANDED, AND THE ESTATE IS AS IT WAS')]
             + '\nCOMMIT;\n', 'shared economic authority')
        load((ROOT / 'supabase/migrations/20261005152000_the_diamond_jackpot_is_decided_and_its_pool_is_player_side.sql').read_text(),
             'installed jackpot foundation')

        # Selected estate shapes, not replacement financial behavior. Add every
        # captured column before loading exact current function definitions.
        columns = json.loads((SQL / 'diamond-jackpot-integration-columns.json').read_text())
        columns += json.loads((SQL / 'diamond-jackpot-integration-extra-columns.json').read_text())
        columns += json.loads((SQL / 'diamond-jackpot-integration-lightning-columns.json').read_text())
        generated = {(c['table_name'], c['column_name'])
                     for c in json.loads((SQL / 'diamond-jackpot-integration-generated.json').read_text())}
        ddl = ['CREATE SCHEMA IF NOT EXISTS extensions;',
               'CREATE SCHEMA IF NOT EXISTS smarter_private;',
               'CREATE SEQUENCE smarter_private.f06_lifecycle_seq;',
               'CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;',
               'CREATE TABLE public.ca_financial_epochs(id integer PRIMARY KEY,is_current boolean);',
               'INSERT INTO public.ca_financial_epochs VALUES(1,true);']
        ddl.extend(f['definition'].rstrip() + ';' for f in json.loads((SQL / 'diamond-jackpot-integration-epoch-preimage.json').read_text()))
        ddl.extend(f['definition'].rstrip() + ';' for f in json.loads((SQL / 'diamond-jackpot-integration-lifecycle-preimage.json').read_text()))
        for sequence_name in sorted({match.group(1) for c in columns
                                     for match in re.finditer(r"nextval\('([^']+)'::regclass\)", c['default_sql'] or '')}):
            ddl.append('CREATE SEQUENCE IF NOT EXISTS ' + sequence_name + ';')
        for table in sorted({c['table_name'] for c in columns}):
            ddl.append('CREATE TABLE IF NOT EXISTS public."%s" (fixture_placeholder boolean);' % table)
            for c in (c for c in columns if c['table_name'] == table):
                if (table, c['column_name']) in generated:
                    default = ' GENERATED ALWAYS AS (' + c['default_sql'] + ') STORED'
                else:
                    default = (' DEFAULT ' + c['default_sql']) if c['default_sql'] else ''
                ddl.append('ALTER TABLE public."%s" ADD COLUMN IF NOT EXISTS "%s" %s%s;' %
                           (table, c['column_name'], c['sql_type'], default))
        for index in json.loads((SQL / 'diamond-jackpot-integration-indexes.json').read_text()):
            ddl.append(index['indexdef'].replace('CREATE UNIQUE INDEX ', 'CREATE UNIQUE INDEX IF NOT EXISTS ', 1) + ';')
        accrual = json.loads((SQL / 'diamond-jackpot-integration-rake-accrual-shape.json').read_text())
        ddl.append('CREATE SEQUENCE public.ca_diamond_rake_accrual_id_seq;')
        ddl.append('CREATE TABLE public.ca_diamond_rake_accrual (' + ','.join(
            '"%s" %s%s%s' % (c['column_name'], c['sql_type'],
              (' DEFAULT ' + c['default_sql']) if c['default_sql'] else '',
              ' NOT NULL' if c['not_null'] else '') for c in accrual['columns']) + ');')
        ddl.extend('ALTER TABLE public.ca_diamond_rake_accrual ADD ' + c + ';' for c in accrual['constraints'])
        ddl.extend(i.replace('CREATE UNIQUE INDEX ', 'CREATE UNIQUE INDEX IF NOT EXISTS ', 1)
                      .replace('CREATE INDEX ', 'CREATE INDEX IF NOT EXISTS ', 1) + ';' for i in accrual['indexes'])
        load('\n'.join(ddl), 'captured column and uniqueness contracts')
        for name in ('money', 'support', 'core', 'pool'):
            filename = 'diamond-jackpot-integration-pool-preimage.json' if name == 'pool' else 'diamond-jackpot-integration-%s-preimages.json' % name
            functions = json.loads((SQL / filename).read_text())
            for f in functions:
                load(f['definition'], 'exact preimage ' + f['signature'])
                observed = run(psql + ['-d', DB, '-At', '-c',
                               "SELECT md5(prosrc) FROM pg_proc WHERE oid='%s'::regprocedure" % f['signature']]).strip()
                if observed != f['body_md5']:
                    raise RuntimeError('loaded preimage differs: ' + f['signature'])

        for f in json.loads((SQL / 'diamond-jackpot-integration-name-preimages.json').read_text()):
            load(f['definition'], 'exact public presentation helper')
        for f in json.loads((SQL / 'diamond-jackpot-integration-lightning-preimages.json').read_text()):
            if f['signature'].startswith('fn_lightning_settlement_seats('):
                load(f['definition'], 'exact settlement-seat reader')
        for f in json.loads((SQL / 'diamond-jackpot-integration-notification-preimages.json').read_text()):
            load(f['definition'], 'exact durable notification writer')
        load('REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb) TO service_role;', 'captured accepted-hand EXECUTE ACL postgres/service_role only')
        tier_config = json.loads((SQL / 'diamond-jackpot-integration-chip-tier-config.json').read_text())
        load("CREATE TABLE public.bbj_stakes_tiers(id text PRIMARY KEY,min_bb numeric,max_bb numeric);\n"
             "CREATE TABLE public.bbj_mini_tiers(tier_id text PRIMARY KEY,amount numeric,enabled boolean);\n"
             + '\n'.join("INSERT INTO public.bbj_stakes_tiers VALUES('%s',%s,%s);" % (t['id'],t['min_bb'],t['max_bb']) for t in tier_config['stakes'])
             + '\n'.join("INSERT INTO public.bbj_mini_tiers VALUES('%s',%s,%s);" % (t['tier_id'],t['amount'],str(t['enabled']).lower()) for t in tier_config['mini']),
             'captured chip tier unit-count configuration')
        private_cols = json.loads((SQL / 'diamond-jackpot-integration-private-columns.json').read_text())
        private_cols += json.loads((SQL / 'diamond-jackpot-integration-retired-columns.json').read_text())
        private_ddl = []
        for table in sorted({c['table_name'] for c in private_cols}):
            columns = ','.join('"%s" %s' % (c['column_name'], c['sql_type']) for c in private_cols if c['table_name'] == table)
            private_ddl.append('CREATE TABLE smarter_private."%s" (%s);' % (table, columns))
        load('\n'.join(private_ddl), 'captured retained-submission and dispatch tables')
        for f in json.loads((SQL / 'diamond-jackpot-integration-private-preimages.json').read_text()):
            load(f['definition'], 'exact private dispatch authority ' + f['signature'])
        for f in json.loads((SQL / 'diamond-jackpot-integration-retired-preimages.json').read_text()):
            load(f['definition'], 'exact retired time-bank custody guard')
        for f in json.loads((SQL / 'diamond-jackpot-integration-history-preimages.json').read_text()):
            if f['proname'] == 'sp_prune_hand_history':
                load(f['definition'], 'exact history authority')

        guard_shape = json.loads((SQL / 'diamond-jackpot-integration-guard-shape.json').read_text())
        guard_ddl = ['CREATE SEQUENCE public.ca_guard_def_history_id_seq;']
        for table in sorted({c['table_name'] for c in guard_shape['columns']}):
            guard_ddl.append('CREATE TABLE public.' + table + ' (' + ','.join(
                c['column_name'] + ' ' + c['sql_type']
                + (' DEFAULT ' + c['default_sql'] if c['default_sql'] else '')
                + (' NOT NULL' if c['not_null'] else '')
                for c in guard_shape['columns'] if c['table_name'] == table) + ');')
        guard_ddl.extend('ALTER TABLE public.' + c['table_name'] + ' ADD ' + c['definition'] + ';'
                         for c in guard_shape['constraints'])
        load('\n'.join(guard_ddl), 'captured guard declaration dependencies')
        load('\n'.join(i['indexdef'].replace('CREATE UNIQUE INDEX ', 'CREATE UNIQUE INDEX IF NOT EXISTS ', 1)
                       .replace('CREATE INDEX ', 'CREATE INDEX IF NOT EXISTS ', 1) + ';'
                       for i in json.loads((SQL / 'diamond-jackpot-integration-guard-indexes.json').read_text())),
             'captured guard declaration uniqueness contracts')
        for f in json.loads((SQL / 'diamond-jackpot-integration-guard-preimages.json').read_text()):
            load(f['definition'].rstrip() + ';', 'exact guard declaration authority ' + f['proname'])

        if args.prepare_only:
            print('PREPARED ONLY: no acceptance verdict; private cluster ' + str(temp), flush=True)
            return
        before = SQL / 'poker-diamond-jackpot-integration-before.sql'
        acceptance = SQL / 'poker-diamond-jackpot-integration-acceptance.sql'
        for path in (before, MIGRATION, acceptance):
            if not path.is_file():
                raise RuntimeError('missing qualification input: ' + str(path))
        load(before.read_text(), 'fail-before counterexamples')
        load(MIGRATION.read_text(), 'complete migration verbatim')
        load("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM public.ca_guard_defs d WHERE d.proname='fn_poker_diamond_settle_cash_hand' AND d.declared_ref='migration 20261012191143_diamond_cash_jackpots_settle_with_the_accepted_hand' AND d.def_hash=(SELECT md5(string_agg(pg_get_functiondef(p.oid),'|' ORDER BY p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=d.proname)) THEN RAISE EXCEPTION 'settlement guard declaration disagrees'; END IF; RAISE NOTICE 'PASS: settlement guard declaration records the exact new authority'; END $$;", 'same-transaction guard baseline')
        load(acceptance.read_text(), 'connected accepted-hand regression cases')
        rake_config = json.loads((SQL / 'diamond-jackpot-integration-cash-rake-config.json').read_text())
        config_json = json.dumps(rake_config['rows']).replace("'", "''")
        load("INSERT INTO public.ca_diamond_economics(name,scope,value,value_text,units,approved_quote,approved_on,basis,recorded_by) "
             "SELECT name,scope,value,value_text,units,approved_quote,approved_on,basis,recorded_by "
             "FROM jsonb_populate_recordset(NULL::public.ca_diamond_economics,'" + config_json + "'::jsonb);",
             'current published cash rake configuration')
        load((SQL / 'poker-diamond-jackpot-integration-rake-acceptance.sql').read_text(), 'combined rake and jackpot acceptance')
        replay = subprocess.run(psql + ['-d', DB, '-f', MIGRATION], env=env,
                                text=True, capture_output=True, timeout=180)
        if replay.returncode == 0 or 'preimage' not in (replay.stdout + replay.stderr).lower():
            raise RuntimeError('installed migration replay did not refuse its exact preimage')
        print('PASS: exact migration replay refused without rewriting installed authorities', flush=True)
        print('Diamond cash jackpots and atomic accepted receipts certified on isolated PostgreSQL 17.', flush=True)
    finally:
        if started and not args.keep:
            subprocess.run([str(bindir / 'pg_ctl'), '-D', str(data), '-m', 'immediate', '-w', 'stop'],
                           env=env, capture_output=True, timeout=30, check=True)
        if not args.keep:
            shutil.rmtree(temp)
            if sock.parent != temp:
                shutil.rmtree(sock)
        else:
            print('kept private diagnostic cluster ' + str(temp) + ', socket ' + str(sock), flush=True)


if __name__ == '__main__':
    main()
