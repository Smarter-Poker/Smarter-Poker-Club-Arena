-- Original formation seats, exact anchor generations and classification.
DO $probe$
DECLARE r jsonb; baseline jsonb; BEGIN
 r:=pg_temp.lightning_roster_result();
 IF r->>'status' IS DISTINCT FROM 'captured' OR jsonb_array_length(r#>'{roster,actors}')<>7 THEN
  RAISE EXCEPTION 'LIGHTNING_ROSTER_CAPTURE_FAILED: %',r; END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r#>'{roster,actors}') a
 WHERE a->>'userId'='10000000-0000-0000-0000-000000000002' AND a->>'seat'='6'
 AND a->>'seatId'='88300000-0000-0000-0000-000000000002'
 AND a->>'classification'='horse' AND a->>'status'='canonical_boolean') THEN
  RAISE EXCEPTION 'LIGHTNING_ORIGINAL_HAND_POSITION_OR_CLASSIFICATION_LOST'; END IF;
 IF (SELECT count(DISTINCT a->>'seat') FROM jsonb_array_elements(r#>'{roster,actors}') a)<>7 THEN
  RAISE EXCEPTION 'LIGHTNING_PHYSICAL_CHAIRS_USED'; END IF;
 RAISE NOTICE 'LIGHTNING ROSTER PASS: original immutable seats differ from duplicate physical anchor chairs';
 -- An invalid marker cannot bless a roster. Refusals do not fail settlement.
 UPDATE public.lightning_settlement_marker SET hand_number=8800011 WHERE player_id='10000000-0000-0000-0000-000000000002';
 r:=pg_temp.lightning_roster_result();
 IF r->>'status'<>'unavailable' OR NOT (r->'reasons' ? 'lightning_seat_positions_unbound') THEN RAISE EXCEPTION 'LIGHTNING_MARKER_HAND_DRIFT_NOT_REFUSED'; END IF;
 UPDATE public.lightning_settlement_marker SET hand_number=8800010 WHERE player_id='10000000-0000-0000-0000-000000000002';
 UPDATE public.lightning_settlement_marker SET seat_id='88300000-0000-0000-0000-0000000000ff' WHERE player_id='10000000-0000-0000-0000-000000000002';
 r:=pg_temp.lightning_roster_result();
 IF r->>'status'<>'unavailable' OR NOT (r->'reasons' ? 'lightning_seat_positions_unbound') THEN RAISE EXCEPTION 'LIGHTNING_ANCHOR_DRIFT_NOT_REFUSED'; END IF;
 UPDATE public.lightning_settlement_marker SET seat_id='88300000-0000-0000-0000-000000000002' WHERE player_id='10000000-0000-0000-0000-000000000002';
 UPDATE public.lightning_settlement_marker SET txid='1'::xid8;
 r:=pg_temp.lightning_roster_result();
 IF r->>'status'<>'unavailable' OR NOT (r->'reasons' ? 'lightning_seat_positions_unbound') THEN RAISE EXCEPTION 'LIGHTNING_CROSS_TRANSACTION_MARKER_NOT_REFUSED'; END IF;
 RAISE NOTICE 'LIGHTNING ROSTER PASS: wrong hand, anchor and transaction markers stay unavailable';
 UPDATE public.lightning_settlement_marker SET txid=pg_current_xact_id();
 FOR baseline IN SELECT x FROM jsonb_array_elements('[[],null,{"10000000-0000-0000-0000-000000000001":"not-a-uuid"}]') x LOOP
  r:=pg_temp.lightning_roster_result(baseline);
  IF r->>'status' IS DISTINCT FROM 'unavailable' OR r->'roster'<>'null'::jsonb THEN
    RAISE EXCEPTION 'LIGHTNING_MALFORMED_MAP_NOT_UNAVAILABLE'; END IF;
 END LOOP;
 SELECT jsonb_object_agg(t.user_id::text,t.table_id) INTO baseline FROM public.table_seats t
 WHERE t.id IN(SELECT seat_id::uuid FROM pg_temp.roster_seats('exact'));
 r:=pg_temp.lightning_roster_result(jsonb_set(baseline,'{10000000-0000-0000-0000-000000000001}','"not-a-uuid"'));
 IF r->>'status' IS DISTINCT FROM 'unavailable' OR r->'roster'<>'null'::jsonb THEN
  RAISE EXCEPTION 'LIGHTNING_INVALID_UUID_MAP_NOT_UNAVAILABLE'; END IF;
 r:=pg_temp.lightning_roster_result(baseline-'10000000-0000-0000-0000-000000000001');
 IF r->>'status' IS DISTINCT FROM 'unavailable' OR r->'reasons'<>'["lightning_seat_positions_unbound"]'::jsonb THEN
  RAISE EXCEPTION 'LIGHTNING_PARTIAL_MAP_NOT_UNAVAILABLE'; END IF;
 RAISE NOTICE 'LIGHTNING ROSTER PASS: malformed, invalid UUID and partial maps return unavailable without aborting';
END $probe$;
