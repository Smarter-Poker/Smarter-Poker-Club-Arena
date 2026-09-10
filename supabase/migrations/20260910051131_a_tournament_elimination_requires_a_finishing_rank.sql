-- A missing rank cannot claim an elimination or close its seat.
-- Valid ranks, exact hand evidence, replay and all money paths are unchanged.
BEGIN;
DO $guard$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
   WHERE oid=to_regprocedure('public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)');
  IF v_md5 IS NULL OR v_md5 NOT IN ('04a2e93dd8afe35fbc0cdd2829daf0f8','b4937067d9bf337e1466095b9e1d5424') THEN
    RAISE EXCEPTION 'Unexpected atomic elimination body; review current source before applying';
  END IF;
END;
$guard$;

CREATE OR REPLACE FUNCTION public.fn_eliminate_tournament_player_atomic(p_tournament_id uuid, p_user_id uuid, p_position integer, p_prize numeric, p_bubble_refund numeric DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_player public.tournament_players%ROWTYPE;
  v_candidate public.tournament_knockout_candidates%ROWTYPE;
  v_atomic public.hand_atomic_commits%ROWTYPE;
  v_live public.table_seats%ROWTYPE;
  v_evidence_stack numeric;
  v_settlement_hand_text text;
  v_settlement_hand_id uuid;
  v_live_count integer;
  v_changed integer;
  v_result jsonb;
BEGIN
  IF p_position IS NULL OR p_position<2 OR p_prize IS NULL OR p_prize<0
     OR p_bubble_refund IS NULL OR p_bubble_refund<0 THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_place_or_prize');
  END IF;
  IF p_bubble_refund<>0 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','bubble_refund_requires_finalized_batch');
  END IF;

  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  IF v_t.status<>'RUNNING' THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_running');
  END IF;
  IF coalesce(v_t.is_bounty,false) OR coalesce(v_t.is_pko,false)
     OR coalesce(v_t.is_mystery_bounty,false) THEN
    RETURN jsonb_build_object('ok',false,'reason','bounty_requires_outbox_claim');
  END IF;

  SELECT * INTO v_player FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','player_not_found');
  END IF;
  IF v_player.status='winner' THEN
    RETURN jsonb_build_object('ok',false,'reason','player_is_winner');
  END IF;
  IF v_player.status NOT IN ('playing','eliminated')
     OR (v_player.status='playing' AND coalesce(v_player.chips,0)>0) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_busted');
  END IF;

  PERFORM 1
    FROM public.tournament_knockout_candidates c
   WHERE c.tournament_id=p_tournament_id
     AND c.eliminated_user_id=p_user_id
   ORDER BY c.hand_number,c.id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','knockout_candidate_required');
  END IF;

  -- The owner-only resolver selects this player's latest immutable entry
  -- generation and already proves both durable halves of its accepted hand.
  -- Re-read every identity here so this transaction is independently bound to
  -- candidate(history hand) -> atomic(internal settlement hand) -> receipt.
  SELECT c.* INTO v_candidate
    FROM public.tournament_knockout_candidates c
   WHERE c.id=public.fn_ca_latest_committed_knockout_candidate(
     p_tournament_id,p_user_id);
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','committed_knockout_candidate_not_found');
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
  -- The settlement owner uses md5(... )::uuid for its stable internal key;
  -- validate PostgreSQL's canonical UUID shape without inventing RFC nibbles.
  IF coalesce(v_settlement_hand_text,'')
       !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_atomic.stack_result->>'table_id'<>v_candidate.table_id::text
     OR coalesce(v_atomic.stack_result->>'hand_number','')
          !~ '^[0-9]+$'
     OR (v_atomic.stack_result->>'hand_number')::bigint<>
          v_candidate.hand_number
     OR coalesce(v_atomic.stack_result->'written'->>p_user_id::text,'')
          !~ '^-?[0-9]+([.][0-9]+)?$'
     OR (v_atomic.stack_result->'written'->>p_user_id::text)::numeric<>0 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','atomic_knockout_candidate_identity_conflict');
  END IF;
  v_settlement_hand_id:=v_settlement_hand_text::uuid;

  SELECT (k.result->'written'->>p_user_id::text)::numeric
    INTO v_evidence_stack
    FROM public.settlement_idempotency_keys k
   WHERE k.table_id=v_candidate.table_id
     AND k.hand_id=v_settlement_hand_id
     AND k.status='succeeded'
     AND k.completed_at IS NOT NULL
     AND k.result->>'table_id'=v_candidate.table_id::text
     AND coalesce(k.result->>'hand_number','') ~ '^[0-9]+$'
     AND (k.result->>'hand_number')::bigint=v_candidate.hand_number
     AND coalesce(k.result->'written'->>p_user_id::text,'')
           ~ '^-?[0-9]+([.][0-9]+)?$';
  IF NOT FOUND OR v_evidence_stack<>0 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','exact_knockout_settlement_receipt_missing');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournament_knockout_candidates c
     WHERE c.tournament_id=p_tournament_id
       AND c.eliminated_user_id=p_user_id
       AND c.hand_number>v_candidate.hand_number
  ) THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','latest_knockout_evidence_chain_conflict');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_knockout_candidates c
     WHERE c.tournament_id=p_tournament_id
       AND c.eliminated_user_id=p_user_id
       AND c.hand_number<v_candidate.hand_number
       AND c.state<>'rebought'
  ) THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','unresolved_knockout_generation_chain');
  END IF;

  IF (v_player.status='playing' AND v_candidate.state<>'pending')
     OR (v_player.status='eliminated' AND v_candidate.state<>'eliminated') THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','knockout_generation_state_mismatch',
      'player_state',v_player.status,'candidate_state',v_candidate.state);
  END IF;
  IF v_candidate.state='pending'
     AND v_candidate.rebuy_prompt_until IS NOT NULL
     AND v_candidate.rebuy_prompt_until>clock_timestamp() THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','rebuy_decision_open',
      'rebuy_prompt_until',v_candidate.rebuy_prompt_until);
  END IF;

  PERFORM 1
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.user_id=p_user_id AND s.left_at IS NULL
   ORDER BY s.id FOR UPDATE OF s;
  SELECT count(*) INTO v_live_count
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.user_id=p_user_id AND s.left_at IS NULL;
  IF v_live_count>1 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','knockout_generation_has_multiple_live_seats');
  END IF;
  IF v_live_count=1 THEN
    SELECT s.* INTO v_live
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id
       AND s.user_id=p_user_id AND s.left_at IS NULL;
    IF v_live.stack IS DISTINCT FROM 0
       OR v_live.table_id IS DISTINCT FROM v_candidate.table_id
       OR v_live.id IS DISTINCT FROM v_candidate.seat_id
       OR v_live.joined_at IS DISTINCT FROM v_candidate.seat_joined_at THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','knockout_generation_has_new_live_seat');
    END IF;
  END IF;

  v_result:=public.fn_eliminate_player_legacy_candidate_20260907(
    p_tournament_id,p_user_id,p_position,p_prize,p_bubble_refund);
  IF coalesce((v_result->>'ok')::boolean,false)
     AND v_player.status='playing' THEN
    UPDATE public.tournament_knockout_candidates c
       SET state='eliminated',
           resolved_at=coalesce(c.resolved_at,clock_timestamp())
     WHERE c.id=v_candidate.id AND c.state='pending';
    GET DIAGNOSTICS v_changed=ROW_COUNT;
    IF v_changed<>1 THEN
      RAISE EXCEPTION 'knockout generation changed while elimination committed'
        USING ERRCODE='serialization_failure';
    END IF;
  END IF;
  RETURN v_result;
END;
$function$;
COMMIT;
