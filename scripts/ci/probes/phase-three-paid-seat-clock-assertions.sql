
DO $paid_clock_assertions$
DECLARE seconds numeric;
BEGIN
 SELECT (value->>'effective_frozen_seconds')::numeric INTO STRICT seconds
 FROM ca09_evidence WHERE kind='actual_v3_thaw';
 IF (SELECT count(*) FROM ca09_paid_seat_before)<>1
 OR EXISTS(SELECT 1 FROM ca09_paid_seat_before b LEFT JOIN public.table_seats s USING(id)
 WHERE s.id IS NULL OR to_jsonb(s)-'sit_out_at' IS DISTINCT FROM b.unchanged_fields
 OR s.sit_out_at IS DISTINCT FROM b.sit_out_at+make_interval(secs=>seconds))
 THEN RAISE EXCEPTION 'CA09 paid seat clock, stack, timebank, identity or status changed incorrectly'; END IF;
 INSERT INTO ca09_evidence VALUES('actual_paid_seat',jsonb_build_object(
 'actual_creator_and_authenticated_paid_entry',true,'cost',1,'stack',1000,
 'sit_out_credited_exactly_once',true,'all_other_seat_fields_unchanged',true,
 'checked_after_receipt_replay_and_release',true,'fixture_guards_enabled',true));
END $paid_clock_assertions$;
