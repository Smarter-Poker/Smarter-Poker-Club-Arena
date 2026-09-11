#!/usr/bin/env python3
"""Actual native money owners; only identities, legacy rows and historical clocks are synthetic."""
import os,json,hashlib,subprocess,time,runpy
from pathlib import Path
from fixture_helpers import sql,setup,source,state
here=Path(os.environ['LEGACY_EXCLUSION_HERE']);checks=[]
def check(name,passed):
 assert passed,name
 checks.append(name);print('PASS: '+name,flush=True)
def load(name): return sql((here/name).read_text())
def refused(name,statement):
 before=state();error=sql(statement,False)
 assert 'Legacy commission receipt includes captured' in error,error
 check(name,'Legacy commission receipt includes captured' in error and before==state())
def money(): return json.loads(sql("SELECT jsonb_build_object('bank',(SELECT chip_treasury FROM clubs WHERE id=test_id(900)),'agent',(SELECT chip_balance FROM club_members WHERE club_id=test_id(900) AND user_id=test_id(301)))"))
def r2(): return json.loads(sql("SELECT fn_settle_round2_club_to_agents(test_id(901),'2026-08-24','2026-08-31');"))
def claim(op): return json.loads(sql(f"SELECT fn_agent_claim_commission(test_id(900),test_id({op}),1000);",actor=301))
setup()
load('fixture-view.sql')
load('00-expand.sql')
subprocess.run([os.environ['COMMISSION_PSQL'],'-X','-v','ON_ERROR_STOP=1','-f',str(here/'00-online-index.sql')],check=True)
load('00-preflight.sql');load('01-source-exclusion.sql');load('03-excluded-unpaid-rollups.sql')
sql("""INSERT INTO unions(id,name,owner_id,slug) VALUES(test_id(901),'Legacy Exclusion Union',test_id(100),'legacy-exclusion');
INSERT INTO union_clubs(union_id,club_id,rate_cash) VALUES(test_id(901),test_id(900),.90);
UPDATE tables SET union_id=test_id(901) WHERE id=test_id(950);
ALTER TABLE agent_commissions ALTER COLUMN created_at SET DEFAULT '2026-08-25T12:00:00Z'::timestamptz;""")
source(1800001,'20','2026-08-25T12:00:00Z','2026-08-25T12:00:00Z')
batch=json.loads(sql("SELECT fn_credit_agent_commissions_batch(jsonb_agg(jsonb_build_object('user_id',player_id,'club_id',booked_club_id,'rake_credit',rake_credit,'source_type','rake_settlement','source_id',hand_id))) FROM ca_cash_commission_facts WHERE hand_id=test_id(1800001) AND rake_credit>0;"))
assert batch.get('failed')==0,batch
check('Actual accepted and bank owners emitted captured positive commission projections',int(sql("SELECT count(*) FROM agent_commissions WHERE source_id=test_id(1800001) AND amount>0"))>0)
# Historical basis rows are synthetic inputs. Hand 1000001 was emitted by the actual
# accepted owner before marker activation in the companion exercise.sql; its marker is NULL.
# The commission rows themselves are not claimed historical owner emission.
sql("""INSERT INTO agent_commissions(club_id,user_id,amount,commission_rate,source_type,source_id,contributing_user_id,created_at)
VALUES(test_id(900),test_id(301),3,.70,'tournament_rake_settlement',test_id(1800002),test_id(201),'2026-08-25T12:00:01Z'),
(test_id(900),test_id(301),7,.70,'rake_settlement',test_id(1000001),test_id(201),'2026-08-25T12:00:02Z'),
(test_id(900),test_id(303),5,.30,'tournament_rake_settlement',test_id(1800004),test_id(201),'2026-08-25T12:00:03Z');""")
check('Known historical accepted source and tournament source stay legacy; captured cash is excluded',sql("SELECT ARRAY[fn_ca_commission_uses_captured_source('rake_settlement',test_id(1800001)),fn_ca_commission_uses_captured_source('rake_settlement',test_id(1000001)),fn_ca_commission_uses_captured_source('tournament_rake_settlement',test_id(1800001))]::text;")=='{t,f,f}')
refused('Actual unchanged legacy Round2 owner rolls back its money when final receipt includes projections',"SELECT fn_settle_round2_club_to_agents(test_id(901),'2026-08-24','2026-08-31');")
before=state();err=sql("SELECT fn_agent_claim_commission(test_id(900),test_id(1800101),1000);",False,actor=301)
check('Actual unchanged direct claim rolls back debit and credit before final projection receipt', 'Legacy commission receipt includes captured' in err and before==state())
overlap=runpy.run_path(str(here/'compiled-overlap.py'));checks.extend(overlap['checks'])
load('02-excluded-owners.sql')
check('Unpaid rollup excludes captured projection accruals',sql("SELECT owed FROM agent_commission_unsettled_rollup WHERE club_id=test_id(900) AND user_id=test_id(301);")=='10')
check('Unsettled reader shows only historical payable cash',sql("SELECT fn_agent_unsettled_commission(test_id(900),test_id(301));",actor=301)=='10')
before=money();paid=claim(1800102);after=money()
check('Updated actual direct owner pays historical ten once, excluding captured projections',paid['success'] and paid['amount']==10 and before['bank']-after['bank']==10 and after['agent']-before['agent']==10)
check('More flag ignores excluded projections',paid['more'] is False)
check('Unpaid view excludes all source-owned projections',sql("SELECT count(*) FROM agent_commissions_unsettled WHERE source_id=test_id(1800001);")=='0')
before=state();replayed=claim(1800102)
check('Exact direct lost-response replay makes no second money movement',replayed['replayed'] and replayed['amount']==10 and before==state() and replayed['more'] is False)
check('Legacy reader has no phantom projection debt after historical payment',sql("SELECT fn_agent_unsettled_commission(test_id(900),test_id(301));",actor=301)=='0')
before=money();agent_before=sql("SELECT chip_balance FROM club_members WHERE club_id=test_id(900) AND user_id=test_id(303);");paid=r2();after=money();agent_after=sql("SELECT chip_balance FROM club_members WHERE club_id=test_id(900) AND user_id=test_id(303);")
check('Updated actual Round2 pays historical five and excludes captured projections',paid['amount']==5 and before['bank']-after['bank']==5 and float(agent_after)-float(agent_before)==5)
before=state();paid=r2();check('Updated Round2 replay has no remaining captured projection payment',paid['amount']==0 and before==state())
check('Private source predicate is unavailable to browser and service direct callers',sql("SELECT NOT has_function_privilege('anon','fn_ca_commission_uses_captured_source(text,uuid)','execute') AND NOT has_function_privilege('authenticated','fn_ca_commission_uses_captured_source(text,uuid)','execute') AND NOT has_function_privilege('service_role','fn_ca_commission_uses_captured_source(text,uuid)','execute');")=='t')
check('Actual cash projection rows are locally indexed as captured',sql("SELECT bool_and(commission_capture_version=1) FROM agent_commissions WHERE source_id=test_id(1800001);")=='t')
check('Historical commission authority remains NULL',sql("SELECT bool_and(commission_capture_version IS NULL) FROM agent_commissions WHERE source_id=test_id(1000001);")=='t')
for name,query,expected in [
 ('Caller cannot forge captured authority on a historical source',"INSERT INTO agent_commissions(club_id,user_id,amount,commission_rate,source_type,source_id,contributing_user_id,commission_capture_version) VALUES(test_id(900),test_id(301),1,.70,'rake_settlement',test_id(1800301),test_id(201),1);",'contradicts accepted hand'),
 ('Captured source flag cannot be cleared',"UPDATE agent_commissions SET commission_capture_version=NULL WHERE source_id=test_id(1800001);",'identity and authority are immutable'),
 ('Captured source identity cannot be replaced',"UPDATE agent_commissions SET source_id=test_id(1800302) WHERE source_id=test_id(1800001);",'identity and authority are immutable'),
 ('Captured cash cannot be retagged as a tournament',"UPDATE agent_commissions SET source_type='tournament_rake_settlement' WHERE source_id=test_id(1800001);",'identity and authority are immutable')]:
 before=state();error=sql(query,False);check(name,expected in error and before==state())

postconditions=runpy.run_path(str(here/'postconditions.py'));checks.extend(postconditions['checks'])
performance=runpy.run_path(str(here/'query-plan-probe.py'));checks.extend(performance['checks'])
result={'status':'native_candidate_only','checks':checks,'runtime':sql('SELECT version();'),'fixture_inputs':{str(x.relative_to(Path(os.environ['ROUND1_INPUT']))):hashlib.sha256(x.read_bytes()).hexdigest() for x in Path(os.environ['ROUND1_INPUT']).rglob('*') if x.is_file()},'inputs':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in here.iterdir() if p.suffix in ['.sql','.py','.sh','.json'] and p.name!='native-proof.json'},'limits':['No production activation.','No complete outer cascade or common finality proof.','Closed timestamps and historical basis rows are explicitly synthetic; actual accepted/bank/legacy money owners run.']}
(here/'native-proof.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'passed':len(checks)}))

from proof_format import format_proof
format_proof(here/'native-proof.json')
