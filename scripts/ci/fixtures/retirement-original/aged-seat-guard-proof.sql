-- Runs inside the helper's real 57-restoration transaction.
-- The trigger probe is synthetic and calls the actual creation guard only.
CREATE TABLE retirement_native.seat_guard_probe (LIKE public.table_seats INCLUDING DEFAULTS);
CREATE TRIGGER retained_seat_guard_probe BEFORE INSERT OR UPDATE ON retirement_native.seat_guard_probe FOR EACH ROW EXECUTE FUNCTION public.fn_ca_guard_seat_creation();
SET LOCAL session_replication_role=replica;
UPDATE public.tournaments SET format_contract='sng-v1',max_players=2,starting_chips=1000 WHERE id=retirement_native.fixture_id(2,1);
SET LOCAL session_replication_role=origin;
INSERT INTO retirement_native.seat_guard_probe
SELECT (jsonb_populate_record(NULL::retirement_native.seat_guard_probe,to_jsonb(s)||(e->'seat'))).* FROM public.table_seats s
JOIN smarter_private.retirement_original_hand_qualification c ON c.table_id=s.table_id
CROSS JOIN LATERAL jsonb_array_elements(c.expected->'rows') e
WHERE c.submission_id=retirement_native.fixture_id(3,1) AND s.id=(e->'seat'->>'id')::uuid;
SET LOCAL request.jwt.claim.role='';
SET LOCAL request.jwt.claims='{}';
SET LOCAL app.money_path='fn_assign_tournament_player_seat_atomic';
DO $$DECLARE denied boolean:=false;BEGIN
PERFORM retirement_native.assert_true(auth.role() IS NULL,'guard NULL-role probe actually has unknown role');
BEGIN UPDATE retirement_native.seat_guard_probe SET left_at=NULL,status='active';EXCEPTION WHEN check_violation THEN denied:=SQLERRM LIKE 'SEAT_FIRST_STACK_MUST_EQUAL_STARTING_CHIPS:%';END;
PERFORM retirement_native.assert_true(denied,'unknown role cannot skip original starting-stack refusal');
END$$;
SET LOCAL request.jwt.claim.role='service_role';
SET LOCAL request.jwt.claims='{"role":"service_role"}';
DO $$DECLARE denied boolean:=false;BEGIN
BEGIN UPDATE retirement_native.seat_guard_probe SET left_at=NULL,status='active',occupancy_id=retirement_native.fixture_id(9,999);EXCEPTION WHEN check_violation THEN denied:=SQLERRM LIKE 'SEAT_FIRST_STACK_MUST_EQUAL_STARTING_CHIPS:%';END;
PERFORM retirement_native.assert_true(denied,'foreign occupancy cannot borrow original private capability');
denied:=false;
BEGIN UPDATE retirement_native.seat_guard_probe SET left_at=NULL,status='active',joined_at=joined_at+interval '1 second';EXCEPTION WHEN check_violation THEN denied:=SQLERRM LIKE 'SEAT_FIRST_STACK_MUST_EQUAL_STARTING_CHIPS:%';END;
PERFORM retirement_native.assert_true(denied,'foreign joined generation cannot borrow original capability');
denied:=false;
BEGIN INSERT INTO retirement_native.seat_guard_probe SELECT (jsonb_populate_record(NULL::retirement_native.seat_guard_probe,to_jsonb(s)||jsonb_build_object('id',retirement_native.fixture_id(8,999),'left_at',NULL,'status','active'))).* FROM retirement_native.seat_guard_probe s;EXCEPTION WHEN check_violation THEN denied:=SQLERRM LIKE 'SEAT_FIRST_STACK_MUST_EQUAL_STARTING_CHIPS:%';END;
PERFORM retirement_native.assert_true(denied,'a newly inserted seat cannot borrow original capability');
END$$;
SET LOCAL session_replication_role=replica;
UPDATE smarter_private.retirement_original_hand_restorations SET transaction_id=txid_current()+1 WHERE submission_id=retirement_native.fixture_id(3,1);
SET LOCAL session_replication_role=origin;
DO $$DECLARE denied boolean:=false;BEGIN
BEGIN UPDATE retirement_native.seat_guard_probe SET left_at=NULL,status='active';EXCEPTION WHEN check_violation THEN denied:=SQLERRM LIKE 'SEAT_FIRST_STACK_MUST_EQUAL_STARTING_CHIPS:%';END;
PERFORM retirement_native.assert_true(denied,'receipt from a different transaction cannot revive original seat');
END$$;
SET LOCAL session_replication_role=replica;
UPDATE smarter_private.retirement_original_hand_restorations SET transaction_id=txid_current() WHERE submission_id=retirement_native.fixture_id(3,1);
SET LOCAL session_replication_role=origin;
UPDATE retirement_native.seat_guard_probe SET left_at=NULL,status='active';
SELECT retirement_native.assert_true((SELECT count(*)=1 AND bool_and(stack=100 AND left_at IS NULL) FROM retirement_native.seat_guard_probe),'same-tx original aged paid stack is admitted unchanged by actual guard');
