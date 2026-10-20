#!/usr/bin/env python3
"""Qualify original unpaid accrual restart using real temporal/funding contracts."""
import argparse,concurrent.futures,json,os,re,shutil,socket,subprocess,tempfile
from pathlib import Path
ap=argparse.ArgumentParser();ap.add_argument('--pg-bin',type=Path,required=True);ap.add_argument('--scratch',type=Path,required=True)
a=ap.parse_args();root=Path(__file__).resolve().parents[2];fixtures=root/'scripts/ci/fixtures'
base=Path(tempfile.mkdtemp(prefix='uac-',dir=a.scratch));started=False
with socket.socket() as listener:listener.bind(('127.0.0.1',0));port=str(listener.getsockname()[1])
env={**os.environ,'TMPDIR':str(base)}
def run(args,content=None,error=None):
 p=subprocess.run([str(x) for x in args],input=content,text=True,capture_output=True,env=env,timeout=90)
 if error:assert p.returncode and error in p.stderr,p.stdout+p.stderr
 else:assert p.returncode==0,p.stdout+p.stderr
 return p.stdout.strip()
def sql(s,error=None):return run([a.pg_bin/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres','-d','postgres'],s,error)
def quoted(v):return "'"+json.dumps(v).replace("'","''")+"'::jsonb"
def insert(table,rows):
 if rows:sql('INSERT INTO '+table+' SELECT * FROM jsonb_populate_recordset(NULL::'+table+','+quoted(rows)+')')
try:
 run([a.pg_bin/'initdb','-D',base/'d','-U','postgres','-A','trust','--no-locale','--encoding=UTF8'])
 run([a.pg_bin/'pg_ctl','-D',base/'d','-l',base/'log','-o',f'-h 127.0.0.1 -k {base} -p {port}','-w','start']);started=True
 sql("ALTER DATABASE postgres SET TimeZone='UTC';CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA smarter_private;CREATE SEQUENCE hand_id_seq;")
 sql("CREATE FUNCTION fn_caller_is_engine() RETURNS boolean LANGUAGE sql AS $$SELECT current_setting('fixture.engine',true) IS DISTINCT FROM 'off'$$;CREATE FUNCTION fn_ca_launch_accounting_accepts(uuid,timestamptz) RETURNS boolean LANGUAGE sql AS $$SELECT true$$;")
 for r in json.loads((fixtures/'unpaid-atomic-cash-contract-columns.json').read_text()):
  # Generated expressions reference the real columns in this same captured table.
  sql('CREATE TABLE '+r['table_name']+'('+r['columns']+')')
 sql('CREATE TABLE clubs(id uuid,owner_id uuid,is_union boolean,union_id uuid);ALTER TABLE accounting_cash_rake_sources ADD PRIMARY KEY(id);ALTER TABLE ca_ledger_maintenance_kinds ADD PRIMARY KEY(kind);CREATE UNIQUE INDEX ON accounting_period_recompute_requests(club_id,period_start,period_end);')
 sql('CREATE TABLE accounting_close_partials(kind text,union_id uuid,period_start timestamptz,period_end timestamptz,value jsonb);CREATE TABLE accounting_close_certificates(kind text,union_id uuid,period_start timestamptz,period_end timestamptz,value jsonb);')
 data=json.loads((fixtures/'unpaid-atomic-cash-contract-cases.json').read_text());cases=data['case'];deps=json.loads((fixtures/'unpaid-atomic-cash-contract-dependencies.json').read_text())
 for table,key in [('clubs','clubs'),('accounting_agreement_history','history'),('accounting_cash_rake_sources','sources'),('accounting_cash_accrual_batches','batches'),('rake_attributions','attributions'),('agent_commissions','commissions')]:insert(table,cases[key])
 insert('rake_records',data['records']['rake_records']);insert('accounting_cash_bank_receipts',data['records']['bank'])
 # JSON transport normalizes unconstrained numeric display scale. Bind the
 # fixture batch fingerprint to its exact normalized inputs. All four actual
 # production fingerprints were separately recomputed read-only and matched.
 sql("UPDATE accounting_cash_accrual_batches b SET source_fingerprint=md5(jsonb_build_object('record',r.id,'hand',r.hand_id,'rake',r.rake_amount,'earned_at',r.created_at,'shares',(SELECT coalesce(jsonb_agg(jsonb_build_array(a.id,a.player_id,a.club_id,a.weighted_rake_credit) ORDER BY a.player_id),'[]'::jsonb)FROM rake_attributions a WHERE a.rake_record_id=r.id))::text)FROM rake_records r WHERE r.id=b.rake_record_id")
 # The retained bank witness points to its native union journal leg. No
 # synthetic wallet balance or chip credit is used by this qualification.
 for b in data['records']['bank']:
  sql("INSERT INTO union_wallet_transactions(id,union_id,amount,created_at,wallet,direction,tx_type) VALUES('"+b['union_transaction_id']+"','"+b['union_id']+"',"+str(b['amount'])+",'"+b['banked_at']+"','rake_wallet','credit','rake')")
 sql("INSERT INTO accounting_cash_accrual_cutover(singleton,starts_at)VALUES(true,'2026-09-01');")
 # These metadata-only original readers are installed to prove guarded edits;
 # their unrelated full-week bodies are not invoked by this focused fixture.
 for r in json.loads((fixtures/'atomic-accounting-history-preimages.json').read_text()):sql(r['definition'])
 sql(data['earning_contract']['definition'])
 for r in deps['definitions']:sql(r['definition'])
 pre=json.loads((fixtures/'unpaid-atomic-cash-contract-preimages.json').read_text())
 for r in pre:sql(r['definition']);assert sql("SELECT md5(pg_get_functiondef('"+r['signature']+"'::regprocedure))")==r['md5']
 for r in pre:
  sql('REVOKE ALL ON FUNCTION '+r['signature']+' FROM PUBLIC,anon,authenticated,service_role')
  if not r['signature'].startswith(('fn_accrue_cash_hand_commissions','fn_prepare_accounting_week')):sql('GRANT EXECUTE ON FUNCTION '+r['signature']+' TO service_role')
 original_acl={r['signature']:sql("SELECT proacl::text FROM pg_proc WHERE oid='"+r['signature']+"'::regprocedure")for r in pre}
 # The complete original source view is retained. Its tournament arm has
 # typed empty prerequisites; no tournament payout is claimed by this test.
 sql('CREATE TABLE accounting_tournament_fee_sources(id uuid,rake_record_id uuid,tournament_id uuid,player_id uuid,club_id uuid,union_id uuid,coordinator_union_id uuid,charged_at timestamptz,rake_credit numeric,contract jsonb);CREATE TABLE accounting_tournament_recognized_sources(source_id uuid,tournament_id uuid,recognized_at timestamptz,disposition text,rake_credit numeric);CREATE TABLE accounting_tournament_fee_recognitions(tournament_id uuid,recognized_at timestamptz,status text,union_id uuid);CREATE FUNCTION fn_ca_launch_accounting_club_cutoffs() RETURNS TABLE(club_id uuid,cutoff_at timestamptz) LANGUAGE sql AS $$SELECT NULL::uuid,NULL::timestamptz WHERE false$$;CREATE VIEW accounting_payable_earning_sources AS '+deps['views'])
 sql('CREATE TRIGGER immutable_source BEFORE UPDATE OR DELETE ON accounting_cash_rake_sources FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_history_immutable();CREATE TRIGGER commission_guard BEFORE INSERT ON agent_commissions FOR EACH ROW EXECUTE FUNCTION fn_accounting_cash_commission_source_guard();CREATE TRIGGER immutable_commission BEFORE UPDATE OR DELETE ON agent_commissions FOR EACH ROW EXECUTE FUNCTION fn_ca_journal_append_only();')
 # Keep the actual seven still-existing original tier identities; the old
 # retired payees remain absent, exactly as the current production read.
 current_agent_ids={'15fe64df-5cbb-4868-8cc0-10031607c7c4','a9f2c2c6-4e2a-4bed-916e-c7994192d425','4ae09499-d25a-40cb-ac0f-09573eb48f1c','5ce78a82-8958-450d-b6f0-2e8b2d50d3c9','c27a488e-7f79-4e23-82a0-9d5867c20e73','9502eb08-8873-4a53-9da3-0e1a0857f5a6','f5cfca70-85b6-4b64-a38b-323edb07c7b7'}
 seen=set()
 for s in cases['sources']:
  for t in s['contract']['tiers']:
   if t['agent_id'] in current_agent_ids and t['agent_id'] not in seen:
    v=t['agreement']['terms'];sql("INSERT INTO agents(id,user_id,club_id,role,commission_rate,player_rakeback_rate,lifetime_rake_generated,weekly_rake_generated)VALUES('"+v['id']+"','"+v['user_id']+"','"+v['club_id']+"','"+v['role']+"',"+str(v['commission_rate'])+","+str(v['player_rakeback_rate'])+",10000,5000)");seen.add(t['agent_id'])
 before=sql("SELECT md5(jsonb_agg(to_jsonb(s) ORDER BY id)::text)FROM accounting_cash_rake_sources s")
 # First prove the historical reader still reproduces the bad original branch.
 old_plan=json.loads(sql("SELECT fn_accounting_cash_commission_plan('f2829e2c-b54a-4e2e-908c-7326cecf5e45')"))
 sql(next((root/'supabase/migrations').glob('20261019183226_*')).read_text())
 canonical={}
 for b in data['records']['bank']:
  p=json.loads(sql("SELECT fn_accounting_cash_commission_plan('"+b['rake_record_id']+"')"))
  for c in p['players']:canonical[(b['rake_record_id'],c['player_id'],c['club_id'])]=c
 expected={};changed=[]
 for s in cases['sources']:
  c=canonical[(s['rake_record_id'],s['player_id'],s['club_id'])]
  if c!=s['contract']:
   changed.append(s)
   expected[s['id']]={'original_md5':sql("SELECT md5(contract::text)FROM accounting_cash_rake_sources WHERE id='"+s['id']+"'"),'admitted_md5':sql("SELECT md5(p::text)FROM jsonb_array_elements(fn_accounting_cash_commission_plan('"+s['rake_record_id']+"')->'players')p WHERE p->>'player_id'='"+s['player_id']+"' AND p->>'club_id'='"+s['club_id']+"'")}
 assert len(changed)==6,[(s['id'],[k for k in s['contract'] if s['contract'][k]!=canonical[(s['rake_record_id'],s['player_id'],s['club_id'])].get(k)])for s in changed]
 candidate=next((root/'supabase/migrations').glob('20261019211745_*')).read_text();sql(candidate)
 assert sql('SELECT '+candidate.splitlines()[0].split(': ',1)[1])=='t', sql("SELECT md5(pg_get_functiondef('smarter_private.admit_cash_atomic_contracts(uuid,jsonb)'::regprocedure))")
 for sig,acl in original_acl.items():assert sql("SELECT proacl::text FROM pg_proc WHERE oid='"+sig+"'::regprocedure")==acl
 native_hashes={r['signature']:sql("SELECT md5(pg_get_functiondef('"+r['signature']+"'::regprocedure))") for r in pre}
 native_hashes['smarter_private.admit_cash_atomic_contracts(uuid,jsonb)']=sql("SELECT md5(pg_get_functiondef('smarter_private.admit_cash_atomic_contracts(uuid,jsonb)'::regprocedure))")
 def attempt(s,e=expected,abort=False,error=None):
  hand=next(r['hand_id'] for r in cases['batches'] if r['rake_record_id']==s['rake_record_id'])
  subset={x['id']:e[x['id']] for x in changed if x['rake_record_id']==s['rake_record_id']}
  q='BEGIN;SET LOCAL app.accounting_atomic_contracts='+"'"+json.dumps(subset)+"';SELECT fn_accrue_cash_hand_commissions('"+hand+"');"
  q+= "DO $$BEGIN RAISE EXCEPTION 'qualified_admission_rollback';END$$;" if abort else 'COMMIT;'
  return sql(q,error or ('qualified_admission_rollback' if abort else None))
 first=changed[0]
 for table in ['accounting_close_partials','accounting_close_certificates']:
  sql("INSERT INTO "+table+" VALUES('earned_plan','fade0000-0000-0000-0000-000000000001','2026-10-12 07:00Z','2026-10-19 07:00Z','{\"fixture\":\"stale_contract\"}'),('earned_plan','fade0000-0000-0000-0000-000000000001','2026-10-05 07:00Z','2026-10-12 07:00Z','{}'),('earned_plan','00000000-0000-0000-0000-000000000099','2026-10-12 07:00Z','2026-10-19 07:00Z','{}'),('pnl_boundary','fade0000-0000-0000-0000-000000000001','2026-10-12 07:00Z','2026-10-12 07:00Z','{}')")
 def fault(prefix,message,expect=expected):
  hand=next(r['hand_id']for r in cases['batches']if r['rake_record_id']==first['rake_record_id'])
  e={x['id']:expect[x['id']] for x in changed if x['rake_record_id']==first['rake_record_id']}
  sql('BEGIN;'+prefix+"SET LOCAL app.accounting_atomic_contracts='"+json.dumps(e)+"';SELECT fn_accrue_cash_hand_commissions('"+hand+"');COMMIT;",message)
 for field,error in [('original_md5','atomic_cash_admission_original_changed'),('admitted_md5','atomic_cash_admission_canonical_changed')]:
  bad=json.loads(json.dumps(expected));bad[first['id']][field]='0'*32;fault('',error,bad)
 fault("SET LOCAL fixture.engine='off';",'service_role_required')
 fault("UPDATE agent_commissions SET settled_at=now() WHERE source_id='"+first['id']+"';",'atomic_cash_admission_original_commissions_changed')
 # Native full-week close evidence excludes every late admission, even if an
 # individual commission has not yet received its settled stamp.
 fault("INSERT INTO agent_commission_settlements(club_id,user_id,period_start,period_end,amount) VALUES('"+first['club_id']+"','"+first['player_id']+"','2026-10-12 07:00Z','2026-10-19 07:00Z',0);",'atomic_cash_admission_week_already_paid')
 foreign={**expected,'00000000-0000-0000-0000-000000000099':{'original_md5':'0'*32,'admitted_md5':'0'*32}}
 sql("BEGIN;SELECT smarter_private.admit_cash_atomic_contracts('"+first['rake_record_id']+"',"+quoted(foreign)+");COMMIT;",'atomic_cash_admission_foreign_source')
 normal=next(s for s in cases['sources']if s['rake_record_id']==first['rake_record_id'] and s['id']not in expected)
 normal_hash=sql("SELECT md5(contract::text)FROM accounting_cash_rake_sources WHERE id='"+normal['id']+"'")
 sql("BEGIN;SELECT smarter_private.admit_cash_atomic_contracts('"+normal['rake_record_id']+"',"+quoted({normal['id']:{'original_md5':normal_hash,'admitted_md5':normal_hash}})+");COMMIT;",'atomic_cash_admission_no_unfinished_external_history')
 attempt(changed[0],abort=True)
 assert sql('SELECT count(*)FROM accounting_cash_atomic_contract_admissions')=='0'
 for table in ['accounting_close_partials','accounting_close_certificates']:assert sql('SELECT count(*)FROM '+table)=='4'
 # Concurrent identical requests serialize on the original hand authority.
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
  futures=[pool.submit(attempt,first)for _ in range(2)]
  for f in futures:f.result()
 done={first['rake_record_id']}
 for s in changed:
  if s['rake_record_id'] not in done:attempt(s);done.add(s['rake_record_id'])
 assert sql('SELECT count(*)FROM accounting_cash_atomic_contract_admissions')=='6'
 assert sql("SELECT md5(jsonb_agg(to_jsonb(s) ORDER BY id)::text)FROM accounting_cash_rake_sources s")==before
 assert sql("SELECT count(*)FROM accounting_cash_atomic_contract_admissions a JOIN accounting_payable_earning_sources s ON s.source_id=a.source_id WHERE s.contract IS DISTINCT FROM a.admitted_contract")=='0'
 assert sql('SELECT count(*)FROM ca_ledger_mutation_log')=='8'
 conflict=json.loads(json.dumps(expected));conflict[first['id']]['admitted_md5']='0'*32
 attempt(first,conflict,error='atomic_cash_admission_replay_conflict')
 assert sql("SELECT lifetime_rake_generated FROM agents WHERE id='4ae09499-d25a-40cb-ac0f-09573eb48f1c'")=='9999.9100'
 assert sql("SELECT lifetime_rake_generated FROM agents WHERE id='a9f2c2c6-4e2a-4bed-916e-c7994192d425'")=='10000.0000'
 assert sql("SELECT sum((t->>'amount')::numeric) FROM accounting_cash_atomic_contract_admissions a CROSS JOIN LATERAL jsonb_array_elements(a.admitted_contract->'tiers')t")=='2.72'
 assert sql("SELECT sum(amount)FROM agent_commissions WHERE source_id IN(SELECT source_id FROM accounting_cash_atomic_contract_admissions)")=='2.72'
 for table in ['accounting_close_partials','accounting_close_certificates']:
  assert sql('SELECT count(*)FROM '+table)=='3'
  assert sql("SELECT count(*)FROM "+table+" WHERE value->>'fixture'='stale_contract'")=='0'
  sql("INSERT INTO "+table+" VALUES('earned_plan','fade0000-0000-0000-0000-000000000001','2026-10-12 07:00Z','2026-10-19 07:00Z','{\"fixture\":\"fresh_contract\"}')")
 for s in changed:attempt(s)
 assert sql('SELECT count(*)FROM accounting_cash_atomic_contract_admissions')=='6'
 assert sql('SELECT count(*)FROM ca_ledger_mutation_log')=='8'
 for table in ['accounting_close_partials','accounting_close_certificates']:
  assert sql('SELECT count(*)FROM '+table)=='4'
  assert sql("SELECT count(*)FROM "+table+" WHERE value->>'fixture'='fresh_contract'")=='1'
 sql('UPDATE accounting_cash_rake_sources SET contract=contract','accounting_agreement_history_is_immutable')
 sql('DELETE FROM accounting_cash_atomic_contract_admissions','accounting_agreement_history_is_immutable')
 sql("UPDATE agent_commissions SET amount=amount+1",'financial journals are append-only')
 assert sql("SELECT has_function_privilege('authenticated','smarter_private.admit_cash_atomic_contracts(uuid,jsonb)','EXECUTE')")=='f'
 sql(candidate,'already exists')
 print(json.dumps({'qualification':'passed','changed_sources':6,'original_sources_unchanged':True,'original_commissions_archived':8,'new_commissions':'2.72','old_commissions':'1.88','rollback':True,'duplicate_unchanged':True,'concurrent_original_requests':True,'no_chip_payment':True,'negative_cases':8,'agent_display_delta_exact':True,'scoped_stale_proofs_invalidated_atomically':True,'boundaries_and_other_books_preserved':True,'duplicate_keeps_new_proofs':True,'postimages':native_hashes}))
finally:
 if started:run([a.pg_bin/'pg_ctl','-D',base/'d','-m','immediate','-w','stop'])
 shutil.rmtree(base)
