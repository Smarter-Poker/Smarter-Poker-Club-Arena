"""Native scope/atomicity proof; controlled freeze/F06 leaves, real row transactions.
Does not qualify deletion of original settlement requests or financial receipts.
"""
import argparse,json,sys
from pathlib import Path
sys.dont_write_bytecode=True
from satellite_qualifier_fixture import module
ROOT=Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser()
for k in ('pg-bin','evidence','work-root','socket-root'):p.add_argument('--'+k,type=Path,required=True)
a=p.parse_args()
for x in (a.evidence,a.work_root,a.socket_root):x.mkdir(parents=True,exist_ok=True)
n=module(ROOT/'scripts/ci/test-mtt-unlimited.py','diamond_remove_pg');e=n.Execution(ROOT,a.evidence,a.pg_bin,a.work_root,120,socket_parent=a.socket_root)
operation=(ROOT/'scripts/operations/remove-diamond-settled-history.sql').read_text()
club='002c2d27-9584-4e52-835a-bb2be148fc81';table='10000000-0000-0000-0000-000000000001';tour='20000000-0000-0000-0000-000000000001'
prefix=f"BEGIN; SET LOCAL ca.diamond_purge_table='{table}'; SET LOCAL ca.diamond_purge_dry_run='false';"
try:
 e.start();db=e.database()
 e.sql(db,"""
 CREATE SCHEMA smarter_private;
 CREATE TABLE tables(id uuid PRIMARY KEY,club_id uuid,tournament_id uuid,status text);
 CREATE TABLE tournaments(id uuid PRIMARY KEY,club_id uuid,status text,bounty_pool numeric,bounty_pool_paid numeric,variant text,tournament_type text);
 CREATE TABLE tournament_terminal_settlements(tournament_id uuid);
 CREATE TABLE ca_diamond_arena_owner_closure(club_id uuid,operation_id uuid,closed boolean);
 CREATE TABLE ca_arena_settings(id int,club_id uuid,cash_games_enabled boolean,tournaments_enabled boolean);
 CREATE TABLE tournament_escrow(tournament_id uuid,closed_at timestamptz);
 CREATE TABLE hand_history(id uuid PRIMARY KEY,table_id uuid,tournament_id uuid,hand_number int,reported boolean,big_blind numeric,pot_size numeric,rake_amount numeric,bbj_amount numeric,winners jsonb,created_at timestamptz);
 CREATE TABLE hand_atomic_commits(hand_id uuid,table_id uuid,hand_number bigint,post_commit_completed_at timestamptz,post_commit_result jsonb);
 CREATE TABLE ca_hand_financial_facts(hand_id uuid PRIMARY KEY,table_id uuid,tournament_id uuid,hand_number int,big_blind numeric,pot_size numeric,rake_amount numeric,bbj_amount numeric,winners jsonb,hand_created_at timestamptz);
 CREATE TABLE poker_diamond_jackpot_hits(table_id uuid,hand_number bigint,paid boolean);
 CREATE TABLE bbj_payouts(table_id uuid,hand_number bigint);
 CREATE TABLE hand_projection_outbox(hand_id uuid);
 CREATE TABLE tournament_knockout_candidates(hand_id uuid,state text);
 CREATE TABLE smarter_private.original_inventory_restoration_cases(source_refs jsonb);
 CREATE TABLE smarter_private.hand_submissions(table_id uuid,hand_number bigint,submission_id uuid PRIMARY KEY,retained_at timestamptz,lease_generation bigint,request_hash text,request jsonb);
 CREATE TABLE smarter_private.hand_submission_disposals(table_id uuid,hand_number bigint,submission_id uuid,receipt_id uuid,witness_hand_number bigint,reason text,expected jsonb,PRIMARY KEY(table_id,hand_number));
 CREATE TABLE ca_hand_notes(hand_id uuid REFERENCES hand_history(id) ON DELETE CASCADE);
 CREATE FUNCTION fn_platform_frozen() RETURNS boolean LANGUAGE sql AS 'SELECT false';
 CREATE FUNCTION smarter_private.f06_hand_cards_unresolved(uuid,bigint) RETURNS boolean LANGUAGE sql AS 'SELECT $2=3';
 CREATE FUNCTION smarter_private.f06_movement_boundary_retained(uuid,bigint) RETURNS boolean LANGUAGE sql AS 'SELECT $2=4';
 """,label='controlled-native-selector-catalog')
 e.sql(db,f"""
 INSERT INTO tables VALUES('{table}','{club}','{tour}','closed');
 INSERT INTO tournaments VALUES('{tour}','{club}','COMPLETED',100,100,'nlh','MTT');
 INSERT INTO ca_arena_settings VALUES(1,'{club}',false,false);
 INSERT INTO ca_diamond_arena_owner_closure VALUES('{club}','01a18fed-2211-7a62-9416-611dd6e4d96d',true);
 INSERT INTO hand_history SELECT md5(g::text)::uuid,'{table}','{tour}',g,false,1,20,1,0,'[]',now() FROM generate_series(1,6)g;
 INSERT INTO hand_atomic_commits SELECT id,table_id,hand_number,CASE WHEN hand_number<>2 THEN now() END,'{{"ok":true}}' FROM hand_history;
 INSERT INTO hand_projection_outbox SELECT id FROM hand_history WHERE hand_number=5;
 INSERT INTO tournament_knockout_candidates SELECT id,'pending' FROM hand_history WHERE hand_number=6;
 INSERT INTO ca_hand_notes SELECT id FROM hand_history;
 INSERT INTO smarter_private.hand_submissions SELECT table_id,hand_number,id,created_at,1,md5(id::text),'{{"original":true}}' FROM hand_history;
 """,label='six-rows-one-eligible')
 code,_,err=e.sql(db,prefix+f"SET LOCAL ca.diamond_purge_tables='{{{table},{table},{table}}}';"+operation+'COMMIT;',label='oversized-batch-refused',check=False)
 if not code or 'DIAMOND_REMOVAL_PAGE_BOUND' not in err:raise RuntimeError('oversized batch admitted')
 for label,change,error in [('foreign-club',"UPDATE tables SET club_id=gen_random_uuid();",'DIAMOND_TERMINAL_TABLE_REQUIRED'),('open-arena','UPDATE ca_arena_settings SET cash_games_enabled=true;','DIAMOND_NOT_PARKED'),('unpaid-bounty','UPDATE tournaments SET bounty_pool_paid=0;','DIAMOND_TERMINAL_TABLE_REQUIRED'),('spin-without-terminal-receipt',"UPDATE tournaments SET tournament_type='SPIN';",'DIAMOND_TERMINAL_TABLE_REQUIRED')]:
  code,_,err=e.sql(db,prefix+change+operation+'COMMIT;',label=label,check=False)
  if not code or error not in err:raise RuntimeError(label+' not refused')
 code,_,err=e.sql(db,prefix+f"SET LOCAL ca.diamond_purge_tables='{{{table},ffffffff-ffff-ffff-ffff-ffffffffffff}}';"+operation+'COMMIT;',label='mixed-scope-batch-rolls-back',check=False)
 if not code or 'DIAMOND_TERMINAL_TABLE_REQUIRED' not in err:raise RuntimeError('mixed scope admitted')
 code,_,err=e.sql(db,prefix+"SET LOCAL ca.diamond_purge_dry_run='true';"+operation+'COMMIT;',label='actual-delete-rolled-back',check=False)
 if not code or 'DIAMOND_REMOVAL_ROLLED_BACK' not in err:raise RuntimeError('dry run did not abort: '+err)
 if e.sql(db,'SELECT (SELECT count(*) FROM hand_history)=6 AND (SELECT count(*) FROM ca_hand_financial_facts)=0 AND (SELECT count(*) FROM smarter_private.hand_submission_disposals)=0;',label='rollback-preserved')[1].strip()!='t':raise RuntimeError('rollback leaked')
 e.sql(db,prefix+operation+'COMMIT;',label='one-qualified-history-removed')
 check="SELECT (SELECT count(*) FROM hand_history)=5 AND (SELECT count(*) FROM ca_hand_notes)=5 AND (SELECT count(*) FROM hand_atomic_commits)=6 AND (SELECT count(*) FROM ca_hand_financial_facts)=1 AND (SELECT count(*) FROM smarter_private.hand_submission_disposals)=1 AND (SELECT count(*) FROM smarter_private.hand_submissions WHERE request='{\"original\":true}'::jsonb)=6;"
 if e.sql(db,check,label='receipt-and-unsettled-evidence-preserved')[1].strip()!='t':raise RuntimeError('wrong deletion scope')
 e.sql(db,prefix+operation+'COMMIT;',label='duplicate-removal-zero')
 if e.sql(db,check,label='repeat-preserved')[1].strip()!='t':raise RuntimeError('repeat changed data')
 # Simulate the earlier history-only operation while retaining its exact facts.
 e.sql(db,"DELETE FROM smarter_private.hand_submission_disposals;",label='prior-history-only-state')
 e.sql(db,prefix+operation+'COMMIT;',label='recover-original-witness-from-facts')
 if e.sql(db,check,label='recovery-preserves-raw-and-accounting')[1].strip()!='t':raise RuntimeError('recovery changed retained data')
 if e.sql(db,"SELECT expected->>'witness_source'='preserved_financial_facts' AND (expected->>'hand_created_at')::timestamptz=f.hand_created_at FROM smarter_private.hand_submission_disposals d JOIN ca_hand_financial_facts f ON f.hand_id=d.submission_id;",label='recovery-original-time')[1].strip()!='t':raise RuntimeError('recovery invented provenance')
 e.sql(db,prefix+operation+'COMMIT;',label='repeat-recovery-zero')
 if e.sql(db,check,label='repeat-recovery-preserved')[1].strip()!='t':raise RuntimeError('recovery duplicate changed data')
 e.report.update(status='passed',operation_sha256=n.sha(ROOT/'scripts/operations/remove-diamond-settled-history.sql'),limitations=__doc__)
except BaseException as err:e.report['failure']=repr(err)
finally:
 e.close();(a.evidence/'result.json').write_text(json.dumps(e.report,indent=2));print(json.dumps({k:e.report.get(k) for k in ('status','failure','cleanup')}))
sys.exit(0 if e.report['status']=='passed' else 1)
