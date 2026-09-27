"""Finite authentic first-event diagnostic inside the existing Spin allocator.

Owns no process lifecycle and accepts no database target. Successful diagnostic
execution is not financial, historical-completion or production qualification.
"""
from pathlib import Path
import copy
import sys
import importlib.util
import re
import hashlib
import json
from decimal import Decimal

IMAGE = 'first-archived-spin'
BANK_IMAGE = 'first-archived-spin-bank-mvcc'
IMAGES=(IMAGE,BANK_IMAGE)
BANK_OBSERVER='scripts/qualification/spin-first-archived-bank-observer.py'
BANK_RACES='scripts/qualification/spin-first-archived-bank-races.py'
BANK_TEST='scripts/qualification/test_first_archived_bank_observer.py'
MODULE = 'scripts/qualification/spin-first-archived.py'
MANIFEST = 'scripts/qualification/spin-first-archived.manifest.json'
BASE = 'scripts/qualification/fixtures/archived-spin/'
CORE = BASE+'seed-core/'
EVENT = '2aa4cba1-506f-426b-a1ba-d8e22e018533'
SEED = ('full-columns.sql', 'first-captured-seed.sql', 'first-temporal-seed.sql')
PROVIDER = ('full-functions.sql', 'fee-resolution-provider.sql', 'full-constraints.sql',
            'full-triggers.sql', 'full-access.sql', 'full-sequences.sql',
            'full-indexes.sql', 'full-readback.sql', 'seating-receipts.sql', 'schema-authority.sql', 'first-manager-release-provider.sql')
LOCKS = 'scripts/qualification/spin-first-archived-locks.py'
LOCKS_TEST = 'scripts/qualification/test_first_archived_locks.py'
PRODUCTION_PROBE = 'scripts/qualification/spin-first-archived-production-probe.py'
PRODUCTION_PROBE_TEST = 'scripts/qualification/test_first_archived_production_probe.py'
PRODUCTION_PROBE_SQL = 'scripts/qualification/fixtures/archived-spin/first-production-rollback-probe.sql'
CONCURRENCY = 'scripts/qualification/spin-first-archived-concurrency.py'
CONCURRENCY_TEST = 'scripts/qualification/test_first_archived_concurrency.py'
MIGRATION = 'supabase/migrations/20260927005812_first_archived_spin_canonical_terminal.sql'
COMPONENTS = tuple('supabase/components/spin-archived-first-'+n+'.sql' for n in ('witness','admission','bridge'))
POSTABORT='scripts/qualification/spin-first-archived-postabort.py'
POSTABORT_TEST='scripts/qualification/test_first_archived_postabort.py'
POSTABORT_SQL=BASE+'first-postabort-bank-readback.sql'
INPUTS = (MODULE, MANIFEST, POSTABORT, POSTABORT_TEST, POSTABORT_SQL, BANK_OBSERVER, BANK_RACES, BANK_TEST, CONCURRENCY, CONCURRENCY_TEST, LOCKS, LOCKS_TEST, PRODUCTION_PROBE, PRODUCTION_PROBE_TEST, PRODUCTION_PROBE_SQL, 'scripts/qualification/test_first_archived_oracle.py', CORE+'columns.sql', CORE+'catalog.json', MIGRATION, *COMPONENTS,
          *(BASE+n for n in (*SEED, *PROVIDER, 'first-captured-state.json',
            'full-provider-catalog.json', 'full-authority-catalog.json',
            'index-sequence-catalog.json', 'fee-resolution-provider.json',
            'seating-receipts.json', 'schema-authority.json', 'original-launch-refusal.sql',
            'first-connected-probe.sql', 'first-temporal-state.json', 'first-temporal-refusal.sql',
            'first-manager-state.json', 'first-manager-proof.sql', 'first-funding-observation.sql', 'first-negative-cases.sql', 'first-atomic-failures.sql', 'first-preimage-drift.sql')))

def require(value, message):
    if not value: raise ValueError(message)

def digest(data): return hashlib.sha256(data).hexdigest()

def decode(raw):
    def unique(pairs):
        result={}
        for key,value in pairs:
            require(key not in result, 'duplicate archived JSON key')
            result[key]=value
        return result
    def nonfinite(value): raise ValueError('nonfinite archived JSON: '+value)
    return json.loads(raw,object_pairs_hook=unique,parse_constant=nonfinite,parse_float=Decimal)


def validate_sources(files):
    require(set(INPUTS) <= set(files), 'first archived source inventory incomplete')
    manifest = decode(files[MANIFEST])
    require(manifest['image'] == IMAGE and manifest['schemaVersion'] == 1
            and manifest['financial_qualified'] is False
            and manifest['production_qualified'] is False,
            'first archived scope changed')
    require(set(manifest['files']) == set(INPUTS)-{MANIFEST}, 'first archived pin inventory differs')
    for path in set(INPUTS)-{MANIFEST}:
        require(manifest['files'][path] == {'bytes':len(files[path]),'sha256':digest(files[path])},
                'first archived source changed: '+path)
    migration=files[MIGRATION].decode()
    require(len(re.findall(r'^BEGIN;$',migration,re.M))==1 and len(re.findall(r'^COMMIT;$',migration,re.M))==1,
            'first migration is not one transaction')
    for index,path in enumerate(COMPONENTS):
        marker='-- Component: '+path+'\n'
        require(migration.count(marker)==1,'first migration component marker differs')
        actual=migration.split(marker,1)[1]
        actual=actual.split('-- Component: ',1)[0] if index<2 else re.sub(r'\nCOMMIT;\s*$', '',actual)
        expected=re.sub(r'^(?:BEGIN|COMMIT);\n?', '',files[path].decode(),flags=re.M)
        require(actual.strip()==expected.strip(),'first migration component bytes differ: '+path)
    require(b'ROLLBACK;' in files[BASE+'first-connected-probe.sql']
            and b'COMMIT;' not in files[BASE+'first-connected-probe.sql'],
            'first diagnostic may not commit financial operations')

def sql_argv(PG, source, execution, path, *, variables=()):
    # The existing allocator owns this private socket, database and execution.
    argv=[str(PG/'psql'),'-X','-w','-A','-t','-h',str(source.parent/'work/socket'),
          '-p','5432','-U','fixture_bootstrap','-d','qual_spin_expiry_'+execution.replace('-',''),
          '-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-v','execution_uuid='+execution]
    for key,value in variables: argv += ['-v',key+'='+value]
    return argv+['-f',str(source/path)]

def seed_plan(PG, source, execution, ordinary, tournament):
    return [('archive_core_columns',sql_argv(PG,source,execution,CORE+'columns.sql')),
            ('archive_full_columns',sql_argv(PG,source,execution,BASE+'full-columns.sql')),
            ('archive_original_seed',sql_argv(PG,source,execution,BASE+'first-captured-seed.sql',
                variables=(('archive_state_json',(source/BASE/'first-captured-state.json').read_text()),))),
            ('archive_temporal_seed',sql_argv(PG,source,execution,BASE+'first-temporal-seed.sql'))]

def body_plan(PG, source, execution, ordinary, tournament, image=IMAGE):
    require(image in IMAGES,'unknown archive variant')
    # Invoke after real suffix, captured baseline access/policies, notification
    # supplement and tested roles. Do not run paid/synthetic entry supplements or
    # baseline empty/current catalog checks: this event deliberately has history
    # in original rows, and exact current captured catalog readback follows here.
    plan=[('archive_'+name.replace('.','_').replace('-','_'),sql_argv(PG,source,execution,BASE+name))
          for name in PROVIDER]
    plan.append(('archive_manager_proof',sql_argv(PG,source,execution,BASE+'first-manager-proof.sql')))
    plan.append(('archive_temporal_refusal',sql_argv(PG,source,execution,BASE+'first-temporal-refusal.sql')))
    plan.append(('archive_original_refusal',sql_argv(PG,source,execution,BASE+'original-launch-refusal.sql')))
    plan.append(('archive_install_migration',sql_argv(PG,source,execution,MIGRATION)))
    plan.append(('archive_funding_observation',sql_argv(PG,source,execution,BASE+'first-funding-observation.sql')))
    plan.append(('archive_negative_cases',sql_argv(PG,source,execution,BASE+'first-negative-cases.sql')))
    plan.append(('archive_preimage_drift',sql_argv(PG,source,execution,BASE+'first-preimage-drift.sql')))
    plan.append(('archive_atomic_failures',sql_argv(PG,source,execution,BASE+'first-atomic-failures.sql')))
    plan.append(('archive_connected_rollback',sql_argv(PG,source,execution,BASE+'first-connected-probe.sql')))
    probe_args=[sys.executable,'-B',str(source/PRODUCTION_PROBE),'--psql',str(PG/'psql'),'--execution',execution]
    if image==BANK_IMAGE:
        plan.append(('archive_production_probe',probe_args+['--bank-races']))
        return plan
    plan.append(('archive_production_probe',probe_args))
    plan.append(('archive_admission_locks',[sys.executable,'-B',str(source/LOCKS),'--psql',str(PG/'psql'),'--execution',execution]))
    plan.append(('archive_concurrency_commit',[sys.executable,'-B',str(source/CONCURRENCY),'--psql',str(PG/'psql'),'--execution',execution]))
    return plan

def validate_account_delta(before, after, *, bank_observations=None):
    relations={'public.club_members','public.clubs','public.unions','public.union_wallets','public.spin_bonus_pools'}
    require(isinstance(before,dict) and isinstance(after,dict) and set(before)==relations and set(after)==relations,
            'first account store inventory differs')
    if bank_observations is not None:
        spec=importlib.util.spec_from_file_location('account_bank_observer',Path(__file__).with_name('spin-first-archived-bank-observer.py'))
        bank=importlib.util.module_from_spec(spec);spec.loader.exec_module(bank)
        bank.validate_history(bank_observations,bank_observations[0]['transaction_id'],before[bank.RELATION],after[bank.RELATION])
    found=0
    for name in sorted(relations):
        require(isinstance(before[name],list) and isinstance(after[name],list), 'first account rows malformed')
        def indexed(rows):
            result={}
            for row in rows:
                key=(row.get('id'),row.get('club_id'),row.get('user_id'))
                require(any(key) and key not in result,'first duplicate account identity')
                result[key]=row
            return result
        expected=copy.deepcopy(indexed(before[name])); actual=indexed(after[name])
        if name=='public.club_members':
            for row in expected.values():
                if row.get('user_id')=='aef849b8-2906-4dc0-b108-251710e76d3c' and row.get('club_id')=='a41434bb-8d0c-400a-8f0d-e8b3d65afed4':
                    require(type(row.get('chip_balance')) in (int,Decimal), 'first wallet amount malformed')
                    row['chip_balance']+=200; found+=1
        if name=='public.union_wallets' and bank_observations is not None:continue
        require(actual==expected,'first unexpected account mutation: '+name)
    require(found==1,'first original winner funding account absent')

def validate_fee_notice(stderr):
    notices=re.findall(r'NOTICE:  00000: (.*)',stderr)
    require(notices==['pre-cutover fee 6d13847d-cbe2-473c-94e5-34dad1ce3efb left uncaptured: cash_commission_earning_club_not_observed (23514)']
            and 'ERROR:' not in stderr and 'WARNING:' not in stderr,
            'first actual fee refusal was not the original temporal refusal')

def validate_journal_and_chairs(state):
    require(isinstance(state['reserve_before'],list) and state['reserve_before']==state['reserve_after'], 'first reserve journal changed')
    def indexed(rows):
        require(isinstance(rows,list),'first journal/chair rows malformed')
        result={}
        for row in rows:
            require(isinstance(row,dict) and row.get('id') and row['id'] not in result,'first duplicate journal/chair identity')
            result[row['id']]=row
        return result
    old=indexed(state['ledger_before']); new=indexed(state['ledger_after'])
    require(all(k in new and new[k]==v for k,v in old.items()),'first original chip journal changed')
    added=[v for k,v in new.items() if k not in old]
    require(len(added)==1,'first canonical credit journal count differs')
    credit=added[0]
    require(type(credit.get('amount')) in (int,Decimal) and credit['amount']==200
            and credit.get('tournament_id')==EVENT and credit.get('club_id')=='a41434bb-8d0c-400a-8f0d-e8b3d65afed4'
            and credit.get('category')=='tournament_prize' and credit.get('from_type')=='prize_liability'
            and credit.get('from_entity_id')==EVENT and credit.get('to_type')=='player_wallet'
            and credit.get('to_entity_id')=='aef849b8-2906-4dc0-b108-251710e76d3c', 'first canonical credit journal scope differs')
    require(all(type(state[k]) is int and state[k]==0 for k in ('history_count','atomic_commit_count')),'first invented history or atomic commit')
    old=indexed(state['seats_before']); new=indexed(state['seats_after'])
    require(set(old)==set(new) and len(old)==3,'first original chair identities differ')
    allowed={'left_at','status','leave_pending','is_sitting_out','is_away','sit_out_at','scheduled_leave_hands','updated_at','terminal_closed_at','active_game_scope','active_parent_key'}
    terminal=state['terminal']; completed=terminal.get('completed_at')
    require(isinstance(completed,str) and completed and terminal.get('settled_at')==completed,
            'first canonical completion time absent')
    require(terminal.get('source_seat_count')==3 and sorted(terminal.get('source_seat_ids',[]))==sorted(old)
            and terminal.get('released_seat_count')==1 and terminal.get('released_seat_ids')==[k for k,r in old.items() if r.get('left_at') is None],
            'first canonical chair release receipt differs')
    for key,before in old.items():
        after=new[key]
        require({k:v for k,v in before.items() if k not in allowed}=={k:v for k,v in after.items() if k not in allowed},'first unrelated chair data changed')
        require(after.get('left_at') is not None and after.get('status')=='left'
                and all(after.get(k) is False for k in ('leave_pending','is_sitting_out','is_away'))
                and after.get('sit_out_at') is None and after.get('scheduled_leave_hands') is None,'first chair remains active')
        require(after.get('terminal_closed_at')==completed and after.get('active_game_scope') is None
                and after.get('active_parent_key') is None,'first chair closure marker or generated scope differs')
        if before.get('left_at') is None: require(after['left_at']==completed,'first new departure differs from terminal')
        if before.get('left_at') is not None: require(before['left_at']==after['left_at'],'first original departure changed')
    table=state['primary_table']
    require(table.get('id')=='6eaddeaf-1511-4265-bb38-37811ae82ad9' and table.get('tournament_id')==EVENT
            and table.get('status')=='closed' and table.get('lifecycle')=='closed'
            and table.get('terminal_closed_at')==completed and type(table.get('current_players')) is int and table['current_players']==0,'first table did not close')

def validate_outputs(source,work,execution,tournament,image=IMAGE):
    funding=[decode(line) for line in (work/'archive_funding_observation.stdout').read_bytes().splitlines() if line.startswith(b'{')]
    require(len(funding)==1 and funding[0]['stage']=='first_original_funding_observation'
            and funding[0]['execution']==execution and funding[0]['event']==EVENT
            and funding[0]['actual']==funding[0]['expected'], 'original funding observed proof differs')
    negatives=[decode(line) for line in (work/'archive_negative_cases.stdout').read_bytes().splitlines() if line.startswith(b'{')]
    require(len(negatives)==1 and negatives[0]['execution']==execution and negatives[0]['stage']=='first_archived_negative_cases', 'first negative case receipt absent')
    require(all(negatives[0][k] is True for k in ('anon_denied','authenticated_denied','wrong_source_denied','null_operation_denied','actual_competing_lease_denied','economic_rows_unchanged','service_acl_wrong_jwt_denied','abi_authority_immutable','actual_freeze_denied'))
            and negatives[0]['financial_qualified'] is False and negatives[0]['production_qualified'] is False,
            'first negative case failed')
    require(not (work/'archive_negative_cases.stderr').read_text().strip(), 'first negative case unexpected diagnostic')
    drift=[decode(line) for line in (work/'archive_preimage_drift.stdout').read_bytes().splitlines() if line.startswith(b'{')]
    require(len(drift)==1 and drift[0]['execution']==execution and drift[0]['stage']=='first_archived_preimage_drift'
            and drift[0]['changed_parent_refused'] is True and drift[0]['whole_rows_unchanged_inside_and_after'] is True
            and drift[0]['financial_qualified'] is False and drift[0]['production_qualified'] is False,
            'first changed original preimage not refused')
    require(not (work/'archive_preimage_drift.stderr').read_text().strip(),'first preimage drift unexpected diagnostic')
    atomic=[decode(line) for line in (work/'archive_atomic_failures.stdout').read_bytes().splitlines() if line.startswith(b'{')]
    require(len(atomic)==1 and atomic[0]['execution']==execution and atomic[0]['stage']=='first_archived_atomic_failures', 'first atomic failure receipt absent')
    require(all(atomic[0][k] is True for k in ('late_failure_after_real_credit','deferred_admission_requires_terminal','whole_rows_unchanged_inside_and_after'))
            and all(atomic[0][k] is False for k in ('sequence_rollback_claimed','financial_qualified','production_qualified')), 'first atomic rollback failed')
    validate_fee_notice((work/'archive_atomic_failures.stderr').read_text())
    raw=(work/'archive_connected_rollback.stdout').read_bytes()
    values=[decode(line) for line in raw.splitlines() if line.startswith(b'{')]
    require([x['stage'] for x in values] == ['first_archived_terminal_before_rollback','first_archived_state_before_rollback','first_archived_after_rollback'],
            'first archived connected observations absent')
    require(all(x['execution']==execution for x in values), 'first archived execution identity differs')
    require(values[-1]['economic_rows_unchanged'] is True and values[-1]['admission_absent'] is True
            and values[-1]['terminal_absent'] is True and values[-1]['lease_absent'] is True,
            'first archived rollback proof absent')
    require(values[0]['event']==EVENT and values[0]['response'].get('ok') is True,
            'first archived terminal did not return success')
    require(values[1]['wallet_delta']==200, 'first original funding club wallet credit differs')
    roster=values[1]['players']
    require(isinstance(roster,list) and len(roster)==3,'first original roster must have exactly three rows')
    players={p['user_id']:p for p in roster}
    expected={'aef849b8-2906-4dc0-b108-251710e76d3c':(1,200),
              '036f0b55-c601-4d09-982a-5294cf4ea15d':(2,0),
              '72f2fedb-a5f9-4d10-b147-d92e18102d3f':(3,0)}
    require(set(players)==set(expected),'first original roster identity differs')
    original_ids={'aef849b8-2906-4dc0-b108-251710e76d3c':'06377b59-94e6-4663-9fc0-5dba12675b9d','036f0b55-c601-4d09-982a-5294cf4ea15d':'bcab2749-47c7-4617-9d72-9e56de4eb616','72f2fedb-a5f9-4d10-b147-d92e18102d3f':'1350d845-cdf8-41ad-86bf-abf2f2460cab'}
    for user,(place,prize) in expected.items():
        require(players[user]['id']==original_ids[user] and players[user]['tournament_id']==EVENT
                and players[user]['club_id']=='a41434bb-8d0c-400a-8f0d-e8b3d65afed4', 'first original roster scope differs')
        require(type(players[user]['position']) is int and type(players[user]['prize']) in (int,Decimal), 'first roster amount malformed')
        require((players[user]['position'],players[user]['prize'])==(place,prize),
                'first recorded place/prize differs: '+user)
    escrow=values[1]['escrow']
    require(all(type(escrow[k]) in (int,Decimal) for k in ('prize_balance','bounty_balance','fee_balance')), 'first escrow amount malformed')
    require(escrow['prize_balance']==0 and escrow['bounty_balance']==0
            and escrow['fee_balance']==24 and escrow['closed_at'] is None, 'first terminal escrow custody differs')
    require(isinstance(values[1]['terminal'],dict),'first canonical terminal receipt absent')
    response=values[0]['response']; state=values[1]
    require(response['tournament_id']==EVENT and response['winner_id']=='aef849b8-2906-4dc0-b108-251710e76d3c'
            and response['status']=='COMPLETED' and response['winner_amount']==200 and response['cash_payout_total']==200
            and response['bounty_payout_total']==0 and response['receipt_version']==3
            and response['fully_settled'] is False and response['accounting_complete'] is False
            and response['accounting_state']=='fee_custody_unresolved', 'first canonical player/fee outcome differs')
    terminal=state['terminal']
    require(terminal.get('tournament_id')==EVENT and terminal.get('winner_id')==response['winner_id']
            and terminal.get('receipt_version')==3 and terminal.get('accounting_state')=='fee_custody_unresolved'
            and terminal.get('cash_payout_count')==1 and terminal.get('cash_payout_total')==200
            and terminal.get('rake_amount')==24 and terminal.get('rake_destination')=='tournament_escrow'
            and terminal.get('escrow_closed_at') is None, 'first stored canonical terminal differs')
    rake=response['rake']; custody=rake['accounting']
    require(rake['amount']==24 and rake['destination']=='tournament_escrow' and rake['attributed'] is False
            and rake['attributed_users']==0 and rake['settled_at'] is None and rake['attributed_at'] is None,
            'first rake was banked or attributed')
    exact={'accounting_version':3,'tournament_id':EVENT,'status':'fee_custody_unresolved','player_result':'final',
           'payable':False,'accounting_complete':False,'resolution':None,'current_held_amount':24,'held_amount':24,
           'source_fingerprint':'bfb56dac635bc7a238383d785ea88f35','source_count':1,
           'reason':'tournament_fee_sources_require_reconciliation','custody_store':'tournament_escrow',
           'recognized_source_count':0,'bank_amount':0,'banked_at':None,'bank_receipt_id':None}
    require(all(k in custody and custody[k]==v and (type(custody[k]) is bool if type(v) is bool else type(custody[k]) in (int,Decimal) if type(v) is int else True) for k,v in exact.items()),
            'first exact unresolved custody differs')
    obligations=state['custody_obligations']
    require(isinstance(obligations,list) and len(obligations)==1,'first custody obligation count differs')
    obligation=obligations[0]
    require(obligation['id']==custody['obligation_id'] and obligation['tournament_id']==EVENT
            and obligation['amount']==24 and obligation['source_fingerprint']==exact['source_fingerprint']
            and obligation['reason']==exact['reason'], 'first custody receipt is not bound to stored obligation')
    require(all(type(state[k]) is int and state[k]==0 for k in ('recognition_count','recognized_source_count','rake_settlement_count')),
            'first legacy fee was recognized or banked')
    validate_account_delta(state['accounts_before'],state['accounts_after'])
    validate_journal_and_chairs(state)
    validate_fee_notice((work/'archive_connected_rollback.stderr').read_text())

    require(all(x['financial_qualified'] is False and x['production_qualified'] is False for x in values),
            'diagnostic scope inflated')
    class Oracle:
        validate_fee_notice=staticmethod(validate_fee_notice)
        validate_account_delta=staticmethod(validate_account_delta)
        validate_journal_and_chairs=staticmethod(validate_journal_and_chairs)
    if image==IMAGE:
        concurrent=[decode(line) for line in (work/'archive_concurrency_commit.stdout').read_bytes().splitlines() if line.startswith(b'{')]
        require(len(concurrent)==1,'first committed concurrency receipt absent')
        require(not (work/'archive_concurrency_commit.stderr').read_text().strip(),'first concurrency unexpected diagnostic')
        spec=importlib.util.spec_from_file_location('first_archived_concurrency_oracle',source/CONCURRENCY)
        verifier=importlib.util.module_from_spec(spec);spec.loader.exec_module(verifier)
        # Pass this module's validators without weakening the independently retained
        # rollback evidence or recoding business rules in the session runner.
        result=verifier.validate_evidence(concurrent[0],execution,Oracle)
        locks=[decode(line) for line in (work/'archive_admission_locks.stdout').read_bytes().splitlines() if line.startswith(b'{')]
        require(len(locks)==1 and not (work/'archive_admission_locks.stderr').read_text().strip(),'first lock artifact absent or unexpected diagnostic')
        spec=importlib.util.spec_from_file_location('first_archived_lock_oracle',source/LOCKS)
        lock_verifier=importlib.util.module_from_spec(spec);spec.loader.exec_module(lock_verifier)
        lock_result=lock_verifier.validate_evidence(locks[0],execution,Oracle)

    else:
        require(image==BANK_IMAGE,'unknown archive variant')
        result={'committed_terminal_qualified':False,'concurrency_qualified':False,'skipped_in_synthetic_variant':True}
        lock_result={'skipped_in_synthetic_variant':True}
    probe_values=[decode(line) for line in (work/'archive_production_probe.stdout').read_bytes().splitlines() if line.startswith(b'{')]
    require(len(probe_values)==1 and not (work/'archive_production_probe.stderr').read_text().strip(),'first production probe artifact absent or diagnostics unexpected')
    spec=importlib.util.spec_from_file_location('first_archived_production_probe_oracle',source/PRODUCTION_PROBE)
    probe_verifier=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe_verifier)
    probe_result=probe_verifier.validate_evidence(probe_values[0],execution,Oracle,bank_races=image==BANK_IMAGE)

    return {'diagnostic_passed':True,'stdout_sha256':digest(raw),'production_probe_rehearsal':probe_result,
            'committed_concurrency':result,'admission_locks':lock_result,
            'financial_qualified':False,'production_qualified':False,
            'committed_terminal_qualified':result['committed_terminal_qualified'],'concurrency_qualified':result['concurrency_qualified']}

def validate_stages(receipt,PG,source,execution,ordinary,tournament,image=IMAGE):
    required=seed_plan(PG,source,execution,ordinary,tournament)+body_plan(PG,source,execution,ordinary,tournament,image)
    names=[r['stage'] for r in receipt['stages']]
    require(len(names)==len(set(names)), 'first archived duplicate stage')
    selected=[name for name in names if name in {n for n,_ in required}]
    require(selected==[name for name,_ in required], 'first archived stage order differs')
    stages={r['stage']:r for r in receipt['stages']}
    for name,argv in required:
        require(name in stages,'first archived stage missing: '+name)
        row=stages[name]
        require(row['argv']==argv and type(row['pid']) is int and row['pid']>0 and row['returncode']==0 and row['terminal_returncode']==0
                and 'client_deadline_exceeded' not in row,'first archived stage failed: '+name)
        for stream in ('stdout','stderr'):
            require(digest((source.parent/'work'/(name+'.'+stream)).read_bytes())==row[stream+'_sha256'],
                    'first archived stream changed: '+name)
    return validate_outputs(source,source.parent/'work',execution,tournament,image)
