#!/usr/bin/env python3
"""Verify and run the sealed private D9 standings proof on isolated PostgreSQL17."""
from pathlib import Path
import hashlib,subprocess,sys,tarfile,tempfile
base=Path(__file__).resolve().parent
archive=base/'fixtures/d9-legacy-witness-20260911.tar.gz'
assert hashlib.sha256(archive.read_bytes()).hexdigest()=='8362576de367577effe686496138192d868454b33ba215f153167469876eff7c'
out=Path(tempfile.mkdtemp(prefix='ca-d9-witness-',dir='/tmp'))
with tarfile.open(archive) as source:
 for member in source.getmembers():
  assert member.isfile() and Path(member.name).name==member.name
  (out/member.name).write_bytes(source.extractfile(member).read())
for name in ['test-accepted-fact.py','test-finish-witness.py']:
 assert (out/name).read_bytes()==(base/'rehearsals/d9'/name).read_bytes()
subprocess.run([sys.executable,str(out/'run.py'),*sys.argv[1:]],check=True)
