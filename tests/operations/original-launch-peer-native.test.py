"""Refuse native PID mutation outside its exact disposable namespace scope."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('native_peer',Path(__file__).with_name('original-launch-peer-native.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class ScopeRefusals(unittest.TestCase):
 def test_nonlinux_execute_never_creates_a_fixture(self):
  with patch.object(m.sys,'platform','darwin'),patch.object(m.tempfile,'TemporaryDirectory') as create:
   with self.assertRaisesRegex(RuntimeError,'DISPOSABLE_NATIVE_CI_ROOT_REQUIRED'):
    m.execute(Path('/unallocated'), 'a'*40)
   create.assert_not_called()
 def test_host_pid_cannot_enter_worker(self):
  with patch.object(m.sys,'platform','linux'),patch.object(m.os,'geteuid',return_value=0),patch.object(m.os,'getpid',return_value=123),patch.object(Path,'write_text') as write:
   with self.assertRaisesRegex(RuntimeError,'PRIVATE_INIT_REQUIRED'):m.worker(Path('/unallocated'),'pid:[100]')
   write.assert_not_called()
 def test_matching_parent_namespace_refuses_before_pid_slot_write(self):
  with patch.object(m.sys,'platform','linux'),patch.object(m.os,'geteuid',return_value=0),patch.object(m.os,'getpid',return_value=1),patch.object(m.os,'readlink',return_value='pid:[100]'),patch.object(Path,'write_text') as write:
   with self.assertRaisesRegex(RuntimeError,'PRIVATE_PID_NAMESPACE_REQUIRED'):m.worker(Path('/unallocated'),'pid:[100]')
   write.assert_not_called()
 def test_host_proc_mount_refuses_even_with_new_pid_namespace(self):
  with patch.object(m.sys,'platform','linux'),patch.object(m.os,'geteuid',return_value=0),patch.object(m.os,'getpid',return_value=1),patch.object(m.os,'readlink',return_value='pid:[101]'),patch.object(Path,'read_text',return_value='NSpid:\t1000\t1\n'),patch.object(Path,'write_text') as write:
   with self.assertRaisesRegex(RuntimeError,'PRIVATE_PROC_MOUNT_REQUIRED'):m.worker(Path('/unallocated'),'pid:[100]')
   write.assert_not_called()
if __name__=='__main__':unittest.main()
