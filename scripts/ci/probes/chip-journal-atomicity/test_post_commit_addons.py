"""Execute the real hand processor and add-on resolver on isolated receipts."""
from pathlib import Path
import re


def verify_post_commit_addons(run):
 root=Path(__file__).resolve().parents[4]
 def extract(file,name):
  s=(root/'supabase/migrations'/file).read_text()
  m=re.search(r'CREATE OR REPLACE FUNCTION public\.'+name+r'\s*\(',s)
  t=s[m.start():];b=re.search(r'\bAS\s+(\$[A-Za-z0-9_]*\$)',t);e=t.index(b[1],b.end())
  return t[:e+len(b[1])]+';'
 old=extract('20260908130009_post_commit_obligations_are_atomic_and_resumable.sql','fn_ca_process_hand_post_commit_obligations')
 new=extract('20260908175113_post_commit_addons_accept_proven_resolution_receipts.sql','fn_ca_process_hand_post_commit_obligations')
 resolver=extract('20260904120000_chip_continuity_slice_0.sql','resolve_pending_addon')
 H="'a0000000-0000-4000-8000-000000000001'"
 H2="'a0000000-0000-4000-8000-000000000002'"
 T="'b0000000-0000-4000-8000-000000000001'"
 A="'c0000000-0000-4000-8000-000000000001'"
 U="'d0000000-0000-4000-8000-000000000001'"
 fixture="""
 CREATE SCHEMA IF NOT EXISTS extensions;
 CREATE OR REPLACE FUNCTION extensions.digest(bytea,text) RETURNS bytea LANGUAGE sql AS $$SELECT sha256($1)$$;
 CREATE TABLE IF NOT EXISTS hand_atomic_commits(hand_id uuid PRIMARY KEY,table_id uuid,hand_number bigint,
  post_commit_payload jsonb,post_commit_payload_hash text,post_commit_completed_at timestamptz);
 ALTER TABLE hand_atomic_commits ADD COLUMN IF NOT EXISTS post_commit_result jsonb;
 CREATE TABLE table_pending_addons(id uuid PRIMARY KEY,table_id uuid,user_id uuid,amount numeric,
  resolved_at timestamptz,applied_to_stack numeric,refunded numeric,kind text DEFAULT 'addon',created_at timestamptz DEFAULT now());
 """
 payload=f"jsonb_build_object('time_banks','[]'::jsonb,'rake',NULL,'bbj_contribution',NULL,'promo_playthrough','[]'::jsonb,'insurance','[]'::jsonb,'pending_addons',jsonb_build_object('enabled',true,'max_buy_in',1000,'ids',jsonb_build_array({A})))"
 seed=f"""
 INSERT INTO hand_atomic_commits(hand_id,table_id,hand_number,post_commit_payload) VALUES({H},{T},1,{payload});
 UPDATE hand_atomic_commits SET post_commit_payload_hash=encode(extensions.digest(convert_to(post_commit_payload::text,'UTF8'),'sha256'),'hex');
 INSERT INTO table_seats(table_id,user_id,seat_number,stack) VALUES({T},{U},1,100);
 INSERT INTO table_pending_addons(id,table_id,user_id,amount,resolved_at,applied_to_stack,refunded)
 VALUES({A},{T},{U},25,now(),25,0);
 """
 state="jsonb_build_array("+','.join(f"(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM {n} t)" for n in ['table_pending_addons','table_seats','cash_baselines','chip_ledger'])+")"
 call=f'fn_ca_process_hand_post_commit_obligations({H})'
 def refusal(body,mutation,message):
  run('BEGIN;'+fixture+resolver+body+seed+mutation+f"""
  DO $check$ DECLARE before_state jsonb;caught boolean:=false;BEGIN
   SELECT {state} INTO before_state;
   BEGIN PERFORM {call};
   EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF position('{message}' IN SQLERRM)=0 THEN RAISE; END IF;
    caught:=true;
   END;
   IF NOT caught OR before_state IS DISTINCT FROM {state}
     OR EXISTS(SELECT 1 FROM hand_atomic_commits WHERE post_commit_completed_at IS NOT NULL)
   THEN RAISE EXCEPTION 'Invalid receipt admitted or a partial write escaped'; END IF;
  END $check$;ROLLBACK;
  """)
 refusal(old,'','is not unresolved')
 cases=1
 for fields in ['25,0','15,10','0,25']:
  applied,refunded=fields.split(',')
  run('BEGIN;'+fixture+resolver+new+seed+f"""
  UPDATE table_pending_addons SET applied_to_stack={applied},refunded={refunded};
  DO $check$ DECLARE before_state jsonb;receipt jsonb;BEGIN
   SELECT {state} INTO before_state;
   receipt:={call};
   IF receipt->>'ok' IS DISTINCT FROM 'true' OR receipt->>'pending_addons'<>'1'
     OR before_state IS DISTINCT FROM {state}
   THEN RAISE EXCEPTION 'Completed add-on replay changed money or was refused'; END IF;
   receipt:={call};
   IF receipt->>'already_completed' IS DISTINCT FROM 'true' OR before_state IS DISTINCT FROM {state}
   THEN RAISE EXCEPTION 'Repeated hand replay changed money'; END IF;
  END $check$;ROLLBACK;
  """)
  cases+=1
 for mutation,message in [
  ('DELETE FROM table_pending_addons;','does not belong'),
  (f'UPDATE table_pending_addons SET table_id={H2};','does not belong'),
  ("UPDATE hand_atomic_commits SET post_commit_payload_hash='bad';",'payload hash mismatch'),
  ('UPDATE table_pending_addons SET applied_to_stack=24;','incomplete resolution receipt'),
  ('UPDATE table_pending_addons SET applied_to_stack=NULL;','incomplete resolution receipt'),
  ('UPDATE table_pending_addons SET applied_to_stack=NULL,refunded=25;','incomplete resolution receipt'),
  ('UPDATE table_pending_addons SET refunded=NULL;','incomplete resolution receipt'),
  ('UPDATE table_pending_addons SET applied_to_stack=-1,refunded=26;','incomplete resolution receipt'),
  ("UPDATE table_pending_addons SET amount='NaN';",'incomplete resolution receipt'),
 ]:
  refusal(new,mutation,message);cases+=1
 # Two recovered accepted hands froze one row. Only the first delivers it;
 # the second consumes the exact stored result without another stack credit.
 run('BEGIN;'+fixture+resolver+new+seed+f"""
 UPDATE table_pending_addons SET resolved_at=NULL,applied_to_stack=NULL,refunded=NULL;
 INSERT INTO hand_atomic_commits(hand_id,table_id,hand_number,post_commit_payload,post_commit_payload_hash)
 SELECT {H2},table_id,2,post_commit_payload,post_commit_payload_hash FROM hand_atomic_commits WHERE hand_id={H};
 DO $check$ DECLARE before_state jsonb;receipt jsonb;BEGIN
  receipt:=fn_ca_process_hand_post_commit_obligations({H2});
  IF receipt->>'reason' IS DISTINCT FROM 'predecessor_pending'
   OR (SELECT stack FROM table_seats WHERE table_id={T})<>100
  THEN RAISE EXCEPTION 'Predecessor barrier was bypassed';END IF;
  receipt:={call};
  IF receipt->>'ok' IS DISTINCT FROM 'true' OR (SELECT stack FROM table_seats WHERE table_id={T})<>125
   OR (SELECT sum(amount) FROM cash_baselines WHERE table_id={T})<>25
  THEN RAISE EXCEPTION 'Unresolved add-on was not delivered exactly once';END IF;
  SELECT {state} INTO before_state;
  receipt:=fn_ca_process_hand_post_commit_obligations({H2});
  IF receipt->>'ok' IS DISTINCT FROM 'true' OR before_state IS DISTINCT FROM {state}
   OR (SELECT count(*) FROM hand_atomic_commits WHERE post_commit_completed_at IS NOT NULL)<>2
  THEN RAISE EXCEPTION 'Second accepted hand did not reuse the completed add-on';END IF;
 END $check$;ROLLBACK;
 """)
 cases+=1
 print(f'TOTAL post-commit add-on recovery: {cases} PostgreSQL scenarios passed',flush=True)
