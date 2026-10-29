#!/usr/bin/env python3
"""Socket-only PG17 qualification of Lightning's existing autovacuum settings."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
PG = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
BASE = Path(os.environ.get('TMPDIR') or os.environ.get('RUNNER_TEMP') or tempfile.gettempdir())
if sys.platform == 'darwin' and not str(BASE).startswith('/Volumes/SmarterWork/agent-work/'):
    raise RuntimeError('TMPDIR must be on the owned external SSD')
ENV = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
ENV.update(LANG='C', LC_ALL='C')
files = list((ROOT / 'supabase/migrations').glob('*_lightning_live_index_maintenance.sql'))
if len(files) != 1:
    raise RuntimeError('exact maintained migration required')
migration = files[0].read_text()
if os.geteuid() == 0:
    raise RuntimeError('run qualification as the non-root PostgreSQL owner')
checks = []
with tempfile.TemporaryDirectory(prefix='lightning-maint-', dir=BASE) as raw:
    data = Path(raw) / 'data'
    # Unix-domain sockets must fit PostgreSQL\'s 108-byte path bound.
    with tempfile.TemporaryDirectory(prefix='lm-', dir=BASE.parents[1]) as sock:
        def command(args, sql=None, ok=True):
            r = subprocess.run(list(map(str, args)), input=sql, text=True,
                               capture_output=True, env=ENV, timeout=60)
            if (r.returncode == 0) != ok:
                raise AssertionError(r.stderr or r.stdout)
            return r.stdout.strip()
        def run(sql, ok=True):
            return command([PG/'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                            '-h', sock, '-p', '55496', '-U', 'postgres', '-d', 'postgres'], sql, ok)
        def check(name, value):
            if not value:
                raise AssertionError(name)
            checks.append(name)
        def snapshot():
            return run("""SELECT jsonb_build_object(
              'rows',(SELECT jsonb_agg(t ORDER BY id) FROM public.lightning_instance t),
              'table',(SELECT jsonb_build_object('oid',oid,'acl',relacl,'rls',relrowsecurity,'owner',relowner) FROM pg_class WHERE oid='public.lightning_instance'::regclass),
              'indexes',(SELECT jsonb_agg(pg_get_indexdef(indexrelid) ORDER BY indexrelid) FROM pg_index WHERE indrelid='public.lightning_instance'::regclass),
              'constraints',(SELECT jsonb_agg(pg_get_constraintdef(oid) ORDER BY oid) FROM pg_constraint WHERE conrelid='public.lightning_instance'::regclass));""")
        command([PG/'initdb', '-D', data, '-A', 'trust', '-U', 'postgres', '--no-locale'])
        command([PG/'pg_ctl', '-D', data, '-l', Path(raw)/'postgres.log', '-o', f'-k {sock} -p 55496 -c listen_addresses=', '-w', 'start'])
        try:
            run("""CREATE TABLE public.lightning_instance(id integer PRIMARY KEY, state text NOT NULL CHECK(state IN ('forming','settled'))) WITH(fillfactor=80,autovacuum_analyze_threshold=600);
              ALTER TABLE public.lightning_instance ENABLE ROW LEVEL SECURITY;
              CREATE INDEX live_test ON public.lightning_instance(id) WHERE state='forming';
              INSERT INTO public.lightning_instance VALUES(1,'forming'),(2,'settled');""")
            before = snapshot()
            check('historical default misses incident dead-tuple count', run("SELECT 98570 < current_setting('autovacuum_vacuum_threshold')::numeric + current_setting('autovacuum_vacuum_scale_factor')::numeric * 695000") == 't')
            holder = subprocess.Popen(list(map(str, [PG/'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', '55496', '-U', 'postgres', '-d', 'postgres'])), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=ENV)
            try:
                holder.stdin.write("BEGIN; UPDATE public.lightning_instance SET state=state WHERE id=1;\n\\echo writer-ready\n")
                holder.stdin.flush()
                check('concurrent original row writer admitted', holder.stdout.readline().strip() == 'writer-ready')
                run(migration)
                checks.append('settings change admits concurrent ordinary row writer')
            finally:
                holder.communicate('ROLLBACK;\n', timeout=10)
                if holder.returncode:
                    raise AssertionError('concurrent writer did not roll back')
            options = json.loads(run("SELECT jsonb_object_agg(option_name,option_value) FROM pg_options_to_table((SELECT reloptions FROM pg_class WHERE oid='public.lightning_instance'::regclass))"))
            check('exact fixed threshold installed', options['autovacuum_vacuum_threshold'] == '1000' and options['autovacuum_vacuum_scale_factor'] == '0')
            check('unrelated options preserved', options['fillfactor'] == '80' and options['autovacuum_analyze_threshold'] == '600')
            check('rows, ACL, RLS, owner, indexes and constraints preserved', snapshot() == before)
            check('eligibility independent of historical table growth', all(98570 > 1000 + 0*n for n in [695000, 10000000]))
            run(migration, ok=False)
            check('unexpected configured preimage refused atomically', snapshot() == before)
            run('ALTER TABLE public.lightning_instance RESET(autovacuum_vacuum_threshold,autovacuum_vacuum_scale_factor); ALTER TABLE public.lightning_instance SET(autovacuum_enabled=false)')
            run(migration, ok=False)
            check('disabled maintenance refused instead of pretending eligibility', run("SELECT count(*) FROM pg_options_to_table((SELECT reloptions FROM pg_class WHERE oid='public.lightning_instance'::regclass)) WHERE option_name='autovacuum_vacuum_threshold'") == '0')
        finally:
            command([PG/'pg_ctl', '-D', data, '-m', 'immediate', '-w', 'stop'])
print(json.dumps({'passed': len(checks), 'checks': checks, 'production_mutations': False}))
