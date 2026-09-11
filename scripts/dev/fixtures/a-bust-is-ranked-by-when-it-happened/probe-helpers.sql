-- Test-only helpers. They build the durable evidence an accepted hand leaves
-- behind (the atomic commit, its settlement receipt, the knockout candidate and
-- the chair it was captured in) exactly as the door reads it.
\set ON_ERROR_STOP on
CREATE SCHEMA probe;

CREATE FUNCTION probe.check(p_ok boolean, p_what text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'PROBE FAILED: %', p_what;
  END IF;
END;
$$;

-- One zero-stack generation of p_user, taken by hand p_hand at p_committed_at.
-- The hand's commit and receipt rows are shared by everyone it busted.
CREATE FUNCTION probe.bust(
  p_tournament uuid, p_table uuid, p_user uuid, p_hand bigint,
  p_stack_before numeric, p_committed_at timestamptz,
  p_state text DEFAULT 'pending'
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_hand_id uuid := md5('hand:' || p_hand)::uuid;
  v_settle uuid := md5('settle:' || p_hand)::uuid;
  v_seat uuid;
  v_id uuid;
BEGIN
  INSERT INTO public.hand_atomic_commits (table_id, hand_number, hand_id, stack_result, committed_at)
  VALUES (p_table, p_hand, v_hand_id,
          jsonb_build_object('hand_id', v_settle::text, 'table_id', p_table::text,
                             'hand_number', p_hand::text,
                             'written', jsonb_build_object(p_user::text, 0)),
          p_committed_at)
  ON CONFLICT (table_id, hand_number) DO UPDATE
     SET stack_result = jsonb_set(public.hand_atomic_commits.stack_result, '{written}',
           (public.hand_atomic_commits.stack_result->'written') || jsonb_build_object(p_user::text, 0));
  INSERT INTO public.settlement_idempotency_keys (table_id, hand_id, status, completed_at, result)
  VALUES (p_table, v_settle, 'succeeded', p_committed_at,
          jsonb_build_object('table_id', p_table::text, 'hand_number', p_hand::text,
                             'written', jsonb_build_object(p_user::text, 0)))
  ON CONFLICT (table_id, hand_id) DO UPDATE
     SET result = jsonb_set(public.settlement_idempotency_keys.result, '{written}',
           (public.settlement_idempotency_keys.result->'written') || jsonb_build_object(p_user::text, 0));
  INSERT INTO public.table_seats (table_id, seat_number, user_id, stack, joined_at, left_at)
  VALUES (p_table, 1 + (p_hand % 9)::integer, p_user, 0,
          p_committed_at - interval '1 hour', p_committed_at + interval '2 seconds')
  RETURNING id INTO v_seat;
  INSERT INTO public.tournament_knockout_candidates (
    tournament_id, eliminated_user_id, table_id, seat_id, seat_joined_at,
    hand_id, hand_number, stack_before, stack_after, state, created_at)
  VALUES (p_tournament, p_user, p_table, v_seat, p_committed_at - interval '1 hour',
          v_hand_id, p_hand, p_stack_before, 0, p_state,
          p_committed_at - interval '1 millisecond')
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- The wallet-to-pool leg a rebuy purchase writes.
CREATE FUNCTION probe.rebuy_leg(
  p_tournament uuid, p_user uuid, p_at timestamptz,
  p_category text DEFAULT 'rebuy', p_status text DEFAULT 'posted'
) RETURNS uuid
LANGUAGE sql AS $$
  INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount,
                                  category, tournament_id, status, created_at)
  VALUES ('player_wallet', p_user, 'prize_liability', p_tournament, 1.00,
          p_category, p_tournament, p_status, p_at)
  RETURNING id;
$$;

-- A player's roster row.
CREATE FUNCTION probe.player(p_tournament uuid, p_user uuid, p_chips integer DEFAULT 0)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.tournament_players (tournament_id, user_id, status, chips)
  VALUES (p_tournament, p_user, 'playing', p_chips);
$$;

CREATE FUNCTION probe.door(p_tournament uuid, p_user uuid, p_position integer, p_prize numeric DEFAULT 0)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.fn_eliminate_tournament_player_atomic(p_tournament, p_user, p_position, p_prize, 0);
$$;

CREATE FUNCTION probe.eliminated_at(p_tournament uuid, p_user uuid) RETURNS timestamptz
LANGUAGE sql AS $$
  SELECT tp.eliminated_at FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament AND tp.user_id = p_user;
$$;

CREATE FUNCTION probe.state(p_candidate uuid) RETURNS text
LANGUAGE sql AS $$
  SELECT c.state FROM public.tournament_knockout_candidates c WHERE c.id = p_candidate;
$$;
