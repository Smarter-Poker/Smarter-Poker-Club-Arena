"""Captured, card-free original jackpot reader proof; isolated PostgreSQL only."""
from pathlib import Path
import json
p=Path(__file__).resolve().parent
x=json.loads((p/'captured-card-free-witness.json').read_text())
tables={k:{}for k in ['bbj_pools','bbj_payouts','bbj_payout_recipients','wallet_credit_idempotency','chip_ledger','chip_transactions','union_pnl_original_flows','union_pnl_cash_outcomes','bbj_unclaimed_shares']}
def add(table,row):
 if row:tables[table][row.get('id',row.get('key',row.get('ledger_id',str((row.get('table_id'),row.get('hand_number'))))))]=row
for r in x['records']:
 add('bbj_payouts',r['payout']);add('bbj_payout_recipients',r['recipient']);add('wallet_credit_idempotency',r['wallet_key']);add('union_pnl_original_flows',r['original']);add('chip_ledger',r['original']['ledger_snapshot'])
 for z in r['pool_legs']:add('chip_ledger',z)
 for z in r['wallet_journals']:add('chip_transactions',z)
for k,table in [('pools','bbj_pools'),('outcomes','union_pnl_cash_outcomes'),('unclaimed','bbj_unclaimed_shares')]:
 for r in x[k] or []:add(table,r)
s=(p/'actual-extra-tables.sql').read_text()
# Existing original fixtures may expose only a subset of these real columns.
for line in s.splitlines():
 table=line.split('public.',1)[1].split('(',1)[0];cols=line.split('(',1)[1].rsplit(',PRIMARY KEY',1)[0]
 for col in cols.split(','):
  name,typ=col.split()[:2];s+=f'ALTER TABLE public.{table} ADD COLUMN IF NOT EXISTS {name} {typ};\n'
deps=json.loads((p/'actual-reader-dependencies.json').read_text())
for table in deps['schemas']:
 # The existing cache regression owns this exact table at its original step.
 if table['relname']=='accounting_close_certificates':continue
 s+=table['ddl']+'\n'
 for name,typ in table['columns']:s+=f"ALTER TABLE public.{table['relname']} ADD COLUMN IF NOT EXISTS {name} {typ};\n"
for function in deps['functions']:s+=function['body']+';\n'
s+=(p/'original-owners.sql').read_text()
for function in json.loads((p/'actual-guarded-transitive-dependencies.json').read_text()):s+=function['body']+';\n'
s+=(p/'actual-current-source-guard.sql').read_text()+';\n'
guard=(p/'actual-current-source-guard.sql').read_text()
values=guard.split('FROM(VALUES',1)[1].split(')x(signature,body_md5)',1)[0]
s+="DO $baseline_pins$DECLARE mismatch jsonb;BEGIN SELECT jsonb_agg(jsonb_build_object('signature',x.signature,'expected',x.body_md5,'actual',md5(pg_get_functiondef(p.oid)))) INTO mismatch FROM(VALUES"+values+")x(signature,body_md5)LEFT JOIN pg_proc p ON p.oid=to_regprocedure(x.signature)WHERE md5(pg_get_functiondef(p.oid))IS DISTINCT FROM x.body_md5;RAISE NOTICE 'wallet baseline pin differences:%',mismatch;END$baseline_pins$;"

s+="REVOKE ALL ON FUNCTION smarter_private.union_pnl_original_flow_evidence_window(uuid,timestamptz,timestamptz,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;"
for table,rows in tables.items():
 if rows:s+=f"INSERT INTO public.{table} SELECT(jsonb_populate_record(NULL::public.{table},j)).* FROM jsonb_array_elements($captured_wallet_awards${json.dumps(list(rows.values()),separators=(',',':'))}$captured_wallet_awards$::jsonb)j ON CONFLICT DO NOTHING;\n"
s+="""CREATE TEMP TABLE wallet_jackpot_original_metadata AS SELECT oid::regprocedure::text signature,jsonb_build_array(proowner,provolatile,prosecdef,proisstrict,proconfig,proacl::text) attributes FROM pg_proc WHERE oid IN('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure,'smarter_private.union_pnl_original_flow_evidence_window(uuid,timestamptz,timestamptz,timestamptz,timestamptz)'::regprocedure,'public.fn_union_pnl_week_bbj_stack_awards(uuid,timestamptz,timestamptz)'::regprocedure,'public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)'::regprocedure,'smarter_private.original_inventory_proof_sources_match()'::regprocedure);
CREATE TEMP TABLE wallet_jackpot_original_money AS SELECT md5((SELECT jsonb_agg(to_jsonb(l) ORDER BY id)::text FROM chip_ledger l)) ledger,md5((SELECT jsonb_agg(to_jsonb(b) ORDER BY id)::text FROM bbj_payouts b)) payouts,md5((SELECT jsonb_agg(to_jsonb(b) ORDER BY id)::text FROM bbj_pools b)) pools;

"""
setup_sql=s
before_sql="DO $before$BEGIN IF (SELECT count(*) FROM public.fn_union_pnl_original_flow_evidence('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z')WHERE NOT valid)<>84 OR (SELECT count(*) FROM public.fn_union_pnl_week_bbj_stack_awards('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z'))<>0 THEN RAISE EXCEPTION 'wallet jackpot old failure not reproduced';END IF;END $before$;"
after_sql=(p/'native-cases.sql').read_text()
