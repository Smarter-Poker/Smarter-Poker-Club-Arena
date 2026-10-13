#!/usr/bin/env python3
"""Actual late proof + original move lineage, exact source gates, isolated PG17."""
from pathlib import Path
import json,re,subprocess,os,time
P=Path(__file__).resolve().parent;R=P.parents[2];O=Path(os.environ['ELIG_NATIVE_OUTPUT']);O.mkdir(parents=True,exist_ok=True)
cmd=[str(Path(os.environ['PG_BIN'])/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',os.environ['ELIG_NATIVE_SOCKET'],'-p',os.environ['ELIG_NATIVE_PORT'],'-U','postgres','-d',os.environ.get('ELIG_NATIVE_DB','postgres')]
def call(sql,name):
 (O/(name+'.sql')).write_text(sql);r=subprocess.run(cmd,input=sql,text=True,capture_output=True,timeout=60);(O/(name+'.stdout')).write_text(r.stdout);(O/(name+'.stderr')).write_text(r.stderr)
 if r.returncode:raise RuntimeError(name+': '+r.stderr[-2300:])
 return r.stdout.strip()
def file(path):return Path(path).read_text()
F=R/'tests/fixtures/late-seat-flow';Old=R/'tests/fixtures/union-pnl-blocked-resolution';Orig=R/'tests/fixtures/original-unchanged-stack'
subprocess.run(['python3',str(F/'load-captured.py'),str(F/'captured.jsonb'),str(O/'load.sql'),str(F/'captured-moves.jsonb')],check=True)
files=[Old/'schema.sql',F/'schema-additions.sql',Orig/'schema-additions.sql',F/'admission-preimages.sql',Orig/'cents-preimage.sql',F/'consumer-preimage.sql',F/'retained-preimages.sql',F/'retained-key-preimage.sql',F/'compact-preimages.sql',F/'unused-original-dependencies.sql',Orig/'lineage-preimage.sql',O/'load.sql']
setup='\n'.join(file(x).rstrip()+';' for x in files)
setup=re.sub(r'CREATE ROLE (anon|authenticated|service_role)(?: NOLOGIN)?;',lambda m:"DO $$BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='"+m[1]+"') THEN CREATE ROLE "+m[1]+";END IF;END$$;",setup,flags=re.I)
call(setup,'actual-captured31-bootstrap')
helpers=json.loads((P/'actual-helpers.json').read_text())
call('\n'.join(x['definition']+';REVOKE ALL ON FUNCTION public.'+x['signature']+' FROM PUBLIC,anon,authenticated,service_role;'+('GRANT EXECUTE ON FUNCTION public.'+x['signature']+' TO service_role;' if 'service_role=X/postgres' in x['acl'] else '') for x in helpers),'actual-current-helper-sources')
# Full directly affected projected financial branch; private33+7 return branches
# are byte unchanged, not replaced/mocked or claimed exercised here.
before=file(P/'before-flow.sql');after=file(P/'after-flow.sql')
def body(s):return s.split('AS $function$\n',1)[1].split('\n UNION ALL SELECT * FROM smarter_private.original_restoration_cash_returns',1)[0].replace('p_union_id',"'fade0000-0000-0000-0000-000000000001'::uuid").replace('p_start',"TIMESTAMPTZ '2026-10-06 15:33Z'").replace('p_end',"TIMESTAMPTZ '2026-10-08 00:00Z'")
results={}
for which,s in [('before',before),('after',after)]:
 out=call("SET statement_timeout='20s'; SELECT jsonb_agg(to_jsonb(t) ORDER BY ledger_id) FROM ("+body(s)+') t(ledger_id,club_id,user_id,buyins,cashouts,kind,valid);','actual31-'+which);results[which]=json.loads(out)
 rows=results[which];assert len(rows)==31 and all(x['kind']=='cash_late_settlement' and x['valid'] is True for x in rows)
 from decimal import Decimal
 assert sum(Decimal(str(x['buyins'])) for x in rows)==Decimal('125.70') and sum(Decimal(str(x['cashouts'])) for x in rows)==Decimal('339.89')
assert results['before']==results['after']
# Existing retained-certificate reader controls execute actual current proof.
call(file(F/'boundaries.sql'),'actual-financial-proof-negative-controls')
call(file(F/'retained-cases.sql'),'actual-retained-proof-controls')
# Late NULL baseline independently verifies no row; no stub helper used.
assert call('SELECT count(*) FROM public.fn_union_pnl_prove_late_settlement(NULL::uuid);','actual-late-null')=='0'
# Component gates include every original predicate; no monetary RPC.
def late(s):return re.search(r'  LEFT JOIN LATERAL \(\n   SELECT count\(\*\) n,[\s\S]*?\n  \) late ON true',s).group()
# Small semantic matrix plus realistic fanout. Inputs remain nonfinancial rows;
# original helper runs its authentic PK/frame/retained proof, not a fake.
call("CREATE TABLE gate_input(ledger_id uuid PRIMARY KEY,tournament_id uuid,l jsonb); INSERT INTO gate_input SELECT q.ledger_id,NULL,q.ledger_snapshot FROM union_pnl_original_flows q; INSERT INTO gate_input VALUES(md5('tourney')::uuid,md5('event')::uuid,'{\"category\":\"settlement\",\"idempotency_key\":\"late_seat_settle:x\"}'),(md5('wrongcat')::uuid,NULL,'{\"category\":\"cashout\",\"idempotency_key\":\"late_seat_settle:x\"}'),(md5('wrongprefix')::uuid,NULL,'{\"category\":\"settlement\",\"idempotency_key\":\"ordinary:x\"}'),(md5('nullcategory')::uuid,NULL,'{\"category\":null,\"idempotency_key\":\"late_seat_settle:x\"}'),(md5('nullkey')::uuid,NULL,'{\"category\":\"settlement\",\"idempotency_key\":null}'),(md5('missingkeys')::uuid,NULL,'{}'),(md5('types')::uuid,NULL,'{\"category\":false,\"idempotency_key\":123}'),(md5('orphaneligible')::uuid,NULL,'{\"category\":\"settlement\",\"idempotency_key\":\"late_seat_settle:missing\"}');",'gate-inputs')
def query(s):return 'SELECT q.ledger_id,late.* FROM gate_input q\n'+late(s)+' ORDER BY q.ledger_id'
rows={}
for w,s in [('before',before),('after',after)]:rows[w]=json.loads(call('SELECT jsonb_agg(to_jsonb(x) ORDER BY ledger_id) FROM ('+query(s)+')x;','gate-controls-'+w))
assert rows['before']==rows['after'] and len(rows['after'])==39
call("INSERT INTO gate_input SELECT md5('background'||g)::uuid,NULL,jsonb_build_object('category','rake','idempotency_key','ordinary:'||g) FROM generate_series(1,20000)g; ANALYZE gate_input;",'gate-rowwork-fixture')
plans={}
for w,s in [('before',before),('after',after)]:plans[w]=json.loads(call("SET statement_timeout='45s';EXPLAIN(ANALYZE TRUE,BUFFERS TRUE,TIMING FALSE,FORMAT JSON) "+query(s)+';','gate-rowwork-'+w))
def nodes(v):
 if isinstance(v,dict):
  yield v
  for x in v.values():yield from nodes(x)
 elif isinstance(v,list):
  for x in v:yield from nodes(x)
b=[x for x in nodes(plans['before']) if x.get('Function Name')=='fn_union_pnl_prove_late_settlement'];a=[x for x in nodes(plans['after']) if x.get('Function Name')=='fn_union_pnl_prove_late_settlement']
assert len(b)==len(a)==1 and b[0]['Actual Loops']==20039 and a[0]['Actual Loops']==32,(b,a)
(O/'component-result.json').write_text(json.dumps({'actual31_full_projected_rows_equal':True,'debits':'125.70','credits':'339.89','net':'214.19','late_semantic_controls':39,'before_actual_helper_loops':20039,'after_actual_helper_loops':32,'retained_proof_controls':True,'limits':'Actual current helper and captured31 financial reader. No money writers/production timing/globalwholeweek claim. Move branch byte unchanged; no production timing claim.'},indent=2))
print('PASS actual31 exactprojected/sourcehelpers +retainednegative controls; late39/equal; actual20039→32 proof invocations')
