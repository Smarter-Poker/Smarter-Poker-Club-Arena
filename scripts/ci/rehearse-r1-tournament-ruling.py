#!/usr/bin/env python3
"""Replay the sealed R1 ruling using only an owned local PostgreSQL 17."""
from pathlib import Path
import hashlib, subprocess, sys, tarfile, tempfile
archive=Path(__file__).resolve().parent/'fixtures/r1-a5aa6984-20260911.tar.gz'
if hashlib.sha256(archive.read_bytes()).hexdigest()!='cbb11ac8dbb1ded847431cc9baface447d37b078a065ea48b91a6cd99c2f7704':
    raise SystemExit('Sealed R1 archive hash differs')
directory=Path(tempfile.mkdtemp(prefix='ca-r1-fixture-',dir='/tmp'))
with tarfile.open(archive,'r:gz') as source:
    for member in source.getmembers():
        if not member.isfile() or Path(member.name).name!=member.name:
            raise SystemExit('Unexpected fixture archive member')
        with source.extractfile(member) as content:
            (directory/member.name).write_bytes(content.read())
subprocess.run([sys.executable,str(directory/'run.py'),*sys.argv[1:]],check=True)
