#!/usr/bin/env python3
"""Verify and reclassify sealed read-only D9 evidence; performs no database calls."""
from pathlib import Path
import hashlib,subprocess,sys,tarfile,tempfile
archive=Path(__file__).resolve().parent/'fixtures/d9-current-cohort-20260911.tar.gz'
assert hashlib.sha256(archive.read_bytes()).hexdigest()=='49a8fbc07355013fd6b3605ae252c9961e829989a219774f67ef5bbe40fccf72'
out=Path(tempfile.mkdtemp(prefix='ca-d9-classification-',dir='/tmp'))
with tarfile.open(archive) as source:
    for member in source.getmembers():
        assert member.isfile() and Path(member.name).name==member.name
        (out/member.name).write_bytes(source.extractfile(member).read())
subprocess.run([sys.executable,str(out/'classify.py')],check=True)
print(str(out/'classification-receipt.json'))
