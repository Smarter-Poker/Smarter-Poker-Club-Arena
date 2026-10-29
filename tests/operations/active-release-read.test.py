#!/usr/bin/env python3
"""Native fixed-file/process-boundary fixtures; never contacts a real host."""
import base64
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('reader', ROOT / 'scripts/ci/read-scoped-release-recovery.py')
R = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(R)
REQUEST = {'runKey': '40842232596-1', 'releaseSha': 'a' * 40}
INVOCATION = 'b' * 32
URL = 'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/40842232596'
UNIT = 'club-arena-engine-release-v1@40842232596-1.service'
NATIVE = ('LoadState=loaded\nActiveState=active\nResult=success\nExecMainStatus=0\nInvocationID=' + INVOCATION + '\n').encode()


def journal(message='[engine-release-transaction] the database says a hand IS in the air; the cutover stays refused'):
    return json.dumps({'MESSAGE':message,'_SYSTEMD_UNIT':UNIT,'_SYSTEMD_INVOCATION_ID':INVOCATION,
                       '__REALTIME_TIMESTAMP':'1793264400000000'}).encode()


class ActiveReaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='native-active-', dir=ROOT.parent)
        self.root = Path(self.temp.name)
        self.intake = self.root / 'engine-intake-requests'
        self.release = self.root / 'engine-release-requests'
        self.intake.mkdir();self.release.mkdir()
        self.path = self.intake / (REQUEST['runKey'] + '.request')
        self.path.write_text('\n'.join([REQUEST['releaseSha'],'c'*40,URL,'private actor never exported','1793270000'])+'\n')
        self.patcher = patch.object(R,'STATE_ROOT',self.root);self.patcher.start()

    def tearDown(self):
        self.patcher.stop();self.temp.cleanup()

    def process(self,args):
        if args[0] == 'systemctl':
            self.assertEqual(args[:4], ['systemctl','show','--no-pager','--property=ActiveState,ExecMainStatus,InvocationID,LoadState,Result'])
            self.assertIn(args[4],['club-arena-engine-intake-v1@40842232596-1.service',UNIT])
            return subprocess.CompletedProcess(args,0,stdout=NATIVE)
        self.assertEqual(args[0],'journalctl')
        self.assertIn('--lines=8',args)
        self.assertIn('_SYSTEMD_INVOCATION_ID='+INVOCATION,args)
        selected=next(x.split('=',1)[1] for x in args if x.startswith('_SYSTEMD_UNIT='))
        value=json.loads(journal());value['_SYSTEMD_UNIT']=selected
        return subprocess.CompletedProcess(args,0,stdout=json.dumps(value).encode())

    def test_actual_files_and_exact_process_selection_export_only_safe_state(self):
        with patch.object(R,'bounded_journal',side_effect=self.process):answer=R.remote_active(REQUEST)
        self.assertEqual(answer['requests']['intake']['status'],'matched')
        self.assertEqual(answer['requests']['release'],{'status':'unknown_absent'})
        self.assertEqual(answer['units']['release']['journal']['events'][0]['code'],'cards_in_air_refused')
        self.assertNotIn('private actor',json.dumps(answer));self.assertNotIn('MESSAGE',json.dumps(answer))
        self.assertEqual(R.validate_active_reply(answer,REQUEST),answer)

    def test_missing_transition_requests_remain_unknown_not_failed_or_admitted(self):
        self.path.unlink()
        with patch.object(R,'bounded_journal',side_effect=self.process):answer=R.remote_active(REQUEST)
        self.assertEqual(answer['requests'],{'intake':{'status':'unknown_absent'},'release':{'status':'unknown_absent'}})
        self.assertIn('not_activation',answer['verdict'])

    def test_wrong_request_sha_url_control_or_field_count_refused(self):
        original=self.path.read_text()
        for raw in [original.replace('a'*40,'d'*40),original.replace(URL,'https://example.test'),original.replace('c'*40,'secret'),original+'extra\n']:
            self.path.write_text(raw)
            with self.assertRaises(ValueError),patch.object(R,'bounded_journal') as calls:
                R.remote_active(REQUEST)
            calls.assert_not_called()

    def test_release_request_shape_binds_its_separate_immutable_control(self):
        p=self.release/(REQUEST['runKey']+'.request')
        p.write_text('\n'.join([REQUEST['releaseSha'],URL,'private','/immutable/generation','d'*40,'1793270000'])+'\n')
        with patch.object(R,'bounded_journal',side_effect=self.process):answer=R.remote_active(REQUEST)
        self.assertEqual(answer['requests']['release']['controlSha'],'d'*40)
        self.assertNotIn('/immutable',json.dumps(answer))

    def test_symlink_fifo_large_and_changed_request_refused(self):
        self.path.unlink();self.path.symlink_to('/etc/passwd')
        with self.assertRaises(OSError):R.remote_active(REQUEST)
        self.path.unlink();os.mkfifo(self.path)
        with self.assertRaises(ValueError):R.remote_active(REQUEST)
        self.path.unlink();self.path.write_text('x'*4097)
        with self.assertRaises(ValueError):R.remote_active(REQUEST)

    def test_unit_unknown_duplicate_extra_secret_and_wrong_types_refused(self):
        for raw in [NATIVE+b'Environment=secret\n',NATIVE+b'ActiveState=active\n',NATIVE.replace(b'active',b'secret'),NATIVE.replace(b'=0\n',b'=999\n')]:
            with self.subTest(raw=raw),self.assertRaises(ValueError):R.active_unit(raw)

    def test_only_exact_unit_invocation_and_timestamp_are_admitted(self):
        for field,value in [('_SYSTEMD_UNIT','other.service'),('_SYSTEMD_INVOCATION_ID','d'*32),('__REALTIME_TIMESTAMP','secret')]:
            row=json.loads(journal());row[field]=value
            with self.assertRaises(ValueError):R.active_journal(json.dumps(row).encode(),UNIT,INVOCATION)

    def test_unknown_or_secret_messages_never_cross_protocol(self):
        answer=R.active_journal(journal('credential=secret phase=sealed'),UNIT,INVOCATION)
        self.assertEqual(answer,{'status':'read','events':[],'unrecognizedRows':1})
        self.assertNotIn('secret',json.dumps(answer))

    def test_actual_certificate_refusal_is_coded_without_exporting_repr(self):
        producer=(ROOT/'server/scripts/engine-release-transaction.sh').read_text()
        self.assertIn('the restart certificate is shut with %dms of the break left: unparkedTables=%r unparkedReasons=%r handsInFlightTotal=%r',producer)
        message="[engine-release-transaction] the restart certificate is shut with 299412ms of the break left: unparkedTables=68 unparkedReasons={'cards_in_air': 66, 'f06_preparation_unresolved': 2} handsInFlightTotal=0"
        self.assertEqual(R.active_code(message),'cards_in_air_certificate_refused')
        answer=R.active_journal(journal(message),UNIT,INVOCATION)
        self.assertNotIn('cards_in_air\': 66',json.dumps(answer))
        self.assertEqual(R.active_code(message.replace("'cards_in_air': 66","'cards_in_air': 0")),'certificate_not_ready')
        self.assertIsNone(R.active_code(message+' secret=never_export'))
        self.assertIsNone(R.active_code(message.replace("'cards_in_air'","'credential=secret'")))

    def test_fixed_causes_only_not_substring_or_attacker_suffixed(self):
        self.assertEqual(R.active_code('ENGINE_IMAGE_REUSED=false'),'image_built')
        self.assertEqual(R.active_code('[engine-release-intake] FATAL: control-generation installation failed permanently (status 1)'),'control_permanent')
        self.assertIsNone(R.active_code('ENGINE_IMAGE_REUSED=false secret'))
        self.assertIsNone(R.active_code('prefix ENGINE_RELEASE_RESULT=sealed'))

    def test_output_line_and_byte_limits_are_enforced(self):
        for raw in [journal()*9,b'x'*8193]:
            with self.assertRaises(ValueError):R.active_journal(raw,UNIT,INVOCATION)

    def test_unit_transition_during_read_refused(self):
        calls=0
        def changing(args):
            nonlocal calls
            calls+=1
            result=self.process(args)
            if calls==3:result.stdout=NATIVE.replace(b'active',b'failed')
            return result
        with patch.object(R,'bounded_journal',side_effect=changing),self.assertRaises(ValueError):R.remote_active(REQUEST)

    def test_mixed_dispatch_modes_refused_before_transport(self):
        path=self.root/'event.json'
        path.write_text(json.dumps({'action':'audit-production-integrity','client_payload':{'active_release_observation':REQUEST,'release_recovery_observation':REQUEST}}))
        with patch.object(R.sys,'argv',['reader','--active']),patch.dict(os.environ,{'GITHUB_EVENT_NAME':'repository_dispatch','GITHUB_EVENT_PATH':str(path)}),patch.object(R.subprocess,'run') as calls,self.assertRaises(ValueError):
            R.main()
        calls.assert_not_called()

    def test_workflow_admission_is_explicit_and_skips_all_ordinary_issue_audits(self):
        source=(ROOT/'.github/workflows/production-integrity-audit.yml').read_text()
        self.assertIn("github.event_name == 'repository_dispatch' && github.event.action == 'audit-production-integrity' && github.event.client_payload.active_release_observation != null",source)
        self.assertEqual(source.count('if: github.event.client_payload.tournament_log_observation == null && github.event.client_payload.active_release_observation == null'),9)
        job=source.split('  scoped_active_release:',1)[1].split('  scoped_release_recovery:',1)[0]
        self.assertIn('permissions:\n      contents: read',job)
        self.assertNotIn('issues: write',job)
        self.assertIn('read-scoped-release-recovery.py --active',job)
        self.assertIn('active-release-observation-${{ github.run_id }}',job)

    def test_unavailable_unit_or_journal_is_explicitly_unknown(self):
        with patch.object(R,'bounded_journal',return_value=subprocess.CompletedProcess([],4,stdout=b'')):
            answer=R.remote_active(REQUEST)
        self.assertEqual(answer['units']['release'],{'status':'unknown_unavailable'})
        self.assertEqual(R.validate_active_reply(answer,REQUEST),answer)
        def missing_journal(args):
            if args[0]=='journalctl':raise subprocess.TimeoutExpired(args,5)
            return self.process(args)
        with patch.object(R,'bounded_journal',side_effect=missing_journal):answer=R.remote_active(REQUEST)
        self.assertEqual(answer['units']['release']['journal']['status'],'unknown_unavailable')

    def test_transport_reply_refuses_extra_fields_codes_and_identity(self):
        with patch.object(R,'bounded_journal',side_effect=self.process):answer=R.remote_active(REQUEST)
        for bad in [{**answer,'raw':'secret'},{**answer,'releaseSha':'d'*40}]:
            with self.assertRaises(ValueError):R.validate_active_reply(bad,REQUEST)
        bad=copy.deepcopy(answer);bad['units']['release']['journal']['events'][0]['code']='secret'
        with self.assertRaises(ValueError):R.validate_active_reply(bad,REQUEST)


if __name__=='__main__':unittest.main()
