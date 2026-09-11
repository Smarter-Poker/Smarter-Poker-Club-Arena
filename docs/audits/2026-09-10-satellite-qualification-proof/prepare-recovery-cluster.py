#!/usr/bin/env python3
"""Physical clone preserves donor NOT VALID constraints and synthetic seed exactly."""
import subprocess,json
from pathlib import Path
B='/opt/homebrew/opt/postgresql@17/bin/'
P=Path('/tmp/codex-satellite-recovery-pg17')
def execute(cmd,sql=None):
 r=subprocess.run(cmd,input=sql,text=True,capture_output=True)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout
assert not P.exists(),'Refuse to overwrite any existing cluster'
P.mkdir(mode=0o700);(P/'socket').mkdir(mode=0o700)
execute([B+'pg_basebackup','-h','/tmp/codex-satellite-cohort-pg17/socket','-p','55387','-D',str(P/'data'),'-X','stream','--checkpoint=fast'])
execute([B+'pg_ctl','-D',str(P/'data'),'-l',str(P/'server.log'),'-o','-p 55388 -k '+str(P/'socket')+' -c listen_addresses=','start','-w'])
new=[B+'psql','-X','-qAt','-h',str(P/'socket'),'-p','55388','-d','postgres','-v','ON_ERROR_STOP=1']
execute(new,"DO $$BEGIN IF current_setting('data_directory')<>'/tmp/codex-satellite-recovery-pg17/data' THEN RAISE EXCEPTION 'Owned recovery cluster only';END IF;END$$; ALTER ROLE service_role BYPASSRLS;")
# This database is an unused physical copy of our earlier diagnostic clone.
# The original database and the donor template remain on the original cluster.
execute(new,'DROP DATABASE satellite_recovery_sep10;')
print(json.dumps({'cluster':str(P),'port':55388,'copy':'physical base backup','service_role_bypassrls':True,'original_cluster_unchanged':True}))
