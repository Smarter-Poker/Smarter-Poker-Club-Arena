#!/usr/bin/env python3
"""Required pure helper and exact installation qualification on isolated PostgreSQL 17."""
import argparse,hashlib,json,pathlib,subprocess,sys
P=pathlib.Path(__file__).resolve().parent;R=P.parents[2]
a=argparse.ArgumentParser();a.add_argument('--output',type=pathlib.Path,required=True);a.add_argument('--installer-only',action='store_true');args=a.parse_args();O=args.output.resolve();O.mkdir(parents=True,exist_ok=True)
for name,pin in json.loads((P/'source-binding.json').read_text())['files'].items():
 raw=(R/name).read_bytes()
 if len(raw)!=pin['bytes'] or hashlib.sha256(raw).hexdigest()!=pin['sha256']:raise RuntimeError('qualification source input differs: '+name)
for script in (['installer-driver.py'] if args.installer_only else ['semantic-driver.py','history-driver.py','installer-driver.py']):
 q=subprocess.run([sys.executable,str(P/script),'--output',str(O/script.removesuffix('.py'))],capture_output=True,text=True)
 (O/(script+'.stdout')).write_text(q.stdout);(O/(script+'.stderr')).write_text(q.stderr)
 print(q.stdout,end='');print(q.stderr,end='',file=sys.stderr)
 if q.returncode:raise SystemExit(q.returncode)
print('PASS bounded pure cohort/native recorded installer; no production/money RPC/performance claim')
