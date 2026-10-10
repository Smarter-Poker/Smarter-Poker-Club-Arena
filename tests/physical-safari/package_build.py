"""Build-only actual device package validation; no TestLab/device/credentials."""
import hashlib,json,plistlib,subprocess,sys,zipfile,re
from pathlib import Path
MAX=268435456
def need(v):
 if not v:raise ValueError('physical_safari_package_refused')
def run(args):
 p=subprocess.run(args,stdin=subprocess.DEVNULL,capture_output=True,timeout=30);need(p.returncode==0 and len(p.stdout)+len(p.stderr)<=1048576);return p.stdout.decode('utf-8','strict')
def device_binary(binary,invoke=run):
 need(binary.is_file()and not binary.is_symlink())
 arch=invoke(['/usr/bin/lipo','-archs',str(binary)]).strip().split();need('arm64'in arch and set(arch)<={'arm64','arm64e'})
 load=invoke(['/usr/bin/otool','-l',str(binary)])
 blocks=re.split(r'Load command \d+',load);platforms=[]
 for b in blocks:
  if re.search(r'\bcmd LC_BUILD_VERSION\b',b):
   p=re.search(r'^\s*platform\s+(\S+)\s*$',b,re.M);need(p is not None);platforms.append(p[1])
 need(platforms and all(p in {'2','IOS'}for p in platforms)) # IOS_SIMULATOR=7 refused.
 return {'architectures':arch,'platform':'iOS','LC_BUILD_VERSIONVerified':True}
def validate(root,invoke=run):
 need(root.is_absolute()and root.resolve()==root and root.is_dir())
 paths=list(root.rglob('*'));need(all(not p.is_symlink()for p in paths));need(sum(p.stat().st_size for p in paths if p.is_file())<=MAX)
 xs=list(root.glob('*.xctestrun'));need(len(xs)==1 and 0<xs[0].stat().st_size<=1048576)
 raw=xs[0].read_bytes();need(b'CA_OWNED_FIXTURE_JSON'not in raw);p=plistlib.loads(raw);need(isinstance(p,dict))
 if 'TestConfigurations'in p:
  targets=[t for c in p['TestConfigurations']for t in c.get('TestTargets',[])]
 else:targets=[v for k,v in p.items()if k!='__xctestrun_metadata__'and isinstance(v,dict)]
 need(len(targets)==1);t=targets[0];need(t.get('IsUITestBundle')is True)
 def resolve(value,host=None):
  need(isinstance(value,str)and value)
  value=value.replace('__TESTROOT__',str(root))
  if host is not None:value=value.replace('__TESTHOST__',str(host))
  need('__'not in value);q=Path(value);need(q.is_absolute()and q.resolve()==q and root/'Debug-iphoneos'in q.parents and q.exists());return q
 host=resolve(t.get('TestHostPath'));bundle=resolve(t.get('TestBundlePath'),host);app=resolve(t.get('UITargetAppPath'))
 need(host.name.endswith('-Runner.app')and host.suffix=='.app'and bundle.suffix=='.xctest'and app.name=='AcceptanceHost.app')
 bundles=sorted([q for q in paths if q.is_dir()and q.suffix in{'.app','.xctest','.framework'}],key=lambda q:len(q.parts),reverse=True)
 need(host in bundles and bundle in bundles and app in bundles)
 identities=[]
 for q in bundles:
  info=q/'Info.plist';need(info.is_file());v=plistlib.loads(info.read_bytes());name=v.get('CFBundleExecutable');need(isinstance(name,str)and name and '/'not in name)
  identities.append({'bundle':str(q.relative_to(root)),**device_binary(q/name,invoke)})
 for q in paths:
  if q.is_file()and q.suffix=='.dylib':identities.append({'binary':str(q.relative_to(root)),**device_binary(q,invoke)})
 return xs[0],bundles,identities
def main():
 need(len(sys.argv)==3 and not sys.flags.optimize);root,out=map(Path,sys.argv[1:]);xs,bundles,identities=validate(root)
 need(out.is_absolute()and not out.exists());out.mkdir()
 for b in bundles:
  run(['/usr/bin/codesign','--force','--sign','-',str(b)]);run(['/usr/bin/codesign','--verify','--deep','--strict','--verbose=2',str(b)])
 # Revalidate exact signed product paths/platform before archive. No secret fixture embedded.
 _,_,signed=validate(root);need(signed==identities)
 with zipfile.ZipFile(out/'xctest.zip','w',zipfile.ZIP_DEFLATED)as z:
  for x in sorted(root.rglob('*')):
   if x.is_file():need(not x.is_symlink());z.write(x,x.relative_to(root))
 size=(out/'xctest.zip').stat().st_size;need(0<size<=MAX)
 h=hashlib.sha256()
 with (out/'xctest.zip').open('rb')as f:
  for b in iter(lambda:f.read(1048576),b''):h.update(b)
 (out/'package-proof.json').write_text(json.dumps({'schema':'physical-safari-xctest-build/v2','zipSHA256':h.hexdigest(),'zipBytes':size,'inputSignature':'adhoc','allBundlesVerified':True,'verifiedDeviceProducts':signed,'xctestrunSHA256':hashlib.sha256(xs.read_bytes()).hexdigest(),'testLabAdmission':False,'physicalSafariExecuted':False,'fundedAcceptance':False},sort_keys=True)+'\n')
if __name__=='__main__':main()
