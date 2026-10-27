#!/usr/bin/env python3
"""Finite parser/transport contracts; no SSH, Docker or production calls."""
import importlib.util,json,subprocess,sys,unittest
from unittest.mock import patch
from pathlib import Path
spec=importlib.util.spec_from_file_location('boot_witness',Path(__file__).with_name('horse-public-bootstrap-witness.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class BootstrapWitness(unittest.TestCase):
 def logs(self):
  lines=['PRIVATE-ACTOR CARD SECRET']
  for i in range(8):
   lines.extend([f'2026-10-27T06:00:01.000Z [HorseDecisionWorker] shard {i} pooled public bootstrap loaded 24369 profiles at 1793080801000',f'2026-10-27T06:00:01.001Z [HorseDecisionWorker] shard {i} boot step pooled_public_profiles ok in 999ms (1000ms since worker services began)',f'2026-10-27T06:00:02.000Z [HorseDecisionWorker] shard {i} services ready 2000ms after they began'])
  return ('\n'.join(lines)+'\n').encode()
 def test_actual_closed_markers_and_no_private_output(self):
  rows=m.parse_logs(self.logs(),'2026-10-27T06:00:00Z');self.assertEqual(len(rows),8);self.assertEqual(rows[7]['profileCount'],24369);self.assertNotIn('PRIVATE',json.dumps(rows));self.assertTrue(rows[0]['bootstrapBeforeServicesReady'])
 def test_partial_duplicate_unavailable_future_and_budget_refuse(self):
  raw=self.logs()
  for bad in [raw.replace(b'shard 7',b'shard 6'),raw.replace(b'loaded 24369 profiles at 1793080801000',b'unavailable'),raw.replace(b'in 999ms',b'in 5001ms'),raw.replace(b'at 1793080801000',b'at 9999999999999'),raw.replace(b'2026-10-27T06:00:02.000Z',b'2026-10-27T05:59:59.000Z'),b'x'*(m.MAX_BYTES+1)]:
   with self.assertRaises(ValueError):m.parse_logs(bad,'2026-10-27T06:00:00Z')
 def test_real_subprocess_output_byte_and_time_bounds(self):
  self.assertEqual(m.bounded([sys.executable,'-c','print("ok")'],16,2),b'ok\n')
  with self.assertRaises(ValueError):m.bounded([sys.executable,'-c','print("x"*100)'],16,2)
  with self.assertRaises(ValueError):m.bounded([sys.executable,'-c','import time;time.sleep(1)'],16,.02)
 def test_remote_current_identity_ready_order_and_source_fences(self):
  ident=('a'*64+' sha256:'+'b'*64+' true '+'c'*40+' 2026-10-27T06:00:00Z').encode()
  health={'releaseSha':'c'*40,'running':True,'liveness':'ok','instanceId':'1-1234abcd','liveHorseDecision':{'phase':'ready','workerCount':8,'workers':[{'index':i,'phase':'ready'} for i in range(8)]}}
  replies=[ident,json.dumps(health).encode(),b'c'*40,self.logs(),ident,json.dumps(health).encode()]
  with patch.object(m,'bounded',side_effect=replies) as read:
   out=m.remote('c'*40);self.assertEqual(out['cacheAdmission'],'unknown');self.assertEqual(out['readyMessageOrder'],'not_logged');self.assertEqual(out['workersReadyAtObservation'],8);self.assertEqual(m.validate_receipt(out,'c'*40),out);self.assertEqual(read.call_args_list[3].args[0][0:2],['docker','logs'])
  for index,bad in [(0,ident.replace(b'true',b'false')),(4,ident.replace(b'a'*64,b'd'*64)),(5,json.dumps(dict(health,instanceId='2-1234abcd')).encode())]:
   values=list(replies);values[index]=bad
   with patch.object(m,'bounded',side_effect=values):
    with self.assertRaises(ValueError):m.remote('c'*40)
 def test_transport_never_forwards_unknown_fields_or_private_values(self):
  result={'version':1,'status':'observed','sourceSha':'c'*40,'instanceId':'1-1234abcd','containerId':'a'*64,'containerStartedAt':'2026-10-27T06:00:00Z','startupIntervalSeconds':120,'workersReadyAtObservation':8,'shards':m.parse_logs(self.logs(),'2026-10-27T06:00:00Z'),'readyMessageOrder':'not_logged','cacheAdmission':'unknown','completePopulation':False,'allPhasesVerified':False}
  for change in [lambda d:d.update(PRIVATE='CARD'),lambda d:d['shards'][0].update(profileCount=True),lambda d:d['shards'][0].update(status='PRIVATE-CARD'),lambda d:d.update(cacheAdmission='verified')]:
   bad=json.loads(json.dumps(result));change(bad)
   with self.assertRaises(ValueError):m.validate_receipt(bad,'c'*40)
if __name__=='__main__':unittest.main()
