#!/usr/bin/env python3
"""Sixteen real-rule Spin scenarios in a private PostgreSQL 17 cluster.

Reuses the funding rehearsal's installed SQL, without running its 58 cases.
No remote database argument or URL is accepted. Funding/ownership/maintenance
fixture limits remain unchanged; RNG alone selects each actual tier.
"""
from pathlib import Path
import copy
import json
import os
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[2]
fixture = repo / 'scripts/dev/fixtures/spin-funding'
bridge = repo / 'scripts/dev/spin-tier-runtime.mjs'
pg = Path(os.environ['POKER_AUDIT_PG_BIN']) if os.environ.get('POKER_AUDIT_PG_BIN') else Path(
    subprocess.check_output(['brew', '--prefix', 'postgresql@17'], text=True).strip()) / 'bin'
node = os.environ.get('POKER_AUDIT_NODE', 'node')
root = Path(tempfile.mkdtemp(prefix='ca-spin-tier-pg17-'))
cluster, sock = root / 'cluster', root / 'socket'
sock.mkdir()
port = str(35000 + os.getpid() % 10000)
log_path = Path('/tmp/codex-phase3-spin-tier-pg17.log')
result_path = Path('/tmp/codex-phase3-spin-tier-results.json')
club = 'aaaaaaaa-0000-0000-0000-000000000001'
results = []


def literal(value):
    return "'" + json.dumps(value, separators=(',', ':')).replace("'", "''") + "'::jsonb"


def uid(n):
    return f'cccccccc-0000-0000-0000-{n:012d}'


with log_path.open('w') as log:
    def q(sql):
        result = subprocess.run(args + ['-c', sql], text=True, capture_output=True, timeout=35)
        if result.returncode:
            log.write(result.stderr)
            log.flush()
            raise AssertionError(result.stderr)
        return result.stdout.strip()

    def load_sql(path):
        result = subprocess.run(args + ['-f', str(path)], stdout=log, stderr=log, timeout=35)
        if result.returncode:
            raise AssertionError(f'Could not load {path}; see {log_path}')

    try:
        captured = json.loads(subprocess.check_output(
            [node, str(bridge), 'capture'], text=True))
        assert ' 17.' in subprocess.check_output([str(pg/'postgres'), '--version'], text=True)
        subprocess.run([str(pg/'initdb'), '-D', str(cluster), '--auth=trust', '--no-locale'],
                       check=True, stdout=log, stderr=log)
        subprocess.run([str(pg/'pg_ctl'), '-D', str(cluster), '-o',
                        f'-k {sock} -p {port} -c listen_addresses=', '-w', 'start'],
                       check=True, stdout=log, stderr=log)
        args = [str(pg/'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                '-h', str(sock), '-p', port, '-d', 'postgres']
        load_sql(fixture/'bootstrap.sql')
        source = (repo/'supabase/migrations/20260830112000_spin_draw_settle_concurrency_hardening.sql').read_text()
        start = source.index('CREATE OR REPLACE FUNCTION public.fn_spin_seed_instalment')
        end = source.index('$function$;', source.index('AS $function$', start)) + len('$function$;')
        q(source[start:end])
        load_sql(fixture/'installed.sql')
        load_sql(fixture/'proof-bootstrap.sql')
        load_sql(fixture/'installed-proof-functions.sql')
        load_sql(repo/'supabase/migrations/20260909174722_spin_draw_books_one_funded_rule_receipt.sql')
        load_sql(fixture/'played-proof-bootstrap.sql')
        load_sql(fixture/'installed-played-proof.sql')
        load_sql(repo/'supabase/migrations/20260909193732_a_booked_played_spin_replays_its_original_funded_draw.sql')
        assert q("SELECT md5(pg_get_functiondef('public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)'::regprocedure))") == '1c911e3ada50ffe0493b9b375e3fa9ae'
        q('CREATE TRIGGER zzz_spin_ladder_is_the_drawn_one BEFORE INSERT OR UPDATE ON public.tournaments FOR EACH ROW EXECUTE FUNCTION public.fn_spin_ladder_is_the_drawn_one()')
        n = 0
        for manifest in captured['manifests']:
            stack = manifest['starting_chips']
            assert stack in (300, 1000)
            total = sum(tier['freq'] for tier in manifest['tiers'])
            assert total == 10_000_000
            assert sum(t['freq'] * t['multiplier'] for t in manifest['tiers']) == 27_600_000
            before = 0
            assert [t['multiplier'] for t in manifest['tiers']] == [2, 3, 4, 5, 10, 25, 50, 100]
            for tier in manifest['tiers']:
                n += 1
                tid, multiplier = uid(n), tier['multiplier']
                # A midpoint strictly inside this tier's actual probability interval.
                roll = ((2*before + tier['freq']) * (1 << 48)) // (2*total)
                before += tier['freq']
                q("CREATE OR REPLACE FUNCTION extensions.gen_random_bytes(integer) RETURNS bytea "
                  f"LANGUAGE sql VOLATILE AS $$ SELECT decode('{roll:012x}', 'hex') $$")
                q(f"SELECT public.probe_spin_fixture('{tid}',1000);"
                  f"UPDATE public.spin_bonus_pools SET balance=1000 WHERE club_id='{club}';"
                  f"UPDATE public.tournaments SET starting_chips={stack} WHERE id='{tid}'")
                def rpc(rules):
                    return f"public.fn_spin_draw_and_settle_atomic('{tid}','{tid}','{tid}',{literal(rules)})"
                receipt = json.loads(q('SELECT ' + rpc(manifest)))
                assert receipt['ok'] is True and receipt['replay'] is False
                assert receipt['multiplier'] == multiplier and receipt['prize_pool'] == multiplier
                assert receipt['pool_covered'] == multiplier and receipt['operator_shortfall'] == 0
                assert receipt['starting_chips'] == stack
                assert receipt['blind_structure'] == tier['blind_structure']
                assert receipt['payout_structure'] == tier['payout_structure']
                assert receipt['rule_manifest']['tiers'] == manifest['tiers']
                assert receipt['rule_manifest']['starting_chips'] == stack
                assert receipt['locked'] == []
                assert float(q(f"SELECT balance FROM public.spin_bonus_pools WHERE club_id='{club}'")) == 1000-multiplier
                q(f"UPDATE public.tournaments SET spin_multiplier={multiplier},blind_structure='[]',payout_structure='[]' WHERE id='{tid}'")
                projection = json.loads(q(f"SELECT jsonb_build_object('stack',starting_chips,'blinds',blind_structure::jsonb,'payouts',payout_structure::jsonb) FROM public.tournaments WHERE id='{tid}'"))
                assert projection == dict(stack=stack, blinds=tier['blind_structure'], payouts=tier['payout_structure'])
                changed = copy.deepcopy(manifest)
                changed['tiers'][0]['freq'] += 1
                assert json.loads(q('SELECT ' + rpc(changed))) == dict(receipt, replay=True)
                assert q(f"SELECT count(*)=1 FROM public.spin_reserve_ledger WHERE tournament_id='{tid}' AND kind='jackpot_draw'") == 't'
                results.append(dict(stack=stack, multiplier=multiplier, tier=tier, receipt=receipt))
                print(f'PASS: {stack} chips, {multiplier}x funded rules, projection and replay', flush=True)
        consumed = json.loads(subprocess.check_output(
            [node, str(bridge), 'consume'], input=json.dumps(results), text=True))
        assert consumed['consumed'] == 16
        assert consumed['sources'] == captured['sources']
        result_path.write_text(json.dumps(dict(
            scenarios_passed=16, actual_engine_receipts_consumed=16,
            source_hashes=captured['sources'],
            cases=[dict(stack=r['stack'], multiplier=r['multiplier']) for r in results],
            scope='actual tier rules, funded draw, frozen projection and engine receipt consumption',
            production_writes=False), indent=2) + '\n')
        print(f'16 PostgreSQL tier scenarios and 16 actual engine receipt consumptions passed. Result: {result_path}', flush=True)
    finally:
        if cluster.exists():
            subprocess.run([str(pg/'pg_ctl'), '-D', str(cluster), '-m', 'immediate', 'stop'],
                           stdout=log, stderr=log)
        shutil.rmtree(root)
