"""Prove all seven guards and unchanged entry-point security after real completion."""
from pathlib import Path
import json,subprocess
b=Path(__file__).resolve().parent;s=json.loads((b/'cluster.json').read_text())
assert s['cluster'].startswith('/tmp/ca-e2-owned-') and s['database']=='e2_bee519fa'
p=['/opt/homebrew/opt/postgresql@17/bin/psql','-X','-v','ON_ERROR_STOP=1','-h',s['socket'],'-p',str(s['port']),'-U','postgres','-d',s['database'],'-Atc']
def query(q):return json.loads(subprocess.check_output(p+[q],text=True))
names=json.loads((b/'pins-receipt.json').read_text())['disabledTournamentGuards']
g=query("SELECT jsonb_object_agg(t.tgname,jsonb_build_object('enabled',t.tgenabled,'function',p.proname,'bodyMd5',md5(p.prosrc))) FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='public.tournaments'::regclass AND t.tgname IN ("+','.join("'"+n+"'" for n in names)+")")
assert len(g)==7 and all(v['enabled']=='O' for v in g.values())
service=['fn_settle_tournament_places(uuid,uuid)','fn_complete_tournament_terminal(uuid,uuid,text)','trg_tournament_atomic_place_completion_guard()','trg_freeze_batched_tournament_place()']
private=['fn_tournament_finish_readiness(uuid,uuid)','fn_ca_verify_terminal_place_batch(uuid,boolean)']
metadata={}
for name in service+private:
 r=query("SELECT jsonb_build_object('owner',pg_get_userbyid(proowner),'definer',prosecdef,'config',proconfig,'anon',has_function_privilege('anon',oid,'EXECUTE'),'authenticated',has_function_privilege('authenticated',oid,'EXECUTE'),'service',has_function_privilege('service_role',oid,'EXECUTE'),'bodyMd5',md5(prosrc)) FROM pg_proc WHERE oid='public."+name+"'::regprocedure")
 assert r['owner']=='postgres' and r['definer'] and not r['anon'] and not r['authenticated'] and r['service']==(name in service),(name,r)
 metadata[name]=r
assert metadata['fn_complete_tournament_terminal(uuid,uuid,text)']['bodyMd5']=='541b6e9d029b8eec7f55aa4ad6965a63'
result={'sevenActiveGuards':g,'entryPointMetadata':metadata,'sessionReplicationRole':query("SELECT to_jsonb(current_setting('session_replication_role'))")}
assert result['sessionReplicationRole']=='origin'
(b/'guard-poststate-receipt.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
