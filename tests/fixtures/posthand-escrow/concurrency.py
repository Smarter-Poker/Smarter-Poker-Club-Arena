"""Controlled native same-original writer admission; no latency assumptions."""
from pathlib import Path
import os
import select
import subprocess
import sys
import time

pgbin, socket = sys.argv[1:]
base = [str(Path(pgbin)/'psql'), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', '56436', '-U', 'postgres']
database = 'posthand_concurrent'
subprocess.run(base+['-d','postgres','-c',f'CREATE DATABASE {database} TEMPLATE postgres'],check=True,capture_output=True)
command=base+['-d',database]
call="SELECT public.fn_union_pnl_certify_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564,md5(public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)::text),encode(extensions.digest(convert_to(smarter_private.posthand_escrow_original_snapshot('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)::text,'UTF8'),'sha256'),'hex'));"
owner=None
try:
    owner=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,bufsize=0)
    owner.stdin.write(('BEGIN;'+call+'\n\\echo FIRST_CERTIFICATE_UNCOMMITTED\n').encode());owner.stdin.flush()
    deadline=time.monotonic()+15;output=b''
    while b'FIRST_CERTIFICATE_UNCOMMITTED' not in output:
        remaining=deadline-time.monotonic()
        if remaining<=0 or owner.poll() is not None: raise RuntimeError('first writer readiness absent')
        if select.select([owner.stdout],[],[],remaining)[0]:output+=os.read(owner.stdout.fileno(),65536)
    second=subprocess.run(command,input=call,text=True,capture_output=True,timeout=15)
    assert second.returncode!=0 and 'POSTHAND_ESCROW_ORIGINAL_EVENT_OWNED' in second.stderr,second.stderr
    print('PASS concurrent exact original writer refuses while first certificate remains uncommitted')
    owner.stdin.write(b'COMMIT;\n\\q\n');owner.stdin.flush();owner.wait(timeout=15)
    assert owner.returncode==0,owner.stderr.read().decode()
    duplicate=subprocess.run(command,input=call,text=True,capture_output=True,timeout=15)
    assert duplicate.returncode!=0 and 'POSTHAND_ESCROW_CERTIFICATE_ALREADY_EXISTS' in duplicate.stderr,duplicate.stderr
    count=subprocess.run(command+['-At','-c','SELECT count(*) FROM smarter_private.posthand_escrow_certificates'],text=True,capture_output=True,check=True,timeout=15)
    assert count.stdout.strip()=='1',count.stdout
    print('PASS first writer commits one certificate; subsequent duplicate refuses with no second row')
finally:
    if owner is not None and owner.poll() is None:
        try:owner.stdin.write(b'ROLLBACK;\n\\q\n');owner.stdin.flush();owner.wait(timeout=5)
        except (BrokenPipeError,subprocess.TimeoutExpired):owner.kill();owner.wait(timeout=5)
    subprocess.run(base+['-d','postgres','-c',f'DROP DATABASE {database}'],check=True,capture_output=True,timeout=15)
