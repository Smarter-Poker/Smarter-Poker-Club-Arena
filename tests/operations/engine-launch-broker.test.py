"""Portable local identity persistence/refusal tests; no native or DB authority."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('launch_broker', ROOT / 'server/scripts/engine-launch-broker.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def identity():
    return dict(kernel_boot_id='548f8f8a-359d-4098-b948-78b6c98c99e7', pid=321,
        process_start_ticks='9001', cgroup_path='/system.slice/docker-'+'a'*64+'.scope',
        cgroup_inode=42, pid_namespace_inode=43, executable_device=1, executable_inode=44,
        uid=0, gid=0, container_id='a'*64, image_id='sha256:'+'b'*64, release_sha='c'*40)


class FrameTests(unittest.TestCase):
    def test_minimal_request_contains_no_identity_or_credential(self):
        self.assertEqual(m.request_frame(b'{"version":1,"operation":"acquireOriginalLaunch"}\n'),
                         {'version':1,'operation':'acquireOriginalLaunch'})

    def test_refuses_caller_identity_duplicate_trailing_and_invalid_frames(self):
        valid = b'{"version":1,"operation":"acquireOriginalLaunch"}\n'
        for raw in [b'',valid+valid,valid[:-1],valid.replace(b'1,',b'true,'),
                    valid.replace(b'1,',b'1,"pid":321,'),valid.replace(b'1,',b'1,"version":1,'),
                    valid.replace(b'1,',b'1,"registration_ref":"claimed",'),
                    b'\xff\n',b'x'*4097+b'\n']:
            with self.subTest(raw_bytes=len(raw)), self.assertRaises(Exception):
                m.request_frame(raw)

    def test_unknown_never_conveys_start_disposition_or_money_authority(self):
        for reason in ['canonical_registration_unavailable','peer_unproven','persistence_unavailable','request_refused']:
            value = m.unknown(reason)
            self.assertEqual(value['kind'],'unknown')
            self.assertFalse(value['startAuthority'])
            self.assertFalse(value['noStartAuthority'])
            self.assertFalse(value['financialMutationAuthority'])

    def test_fragmented_request_cannot_extend_the_absolute_read_deadline(self):
        class DrippingConnection:
            reads = 0
            reply = None
            timeouts = []
            def settimeout(self, value):self.timeouts.append(value)
            def recv(self, size):
                self.reads += 1
                return b'{'  # Each fragment alone would reset a per-read timeout.
            def sendall(self, value):self.reply = json.loads(value)
        connection = DrippingConnection()
        with patch.object(m.time,'monotonic',side_effect=[100,100,102,104]), \
             patch.object(m,'PeerIncarnation') as peer:
            m.handle(connection, None)
            peer.assert_not_called()
        self.assertEqual(connection.reads,2)
        self.assertEqual(connection.timeouts[:2],[3,1])
        self.assertEqual(connection.reply,m.unknown('request_refused'))


class PersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.root.chmod(0o700)
        self.store = m.PendingIdentityStore(self.root, owner_uid=os.geteuid())

    def tearDown(self):
        self.store.close()
        self.temporary.cleanup()

    def test_lost_reply_and_broker_restart_retain_one_immutable_pending_identity(self):
        first = self.store.prepare(identity())
        original = next(self.root.glob('*.json')).read_bytes()
        self.assertEqual(self.store.prepare(identity()),first)
        restarted = m.PendingIdentityStore(self.root, owner_uid=os.geteuid())
        try:self.assertEqual(restarted.prepare(identity()),first)
        finally:restarted.close()
        self.assertEqual(next(self.root.glob('*.json')).read_bytes(),original)
        self.assertEqual(len(list(self.root.glob('*.json'))),1)
        self.assertFalse(first['canonical_committed'])
        self.assertNotIn('registration_ref',first)

    def test_same_container_automatic_restart_has_a_new_incarnation(self):
        first = self.store.prepare(identity())
        # Reused PID/cgroup/container cannot reuse the old process start.
        second = self.store.prepare(dict(identity(),process_start_ticks='9999'))
        self.assertNotEqual(first['pending_ref'],second['pending_ref'])
        self.assertNotEqual(first['identity_sha256'],second['identity_sha256'])
        self.assertEqual(first['identity']['container_id'],second['identity']['container_id'])

    def test_host_reboot_cannot_reuse_prior_process_registration(self):
        first = self.store.prepare(identity())
        second = self.store.prepare(dict(identity(),kernel_boot_id='666496cf-48e1-4bc5-acba-6af83896e086'))
        self.assertNotEqual(first['pending_ref'],second['pending_ref'])

    def test_corrupt_record_is_preserved_and_refused(self):
        self.store.prepare(identity())
        path = next(self.root.glob('*.json'))
        for raw in [b'{partial',m.encode(dict(self.store.prepare(identity()),canonical_committed=True))]:
            path.write_bytes(raw)
            with self.assertRaises(Exception):self.store.prepare(identity())
            self.assertEqual(path.read_bytes(),raw)

    def test_preexisting_symlink_is_not_followed_or_replaced(self):
        outside=self.root/'unrelated';outside.write_text('preserve')
        name=hashlib.sha256(m.encode(identity())).hexdigest()+'.json'
        (self.root/name).symlink_to(outside)
        with self.assertRaises(OSError):self.store.prepare(identity())
        self.assertEqual(outside.read_text(),'preserve')
        self.assertTrue((self.root/name).is_symlink())

    def test_unacknowledged_fsync_never_reports_preparation_success(self):
        with patch.object(m.os,'fsync',side_effect=OSError('controlled disk failure')):
            with self.assertRaises(OSError):self.store.prepare(identity())
        self.assertEqual(list(self.root.glob('*.json')),[])

    def test_lost_directory_sync_is_rechecked_before_replay_is_reported_durable(self):
        real_sync = m.os.fsync
        def refuse_directory(fd):
            if fd == self.store.fd:
                raise OSError('controlled directory sync failure')
            real_sync(fd)
        with patch.object(m.os,'fsync',side_effect=refuse_directory):
            with self.assertRaises(OSError):self.store.prepare(identity())
            path = next(self.root.glob('*.json'))
            original = path.read_bytes()
            with self.assertRaises(OSError):self.store.prepare(identity())
            self.assertEqual(path.read_bytes(),original)
        self.assertEqual(self.store.prepare(identity())['identity'],identity())
        self.assertEqual(path.read_bytes(),original)

    def test_arbitrary_identity_fields_are_refused_before_persistence(self):
        for value in [dict(identity(),caller_token='rejected'),dict(identity(),pid=True),
                      dict(identity(),process_start_ticks='0'),dict(identity(),uid=1000)]:
            with self.assertRaises(RuntimeError):self.store.prepare(value)
        self.assertEqual(list(self.root.iterdir()),[])

    def test_readable_directory_and_record_modes_are_refused(self):
        self.root.chmod(0o755)
        with self.assertRaises(RuntimeError):m.PendingIdentityStore(self.root,owner_uid=os.geteuid())
        self.root.chmod(0o700)
        self.store.prepare(identity());path=next(self.root.glob('*.json'));path.chmod(0o644)
        with self.assertRaises(RuntimeError):self.store.prepare(identity())


if __name__ == '__main__':
    unittest.main()
