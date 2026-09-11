#!/usr/bin/env python3
"""Rehearse21 source-sealed D9 cash finishes and the unchanged modern E2 path."""
from pathlib import Path
import hashlib,subprocess,sys,tarfile,tempfile
base=Path(__file__).resolve().parent
archive=base/'fixtures/d9-cash-completion-20260911.tar.gz'
assert hashlib.sha256(archive.read_bytes()).hexdigest()=='9e22f74e5b4a408a58afa6bbaaceff73bc466ca2130978326fc52c5b6f8c4c55'
out=Path(tempfile.mkdtemp(prefix='ca-d9-completion-',dir='/tmp'))
with tarfile.open(archive) as source:
 for member in source.getmembers():
  assert member.isfile() and Path(member.name).name==member.name
  (out/member.name).write_bytes(source.extractfile(member).read())
assert (out/'test-cash-completion.py').read_bytes()==(base/'rehearsals/d9/test-cash-completion.py').read_bytes()
assert (out/'integration.sql').read_bytes()==(base.parent.parent/'supabase/migrations/20260911170040_complete_legacy_tournaments_from_sealed_accepted_hands.sql').read_bytes()
subprocess.run([sys.executable,str(out/'run-completion.py'),*sys.argv[1:]],check=True)
