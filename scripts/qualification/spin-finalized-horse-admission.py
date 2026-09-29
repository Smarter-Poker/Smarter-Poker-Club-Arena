"""Finite horse admission regression in the existing owned Spin PG17 allocation.

This module owns no process, restore scheduler, financial repair or release.
A modeled malformed chair is not authentic history or dealt gameplay.
"""
import hashlib
import json
import re
import sys
from copy import deepcopy

IMAGE = 'finalized-horse-admission'
MODULE = 'scripts/qualification/spin-finalized-horse-admission.py'
MANIFEST = 'scripts/qualification/spin-finalized-horse-admission.manifest.json'
BASE = 'scripts/qualification/fixtures/finalized-horse-admission/'
CORE = 'scripts/qualification/fixtures/archived-spin-core-provider/'
MIGRATION = 'supabase/migrations/20260926143705_finalized_horse_seating_preserves_existing_custody.sql'
RACE = 'scripts/qualification/spin-horse-admission-race.py'
INPUTS = (MODULE, MANIFEST, MIGRATION, RACE, 'scripts/qualification/spin-expiry-business-races.py', 'scripts/qualification/fixtures/spin-history-retention/database-state.sql', 'scripts/qualification/spin-horse-platform-paid-entry.sql', 'scripts/qualification/fixtures/spin-paid-terminal/execute.sql', *(BASE + n for n in
          ('owner-capture.json', 'provider.sql', 'prestart-seat.sql', 'closed-seat.sql', 'launch.sql', 'fee-resolution-provider.sql', 'fee-resolution-provider.json', 'generate-fee-resolution-provider.py', 'fee-custody-provider.sql', 'fee-custody-provider.json', 'generate-fee-custody-provider.py', 'core-leaves.json', 'core-leaves.sql', 'seating-receipts.json', 'seating-receipts.sql', 'generate-seating-receipts.py', 'cash-cluster-columns.json', 'cash-cluster-columns.sql')),
          *(CORE + n for n in ('generate.py', 'catalog.json', 'columns.sql', 'constraints.sql', 'triggers.sql', 'readback.sql', 'indexes.sql', 'indexes-readback.sql')))


def require(ok, message):
    if not ok:
        raise ValueError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def decode(raw):
    def unique(pairs):
        answer = {}
        for k, v in pairs:
            require(k not in answer, 'duplicate horse JSON key')
            answer[k] = v
        return answer
    def nonfinite(value):
        raise ValueError('nonfinite horse JSON: ' + value)
    return json.loads(raw, object_pairs_hook=unique, parse_constant=nonfinite)


def validate_sources(files):
    require(set(INPUTS) <= set(files), 'horse source inventory incomplete')
    manifest = decode(files[MANIFEST])
    require(manifest['image'] == IMAGE and manifest['schemaVersion'] == 1
            and manifest['current_provider_qualified'] is False
            and manifest['full_financial_qualification'] is False
            and manifest['historical_qualification'] is False
            and manifest['production_qualification'] is False,
            'horse scope differs')
    require(set(manifest['files']) == set(INPUTS) - {MANIFEST}, 'horse pinned inventory differs')
    for name, pin in manifest['files'].items():
        require(pin == {'bytes': len(files[name]), 'sha256': sha(files[name])},
                'horse source changed: ' + name)
    for row in decode(files[BASE + 'owner-capture.json'])['functions']:
        require(row['definition'].strip() + ';' in files[BASE + 'provider.sql'].decode(),
                'horse provider differs from captured owner')
    for path in ('closed-seat.sql', 'prestart-seat.sql'):
        require(re.findall(r'^\\ir (.+)$', files[BASE + path].decode(), re.M)
                == ['../spin-history-retention/database-state.sql'], 'horse include graph changed')
    expected_launch = files['scripts/qualification/fixtures/spin-paid-terminal/execute.sql'].decode().split('-- Explicit model input, not an actual hand or recovered historical result.')[0]
    expected_launch = expected_launch.replace('-- fee and prize receipts below must be written by their actual authorities.\n-- Two declared synthetic busts supply finish input; no hand history is invented.', '-- draw receipts below must be written by their actual authorities.\n-- This ends at RUNNING: no finish, hand history or prize is invented.')
    expected_launch = expected_launch.replace('INSERT INTO public.club_wallets(club_id) SELECT execution FROM paid_q;',
        'INSERT INTO public.club_wallets(club_id)\nSELECT t.club_id FROM public.tournaments t JOIN paid_q q ON t.id=q.tournament;')
    require(files[BASE + 'launch.sql'].decode() == expected_launch, 'horse real launch prefix differs from qualified terminal owner')


def body_plan(PG, source, execution, ordinary, tournament, fee, terminal, mixed):
    plan = terminal.body_plan(PG, source, execution, ordinary, tournament, fee, mixed)[:-1]
    platform_plan = fee.body_plan(PG, source, execution, ordinary, tournament, platform_board=True)
    plan[-1] = platform_plan[-1]
    def sql(name, path, refuse=None, horse=False):
        argv = fee.sql_argv(PG, source, execution, ordinary, tournament, path)
        if refuse is not None:
            at = argv.index('-c')
            argv[at:at] = ['-v', 'expect_refusal=' + ('true' if refuse else 'false'),
                           '-v', 'horse_profile=' + ('true' if horse else 'false')]
        return name, argv
    overlays = [(name, fee.sql_argv(PG, source, execution, ordinary, tournament, CORE + path,
                    user='fixture_bootstrap')) for name, path in
                [('horse_core_columns', 'columns.sql'), ('horse_core_constraints', 'constraints.sql'),
                 ('horse_core_triggers', 'triggers.sql'), ('horse_core_readback', 'readback.sql'),
                 ('horse_core_indexes', 'indexes.sql'), ('horse_core_indexes_readback', 'indexes-readback.sql')]]
    overlays.append(('horse_cash_cluster_columns', fee.sql_argv(PG, source, execution, ordinary, tournament, BASE + 'cash-cluster-columns.sql', user='fixture_bootstrap')))
    overlays.append(('horse_seating_receipts', fee.sql_argv(PG, source, execution, ordinary, tournament, BASE + 'seating-receipts.sql', user='fixture_bootstrap')))
    overlays.append(('horse_core_leaves', fee.sql_argv(PG, source, execution, ordinary, tournament, BASE + 'core-leaves.sql', user='fixture_bootstrap')))
    overlays.append(('horse_fee_custody_provider', fee.sql_argv(PG, source, execution, ordinary, tournament, BASE + 'fee-custody-provider.sql', user='fixture_bootstrap')))
    overlays.append(('horse_fee_resolution_provider', fee.sql_argv(PG, source, execution, ordinary, tournament, BASE + 'fee-resolution-provider.sql', user='fixture_bootstrap')))
    launch = fee.sql_argv(PG, source, execution, ordinary, tournament, BASE + 'launch.sql')
    at = launch.index('-c')
    launch[at:at] = ['-v', 'rule_manifest=' + (source / terminal.BASE / 'rules.json').read_text()]
    return plan[:-1] + overlays + plan[-1:] + [
                   sql('horse_prestart_owners', BASE + 'provider.sql'),
                   sql('horse_prestart_install', MIGRATION),
                   sql('horse_prestart_ordinary', BASE + 'prestart-seat.sql', False),
                   sql('horse_prestart_horse', BASE + 'prestart-seat.sql', False, True),
                   sql('horse_prestart_restore', BASE + 'provider.sql'),
                   ('horse_actual_launch', launch),
                   sql('horse_captured_owners', BASE + 'provider.sql'),
                   sql('horse_preimage_closed_chair', BASE + 'closed-seat.sql', False),
                   sql('horse_preimage_horse_closed_chair', BASE + 'closed-seat.sql', False, True),
                   sql('horse_install_candidate', MIGRATION),
                   sql('horse_candidate_closed_chair', BASE + 'closed-seat.sql', True),
                   sql('horse_candidate_horse_closed_chair', BASE + 'closed-seat.sql', True, True),
                   ('horse_parent_race',[sys.executable,str(source/RACE),'--psql',str(PG/'psql'),
                       '--execution',execution,'--tournament',tournament,'--player',ordinary])]


def validate_launch(source, work, execution, tournament, terminal, fee):
    """Independently check original real launch output, before modeled chair input."""
    from decimal import Decimal
    raw = (work / 'horse_actual_launch.stdout').read_bytes()
    values = terminal.observations(raw)
    require([v.get('stage') for v in values] == list(terminal.STAGES[:5]),
            'horse real launch observations missing or reordered')
    rules = terminal.decode((source / terminal.BASE / 'rules.json').read_bytes())
    capture = terminal.decode((source / terminal.BASE / 'capture.json').read_bytes())
    oracle = fee.load_oracle(source)
    same = lambda a, b: oracle._jsonb_text(a) == oracle._jsonb_text(b)
    before, refused, draw, replay, running = values
    rows = lambda v, name: v['estate']['public.' + name]
    def one(v, name):
        result, = rows(v, name)
        return result
    for index, value in enumerate(values):
        require(value['execution'] == execution and value['tournament'] == tournament
                and same(value['rules'], rules) and value['winner'] == before['winner']
                and value['launch'] == before['launch'] and value['generation'] == before['generation']
                and value['synthetic_finish_input'] is True
                and all(value[k] is False for k in ('historical_qualification',
                    'full_financial_qualification', 'production_qualification')),
                'horse launch identity or limits differ')
        require(200 < len(value['estate']) <= 400
                and all(isinstance(r, list) and len(r) <= 1000 for r in value['estate'].values()),
                'horse launch bounded estate missing')
        require(one(value, 'tournaments')['status'] == ('RUNNING' if index == 4 else 'REGISTERING')
                and not rows(value, 'hand_history') and not rows(value, 'hand_atomic_commits')
                and not rows(value, 'tournament_terminal_settlements')
                and not rows(value, 'tournament_payouts'), 'launch fabricated finish/history')
        for name in ('wallet_transactions', 'tournament_refund_entitlements',
                     'accounting_tournament_fee_sources', 'club_members', 'ca_mint_ledger'):
            require(same(rows(value, name), rows(before, name)), 'launch changed original paid identity: ' + name)
        pool = one(value, 'spin_bonus_pools'); escrow = one(value, 'tournament_escrow')
        require(one(value,'clubs')['id'] == fee.HOUSE_BOARD
                and one(value,'tournaments')['club_id'] == fee.HOUSE_BOARD
                and one(value,'club_wallets')['club_id'] == fee.HOUSE_BOARD
                and pool['club_id'] == execution, 'house host and union reserve identity differ')
        require(oracle.money(one(value, 'clubs')['chip_treasury']) == 97
                and oracle.money(pool['balance']) == Decimal('2.76' if index < 2 else '.76')
                and [oracle.money(escrow[k]) for k in ('prize_balance','fee_balance','bounty_balance')]
                    == [Decimal(0 if index < 2 else 2), Decimal('.24'), Decimal(0)],
                'horse launch cash custody differs')
    require(not rows(before,'spin_draw_receipts') and not rows(before,'tournament_launch_receipts')
            and len(rows(before,'tournament_refund_entitlements')) == 3
            and len(rows(before,'wallet_transactions')) == 3, 'three original paid entries required')
    require(refused['calls']['wrong_generation'] == {'ok':False,'reason':'launch_lease_lost'}
            and refused['calls']['wrong_format']['ok'] is False
            and refused['calls']['wrong_format']['reason'] == 'launch_format_mismatch',
            'horse real launch invalid authority refusal absent')
    authority, = [f for f in capture['functions'] if f['signature'] == 'fn_spin_draw_multiplier(uuid,numeric,jsonb,numeric,integer)']
    bound_rules = dict(rules, draw_function_md5=authority['definition_md5'])
    receipt = one(draw,'spin_draw_receipts'); launch = one(running,'tournament_launch_receipts')
    require(receipt['tournament_id'] == tournament and receipt['launch_id'] == before['launch']
            and receipt['lease_generation'] == before['generation']
            and same(receipt['rule_manifest'],bound_rules)
            and receipt['rule_sha256'] == sha(oracle._jsonb_text(bound_rules).encode()),
            'horse draw receipt lacks exact authority')
    require(same(draw['estate'],replay['estate']), 'horse draw replay mutated state')
    require(launch['tournament_id'] == tournament and launch['launch_id'] == before['launch']
            and launch['lease_generation'] == before['generation'] and launch['completed_at'] is not None
            and one(running,'tournaments')['started_at'] == launch['started_at']
            and one(running,'tournaments')['prize_pool_finalized'] is False,
            'horse real completed launch boundary absent')
    return {'stdout_sha256':sha(raw), 'observations':5, 'real_launch_completed':True,
            'draw_replay_unchanged':True, 'historical_qualification':False,
            'full_financial_qualification':False, 'production_qualification':False}


def validate_race(value, execution, tournament):
    require(value['execution']==execution and value['tournament']==tournament
            and value['passed'] is True and value['cleanup_verified'] is True
            and value['modeled_chair_closure'] is True
            and value['finalization_transition_qualified'] is False
            and value['full_financial_qualification'] is False and value['production_qualification'] is False
            and type(value['work_deadline_seconds']) is int and value['work_deadline_seconds']==20
            and type(value['cleanup_deadline_seconds']) is int and value['cleanup_deadline_seconds']==5
            and 'failure' not in value and value['backend_cleanup']=={'backends':0,'locks':0}
            and all(type(n) is int for n in value['backend_cleanup'].values()),
            'horse race identity, cleanup or limits differ')
    pids=value['backend_pids']
    require(set(pids)=={'observer','holder','writer'} and len(set(pids.values()))==3
            and all(type(pid) is int and pid>0 for pid in pids.values()), 'horse race backend identities differ')
    require(len(value['clients'])==3 and {c['backend_pid'] for c in value['clients']}==set(pids.values())
            and all(type(c['client_exit']) is int and c['client_exit']==0 and 'cleanup_error' not in c for c in value['clients'])
            and type(value['verifier_client']['client_exit']) is int and value['verifier_client']['client_exit']==0,'horse original clients did not exit')
    require([c['case'] for c in value['cases']]==['existing_live_chair','modeled_closed_chair'],
            'horse race original cases absent')
    for case,expected in zip(value['cases'],({'ok':True,'already_seated':True},
            {'ok':False,'reason':'game_already_started'})):
        require(case['result']==expected and case['before']==case['inside']==case['after']
                and 200<len(case['before']['rows'])<=400 and isinstance(case['before']['sequences'],dict)
                and case['wait']=={'pid':pids['writer'],'wait_event_type':'Lock',
                    'wait_event':'transactionid','blockers':[pids['holder']]},
                'horse parent race outcome/state/original wait differs')
    require(len(value['transcripts'])==3 and all(isinstance(raw,str) and raw
            and not any(bad in raw for bad in ('ERROR:','FATAL:','PANIC:'))
            for raw in value['transcripts'].values()),'horse original transcripts missing/errors')
    return value


def validate_outputs(source, work, execution, tournament):
    raw=(work/'horse_parent_race.stdout').read_bytes()
    answer = {'horse_parent_race':{'observation':validate_race(decode(raw),execution,tournament),
                                  'stdout_sha256':sha(raw)}}
    for candidate, horse, stage in [(False, False, 'horse_preimage_closed_chair'),
            (False, True, 'horse_preimage_horse_closed_chair'),
            (True, False, 'horse_candidate_closed_chair'),
            (True, True, 'horse_candidate_horse_closed_chair')]:
        raw = (work / (stage + '.stdout')).read_bytes()
        values = [decode(line) for line in raw.splitlines() if line.lstrip().startswith(b'{')]
        value, = values
        require(value['stage'] == 'closed_winning_chair' and value['execution'] == execution
                and value['tournament'] == tournament and value['candidate'] is candidate
                and value['horse_profile'] is horse
                and value['synthetic_finish_input'] is True
                and all(value[k] is False for k in ('dealt_gameplay', 'historical_qualification',
                    'full_financial_qualification', 'production_qualification')),
                'horse original observation identity or limits differ')
        require(value['live_replay'] == {'result': {'ok': True, 'already_seated': True},
                'state_unchanged': True, 'sequences_unchanged': True},
                'existing running chair replay changed')
        if candidate:
            require(value['response'] == {'ok': False, 'reason': 'game_already_started'}
                    and value['state_unchanged'] is True and value['sequences_unchanged'] is True,
                    'candidate did not refuse without persistent mutation')
        else:
            require(value['response']['ok'] is True
                    and value['response']['reused_registration'] is True
                    and value['response']['reused_seat'] is True
                    and value['state_unchanged'] is False,
                    'old endpoint defect was not reproduced')
        answer[stage] = {'observation': value, 'stdout_sha256': sha(raw)}
    for horse, stage in [(False, 'horse_prestart_ordinary'), (True, 'horse_prestart_horse')]:
        raw = (work / (stage + '.stdout')).read_bytes()
        value, finalized = [decode(line) for line in raw.splitlines() if line.lstrip().startswith(b'{')]
        require(finalized == {'stage':'finalized_prestart_refusal','execution':execution,
                'tournament':tournament,'horse_profile':horse,
                'response':{'ok':False,'reason':'registration_closed'},
                'state_unchanged':True,'sequences_unchanged':True,
                'modeled_legacy_finalized_flag':True,'historical_qualification':False,
                'full_financial_qualification':False,'production_qualification':False},
                'finalized legacy prestart did not refuse unchanged')
        require(value['stage'] == 'prestart_existing_entry' and value['execution'] == execution
                and value['tournament'] == tournament and value['horse_profile'] is horse
                and value['status'] == 'REGISTERING' and value['money_unchanged'] is True
                and type(value['live_seats']) is int and value['live_seats'] == 3
                and type(value['live_stack']) in (int, float) and value['live_stack'] == 3000
                and value['synthetic_closed_chair'] is True
                and value['full_financial_qualification'] is False and value['production_qualification'] is False,
                'legitimate prestart entry observation differs')
        r = value['response']
        require(r['ok'] is True and r['reused_registration'] is True and r['reused_seat'] is True
                and type(r['stack']) in (int,float) and r['stack'] == 1000,
                'legitimate prestart chair was refused or changed')
        answer[stage] = {'observation': value, 'finalized_boundary':finalized, 'stdout_sha256': sha(raw)}
    return answer


def validate_stages(receipt, PG, source, execution, ordinary, tournament, fee, terminal, mixed):
    original = fee.body_plan(PG, source, execution, ordinary, tournament, platform_board=True)
    plan = body_plan(PG, source, execution, ordinary, tournament, fee, terminal, mixed)
    stages = receipt['stages']
    names = [s['stage'] for s in stages]
    start = names.index('fee_hand_id_sequence')
    require(names[start:-2] == [name for name, _ in plan], 'horse stage sequence differs')
    for stage, (name, argv) in zip(stages[start:-2], plan):
        require(stage['argv'] == argv and type(stage['pid']) is int and stage['pid'] > 0
                and type(stage['returncode']) is int and stage['returncode'] == 0
                and type(stage['terminal_returncode']) is int and stage['terminal_returncode'] == 0
                and 'client_deadline_exceeded' not in stage, 'horse original stage differs: ' + name)
        for stream in ('stdout', 'stderr'):
            require(sha((source.parent / 'work' / (name + '.' + stream)).read_bytes())
                    == stage[stream + '_sha256'], 'horse original stream changed')
    base = deepcopy(receipt)
    old_names = {name for name, _ in original}
    base['stages'] = stages[:start] + [s for s in stages[start:-2] if s['stage'] in old_names] + stages[-2:]
    fee.validate_stages(base, PG, source, execution, ordinary, tournament, platform_board=True)
    require(receipt['finalized_horse_launch'] == validate_launch(source, source.parent / 'work', execution, tournament, terminal, fee), 'horse launch summary differs')
    require(receipt['finalized_horse_qualification'] == validate_outputs(
        source, source.parent / 'work', execution, tournament), 'horse summary differs from original output')
    return []
