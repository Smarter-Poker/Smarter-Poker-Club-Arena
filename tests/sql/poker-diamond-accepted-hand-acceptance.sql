SELECT fixture_assert((SELECT count(*)=1 FROM hand_history) AND (SELECT count(*)=1 FROM hand_atomic_commits)
 AND (SELECT count(*)=1 FROM hand_projection_outbox),'one canonical hand atomic receipt and durable projection');
SELECT fixture_assert((SELECT bool_and(time_bank_uses_remaining=2 AND time_bank_remaining=20) FROM table_seats),
 'time banks commit with exact funded occupancy');
SELECT fixture_assert((SELECT sum(balance)=600 FROM poker_diamond_custody WHERE state='active')
 AND (SELECT stack=250 FROM table_seats WHERE seat_number=1) AND (SELECT stack=350 FROM table_seats WHERE seat_number=2),
 'accepted hand conserves custody and exact seat stacks');
SELECT fixture_assert((SELECT consumed=50 AND arena_reserved=250 FROM diamond_purchase_lots WHERE user_id='10000000-0000-0000-0000-000000000001'),
 'accepted hand consumes only actual purchased losses');
SELECT fixture_assert((SELECT post_commit_payload->'promo_playthrough'='[]'::jsonb
 AND post_commit_payload->'pending_addons'='null'::jsonb
 AND post_commit_request_hash IS NOT NULL AND post_commit_payload_hash IS NOT NULL FROM hand_atomic_commits),
 'receipt preserves canonical empty financial envelope');
-- Projection failure must roll back its processor receipt and index writes.
CREATE FUNCTION fixture_projection_failure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'fixture_projection_failure'; END $$;
CREATE TRIGGER fixture_projection_failure BEFORE INSERT ON ca_hand_player_stat FOR EACH ROW EXECUTE FUNCTION fixture_projection_failure();
SELECT fixture_refuses($q$SELECT fn_project_hand_side_effects(hand_id) FROM hand_atomic_commits$q$,'fixture_projection_failure');
SELECT fixture_assert((SELECT post_commit_completed_at IS NULL FROM hand_atomic_commits)
 AND (SELECT count(*)=0 FROM ca_hand_player_idx) AND (SELECT count(*)=1 FROM hand_projection_outbox),
 'projection failure retains outbox and rolls back partial index and completion receipt');
DROP TRIGGER fixture_projection_failure ON ca_hand_player_stat;
SELECT fixture_assert((SELECT fn_project_hand_side_effects(hand_id)->>'ok'='true' FROM hand_atomic_commits),
 'real ordered projection completes Diamond history');
SELECT fixture_assert((SELECT count(*)=2 FROM ca_hand_player_idx) AND (SELECT count(*)=2 FROM ca_hand_player_stat)
 AND (SELECT count(*)=0 FROM hand_projection_outbox),'both players retain exact history index and facts');
SELECT fixture_assert((SELECT post_commit_completed_at IS NOT NULL
 AND post_commit_result->>'promo_playthrough'='0' AND post_commit_result->>'pending_addons'='0'
 FROM hand_atomic_commits),'post-commit completion records zero chip operations');
SELECT fixture_assert((SELECT fn_project_hand_side_effects(hand_id)->>'reason'='not_pending' FROM hand_atomic_commits)
 AND (SELECT fn_ca_process_hand_post_commit_obligations(hand_id)->>'already_completed'='true' FROM hand_atomic_commits),
 'recovery replay cannot repeat additive projection');
DO $$ DECLARE before_state jsonb; BEGIN
 before_state:=fixture_accepted_state();
 PERFORM fixture_assert(fixture_accept()->>'replay'='true','response-loss replay uses immutable accepted receipt');
 PERFORM fixture_assert(fixture_accepted_state()=before_state,'accepted replay changes no accounting or time banks');
END $$;
SELECT fixture_refuses($q$SELECT fixture_accept(jsonb_build_object('obligations',
 jsonb_set(obligations,'{time_banks,0,seconds_remaining}','19'))) FROM fixture_accepted_payload$q$,'post_commit_payload_conflict');
SELECT fixture_assert(NOT has_function_privilege('authenticated',
 'fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)','EXECUTE'),
 'browser cannot accept a funded hand');
