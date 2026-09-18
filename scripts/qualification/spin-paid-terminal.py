"""Current paid terminal compatibility in the existing finite PG17 owner.

No process owner, production target, historical reconstruction or repair loop.
Every older image and its original stage validation remain intact.
"""
from copy import deepcopy
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import re

IMAGE = 'positive-fee-terminal'
BASE = 'scripts/qualification/fixtures/spin-paid-terminal/'
MODULE = 'scripts/qualification/spin-paid-terminal.py'
MANIFEST = 'scripts/qualification/spin-paid-terminal.hosted.manifest.json'
RULE_SOURCE = 'server/src/tournament/SpinDrawReceipt.ts'
INPUTS = (MODULE, MANIFEST, *(BASE + n for n in ('capture.json', 'provider.sql', 'execute.sql', 'rules.json')),
          RULE_SOURCE, 'server/src/config/spinSpec.ts')
STAGES = ('paid_before_launch', 'paid_launch_refusals', 'paid_draw_committed', 'paid_draw_replay',
          'paid_running', 'paid_synthetic_finish', 'paid_finish_claimed',
          'paid_terminal_committed', 'paid_terminal_replay')


def require(ok, message):
    if not ok:
        raise ValueError('paid terminal evidence: ' + message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def decode(raw):
    def unique(pairs):
        result = {}
        for key,value in pairs:
            require(key not in result, 'duplicate JSON key')
            result[key] = value
        return result
    def bad(value):
        raise ValueError('nonfinite JSON: ' + value)
    return json.loads(raw, object_pairs_hook=unique, parse_constant=bad, parse_float=Decimal)


def observations(raw):
    require(isinstance(raw, bytes) and 0 < len(raw) <= 4194304, 'bounded original output required')
    result = []
    for line in raw.decode().splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith('{'):
            if line == '{"role":"service_role"}||service_role':
                continue
            value = decode(line)
            require(isinstance(value, dict) and 'stage' in value, 'unknown JSON output')
            result.append(value)
        else:
            require(re.fullmatch(r'(?:BEGIN|COMMIT|SET|RESET|GRANT|REVOKE|DO|ALTER FUNCTION|'
                                r'CREATE (?:TABLE|FUNCTION)|INSERT 0 [0-9]+|UPDATE [0-9]+|SELECT [0-9]+)', line),
                    'unexpected stdout or SQL diagnostic')
    return result


def validate_sources(files, fee):
    require(set(INPUTS) <= set(files), 'source inventory incomplete')
    manifest = fee.decode(files[MANIFEST])
    require(manifest['schemaVersion'] == 1 and manifest['image'] == IMAGE
            and manifest['synthetic_finish_input'] is True
            and all(manifest[k] is False for k in ('historical_qualification',
                'full_financial_qualification', 'production_qualification')),
            'scope differs')
    require(set(manifest['files']) == set(INPUTS) - {MANIFEST}, 'pinned inventory differs')
    for name, pin in manifest['files'].items():
        require(pin == {'bytes': len(files[name]), 'sha256': sha(files[name])}, 'source changed: ' + name)
    capture = fee.decode(files[BASE + 'capture.json'])
    require(len(capture['functions']) == 24 and len(capture['preimage']) == 24
            and sum(x['present'] is True for x in capture['preimage']) == 8,
            'captured provider inventory differs')
    for f in capture['functions']:
        require(hashlib.md5(f['definition'].encode()).hexdigest() == f['definition_md5'], 'capture definition changed')
        if not next(p['present'] for p in capture['preimage'] if p['signature'] == f['signature']):
            require(files[BASE + 'provider.sql'].count((f['definition'].rstrip() + ';').encode()) == 1,
                    'executed provider differs from original captured definition')
    for path, expected in ((BASE + 'provider.sql', ['../spin-receipt-lane/boundary.sql']),
                           (BASE + 'execute.sql', ['../spin-receipt-lane/boundary.sql',
                              '../spin-history-retention/database-state.sql'])):
        require(re.findall(r'^\\ir (.+)$', files[path].decode(), re.M) == expected,
                'private include graph changed')


def body_plan(PG, source, execution, ordinary, tournament, fee, mixed):
    original = fee.body_plan(PG, source, execution, ordinary, tournament)
    def sql(name, path, rules=False):
        argv = fee.sql_argv(PG, source, execution, ordinary, tournament, path)
        if rules:
            at = argv.index('-c')
            argv[at:at] = ['-v', 'rule_manifest=' + (source / BASE / 'rules.json').read_text()]
        return name, argv
    # The original pure preimage must be installed before the current catalog.
    prefix = [sql('paid_legacy_lane_provider', 'scripts/qualification/fixtures/spin-receipt-lane/provider.sql'),
              sql('paid_pure_install', 'supabase/components/spin-mixed-basis-evidence.sql')]
    additions = [sql('paid_launch_provider', BASE + 'provider.sql'),
                 sql('paid_doctrine_restore', mixed.BASE + 'doctrine-successor-restore.sql'),
                 sql('paid_current_lane_install', mixed.LANE),
                 sql('paid_terminal_install', mixed.COMPONENT)]
    return original[:1] + prefix + original[1:-1] + additions + original[-1:] + [
        sql('paid_actual_terminal', BASE + 'execute.sql', rules=True)]


def validate_observations(values, execution, tournament, rules):
    require([v.get('stage') for v in values] == list(STAGES), 'missing or reordered original observations')
    for v in values:
        require(v['execution'] == execution and v['tournament'] == tournament and v['rules'] == rules,
                'wrong operation identity or rules')
        require(v['synthetic_finish_input'] is True and all(v[k] is False for k in
                ('historical_qualification', 'full_financial_qualification', 'production_qualification')),
                'unobserved scope claimed')
        require(isinstance(v['estate'], dict) and 200 < len(v['estate']) <= 400
                and all(isinstance(rows, list) and len(rows) <= 1000 for rows in v['estate'].values()),
                'bounded full business estate absent')
    obs = dict(zip(STAGES, values))
    def rows(v, name):
        return v['estate']['public.' + name]
    def one(v, name):
        result, = rows(v, name)
        return result
    before = obs['paid_before_launch']; draw = obs['paid_draw_committed']; running = obs['paid_running']
    final = obs['paid_terminal_committed']; replay = obs['paid_terminal_replay']
    winner = before['winner']
    require(all(v['winner'] == winner and v['launch'] == before['launch'] and v['generation'] == before['generation'] for v in values),
            'operation identity changed')
    require(one(before, 'tournaments')['status'] == 'REGISTERING' and not rows(before, 'spin_draw_receipts')
            and not rows(before, 'tournament_launch_receipts'), 'launch receipt existed before real launch')
    refusals = obs['paid_launch_refusals']['calls']
    require(refusals['wrong_generation']['ok'] is False and refusals['wrong_generation']['reason'] == 'launch_lease_lost'
            and refusals['wrong_format']['ok'] is False and refusals['wrong_format']['reason'] == 'launch_format_mismatch',
            'real lease/format refusals absent')
    paid = rows(before, 'tournament_refund_entitlements')
    require(len(paid) == 3 and len({p['user_id'] for p in paid}) == 3, 'three genuine paid identities missing')
    receipt = one(draw, 'spin_draw_receipts'); launch = one(running, 'tournament_launch_receipts')
    require(receipt['tournament_id'] == tournament and receipt['launch_id'] == before['launch']
            and receipt['lease_generation'] == before['generation'] and receipt['rule_manifest'] == rules,
            'draw has wrong launch, lease or rules')
    require(launch['tournament_id'] == tournament and launch['launch_id'] == before['launch']
            and launch['lease_generation'] == before['generation'] and launch['completed_at'] is not None
            and one(running, 'tournaments')['started_at'] == launch['started_at']
            and one(running, 'tournaments')['status'] == 'RUNNING', 'real completed launch missing')
    require(draw['estate'] == obs['paid_draw_replay']['estate'], 'draw replay changed durable state')
    require(final['estate'] == replay['estate'] and replay['calls']['terminal_replay'] == final['calls']['terminal'],
            'terminal replay changed durable state or receipt')
    for v in values:
        require(not rows(v, 'hand_history') and not rows(v, 'hand_atomic_commits'), 'invented hand evidence')
        require(len(rows(v, 'tournament_refund_entitlements')) == 3, 'paid identity lost')
        mint = one(v, 'ca_mint_ledger')
        require(mint['amount'] == 100 and mint['action'] == 'mint', 'original isolated issue changed')
        club = one(v, 'clubs'); pool = one(v, 'spin_bonus_pools'); escrow = one(v, 'tournament_escrow')
        # Tournament chips are intentionally excluded from this cash equation.
        total = Decimal(str(club['chip_treasury'])) + sum(Decimal(str(x['chip_balance'])) for x in rows(v, 'club_members'))
        total += Decimal(str(pool['balance'])) + sum(Decimal(str(escrow[k])) for k in ('prize_balance','bounty_balance','fee_balance'))
        total += sum(Decimal(str(u[k])) for u in rows(v, 'unions') for k in ('chip_balance','rake_wallet','bbj_wallet','promo_wallet'))
        require(total == 100, 'independent cash conservation differs')
    h = one(final, 'tournament_terminal_settlements'); t = one(final, 'tournaments')
    payout = one(final, 'tournament_payouts'); rake = one(final, 'tournament_rake_settlements')
    require(t['status'] == 'COMPLETED' and h['winner_id'] == winner and h['cash_payout_count'] == 1
            and h['cash_payout_total'] == 2 and h['rake_amount'] == Decimal('.24'), 'final award or fee differs')
    require(payout['user_id'] == winner and payout['amount'] == 2 and payout['tournament_id'] == tournament,
            'one exact winner payment absent')
    require(rake['amount'] == Decimal('.24') and rake['settled_at'] is not None, 'fee settlement absent')
    require(one(final, 'spin_bonus_pools')['balance'] == Decimal('.76')
            and one(final, 'clubs')['chip_treasury'] == 97, 'reserve or treasury differs')
    require({p['position'] for p in rows(final, 'tournament_players')} == {1,2,3}
            and len(rows(final, 'tournament_players')) == 3, 'complete standings absent')
    require(all(s['left_at'] is not None and s['status'] == 'left' for s in rows(final, 'table_seats'))
            and len(rows(final, 'table_seats')) == 3 and one(final, 'tables')['status'] == 'closed', 'seat/table release missing')
    require(all(one(final, 'tournament_escrow')[k] == 0 for k in ('prize_balance','bounty_balance','fee_balance'))
            and one(final, 'tournament_escrow')['closed_at'] is not None, 'escrow did not close')
    require(not rows(final, 'ca_spin_mixed_dispatch_v1') and not rows(final, 'ca_spin_mixed_basis_v1')
            and not rows(final, 'ca_spin_mixed_completion_v1'), 'modern paid entry incorrectly used mixed history admission')
    return {'qualification': 'current_paid_terminal_with_synthetic_finish_input', 'cash_total': '100.00',
            'prize_paid': '2.00', 'fee_settled': '0.24', 'reserve_remaining': '0.76',
            'observations': len(values), 'draw_replay_unchanged': True, 'terminal_replay_unchanged': True,
            'full_financial_qualification': False, 'historical_qualification': False, 'production_qualification': False}


def validate_outputs(source, work, execution, tournament, fee):
    provider_raw = (work / 'paid_launch_provider.stdout').read_bytes()
    provider, = observations(provider_raw)
    capture = decode((source / BASE / 'capture.json').read_bytes())
    require(provider == {'stage': 'modern_launch_provider', 'execution': execution,
            'functions': [{k:v for k,v in f.items() if k != 'definition'} for f in capture['functions']],
            'relations': capture['relations'], 'business_rows_written': False, 'production_qualification': False},
            'provider authority differs from raw capture')
    raw = (work / 'paid_actual_terminal.stdout').read_bytes()
    values = observations(raw)
    rules = decode((source / BASE / 'rules.json').read_bytes())
    summary = validate_observations(values, execution, tournament, rules)
    return {'summary': summary, 'stdout_sha256': sha(raw), 'provider_stdout_sha256': sha(provider_raw)}


def validate_stages(receipt, PG, source, execution, ordinary, tournament, fee, mixed):
    original = fee.body_plan(PG, source, execution, ordinary, tournament)
    plan = body_plan(PG, source, execution, ordinary, tournament, fee, mixed)
    stages = receipt['stages']; names = [s['stage'] for s in stages]
    start = names.index('fee_hand_id_sequence')
    require(names[start:-2] == [name for name,_ in plan], 'exact modern paid stage sequence differs')
    for stage,(name,argv) in zip(stages[start:-2], plan):
        require(stage['stage'] == name and stage['argv'] == argv and type(stage['pid']) is int and stage['pid'] > 0
                and type(stage['returncode']) is int and stage['returncode'] == 0
                and type(stage['terminal_returncode']) is int and stage['terminal_returncode'] == 0
                and 'client_deadline_exceeded' not in stage, 'modern stage role, arguments or result differs')
        for stream in ('stdout','stderr'):
            require(sha((source.parent / 'work' / (name+'.'+stream)).read_bytes()) == stage[stream+'_sha256'],
                    'original modern output changed')
    # Validate every additional original stage above before reusing the older
    # exact baseline validator. This cannot accept an omitted/reordered stage.
    base = deepcopy(receipt)
    old_names = {name for name,_ in original}
    base['stages'] = stages[:start] + [s for s in stages[start:-2] if s['stage'] in old_names] + stages[-2:]
    fee.validate_stages(base, PG, source, execution, ordinary, tournament)
    require(receipt['positive_fee_terminal_qualification'] == validate_outputs(source, source.parent/'work',execution,tournament,fee),
            'summary differs from original modern output')
    return []
