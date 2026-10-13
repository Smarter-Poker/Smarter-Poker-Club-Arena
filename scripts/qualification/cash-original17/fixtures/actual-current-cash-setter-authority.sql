BEGIN;
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_settle_cash_hand(p_table_id uuid, p_hand_number bigint, p_stacks jsonb, p_rake numeric, p_bbj numeric, p_ref text, p_inflow numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_arena uuid;
  v_bb bigint;
  v_request jsonb;
  v_stacks jsonb;
  v_prior public.poker_diamond_hand_receipts%ROWTYPE;
  v_c public.poker_diamond_custody%ROWTYPE;
  v_seat public.table_seats%ROWTYPE;
  v_e jsonb;
  v_lot record;
  v_before bigint;
  v_after bigint;
  v_loss bigint;
  v_take bigint;
  v_written jsonb := '{}'::jsonb;
  v_result jsonb;
  -- The rake arithmetic, all of it integer.
  v_rake_on boolean;
  v_rake bigint;
  v_facts jsonb := NULL;
  v_pot bigint;
  v_dealt integer;
  v_saw_flop boolean;
  v_dealt_key text;
  v_pct numeric;
  v_cap numeric;
  v_min_pot numeric;
  v_no_drop boolean;
  v_rounding text;
  v_expected bigint;
  v_attributed bigint;
  v_bbj bigint;
  v_bbj_on boolean;
  v_bbj_due bigint;
  v_pool uuid;
  v_double_board boolean;
BEGIN
  IF p_table_id IS NULL OR p_hand_number IS NULL OR p_hand_number < 1000000
     OR COALESCE(p_inflow,0) <> 0 THEN
    -- Insurance remains refused. Jackpot price is recomputed below.
    RAISE EXCEPTION 'diamond_plain_cash_hand_required' USING ERRCODE='22023';
  END IF;
  IF COALESCE(p_rake,0) < 0 OR COALESCE(p_rake,0) <> trunc(COALESCE(p_rake,0)) THEN
    RAISE EXCEPTION 'diamond_plain_cash_hand_required' USING ERRCODE='22023';
  END IF;
  v_rake := COALESCE(p_rake,0)::bigint;
  IF COALESCE(p_bbj,0) < 0 OR COALESCE(p_bbj,0) <> trunc(COALESCE(p_bbj,0)) THEN
    RAISE EXCEPTION 'diamond_bbj_must_be_whole_diamonds' USING ERRCODE='22023';
  END IF;
  v_bbj := COALESCE(p_bbj,0)::bigint;
  v_bbj_on := public.fn_ca_diamond_economic_on('bbj_enabled','all');
  IF NOT v_bbj_on AND v_bbj <> 0 THEN
    RAISE EXCEPTION 'diamond_bad_beat_jackpot_not_open' USING ERRCODE='22023';
  END IF;

  -- THE SWITCH IS AN ANSWER (design 3.2). Absent or off means the amount is
  -- exactly zero and this door keeps refusing anything else; on with a required
  -- value unset refuses by name, never "on with a default".
  BEGIN
    v_rake_on := public.fn_ca_diamond_economic_on('cash_rake_enabled','all');
  EXCEPTION WHEN SQLSTATE 'PDE01' THEN
    -- Switch ABSENT is the same answer as off (design 3.2): the amount is
    -- exactly zero and this door keeps refusing anything else. Only the ABSENCE
    -- is caught. A name the list does not know (PDE02) is a programming error
    -- in this door and must not be swallowed into "off".
    v_rake_on := false;
  END;
  IF NOT v_rake_on AND v_rake <> 0 THEN
    RAISE EXCEPTION 'diamond_cash_rake_not_open' USING ERRCODE='22023';
  END IF;

  IF jsonb_typeof(p_stacks) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'diamond_hand_roster_required' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(p_stacks) < 2 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_stacks) x
    WHERE jsonb_typeof(x) IS DISTINCT FROM 'object'
       OR jsonb_typeof(x->'user_id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
       OR jsonb_typeof(x->'stack_before') IS DISTINCT FROM 'number'
       OR jsonb_typeof(x->'stack') IS DISTINCT FROM 'number'
  ) THEN
    RAISE EXCEPTION 'diamond_exact_hand_roster_required' USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_stacks) x
    WHERE NOT pg_input_is_valid(x->>'user_id','uuid')
       OR NOT pg_input_is_valid(x->>'seat_id','uuid')
       OR NOT pg_input_is_valid(x->>'seat_joined_at','timestamp with time zone')
       OR (x->>'stack')::numeric NOT BETWEEN 0 AND 2147483647
       OR (x->>'stack_before')::numeric NOT BETWEEN 0 AND 2147483647
       OR (x->>'stack')::numeric <> trunc((x->>'stack')::numeric)
       OR (x->>'stack_before')::numeric <> trunc((x->>'stack_before')::numeric)
  ) OR (SELECT count(*) <> count(DISTINCT (x->>'user_id')::uuid)
         OR count(*) <> count(DISTINCT (x->>'seat_id')::uuid)
        FROM jsonb_array_elements(p_stacks) x) THEN
    RAISE EXCEPTION 'diamond_invalid_hand_amount_or_generation' USING ERRCODE='22023';
  END IF;

  -- CONSERVATION, RESTATED. The stacks after the hand are short by exactly the
  -- rake and the jackpot drop, and by nothing else. With both zero this is the
  -- rule that ran before this migration, unchanged.
  IF (SELECT sum((x->>'stack')::numeric - (x->>'stack_before')::numeric)
      FROM jsonb_array_elements(p_stacks) x) <> -(v_rake + COALESCE(p_bbj,0)) THEN
    RAISE EXCEPTION 'diamond_hand_does_not_conserve' USING ERRCODE='23514';
  END IF;

  SELECT t.club_id, t.big_blind INTO v_arena, v_bb FROM public.tables t
  JOIN public.clubs c ON c.id=t.club_id
  WHERE t.id=p_table_id AND c.asset='diamonds' AND c.is_platform IS TRUE
    AND c.union_id IS NULL AND t.union_id IS NULL
    AND t.tournament_id IS NULL AND public.fn_poker_diamond_cash_variant(t.game_variant)
    AND t.big_blind = trunc(t.big_blind) AND t.big_blind > 0
  FOR UPDATE OF t;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'diamond_plain_cash_table_required' USING ERRCODE='23514';
  END IF;

  -- THE RECOMPUTE. With the switch on, every hand carries its facts and the
  -- rake is recomputed from the Diamond schedule. A hand whose facts are
  -- missing, malformed or self-contradictory is refused, not resolved.
  IF v_rake_on OR v_bbj_on THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_stacks) x
      WHERE jsonb_typeof(x->'contributed') IS DISTINCT FROM 'number'
         OR jsonb_typeof(x->'dealt_in') IS DISTINCT FROM 'boolean'
         OR jsonb_typeof(x->'hand_saw_flop') IS DISTINCT FROM 'boolean'
         OR (x->>'contributed')::numeric < 0
         OR (x->>'contributed')::numeric <> trunc((x->>'contributed')::numeric)
         OR (x->>'contributed')::numeric > 2147483647
    ) THEN
      RAISE EXCEPTION 'diamond_cash_rake_facts_required' USING ERRCODE='22023';
    END IF;
    IF (SELECT count(DISTINCT (x->>'hand_saw_flop')) FROM jsonb_array_elements(p_stacks) x) <> 1 THEN
      RAISE EXCEPTION 'diamond_cash_rake_facts_disagree' USING ERRCODE='22023';
    END IF;
    SELECT sum((x->>'contributed')::bigint),
           count(*) FILTER (WHERE (x->>'dealt_in')::boolean),
           bool_or((x->>'hand_saw_flop')::boolean)
      INTO v_pot, v_dealt, v_saw_flop
      FROM jsonb_array_elements(p_stacks) x;
    -- A player who contributed cannot have been sitting out.
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x
                WHERE (x->>'contributed')::bigint > 0 AND NOT (x->>'dealt_in')::boolean) THEN
      RAISE EXCEPTION 'diamond_cash_rake_facts_disagree' USING ERRCODE='22023';
    END IF;
    -- TWO BOUNDS THAT TIE THE CLAIMED CONTRIBUTIONS TO THE STACKS THAT MOVED.
    -- Without them "contributed" is a number the engine asserts about itself and
    -- the attribution rests on nothing.
    --   A player cannot lose more than they put in. This is what makes the
    --   per-player weights trustworthy, and summed it also gives pot >= losses.
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x
                WHERE greatest((x->>'stack_before')::bigint-(x->>'stack')::bigint,0)
                      > (x->>'contributed')::bigint) THEN
      RAISE EXCEPTION 'diamond_cash_rake_facts_disagree' USING ERRCODE='22023';
    END IF;
    --   Nobody contributes Diamonds they did not bring to the hand.
    IF v_pot > (SELECT COALESCE(sum((x->>'stack_before')::bigint),0)
                  FROM jsonb_array_elements(p_stacks) x) THEN
      RAISE EXCEPTION 'diamond_cash_rake_facts_disagree' USING ERRCODE='22023';
    END IF;

    -- The dealt-in bracket is part of the NAME, not the scope: the settings
    -- table's scope grammar is 'all' or '^bb:[0-9]+$' and nothing else, so a
    -- stake key stays a stake key.
    IF v_rake_on THEN
    v_dealt_key := CASE WHEN v_dealt <= 2 THEN '_heads_up'
                        WHEN v_dealt = 3 THEN '_three_handed'
                        ELSE '' END;
    -- EVERY NUMBER IS READ, NONE IS A LITERAL, AND NONE FALLS BACK. An unset
    -- name raises diamond_economics_unset:<name>/<scope> out of this door and on
    -- to the client, which is the design's rule: "the settler refuses a raked
    -- hand with the unset name of B5", and the reader's SQLSTATE PDE01 travels
    -- out of here untouched. A Diamond stake with no published cap row therefore
    -- refuses by name rather than being raked at some other stake's cap: the
    -- A-lane's reader "never falls back from a stake to all".
    v_pct      := public.fn_ca_diamond_economic('cash_rake_percent'||v_dealt_key, 'all');
    v_cap      := public.fn_ca_diamond_economic('cash_rake_cap'||v_dealt_key, 'bb:'||v_bb::text);
    v_min_pot  := public.fn_ca_diamond_economic('cash_rake_min_pot','all');
    v_no_drop  := public.fn_ca_diamond_economic_on('cash_rake_no_flop_no_drop','all');
    v_rounding := public.fn_ca_diamond_economic_text('cash_rake_rounding','all');
    -- Only "down" is implemented. A row that says something else is an answer
    -- this door cannot honour, and honouring it approximately would be worse
    -- than refusing: the refusal names the value it cannot apply.
    IF v_rounding <> 'down' THEN
      RAISE EXCEPTION 'diamond_cash_rake_rounding_unsupported:%', v_rounding USING ERRCODE='22023';
    END IF;

    v_expected := CASE
      WHEN v_dealt < 2 THEN 0
      WHEN NOT v_saw_flop AND v_no_drop THEN 0
      WHEN v_pot < v_min_pot THEN 0
      ELSE least(trunc(v_pot::numeric * v_pct / 100), v_cap)::bigint END;

    IF v_rake <> v_expected THEN
      RAISE EXCEPTION 'diamond_cash_rake_disagrees (engine %, settings % at pot %, % dealt, flop %)',
        v_rake, v_expected, v_pot, v_dealt, v_saw_flop USING ERRCODE='23514';
    END IF;
    IF v_rake > v_pot THEN
      RAISE EXCEPTION 'diamond_cash_rake_facts_disagree' USING ERRCODE='22023';
    END IF;
    END IF;
  ELSIF v_rake <> 0 THEN
    RAISE EXCEPTION 'diamond_cash_rake_not_open' USING ERRCODE='22023';
  END IF;

  IF v_bbj_on THEN
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x
        WHERE jsonb_typeof(x->'hand_double_board') IS DISTINCT FROM 'boolean')
      OR (SELECT count(DISTINCT x->>'hand_double_board') FROM jsonb_array_elements(p_stacks) x) <> 1 THEN
      RAISE EXCEPTION 'diamond_jackpot_board_facts_required' USING ERRCODE='22023';
    END IF;
    SELECT bool_or((x->>'hand_double_board')::boolean) INTO v_double_board
      FROM jsonb_array_elements(p_stacks) x;
    v_bbj_due := CASE WHEN v_saw_flop AND NOT v_double_board
       AND v_dealt >= public.fn_ca_diamond_economic('bbj_min_dealt_in')
       THEN public.fn_poker_diamond_jackpot_drop_due(p_table_id) ELSE 0 END;
    IF v_bbj IS DISTINCT FROM v_bbj_due OR v_rake + v_bbj > v_pot THEN
      RAISE EXCEPTION 'diamond_bbj_amount_disagrees_with_the_schedule' USING ERRCODE='23514';
    END IF;
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
    'user_id',(x->>'user_id')::uuid, 'seat_id',(x->>'seat_id')::uuid,
    'seat_joined_at',(x->>'seat_joined_at')::timestamptz,
    'stack_before',(x->>'stack_before')::bigint, 'stack',(x->>'stack')::bigint)
    ORDER BY (x->>'user_id')::uuid) INTO v_stacks
    FROM jsonb_array_elements(p_stacks) x;
  -- The facts are part of the request, so a replay that claims a different pot,
  -- a different flop or a different roster is a payload mismatch rather than a
  -- second settlement. They are kept apart from the stacks so the stack shape
  -- the rest of this door reads is exactly what it was.
  IF v_rake_on OR v_bbj_on THEN
    SELECT jsonb_build_object('double_board',v_double_board,'pot',v_pot,'dealt',v_dealt,'saw_flop',v_saw_flop,
             'contributions', jsonb_agg(jsonb_build_object(
               'user_id',(x->>'user_id')::uuid,
               'contributed',(x->>'contributed')::bigint,
               'dealt_in',(x->>'dealt_in')::boolean)
               ORDER BY (x->>'user_id')::uuid))
      INTO v_facts FROM jsonb_array_elements(p_stacks) x;
  END IF;
  v_request := jsonb_build_object('stacks',v_stacks,'ref',p_ref,
    'rake',p_rake,'bbj',p_bbj,'inflow',p_inflow)
    || CASE WHEN v_facts IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('rake_facts',v_facts) END;

  -- A REPLAY MOVES NOTHING TWICE. The receipt is read before any write, so a
  -- redelivered hand returns the first receipt and touches no balance, no lot,
  -- no seat and no accrual row.
  SELECT * INTO v_prior FROM public.poker_diamond_hand_receipts
    WHERE table_id=p_table_id AND hand_number=p_hand_number;
  IF FOUND THEN
    IF v_prior.request IS DISTINCT FROM v_request THEN
      RAISE EXCEPTION 'diamond_hand_payload_mismatch' USING ERRCODE='22023';
    END IF;
    RETURN v_prior.receipt || jsonb_build_object('replay',true);
  END IF;

  -- Own the player-side jackpot bank before wallet locks; the payout takes
  -- this same pool then wallet order inside the accepted-hand transaction.
  IF v_bbj_on THEN
    v_pool := public.fn_poker_diamond_jackpot_pool_for_table(p_table_id);
    IF v_pool IS NULL THEN RAISE EXCEPTION 'diamond_jackpot_pool_absent'; END IF;
    PERFORM 1 FROM public.poker_diamond_jackpot_pools WHERE id=v_pool FOR UPDATE;
  END IF;

  -- Match the wallet/refund lock order before touching purchase lots.
  PERFORM p.id FROM public.profiles p
    JOIN jsonb_array_elements(v_stacks) x ON (x->>'user_id')::uuid=p.id
    ORDER BY p.id FOR UPDATE OF p;
  -- Validate the entire roster while locks are held before changing one balance.
  FOR v_e IN SELECT value FROM jsonb_array_elements(v_stacks) LOOP
    SELECT * INTO v_seat FROM public.table_seats
      WHERE id=(v_e->>'seat_id')::uuid AND table_id=p_table_id
        AND user_id=(v_e->>'user_id')::uuid
        AND joined_at=(v_e->>'seat_joined_at')::timestamptz
        AND left_at IS NULL FOR UPDATE;
    IF NOT FOUND OR v_seat.stack IS DISTINCT FROM (v_e->>'stack_before')::numeric THEN
      RAISE EXCEPTION 'diamond_hand_stale_seat' USING ERRCODE='55000';
    END IF;
    SELECT * INTO v_c FROM public.poker_diamond_custody
      WHERE occupancy_id=v_seat.occupancy_id AND seat_id=v_seat.id
        AND seat_joined_at=v_seat.joined_at AND user_id=v_seat.user_id
        AND target_id=p_table_id AND arena_id=v_arena
        AND purpose='cash_seat' AND state='active' FOR UPDATE;
    IF NOT FOUND OR v_c.balance IS DISTINCT FROM (v_e->>'stack_before')::bigint THEN
      RAISE EXCEPTION 'diamond_hand_custody_mismatch' USING ERRCODE='23514';
    END IF;
  END LOOP;

  FOR v_e IN SELECT value FROM jsonb_array_elements(v_stacks) LOOP
    SELECT * INTO STRICT v_c FROM public.poker_diamond_custody
      WHERE seat_id=(v_e->>'seat_id')::uuid
        AND seat_joined_at=(v_e->>'seat_joined_at')::timestamptz
        AND user_id=(v_e->>'user_id')::uuid AND target_id=p_table_id AND state='active';
    v_before := (v_e->>'stack_before')::bigint;
    v_after := (v_e->>'stack')::bigint;
    v_loss := greatest(v_before-v_after,0);
    -- THE RAKE NEEDS NO CHANGE HERE (design section 5, step 4): the settler
    -- already consumes purchased lots for every loss, and every rake Diamond is
    -- part of some player's loss.
    FOR v_lot IN
      SELECT l.id,r.amount-r.consumed AS held,
        greatest(l.issued-l.consumed-l.refunded,0) AS outstanding
      FROM public.poker_diamond_lot_reservations r
      JOIN public.diamond_purchase_lots l ON l.id=r.lot_id
      WHERE r.custody_id=v_c.id AND r.released_at IS NULL
      ORDER BY l.created_at,l.id FOR UPDATE OF l,r
    LOOP
      EXIT WHEN v_loss=0;
      v_take := least(v_loss,v_lot.held);
      IF v_take>0 THEN
        -- A provider reversal may already have retired this liability.
        -- Remove the hold once; consume only liability still outstanding.
        UPDATE public.diamond_purchase_lots
          SET arena_reserved=arena_reserved-v_take,
              consumed=consumed+least(v_take,v_lot.outstanding)::integer
          WHERE id=v_lot.id;
        UPDATE public.poker_diamond_lot_reservations
          SET consumed=consumed+v_take
          WHERE custody_id=v_c.id AND lot_id=v_lot.id;
        v_loss := v_loss-v_take;
      END IF;
    END LOOP;
    UPDATE public.poker_diamond_custody SET balance=v_after WHERE id=v_c.id;
    UPDATE public.table_seats SET stack=v_after
      WHERE id=v_c.seat_id AND joined_at=v_c.seat_joined_at
        AND occupancy_id=v_c.occupancy_id AND left_at IS NULL;
    IF NOT EXISTS (SELECT 1 FROM public.table_seats
      WHERE id=v_c.seat_id AND joined_at=v_c.seat_joined_at
        AND occupancy_id=v_c.occupancy_id AND left_at IS NULL AND stack=v_after) THEN
      RAISE EXCEPTION 'diamond_hand_seat_write_failed' USING ERRCODE='23514';
    END IF;
    v_written := v_written || jsonb_build_object(v_c.user_id::text,v_after);
  END LOOP;

  -- ATTRIBUTION AND ACCRUAL (design section 5, steps 4 and 5)
  --
  -- WEIGHTED_CONTRIBUTED, the method the commit door already requires for chip
  -- rake: each contributor's share of the rake is in proportion to what they put
  -- into the pot. This moves no Diamond - the Diamonds already left the stacks
  -- when the pot was cut. It decides WHOSE spend row records each Diamond of
  -- rake, which is what the register needs at the sweep and what a rakeback
  -- would need if B12 were ever yes.
  --
  -- THE REMAINDER RULE, STATED SO IT CAN BE PINNED. A proportional split of a
  -- whole number of Diamonds almost never divides evenly, so:
  --   1. each contributor takes floor(rake * contributed / pot);
  --   2. the Diamonds left over go one each to the contributors with the largest
  --      remainder (rake * contributed) mod pot, largest first;
  --   3. ties on that remainder are broken by user_id ascending.
  -- It is deterministic, it is total (the shares sum to the rake exactly, which
  -- the assertion below proves on every hand), and it never gives a contributor
  -- more than one extra Diamond.
  --
  -- NO is_horse ANYWHERE. A horse contributes and is attributed like anyone.
  IF v_rake > 0 THEN
    INSERT INTO public.ca_diamond_rake_accrual
      (table_id, hand_number, arena_id, user_id, kind, amount)
    WITH c AS (
      SELECT (x->>'user_id')::uuid AS uid, (x->>'contributed')::bigint AS contributed
        FROM jsonb_array_elements(p_stacks) x
       WHERE (x->>'contributed')::bigint > 0
    ), b AS (
      SELECT uid,
             div(v_rake * contributed, v_pot) AS base,
             (v_rake * contributed) % v_pot AS frac
        FROM c
    ), r AS (
      SELECT v_rake - COALESCE(sum(base),0) AS rem FROM b
    ), o AS (
      SELECT uid, base, row_number() OVER (ORDER BY frac DESC, uid ASC) AS rn FROM b
    )
    SELECT p_table_id, p_hand_number, v_arena, o.uid, 'rake',
           o.base + CASE WHEN o.rn <= r.rem THEN 1 ELSE 0 END
      FROM o CROSS JOIN r
     WHERE o.base + CASE WHEN o.rn <= r.rem THEN 1 ELSE 0 END > 0;

    SELECT COALESCE(sum(amount),0) INTO v_attributed
      FROM public.ca_diamond_rake_accrual
     WHERE table_id=p_table_id AND hand_number=p_hand_number AND kind='rake';
    IF v_attributed IS DISTINCT FROM v_rake THEN
      RAISE EXCEPTION 'diamond_cash_rake_attribution_does_not_sum (% of %)', v_attributed, v_rake
        USING ERRCODE='23514';
    END IF;
  END IF;

  IF v_bbj > 0 THEN
    PERFORM public.fn_poker_diamond_jackpot_drop(p_table_id,p_hand_number,v_bbj,v_stacks);
  END IF;

  v_result := jsonb_build_object('success',true,'asset','diamonds',
    'players',jsonb_array_length(v_stacks),'table_id',p_table_id,
    'hand_id',md5('ca-hand:'||p_table_id||':'||p_hand_number
      ||CASE WHEN p_ref IS NULL OR p_ref='' THEN '' ELSE ':'||p_ref END)::uuid,
    'hand_number',p_hand_number,'net_deltas',-(v_rake + COALESCE(p_bbj,0)),
    'rake',p_rake,'bbj',p_bbj,
    'inflow',p_inflow,'mode','delta','rebased','{}'::jsonb,
    'written',v_written,'departed','[]'::jsonb,'conservation_checked',true,
    'rake_accrued',COALESCE(v_attributed,0),
    'request',v_request);
  INSERT INTO public.poker_diamond_hand_receipts(table_id,hand_number,request,receipt)
    VALUES(p_table_id,p_hand_number,v_request,v_result);
  RETURN v_result;
END $function$;

ALTER FUNCTION public.fn_poker_diamond_settle_cash_hand(uuid,bigint,jsonb,numeric,numeric,text,numeric) OWNER TO postgres; REVOKE ALL ON FUNCTION public.fn_poker_diamond_settle_cash_hand(uuid,bigint,jsonb,numeric,numeric,text,numeric) FROM PUBLIC,anon,authenticated,service_role; GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_jackpot_bank(uuid,text) TO service_role;
DO $m$ BEGIN IF md5(pg_get_functiondef('public.fn_poker_diamond_settle_cash_hand(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure)) IS DISTINCT FROM '42026f4929fe2adc0aae9bfd307c516f' THEN RAISE EXCEPTION 'ACTUAL_CASH_SETTER_MISMATCH'; END IF;END $m$; COMMIT;