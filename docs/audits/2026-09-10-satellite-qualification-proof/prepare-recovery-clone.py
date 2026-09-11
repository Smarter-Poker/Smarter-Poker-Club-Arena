#!/usr/bin/env python3
"""Prepare owned local proof clone; never contacts Supabase or production."""
import json,importlib.util,subprocess
from pathlib import Path
P=Path(__file__).resolve().parent
sp=importlib.util.spec_from_file_location('native',P/'running-target-native.py');n=importlib.util.module_from_spec(sp);sp.loader.exec_module(n)
assert n.DB=='satellite_recovery_sep10'
identity_command=n.PSQL[:n.PSQL.index('-d')]+['-d','postgres','-v','ON_ERROR_STOP=1']
identity=subprocess.run(identity_command,input="SELECT current_database(),current_setting('data_directory'),inet_server_addr() IS NULL;",text=True,capture_output=True,check=True)
assert identity.stdout.strip()=='postgres|/tmp/codex-satellite-recovery-pg17/data|t','Private Unix-socket cluster identity required before database creation'
r=subprocess.run(n.PSQL[:n.PSQL.index('-d')]+['-d','postgres','-v','ON_ERROR_STOP=1'],input="CREATE DATABASE satellite_recovery_sep10 TEMPLATE satellite_qualification_verified;",text=True,capture_output=True)
if r.returncode: raise RuntimeError(r.stderr)
sql='BEGIN; GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO postgres; GRANT USAGE ON SCHEMA auth TO postgres; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO postgres; GRANT SELECT ON public.tournaments,public.tournament_players TO service_role; GRANT ALL ON public.tables,public.clubs,public.table_seats,public.player_sessions TO service_role;'
for name in ['current-funded-helpers.json','current-placement-authorities.json','current-seat-authority-trigger.json']:
 for row in json.loads((P/name).read_text()):
  signature='public.'+row['signature'];sql+=row['definition']+';ALTER FUNCTION '+signature+' OWNER TO postgres;REVOKE ALL ON FUNCTION '+signature+' FROM PUBLIC,anon,authenticated,service_role,"smarter.poker";GRANT EXECUTE ON FUNCTION '+signature+' TO postgres;'
  if 'service_role=' in row['acl']: sql+='GRANT EXECUTE ON FUNCTION '+signature+' TO service_role;'
for row in json.loads((P/'current-placement-gate.json').read_text()):
 sig='public.'+row['signature'];sql+='ALTER FUNCTION '+sig+' OWNER TO postgres;REVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC,anon,authenticated,service_role,"smarter.poker";GRANT EXECUTE ON FUNCTION '+sig+' TO postgres;'
 if 'service_role=' in row['acl']: sql+='GRANT EXECUTE ON FUNCTION '+sig+' TO service_role;'
sql+=(P/'current-placement-gate.sql').read_text()
m=(P.parents[2]/'supabase/migrations/20260910054035_satellites_record_equal_qualifiers_without_fabricated_finish.sql').read_text()
a=m.index('CREATE OR REPLACE FUNCTION public.fn_ca_settle_satellite_with_seat_authority(');b=m.index('-- All legacy money paths delegate',a)
sql+=m[a:b]+'COMMIT;'
r=n.run(sql)
(P/'recovery-fixture-install-results.json').write_text(json.dumps({'exit_code':r.returncode,'stdout':r.stdout,'stderr':r.stderr,'database':n.DB,'template':'satellite_qualification_verified','limits':['Source schema and Stage B come from restored donor fixture','Only captured changed authorities have production owner/ACL restored','Other restored objects retain local owner; postgres receives fixture access','Service role receives SELECT on tournaments and tournament_players, matching production read grants','Service role receives existing production table privileges on tables, clubs, table_seats and player_sessions so deferred invoker triggers execute at commit']},indent=2)+'\n')
print(r.returncode,r.stderr)
raise SystemExit(r.returncode)
