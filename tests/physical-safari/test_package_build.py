"""Root-only bounded local product-validation fixtures; no codesign/device effects."""
import os,tempfile,plistlib,unittest
from pathlib import Path
import package_build as p
class ProductValidation(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']);self.root=Path(self.tmp.name);self.products=self.root/'Debug-iphoneos';self.products.mkdir()
  for n in ['AcceptanceHost.app','SafariTests-Runner.app','SafariTests-Runner.app/PlugIns/SafariTests.xctest']:
   q=self.products/n;q.mkdir(parents=True,exist_ok=True);(q/'Info.plist').write_bytes(plistlib.dumps({'CFBundleExecutable':'binary'}));(q/'binary').write_bytes(b'fixture-not-real-macho')
  self.run=self.root/'Acceptance.xctestrun';self.run.write_bytes(plistlib.dumps({'SafariTests':{'IsUITestBundle':True,'TestHostPath':'__TESTROOT__/Debug-iphoneos/SafariTests-Runner.app','TestBundlePath':'__TESTHOST__/PlugIns/SafariTests.xctest','UITargetAppPath':'__TESTROOT__/Debug-iphoneos/AcceptanceHost.app'}}))
 def tearDown(self):self.tmp.cleanup()
 def invoke(self,a):return 'arm64\n'if a[0].endswith('lipo')else 'Load command 1\n cmd LC_BUILD_VERSION\n platform 2\n'
 def test_real_structured_paths_are_required(self):
  p.validate(self.root,self.invoke);v=plistlib.loads(self.run.read_bytes());v['SafariTests']['TestHostPath']='__TESTROOT__/Debug-iphonesimulator/SafariTests-Runner.app';self.run.write_bytes(plistlib.dumps(v))
  with self.assertRaises(ValueError):p.validate(self.root,self.invoke)
 def test_absent_runner_xctestrun_symlink_and_fixture_leak_refuse(self):
  saved=self.run.read_bytes();self.run.unlink()
  with self.assertRaises(ValueError):p.validate(self.root,self.invoke)
  self.run.write_bytes(saved);q=self.products/'foreign';q.symlink_to(self.root)
  with self.assertRaises(ValueError):p.validate(self.root,self.invoke)
  q.unlink();self.run.write_bytes(saved.replace(b'SafariTests',b'CA_OWNED_FIXTURE_JSON'))
  with self.assertRaises(ValueError):p.validate(self.root,self.invoke)
 def test_simulator_or_nonarm64_binary_refuses(self):
  binary=self.products/'AcceptanceHost.app/binary'
  for arch,platform in [('x86_64','2'),('arm64','7')]:
   def fake(a):return arch if a[0].endswith('lipo')else 'Load command 1\n cmd LC_BUILD_VERSION\n platform '+platform+'\n'
   with self.assertRaises(ValueError):p.device_binary(binary,fake)
if __name__=='__main__':unittest.main()
