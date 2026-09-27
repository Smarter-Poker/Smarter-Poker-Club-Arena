"""Fail-closed evidence controls, not PostgreSQL concurrency qualification."""
import copy
import importlib.util
from pathlib import Path
import unittest

HERE=Path(__file__).resolve().parent

def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

C=load('archive_concurrency_controls',HERE/'spin-first-archived-concurrency.py')
A=load('archive_oracle_controls_owner',HERE/'spin-first-archived.py')
T=load('archive_oracle_examples',HERE/'test_first_archived_oracle.py')


def valid():
    v=T.envelopes()
    state=v[1];execution=T.EXECUTION
    before={'public.spin_reserve_ledger':state['reserve_before'],'public.chip_ledger':state['ledger_before'],
        'public.table_seats':state['seats_before'],'smarter_private.spin_archived_first_admission':[]}
    after={'public.spin_reserve_ledger':state['reserve_after'],'public.chip_ledger':state['ledger_after'],
        'public.table_seats':state['seats_after'],'public.hand_history':[],'public.hand_atomic_commits':[],
        'public.tables':[state['primary_table']],'public.tournament_terminal_settlements':[state['terminal']],
        'public.accounting_tournament_fee_custody_obligations':state['custody_obligations'],
        'smarter_private.spin_archived_first_admission':[{'operation_id':execution,'tournament_id':C.EVENT,'source_sha256':C.SOURCE}]}
    for rows in (before,after):
        for table in ('public.spin_reserve_ledger','public.chip_ledger'):
            for row in rows[table]:row['tournament_id']=C.EVENT
    committed={'rows':after,'sequences':{n:{'last_value':'4','is_called':True} for n in C.SEQUENCES}}
    p={'observer':101,'first':102,'same':103,'different':104}
    d={'execution':execution,'event':C.EVENT,'passed':True,'cleanup_verified':True,'financial_qualified':False,'production_qualified':False,
       'environment':{'max_locks':1024,'max_connections':8},'sequence_scope':C.SEQUENCES,'excluded_sequences':['auth.refresh_tokens_id_seq','public.ad_event_id_seq'],
       'excluded_sequence_count':2,'excluded_sequence_reason':C.EXCLUSION_REASON,
       'backend_pids':p,'waits':{n:{'pid':p[n],'wait_event_type':'Lock','wait_event':'advisory','blockers':[102],'same_owned_advisory_key':True} for n in ('same','different')},
       'commit_observed':True,'deferred_checks_at_commit':True,'first_response':v[0]['response'],'durable_response':v[0]['response'],
       'same_response':v[0]['response'],'different_sqlstate':'40001','different_message':'ARCHIVED_SPIN_REPLAY_MISMATCH',
       'before':{'rows':before,'sequences':{n:{'last_value':'1','is_called':False} for n in C.SEQUENCES}},'inside':committed,'committed':committed,'same_inside':committed,'after':committed,
       'accounts_before':state['accounts_before'],'accounts_after':state['accounts_after'],
       'clients':[{'client_exit':0,'backend_pid':pid} for pid in p.values()],
       'transcripts':{name:'original-stream' for name in p},'backend_cleanup':{'backends':0,'locks':0},
       'backend_cleanup_observations':[{'backends':0,'locks':0}], 'verifier_client':{'client_exit':0},'cleanup_transcript':'original-cleanup'}
    return copy.deepcopy(d)


class FirstArchivedConcurrencyTests(unittest.TestCase):
    def test_sequence_observer_has_no_retention_business_dependency(self):
        self.assertNotIn('sp_prune_hand_history',C.SEQUENCE_SQL)
        self.assertNotIn('retention_catalog_state',C.SEQUENCE_SQL)
        self.assertIn("c.relkind='S'",C.SEQUENCE_SQL)
        self.assertEqual(len(C.SEQUENCES),8)
        self.assertIn("pg_get_userbyid(c.relowner)='postgres'",C.SEQUENCE_SQL)
        self.assertNotIn("has_sequence_privilege",C.SEQUENCE_SQL)
        self.assertIn('count<>8',C.SEQUENCE_SQL)
        for name in C.SEQUENCES:self.assertIn(name,C.SEQUENCE_SQL)
        self.assertIn('last_value::text',C.SEQUENCE_SQL)
        self.assertNotIn('setval',C.SEQUENCE_SQL)
        self.assertNotIn('nextval',C.SEQUENCE_SQL)

    def test_failed_schedule_releases_first_owner_before_waiters(self):
        source=(HERE/'spin-first-archived-concurrency.py').read_text()
        self.assertIn("for name in ('first','same','different')",source)
        self.assertLess(source.index("for name in ('first','same','different')"),source.index('for name,session in reversed(sessions)'))
        self.assertIn("client.command('ROLLBACK;')",source)
        self.assertIn("environment['max_locks']==1024 and environment['max_connections']==8",source)

    def test_canonical_commit_replay_evidence(self):
        d=valid();self.assertTrue(C.validate_evidence(d,T.EXECUTION,A)['concurrency_qualified'])

    def test_corrupt_concurrency_evidence_refuses(self):
        mutations=[lambda d:d['environment'].update(max_locks=64),lambda d:d['environment'].update(max_connections=9),lambda d:d.update(commit_observed=False),lambda d:d.update(sequence_scope=['public']),
          lambda d:d.update(excluded_sequence_reason=''),lambda d:d.update(excluded_sequences=[C.SEQUENCES[0]]),lambda d:d.update(excluded_sequence_count=0),lambda d:d['before']['sequences'].pop(C.SEQUENCES[0]),lambda d:d.update(deferred_checks_at_commit=False),
          lambda d:d.update(financial_qualified=True),lambda d:d.update(cleanup_verified=False),
          lambda d:d['waits']['same'].update(wait_event='transactionid'),
          lambda d:d['waits']['different'].update(blockers=[999]),
          lambda d:d['waits']['same'].update(same_owned_advisory_key=False),
          lambda d:d.update(different_sqlstate='55P03'),lambda d:d.update(different_message='other'),
          lambda d:d['clients'][0].update(client_exit=True),lambda d:d['transcripts'].pop('same'),
          lambda d:d['backend_pids'].update(different=102),
          lambda d:d.update(same_response={'ok':True}),lambda d:d['backend_cleanup'].update(locks=1),
          lambda d:d['clients'][0].update(backend_pid=999),lambda d:d['verifier_client'].update(client_exit=True),
          lambda d:d.update(after={'rows':{},'sequences':{}}),
          lambda d:d['accounts_after']['public.club_members'][1].update(chip_balance=900)]
        for index,mutate in enumerate(mutations):
            d=valid();mutate(d)
            with self.subTest(index=index),self.assertRaises((ValueError,KeyError)):C.validate_evidence(d,T.EXECUTION,A)

    def test_duplicate_money_and_admission_refuse_even_consistent_state(self):
        for name in ('smarter_private.spin_archived_first_admission','public.tournament_terminal_settlements','public.chip_ledger'):
            d=valid();d['after']['rows'][name].append(copy.deepcopy(d['after']['rows'][name][-1]))
            with self.subTest(name=name),self.assertRaises(ValueError):C.validate_evidence(d,T.EXECUTION,A)


if __name__=='__main__':unittest.main()
