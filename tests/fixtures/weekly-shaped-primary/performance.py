from pathlib import Path
import json,subprocess,sys
pg,work,root=map(Path,sys.argv[1:]);q=root/'tests/fixtures/weekly-shaped-primary'
args=[str(pg/'psql'),'-X','-q','-h',str(work),'-p','56449','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1']
def sql(s):
 r=subprocess.run(args+['-At'],input=s,text=True,capture_output=True)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout
sql("""INSERT INTO union_pnl_cash_outcomes(table_id,hand_number,hand_id,recognized_at,payload_hash,game_scope,evidence)
 SELECT '77777777-7777-4777-8777-777777777777',g,md5(g::text)::uuid,'2026-10-08 10:00Z','native-wide-ready',
 '{"game_union_id":"fade0000-0000-0000-0000-000000000001"}'::jsonb,
 jsonb_build_object('status','ready','basis_certified',true,'all_players_included',true,'game_scope','{"game_union_id":"fade0000-0000-0000-0000-000000000001"}'::jsonb,'participants',
 (SELECT jsonb_agg(md5(g::text||':'||n::text)) FROM generate_series(1,100)n)) FROM generate_series(90000001,90020000)g;
 INSERT INTO union_pnl_cash_outcome_touches SELECT table_id,hand_number,recognized_at,game_scope->>'game_union_id',false,'0',evidence->'participants'
 FROM union_pnl_cash_outcomes WHERE hand_number BETWEEN 90000001 AND 90020000;""")
def query(path):
 s=path.read_text();a=s.index('RETURN QUERY ')+len('RETURN QUERY ');b=s.index('\n ELSE',a)
 return s[a:b].strip().rstrip(';').replace('p_union_id',"'fade0000-0000-0000-0000-000000000001'::uuid").replace('p_start',"'2026-10-05 07:00Z'::timestamptz").replace('p_end',"'2026-10-12 07:00Z'::timestamptz")
old=query(q/'preimage.sql');new=query(root/'supabase/migrations/20261013024122_weekly_shaped_hands_start_from_original_unaccepted.sql')
plans={}
for label,s in [('before',old),('after',new)]:
 plans[label]=json.loads(sql('EXPLAIN(ANALYZE TRUE,BUFFERS TRUE,FORMAT JSON) '+s))[0]
 (work/f'{label}-plan.log').write_text(json.dumps(plans[label],indent=2))
def nodes(p):
 yield p
 for c in p.get('Plans',[]):yield from nodes(c)
oldnodes=list(nodes(plans['before']['Plan']));newnodes=list(nodes(plans['after']['Plan']))
oldwork=sum(n.get('Actual Rows',0)+n.get('Rows Removed by Filter',0) for n in oldnodes if n.get('Relation Name')=='union_pnl_cash_outcome_touches')
newwork=sum((n.get('Actual Rows',0)+n.get('Rows Removed by Filter',0))*n.get('Actual Loops',1) for n in newnodes if n.get('Relation Name')=='union_pnl_cash_outcome_touches')
assert oldwork>=20000,(oldwork,plans['before'])
assert newwork==4,(newwork,plans['after'])
assert plans['before']['Plan']['Actual Rows']==plans['after']['Plan']['Actual Rows']==4
print('PASS native wide ready TOAST touch counterexample: before touch rowwork',oldwork,'after touch PK rowwork',newwork)
print('Native query milliseconds:',plans['before']['Execution Time'],plans['after']['Execution Time'],'not a production timing claim')
