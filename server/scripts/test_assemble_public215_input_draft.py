"""Synthetic renderer and write-boundary guards; no solver, labels or M2 seed."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('input_draft',Path(__file__).with_name('assemble-public215-input-draft.py'))
draft=importlib.util.module_from_spec(spec);spec.loader.exec_module(draft)
NS='12345678-1234-4234-8234-123456789abc'

class DraftGuardTests(unittest.TestCase):
    def source(self, board='AsKdQc2s3h', node='r:0:c:c:2s:b250:b750:3h'):
        return {'scenario_id':'old','flop_board':board[:6],'purpose':'harvest',
                'conditional_history':{'model':'authored_range_preserving_response','target_node':node},
                'tree_lines':[[0,0,250,750]],'icm_model_id':'same-full-table',
                'targets':[{'target_id':'old.t','machine_id':'M1','board':board,'node':node,'expected_children':['c','f']} ]}

    def test_chronological_tokens_and_conditional_history(self):
        source=self.source();before=copy.deepcopy(source)
        result=draft.remap_scenario(source,'JhTs9c4d5s',NS,3)
        self.assertEqual(result['flop_board'],'JhTs9c')
        self.assertEqual(result['targets'][0]['node'],'r:0:c:c:4d:b250:b750:5s')
        self.assertEqual(result['conditional_history']['target_node'],result['targets'][0]['node'])
        self.assertEqual(result['targets'][0]['board'],'JhTs9c4d5s')
        self.assertEqual(result['targets'][0]['machine_id'],'M2')
        self.assertEqual(result['targets'][0]['expected_children'],['c','f'])
        self.assertEqual(result['tree_lines'],before['tree_lines'])
        self.assertEqual(result['icm_model_id'],before['icm_model_id'])
        self.assertEqual(source,before)
        self.assertEqual(result['scenario_id'],'r7f.m2.'+NS.replace('-','')+'.00003')

    def test_flop_has_no_native_community_tokens(self):
        s=self.source('AsKdQc','r:0:b250:b750')
        result=draft.remap_scenario(s,'JhTs9c',NS,0)
        self.assertEqual(result['targets'][0]['node'],'r:0:b250:b750')
        self.assertEqual(result['flop_board'],'JhTs9c')

    def test_turn_maps_only_runout(self):
        result=draft.remap_scenario(self.source('AsKdQc2s','r:0:c:c:2s:c'),'JhTs9c4d',NS,0)
        self.assertEqual(result['targets'][0]['node'],'r:0:c:c:4d:c')

    def test_wrong_chronology_or_street_refused(self):
        for s,b in [(self.source(node='r:0:c:c:3h:c:2s'),'JhTs9c4d5s'),(self.source(),'JhTs9c4d')]:
            with self.assertRaises(ValueError):draft.remap_scenario(s,b,NS,0)

    def test_illegal_duplicate_board_refused(self):
        for board in ['JhJh9c4d5s','XhTs9c4d5s','JhTs']:
            with self.assertRaises(ValueError):draft.remap_scenario(self.source(),board,NS,0)

    def test_exclusive_safe_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);draft.new_file(root,'inputs/a.json',b'{}')
            with self.assertRaises(FileExistsError):draft.new_file(root,'inputs/a.json',b'changed')
            self.assertEqual((root/'inputs/a.json').read_bytes(),b'{}')
            for name in ['../escape','/absolute','.env','a/.env.local']:
                with self.assertRaises(ValueError):draft.new_file(root,name,b'x')

    def test_input_hash_and_duplicate_keys_refuse(self):
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory).resolve()/'public.json';p.write_bytes(b'{"x":1,"x":2}')
            with self.assertRaises(ValueError):draft.checked({'path':str(p),'sha256':'0'*64})
            with self.assertRaises(ValueError):draft.parsed({'path':str(p),'sha256':draft.sha(p.read_bytes())})

if __name__=='__main__':unittest.main()
