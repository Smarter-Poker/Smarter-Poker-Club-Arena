"""Malformed finite lock receipts only; not native financial proof."""
import copy
import importlib.util
from pathlib import Path
import unittest
import uuid

HERE=Path(__file__).resolve().parent

def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

L=load('first_lock_controls',HERE/'spin-first-archived-locks.py')
T=load('first_lock_concurrency_examples',HERE/'test_first_archived_concurrency.py')
A=T.A


def valid():
    c=T.valid();execution=c['execution'];p={'observer':101,'holder':102,'worker':103}
    held={'locktype':'advisory','mode':'ExclusiveLock','classid':530090,'objid':1,'objsubid':2,'granted':True,'relation':None}
    pending=dict(held,granted=False,mode='ShareLock')
    def wait(relation=None):
        return {'pid':103,'blockers':[102],'wait_event_type':'Lock','wait_event':'advisory' if relation is None else 'transactionid',
                'locks':[pending if relation is None else {'relation':relation}],'holder_locks':[held]}
    cases={}
    for kind in ('maintenance','abi'):
        cases[kind]={'wait':wait(None if kind=='maintenance' else 'ca_mtt_admission_contract'),
            'deferred_checked':True,'after':c['before'],'response':c['first_response'],'inside':c['inside']['rows'],
            'accounts_before':c['accounts_before'],'accounts_inside':c['accounts_after']}
    generation=str(uuid.uuid5(uuid.UUID(execution),'manager-lock-case'));instance='isolated:archive-lock-manager:'+execution
    lease=[{'tournament_id':L.C.EVENT,'instance_id':instance,'lease_generation':generation}]
    setup=copy.deepcopy(c['before']);setup['rows']['public.engine_tournament_leases']=lease
    manager={'refusal':['40001','ARCHIVED_SPIN_COMPETING_OWNER'],'release_count':1,'lease':lease,
        'inside':setup['rows'],'after_refusal':setup['rows'],'instance':instance,'generation':generation,
        'claim':{'granted':True,'holder':instance,'lease_generation':generation},'lane':{'scope':L.C.EVENT,'held':True},'wait':wait('engine_tournament_leases')}
    return copy.deepcopy({'execution':execution,'event':L.C.EVENT,'passed':True,'cleanup_verified':True,
        'financial_qualified':False,'production_qualified':False,'sequence_rollback_claimed':False,'backend_pids':p,
        'environment':{'max_locks':1024,'max_connections':8},'before':c['before'],'after':c['before'],'cases':cases,'manager_setup':setup,'manager':manager,
        'clients':[{'backend_pid':v,'client_exit':0} for v in p.values()],
        'backend_cleanup':{'backends':0,'locks':0},'backend_cleanup_observations':[{'backends':0,'locks':0}],
        'verifier_client':{'client_exit':0},'cleanup_transcript':'original','transcripts':{k:'original' for k in p}})


class FirstArchivedLockTests(unittest.TestCase):
    def test_exact_oid_observation_and_holder_first_fault_cleanup(self):
        source=(HERE/'spin-first-archived-locks.py').read_text()
        self.assertEqual(source.count("'classid',classid::bigint,'objid',objid::bigint"),2)
        self.assertIn("for name in ('holder','worker')",source)
        self.assertLess(source.index("for name in ('holder','worker')"),source.index('for name,session in reversed(sessions)'))

    def test_scoped_lock_protocol_shape(self):
        d=valid();self.assertTrue(L.validate_evidence(d,d['execution'],A)['admission_lock_order_qualified'])

    def test_corrupt_retained_lock_proof_refuses(self):
        mutations=[lambda d:d['environment'].update(max_locks=64),lambda d:d['environment'].update(max_connections=9),lambda d:d['cases']['maintenance']['wait']['locks'][0].update(objsubid=1),
            lambda d:d['cases']['maintenance']['wait']['holder_locks'][0].update(granted=False),
            lambda d:d['cases']['abi']['wait'].update(blockers=[999]),
            lambda d:d['cases']['maintenance']['accounts_inside']['public.club_members'][0].update(chip_balance=999),
            lambda d:d['cases']['abi']['inside']['public.chip_ledger'][-1].update(amount=900),
            lambda d:d['cases']['abi']['inside']['public.table_seats'][0].update(left_at=None),
            lambda d:d['manager'].update(after_refusal={}),lambda d:d['manager']['lane'].update(held=False),
            lambda d:d['manager']['claim'].update(holder='guessed'),lambda d:d['manager']['wait'].update(pid=999),
            lambda d:d['manager'].update(release_count=True),lambda d:d['clients'][0].update(client_exit=False),
            lambda d:d['backend_cleanup'].update(locks=1),lambda d:d.update(sequence_rollback_claimed=True)]
        for index,mutate in enumerate(mutations):
            d=valid();mutate(d)
            with self.subTest(index=index),self.assertRaises((ValueError,KeyError)):L.validate_evidence(d,d['execution'],A)


if __name__=='__main__':unittest.main()
