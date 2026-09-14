from pathlib import Path
import json,subprocess
b=Path(__file__).resolve().parent;s=json.loads((b/'cluster.json').read_text());assert s['database']=='d9_satellite_completion_v2'
ps=['/opt/homebrew/opt/postgresql@17/bin/psql','-X','-v','ON_ERROR_STOP=1','-h',s['socket'],'-p',str(s['port']),'-U','postgres','-d',s['database']]
x=json.loads((b/'live-three-target-support.json').read_text());contracts=json.loads((b/'original-contracts.json').read_text())['contracts']
data={'public.clubs':x['clubs'],'public.tournaments':x['targets'],'public.tournament_players':x['players'],'public.tournament_escrow':x['escrows'],'public.managed_game_contract_versions':contracts}
users={p['user_id'] for p in x['players']}
for t in ['targets','clubs']:
 for r in x[t]:
  for key in ['created_by','creator_id','owner_id']:
   if r.get(key):users.add(r[key])
identity={'auth.users':[{'id':u} for u in users],'public.users':[{'id':u,'username':'sat_'+u.replace('-','')} for u in users],'public.profiles':[{'id':u,'username':'sat_'+u.replace('-','')} for u in users]}
data={**identity,**data}
cols=json.loads(subprocess.check_output(ps+['-Atc',"SELECT jsonb_agg(to_jsonb(c)) FROM information_schema.columns c WHERE table_schema IN ('public','auth');"],text=True)); known={}
for c in cols:known.setdefault(c['table_schema']+'.'+c['table_name'],{})[c['column_name']]=c['is_generated']
sql=['BEGIN;','SET LOCAL session_replication_role=replica;']
for table,rs in data.items():
 for r in rs:
  assert not(set(r)-set(known[table])),(table,set(r)-set(known[table]))
  r={k:v for k,v in r.items() if known[table][k]=='NEVER'};cs=','.join('"'+k+'"' for k in r);v=json.dumps(r,separators=(',',':')).replace("'","''")
  sql.append(f"INSERT INTO {table} ({cs}) OVERRIDING SYSTEM VALUE SELECT {cs} FROM jsonb_populate_record(NULL::{table},'{v}'::jsonb) ON CONFLICT DO NOTHING;")
sql+=['COMMIT;','SHOW session_replication_role;'];(b/'seed-targets.sql').write_text('\n'.join(sql))
r=subprocess.run(ps+['-f',str(b/'seed-targets.sql')],text=True,capture_output=True);(b/'seed-targets.log').write_text(r.stdout+r.stderr);assert r.returncode==0,r.stderr[-3000:];print({t:len(v) for t,v in data.items()})
