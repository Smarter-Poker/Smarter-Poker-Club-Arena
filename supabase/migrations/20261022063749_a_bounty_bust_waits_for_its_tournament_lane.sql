-- A BOUNTY BUST WAITS FOR ITS TOURNAMENT LANE (2026-10-22).
--
-- From 06:19 UTC every bust in Midnight Bounty (NLH) 77c43fe1 and c97ae5a1
-- was refused F06_RETRY_CANONICAL_LANE. fn_claim_tournament_bounty_elimination
-- writes tournament_players, whose f06_source_guard only TRIES the
-- tournament's exclusive settlement lane; each of the event's ~17 tables
-- takes that lane shared for every hand commit, so the try lost almost every
-- time. 130 busted players stayed "playing" and, after the 06:29 engine
-- release, 16 tables were refused re-admission because their rosters no
-- longer matched (F06_MOVEMENT_WHOLE_ROSTER_REQUIRED / ELIMINATION_UNPROVEN).
--
-- The claim now takes the lane itself before any row lock, waiting at most
-- 4 s, the same rule per-table writers follow through f06_wait_table_lane
-- (2026-10-19). A wait that still times out is the same named refusal, so
-- the engine's elimination sweep retries it exactly as before.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $pre$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid =
      'public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)'::regprocedure)
     IS DISTINCT FROM '1ae2854de3f05d01ca8a71d7ad4044fd' THEN
    RAISE EXCEPTION 'BOUNTY_LANE_PREIMAGE_CHANGED: requalify against the installed body';
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.fn_claim_tournament_bounty_elimination(p_tournament_id uuid, p_eliminated_user_id uuid, p_position integer, p_prize numeric, p_table_id uuid, p_hand_id uuid, p_hand_number bigint, p_seat_joined_at timestamp with time zone, p_knocker_user_id uuid, p_claimants jsonb, p_bubble_refund numeric DEFAULT 0, p_allow_existing_eliminated boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_player public.tournament_players%ROWTYPE;
  v_candidate public.tournament_knockout_candidates%ROWTYPE;
  v_resolved_candidate_id uuid;
  v_atomic public.hand_atomic_commits%ROWTYPE;
  v_live public.table_seats%ROWTYPE;
  v_evidence_stack numeric;
  v_settlement_hand_text text;
  v_settlement_hand_id uuid;
  v_live_count integer;
  v_changed integer;
  v_result jsonb;
  v_rebought_generations uuid[] := ARRAY[]::uuid[];
BEGIN
  -- Exact replay is permitted after the player, seat and tournament have moved
  -- on. The immutable obligation itself is the receipt, and the private core
  -- verifies every caller-supplied field against it.
  IF p_tournament_id IS NULL OR p_eliminated_user_id IS NULL
     OR p_hand_number IS NULL THEN
    RETURN public.fn_claim_bounty_legacy_candidate_20260907(
      p_tournament_id,p_eliminated_user_id,p_position,p_prize,p_table_id,
      p_hand_id,p_hand_number,p_seat_joined_at,p_knocker_user_id,p_claimants,
      p_bubble_refund,p_allow_existing_eliminated);
  END IF;

  /* A BOUNTY BUST WAITS FOR ITS TOURNAMENT LANE (2026-10-22). The
     tournament_players write below is checked by f06_source_guard, which
     only TRIES the tournament's exclusive lane and refuses on contention
     (F06_RETRY_CANONICAL_LANE). Every table of the event takes that lane
     shared for each hand commit, so on a large field the try nearly always
     lost: Midnight Bounty 77c43fe1 and c97ae5a1 recorded no bust from
     06:19 UTC and left 130 busted players listed as playing. Take the lane
     here, before any row lock, waiting at most 4 s; the guard's try then
     finds it already held by this transaction. */
  DECLARE v_prior_lock_timeout text := current_setting('lock_timeout');
  BEGIN
    PERFORM set_config('lock_timeout', '4s', true);
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended('ca:tournament-terminal-settlement:v1', 0));
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ca:tournament-terminal-settlement:v1:' || p_tournament_id::text, 0));
    PERFORM set_config('lock_timeout', v_prior_lock_timeout, true);
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE = '55P03';
  END;

  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_bounty_obligations o
     WHERE o.tournament_id=p_tournament_id
       AND o.table_id=p_table_id
       AND o.hand_id=p_hand_id
       AND o.hand_number=p_hand_number
       AND o.eliminated_user_id=p_eliminated_user_id
  ) THEN
    RETURN public.fn_claim_bounty_legacy_candidate_20260907(
      p_tournament_id,p_eliminated_user_id,p_position,p_prize,p_table_id,
      p_hand_id,p_hand_number,p_seat_joined_at,p_knocker_user_id,p_claimants,
      p_bubble_refund,p_allow_existing_eliminated);
  END IF;

  SELECT * INTO v_player FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.user_id=p_eliminated_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','player_not_found');
  END IF;

  PERFORM 1
    FROM public.tournament_knockout_candidates c
   WHERE c.tournament_id=p_tournament_id
     AND c.eliminated_user_id=p_eliminated_user_id
   ORDER BY c.hand_number,c.id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','knockout_candidate_required');
  END IF;

  v_resolved_candidate_id:=public.fn_ca_latest_committed_knockout_candidate(
    p_tournament_id,p_eliminated_user_id);
  SELECT c.* INTO v_candidate
    FROM public.tournament_knockout_candidates c
   WHERE c.id=v_resolved_candidate_id;
  IF NOT FOUND
     OR v_candidate.table_id IS DISTINCT FROM p_table_id
     OR v_candidate.hand_id IS DISTINCT FROM p_hand_id
     OR v_candidate.hand_number IS DISTINCT FROM p_hand_number
     OR v_candidate.seat_joined_at IS DISTINCT FROM p_seat_joined_at THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','bounty_claim_is_not_latest_knockout_hand');
  END IF;

  SELECT a.* INTO v_atomic
    FROM public.hand_atomic_commits a
   WHERE a.table_id=v_candidate.table_id
     AND a.hand_number=v_candidate.hand_number
     AND a.hand_id=v_candidate.hand_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','atomic_knockout_candidate_missing');
  END IF;
  v_settlement_hand_text:=v_atomic.stack_result->>'hand_id';
  IF coalesce(v_settlement_hand_text,'')
       !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_atomic.stack_result->>'table_id'<>v_candidate.table_id::text
     OR coalesce(v_atomic.stack_result->>'hand_number','')
          !~ '^[0-9]+$'
     OR (v_atomic.stack_result->>'hand_number')::bigint<>
          v_candidate.hand_number
     OR coalesce(v_atomic.stack_result->'written'
                   ->>p_eliminated_user_id::text,'')
          !~ '^-?[0-9]+([.][0-9]+)?$'
     OR (v_atomic.stack_result->'written'
           ->>p_eliminated_user_id::text)::numeric<>0 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','atomic_knockout_candidate_identity_conflict');
  END IF;
  v_settlement_hand_id:=v_settlement_hand_text::uuid;

  SELECT (k.result->'written'
            ->>p_eliminated_user_id::text)::numeric
    INTO v_evidence_stack
    FROM public.settlement_idempotency_keys k
   WHERE k.table_id=v_candidate.table_id
     AND k.hand_id=v_settlement_hand_id
     AND k.status='succeeded'
     AND k.completed_at IS NOT NULL
     AND k.result->>'table_id'=v_candidate.table_id::text
     AND coalesce(k.result->>'hand_number','') ~ '^[0-9]+$'
     AND (k.result->>'hand_number')::bigint=v_candidate.hand_number
     AND coalesce(k.result->'written'
                   ->>p_eliminated_user_id::text,'')
           ~ '^-?[0-9]+([.][0-9]+)?$';
  IF NOT FOUND OR v_evidence_stack<>0 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','exact_knockout_settlement_receipt_missing');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournament_knockout_candidates c
     WHERE c.tournament_id=p_tournament_id
       AND c.eliminated_user_id=p_eliminated_user_id
       AND c.hand_number>v_candidate.hand_number
  ) THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','latest_knockout_evidence_chain_conflict');
  END IF;
  /* A GENERATION A REBUY PAID FOR IS NOT A LIVE BUST (2026-09-11).
     The 2026-09-08/09 rebuy chain bought players back in without marking the
     busted generation 'rebought', so each left an older 'pending' row, and
     this check then refused every later, real bust of the same player for
     ever. The non-bounty door's rule applies here too: a pending generation
     is proven bought back when a posted 'rebuy' leg moved this player's own
     wallet into this event's prize liability AFTER that generation was
     captured and BEFORE the player's next generation was. A bounty adds one
     condition: the older generation's head must already be COLLECTED. A
     bounty rebuy settles the replaced generation's head before the purchase
     completes (fn_ca_settle_bounty_rebuy_generation_v1), so a proven
     generation is resolved only when its own bounty obligation exists and
     every obligation that names its hand or its chair is settled with its
     complete marker. A generation no obligation names never had its head
     collected: that head is still owed to whoever took the stack in that
     hand, and a rebuy adds the new head on top of it, so resolving it here
     would hand both heads to the player's next knocker. An obligation still
     owed would be collected against a player this claim is about to record
     under a newer head. Both stay refused, and the refusal raises an alert
     for a ruling. Only proven rows are resolved, only in the transaction
     that records the newer bust; anything unproven is refused exactly as
     before. */
  SELECT COALESCE(array_agg(c.id ORDER BY c.hand_number,c.id),ARRAY[]::uuid[])
    INTO v_rebought_generations
    FROM public.tournament_knockout_candidates c
   WHERE c.tournament_id=p_tournament_id
     AND c.eliminated_user_id=p_eliminated_user_id
     AND c.hand_number<v_candidate.hand_number
     AND c.state='pending'
     AND (
       -- DIAMOND PHASE 8: a Diamond rebuy or re-entry is a Diamond ledger
       -- row, not a chip leg; it proves the generation the same way.
       EXISTS (
       SELECT 1 FROM public.poker_diamond_tournament_ledger d
        WHERE d.user_id=p_eliminated_user_id
          AND d.tournament_id=p_tournament_id
          AND d.kind IN ('rebuy','reentry')
          AND d.amount>0
          AND d.created_at>c.created_at
          AND d.created_at<(
            SELECT n.created_at
              FROM public.tournament_knockout_candidates n
             WHERE n.tournament_id=p_tournament_id
               AND n.eliminated_user_id=p_eliminated_user_id
               AND n.hand_number>c.hand_number
             ORDER BY n.hand_number,n.id
             LIMIT 1))
       OR EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.from_entity_id=p_eliminated_user_id
          AND l.tournament_id=p_tournament_id
          AND l.category='rebuy'
          AND l.from_type='player_wallet'
          AND l.to_type='prize_liability'
          AND l.status='posted'
          AND l.amount>0
          AND l.created_at>c.created_at
          AND l.created_at<(
            SELECT n.created_at
              FROM public.tournament_knockout_candidates n
             WHERE n.tournament_id=p_tournament_id
               AND n.eliminated_user_id=p_eliminated_user_id
               AND n.hand_number>c.hand_number
             ORDER BY n.hand_number,n.id
             LIMIT 1)))
     AND EXISTS (
       SELECT 1 FROM public.tournament_bounty_obligations o
        WHERE o.tournament_id=p_tournament_id
          AND o.eliminated_user_id=p_eliminated_user_id
          AND o.table_id=c.table_id
          AND o.hand_id=c.hand_id
          AND o.hand_number=c.hand_number)
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_bounty_obligations o
        WHERE o.tournament_id=p_tournament_id
          AND o.eliminated_user_id=p_eliminated_user_id
          AND (o.hand_number=c.hand_number
               OR o.seat_joined_at=c.seat_joined_at)
          AND NOT (o.state='settled'
                   AND public.fn_bounty_obligation_has_complete_marker(o.id)));
  IF EXISTS (
    SELECT 1 FROM public.tournament_knockout_candidates c
     WHERE c.tournament_id=p_tournament_id
       AND c.eliminated_user_id=p_eliminated_user_id
       AND c.hand_number<v_candidate.hand_number
       AND c.state<>'rebought'
       AND c.id<>ALL(v_rebought_generations)
  ) THEN
    /* This refusal cannot clear by itself - no newer generation will make
       the older one proven - so it would hold the event open for ever
       without a word. It is written where the money board reads - once: one
       open alert per player. */
    INSERT INTO public.financial_alerts(severity,source,message,context)
    SELECT 'critical','knockout_door.payout_blocked_by_unrecordable_bust',
      'A busted player cannot be recorded, so the tournament cannot finish: '
        ||'an older knockout generation of theirs is neither rebought nor '
        ||'proven bought back (a posted rebuy leg after it and, in a bounty '
        ||'event, its head collected). That generation needs a ruling.',
      jsonb_build_object('tournament_id',p_tournament_id,'user_id',p_eliminated_user_id,
        'reason','unresolved_knockout_generation_chain',
        'hand_number',v_candidate.hand_number)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts fa
        WHERE fa.source='knockout_door.payout_blocked_by_unrecordable_bust'
          AND NOT fa.resolved
          AND fa.context->>'tournament_id'=p_tournament_id::text
          AND fa.context->>'user_id'=p_eliminated_user_id::text);
    RETURN jsonb_build_object(
      'ok',false,'reason','unresolved_knockout_generation_chain');
  END IF;
  IF v_candidate.state<>'pending' THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','knockout_generation_state_mismatch',
      'player_state',v_player.status,'candidate_state',v_candidate.state);
  END IF;
  IF v_candidate.rebuy_prompt_until IS NOT NULL
     AND v_candidate.rebuy_prompt_until>clock_timestamp() THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','rebuy_decision_open',
      'rebuy_prompt_until',v_candidate.rebuy_prompt_until);
  END IF;

  PERFORM 1
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.user_id=p_eliminated_user_id AND s.left_at IS NULL
   ORDER BY s.id FOR UPDATE OF s;
  SELECT count(*) INTO v_live_count
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.user_id=p_eliminated_user_id AND s.left_at IS NULL;
  IF v_live_count>1 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','knockout_generation_has_multiple_live_seats');
  END IF;
  IF v_live_count=1 THEN
    SELECT s.* INTO v_live
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id
       AND s.user_id=p_eliminated_user_id AND s.left_at IS NULL;
    IF v_live.stack IS DISTINCT FROM 0
       OR v_live.table_id IS DISTINCT FROM v_candidate.table_id
       OR v_live.id IS DISTINCT FROM v_candidate.seat_id
       OR v_live.joined_at IS DISTINCT FROM v_candidate.seat_joined_at THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','knockout_generation_has_new_live_seat');
    END IF;
  END IF;

  v_result:=public.fn_claim_bounty_legacy_candidate_20260907(
    p_tournament_id,p_eliminated_user_id,p_position,p_prize,p_table_id,
    p_hand_id,p_hand_number,p_seat_joined_at,p_knocker_user_id,p_claimants,
    p_bubble_refund,p_allow_existing_eliminated);
  IF coalesce((v_result->>'ok')::boolean,false)
     AND coalesce((v_result->>'claimed')::boolean,false)
  THEN
    UPDATE public.tournament_knockout_candidates c
       SET state='eliminated',
           resolved_at=coalesce(c.resolved_at,clock_timestamp())
     WHERE c.id=v_candidate.id AND c.state='pending';
    GET DIAGNOSTICS v_changed=ROW_COUNT;
    IF v_changed<>1 THEN
      RAISE EXCEPTION
        'bounty knockout generation changed while claim committed'
        USING ERRCODE='55000';
    END IF;
  END IF;
  -- The proven older generations close with the bust that proved them.
  IF coalesce((v_result->>'ok')::boolean,false)
     AND coalesce((v_result->>'claimed')::boolean,false)
     AND cardinality(v_rebought_generations)>0 THEN
    UPDATE public.tournament_knockout_candidates c
       SET state='rebought',resolved_at=clock_timestamp()
     WHERE c.id=ANY(v_rebought_generations)
       AND c.tournament_id=p_tournament_id
       AND c.eliminated_user_id=p_eliminated_user_id
       AND c.state='pending';
    GET DIAGNOSTICS v_changed=ROW_COUNT;
    IF v_changed<>cardinality(v_rebought_generations) THEN
      RAISE EXCEPTION
        'a bought-back knockout generation changed while the bounty claim committed'
        USING ERRCODE='55000';
    END IF;
    v_result:=v_result||jsonb_build_object(
      'rebought_generations',to_jsonb(v_rebought_generations));
  END IF;
  RETURN v_result;
END;
$function$
;

DO $post$
DECLARE s text := (SELECT prosrc FROM pg_proc WHERE oid =
  'public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)'::regprocedure);
BEGIN
  IF position('pg_advisory_xact_lock(' in s) = 0
     OR position('pg_advisory_xact_lock(' in s) > position('FROM public.tournaments t' in s) THEN
    RAISE EXCEPTION 'BOUNTY_LANE_RESULT_CHANGED';
  END IF;
END $post$;

COMMIT;
