"""Native-only auth-shim barriers, unchanged real legacy money-owner bodies."""
import os,json,subprocess,time
from pathlib import Path
from fixture_helpers import sql,state
here=Path(os.environ['LEGACY_EXCLUSION_HERE']);psql=os.environ['COMMISSION_PSQL']
checks=[];observations=[]
def wait_for(q):
 for _ in range(100):
  if sql(q)=='t': return
  time.sleep(.02)
 raise AssertionError('Expected native blocker was not observed: '+q)
def spawn(statement):
 return subprocess.Popen([psql,'-X','-qAt','-v','ON_ERROR_STOP=1','-c',statement],text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
# Auth identities already use native-only shims. A barrier here lets the actual
# PL/pgSQL owner compile before its first financial query, without replacing money.
sql("""CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE plpgsql STABLE AS $$
BEGIN IF current_setting('test.pause_auth',true)='on' THEN PERFORM pg_advisory_xact_lock(530191,1);END IF;
RETURN nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;END$$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE plpgsql STABLE AS $$
BEGIN IF current_setting('test.pause_auth',true)='on' THEN PERFORM pg_advisory_xact_lock(530191,1);END IF;
RETURN nullif(current_setting('request.jwt.claim.role',true),'');END$$;""")
catalog=json.loads((here/'installed-catalog.json').read_text())['functions']
for name,actor,call in [('fn_settle_round2_club_to_agents',100,"SELECT fn_settle_round2_club_to_agents(test_id(901),'2026-08-24','2026-08-31');"),('fn_agent_claim_commission',301,"SELECT fn_agent_claim_commission(test_id(900),test_id(1800199),1000);")]:
 original=next(x for x in catalog if x['signature'].startswith(name+'('))
 sql(original['definition']+';DROP TRIGGER ca_legacy_commission_receipt_excludes_captured ON agent_commission_settlements;')
 holder=subprocess.Popen([psql,'-X','-qAt','-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 holder.stdin.write('BEGIN;SELECT pg_advisory_xact_lock(530191,1);\n');holder.stdin.flush()
 wait_for("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=530191 AND objid=1 AND granted);")
 before=state()
 old=spawn(f"SELECT set_config('request.jwt.claim.sub',test_id({actor})::text,false);SELECT set_config('test.pause_auth','on',false);"+call)
 wait_for("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=530191 AND objid=1 AND NOT granted);")
 observations.append({'owner':name,'old_body_md5':original['body_md5'],'observed_wait':True,'barrier':'native auth shim before first financial query'})
 sql("BEGIN;SET LOCAL lock_timeout='1s';CREATE TRIGGER ca_legacy_commission_receipt_excludes_captured BEFORE INSERT ON agent_commission_settlements FOR EACH ROW EXECUTE FUNCTION fn_ca_legacy_commission_receipt_excludes_captured();"+(here/'02-excluded-owners.sql').read_text()+'COMMIT;')
 holder.stdin.write('COMMIT;\n\\q\n');holder.stdin.flush();holder.communicate(timeout=10)
 out,err=old.communicate(timeout=15)
 assert old.returncode and 'Legacy commission receipt includes captured' in err, (name,out,err)
 assert state()==before,name+' changed public data'
 label='Compiled old '+name+' resumes after owner replacement and rolls back all money at receipt guard'
 checks.append(label);print('PASS: '+label,flush=True)
sql("""CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.role',true),'')$$;""")
(here/'compiled-overlap-proof.json').write_text(json.dumps({'checks':checks,'observations':observations,'scope':'Native auth barriers only; actual old money owners compiled and executed. No production mutations.'},indent=2)+'\n')

from proof_format import format_proof
format_proof(here/'compiled-overlap-proof.json')
