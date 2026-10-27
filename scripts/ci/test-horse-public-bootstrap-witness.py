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
  for bad in [raw.replace(b'shard 7',b'shard 6'),raw.replace(b'loaded 24369 profiles at 1793080801000',b'unavailable'),raw.replace(b'in 999ms',b'in 120001ms'),raw.replace(b'at 1793080801000',b'at 9999999999999'),raw.replace(b'2026-10-27T06:00:02.000Z',b'2026-10-27T05:59:59.000Z'),b'x'*(m.MAX_BYTES+1)]:
   with self.assertRaises(ValueError):m.parse_logs(bad,'2026-10-27T06:00:00Z')
 def test_whole_boot_step_can_exceed_database_abort_budget(self):
  raw=self.logs().replace(b'06:00:01.000Z',b'06:00:06.000Z').replace(b'at 1793080801000',b'at 1793080806000').replace(b'06:00:01.001Z',b'06:00:06.001Z').replace(b'06:00:02.000Z',b'06:00:07.000Z').replace(b'in 999ms (1000ms',b'in 5001ms (6000ms').replace(b'services ready 2000ms',b'services ready 7000ms')
  rows=m.parse_logs(raw,'2026-10-27T06:00:00Z');self.assertEqual(rows[0]['bootstrapElapsedMs'],5001)
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
 def test_current_container_startup_survives_more_than_tail_poststartup_lines(self):
  # Moby tails globally, then applies since/until. Model that order exactly;
  # all calls stay fenced to the same source/container/instance and eight READY workers.
  ident=('a'*64+' sha256:'+'b'*64+' true '+'c'*40+' 2026-10-27T06:00:00Z').encode()
  health={'releaseSha':'c'*40,'running':True,'liveness':'ok','instanceId':'1-1234abcd','liveHorseDecision':{'phase':'ready','workerCount':8,'workers':[{'index':i,'phase':'ready'} for i in range(8)]}}
  startup=self.logs().decode().splitlines()[1:]
  history=startup+['2026-10-27T06:03:00Z PRIVATE-POSTSTARTUP']*20001
  calls=[]
  def docker_log_selection(args):
   selected=history
   if '--tail' in args:selected=selected[-int(args[args.index('--tail')+1]):]
   since=m.timestamp(args[args.index('--since')+1]);until=m.timestamp(args[args.index('--until')+1])
   return ('\n'.join(line for line in selected if since<=m.timestamp(line.split(' ',1)[0])<=until)+'\n').encode()
  def transport(args,*unused,**kw):
   calls.append(args)
   if args[:2]==['docker','logs']:return docker_log_selection(args)
   if args[:2]==['docker','inspect']:return ident
   if args[:3]==['docker','image','inspect']:return b'c'*40
   if args[0]=='curl':return json.dumps(health).encode()
   raise AssertionError('Unexpected transport operation')
  old=['docker','logs','--timestamps','--since','2026-10-27T06:00:00Z','--until','2026-10-27T06:02:00Z','--tail','20000','a'*64]
  with self.assertRaisesRegex(ValueError,'missing_shard'):m.parse_logs(docker_log_selection(old),'2026-10-27T06:00:00Z')
  with patch.object(m,'bounded',side_effect=transport):out=m.remote('c'*40)
  self.assertEqual(len(out['shards']),8);self.assertEqual(out['instanceId'],health['instanceId']);self.assertNotIn('PRIVATE',json.dumps(out))
  log_call=next(args for args in calls if args[:2]==['docker','logs']);self.assertNotIn('--tail',log_call);self.assertIn('--since',log_call);self.assertIn('--until',log_call)
 def test_more_than_twenty_thousand_in_window_lines_refuse_locally(self):
  raw=self.logs()+b'2026-10-27T06:00:03Z PRIVATE-IN-WINDOW\n'*20001
  self.assertLess(len(raw),m.MAX_BYTES)
  with self.assertRaisesRegex(ValueError,'log_line_bound'):m.parse_logs(raw,'2026-10-27T06:00:00Z')
if __name__=='__main__':unittest.main()
