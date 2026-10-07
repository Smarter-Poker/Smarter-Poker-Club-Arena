-- The original whole rebuy transaction chooses a fresh chair after capturing funding.
-- A never-dealt table may prove that original paid generation from its immutable
-- atomic purchase result, exact rebought candidate and settled zero-stack hand.
-- No purchase, seat, hand, wallet or profile is rewritten or replayed here.
BEGIN;
SET LOCAL lock_timeout='500ms';
SET LOCAL statement_timeout='10s';
DO $pre$ BEGIN
IF md5(pg_get_functiondef('smarter_private.f06_movement_never_dealt_prior(uuid,uuid,uuid)'::regprocedure))<>'433debf7038257e4c8f0e3dfb9bb4a7d' THEN
RAISE EXCEPTION 'F06_NEVER_DEALT_REBUY_PREIMAGE_DRIFT'; END IF;
END $pre$;
CREATE OR REPLACE FUNCTION smarter_private.f06_movement_never_dealt_prior(p_tournament uuid, p_table uuid, p_break uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE o smarter_private.f06_operations; seat public.table_seats; registration public.tournament_players;
 fund public.tournament_participant_funding_receipts; roster jsonb:='[]'; entries jsonb:='[]'; n integer:=0; permits jsonb; entry_proven boolean; rebuy_proven boolean;
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
 SELECT * INTO fund FROM public.tournament_participant_funding_receipts f WHERE f.tournament_id=p_tournament AND f.registration_id=registration.id ORDER BY f.observed_at DESC,f.id DESC LIMIT 1;
 entry_proven:=NOT (seat.user_id IS NULL OR seat.occupancy_id IS NULL OR seat.stack IS NULL OR seat.stack<=0
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
 AND l.from_entity_id=registration.user_id));
 rebuy_proven:=false;
 IF entry_proven IS NOT TRUE THEN
 -- A fresh rebuy/re-entry is a new paid generation, not an arrival move.
 -- Its immutable original whole-transaction result names the chosen chair;
 -- the earlier funding snapshot deliberately precedes that assignment.
 SELECT EXISTS(
  SELECT 1 FROM public.entry_purchase_idempotency_receipts p
  JOIN public.tournament_knockout_candidates c ON c.id=(p.request->>'candidate_id')::uuid
  JOIN public.hand_atomic_commits a ON a.table_id=c.table_id AND a.hand_number=c.hand_number AND a.hand_id=c.hand_id
  JOIN public.chip_ledger l ON l.id=fund.ledger_id
  JOIN public.wallet_transactions w ON w.id=fund.wallet_transaction_id
  WHERE p.key_domain='tournament_chip_purchase' AND p.idempotency_key=fund.purchase_key
  AND fund.amount>0 AND fund.asset='chips'
  AND fund.operation IN ('rebuy','reentry') AND fund.user_id=seat.user_id AND fund.registration_id=registration.id
  AND seat.user_id IS NOT NULL AND seat.occupancy_id IS NOT NULL AND seat.stack>0 AND seat.stack=trunc(seat.stack)
  AND registration.status='playing' AND registration.eliminated_at IS NULL
  AND (registration.table_id,registration.seat_number) IS NOT DISTINCT FROM (seat.table_id,seat.seat_number)
  AND registration.chips::numeric=seat.stack
  AND fund.registration_snapshot->>'id'=registration.id::text
  AND fund.registration_snapshot->>'user_id'=seat.user_id::text
  AND fund.tournament_snapshot->>'id'=p_tournament::text
  AND jsonb_typeof(fund.registration_snapshot->'chips')='number'
  AND (fund.registration_snapshot->>'chips')::numeric=seat.stack
  AND COALESCE(NULLIF((fund.tournament_snapshot->>'rebuy_chips')::numeric,0),(fund.tournament_snapshot->>'starting_chips')::numeric)=seat.stack
  AND p.request->>'version'='v1' AND p.request->>'user_id'=seat.user_id::text
  AND p.request->>'tournament_id'=p_tournament::text AND p.request->>'rebuy_type'=fund.operation
  AND p.request->>'idempotency_key'=fund.purchase_key
  AND p.response->'success'='true'::jsonb AND p.response->'seated'='true'::jsonb
  AND p.response->>'atomic_tournament_chip_purchase'='v1'
  AND p.response->>'rebuy_type'=fund.operation AND p.response->>'candidate_id'=c.id::text
  AND p.response->>'candidate_state'='rebought'
  AND p.response->>'table_id'=p_table::text AND p.response->>'seat_id'=seat.id::text
  AND (p.response->>'seat_number')::integer=seat.seat_number AND (p.response->>'stack')::numeric=seat.stack
  AND (p.response->>'new_stack')::numeric=seat.stack AND (p.response->>'chips_added')::numeric=seat.stack
  AND (p.response->>'cost')::numeric=fund.amount
  AND p.claimed_at IS NOT NULL AND p.completed_at IS NOT NULL AND p.completed_at>=p.claimed_at
  AND c.tournament_id=p_tournament AND c.eliminated_user_id=seat.user_id AND c.state='rebought'
  AND c.stack_after=0 AND c.resolved_at IS NOT NULL
  AND c.resolved_at>=fund.observed_at AND seat.joined_at>=c.resolved_at AND seat.joined_at<o.created_at
  AND a.post_commit_completed_at IS NOT NULL AND a.post_commit_result->'ok'='true'::jsonb
  AND a.post_commit_completed_at<=fund.observed_at
  AND a.stack_result->'conservation_checked'='true'::jsonb
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(a.stack_result->'request'->'stacks') x
   WHERE x->>'user_id'=seat.user_id::text AND x->>'seat_id'=c.seat_id::text
   AND (x->>'seat_joined_at')::timestamptz=c.seat_joined_at AND (x->>'stack')::numeric=0)
  AND to_jsonb(l)=fund.ledger_snapshot AND l.status='posted' AND l.category=fund.operation
  AND l.from_entity_id=seat.user_id AND l.tournament_id=p_tournament
  AND l.amount=fund.amount AND l.to_entity_id=p_tournament AND l.club_id=fund.funding_club_id
  AND to_jsonb(w)=fund.wallet_snapshot AND w.user_id=seat.user_id AND w.type='debit'
  AND w.category=fund.operation AND w.related_entity_id=p_tournament AND w.amount=fund.amount
  AND NOT EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts later
   WHERE later.tournament_id=p_tournament AND later.user_id=seat.user_id AND later.observed_at>fund.observed_at)
  AND NOT EXISTS(SELECT 1 FROM public.ca_seat_stack_exits x WHERE x.table_id=p_table AND x.user_id=seat.user_id AND x.occurred_at>=p.claimed_at)
 ) INTO rebuy_proven;
 END IF;
 IF entry_proven IS NOT TRUE AND rebuy_proven IS NOT TRUE THEN
 RAISE EXCEPTION 'F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN' USING ERRCODE='55000'; END IF;
 n:=n+1;
 roster:=roster||jsonb_build_array(jsonb_build_object('seat',to_jsonb(seat),'registration',to_jsonb(registration)));
 entries:=entries||jsonb_build_array(jsonb_build_object('receipt_id',fund.id,'registration_id',fund.registration_id,'user_id',fund.user_id,
 'operation',fund.operation,'observed_at',fund.observed_at,'starting_chips',fund.tournament_snapshot->'starting_chips','chips',fund.registration_snapshot->'chips')||CASE WHEN rebuy_proven THEN jsonb_build_object('atomic_purchase',fund.purchase_key) ELSE '{}'::jsonb END);
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

ALTER FUNCTION smarter_private.f06_movement_never_dealt_prior(uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_movement_never_dealt_prior(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
-- @live-proof: never_dealt_rebuy_original_generation
-- SELECT count(*) FROM pg_proc p WHERE p.oid=to_regprocedure('smarter_private.f06_movement_never_dealt_prior(uuid,uuid,uuid)') AND md5(pg_get_functiondef(p.oid))='5f81993352981f9991b43c9a4d6dbaeb' AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']::text[] AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AND NOT has_function_privilege('service_role',p.oid,'EXECUTE');
DO $post$ BEGIN
IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='smarter_private.f06_movement_never_dealt_prior(uuid,uuid,uuid)'::regprocedure AND md5(pg_get_functiondef(p.oid))='5f81993352981f9991b43c9a4d6dbaeb' AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']::text[] AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AND NOT has_function_privilege('service_role',p.oid,'EXECUTE')) THEN RAISE EXCEPTION 'F06_NEVER_DEALT_REBUY_POSTIMAGE_DRIFT';END IF;
END $post$;
COMMIT;
