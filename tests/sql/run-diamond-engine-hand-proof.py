#!/usr/bin/env python3
"""Prove the Diamond cash engine fix: REAL engine hands through the REAL settler.

Never connects to production and needs no credential. It starts its own
PostgreSQL 17 cluster in a temporary directory it creates and destroys, with no
TCP listener, exactly as run-diamond-cash-rake.py does, and reuses that
harness's fixture world: the Diamond Arena, a 10/20 cash table with four
seated players (one of them a horse), every buy-in in custody, and the
identity closing at 6,000 Diamonds.

WHAT IS PROVEN, AND WHY IT IS THE ONE THING MISSING (Dan, 2026-10-06: "the
engine fix is proven first before starting cash games"). On 2026-10-05 the
settler (`fn_poker_diamond_settle_cash_hand`, migration 20261005183028) began
recomputing every Diamond cash rake from the owner's published economics and
refusing a hand without `contributed`, `dealt_in` and `hand_saw_flop`. On
2026-10-06 the engine began sending those facts (#6268) and pricing the rake
from the same economics (#6288). Each side was tested alone: the settler with
hand-written payloads (run-diamond-cash-rake.py), the engine with the database
mocked (server/src/engine/ADiamondCashHand*.test.ts). Nothing had ever handed
a payload the ENGINE produced to the settler PRODUCTION runs, and no Diamond
cash hand has ever been dealt on production. This does exactly that:

  1. The settler under test is fingerprinted against production's own
     (md5 of pg_get_functiondef, read 2026-10-06), so it is the code that will
     settle the first live hand, not a stand-in.
  2. The rake schedule the engine prices with is read from the same
     `ca_diamond_economics` rows the settler recomputes from, and those rows
     are asserted equal to production's published answers.
  3. diamond-engine-hand-proof-driver.ts deals REAL hands on the engine's own
     HandController - a four-way showdown, a fold to the big blind, a raise
     that wins uncontested, and an all-in to the cap - and composes the
     settlement payload with the engine's own functions, in the same shape
     ServerTableEngineSettlement sends (pinned below against that source).
  4. Each hand goes to the settler. Every one must be ACCEPTED, its banked
     rake must equal the engine's, the seats must land on the engine's
     stacks, the horse must be attributed rake exactly like the people, the
     Diamond identity must close after every hand, and a redelivery must move
     nothing twice.
  5. A hand whose rake is moved by one Diamond must be REFUSED, so a pass
     cannot come from a settler that accepts anything.

This is an isolated proof, not a production certificate: it says the engine and
the settler agree, hand for hand, on production's code and published numbers.
"""
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
# The only thing read from the environment, and only to choose the binaries;
# the rake harness's bin_path resolves the same variable the same way.
PG_BIN = os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin')
SQL_DIR = ROOT / 'tests' / 'sql'
DRIVER = SQL_DIR / 'diamond-engine-hand-proof-driver.ts'
SETTLEMENT = ROOT / 'server' / 'src' / 'engine' / 'ServerTableEngineSettlement.ts'

_spec = importlib.util.spec_from_file_location('rake', SQL_DIR / 'run-diamond-cash-rake.py')
rake = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rake)

# Production's installed settler, read 2026-10-06 with
#   SELECT md5(pg_get_functiondef('public.fn_poker_diamond_settle_cash_hand(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure))
PRODUCTION_SETTLER_MD5 = '500b74f93049e7bc85a21676e3416edb'

# Production's published cash rake answers at the 10/20 stake, read 2026-10-06.
PRODUCTION_ANSWERS = {
    ('cash_rake_percent', 'all'): 10,
    ('cash_rake_percent_heads_up', 'all'): 5,
    ('cash_rake_percent_three_handed', 'all'): 10,
    ('cash_rake_cap', 'bb:20'): 300,
    ('cash_rake_cap_heads_up', 'bb:20'): 150,
    ('cash_rake_cap_three_handed', 'bb:20'): 300,
    ('cash_rake_min_pot', 'all'): 0,
}
PRODUCTION_TEXT_ANSWERS = {
    ('cash_rake_enabled', 'all'): 'yes',
    ('cash_rake_no_flop_no_drop', 'all'): 'yes',
    ('cash_rake_rounding', 'all'): 'down',
}

SCENARIOS = ['showdown', 'fold_preflop', 'raise_and_fold', 'showdown', 'all_in', 'showdown']
FIRST_HAND = 2000001

# ServerTableEngineSettlement composes `atomicCommit.stacks` for a Diamond cash
# hand from exactly these pieces. The driver composes the same; if the engine's
# composition changes, this proof must be revisited, so it refuses to pass.
SETTLEMENT_COMPOSITION = [
    '...requireHandSeatGeneration(snap.seatGenerations, p.user_id),',
    'user_id: p.user_id,',
    'stack: cents(p.stack),',
    'handStackBefore(snap.seatGenerations, snap.dealtStacks, p.user_id, p.stack)',
    '? diamondCashRakeFactsFor({',
    'contributions: snap.contributions,',
    'dealtStacks: snap.dealtStacks,',
    'handSawFlop: snap.sawFlopForMoney,',
    'rake: this.isTournamentTable() ? 0 : snap.rake,',
]


def literal(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def expected_rake_shares(elements: list, rake_amount: int) -> list:
    """Independent whole-Diamond floor/remainder oracle; no horse exemption.

    A positive contribution can correctly receive zero when the indivisible
    remainder belongs to another player. Only positive shares create rows.
    """
    if isinstance(rake_amount, bool) or int(rake_amount) != rake_amount or rake_amount < 0:
        raise ValueError('Whole nonnegative rake required')
    contributions = {}
    for element in elements:
        uid, amount = element['user_id'], element['contributed']
        if uid in contributions or isinstance(amount, bool) or int(amount) != amount or amount < 0:
            raise ValueError('Unique players and whole nonnegative contributions required')
        contributions[uid] = int(amount)
    pot = sum(contributions.values())
    if rake_amount > pot:
        raise ValueError('Rake cannot exceed contributed pot')
    if not rake_amount:
        return []
    shares = {}
    remainders = []
    for uid, amount in contributions.items():
        if amount:
            shares[uid], remainder = divmod(int(rake_amount) * amount, pot)
            remainders.append((remainder, uid))
    remaining = int(rake_amount) - sum(shares.values())
    for _, uid in sorted(remainders, key=lambda item: (-item[0], item[1]))[:remaining]:
        shares[uid] += 1
    return [{'user_id': uid, 'amount': shares[uid]} for uid in sorted(shares) if shares[uid] > 0]


def main() -> int:
    passes = 0
    source = SETTLEMENT.read_text()
    for piece in SETTLEMENT_COMPOSITION:
        if piece not in source:
            raise SystemExit(f'ServerTableEngineSettlement no longer composes the payload this '
                             f'proof mirrors (missing: {piece!r}); update the driver first')
    print('  PASS: the driver composes the payload exactly as ServerTableEngineSettlement does')
    passes += 1

    tmp = tempfile.mkdtemp(prefix='ca-diamond-engine-proof-pg17-')
    data = pathlib.Path(tmp) / 'data'
    sock = pathlib.Path(tmp) / 'sock'
    sock.mkdir(parents=True, exist_ok=True)

    # The live kind map and the shared economics table, narrowed exactly as the
    # rake harness narrows them (its assertions are repeated here, not assumed).
    km = rake.KIND_MAP.read_text()
    kind_map = km[km.index('CREATE OR REPLACE FUNCTION public.fn_diamond_kind_bucket'):]
    kind_map = kind_map[:kind_map.index('COMMENT ON FUNCTION public.fn_diamond_kind_bucket')]
    econ = rake.ECONOMICS.read_text()
    cut = econ.index('-- 7. EVERY EDIT LANDED')
    rule = econ.rindex('-- ' + '-' * 73, 0, cut)
    economics = econ[:rule] + '\nCOMMIT;\n'
    if 'md5(pg_get_functiondef(' in economics or 'CREATE TABLE public.ca_diamond_economics' not in economics:
        raise SystemExit('the economics narrowing no longer matches the rake harness')

    try:
        subprocess.run([rake.bin_path('initdb'), '-D', str(data), '-U', 'postgres', '-A', 'trust',
                        '--no-sync', '--locale=C', '--encoding=UTF8'],
                       check=True, capture_output=True, text=True, env=rake.ENV)
        started = subprocess.run(
            [rake.bin_path('pg_ctl'), '-D', str(data), '-w', '-l', str(pathlib.Path(tmp) / 'pg.log'),
             '-o', f'-k {sock} -c listen_addresses= -c fsync=off', 'start'],
            capture_output=True, text=True, env=rake.ENV)
        if started.returncode:
            print(started.stdout, started.stderr, file=sys.stderr)
            raise SystemExit('could not start the isolated PostgreSQL 17 cluster')
        try:
            def run(sql: str, label: str) -> str:
                r = subprocess.run(
                    [rake.bin_path('psql'), '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1',
                     '-h', str(sock), '-U', 'postgres', '-d', 'postgres', '-f', '-'],
                    input=sql, text=True, capture_output=True, timeout=300, env=rake.ENV)
                if r.returncode:
                    print(r.stdout)
                    print(r.stderr, file=sys.stderr)
                    raise SystemExit(f'{label} failed')
                return r.stdout.strip()

            def check(condition: str, label: str) -> None:
                nonlocal passes
                if run(f'SELECT ({condition})::text;', label) != 'true':
                    raise SystemExit(f'FAILED: {label}')
                print(f'  PASS: {label}')
                passes += 1

            version = run('SHOW server_version;', 'version')
            print(f'Isolated cluster: PostgreSQL {version}')
            if not version.startswith('17'):
                raise SystemExit(f'expected PostgreSQL 17, got {version}')

            print("\nThe rake harness's fixture world, then the settler as production runs it:")
            for sql, label in ((rake.SCHEMA.read_text(), 'fixture schema'),
                               (rake.DOORS.read_text(), 'installed doors'),
                               (kind_map + ';', 'the live kind map'),
                               (rake.SEED, 'fixture seed'),
                               (rake.HELPER, 'fixture helper'),
                               (economics, 'the shared economics table'),
                               (rake.MIGRATION.read_text(), 'the settler migration')):
                run(sql, label)
            md5 = run("SELECT md5(pg_get_functiondef('public.fn_poker_diamond_settle_cash_hand"
                      "(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure));", 'md5')
            if md5 != PRODUCTION_SETTLER_MD5:
                raise SystemExit(f'the settler here ({md5}) is not production\'s '
                                 f'({PRODUCTION_SETTLER_MD5}); re-read production before proving anything')
            print(f'  PASS: the settler under test is byte-for-byte production\'s (md5 {md5})')
            passes += 1

            for (name, scope), value in PRODUCTION_ANSWERS.items():
                check(f"public.fn_ca_diamond_economic('{name}','{scope}') = {value}",
                      f'{name}@{scope} is {value}, as production publishes it')
            for (name, scope), value in PRODUCTION_TEXT_ANSWERS.items():
                check(f"public.fn_ca_diamond_economic_text('{name}','{scope}') = '{value}'",
                      f'{name}@{scope} is {value}, as production publishes it')

            # The engine reads its schedule from this same table, as
            # services/supabase/diamondCashRakeSettings.ts does at the deal.
            rows = json.loads(run(
                "SELECT COALESCE(jsonb_agg(jsonb_build_object('name',name,'scope',scope,"
                "'value',value,'value_text',value_text,"
                "'recorded_at',to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'),"
                "'id',id) ORDER BY id),'[]') FROM public.ca_diamond_economics "
                "WHERE name LIKE 'cash_rake%' AND scope IN ('all','bb:20');", 'economics rows'))
            for r in rows:
                if r['value'] is not None:
                    r['value'] = float(r['value'])
            seats = json.loads(run(
                "SELECT jsonb_agg(jsonb_build_object('user_id',x.user_id,'seat_id',x.id,"
                "'seat_joined_at',to_char(x.joined_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'),"
                "'seat_number',x.n,'stack',x.stack::bigint,'is_horse',x.is_horse) ORDER BY x.user_id) "
                "FROM (SELECT s.*, p.is_horse, row_number() OVER (ORDER BY s.user_id) AS n "
                f"FROM public.table_seats s JOIN public.profiles p ON p.id=s.user_id "
                f"WHERE s.table_id='{rake.T_20}' AND s.left_at IS NULL) x;", 'seats'))
            if len(seats) != 4 or sum(1 for s in seats if s['is_horse']) != 1:
                raise SystemExit('the fixture table is not four seats with one horse')

            print('\nREAL HANDS ON THE ENGINE\'S OWN HandController:')
            with tempfile.TemporaryDirectory(prefix='diamond-engine-proof-') as work:
                work = pathlib.Path(work)
                spec_file = work / 'spec.json'
                out_file = work / 'hands.json'
                cfg = work / 'vitest.config.mjs'
                spec_file.write_text(json.dumps({
                    'table_id': rake.T_20, 'small_blind': 10, 'big_blind': 20,
                    'first_hand_number': FIRST_HAND, 'economics': rows,
                    'seats': seats, 'scenarios': SCENARIOS}))
                cfg.write_text('export default ' + json.dumps({'test': {
                    'include': [str(DRIVER)], 'pool': 'forks', 'maxWorkers': 1, 'minWorkers': 1}}))
                env = dict(os.environ, DIAMOND_ENGINE_PROOF_INPUT=str(spec_file),
                           DIAMOND_ENGINE_PROOF_OUTPUT=str(out_file))
                subprocess.run([str(ROOT / 'server/node_modules/.bin/vitest'), 'run', '--config', str(cfg)],
                               cwd=ROOT, env=env, check=True, timeout=180)
                hands = json.loads(out_file.read_text())['hands']
            print(f'  {len(hands)} hands dealt and played to their end by the engine')

            def refuse_a_wrong_rake(last: dict) -> None:
                """A hand whose stacks CONSERVE with a rake one Diamond above what the
                settings price must be refused by the rake recompute itself. Run on
                live, funded seats right after the first raked hand, so nothing
                else about the hand can be the reason it is refused."""
                nonlocal passes
                print('\n  THE SETTLER STILL REFUSES A WRONG ENGINE NUMBER:')
                live = json.loads(run(
                    "SELECT jsonb_agg(jsonb_build_object('seat_id',s.id,'stack',s.stack::bigint)) "
                    f"FROM public.table_seats s WHERE s.table_id='{rake.T_20}' AND s.left_at IS NULL;", 'live'))
                stack_now = {r['seat_id']: r['stack'] for r in live}
                mutated = []
                for e in last['elements']:
                    cur = stack_now[e['seat_id']]
                    mutated.append({**e, 'stack_before': cur, 'stack': cur + (e['stack'] - e['stack_before'])})
                if any(m['stack_before'] <= 0 or m['stack'] < 0 for m in mutated):
                    raise SystemExit('the wrong-rake case needs funded seats; run it earlier')
                winner = max(mutated, key=lambda m: m['stack'] - m['stack_before'])
                winner['stack'] -= 1
                refusal = subprocess.run(
                    [rake.bin_path('psql'), '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-h', str(sock),
                     '-U', 'postgres', '-d', 'postgres', '-c',
                     f"SELECT public.fn_poker_diamond_settle_cash_hand('{rake.T_20}',{FIRST_HAND + 900},"
                     f"{literal(json.dumps(mutated))}::jsonb,{last['rake'] + 1},0,NULL,0);"],
                    text=True, capture_output=True, env=rake.ENV)
                if refusal.returncode == 0:
                    raise SystemExit('the settler accepted a rake one Diamond off the engine\'s - it checks nothing')
                if 'diamond_cash_rake_disagrees' not in refusal.stderr:
                    raise SystemExit('the wrong rake was refused, but not by the rake check: '
                                     + refusal.stderr.strip()[:200])
                print('  PASS: a conserving hand claiming one Diamond more rake than the settings price is refused: '
                      + refusal.stderr.strip().splitlines()[0][:140])
                passes += 1

            print('\nEVERY ENGINE HAND THROUGH THE INSTALLED SETTLER:')
            cumulative_rake = 0
            raked_with_flop = 0
            unraked_no_flop = 0
            wrong_rake_refused = False
            for hand in hands:
                n = hand['hand_number']
                payload = json.dumps(hand['elements'])
                receipt = json.loads(run(
                    f"SELECT public.fn_poker_diamond_settle_cash_hand('{rake.T_20}',{n},"
                    f"{literal(payload)}::jsonb,{hand['rake']},0,NULL,0)::text;", f'hand {n}'))
                label = (f"hand {n} ({hand['scenario']}, {hand['dealt_in']} dealt, pot {hand['pot']}, "
                         f"flop {'yes' if hand['saw_flop'] else 'no'})")
                if float(receipt.get('rake', -1)) != hand['rake']:
                    raise SystemExit(f'{label}: the settler banked {receipt.get("rake")}, '
                                     f'the engine charged {hand["rake"]}')
                print(f"  PASS: {label} is accepted with the engine's rake of {hand['rake']}")
                passes += 1
                cumulative_rake += hand['rake']
                if hand['rake'] > 0 and hand['saw_flop']:
                    raked_with_flop += 1
                if hand['rake'] == 0 and not hand['saw_flop']:
                    unraked_no_flop += 1
                check(f"(SELECT COALESCE(sum(amount),0) FROM public.ca_diamond_rake_accrual "
                      f"WHERE table_id='{rake.T_20}' AND hand_number={n}) = {hand['rake']}",
                      f'hand {n}: the accrual holds exactly the engine\'s rake')
                for e in hand['elements']:
                    check(f"(SELECT stack FROM public.table_seats WHERE id='{e['seat_id']}') = {e['stack']}",
                          f"hand {n}: seat {e['user_id'][-1]} lands on the engine's stack {e['stack']}")
                expected_shares = expected_rake_shares(hand['elements'], hand['rake'])
                actual_shares = json.loads(run(
                    "SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id',user_id,'amount',amount) "
                    "ORDER BY user_id),'[]'::jsonb)::text FROM public.ca_diamond_rake_accrual "
                    f"WHERE table_id='{rake.T_20}' AND hand_number={n} AND kind='rake';",
                    f'hand {n} exact player rake shares'))
                if actual_shares != expected_shares:
                    raise SystemExit(f'hand {n}: exact contributor rake shares differ from independent floor/remainder oracle')
                print(f'  PASS: hand {n}: exact whole-Diamond contributor shares, including the horse, match (10.5)')
                passes += 1
                check("(SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) = 0",
                      f'hand {n}: the Diamond identity closes')
                if hand['rake'] > 0 and not wrong_rake_refused:
                    refuse_a_wrong_rake(hand)
                    wrong_rake_refused = True

            check(f"(SELECT sum(balance) FROM public.poker_diamond_custody) = {6000 - cumulative_rake}",
                  f'custody is the 6000 seeded less the {cumulative_rake} raked')
            check(f"(SELECT COALESCE(sum(amount),0) FROM public.ca_diamond_rake_accrual) = {cumulative_rake}",
                  f'the accrual holds all {cumulative_rake} Diamonds of rake, and nothing else')
            if not wrong_rake_refused:
                raise SystemExit('no raked hand to prove the wrong-rake refusal on')
            if raked_with_flop < 1 or unraked_no_flop < 1:
                raise SystemExit('the hands did not cover both a raked flop and an unraked no-flop hand')
            print(f'  PASS: {raked_with_flop} raked hand(s) saw a flop; '
                  f'{unraked_no_flop} no-flop hand(s) were not raked')
            passes += 1

            print('\nA REDELIVERY MOVES NOTHING TWICE:')
            before = run("SELECT (SELECT sum(balance) FROM public.poker_diamond_custody)::text || '/' || "
                         "(SELECT count(*) FROM public.ca_diamond_rake_accrual)::text;", 'before replay')
            for hand in hands:
                run(f"SELECT public.fn_poker_diamond_settle_cash_hand('{rake.T_20}',{hand['hand_number']},"
                    f"{literal(json.dumps(hand['elements']))}::jsonb,{hand['rake']},0,NULL,0);",
                    f"replay {hand['hand_number']}")
            after = run("SELECT (SELECT sum(balance) FROM public.poker_diamond_custody)::text || '/' || "
                        "(SELECT count(*) FROM public.ca_diamond_rake_accrual)::text;", 'after replay')
            if before != after:
                raise SystemExit(f'a replay moved money: {before} -> {after}')
            print(f'  PASS: every hand redelivered as the engine sent it; custody and accrual unchanged ({after})')
            passes += 1

            print(f'\n{passes} Diamond engine hand proof checks passed on isolated PostgreSQL 17; '
                  'ENGINE HAND PROOF PASSED: the engine and production\'s settler agree on every hand. '
                  'This is an isolated proof, not a production certification.')
            return 0
        finally:
            subprocess.run([rake.bin_path('pg_ctl'), '-D', str(data), '-w', '-m', 'immediate', 'stop'],
                           capture_output=True, text=True, env=rake.ENV)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    raise SystemExit(main())
