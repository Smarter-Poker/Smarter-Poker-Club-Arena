-- Exact original-seat continuation, not a new paid entry.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $before$
BEGIN
 IF md5(pg_get_functiondef('public.fn_ca_guard_seat_creation()'::regprocedure)) IS DISTINCT FROM 'b3e14f411d43b01e84fd614c87f8bf6a'
 OR md5(pg_get_functiondef('smarter_private.restore_retired_original_tournament_hand(uuid,text,uuid)'::regprocedure)) IS DISTINCT FROM 'd9201d7507320a4f20cdfd98293d25f8' THEN
  RAISE EXCEPTION 'RETAINED_SEAT_CONTINUATION_PREIMAGE_CHANGED' USING ERRCODE='55000';
 END IF;
END $before$;
CREATE OR REPLACE FUNCTION smarter_private.restore_retired_original_tournament_hand(p_submission_id uuid, p_instance_id text, p_lease_generation uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE c smarter_private.retirement_original_hand_qualification;
 s smarter_private.hand_submissions; permit smarter_private.f06_hand_permits;
 item jsonb; stack_item jsonb; roster public.tournament_players; seat public.table_seats;
 projected jsonb; lease public.engine_tournament_leases; n integer:=0;
BEGIN
 SELECT * INTO c FROM smarter_private.retirement_original_hand_qualification
 WHERE submission_id=p_submission_id;
 IF NOT FOUND THEN RETURN false; END IF;
 IF auth.role() IS DISTINCT FROM 'service_role' OR p_instance_id IS NULL OR p_lease_generation IS NULL THEN
  RAISE EXCEPTION 'RETIREMENT_ORIGINAL_ENGINE_SUCCESSOR_REQUIRED' USING ERRCODE='42501';
 END IF;
 -- The caller acquires the existing rolling authority before its F06 prefix.
 -- Re-entry here cannot grant an unproven original generation a financial door.
 PERFORM public.fn_ca_lock_settlement_lane_for_tournament(c.tournament_id,c.table_id);
 SELECT * INTO lease FROM public.engine_tournament_leases WHERE tournament_id=c.tournament_id FOR KEY SHARE;
 IF lease.instance_id IS DISTINCT FROM p_instance_id OR lease.lease_generation IS DISTINCT FROM p_lease_generation
 OR lease.protocol_version IS DISTINCT FROM 2 OR lease.heartbeat_at IS NULL
 OR lease.heartbeat_at<clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds())
 OR public.fn_platform_frozen() THEN
  RAISE EXCEPTION 'RETIREMENT_ORIGINAL_LEASE_UNPROVEN' USING ERRCODE='55000';
 END IF;
 SELECT * INTO s FROM smarter_private.hand_submissions
 WHERE submission_id=c.submission_id FOR UPDATE;
 IF s.submission_id IS NULL OR s.request_hash IS DISTINCT FROM c.request_hash
 OR (s.table_id,s.hand_number) IS DISTINCT FROM (c.table_id,c.hand_number)
 OR s.lease_generation=p_lease_generation THEN
  RAISE EXCEPTION 'RETIREMENT_ORIGINAL_REQUEST_CHANGED' USING ERRCODE='55000';
 END IF;
 SELECT * INTO permit FROM smarter_private.f06_hand_permits
 WHERE table_id=c.table_id AND hand_number=c.hand_number FOR UPDATE;
 IF permit.permit_id IS NULL OR permit.state IS DISTINCT FROM 'reserved'
 OR permit.tournament_id IS DISTINCT FROM c.tournament_id OR permit.generation IS DISTINCT FROM s.lease_generation
 OR NOT EXISTS(SELECT 1 FROM public.tables t WHERE t.id=c.table_id AND t.tournament_id=c.tournament_id
   AND NOT coalesce(t.is_deleted,false) AND lower(t.status) IN('waiting','running') AND t.lifecycle IS NULL)
 OR NOT EXISTS(SELECT 1 FROM public.tournaments t WHERE t.id=c.tournament_id AND t.status='RUNNING')
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits a WHERE a.table_id=c.table_id AND a.hand_number>=c.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history h WHERE h.table_id=c.table_id AND h.hand_number>=c.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits p WHERE p.table_id=c.table_id AND p.hand_number>c.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs h WHERE h.submission_id=c.submission_id)
 OR EXISTS(SELECT 1 FROM smarter_private.retirement_original_hand_restorations r WHERE r.submission_id=c.submission_id) THEN
  RAISE EXCEPTION 'RETIREMENT_ORIGINAL_HAND_ALREADY_CONSUMED_OR_SCOPE_CHANGED' USING ERRCODE='55000';
 END IF;
 -- Every dealt player's before-stack and exact seat must still be held.
 -- The 101 unaffected players require ordinary live/playing ownership.
 FOR stack_item IN SELECT value FROM jsonb_array_elements(s.request->'p_stacks') LOOP
  SELECT * INTO roster FROM public.tournament_players
   WHERE tournament_id=c.tournament_id AND user_id=(stack_item->>'user_id')::uuid FOR UPDATE;
  SELECT * INTO seat FROM public.table_seats WHERE id=(stack_item->>'seat_id')::uuid FOR UPDATE;
  IF roster.id IS NULL OR roster.chips::numeric IS DISTINCT FROM (stack_item->>'stack_before')::numeric
  OR seat.id IS NULL OR seat.table_id IS DISTINCT FROM c.table_id
  OR seat.user_id IS DISTINCT FROM (stack_item->>'user_id')::uuid
  OR seat.joined_at IS DISTINCT FROM (stack_item->>'seat_joined_at')::timestamptz
  OR seat.stack IS DISTINCT FROM (stack_item->>'stack_before')::numeric THEN
   RAISE EXCEPTION 'RETIREMENT_ORIGINAL_DEALT_CUSTODY_CHANGED' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.expected->'rows')x WHERE x->>'user_id'=stack_item->>'user_id')
   AND (roster.status IS DISTINCT FROM 'playing' OR seat.left_at IS NOT NULL) THEN
   RAISE EXCEPTION 'RETIREMENT_ORIGINAL_UNQUALIFIED_PLAYER_CHANGED' USING ERRCODE='55000';
  END IF;
 END LOOP;
 -- Validate ALL qualified post-images before changing the first row.
 FOR item IN SELECT value FROM jsonb_array_elements(c.expected->'rows') ORDER BY value->>'user_id' LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.request->'p_stacks')x WHERE x=item->'stack') THEN
   RAISE EXCEPTION 'RETIREMENT_ORIGINAL_PAYLOAD_PLAYER_CHANGED' USING ERRCODE='55000';
  END IF;
  SELECT * INTO roster FROM public.tournament_players WHERE id=(item#>>'{roster,id}')::uuid FOR UPDATE;
  SELECT * INTO seat FROM public.table_seats WHERE id=(item#>>'{seat,id}')::uuid FOR UPDATE;
  SELECT jsonb_object_agg(key,value) INTO projected FROM jsonb_each(to_jsonb(roster))
   WHERE key=ANY(ARRAY['id','user_id','tournament_id','status','chips','position','prize','table_id','seat_number','rebuys','add_on','eliminated_at','current_bounty','bounty_winnings','bounties_collected','rebuy_prompt_until','elimination_sequence']);
  IF projected IS DISTINCT FROM item->'roster' THEN
   RAISE EXCEPTION 'RETIREMENT_ORIGINAL_ROSTER_POSTIMAGE_CHANGED' USING ERRCODE='55000';
  END IF;
  SELECT jsonb_object_agg(key,value) INTO projected FROM jsonb_each(to_jsonb(seat))
   WHERE key=ANY(ARRAY['id','table_id','user_id','club_id','seat_number','joined_at','occupancy_id','stack','left_at','status','is_sitting_out','is_away','leave_pending','active_game_scope','active_parent_key']);
  IF projected IS DISTINCT FROM item->'seat'
  OR roster.status IS DISTINCT FROM 'eliminated' OR roster.chips<=0
  OR roster.position IS NOT NULL OR coalesce(roster.prize,0)<>0
  OR roster.eliminated_at NOT BETWEEN '2026-10-06 15:33:04Z'::timestamptz AND '2026-10-06 15:33:08Z'::timestamptz
  OR seat.left_at NOT BETWEEN '2026-10-06 15:33:04Z'::timestamptz AND '2026-10-06 15:33:08Z'::timestamptz
  OR NOT EXISTS(SELECT 1 FROM smarter_private.patterned_identity_retirements r JOIN public.profiles p ON p.id=r.old_id
    WHERE r.old_id=roster.user_id AND r.cohort='horse' AND r.retired_at IS NOT NULL
      AND r.replacement_horse_id IS NULL AND p.status='deleted' AND p.horse_status='disabled')
  OR EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts f
    WHERE f.tournament_id=c.tournament_id AND f.user_id=roster.user_id
      AND f.observed_at>=(s.request#>>'{p_hand_row,started_at}')::timestamptz)
  OR EXISTS(SELECT 1 FROM public.tournament_payouts p WHERE p.tournament_id=c.tournament_id AND p.user_id=roster.user_id)
  OR EXISTS(SELECT 1 FROM public.tournament_seat_move_receipts m
    WHERE m.tournament_id=c.tournament_id AND m.user_id=roster.user_id AND m.moved_at>=roster.eliminated_at) THEN
   RAISE EXCEPTION 'RETIREMENT_ORIGINAL_POSTIMAGE_OR_OWNERSHIP_CHANGED' USING ERRCODE='55000';
  END IF;
 END LOOP;
 INSERT INTO smarter_private.retirement_original_hand_restorations
 (submission_id,original_generation,successor_generation,instance_id,request_hash,qualification_hash,transaction_id,restored_players)
 VALUES(c.submission_id,s.lease_generation,p_lease_generation,p_instance_id,c.request_hash,md5(c.expected::text),txid_current(),jsonb_array_length(c.expected->'rows'));
 FOR item IN SELECT value FROM jsonb_array_elements(c.expected->'rows') ORDER BY value->>'user_id' LOOP
  UPDATE public.tournament_players SET status='playing',eliminated_at=NULL
   WHERE id=(item#>>'{roster,id}')::uuid;
  UPDATE public.table_seats SET left_at=NULL,status='active'
   WHERE id=(item#>>'{seat,id}')::uuid;
  n:=n+1;
 END LOOP;

 RETURN true;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_guard_seat_creation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_path text;
  v_creating boolean;
  v_tournament_id uuid;
  v_variant text;
  v_max_players integer;
  v_starting_chips numeric;
BEGIN
  v_creating := (TG_OP = 'INSERT' AND NEW.left_at IS NULL)
             OR (TG_OP = 'UPDATE' AND OLD.left_at IS NOT NULL AND NEW.left_at IS NULL);
  IF NOT v_creating THEN
    RETURN NEW;
  END IF;

  SELECT tb.tournament_id, t.variant, t.max_players, t.starting_chips
    INTO v_tournament_id, v_variant, v_max_players, v_starting_chips
    FROM public.tables tb
    LEFT JOIN public.tournaments t ON t.id = tb.tournament_id
   WHERE tb.id = NEW.table_id;

  IF v_tournament_id IS NOT NULL THEN
    IF NEW.stack IS NULL
       OR NEW.stack::text IN ('NaN','Infinity','-Infinity')
       OR NEW.stack <= 0 THEN
      RAISE EXCEPTION
        'TOURNAMENT_SEAT_REQUIRES_POSITIVE_STACK: tournament %, table %, seat %, stack %',
        v_tournament_id, NEW.table_id, NEW.seat_number, NEW.stack
        USING ERRCODE = 'check_violation',
              HINT = 'Create or revive the seat with its paid positive stack in the same database transaction.';
    END IF;

    IF public.fn_ca_tournament_recorded_seat_first(v_tournament_id, false) THEN
      IF v_starting_chips IS NULL
         OR v_starting_chips::text IN ('NaN','Infinity','-Infinity')
         OR v_starting_chips <= 0 THEN
        RAISE EXCEPTION
          'SEAT_FIRST_STARTING_CHIPS_INVALID: tournament %, starting_chips %',
          v_tournament_id, v_starting_chips
          USING ERRCODE = 'check_violation';
      END IF;
      -- A retained original hand revives its exact already-paid chair.
      -- This capability exists only in the same transaction as the private
      -- original recovery receipt; no new seat or changed stack is admitted.
      IF NEW.stack IS DISTINCT FROM v_starting_chips AND NOT (
        TG_OP='UPDATE' AND OLD.left_at IS NOT NULL AND NEW.left_at IS NULL
        AND NEW.status IS NOT DISTINCT FROM 'active' AND auth.role() IS NOT DISTINCT FROM 'service_role'
        AND (to_jsonb(NEW)-'left_at'-'status')=(to_jsonb(OLD)-'left_at'-'status')
        AND EXISTS (
          SELECT 1 FROM smarter_private.retirement_original_hand_restorations r
          JOIN smarter_private.retirement_original_hand_qualification c USING(submission_id)
          JOIN smarter_private.hand_submissions s USING(submission_id)
          JOIN public.engine_tournament_leases l ON l.tournament_id=c.tournament_id
          CROSS JOIN LATERAL jsonb_array_elements(c.expected->'rows') e
          WHERE r.transaction_id=txid_current()
            AND c.tournament_id=v_tournament_id AND c.table_id=OLD.table_id
            AND r.request_hash=c.request_hash AND s.request_hash=c.request_hash
            AND r.qualification_hash=md5(c.expected::text)
            AND r.original_generation=s.lease_generation
            AND r.successor_generation=l.lease_generation AND r.instance_id=l.instance_id
            AND l.protocol_version=2
            AND r.restored_players=jsonb_array_length(c.expected->'rows')
            AND (e->>'user_id')::uuid=OLD.user_id
            AND (e->'seat'->>'id')::uuid=OLD.id
            AND to_jsonb(OLD) @> (e->'seat')
            AND (e->'stack'->>'stack_before')::numeric=OLD.stack
            AND EXISTS(SELECT 1 FROM jsonb_array_elements(s.request->'p_stacks') x
                       WHERE x=e->'stack')
        )
      ) THEN
        RAISE EXCEPTION
          'SEAT_FIRST_STACK_MUST_EQUAL_STARTING_CHIPS: tournament %, table %, seat %, stack %, expected %',
          v_tournament_id, NEW.table_id, NEW.seat_number, NEW.stack, v_starting_chips
          USING ERRCODE = 'check_violation',
                HINT = 'The paid seat transaction is the only starting-stack authority; no later top-up exists.';
      END IF;
    END IF;
  END IF;

  -- Cash seats with no funded stack preserve their existing reservation path.
  IF COALESCE(NEW.stack,0) <= 0 THEN
    RETURN NEW;
  END IF;

  IF public.fn_caller_is_engine() THEN
    RETURN NEW;
  END IF;

  v_path := current_setting('app.money_path', true);
  IF v_path IN ('atomic_table_buyin', 'fn_take_seat_and_buy_in',
                'fn_seat_horse_in_seat_first_game', 'fn_seat_late_registrant',
                'fn_assign_tournament_player_seat_atomic',
                'fn_horse_seat_from_treasury') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'SEAT_NOT_FUNDED: chips may only reach a seat through the engine or a declared money path (path=%, jwt_role=%, app=%, table=%, seat=%, stack=%)',
    COALESCE(NULLIF(v_path, ''), 'none'),
    COALESCE(auth.role(), 'none'),
    COALESCE(NULLIF(current_setting('application_name', true), ''), 'none'),
    NEW.table_id, NEW.seat_number, NEW.stack
    USING ERRCODE = 'check_violation',
          HINT = 'The caller must debit a wallet or treasury and declare app.money_path, or be the engine.';
END;
$function$;

ALTER FUNCTION public.fn_ca_guard_seat_creation() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_guard_seat_creation() FROM PUBLIC,anon,authenticated,service_role;
ALTER FUNCTION smarter_private.restore_retired_original_tournament_hand(uuid,text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.restore_retired_original_tournament_hand(uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
DO $after$ BEGIN
 IF NOT ((SELECT md5(pg_get_functiondef(oid))='34016ee7fb4957fe0d46dfb78c8fd5b7' AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=public'] AND proacl::text='{postgres=X/postgres}' FROM pg_proc WHERE oid='public.fn_ca_guard_seat_creation()'::regprocedure) AND (SELECT md5(pg_get_functiondef(oid))='a529e0bd2972a5b87eff0afa5fce7988' AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private'] AND proacl::text='{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.restore_retired_original_tournament_hand(uuid,text,uuid)'::regprocedure)) THEN RAISE EXCEPTION 'RETAINED_SEAT_CONTINUATION_POSTIMAGE_CHANGED' USING ERRCODE='55000'; END IF;
END $after$;
-- @live-proof: (SELECT md5(pg_get_functiondef(oid))='34016ee7fb4957fe0d46dfb78c8fd5b7' AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=public'] AND proacl::text='{postgres=X/postgres}' FROM pg_proc WHERE oid='public.fn_ca_guard_seat_creation()'::regprocedure)
-- @live-proof: (SELECT md5(pg_get_functiondef(oid))='a529e0bd2972a5b87eff0afa5fce7988' AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private'] AND proacl::text='{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.restore_retired_original_tournament_hand(uuid,text,uuid)'::regprocedure)
COMMIT;
