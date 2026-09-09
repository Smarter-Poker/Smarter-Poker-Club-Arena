/*
  A RESULT THE CHRONOLOGY CANNOT CERTIFY IS SETTLED BY A RULING (2026-09-09).

  fn_normalize_tournament_final_standings holds the right law: chronology is the
  result authority, the champion is first, and the eliminated run from the latest
  bust in second to the earliest in last. It refuses to renumber a place that has
  already been paid to somebody else, because it "neither claws money back nor
  moves it to a different recipient", and it says out loud that such an event
  "requires manual review".

  $100 Freeroll 6:00 AM is that event, and until today nothing existed to answer
  the review with. It has been RUNNING for twenty-nine hours holding 179.11 of
  prize money that no door could pay.

  WHAT WENT WRONG THERE.  Positions were stamped at bust time from a live count
  that still counted players who had left the felt hours earlier - the fault the
  absent-player door now closes. The count therefore moved in both directions:
  7f2fcb20 busted at 14:32:35 and was paid place 2 (72.68) because the engine
  saw two players; then 89a23158 busted at 14:37:43 and was paid place 21,
  65f99ae2 at 14:41:56 place 26, b1dd1863 at 14:43:45 place 30, and 786eb11f at
  14:44:10 place 35. Nobody un-busts. Thirty-seven of the forty paid places
  disagree with bust order, and 585.99 has already left the escrow against them.

  WHY A RULING AND NOT A RENUMBER.  Every renumbering that satisfies chronology
  moves a place that has been paid, which means either paying it twice or taking
  it back from the player who holds it. The escrow is exact evidence that the
  paid record is the settled one: 765.10 of prize pool, 585.99 disbursed, and
  179.11 left, which is place 1 (126.55) plus place 3 (52.56) to the cent and
  nothing else. So the paid places stand, the two open places are paid, and the
  disagreement with chronology is recorded rather than erased.

  THE DOOR CANNOT BE USED WHILE THE ORDINARY ONE WORKS.  This function calls
  fn_normalize_tournament_final_standings first and refuses outright if it
  succeeds. A ruling is reachable only where chronology has actually been tried
  and has actually refused, and the refusal it gave is carried in the receipt.
  It also proves, before writing anything, that the ruling leaves no money
  unaccounted for: every obligation settled in full, the roster prizes and the
  obligations agreeing to the cent, the place obligations summing to the whole
  prize pool, and the escrow closing at zero.

  The receipt says 'ruling', not 'structure', for ever. An event settled this way
  is never mistaken for one the structure computed.
*/

ALTER TABLE public.tournament_place_settlement_batches
  DROP CONSTRAINT IF EXISTS tournament_place_settlement_batches_mode_check;
ALTER TABLE public.tournament_place_settlement_batches
  ADD CONSTRAINT tournament_place_settlement_batches_mode_check
  CHECK (mode IN ('structure', 'ruling'));

COMMENT ON COLUMN public.tournament_place_settlement_batches.mode IS
  'structure: the places came from the prize structure through fn_settle_tournament_places_atomic. ruling: chronology could not certify the result because places already paid disagreed with bust order, so fn_settle_tournament_places_by_ruling settled the remainder against the paid record and recorded the disagreement.';

CREATE OR REPLACE FUNCTION public.fn_settle_tournament_places_by_ruling(
  p_tournament_id uuid,
  p_reason text,
  p_source text DEFAULT 'chip standard 10.9')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_t record;
  v_norm jsonb;
  v_source text := COALESCE(NULLIF(btrim(p_source), ''), 'chip standard 10.9');
  v_reason text := COALESCE(btrim(p_reason), '');
  r record;
  v_res jsonb;
  v_paid_here numeric := 0;
  v_settled_count integer := 0;
  v_place_owed numeric := 0;
  v_place_count integer := 0;
  v_escrow_before numeric := 0;
  v_escrow_after numeric := 0;
  v_bounty_after numeric := 0;
  v_unsettled integer := 0;
  v_unranked integer := 0;
  v_dupes integer := 0;
  v_winners integer := 0;
  v_prize_without_obligation integer := 0;
  v_fee_after numeric := 0;
  v_result_mismatches integer := 0;
  v_fingerprint text;
BEGIN
  IF p_tournament_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_id_required');
  END IF;
  IF length(v_reason) < 200 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'a_ruling_states_its_cause',
      'detail', 'the reason must be at least 200 characters and name what disagreed',
      'given', length(v_reason));
  END IF;

  SELECT t.id, t.status, round(COALESCE(t.prize_pool, 0), 2) AS prize_pool,
         COALESCE(t.prize_pool_finalized, false) AS finalized
    INTO v_t
    FROM public.tournaments t WHERE t.id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;
  IF v_t.status <> 'COMPLETING' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_completing', 'status', v_t.status);
  END IF;
  IF NOT v_t.finalized THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'prize_pool_is_not_finalized');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_place_settlement_batches b
              WHERE b.tournament_id = p_tournament_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'a_batch_already_exists');
  END IF;

  /* THE ORDINARY DOOR IS TRIED FIRST, EVERY TIME. A ruling that could have been
     a computation is not a ruling, it is a shortcut. */
  v_norm := public.fn_normalize_tournament_final_standings(p_tournament_id);
  IF COALESCE((v_norm->>'ok')::boolean, false) IS TRUE THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'chronology_can_certify_this_result',
      'detail', 'fn_normalize_tournament_final_standings succeeded; settle through '
                || 'fn_prepare_tournament_place_obligations and '
                || 'fn_settle_tournament_places_atomic, not through a ruling',
      'normalization', v_norm);
  END IF;

  SELECT count(*) FILTER (WHERE tp.position IS NULL),
         count(*) FILTER (WHERE tp.status = 'winner' AND tp.position = 1)
    INTO v_unranked, v_winners
    FROM public.tournament_players tp WHERE tp.tournament_id = p_tournament_id;
  SELECT count(*) INTO v_dupes FROM (
    SELECT tp.position FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id AND tp.position IS NOT NULL
     GROUP BY tp.position HAVING count(*) <> 1) d;
  IF v_unranked <> 0 OR v_winners <> 1 OR v_dupes <> 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'standings_are_not_terminal',
      'unranked', v_unranked, 'winners_at_place_one', v_winners,
      'duplicate_positions', v_dupes);
  END IF;

  SELECT round(COALESCE(e.prize_balance, 0), 2) INTO v_escrow_before
    FROM public.tournament_escrow e WHERE e.tournament_id = p_tournament_id;

  /* Pay every place the roster names and the obligations have not settled.
     The roster prize is the authority here precisely because the structure's
     ordering is the thing in dispute. */
  FOR r IN
    SELECT tp.user_id, tp.position, round(tp.prize, 2) AS prize
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND round(COALESCE(tp.prize, 0), 2) > 0
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_obligations o
          WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
            AND o.user_id = tp.user_id AND o.place = tp.position
            AND abs(round(o.amount_paid, 2) - round(tp.prize, 2)) <= 0.005
            AND abs(round(o.amount_owed, 2) - round(o.amount_paid, 2)) <= 0.005)
     ORDER BY tp.position
  LOOP
    v_res := public.fn_settle_tournament_obligation(
      p_tournament_id, 'place', r.position, r.user_id, r.prize, 'reconcile',
      format('Tournament prize: position %s, settled by ruling', r.position));
    IF COALESCE((v_res->>'ok')::boolean, false) IS NOT TRUE
       OR COALESCE((v_res->>'fully_settled')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'ruling could not settle place % for %: %',
        r.position, r.user_id, v_res USING ERRCODE = 'P0404';
    END IF;
    v_paid_here := v_paid_here + (v_res->>'paid')::numeric;
    v_settled_count := v_settled_count + 1;
  END LOOP;

  ---------------------------------------------------------------- proofs
  SELECT count(*) INTO v_unsettled
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND abs(round(COALESCE(o.amount_paid, 0), 2)
           - round(COALESCE(o.amount_owed, 0), 2)) > 0.005;
  IF v_unsettled <> 0 THEN
    RAISE EXCEPTION 'ruling left % obligation(s) unsettled', v_unsettled
      USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_prize_without_obligation
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id AND round(COALESCE(tp.prize, 0), 2) > 0
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_obligations o
        WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
          AND o.user_id = tp.user_id AND o.place = tp.position
          AND abs(round(o.amount_paid, 2) - round(tp.prize, 2)) <= 0.005);
  IF v_prize_without_obligation <> 0 THEN
    RAISE EXCEPTION 'ruling left % roster prize(s) with no settled obligation',
      v_prize_without_obligation USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*), round(COALESCE(sum(o.amount_owed), 0), 2)
    INTO v_place_count, v_place_owed
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id AND o.kind = 'place';
  IF abs(v_place_owed - v_t.prize_pool) > 0.005 THEN
    RAISE EXCEPTION 'ruling settled % of a % prize pool - the pool is not fully obligated',
      v_place_owed, v_t.prize_pool USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(e.prize_balance, 0), 2), round(COALESCE(e.bounty_balance, 0), 2),
         round(COALESCE(e.fee_balance, 0), 2)
    INTO v_escrow_after, v_bounty_after, v_fee_after
    FROM public.tournament_escrow e WHERE e.tournament_id = p_tournament_id;
  IF abs(COALESCE(v_escrow_after, 0)) > 0.005 OR abs(COALESCE(v_bounty_after, 0)) > 0.005 THEN
    RAISE EXCEPTION 'ruling left % prize and % bounty in escrow',
      v_escrow_after, v_bounty_after USING ERRCODE = 'P0404';
  END IF;
  /* The rake is settled before this door will complete an event, not after.
     fn_certify_tournament_finish only certifies a tournament that already reads
     COMPLETED, so this function is what advances it - and it will not advance an
     event whose fee balance is still open, because a COMPLETED event nobody is
     going to settle again is where a fee goes to die. */
  IF abs(COALESCE(v_fee_after, 0)) > 0.005 THEN
    RAISE EXCEPTION 'the fee balance is still % - settle the rake with '
      'fn_settle_tournament_rake before ruling on the places', v_fee_after
      USING ERRCODE = 'P0404';
  END IF;

  ---------------------------------------------------------------- the receipt
  SELECT md5(string_agg(o.place::text || ':' || o.user_id::text || ':'
                        || round(o.amount_owed, 2)::text, '|' ORDER BY o.place))
    INTO v_fingerprint
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id AND o.kind = 'place';

  INSERT INTO public.tournament_place_settlement_batches
    (tournament_id, mode, plan_fingerprint, place_count, amount_owed,
     escrow_required, escrow_available, bubble_contract_required,
     bubble_obligation_id, bubble_user_id, bubble_source, bubble_amount_owed,
     bubble_amount_paid_before, source, prepared_at, settled_at)
  VALUES
    (p_tournament_id, 'ruling', v_fingerprint, v_place_count, v_place_owed,
     GREATEST(COALESCE(v_paid_here, 0), 0), GREATEST(COALESCE(v_escrow_before, 0), 0),
     false, NULL, NULL, NULL, 0, 0, v_source, now(), now());

  ------------------------------------------------------- the event is over
  /* Same tail as fn_settle_tournament_places_atomic: the status transition is
     what releases the seats (trg_release_seats_on_tournament_finish), the
     tables are closed in the same transaction so a table trigger rolls the
     prizes back with them, and the result is proved against the obligations
     one last time before anything is allowed to stand. */
  UPDATE public.tournaments
     SET status = 'COMPLETED',
         ended_at = COALESCE(ended_at, clock_timestamp()),
         on_break = false,
         break_ends_at = NULL
   WHERE id = p_tournament_id AND status = 'COMPLETING';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the COMPLETING claim was lost before the ruling could complete the event'
      USING ERRCODE = '40001';
  END IF;

  UPDATE public.tables
     SET status = 'closed', current_players = 0
   WHERE tournament_id = p_tournament_id
     AND (status IS DISTINCT FROM 'closed' OR current_players IS DISTINCT FROM 0);
  IF EXISTS (SELECT 1 FROM public.tables
              WHERE tournament_id = p_tournament_id
                AND (status IS DISTINCT FROM 'closed' OR current_players IS DISTINCT FROM 0))
     OR EXISTS (SELECT 1 FROM public.table_seats s
                  JOIN public.tables tb ON tb.id = s.table_id
                 WHERE tb.tournament_id = p_tournament_id AND s.left_at IS NULL) THEN
    RAISE EXCEPTION 'the ruled tournament retained a nonterminal table or a live seat'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO v_result_mismatches
    FROM public.tournament_obligations o
    LEFT JOIN public.tournament_players tp
      ON tp.tournament_id = o.tournament_id AND tp.position = o.place
   WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
     AND (tp.user_id IS NULL OR tp.user_id IS DISTINCT FROM o.user_id);
  IF v_result_mismatches <> 0 THEN
    RAISE EXCEPTION 'the ruling left % place obligation(s) pointing at a player who does not '
      'hold that place', v_result_mismatches USING ERRCODE = '23514';
  END IF;

  PERFORM public.fn_raise_server_financial_alert(
    'warning', 'fn_settle_tournament_places_by_ruling',
    'Tournament ' || p_tournament_id || ' was settled by ruling because chronology '
      || 'refused to certify it (' || COALESCE(v_norm->>'reason', 'unknown') || '). '
      || v_settled_count || ' place(s) worth ' || round(v_paid_here, 2)
      || ' were paid against the record already on the board, the escrow closed at zero, '
      || 'and no place was moved from the player holding it. Cause: ' || v_reason,
    jsonb_build_object('normalization_refusal', v_norm, 'places_settled', v_settled_count,
                       'paid', round(v_paid_here, 2), 'place_obligations', v_place_owed,
                       'prize_pool', v_t.prize_pool, 'escrow_before', v_escrow_before,
                       'source', v_source, 'reason', v_reason),
    'ruled-finish:' || p_tournament_id::text);

  RETURN jsonb_build_object('ok', true, 'mode', 'ruling',
    'places_settled', v_settled_count, 'paid', round(v_paid_here, 2),
    'place_obligations', v_place_owed, 'prize_pool', v_t.prize_pool,
    'escrow_before', v_escrow_before, 'escrow_after', v_escrow_after,
    'status', (SELECT t2.status FROM public.tournaments t2 WHERE t2.id = p_tournament_id),
    'plan_fingerprint', v_fingerprint, 'normalization_refusal', v_norm);
END;
$fn$;

COMMENT ON FUNCTION public.fn_settle_tournament_places_by_ruling(uuid, text, text) IS
  'Settles the open places of a tournament whose already-paid places disagree with bust chronology, so fn_normalize_tournament_final_standings refuses to certify it. Unreachable while chronology can certify: it calls the normalizer first and refuses if that succeeds. Proves every obligation settled, the prize pool fully obligated and the escrow closed at zero before writing a batch receipt marked mode=ruling.';

REVOKE ALL ON FUNCTION public.fn_settle_tournament_places_by_ruling(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_places_by_ruling(uuid, text, text) TO service_role;

DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.tournament_place_settlement_batches'::regclass
       AND conname = 'tournament_place_settlement_batches_mode_check'
       AND pg_get_constraintdef(oid) LIKE '%ruling%') THEN
    RAISE EXCEPTION 'the batch mode was not widened to accept a ruling';
  END IF;
  IF to_regprocedure('public.fn_settle_tournament_places_by_ruling(uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'the ruling door was not created';
  END IF;
END
$assert$;
