from pathlib import Path
import json,re,subprocess,hashlib,uuid,time
import os
P=Path(__file__).resolve().parent;N=Path(os.environ['RF_NATIVE_OUTPUT']);R=P.parents[2]
B=str(Path(os.environ['PG_BIN'])/'psql')
def run(sql,name):
 p=N/(name+'.sql');p.write_text(sql)
 t=time.monotonic();r=subprocess.run([B,'-X','-q','-v','ON_ERROR_STOP=1','-h',os.environ['RF_NATIVE_SOCKET'],'-p',os.environ['RF_NATIVE_PORT'],'-U','postgres','-d','postgres','-A','-t','-f',str(p)],capture_output=True,text=True)
 (N/(name+'.stdout')).write_text(r.stdout);(N/(name+'.stderr')).write_text(r.stderr)
 if r.returncode:raise RuntimeError(name+': '+r.stderr[:900])
 return r.stdout,time.monotonic()-t
def uid(s):return str(uuid.UUID(hashlib.md5(s.encode()).hexdigest()))
def lit(v):
 if v is None:return 'NULL'
 if isinstance(v,(int,float)):return str(v)
 return "'"+str(v).replace("'","''")+"'"
source=(P/'before-flow.sql').read_text()
candidate=(R/'supabase/migrations/20261013063142_original_refund_evidence_scans_its_application_lineage_once.sql').read_text()
oldrf=re.search(r'  LEFT JOIN LATERAL \(\n   SELECT count\(\*\) refunds,[\s\S]*?\n  \) rf ON true',source).group(0)
newrf=re.search(r'  LEFT JOIN LATERAL \(\n   SELECT r.refunds,[\s\S]*?\n  \) rf ON true',candidate).group(0)
ctes=re.search(r' \), rf_original_keys AS MATERIALIZED \(([\s\S]*?)\n \), matched AS \(',candidate).group(0)
ctes=ctes[:-len('\n ), matched AS (')]
fundschema=(P/'funding-type.sql').read_text().strip()
assert fundschema.startswith('CREATE TABLE public.cash_participant_funding_receipts(')
schema="""-- Isolated READONLY RF classification component; no money writer/auth/custody behavior stub.
-- Actual q/funding/application types; unrelated FK/financial triggers not invoked/claimed.
CREATE TABLE public.union_pnl_original_flows(ledger_id uuid PRIMARY KEY,transaction_id xid8 NOT NULL,recognized_at timestamptz NOT NULL,game_scope jsonb NOT NULL,ledger_snapshot jsonb NOT NULL);
CREATE INDEX ON public.union_pnl_original_flows((game_scope->>'game_union_id'),recognized_at);
"""+fundschema+"""
ALTER TABLE public.cash_participant_funding_receipts ADD PRIMARY KEY(id);
CREATE UNIQUE INDEX ON public.cash_participant_funding_receipts(source_ledger_id);
CREATE UNIQUE INDEX ON public.cash_participant_funding_receipts(pending_addon_id);
CREATE TABLE public.cash_funding_application_receipts(pending_addon_id uuid PRIMARY KEY,funding_receipt_id uuid NOT NULL UNIQUE,applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),original_occupancy_id uuid NOT NULL,applied_occupancy_id uuid,applied numeric NOT NULL CHECK(applied>=0),refunded numeric NOT NULL CHECK(refunded>=0),transaction_id xid8 DEFAULT pg_current_xact_id());
"""
run('DROP SCHEMA public CASCADE;CREATE SCHEMA public;'+schema,'schema')
expected={};seeds=[];u=uid('user');cl=uid('club');table=uid('table');occup=uid('occupancy');union='fade0000-0000-0000-0000-000000000001'
configs=[('valid',{},1),('no_application',{'noapp':True},0),('duplicate_applications',{'duplicates':2},2),('duplicate_original_flow_a',{'shared':True},1),('duplicate_original_flow_b',{'shared':True},1),('wrong_transaction',{'txdelta':1},0),('wrong_amount',{'refund':9},0),('zero_refund',{'refund':0},0),('wrong_pending',{'pendingwrong':True},0),('null_funding_pending',{'pendingnull':True},0),('wrong_occupancy',{'occupwrong':True},0),('wrong_table',{'tablewrong':True},0),('wrong_account_type',{'accounttype':'club_treasury'},0),('wrong_account_entity',{'accountwrong':True},0),('wrong_club',{'clubwrong':True},0),('wrong_user',{'userwrong':True},0),('wrong_from',{'from':'player_wallet'},0),('wrong_to',{'to':'club_treasury'},0),('wrong_category',{'category':'refund'},0),('tournament_gate',{'tourney':uid('tourney')},0),('null_table',{'qtable':None},0),('null_club',{'qclub':None},0),('null_user',{'quser':None},0),('null_amount',{'qamount':None},0),('canonical_uuid_case',{'qtable':table.upper(),'qclub':cl.upper(),'quser':u.upper()},1),('ineligible_malformed_table',{'category':'refund','qtable':'not-a-uuid'},0)]
sharedmade=False
for i,(name,cfg,count) in enumerate(configs):
 tx=9900000 if cfg.get('shared') else 900000+i*1000;ledger=uid('q'+name)
 snap={'table_id':cfg.get('qtable',table),'club_id':cfg.get('qclub',cl),'to_entity_id':cfg.get('quser',u),'amount':cfg.get('qamount',10),'from_type':cfg.get('from','table_stack'),'to_type':cfg.get('to','player_wallet'),'category':cfg.get('category','player_funding')}
 scope={'game_union_id':union,'tournament_id':cfg.get('tourney')}
 seeds.append(f"INSERT INTO public.union_pnl_original_flows VALUES('{ledger}','{tx}','2026-10-06 08:00Z',{lit(json.dumps(scope))}::jsonb,{lit(json.dumps(snap))}::jsonb);")
 expected[ledger]={'name':name,'refunds':count,'club':cl if count else None,'player':u if count else None}
 if cfg.get('shared') and sharedmade:continue
 if cfg.get('shared'):sharedmade=True
 for j in range(cfg.get('duplicates',1)):
  ident=name+str(j);f=uid('f'+ident);pending=uid('p'+ident);occ=uid('o'+ident)
  vals=[f,'addon',uid('wronguser') if cfg.get('userwrong') else u,uid('wrongtable') if cfg.get('tablewrong') else table,uid('seat'+ident),occ,'2026-10-06 07:00Z',uid('source'+ident),cfg.get('accounttype','player_wallet'),uid('wrongaccount') if cfg.get('accountwrong') else u,uid('wrongclub') if cfg.get('clubwrong') else cl,union,'chips',10,110,100,None if cfg.get('pendingnull') else pending,str(tx)]
  seeds.append('INSERT INTO public.cash_participant_funding_receipts(id,operation_kind,user_id,table_id,seat_id,occupancy_id,seat_joined_at,source_ledger_id,account_type,account_entity_id,funding_club_id,funding_union_id,asset,amount,balance_before,balance_after,pending_addon_id,transaction_id) VALUES('+','.join(lit(x) for x in vals)+');')
  if not cfg.get('noapp'):
   av=[uid('wrongpending'+ident) if cfg.get('pendingwrong') else pending,f,uid('wrongoccup') if cfg.get('occupwrong') else occ,None,10-cfg.get('refund',10),cfg.get('refund',10),str(tx+cfg.get('txdelta',0))]
   seeds.append('INSERT INTO public.cash_funding_application_receipts(pending_addon_id,funding_receipt_id,original_occupancy_id,applied_occupancy_id,applied,refunded,transaction_id) VALUES('+','.join(lit(x) for x in av)+');')
run('\n'.join(seeds),'seed-controls')
orig="""WITH originals AS MATERIALIZED (SELECT q.*,q.ledger_snapshot l,(q.game_scope->>'tournament_id')::uuid tournament_id FROM public.union_pnl_original_flows q WHERE q.game_scope->>'game_union_id'='fade0000-0000-0000-0000-000000000001' AND q.recognized_at>='2026-10-05 07:00Z' AND q.recognized_at<'2026-10-12 07:00Z'"""
def query(which):
 if which=='before':return orig+") SELECT q.ledger_id,rf.refunds,rf.club,rf.player FROM originals q\n"+oldrf+' ORDER BY q.ledger_id'
 return orig+ctes+") SELECT q.ledger_id,COALESCE(rf.refunds,0) refunds,rf.club,rf.player FROM originals q\n"+newrf+' ORDER BY q.ledger_id'
results={}
for which in ('before','after'):
 sql='SET statement_timeout=\'20s\';SELECT jsonb_agg(to_jsonb(x) ORDER BY ledger_id) FROM ('+query(which)+')x;'
 out,elapsed=run(sql,'controls-'+which);rows=json.loads(out.strip());results[which]=rows
 for row in rows:
  want=expected[row['ledger_id']]
  assert row['refunds']==want['refunds'] and row['club']==want['club'] and row['player']==want['player'],(which,want,row)
assert results['before']==results['after']
(N/'control-receipt.json').write_text(json.dumps({'scope':'isolated exactRFclassification component NOTfullfinancialfunction/productiontiming','source_old_rf_sha256':hashlib.sha256(oldrf.encode()).hexdigest(),'source_new_rf_sha256':hashlib.sha256(newrf.encode()).hexdigest(),'independent_cases':len(configs),'results_equal':True,'cases':list(expected.values())},indent=2)+'\n')
print('PASS independent26/old-new-equality')
# Separate representative fanout fixture, no broad whole-book claim.
run('TRUNCATE public.union_pnl_original_flows,public.cash_participant_funding_receipts,public.cash_funding_application_receipts;','reset-for-rowwork')
background="""INSERT INTO public.cash_participant_funding_receipts(id,operation_kind,user_id,table_id,seat_id,occupancy_id,seat_joined_at,source_ledger_id,account_type,account_entity_id,funding_club_id,funding_union_id,asset,amount,balance_before,balance_after,pending_addon_id,transaction_id)
SELECT md5('f'||g)::uuid,'addon',md5('u')::uuid,md5('table')::uuid,md5('seat'||g)::uuid,md5('occ'||g)::uuid,'2026-10-06 07:00Z',md5('leg'||g)::uuid,'player_wallet',md5('u')::uuid,md5('cl')::uuid,'fade0000-0000-0000-0000-000000000001','chips',10,110,100,md5('pend'||g)::uuid,(1000000+g)::text::xid8 FROM generate_series(1,27557)g;
INSERT INTO public.cash_funding_application_receipts(pending_addon_id,funding_receipt_id,original_occupancy_id,applied_occupancy_id,applied,refunded,transaction_id)
SELECT md5('pend'||g)::uuid,md5('f'||g)::uuid,md5('occ'||g)::uuid,NULL,0,10,(1000000+g)::text::xid8 FROM generate_series(1,27557)g;
INSERT INTO public.union_pnl_original_flows SELECT md5('q'||g)::uuid,(1000000+g)::text::xid8,'2026-10-06 08:00Z',jsonb_build_object('game_union_id','fade0000-0000-0000-0000-000000000001','tournament_id',NULL),jsonb_build_object('table_id',md5('table')::uuid,'club_id',md5('cl')::uuid,'to_entity_id',md5('u')::uuid,'amount',10,'from_type','table_stack','to_type','player_wallet','category','player_funding') FROM generate_series(1,1024)g;
ANALYZE public.union_pnl_original_flows;ANALYZE public.cash_participant_funding_receipts;ANALYZE public.cash_funding_application_receipts;
"""
run(background,'rowwork-fixture')
plans={};digests={}
for which in ('before','after'):
 out,elapsed=run("SET statement_timeout='20s';EXPLAIN(ANALYZE TRUE,BUFFERS TRUE,TIMING FALSE,FORMAT JSON) "+query(which)+';', 'rowwork-plan-'+which)
 plans[which]=json.loads(out.strip())
 out,_=run("SELECT md5(jsonb_agg(to_jsonb(x) ORDER BY ledger_id)::text) FROM ("+query(which)+')x;','rowwork-digest-'+which);digests[which]=out.strip()
assert digests['before']==digests['after']
def nodes(x):
 if isinstance(x,dict):
  yield x
  for v in x.values():yield from nodes(v)
 elif isinstance(x,list):
  for v in x:yield from nodes(v)
oldscans=[n for n in nodes(plans['before']) if n.get('Relation Name')=='cash_funding_application_receipts']
newscans=[n for n in nodes(plans['after']) if n.get('Relation Name')=='cash_funding_application_receipts']
assert any(n.get('Node Type')=='Seq Scan' and n.get('Actual Loops',0)>=1024 for n in oldscans),oldscans
assert all(n.get('Actual Loops',0)<=1 for n in newscans),newscans
receipt={'scope':'isolated exactRFsource component; actualtypes;27557application modeledbackground/1024eligibleflows; NOTproductioncoldI/O/fullbook financialtiming','before_application_scans':oldscans,'after_application_scans':newscans,'rowset_md5':digests['before'],'independent26':True,'whole_function_unchanged_other_branches_pending_byte_audit':True}
(N/'rowwork-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print('PASS actualold1024appscans→afterONE / rowset-identical')
