CREATE OR REPLACE FUNCTION smarter_private.f06_movement_never_dealt_prior(p_tournament uuid, p_table uuid, p_break uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE o smarter_private.f06_operations; seat public.table_seats; registration public.tournament_players;
 fund public.tournament_participant_funding_receipts; roster jsonb:='[]'; entries jsonb:='[]'; n integer:=0; permits jsonb;
BEGIN
 -- Called only by f06_movement_prior, for the one open break of this table's
 -- current lifecycle, when the table has no committed hand. A park of a table
 -- that never dealt has no sealed hand to prove its boundary from: the
 -- boundary is its seated entries, each holding exactly what its entry grants.
 SELECT op.* INTO o FROM smarter_private.f06_operations op JOIN public.tables t ON t.id=op.source_table_id AND t.f06_lifecycle=op.lifecycle
 WHERE op.break_id=p_break AND op.tournament_id=p_tournament AND op.source_table_id=p_table AND t.tournament_id=p_tournament;
 IF NOT FOUND OR o.state IS DISTINCT FROM 'park_requested' OR o.manifest IS NOT NULL
 OR (SELECT count(*) FROM smarter_private.f06_operations WHERE tournament_id=p_tournament AND source_table_id=p_table AND state IN ('park_requested','begun'))<>1 THEN
 RAISE EXCEPTION 'F06_MOVEMENT_PRIOR_INCOMPLETE' USING ERRCODE='55000'; END IF;
 -- Never dealt: no hand of any number was committed, recorded, held
 -- privately, dealt, snapshotted or permitted on this table.
 IF EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=p_table)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=p_table)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=p_table)
 OR EXISTS(SELECT 1 FROM public.table_hole_cards WHERE table_id=p_table)
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=p_table)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=p_table) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_PRIOR_INCOMPLETE' USING ERRCODE='55000'; END IF;
 -- Every occupied chair holds a playing registration of this event on exactly
 -- this chair, whose chips are the chair's stack and are exactly what its one
 -- durable funding receipt, an entry, granted: no rebuy, re-entry or add-on
 -- (receipt, registration counter or ledger leg), no elimination.
 FOR seat IN SELECT st.* FROM public.table_seats st WHERE st.table_id=p_table AND st.left_at IS NULL ORDER BY st.user_id,st.id FOR UPDATE LOOP
 SELECT * INTO registration FROM public.tournament_players WHERE tournament_id=p_tournament AND user_id=seat.user_id FOR UPDATE;
 SELECT * INTO fund FROM public.tournament_participant_funding_receipts f WHERE f.tournament_id=p_tournament AND f.registration_id=registration.id;
 IF seat.user_id IS NULL OR seat.occupancy_id IS NULL OR seat.stack IS NULL OR seat.stack<=0
 OR registration.id IS NULL OR registration.status IS DISTINCT FROM 'playing' OR registration.eliminated_at IS NOT NULL
 OR (registration.table_id,registration.seat_number) IS DISTINCT FROM (seat.table_id,seat.seat_number)
 OR registration.chips::numeric IS DISTINCT FROM seat.stack
 OR COALESCE(registration.rebuys,0)<>0 OR COALESCE(registration.add_on,false)
 OR fund.id IS NULL OR fund.operation IS DISTINCT FROM 'entry' OR fund.user_id IS DISTINCT FROM registration.user_id
 OR fund.tournament_snapshot->>'id' IS DISTINCT FROM p_tournament::text
 OR fund.registration_snapshot->>'id' IS DISTINCT FROM registration.id::text
 OR jsonb_typeof(fund.tournament_snapshot->'starting_chips') IS DISTINCT FROM 'number'
 OR jsonb_typeof(fund.registration_snapshot->'chips') IS DISTINCT FROM 'number'
 OR (fund.tournament_snapshot->>'starting_chips')::numeric IS DISTINCT FROM seat.stack
 OR (fund.registration_snapshot->>'chips')::numeric IS DISTINCT FROM seat.stack
 OR (SELECT count(*) FROM public.tournament_participant_funding_receipts f WHERE f.tournament_id=p_tournament
 AND (f.registration_id=registration.id OR f.user_id=registration.user_id))<>1
 OR EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.tournament_id=p_tournament AND l.category IN ('rebuy','addon')
 AND l.from_entity_id=registration.user_id) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN' USING ERRCODE='55000'; END IF;
 n:=n+1;
 roster:=roster||jsonb_build_array(jsonb_build_object('seat',to_jsonb(seat),'registration',to_jsonb(registration)));
 entries:=entries||jsonb_build_array(jsonb_build_object('receipt_id',fund.id,'registration_id',fund.registration_id,'user_id',fund.user_id,
 'operation',fund.operation,'observed_at',fund.observed_at,'starting_chips',fund.tournament_snapshot->'starting_chips','chips',fund.registration_snapshot->'chips'));
 END LOOP;
 IF n NOT BETWEEN 1 AND 10
 OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=p_tournament AND table_id=p_table AND status IN ('playing','registered'))<>n THEN
 RAISE EXCEPTION 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED' USING ERRCODE='55000'; END IF;
 permits:=smarter_private.f06_movement_permits(p_tournament,p_table,NULL);
 IF permits IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'F06_MOVEMENT_PRIOR_INCOMPLETE' USING ERRCODE='55000'; END IF;
 -- No hand: 'atomic' and 'history' are JSON null and 'first_hand' is true, as
 -- fn_f06_continue_no_start_last_table reports a first hand. The roster entries
 -- have the park shape f06_assert_movement compares.
 RETURN jsonb_build_object('atomic',NULL::jsonb,'history',NULL::jsonb,'roster',roster,'eliminated','[]'::jsonb,'permits',permits,'first_hand',true,
 'receipts',jsonb_build_object('break_id',o.break_id,'state',o.state,'lifecycle',o.lifecycle,'never_dealt',true,'entries',entries));
END $function$;
