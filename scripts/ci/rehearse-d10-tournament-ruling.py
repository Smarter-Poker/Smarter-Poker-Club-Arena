#!/usr/bin/env python3
"""Replay the sealed D10 ruling and native invalidation guards on local PG17."""
from pathlib import Path
import hashlib, subprocess, sys, tarfile, tempfile
archive=Path(__file__).resolve().parent/'fixtures/d10-c1f15c30-20260911.tar.gz'
if hashlib.sha256(archive.read_bytes()).hexdigest()!='9ccc3b7fcc4527167ed583fa56bc32a6ac87b5025efd2e0301f7dda1c00b525b':
    raise SystemExit('Sealed D10 archive hash differs')
directory=Path(tempfile.mkdtemp(prefix='ca-d10-fixture-',dir='/tmp'))
with tarfile.open(archive,'r:gz') as source:
    for member in source.getmembers():
        if not member.isfile() or Path(member.name).name!=member.name:
            raise SystemExit('Unexpected fixture archive member')
        with source.extractfile(member) as content:
            (directory/member.name).write_bytes(content.read())
for name in ['verify-local.py','test-paid-evidence.py','test-d12-replay.py','extract-bust-evidence.py']:
    if (directory/name).read_bytes()!=(Path(__file__).resolve().parent/'rehearsals/d10'/name).read_bytes():
        raise SystemExit('Readable native proof differs from the sealed fixture: '+name)
subprocess.run([sys.executable,str(directory/'run.py'),*sys.argv[1:]],check=True)
