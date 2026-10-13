#!/usr/bin/env python3
"""Execute one explicitly named input against this task's already prepared PG17 only."""
import argparse,json,pathlib,subprocess,os,hashlib,sys
sys.dont_write_bytecode=True
p=argparse.ArgumentParser();p.add_argument('--state',type=pathlib.Path,required=True);p.add_argument('--sql',type=pathlib.Path,required=True);p.add_argument('--label',required=True);p.add_argument('--database');args=p.parse_args()
r=json.loads(args.state.read_text());db=args.database or r['database'];root=pathlib.Path('/Volumes/SmarterWork/agent-work/cash-original17-correction-01a13099')
for path in (args.state,args.sql,pathlib.Path(r['socket'])):
 if not str(path.resolve()).startswith('/Volumes/SmarterWork/agent-work/'):raise SystemExit('Owned SSD/private socket required')
if not db.startswith('r46_mtt_'):raise SystemExit('Private fixture database required')
env={k:v for k,v in os.environ.items() if not k.startswith('PG') and k not in ('DATABASE_URL','SUPABASE_DB_URL')};env.update(LC_ALL='C',LANG='C',TZ='UTC')
cmd=[r['pg_bin']+'/psql','-X','-qAt','-h',r['socket'],'-p','55496','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1']
a=subprocess.run(cmd+['-c',"SELECT inet_server_addr() IS NULL AND current_setting('server_version_num')::integer BETWEEN 170000 AND 179999"],env=env,capture_output=True,text=True,timeout=10)
if a.returncode or a.stdout.strip()!='t':raise SystemExit('Private PG17 boundary refused')
a=subprocess.run(cmd+['-f',str(args.sql)],env=env,capture_output=True,text=True,timeout=180)
out=args.state.parent;stem=args.label
(out/(stem+'.stdout')).write_text(a.stdout);(out/(stem+'.stderr')).write_text(a.stderr)
(out/(stem+'.receipt.json')).write_text(json.dumps({'database':db,'input':str(args.sql),'inputSHA256':hashlib.sha256(args.sql.read_bytes()).hexdigest(),'exit':a.returncode,'production':False})+'\n')
print(json.dumps({'label':stem,'exit':a.returncode,'privateLogs':str(out)}));sys.exit(a.returncode)
