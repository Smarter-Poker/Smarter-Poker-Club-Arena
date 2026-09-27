"""Finite parser controls; synthetic envelopes, not native financial proof."""
import copy
import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('bank_observer',Path(__file__).with_name('spin-first-archived-bank-observer.py'))
B=importlib.util.module_from_spec(spec);spec.loader.exec_module(B)

def observed(low=99,amount=10,top=100,xmax=105,status=None):
    return {'transaction_id':str(top),'snapshot_xmax':str(xmax),'isolation':'read committed','rows':[
        {'projection':dict({k:0 for k in B.FINANCIAL},id='341f02a3-4655-420c-b43b-3930b6d9ad8f',union_id=B.UNION,rake_wallet=amount),
         'xmin':str(low),'full_xid':str((top//2**32)*2**32+low),'eligible':low>=top%2**32 and (top//2**32)*2**32+low<xmax,'status':status}]}

class FirstArchivedBankObserverTests(unittest.TestCase):
    def test_external_committed_both_intervals(self):
        history=[observed(),observed(101,11,status='committed'),observed(102,12,status='committed')]
        self.assertEqual(B.validate_history(history,'100'),['external committed version']*2)
    def test_empty_unchanged_and_baseline_ownership(self):
        value=observed();value['rows']=[]
        self.assertEqual(B.validate_history([copy.deepcopy(value) for _ in range(3)],'100'),['unchanged empty scope']*2)
        for low,status in [(100,'in progress'),(101,'in progress'),(101,None)]:
            with self.subTest(low=low,status=status),self.assertRaises(ValueError):
                B.validate_history([observed(low,10,status=status)]*3,'100')
    def test_own_noop_offset_parent_child_and_old_unknown_refuse(self):
        before=observed()
        for low,amount,status in [(100,11,'in progress'),(101,11,'in progress'),(100,10,'in progress'),(101,10,'in progress'),(98,11,None),(101,11,None)]:
            with self.subTest(low=low,amount=amount,status=status),self.assertRaises(ValueError):B.pair(before,observed(low,amount,status=status),'100')
    def test_cardinality_identity_epoch_and_metadata_fail_closed(self):
        mutations=[lambda d:d['rows'].clear(),lambda d:d['rows'].append(copy.deepcopy(d['rows'][0])),
            lambda d:d['rows'][0]['projection'].update(id='00000000-0000-0000-0000-000000000001'),
            lambda d:d.update(snapshot_xmax=str(2**32)),lambda d:d.update(transaction_id=True),
            lambda d:d['rows'][0].update(xmin='2'),lambda d:d['rows'][0].update(full_xid='98'),
            lambda d:d['rows'][0].update(eligible=0),lambda d:d['rows'][0]['projection'].update(rake_wallet=True),
            lambda d:d['rows'][0].update(status='committed'),lambda d:d['rows'][0]['projection'].update(rake_wallet=11),
            lambda d:d.update(isolation='repeatable read')]
        for i,change in enumerate(mutations):
            after=observed();change(after)
            with self.subTest(i=i),self.assertRaises(ValueError):B.pair(observed(),after,'100')
    def test_version_metadata_must_bind_same_projection_and_three_phases(self):
        h=[observed() for _ in range(3)]
        with self.assertRaises(ValueError):B.validate_history(h,'100',before=[])
        with self.assertRaises(ValueError):B.validate_history(h[:2],'100')
        h[2]['rows'][0]['eligible']=True
        with self.assertRaises(ValueError):B.validate_history(h,'100')

    def test_replay_phase_cannot_hide_own_or_unknown_versions(self):
        for low,status in [(100,'in progress'),(101,'in progress'),(101,None)]:
            history=[observed(),observed(),observed(low,10,status=status)]
            with self.subTest(low=low,status=status),self.assertRaises(ValueError):B.validate_history(history,'100')
        history=[observed(),observed(),observed(101,11,status='in progress')]
        self.assertTrue(B.validate_own_fault(history,'100',[history[1]['rows'][0]['projection']],[history[2]['rows'][0]['projection']]))
        history[0]['rows'][0]['status']='committed'
        with self.assertRaises(ValueError):B.validate_own_fault(history,'100',[history[1]['rows'][0]['projection']],[history[2]['rows'][0]['projection']])

    def test_captured_additional_financial_column_is_checked(self):
        before=observed();after=observed()
        for d in (before,after):d['rows'][0]['projection']['held_chips']=3
        self.assertEqual(B.pair(before,after,'100'),'unchanged')
        after['rows'][0]['projection']['held_chips']=4
        with self.assertRaises(ValueError):B.pair(before,after,'100')
        after['rows'][0]['projection']['held_chips']=True
        with self.assertRaises(ValueError):B.pair(before,after,'100')

    def test_future_frozen_and_other_epoch_versions_refuse(self):
        for low,xmax in [(2,105),(105,105),(106,105)]:
            with self.subTest(low=low),self.assertRaises(ValueError):B.pair(observed(),observed(low,11,xmax=xmax,status=None),'100')
        with self.assertRaises(ValueError):B.pair(observed(),observed(101,11,xmax=2**32,status='committed'),'100')

    def test_race_derivations_place_replay_fault_after_second_call(self):
        def load(name,path):
            spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
        base=Path(__file__).parent
        P=load('bank_race_probe_control',base/'spin-first-archived-production-probe.py')
        R=load('bank_race_derivation_control',base/'spin-first-archived-bank-races.py')
        source=(P.ROOT/P.PROBE).read_text()
        for kind in R.KINDS:
            derived=R.derived_source(source,kind,P)
            if kind.startswith('own_replay_'):
                self.assertIn('IF phase=1 THEN ',derived)
                self.assertNotIn('IF phase=0 THEN UPDATE public.union_wallets',derived)
            elif kind=='external_replay_commit':
                self.assertIn('IF phase=1 THEN PERFORM pg_advisory_xact_lock('+R.REPLAY_KEY+'); END IF;',derived)
            elif kind in ('external_commit','external_after_observation'):self.assertEqual(source,derived)
        with self.assertRaises(ValueError):R.derived_source(source,'unknown',P)
        with self.assertRaises(ValueError):R.derived_source(source.replace(P.BANK_FAULT_ANCHOR,''),'own_parent',P)
