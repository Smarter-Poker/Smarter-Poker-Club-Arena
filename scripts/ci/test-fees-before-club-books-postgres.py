#!/usr/bin/env python3
"""Actual changed owners with fault-controlled stage contracts; not a money certificate.
Maintained monetary-stage regressions and a production rollback prove the money path.
"""
import argparse,json,os,socket,subprocess,tempfile,shutil
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--pg-bin',type=Path,required=True);p.add_argument('--scratch',type=Path,required=True);a=p.parse_args();root=Path(__file__).resolve().parents[2];fixtures=root/'scripts/ci/fixtures/fees-before-club-books'
b=Path(tempfile.mkdtemp(prefix='fees-before-books-',dir=a.scratch.resolve()));started=False
with socket.socket()as listener:listener.bind(('127.0.0.1',0));port=str(listener.getsockname()[1])
env={**os.environ,'TMPDIR':str(b)}
def run(argv,s=None,error=None):
 r=subprocess.run([str(x)for x in argv],input=s,text=True,capture_output=True,env=env,timeout=90)
 if error:assert r.returncode and error in r.stderr,r.stdout+r.stderr
 else:assert r.returncode==0,r.stdout+r.stderr
 return r.stdout.strip()
def q(s,error=None):return run([a.pg_bin/'psql','-XqAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres'],"SET app.weekly_accounting_chunked='on';"+s,error)
def check(s):assert q('SELECT ('+s+')')=='t',s
call="SELECT fn_union_settlement_cascade(u(),'2026-10-19 07:00Z','2026-10-26 07:00Z')"
owners=json.loads((fixtures/'original-owners.json').read_text());migration=(root/'supabase/migrations/20261027004204_rakeback_is_paid_before_the_club_books_close.sql').read_text()
try:
 run([a.pg_bin/'initdb','-D',b/'d','-U','postgres','-A','trust','--no-locale','-E','UTF8']);run([a.pg_bin/'pg_ctl','-D',b/'d','-l',b/'log','-o',f"-h 127.0.0.1 -k '' -p {port}",'-w','start']);started=True
 q((fixtures/'bootstrap.sql').read_text())
 for r in owners:
  q(r['definition']);assert q("SELECT md5(pg_get_functiondef('"+r['signature']+"'::regprocedure))")==r['md5']
  q('REVOKE ALL ON FUNCTION '+r['signature']+' FROM PUBLIC,anon,authenticated,service_role')
  if 'service_role=X/'in(r['acl']or''):q('GRANT EXECUTE ON FUNCTION '+r['signature']+' TO service_role')
 meta=lambda:q("SELECT jsonb_agg(jsonb_build_array(oid::regprocedure::text,proowner,provolatile,prosecdef,proisstrict,proconfig,proacl::text)ORDER BY oid::regprocedure::text)FROM pg_proc WHERE oid IN('fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure,'fn_union_settlement_cascade(uuid,timestamptz,timestamptz)'::regprocedure)")
 before=meta();q(call,'weekly_accounting_calculation_incomplete');check('(SELECT count(*)FROM phase_legs)=0')
 q('BEGIN;'+migration.split('BEGIN;',1)[1].rsplit('COMMIT;',1)[0]+'ROLLBACK;')
 for r in owners:assert q("SELECT md5(pg_get_functiondef('"+r['signature']+"'::regprocedure))")==r['md5']
 q(migration);assert meta()==before;q(migration,'fees_before_books_original_owner_changed')
 # Whole earned-source and recompute refusals still stop every payer.
 q("SET test.source_bad='on';"+call,'weekly_accounting_calculation_incomplete');q("SET test.recompute_bad='on';"+call,'weekly_accounting_calculation_incomplete');q("SET test.fee_bad='on';"+call,'original_earned_fee_proof_refused');q("SET test.commission_bad='on';"+call,'original_commission_source_refused');q("SET test.engine='false';"+call,'not_authorised');q("SET test.deadline_bad='on';"+call,'original_deadline_refused');check('(SELECT count(*)FROM phase_legs)=0')
 q("INSERT INTO settlement_locks VALUES('GLOBAL_SETTLEMENT_FREEZE',true);" );q(call,'EMERGENCY_PROFIT_DRIFT_LOCK');q('TRUNCATE settlement_locks;')
 for n in [1,2,3]:
  r=json.loads(q(call));assert r['chunk_committed']and r['committed_round']==n,r
 check('(SELECT count(*)FROM phase_legs)=3 AND (SELECT count(*)FROM phase_trace WHERE event=\'pnl\')=0')
 check("(SELECT balance FROM phase_accounts WHERE kind='union_rake')=900 AND(SELECT balance FROM phase_accounts WHERE kind='union_bank')=10 AND(SELECT balance FROM phase_accounts WHERE kind='club')=150 AND(SELECT balance FROM phase_accounts WHERE kind='agent')=30 AND(SELECT balance FROM phase_accounts WHERE kind='player')=10")
 # A real book problem refuses every terminal accounting/invoice transition,
 # while the separately committed original fee receipts remain replay-safe.
 q(call,'union_pnl_basis_uncertified');check("(SELECT count(*)FROM phase_legs)=3 AND NOT EXISTS(SELECT FROM phase_trace WHERE event IN('settled','eco','invoices'))")
 r=json.loads(q("SET test.pnl='warming';"+call));assert r['committed_round']==0 and r['purpose']=='club_settlements',r
 check("(SELECT count(*)FROM phase_legs)=3 AND NOT EXISTS(SELECT FROM phase_trace WHERE event IN('settled','eco','invoices'))")
 r=json.loads(q("SET test.pnl='ready';"+call));assert r['success'],r
 check("EXISTS(SELECT FROM phase_trace WHERE event='settled')AND EXISTS(SELECT FROM phase_trace WHERE event='invoices')AND(SELECT count(*)FROM phase_legs)=3")
 r=json.loads(q("SET test.pnl='ready';"+call));assert r['success'];check('(SELECT count(*)FROM phase_legs)=3')
 # Atomic legacy callers still roll the entire transaction back on a bad book.
 q("TRUNCATE phase_legs,phase_round1,accounting_routed_settlement_runs,union_settlement_rounds,phase_trace,settlement_invoices;UPDATE phase_accounts SET balance=CASE kind WHEN 'union_rake' THEN 1000 WHEN 'club' THEN 100 ELSE 0 END;")
 q("SET app.weekly_accounting_chunked='off';"+call,'union_pnl_basis_uncertified');check("(SELECT count(*)FROM phase_legs)=0 AND(SELECT balance FROM phase_accounts WHERE kind='player')=0")
 print(json.dumps({'passed':True,'actual_changed_owners':2,'original_failure_reproduced':True,'earned_source_recompute_freeze_auth_deadline_guards':True,'stages':[1,2,3],'bad_book_blocks_settlement_and_invoices':True,'warming_proof_commits_without_book_success':True,'replay_zero_duplicate_legs':True,'atomic_legacy_rollback':True,'metadata_rollback_replay_refusal':True,'scope':'phase_order_with_controlled_stage_contracts_not_complete_monetary_writer_qualification'}))
finally:
 if started:run([a.pg_bin/'pg_ctl','-D',b/'d','-m','immediate','-w','stop'])
 shutil.rmtree(b)
