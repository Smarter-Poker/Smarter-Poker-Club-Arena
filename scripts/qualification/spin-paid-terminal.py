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
    def number(value):
        result = Decimal(value)
        require(result.is_finite() and abs(result.adjusted()) <= 128
                and len(result.as_tuple().digits) <= 128, 'bounded finite JSON decimal')
        return result
    return json.loads(raw, object_pairs_hook=unique, parse_constant=bad, parse_float=number)


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
                                r'CREATE (?:TABLE|FUNCTION|INDEX)|INSERT 0 [0-9]+|UPDATE [0-9]+|SELECT [0-9]+)', line),
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
    require(len(capture['functions']) == 25 and len(capture['preimage']) == 25
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
              ('paid_catalog_provider', mixed.sql_argv(PG, source, execution, ordinary, tournament,
                  'bootstrap_postgres', mixed.BASE + 'synthetic-provider.sql')),
              sql('paid_pure_install', 'supabase/components/spin-mixed-basis-evidence.sql')]
    additions = [sql('paid_launch_provider', BASE + 'provider.sql'),
                 sql('paid_doctrine_restore', mixed.BASE + 'doctrine-successor-restore.sql'),
                 sql('paid_current_lane_install', mixed.LANE),
                 sql('paid_terminal_install', mixed.COMPONENT)]
    return original[:1] + prefix + original[1:-1] + additions + original[-1:] + [
        sql('paid_actual_terminal', BASE + 'execute.sql', rules=True)]


def validate_observations(values, execution, tournament, rules, capture, oracle):
    money = oracle.money
    same = lambda a, b: oracle._jsonb_text(a) == oracle._jsonb_text(b)
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
    draw_authority, = [f for f in capture['functions']
                      if f['signature'] == 'fn_spin_draw_multiplier(uuid,numeric,jsonb,numeric,integer)']
    # The captured real draw binds its own function body to the supplied rules.
    bound_rules = dict(rules, draw_function_md5=draw_authority['definition_md5'])
    require(receipt['tournament_id'] == tournament and receipt['launch_id'] == before['launch']
            and receipt['lease_generation'] == before['generation'] and same(receipt['rule_manifest'], bound_rules)
            and receipt['rule_sha256'] == sha(oracle._jsonb_text(bound_rules).encode()),
            'draw has wrong launch, lease or rules')
    require(launch['tournament_id'] == tournament and launch['launch_id'] == before['launch']
            and launch['lease_generation'] == before['generation'] and launch['completed_at'] is not None
            and one(running, 'tournaments')['started_at'] == launch['started_at']
            and one(running, 'tournaments')['status'] == 'RUNNING', 'real completed launch missing')
    require(draw['estate'] == obs['paid_draw_replay']['estate'], 'draw replay changed durable state')
    require(final['estate'] == replay['estate'] and replay['calls']['terminal_replay'] == final['calls']['terminal'],
            'terminal replay changed durable state or receipt')
    original_ledger = {r['id']:r for r in rows(before, 'chip_ledger')}
    original_debits = {r['id']:r for r in rows(before, 'wallet_transactions')}
    require(len(original_debits) == 3 and all(r['type'] == 'debit' and money(r['amount']) == 1
            and r['terminal_closed_at'] is None for r in original_debits.values()), 'original paid debits absent')
    expected_status = ('REGISTERING','REGISTERING','REGISTERING','REGISTERING','RUNNING','RUNNING',
                       'COMPLETING','COMPLETED','COMPLETED')
    for index, v in enumerate(values):
        terminal = index >= 7
        require(not rows(v, 'hand_history') and not rows(v, 'hand_atomic_commits'), 'invented hand evidence')
        require(same(rows(v, 'tournament_refund_entitlements'), paid), 'paid identity changed')
        require(one(v, 'tournaments')['status'] == expected_status[index], 'lifecycle stage differs')
        ledger = {r['id']:r for r in rows(v, 'chip_ledger')}
        require(len(ledger) == len(rows(v,'chip_ledger')), 'duplicate financial journal identity')
        require(all(k in ledger and same(r, ledger[k]) for k,r in original_ledger.items()),
                'original financial journal changed')
        transactions = {r['id']:r for r in rows(v, 'wallet_transactions')}
        require(len(transactions) == len(rows(v,'wallet_transactions')) == (4 if terminal else 3),
                'unexpected wallet transaction count')
        for k, r in original_debits.items():
            expected = dict(r, terminal_closed_at=one(v,'tournament_terminal_settlements')['completed_at']) if terminal else r
            require(k in transactions and same(expected, transactions[k]), 'original wallet debit changed')
        mint = one(v, 'ca_mint_ledger')
        require(money(mint['amount']) == 100 and same(mint, one(before,'ca_mint_ledger')), 'original isolated issue changed')
        club = one(v, 'clubs'); pool = one(v, 'spin_bonus_pools'); escrow = one(v, 'tournament_escrow')
        # Tournament chips are intentionally excluded from this cash equation.
        total = money(club['chip_treasury']) + sum(money(x['chip_balance']) for x in rows(v, 'club_members'))
        total += money(pool['balance']) + sum(money(escrow[k]) for k in ('prize_balance','bounty_balance','fee_balance'))
        total += sum(money(u[k]) for u in rows(v, 'unions') for k in ('chip_balance','rake_wallet','bbj_wallet','promo_wallet'))
        total += sum(money(u[k]) for u in rows(v, 'union_wallets') for k in
                     ('chip_balance','rake_wallet','bbj_wallet','promo_wallet','insurance_wallet','spin_reserve_wallet'))
        total += sum(money(c[k]) for c in rows(v,'club_wallets') for k in ('chip_balance','insurance_balance'))
        require(total == 100, 'independent cash conservation differs')
        balances = {p['user_id']: money(p['chip_balance']) for p in rows(v,'club_members')}
        require(balances == {p['user_id']: Decimal(2 if terminal and p['user_id']==winner else 0) for p in paid},
                'member cash distribution differs')
        require(money(club['chip_treasury']) == 97 and money(pool['balance']) == Decimal('2.76' if index < 2 else '.76'),
                'treasury or reserve distribution differs')
        require([money(escrow[k]) for k in ('prize_balance','fee_balance','bounty_balance')]
                == [Decimal(0 if terminal or index<2 else 2), Decimal(0 if terminal else '.24'), Decimal(0)],
                'escrow custody differs')
        require(same(rows(v,'unions'), rows(before,'unions')), 'legacy Union balance changed')
        require(not rows(v,'union_wallets') if not terminal else money(one(v,'union_wallets')['rake_wallet']) == Decimal('.24'),
                'fee banking timing differs')
        require(all(not rows(v, n) for n in ('wallets','tournament_refund_tranches','tournament_refund_authorizations','agents',
                'ca_spin_mixed_dispatch_v1','ca_spin_mixed_basis_v1','ca_spin_mixed_completion_v1')),
                'unexpected alternate custody or mixed admission')
    h = one(final, 'tournament_terminal_settlements'); t = one(final, 'tournaments')
    payout = one(final, 'tournament_payouts'); rake = one(final, 'tournament_rake_settlements')
    oracle.fields(h, tournament_id=tournament, winner_id=winner, cash_payout_count=1,
                  cash_payout_total=2, rake_amount=Decimal('.24'), rake_attributed_users=3,
                  source_seat_count=3, released_seat_count=3, closed_table_count=1)
    oracle.fields(payout, user_id=winner, amount=2, tournament_id=tournament)
    oracle.fields(rake, amount=Decimal('.24'), tournament_id=tournament)
    require(t['status'] == 'COMPLETED' and h['winner_id'] == winner and h['cash_payout_count'] == 1
            and h['cash_payout_total'] == 2 and h['rake_amount'] == Decimal('.24'), 'final award or fee differs')
    require(payout['user_id'] == winner and payout['amount'] == 2 and payout['tournament_id'] == tournament,
            'one exact winner payment absent')
    require(rake['amount'] == Decimal('.24') and rake['settled_at'] is not None, 'fee settlement absent')
    require(h['accounting_state'] == 'recognized' and h['rake_attributed_users'] == 3
            and h['rake_attributed_at'] is not None and h['rake_destination'] == 'union:'+execution,
            'complete fee attribution absent')
    union = one(final,'union_wallets'); bank = one(final,'union_wallet_transactions')
    recognition = one(final,'accounting_tournament_fee_recognitions')
    require(union['union_id'] == execution and money(union['rake_wallet']) == Decimal('.24')
            and money(union['total_rake_collected']) == Decimal('.24')
            and all(money(union[k]) == 0 for k in ('chip_balance','bbj_wallet','promo_wallet','insurance_wallet','spin_reserve_wallet')),
            'bank custody differs')
    require(bank['union_id'] == execution and bank['club_id'] == execution and bank['wallet'] == 'rake_wallet'
            and bank['direction'] == 'credit' and bank['tx_type'] == 'rake'
            and money(bank['amount']) == Decimal('.24') and money(bank['balance_after']) == Decimal('.24'),
            'fee bank transaction differs')
    require(recognition['tournament_id'] == tournament and recognition['status'] == 'recognized'
            and recognition['union_id'] == execution and recognition['bank_club_id'] == execution
            and recognition['union_wallet_transaction_id'] == bank['id'] and money(recognition['net_rake']) == Decimal('.24'),
            'recognition does not bind actual bank receipt')
    sources = rows(final,'accounting_tournament_fee_sources'); recognized = rows(final,'accounting_tournament_recognized_sources')
    require(same(sources, rows(before,'accounting_tournament_fee_sources')) and len(sources) == 3
            and len(recognized) == 3 and {r['source_id'] for r in recognized} == {s['id'] for s in sources}
            and all(r['tournament_id'] == tournament and r['disposition'] == 'earned'
                    and money(r['rake_credit']) == Decimal('.08') for r in recognized), 'per-player fee recognition differs')
    credit, = [r for r in rows(final,'wallet_transactions') if r['id'] not in original_debits]
    require(credit['user_id'] == winner and credit['type'] == 'credit' and credit['category'] == 'prize'
            and credit['related_entity_id'] == tournament and money(credit['amount']) == 2
            and money(credit['balance_after']) == 2, 'winner wallet credit differs')
    additions = [r for r in rows(final,'chip_ledger') if r['id'] not in original_ledger]
    require(len(additions) == 3 and {(r['from_type'],r['to_type'],money(r['amount'])) for r in additions}
            == {('spin_reserve','prize_liability',Decimal(2)),('prize_liability','player_wallet',Decimal(2)),
                ('prize_liability','union_wallet',Decimal('.24'))}
            and all(r['tournament_id'] == tournament and r['status'] == 'posted' for r in additions),
            'draw prize and fee journals differ')
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


def negative_controls(values, execution, tournament, rules, capture, oracle):
    """Reject corruptions of the actual native observations, never seeded proof.

    Mutate both terminal observations together so replay equality cannot hide
    a missing independent invariant. No original evidence is changed.
    """
    controls = [
        ('clubs','chip_treasury',Decimal('96.99')),
        ('club_members','chip_balance','0.00'),
        ('club_members','chip_balance',False),
        ('spin_bonus_pools','balance',Decimal('.77')),
        ('tournament_escrow','prize_balance',Decimal('.01')),
        ('union_wallets','rake_wallet',Decimal('.23')),
        ('union_wallets','insurance_wallet',Decimal('.01')),
        ('union_wallets','union_id',tournament),
        ('union_wallets','total_rake_collected',Decimal('.23')),
        ('union_wallet_transactions','amount',Decimal('.23')),
        ('union_wallet_transactions','direction','debit'),
        ('union_wallet_transactions','wallet','promo_wallet'),
        ('union_wallet_transactions','club_id',tournament),
        ('accounting_tournament_fee_recognitions','union_wallet_transaction_id',tournament),
        ('accounting_tournament_fee_recognitions','status','unknown'),
        ('accounting_tournament_recognized_sources','rake_credit',Decimal('.07')),
        ('accounting_tournament_recognized_sources','source_id',tournament),
        ('accounting_tournament_recognized_sources','disposition','refunded'),
        ('tournament_refund_entitlements','gross',Decimal('.99')),
        ('chip_ledger','amount',Decimal('.01')),
        ('wallet_transactions','amount',Decimal('.01')),
        ('tournament_terminal_settlements','cash_payout_count',True),
        ('tournament_terminal_settlements','rake_attributed_users',2),
        ('tournament_terminal_settlements','rake_attributed_at',None),
        ('tournament_terminal_settlements','source_seat_count',2),
        ('tournament_payouts','user_id',tournament),
        ('tournament_payouts','amount',Decimal('1.99')),
        ('tournament_rake_settlements','settled_at',None),
        ('table_seats','left_at',None),
        ('tables','status','active'),
    ]
    rejected = []
    def must_refuse(label, changed):
        try:
            validate_observations(changed, execution, tournament, rules, capture, oracle)
        except ValueError:
            rejected.append(label)
            return
        raise AssertionError('corrupt paid terminal evidence accepted: '+label)
    for table, key, value in controls:
        changed = deepcopy(values)
        for v in changed[-2:]:
            v['estate']['public.'+table][0][key] = value
        must_refuse(table+'.'+key+':'+str(value), changed)
    for table in ('union_wallet_transactions','accounting_tournament_recognized_sources',
                  'tournament_payouts','wallet_transactions'):
        for duplicate in (False,True):
            changed = deepcopy(values)
            for v in changed[-2:]:
                rows = v['estate']['public.'+table]
                if duplicate: rows.append(deepcopy(rows[0]))
                else: rows.pop()
            must_refuse(table+(':duplicate' if duplicate else ':missing'), changed)
    for field, value in (('rule_sha256','f'*64),('rule_manifest',rules),('lease_generation',tournament)):
        changed = deepcopy(values)
        for v in changed[2:]:
            v['estate']['public.spin_draw_receipts'][0][field] = value
        must_refuse('draw.'+field, changed)
    for index in range(len(values)):
        changed = deepcopy(values); changed.pop(index)
        must_refuse('missing:'+values[index]['stage'], changed)
    require(len(rejected) == 50, 'negative control count differs')
    return rejected


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
    oracle = fee.load_oracle(source)
    summary = validate_observations(values, execution, tournament, rules, capture, oracle)
    rejected = negative_controls(values, execution, tournament, rules, capture, oracle)
    return {'summary': summary, 'negative_controls': rejected,
            'stdout_sha256': sha(raw), 'provider_stdout_sha256': sha(provider_raw)}


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
