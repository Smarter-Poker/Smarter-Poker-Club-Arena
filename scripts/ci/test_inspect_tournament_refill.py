import importlib.util,json,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('diagnostic',Path(__file__).with_name('inspect-tournament-refill.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class RestartEvidence(unittest.TestCase):
 def test_only_bounded_typed_fields_leave_host(self):
  events=[{'Action':'oom','time':123,'Actor':{'Attributes':{'name':m.CONTAINER,'secret':'do-not-export'}}},
   {'Action':'die','time':124,'Actor':{'Attributes':{'name':m.CONTAINER,'exitCode':'137','signal':'unsafe','credential':'hidden'}}},
   {'Action':'start','time':125,'Actor':{'Attributes':{'name':'other-container'}}}]
  result=m.sanitize_restart_evidence({'OOMKilled':True,'ExitCode':137,'Env':'private'},'2','\n'.join(map(json.dumps,events)))
  self.assertEqual(result,{'oomKilled':True,'exitCode':137,'restartCount':2,'events':[{'action':'oom','unixTime':123},{'action':'die','unixTime':124,'exitCode':137}]})
 def test_unknown_state_and_malformed_events_refuse(self):
  for value in ['-1','unknown','1;secret']:
   with self.assertRaises(RuntimeError):m.sanitize_restart_evidence({},value,'')
  with self.assertRaises(ValueError):m.sanitize_restart_evidence({},'0','not json')
if __name__=='__main__':unittest.main()
