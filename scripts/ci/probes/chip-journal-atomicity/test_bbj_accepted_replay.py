"""A banked legacy receipt can recover only from the exact accepted hand."""
from test_bbj import P, Q, T, C, H


def verify_accepted_replay(run, ddl, setup, call, state, extract, root):
 seed = f"""
 INSERT INTO hand_atomic_commits(hand_id,table_id,hand_number,post_commit_payload)
 VALUES({H},{T},1,jsonb_build_object('bbj_contribution',
   jsonb_build_object('amount',0.25,'club_id',{C},'big_blind',2)));
 UPDATE hand_atomic_commits SET post_commit_payload_hash=encode(extensions.digest(
   convert_to(post_commit_payload::text,'UTF8'),'sha256'),'hex');
 INSERT INTO bbj_contributions(pool_id,hand_id,table_id,club_id,amount,
   main_portion,backup_portion,promo_portion,big_blind,hand_number)
 VALUES({P},{H},{T},{C},0.25,0.13,0.06,0.06,NULL,NULL);
 """
 # The same input fails against the original production body. This proves
 # the regression rather than only checking the replacement's text.
 original = list(extract((root/'supabase/migrations/20260908045746_bbj_contribution_identity_serializes_before_allocation.sql').read_text(),'bbj_record_contribution'))[-1]
 run('BEGIN;'+ddl+setup+seed+original+f"""
 DO $check$ DECLARE caught boolean:=false; BEGIN
  BEGIN PERFORM {call()}; EXCEPTION WHEN SQLSTATE '22023' THEN caught:=true; END;
  IF NOT caught THEN RAISE EXCEPTION 'Original failure was not reproduced'; END IF;
 END $check$; ROLLBACK;
 """)
 cases = 1
 for metadata in ['', 'UPDATE bbj_contributions SET hand_number=1;',
                  'UPDATE bbj_contributions SET big_blind=2;']:
  run('BEGIN;'+ddl+setup+seed+metadata+f"""
  DO $check$ DECLARE before_state jsonb; receipt bbj_contributions; BEGIN
   SELECT {state} INTO before_state;
   receipt := {call()};
   IF receipt.id IS DISTINCT FROM (SELECT id FROM bbj_contributions)
      OR receipt.hand_number<>1 OR receipt.big_blind<>2
      OR before_state IS DISTINCT FROM {state}
      OR EXISTS(SELECT 1 FROM hand_atomic_commits WHERE post_commit_completed_at IS NOT NULL)
   THEN RAISE EXCEPTION 'Replay did not retain its receipt without another payment'; END IF;
   PERFORM {call()};
   IF before_state IS DISTINCT FROM {state} THEN RAISE EXCEPTION 'Repeat replay wrote data'; END IF;
  END $check$; ROLLBACK;
  """)
  cases += 1
 # All known conflicts still fail. Missing/corrupt proof never earns an exception.
 faults = [
  ('DELETE FROM hand_atomic_commits;',call()),
  ("UPDATE hand_atomic_commits SET post_commit_payload_hash='tampered';",call()),
  ("UPDATE hand_atomic_commits SET post_commit_payload=jsonb_set(post_commit_payload,'{bbj_contribution,amount}','0.26');",call()),
  ('UPDATE bbj_contributions SET hand_number=2;',call()),
  ('UPDATE bbj_contributions SET big_blind=3;',call()),
  ('',call(amount='0.26')),('',call(blind='3')),('',call(number='2')),
  ('',call(pool=Q)),('',call(club=Q)),('',call(table=Q)),
  ('UPDATE bbj_contributions SET hand_number=1;',call(hand='NULL')),
 ]
 for mutation, request in faults:
  run('BEGIN;'+ddl+setup+seed+mutation+f"""
  DO $check$ DECLARE before_state jsonb; caught boolean:=false; BEGIN
   SELECT {state} INTO before_state;
   BEGIN PERFORM {request}; EXCEPTION WHEN SQLSTATE '22023' THEN caught:=true; END;
   IF NOT caught OR before_state IS DISTINCT FROM {state}
   THEN RAISE EXCEPTION 'An unproven or conflicting replay escaped'; END IF;
  END $check$; ROLLBACK;
  """)
  cases += 1
 repair = list(extract((root/'supabase/migrations/20260908171222_bbj_repair_receipts_replay_accepted_hand_identity.sql').read_text(),'fn_bbj_repair_unbanked'))[-1]
 repair_setup = f"""
 ALTER TABLE bbj_pools ADD COLUMN status text DEFAULT 'active',ADD COLUMN union_id uuid;
 INSERT INTO clubs(id) VALUES({C});
 CREATE OR REPLACE FUNCTION fn_platform_frozen() RETURNS boolean LANGUAGE sql AS 'SELECT false';
 INSERT INTO rake_records(hand_id,table_id,club_id,bbj_contribution,metadata,created_at)
 VALUES({H},{T},{C},0.25,'{{"big_blind":2}}',now()-interval '10 minutes');
 """
 for accepted in [True, False]:
  owned = seed+'DELETE FROM bbj_contributions;' if accepted else ''
  run('BEGIN;'+ddl+setup+repair+repair_setup+owned+f"""
  DO $check$ DECLARE rows_written int; BEGIN
   SELECT count(*) INTO rows_written FROM fn_bbj_repair_unbanked(48,200);
   IF rows_written<>{0 if accepted else 1}
      OR (SELECT count(*) FROM bbj_contributions)<>{0 if accepted else 1}
      OR (SELECT total_contributed FROM bbj_pools WHERE id={P})<>{0 if accepted else 0.25}
   THEN RAISE EXCEPTION 'Repair ownership changed incorrectly'; END IF;
  END $check$; ROLLBACK;
  """)
  cases += 1
 print(f'TOTAL accepted BBJ receipt recovery: {cases} passing cases',flush=True)
