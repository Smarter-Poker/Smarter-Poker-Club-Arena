 -- Missing storage is never a claim that this hand did not start. The original
 -- ended dispatch/refusal and prior accepted stack boundary remain mandatory.
 IF snapshot_absent_spin THEN
 IF event.format_contract IS DISTINCT FROM 'spin-v1' OR jsonb_array_length(roster)<>3
 OR retired_dispatch IS NULL
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=h.table_id AND hand_number>=h.hand_number) THEN
 RAISE EXCEPTION 'F06_SPIN_ABSENT_SNAPSHOT_CHANGED' USING ERRCODE='55000'; END IF;
 PERFORM 1 FROM public.table_hole_cards WHERE table_id=h.table_id AND hand_number=h.hand_number ORDER BY id FOR SHARE;
 IF (SELECT count(*) FROM public.table_hole_cards WHERE table_id=h.table_id AND hand_number=h.hand_number)<>3
 OR (SELECT count(DISTINCT user_id) FROM public.table_hole_cards WHERE table_id=h.table_id AND hand_number=h.hand_number)<>3
 OR (SELECT count(DISTINCT seat_number) FROM public.table_hole_cards WHERE table_id=h.table_id AND hand_number=h.hand_number)<>3
 OR EXISTS(SELECT 1 FROM public.table_hole_cards c WHERE c.table_id=h.table_id AND c.hand_number=h.hand_number
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(roster) r
 WHERE r->>'user_id'=c.user_id::text AND (r->>'seat_number')::integer=c.seat_number)) THEN
 RAISE EXCEPTION 'F06_SPIN_ABSENT_CARDS_CHANGED' USING ERRCODE='55000'; END IF;
 END IF;
