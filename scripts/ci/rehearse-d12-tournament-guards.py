#!/usr/bin/env python3
"""Rehearse seven-guard restoration on a sealed, socket-only local PG17 fixture."""
from pathlib import Path
import hashlib,subprocess,sys,tarfile,tempfile
here=Path(__file__).resolve().parent
archive=here/'fixtures/d12-tournament-guards-20260911.tar.gz'
if hashlib.sha256(archive.read_bytes()).hexdigest()!='9824936824f888c607b26b02b334c50a0fdd5f53bcc7f27eb881802f4b22f4ef':raise SystemExit('Sealed D12 fixture hash differs')
directory=Path(tempfile.mkdtemp(prefix='ca-d12-fixture-',dir='/tmp'))
with tarfile.open(archive,'r:gz') as source:
 for member in source.getmembers():
  if not member.isfile() or Path(member.name).name!=member.name:raise SystemExit('Unexpected D12 archive member')
  with source.extractfile(member) as content:(directory/member.name).write_bytes(content.read())
for name in ['run.py','lifecycle-probe.sql','verify-guard-poststate.py']:
 if (directory/name).read_bytes()!=(here/'rehearsals/d12'/name).read_bytes():raise SystemExit('Readable D12 proof differs: '+name)
migration=here.parent.parent/'supabase/migrations/20260911161539_restore_tournament_guards_with_canonical_terminal_receipts.sql'
subprocess.run([sys.executable,str(directory/'run.py'),'--migration',str(migration),*sys.argv[1:]],check=True)
