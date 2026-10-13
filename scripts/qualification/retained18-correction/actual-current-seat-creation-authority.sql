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
$function$
