\set ON_ERROR_STOP on
CREATE FUNCTION public.fixture_refuses(p_sql text,p_state text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF p_state IS NULL OR SQLSTATE=p_state THEN RETURN; END IF;
    RAISE EXCEPTION 'wrong refusal state %, expected %: %',SQLSTATE,p_state,SQLERRM;
  END;
  RAISE EXCEPTION 'expected refusal: %',p_sql;
END $$;

INSERT INTO clubs(id,asset) VALUES('10000000-0000-4000-8000-000000000001','chips');
INSERT INTO club_members VALUES(
 '10000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','active'
);
INSERT INTO tables VALUES('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001');
INSERT INTO hand_history(id,table_id,hand_number) VALUES
 ('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',1001),
 ('30000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001',1002);

CREATE FUNCTION public.fixture_stats(p_hand uuid,p_net numeric) RETURNS jsonb LANGUAGE sql AS $$
SELECT jsonb_build_object('version',1,'facts',jsonb_build_array(jsonb_build_object(
 'hand_id',p_hand,'user_id','40000000-0000-4000-8000-000000000001',
 'club_id','10000000-0000-4000-8000-000000000001','table_id','20000000-0000-4000-8000-000000000001',
 'tournament_id',NULL,'played_at','2026-10-03T12:00:00Z','game_variant','nlh','big_blind',2,
 'seat',1,'position','BTN','players_dealt',2,
 'opponent_ids',jsonb_build_array('40000000-0000-4000-8000-000000000002'),
 'hole_cards',jsonb_build_array(jsonb_build_object('rank','A','suit','spades'),jsonb_build_object('rank','K','suit','spades')),
 'hand_class','AKs','invested',10,'returned',10+p_net,'net',p_net,'net_bb',p_net/2,
 'rake_paid',0.2,'vpip',true,'pfr',true,'three_bet',false,'four_bet',false,
 'faced_three_bet',false,'folded_to_three_bet',false,'had_cbet_flop_opp',true,
 'cbet_flop',true,'saw_flop',true,'went_to_showdown',true,'won_at_showdown',p_net>0,
 'aggressive_actions',2,'passive_actions',1,'was_all_in',false,'all_in_street',NULL,
 'all_in_at_risk',NULL,'all_in_equity',NULL,'ev_returned',NULL,'ev_net',p_net,'ev_net_bb',p_net/2
 )),'transfers','[]'::jsonb)
$$;

INSERT INTO hand_atomic_commits VALUES
 ('20000000-0000-4000-8000-000000000001',1001,'30000000-0000-4000-8000-000000000001',
  jsonb_build_object('accepted_hand_facts',jsonb_build_object('stats_facts',fixture_stats('30000000-0000-4000-8000-000000000001',5)))),
 ('20000000-0000-4000-8000-000000000001',1002,'30000000-0000-4000-8000-000000000002',
  jsonb_build_object('accepted_hand_facts',jsonb_build_object('stats_facts',fixture_stats('30000000-0000-4000-8000-000000000002',-4))));

DO $$ DECLARE v jsonb; BEGIN
 v:=ca_project_hand_stats_facts('30000000-0000-4000-8000-000000000001');
 IF NOT (v->>'ok')::boolean OR (SELECT net FROM ca_hand_facts WHERE hand_id='30000000-0000-4000-8000-000000000001')<>5 THEN
   RAISE EXCEPTION 'initial projection failed: %',v;
 END IF;
 v:=ca_project_hand_stats_facts('30000000-0000-4000-8000-000000000001');
 IF NOT (v->>'ok')::boolean OR (SELECT count(*) FROM ca_hand_facts WHERE hand_id='30000000-0000-4000-8000-000000000001')<>1 THEN
   RAISE EXCEPTION 'idempotent projection failed: %',v;
 END IF;
END $$;

UPDATE hand_atomic_commits SET post_commit_payload=jsonb_build_object(
 'accepted_hand_facts',jsonb_build_object('stats_facts',fixture_stats('30000000-0000-4000-8000-000000000001',6)))
 WHERE hand_number=1001;
SELECT fixture_refuses($q$SELECT ca_project_hand_stats_facts('30000000-0000-4000-8000-000000000001')$q$);
UPDATE hand_atomic_commits SET post_commit_payload=jsonb_build_object(
 'accepted_hand_facts',jsonb_build_object('stats_facts',fixture_stats('30000000-0000-4000-8000-000000000001',5)))
 WHERE hand_number=1001;

-- The accepted-hand projector is the only writer. Exercise it directly as the
-- transactional outbox does; there is deliberately no later repair sweep.
DELETE FROM hand_history
 WHERE id='30000000-0000-4000-8000-000000000002';
DO $$ DECLARE v jsonb; BEGIN
 v:=ca_project_hand_stats_facts('30000000-0000-4000-8000-000000000002');
 IF NOT COALESCE((v->>'ok')::boolean,false)
    OR NOT EXISTS(SELECT 1 FROM ca_hand_facts WHERE hand_id='30000000-0000-4000-8000-000000000002')
    OR NOT EXISTS(SELECT 1 FROM ca_hand_fact_projection_receipts WHERE hand_id='30000000-0000-4000-8000-000000000002') THEN
   RAISE EXCEPTION 'transactional projection failed: %',v;
 END IF;
END $$;

DO $$ DECLARE v jsonb; k uuid:='50000000-0000-4000-8000-000000000001'; BEGIN
 v:=ca_append_hand_fact_revision('30000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001','correction',
  '{"returned":17,"net":7,"net_bb":3.5,"ev_net":7,"ev_net_bb":3.5}'::jsonb,'case-1',k);
 IF (SELECT net FROM ca_hand_facts WHERE hand_id='30000000-0000-4000-8000-000000000001')<>7 THEN
   RAISE EXCEPTION 'correction not materialized';
 END IF;
 v:=ca_append_hand_fact_revision('30000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001','correction',
  '{"returned":17,"net":7,"net_bb":3.5,"ev_net":7,"ev_net_bb":3.5}'::jsonb,'case-1',k);
 IF NOT (v->>'replay')::boolean OR (SELECT count(*) FROM ca_hand_fact_revisions WHERE idempotency_key=k)<>1 THEN
   RAISE EXCEPTION 'revision replay failed: %',v;
 END IF;
END $$;
SELECT fixture_refuses($q$SELECT ca_append_hand_fact_revision(
 '30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',
 'refund','{"returned":16,"net":6,"net_bb":3,"ev_net":6,"ev_net_bb":3}'::jsonb,'different',
 '50000000-0000-4000-8000-000000000001')$q$);

SELECT ca_append_hand_fact_revision('30000000-0000-4000-8000-000000000002',
 '40000000-0000-4000-8000-000000000001','void',NULL,'void-case',
 '50000000-0000-4000-8000-000000000002');
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM ca_hand_facts WHERE hand_id='30000000-0000-4000-8000-000000000002')
    OR NOT EXISTS(SELECT 1 FROM ca_hand_fact_revisions WHERE hand_id='30000000-0000-4000-8000-000000000002' AND kind='void') THEN
   RAISE EXCEPTION 'void was not retained/excluded';
 END IF;
END $$;
SELECT fixture_refuses('UPDATE ca_hand_fact_revisions SET source_reference=''x''');

GRANT USAGE ON SCHEMA public TO authenticated;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','40000000-0000-4000-8000-000000000001',false);
DO $$ BEGIN
 IF (SELECT count(*) FROM ca_own_hand_history_by_club(
      '10000000-0000-4000-8000-000000000001',NULL,50,0))<>1 THEN
   RAISE EXCEPTION 'authorized own-club history scope failed';
 END IF;
END $$;
SELECT fixture_refuses($q$SELECT ca_own_hand_history_by_club(
 '10000000-0000-4000-8000-000000000099',NULL,50,0)$q$,'42501');
SELECT set_config('request.jwt.claim.sub','40000000-0000-4000-8000-000000000099',false);
SELECT fixture_refuses($q$SELECT ca_own_hand_history_by_club(
 '10000000-0000-4000-8000-000000000001',NULL,50,0)$q$,'42501');
SELECT set_config('request.jwt.claim.sub','40000000-0000-4000-8000-000000000001',false);
RESET ROLE;
UPDATE clubs SET lifecycle_status='retired';
SET ROLE authenticated;
SELECT fixture_refuses($q$SELECT ca_own_hand_history_by_club(
 '10000000-0000-4000-8000-000000000001',NULL,50,0)$q$,'42501');
RESET ROLE;
UPDATE clubs SET lifecycle_status='active';
SET ROLE authenticated;
SELECT fixture_refuses($q$SELECT ca_project_hand_stats_facts('30000000-0000-4000-8000-000000000001')$q$,'42501');
SELECT fixture_refuses($q$SELECT ca_append_hand_fact_revision(
 '30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',
 'void',NULL,'no','50000000-0000-4000-8000-000000000003')$q$,'42501');
RESET ROLE;

DO $$ BEGIN
 IF position('ca_project_hand_stats_facts(v_h.id)' in
   (SELECT prosrc FROM pg_proc WHERE oid='public.fn_project_hand_side_effects_after_post_commit_20260908(uuid)'::regprocedure))=0 THEN
   RAISE EXCEPTION 'projector not wired';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conname='ca_hand_facts_hand_id_fkey') THEN
   RAISE EXCEPTION 'purge-incompatible fact FK remains';
 END IF;
END $$;

-- The supported history retention delete must not erase the indefinite fact
-- or its immutable projection proof. The scoped reader naturally returns no
-- replay once the replay source itself is gone.
DELETE FROM hand_history WHERE id='30000000-0000-4000-8000-000000000001';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM ca_hand_facts WHERE hand_id='30000000-0000-4000-8000-000000000001')
    OR NOT EXISTS(SELECT 1 FROM ca_hand_fact_projection_receipts WHERE hand_id='30000000-0000-4000-8000-000000000001') THEN
   RAISE EXCEPTION 'history prune erased retained Stats evidence';
 END IF;
END $$;
SELECT 'PASS: durable transactional facts, replay conflict, revision, void and grants';
