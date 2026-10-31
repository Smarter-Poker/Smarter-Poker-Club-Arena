"""Private PG17 execution of the exact closure functions; never accepts a DSN.

This tests closure routing and financial non-mutation, not gameplay simulation.
The exact reservation function is exercised only through its pre-write refusal
and committed-receipt replay paths. No financial engine is simulated.
"""
import argparse,json,sys
from pathlib import Path
sys.dont_write_bytecode=True
from satellite_qualifier_fixture import module
ROOT=Path(__file__).resolve().parents[2]
def main():
 p=argparse.ArgumentParser();p.add_argument('--pg-bin',type=Path,required=True);p.add_argument('--evidence',type=Path,required=True);p.add_argument('--work-root',type=Path,required=True);p.add_argument('--socket-root',type=Path,required=True);a=p.parse_args()
 for x in (a.evidence,a.work_root,a.socket_root):x.mkdir(parents=True,exist_ok=True)
 b=module(ROOT/'scripts/ci/build-diamond-owner-closure.py','diamond_closure_builder');sql,rows=b.render()
 assert sql==(ROOT/b.MIGRATION).read_text()
 n=module(ROOT/'scripts/ci/test-mtt-unlimited.py','diamond_closure_pg');e=n.Execution(ROOT,a.evidence,a.pg_bin,a.work_root,180,socket_parent=a.socket_root)
 sources=[b.MIGRATION,'scripts/ci/build-diamond-owner-closure.py','scripts/ci/test-diamond-owner-closure.py','scripts/ci/fixtures/diamond-owner-closure.json']
 e.report['source_sha256']={x:n.sha(ROOT/x) for x in sources}
 try:
  e.start();db=e.database()
  fixture="""
CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
CREATE SCHEMA smarter_private;
CREATE TABLE public.tables(id uuid PRIMARY KEY,club_id uuid,union_id uuid,tournament_id uuid,f06_lifecycle bigint,status text,is_deleted boolean);
CREATE TABLE public.tournaments(id uuid PRIMARY KEY,club_id uuid,union_id uuid,status text);
CREATE TABLE public.tournament_players(tournament_id uuid,user_id uuid);
CREATE TABLE public.ca_operator_floor_hold(operation_id uuid,mode text,reason text);
CREATE TABLE public.ca_launch_operator_scopes(operation_id uuid,club_ids uuid[]);
CREATE TABLE public.ca_operator_table_closes(table_id uuid,operation_id uuid,status text);
CREATE TABLE public.hand_state_snapshots(table_id uuid,is_complete boolean);
CREATE TABLE smarter_private.tournament_abort_targets(operation_id uuid,tournament_id uuid);
CREATE TABLE smarter_private.tournament_abort_operations(operation_id uuid,reason text);
CREATE TABLE smarter_private.f06_hand_permits(permit_id uuid,tournament_id uuid,table_id uuid,lifecycle bigint,hand_number bigint,custody_id uuid,generation uuid,state text);
CREATE TABLE public.table_seats(table_id uuid,left_at timestamptz,occupancy_id uuid);
CREATE TABLE public.profiles(id uuid PRIMARY KEY,diamonds bigint);
CREATE TABLE public.poker_diamond_movements(request_id uuid,request jsonb,receipt jsonb);
CREATE TABLE public.clubs(id uuid PRIMARY KEY,asset text,is_platform boolean,union_id uuid);
CREATE TABLE public.ca_arena_settings(id integer,club_id uuid,tournaments_enabled boolean);
CREATE FUNCTION public.fn_ca_launch_cash_close_resumed(uuid,uuid) RETURNS boolean LANGUAGE sql AS 'SELECT false';
-- Only the lease/table lane is inert in this routing fixture; it writes no money.
CREATE FUNCTION public.fn_ca_f06_share_table_lane(uuid,uuid,uuid) RETURNS void LANGUAGE sql AS 'SELECT';
"""
  e.sql(db,fixture,label='closure-routing-fixture')
  for r in rows:
   sig='public.'+r['proname']+'('+','.join(x.strip().split()[-1] for x in r['args'].split(','))+')' if r['args'] else 'public.'+r['proname']+'()'
   e.sql(db,r['definition']+';REVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC;'+('GRANT EXECUTE ON FUNCTION '+sig+' TO service_role;' if 'service_role=' in r['acl'] else ''),label='exact-preimage-'+r['proname'])
  e.sql(db,"CREATE TRIGGER admission BEFORE INSERT OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION public.fn_ca_operator_floor_entry_guard();",label='existing-entry-wiring')
  e.sql(db,"INSERT INTO public.tables VALUES('10000000-0000-0000-0000-000000000001','"+b.CLUB+"',NULL,NULL,1,'running',false),('10000000-0000-0000-0000-000000000002','"+b.CLUB+"',NULL,'20000000-0000-0000-0000-000000000001',1,'running',false),('10000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000001',NULL,NULL,1,'running',false);INSERT INTO public.tournaments VALUES('20000000-0000-0000-0000-000000000001','"+b.CLUB+"',NULL,'RUNNING');",label='closure-three-scopes')
  e.sql(db,"DO $$BEGIN IF public.fn_ca_launch_tournament_held('002c2d27-9584-4e52-835a-bb2be148fc81',NULL) OR public.fn_ca_operator_floor_state('10000000-0000-0000-0000-000000000001')->'hold'<>'null'::jsonb THEN RAISE EXCEPTION 'baseline_was_not_open';END IF;END$$;",label='baseline-open-reproduced')
  e.sql(db,"ALTER TABLE public.tables ADD COLUMN min_buy_in numeric DEFAULT 1,ADD COLUMN max_buy_in numeric DEFAULT 1000;ALTER TABLE public.tournaments ADD COLUMN buy_in_amount numeric DEFAULT 10,ADD COLUMN buy_in_fee numeric DEFAULT 0;INSERT INTO public.profiles VALUES('70000000-0000-0000-0000-000000000001',100);INSERT INTO public.clubs VALUES('"+b.CLUB+"','diamonds',true,NULL);INSERT INTO public.ca_arena_settings VALUES(1,'"+b.CLUB+"',true);",label='reservation-prewrite-fixture')
  drift=e.database(db)
  e.sql(drift,'GRANT EXECUTE ON FUNCTION public.fn_ca_operator_floor_state(uuid) TO anon;',label='changed-authority-fixture')
  code,_,err=e.sql(drift,sql,label='changed-authority-refused',check=False)
  if not code or 'DIAMOND_CLOSURE_PREIMAGE_CHANGED' not in err:raise RuntimeError('authority drift accepted')
  if e.sql(drift,"SELECT to_regclass('public.ca_diamond_arena_owner_closure') IS NULL;",label='drift-install-rolled-back')[1].strip()!='t':raise RuntimeError('partial installation survived')
  e.discard(drift)
  e.sql(db,sql,label='exact-closure-install')
  assertions="""
DO $$DECLARE x jsonb;BEGIN
 IF NOT public.fn_ca_launch_tournament_held('002c2d27-9584-4e52-835a-bb2be148fc81',NULL) OR public.fn_ca_launch_tournament_held('30000000-0000-0000-0000-000000000001',NULL) THEN RAISE EXCEPTION 'admission_scope';END IF;
 IF public.fn_ca_operator_floor_state('10000000-0000-0000-0000-000000000001')->'hold'='null'::jsonb OR public.fn_ca_operator_floor_state('10000000-0000-0000-0000-000000000002')->'hold'='null'::jsonb OR public.fn_ca_operator_floor_state('10000000-0000-0000-0000-000000000003')->'hold'<>'null'::jsonb THEN RAISE EXCEPTION 'boundary_scope';END IF;
 BEGIN INSERT INTO public.table_seats VALUES('10000000-0000-0000-0000-000000000001',NULL,gen_random_uuid());RAISE EXCEPTION 'cash_admitted';EXCEPTION WHEN SQLSTATE '55006' THEN NULL;END;
 INSERT INTO public.table_seats VALUES('10000000-0000-0000-0000-000000000003',NULL,gen_random_uuid());
 x:=public.fn_ca_lock_tournament_seat_acquisition('20000000-0000-0000-0000-000000000001',NULL,gen_random_uuid());IF x->>'reason'<>'diamond_arena_closed' THEN RAISE EXCEPTION 'new_registration';END IF;
 x:=public.fn_f06_begin_hand('20000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002',1,'50000000-0000-0000-0000-000000000001',1,'60000000-0000-0000-0000-000000000001');IF x->>'reason'<>'diamond_arena_closed' THEN RAISE EXCEPTION 'new_hand';END IF;
 INSERT INTO smarter_private.f06_hand_permits VALUES('50000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002',1,1,'60000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','reserved');
 IF public.fn_ca_operator_floor_state('10000000-0000-0000-0000-000000000002')->'hold'<>'null'::jsonb THEN RAISE EXCEPTION 'original_recovery_blocked';END IF;
 x:=public.fn_f06_begin_hand('20000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002',1,'50000000-0000-0000-0000-000000000001',1,'60000000-0000-0000-0000-000000000001');IF x->>'ok'<>'true' THEN RAISE EXCEPTION 'original_replay';END IF;
 BEGIN PERFORM public.fn_f06_begin_hand('20000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002',2,'50000000-0000-0000-0000-000000000001',1,'60000000-0000-0000-0000-000000000001');RAISE EXCEPTION 'changed_original_admitted';EXCEPTION WHEN SQLSTATE '22023' THEN NULL;END;
 UPDATE smarter_private.f06_hand_permits SET state='committed';
 IF public.fn_ca_operator_floor_state('10000000-0000-0000-0000-000000000002')->'hold'='null'::jsonb THEN RAISE EXCEPTION 'boundary_did_not_close';END IF;
 INSERT INTO public.hand_state_snapshots VALUES('10000000-0000-0000-0000-000000000001',false);
 IF public.fn_ca_operator_floor_state('10000000-0000-0000-0000-000000000001')->'hold'<>'null'::jsonb THEN RAISE EXCEPTION 'cash_original_recovery';END IF;
 IF has_table_privilege('anon','public.ca_diamond_arena_owner_closure','UPDATE') OR has_table_privilege('authenticated','public.ca_diamond_arena_owner_closure','UPDATE') OR has_table_privilege('service_role','public.ca_diamond_arena_owner_closure','UPDATE') THEN RAISE EXCEPTION 'closure_write_acl';END IF;
END $$;
"""
  e.sql(db,'BEGIN;'+assertions+'ROLLBACK;',label='closure-boundaries-and-original-preservation')
  e.sql(db,"""
BEGIN;
INSERT INTO public.poker_diamond_movements VALUES(
 '80000000-0000-0000-0000-000000000001',
 jsonb_build_object('user_id','70000000-0000-0000-0000-000000000001','purpose','cash_seat','target_id','10000000-0000-0000-0000-000000000001','entry_key','existing','amount',10,'action','reserve'),
 '{"success":true,"original_receipt":true}');
DO $$DECLARE x jsonb;target uuid;purpose text;BEGIN
 x:=public.fn_poker_diamond_reserve('70000000-0000-0000-0000-000000000001','cash_seat','10000000-0000-0000-0000-000000000001','existing',10,'80000000-0000-0000-0000-000000000001');
 IF x<>'{"success":true,"original_receipt":true}'::jsonb THEN RAISE EXCEPTION 'committed_receipt_changed';END IF;
 BEGIN
  PERFORM public.fn_poker_diamond_reserve('70000000-0000-0000-0000-000000000001','cash_seat','10000000-0000-0000-0000-000000000001','existing',11,'80000000-0000-0000-0000-000000000001');
  RAISE EXCEPTION 'changed_receipt_accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'idempotency_payload_mismatch' THEN RAISE;END IF;END;
 FOR target,purpose IN SELECT * FROM (VALUES ('10000000-0000-0000-0000-000000000001'::uuid,'cash_seat'),('20000000-0000-0000-0000-000000000001'::uuid,'tournament_entry')) AS v(t,p) LOOP
  BEGIN
   PERFORM public.fn_poker_diamond_reserve('70000000-0000-0000-0000-000000000001',purpose,target,'new',10,gen_random_uuid());
   RAISE EXCEPTION 'new_funding_accepted';
  EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'diamond_arena_closed' THEN RAISE;END IF;END;
 END LOOP;
 IF (SELECT diamonds FROM public.profiles WHERE id='70000000-0000-0000-0000-000000000001')<>100 OR (SELECT count(*) FROM public.poker_diamond_movements)<>1 THEN RAISE EXCEPTION 'reservation_mutated_money';END IF;
END$$;
ROLLBACK;
""",label='new-funding-refused-original-receipt-preserved')
  code,_,err=e.sql(db,sql,label='closure-replay-refused',check=False)
  if not code or 'already exists' not in err:raise RuntimeError('migration replay was not refused')
  if any(n.sha(ROOT/x)!=h for x,h in e.report['source_sha256'].items()):raise RuntimeError('qualification source changed')
  e.report.update(status='passed',scope='Exact installed functions, boundary/admission routing and original permit replay. No production writes or financial simulation.')
 except BaseException as err:e.report['failure']=repr(err)
 finally:
  e.close();(a.evidence/'result.json').write_text(json.dumps(e.report,indent=2));print(json.dumps({k:e.report.get(k) for k in ('status','failure','cleanup')}))
 return 0 if e.report['status']=='passed' else 1
if __name__=='__main__':sys.exit(main())
