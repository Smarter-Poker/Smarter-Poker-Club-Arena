#!/usr/bin/env python3
"""Final-atomic receipt regression inside the existing weekly native cluster."""
import hashlib,json,subprocess,sys
from pathlib import Path
root=Path(__file__).resolve().parents[2]
psql,socket,port,work=sys.argv[1:]
work=Path(work)
inputs=['scripts/dev/qualify-final-atomic-receipt.py','tests/fixtures/union-weekly-basis/captured-final-atomic-preimages.json','tests/fixtures/union-weekly-basis/final-atomic-before.sql','tests/fixtures/union-weekly-basis/final-atomic-after.sql',str(next((root/'supabase/migrations').glob('20260918004443*.sql')).relative_to(root))]
(work/'final-atomic-tested-binding.json').write_text(json.dumps({p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in inputs},indent=2)+'\n')
def run(sql,label):
 path=work/(label+'.sql');path.write_text(sql)
 result=subprocess.run([psql,'-X','-q','-v','ON_ERROR_STOP=1','-U','postgres','-h',socket,'-p',port,'-d','postgres','-f',str(path)],capture_output=True,text=True)
 (work/(label+'.log')).write_text(result.stdout+result.stderr)
 if result.returncode:raise AssertionError(label+': '+result.stderr[-5000:])
 print('PASS '+label,flush=True)
rows=json.loads((root/'tests/fixtures/union-weekly-basis/captured-final-atomic-preimages.json').read_text())
sql='SET check_function_bodies=off;\n'
for r in rows:
 sql+=r['definition']+';\nREVOKE ALL ON FUNCTION public.'+r['signature']+' FROM PUBLIC,anon,authenticated,service_role;\n'
 if 'service_role=' in r['acl']:sql+='GRANT EXECUTE ON FUNCTION public.'+r['signature']+' TO service_role;\n'
run(sql,'final-atomic-original-authorities')
run((root/'tests/fixtures/union-weekly-basis/final-atomic-before.sql').read_text(),'final-atomic-before')
run(next((root/'supabase/migrations').glob('20260918004443*.sql')).read_text(),'final-atomic-successor')
run((root/'tests/fixtures/union-weekly-basis/final-atomic-after.sql').read_text(),'final-atomic-after')
output=subprocess.check_output([psql,'-X','-A','-t','-U','postgres','-h',socket,'-p',port,'-d','postgres','-c',"SELECT jsonb_agg(to_jsonb(x) ORDER BY signature) FROM (SELECT p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) definition,md5(pg_get_functiondef(p.oid)) definition_md5,md5(p.prosrc) body_md5,pg_get_userbyid(p.proowner) owner,p.proacl::text acl,p.prosecdef security_definer,p.proconfig configuration FROM pg_proc p WHERE p.oid IN ('public.fn_cash_atomic_original_matches(jsonb,jsonb,jsonb)'::regprocedure,'public.fn_pnl_cash_hand_evidence(uuid,bigint)'::regprocedure)) x"],text=True)
(work/'final-atomic-candidate-functions.json').write_text(json.dumps(json.loads(output),indent=2)+'\n')
