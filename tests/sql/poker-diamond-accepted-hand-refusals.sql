SELECT fixture_assert(fixture_accept('{}','70000000-0000-0000-0000-000000000009')->>'reason'='hand_lease_lost','wrong lease cannot accept a Diamond hand');
BEGIN;
UPDATE engine_table_leases SET heartbeat_at=now()-interval '1 minute';
SELECT fixture_assert(fixture_accept()->>'reason'='hand_lease_stale','expired lease cannot accept a Diamond hand');
ROLLBACK;
SELECT fixture_refuses($q$SELECT fixture_accept(jsonb_build_object('obligations',
 jsonb_set(obligations,'{promo_playthrough}',jsonb_build_array(jsonb_build_object(
 'club_id','20000000-0000-0000-0000-000000000001','user_id','10000000-0000-0000-0000-000000000001','wagered',50)))))
 FROM fixture_accepted_payload$q$,'diamond');
SELECT fixture_refuses($q$SELECT fixture_accept(jsonb_build_object('hand_row',
 jsonb_set(hand_row,'{pot_size}','100.5'))) FROM fixture_accepted_payload$q$,'diamond');
SELECT fixture_refuses($q$SELECT fixture_accept(jsonb_build_object('obligations',
 jsonb_set(obligations,'{time_banks,0,seat_joined_at}','"2026-09-09T00:00:00Z"')))
 FROM fixture_accepted_payload$q$,'time_bank_seat_generation_mismatch');
CREATE FUNCTION fixture_history_failure() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'fixture_history_write_failure'; END $$;
CREATE TRIGGER fixture_history_failure BEFORE INSERT ON hand_history FOR EACH ROW EXECUTE FUNCTION fixture_history_failure();
DO $$ DECLARE before_state jsonb; r jsonb;
BEGIN
 before_state:=fixture_accepted_state(); r:=fixture_accept();
 PERFORM fixture_assert(r->>'reason'='atomic_hand_rolled_back' AND r->>'error'='fixture_history_write_failure',
 'history failure is an atomic refusal');
 PERFORM fixture_assert(fixture_accepted_state()=before_state,'history failure rolls back custody seats lots and receipts');
END $$;
DROP TRIGGER fixture_history_failure ON hand_history;
-- Failure after the nested core has returned must still roll it all back.
CREATE FUNCTION fixture_timebank_failure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.time_bank_remaining IS DISTINCT FROM OLD.time_bank_remaining THEN
 RAISE EXCEPTION 'fixture_timebank_write_failure'; END IF; RETURN NEW; END $$;
CREATE TRIGGER fixture_timebank_failure BEFORE UPDATE ON table_seats FOR EACH ROW EXECUTE FUNCTION fixture_timebank_failure();
DO $$ DECLARE before_state jsonb; BEGIN
 before_state:=fixture_accepted_state();
 PERFORM fixture_refuses('SELECT fixture_accept()','fixture_timebank_write_failure');
 PERFORM fixture_assert(fixture_accepted_state()=before_state,'outer time-bank failure rolls back already settled core');
END $$;
DROP TRIGGER fixture_timebank_failure ON table_seats;
UPDATE engine_table_leases SET heartbeat_at=clock_timestamp();

SELECT fixture_refuses($q$SELECT fixture_accept(jsonb_build_object('hand_row',
 jsonb_set(hand_row,'{daily_mission_events}','[{"user_id":"10000000-0000-0000-0000-000000000001","amounts":{"hands":1}}]')))
 FROM fixture_accepted_payload$q$,'diamond');
SELECT fixture_refuses($q$SELECT fixture_accept('{"units":[{"amount":1}]}')$q$,'diamond');
