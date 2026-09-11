#!/usr/bin/env python3
"""Replay the sealed D1 ruling and native invalidation guards on local PG17."""
from pathlib import Path
import hashlib, subprocess, sys, tarfile, tempfile
archive=Path(__file__).resolve().parent/'fixtures/d1-7aa16fa7-20260911.tar.gz'
if hashlib.sha256(archive.read_bytes()).hexdigest()!='3e4a46f2063eb583fb6ac94f7f1e4226fde967df7c29a5f2825fe05aa5391d19':
    raise SystemExit('Sealed D1 archive hash differs')
directory=Path(tempfile.mkdtemp(prefix='ca-d1-fixture-',dir='/tmp'))
with tarfile.open(archive,'r:gz') as source:
    for member in source.getmembers():
        if not member.isfile() or Path(member.name).name!=member.name:
            raise SystemExit('Unexpected fixture archive member')
        with source.extractfile(member) as content:
            (directory/member.name).write_bytes(content.read())
for name in ['test-invalidations.py','verify-local.py']:
    if (directory/name).read_bytes()!=(Path(__file__).resolve().parent/'rehearsals/d1'/name).read_bytes():
        raise SystemExit('Readable native proof differs from the sealed fixture: '+name)
subprocess.run([sys.executable,str(directory/'run.py'),*sys.argv[1:]],check=True)
