#!/usr/bin/env python3
"""The mint register keeps its supply in shards, and the supply it records is unchanged.

fn_ca_register_issuance_leg summed every chips row of ca_mint_ledger to fill
supply_after for each leg it registered (0.67 s and 19,286 buffers per call on
822,498 rows, production 2026-10-03). Migration
20261003220304_the_mint_register_keeps_its_supply_in_shards reads the same
total from 32 shard rows kept by an AFTER trigger.

This harness runs on a disposable PostgreSQL cluster. It installs the live
pre-image of fn_ca_register_issuance_leg (the migration's own md5 pin proves
the fixture is the production text), then applies the SHIPPED migration file
unchanged, and proves:

  SAME     a twin cluster left on the pre-image registers the same legs and
           every register row's supply_after matches, to the cent, including
           mints, burns, a correction that moves nothing and a hand-written
           row the register adopts;
  AGREE    after every step the shards equal the register's own sum, for both
           assets, and fn_ca_mint_supply_shards_agree() says so;
  CHANGES  a permitted maintenance change of an amount, and a delete, move the
           shards by exactly the difference; a link update moves nothing;
  CONCUR   eight sessions registering at once never deadlock, never wait on
           one row, and leave the shards equal to the sum;
  COST     on 400,000 register rows the old supply read scans them all and the
           new one reads 32 rows.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import threading

ROOT = Path(__file__).resolve().parents[2]
OUT = (ROOT / 'artifacts/mint-supply-shards').resolve()
OUT.mkdir(parents=True, exist_ok=True)


def find_pg_bin():
    if os.environ.get('PG_BIN'):
        return Path(os.environ['PG_BIN'])
    for cand in sorted(Path('/usr/lib/postgresql').glob('*/bin'), reverse=True):
        if (cand / 'postgres').exists():
            return cand
    return Path('/opt/homebrew/opt/postgresql@17/bin')


PG = find_pg_bin()
# initdb refuses to run as root; a root sandbox runs the cluster as postgres.
AS_PG = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
ENV = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
ENV['LC_ALL'] = 'C'

found = sorted((ROOT / 'supabase/migrations').glob('*_the_mint_register_keeps_its_supply_in_shards.sql'))
if len(found) != 1:
    raise RuntimeError(f'expected exactly one shipped migration, found {len(found)}')
SHIPPED = found[0].read_text()

# The production pre-image, byte for byte (md5 8d3d5e1feccd96fcf0045afefdb9fcdc,
# asserted by the shipped migration's own pre-check when it runs below).
PRE_IMAGE = (ROOT / 'scripts/ci/fixtures/mint-supply-shards/fn_ca_register_issuance_leg.pre.sql').read_text()

FIXTURE = r"""
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE TABLE public.clubs (id uuid PRIMARY KEY, name text, is_union boolean DEFAULT false);
CREATE TABLE public.unions (id uuid PRIMARY KEY, name text);
CREATE TABLE public.profiles (id uuid PRIMARY KEY, username text, full_name text);
CREATE TABLE public.chip_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), performed_by uuid,
  from_type text, from_entity_id uuid, to_type text, to_entity_id uuid,
  amount numeric, category text, description text, metadata jsonb,
  idempotency_key text, actor_service text, db_role text DEFAULT current_user,
  pre_from_balance numeric, post_from_balance numeric, pre_to_balance numeric, post_to_balance numeric,
  created_at timestamptz DEFAULT now());
CREATE TABLE public.ca_mint_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), op_id text NOT NULL UNIQUE, action text NOT NULL,
  asset text NOT NULL, holder_type text NOT NULL, holder_id uuid NOT NULL, holder_label text,
  amount numeric NOT NULL, balance_before numeric NOT NULL, balance_after numeric NOT NULL,
  supply_after numeric NOT NULL, reason text NOT NULL, performed_by uuid, performed_by_label text,
  db_role text NOT NULL DEFAULT CURRENT_USER, created_at timestamptz NOT NULL DEFAULT now(),
  chip_ledger_id uuid, diamond_tx_id uuid, origin text);
CREATE UNIQUE INDEX ca_mint_ledger_chip_ledger_id_key ON public.ca_mint_ledger (chip_ledger_id) WHERE chip_ledger_id IS NOT NULL;
CREATE INDEX ca_mint_ledger_asset_created_net_idx ON public.ca_mint_ledger (asset, created_at) INCLUDE (action, amount);
CREATE INDEX ca_mint_ledger_asset_idx ON public.ca_mint_ledger (asset, action, created_at DESC);
ALTER TABLE public.ca_mint_ledger ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION public.fn_ca_noncirculating_chip_stores() RETURNS text[] LANGUAGE sql IMMUTABLE
  AS $$ SELECT ARRAY['system_mint','system_burn','issuance_reserve','chip_retirement'] $$;
INSERT INTO public.clubs VALUES ('00000000-0000-0000-0000-0000000000c1','Club One',false),
                                ('00000000-0000-0000-0000-0000000000a1','Union As Club',true);
INSERT INTO public.unions VALUES ('00000000-0000-0000-0000-0000000000a1','Union One');
INSERT INTO public.profiles VALUES ('00000000-0000-0000-0000-0000000000f1','player one',null);
"""


class Cluster:
    def __init__(self, name, port):
        self.dir = Path(tempfile.mkdtemp(prefix=f'mint-shards-{name}-', dir='/tmp'))
        self.sock = self.dir / 'socket'
        self.sock.mkdir(mode=0o700)
        if AS_PG:
            shutil.chown(self.dir, 'postgres')
            shutil.chown(self.sock, 'postgres')
        self.port = str(port)
        subprocess.run(AS_PG + [str(PG / 'initdb'), '-D', str(self.dir / 'data'), '-U', 'postgres', '-A', 'trust'],
                       env=ENV, check=True, capture_output=True)
        subprocess.run(AS_PG + [str(PG / 'pg_ctl'), '-D', str(self.dir / 'data'), '-l', str(self.dir / 'log'), '-w',
                        '-o', f"-k {self.sock} -p {self.port} -c listen_addresses='' -c fsync=off -c max_connections=40",
                        'start'], env=ENV, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def psql(self, sql, check=True):
        if os.environ.get('SHARDS_TRACE'):
            print(f'[{self.port}] {sql[:90]!r}', flush=True)
        r = subprocess.run([str(PG / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', str(self.sock),
                            '-p', self.port, '-U', 'postgres', '-d', 'postgres'],
                           input=sql, text=True, capture_output=True, env=ENV, timeout=300)
        if check and r.returncode != 0:
            raise RuntimeError(r.stderr)
        return r

    def stop(self):
        subprocess.run(AS_PG + [str(PG / 'pg_ctl'), '-D', str(self.dir / 'data'), '-m', 'immediate', 'stop'],
                       env=ENV, capture_output=True)
        shutil.rmtree(self.dir, ignore_errors=True)


def leg_sql(i, kind):
    """One journal leg and its registration, as the deferred trigger would do at commit."""
    if kind == 'burn':
        return (f"INSERT INTO public.chip_ledger (id, from_type, from_entity_id, to_type, amount, category, description, created_at) "
                f"VALUES ('{uid(i)}', 'table_stack', '00000000-0000-0000-0000-0000000000c1', 'chip_retirement', {1 + (i % 7) * 0.13:.2f}, 'burn', 'rake retired', now()); "
                f"SELECT public.fn_ca_register_issuance_leg('{uid(i)}');")
    if kind == 'mint':
        return (f"INSERT INTO public.chip_ledger (id, from_type, to_type, to_entity_id, amount, category, idempotency_key, pre_to_balance, post_to_balance, created_at) "
                f"VALUES ('{uid(i)}', 'issuance_reserve', 'club_treasury', '00000000-0000-0000-0000-0000000000a1', 250.00, 'mint', 'k:{i}', 10, 260, now()); "
                f"SELECT public.fn_ca_register_issuance_leg('{uid(i)}');")
    if kind == 'correction':
        return (f"INSERT INTO public.chip_ledger (id, from_type, to_type, amount, category, metadata, created_at) "
                f"VALUES ('{uid(i)}', 'issuance_reserve', 'player_wallet', 5, 'correction', '{{\"posted_via\":\"fn_ca_post_correction\"}}', now()); "
                f"SELECT public.fn_ca_register_issuance_leg('{uid(i)}');")
    if kind == 'adopt':
        # A door wrote its own row (unlinked) a moment before the leg: the register adopts it.
        return (f"INSERT INTO public.ca_mint_ledger (op_id, action, asset, holder_type, holder_id, amount, balance_before, balance_after, supply_after, reason) "
                f"VALUES ('door:{i}', 'burn', 'chips', 'player', '00000000-0000-0000-0000-0000000000f1', 3.00, 3, 0, 0, 'door wrote it'); "
                f"INSERT INTO public.chip_ledger (id, from_type, from_entity_id, to_type, amount, category, created_at) "
                f"VALUES ('{uid(i)}', 'player_wallet', '00000000-0000-0000-0000-0000000000f1', 'chip_retirement', 3.00, 'burn', now()); "
                f"SELECT public.fn_ca_register_issuance_leg('{uid(i)}');")
    if kind == 'diamond':
        return (f"INSERT INTO public.ca_mint_ledger (op_id, action, asset, holder_type, holder_id, amount, balance_before, balance_after, supply_after, reason) "
                f"VALUES ('diamond:{i}', 'mint', 'diamonds', 'player', '00000000-0000-0000-0000-0000000000f1', 7, 0, 7, 0, 'diamond door');")
    raise ValueError(kind)


def uid(i):
    return f'00000000-0000-4000-8000-{i:012d}'


PLAN = ['burn'] * 5 + ['mint', 'burn', 'correction', 'adopt', 'diamond', 'burn', 'mint'] + ['burn'] * 6


def supplies(c):
    r = c.psql("SELECT coalesce(string_agg(op_id || '=' || supply_after::text, ',' ORDER BY op_id), '') FROM public.ca_mint_ledger WHERE asset = 'chips';")
    return r.stdout.strip()


def agree(c):
    r = c.psql("""
      SELECT bool_and(a.agree)::text || ':' || count(*)::text FROM public.fn_ca_mint_supply_shards_agree() a;""")
    return r.stdout.strip()


results = {'scope': 'the mint register keeps its supply in shards', 'cases': [], 'passed': False}
old = new = None
try:
    old = Cluster('old', 55811)
    new = Cluster('new', 55812)
    for c in (old, new):
        c.psql(FIXTURE)
        c.psql(PRE_IMAGE + ';\nREVOKE ALL ON FUNCTION public.fn_ca_register_issuance_leg(uuid) FROM PUBLIC;\n'
               'GRANT EXECUTE ON FUNCTION public.fn_ca_register_issuance_leg(uuid) TO service_role;')
        # Some history before the migration, so the seed has something to carry.
        for i in range(1, 6):
            c.psql(leg_sql(i, 'burn'))
        c.psql(leg_sql(6, 'diamond'))

    pre = old.psql("SELECT md5(pg_get_functiondef('public.fn_ca_register_issuance_leg(uuid)'::regprocedure));").stdout.strip()
    results['cases'].append({'case': 'fixture is the production pre-image', 'md5': pre,
                             'ok': pre == '8d3d5e1feccd96fcf0045afefdb9fcdc'})

    r = new.psql(SHIPPED)
    results['cases'].append({'case': 'shipped migration applies, its own pre and post checks pass', 'ok': r.returncode == 0})
    results['cases'].append({'case': 'AGREE after seed', 'agree': agree(new), 'ok': agree(new) == 'true:2'})

    for i, kind in enumerate(PLAN, start=100):
        for c in (old, new):
            c.psql(leg_sql(i, kind))
        a = agree(new)
        if a != 'true:2':
            results['cases'].append({'case': f'AGREE after {kind} {i}', 'agree': a, 'ok': False})
    s_old, s_new = supplies(old), supplies(new)
    results['cases'].append({'case': 'SAME supply_after on every register row', 'rows': s_new.count('=') ,
                             'ok': s_old == s_new and s_new.count('=') > 20})

    # CHANGES: maintenance change of an amount and a delete move the shards by the difference.
    new.psql("""
      UPDATE public.ca_mint_ledger SET amount = amount + 1 WHERE op_id = 'door:108';
      DELETE FROM public.ca_mint_ledger WHERE op_id = 'diamond:6';""")
    results['cases'].append({'case': 'CHANGES amount change and delete keep the shards exact', 'agree': agree(new),
                             'ok': agree(new) == 'true:2'})
    before = new.psql("SELECT sum(net)::text FROM public.ca_mint_supply_shards;").stdout.strip()
    new.psql("UPDATE public.ca_mint_ledger SET chip_ledger_id = gen_random_uuid() WHERE op_id = 'door:9999' OR (chip_ledger_id IS NULL AND op_id LIKE 'diamond:%');")
    after = new.psql("SELECT sum(net)::text FROM public.ca_mint_supply_shards;").stdout.strip()
    results['cases'].append({'case': 'CHANGES a link update moves nothing', 'before': before, 'after': after,
                             'ok': before == after})

    # CONCUR: eight sessions registering at once.
    errors = []

    def worker(w):
        sql = 'BEGIN;\n' + '\n'.join(leg_sql(1000 + w * 100 + k, 'burn') for k in range(40)) + '\nSELECT pg_sleep(0.05);\nCOMMIT;'
        r = new.psql(sql, check=False)
        if r.returncode != 0:
            errors.append(r.stderr[-300:])
    threads = [threading.Thread(target=worker, args=(w,)) for w in range(8)]
    t0 = time.time()
    [t.start() for t in threads]
    [t.join() for t in threads]
    results['cases'].append({'case': 'CONCUR eight sessions, no deadlock, shards agree', 'errors': errors[:2],
                             'agree': agree(new), 'seconds': round(time.time() - t0, 2),
                             'ok': not errors and agree(new) == 'true:2'})

    # COST: 400,000 register rows.
    for c in (old, new):
        c.psql("""
          INSERT INTO public.ca_mint_ledger (op_id, action, asset, holder_type, holder_id, amount, balance_before, balance_after, supply_after, reason)
          SELECT 'bulk:' || g, 'burn', 'chips', 'circulation', '00000000-0000-0000-0000-00000000c1c0', 0.5, 0, 0, 0, 'bulk history'
            FROM generate_series(1, 400000) g;
          VACUUM ANALYZE public.ca_mint_ledger;""")
    old_plan = old.psql("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) FROM public.ca_mint_ledger WHERE asset = 'chips';").stdout
    new_plan = new.psql("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT COALESCE(SUM(s.net), 0) FROM public.ca_mint_supply_shards s WHERE s.asset = 'chips';").stdout
    op = json.loads(old_plan)[0]
    np = json.loads(new_plan)[0]
    results['cases'].append({'case': 'COST old supply read vs shards', 'old_ms': op['Execution Time'], 'new_ms': np['Execution Time'],
                             'old_buffers': op['Plan'].get('Shared Hit Blocks', 0) + op['Plan'].get('Shared Read Blocks', 0),
                             'new_buffers': np['Plan'].get('Shared Hit Blocks', 0) + np['Plan'].get('Shared Read Blocks', 0),
                             'ok': np['Execution Time'] < op['Execution Time'] / 20})
    results['cases'].append({'case': 'AGREE after bulk history', 'agree': agree(new), 'ok': agree(new) == 'true:2'})

    results['passed'] = all(c['ok'] for c in results['cases'])
finally:
    for c in (old, new):
        if c:
            c.stop()
    (OUT / 'result.json').write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))

if not results['passed']:
    raise SystemExit(1)
