#!/usr/bin/env python3
"""Replay the sealed bee519fa accounting fixture on an isolated local PG17."""
from pathlib import Path
import hashlib, subprocess, sys, tarfile, tempfile

archive = Path(__file__).resolve().parent/'fixtures/e2-bee519fa-20260911.tar.gz'
expected = '6be71661c49edd736ad78bf62582389ecce5cf06b46eb44237ff8a69833693c1'
if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
    raise SystemExit('Sealed E2 archive hash differs')
directory = Path(tempfile.mkdtemp(prefix='ca-e2-fixture-',dir='/tmp'))
with tarfile.open(archive,'r:gz') as source:
    for member in source.getmembers():
        if not member.isfile() or Path(member.name).name != member.name:
            raise SystemExit('Fixture contains an unexpected archive member')
        with source.extractfile(member) as content:
            (directory/member.name).write_bytes(content.read())
subprocess.run([sys.executable,str(directory/'run.py'),*sys.argv[1:]],check=True)
