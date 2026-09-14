-- BYTE-EXACT CAPTURE of the live function bodies these probes run, read from
-- production with pg_get_functiondef on 2026-09-11 (read-only). The migration
-- under test pins the md5 of every body it replaces or depends on, so if this
-- capture drifts from production the migration itself refuses to apply here.
-- Owner and EXECUTE grants are restated to match the live ACLs.
\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION public.fn_safe_jsonb_array(p_text text)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v jsonb;
BEGIN
  IF p_text IS NULL OR btrim(p_text) = '' THEN
    RETURN '[]'::jsonb;
  END IF;
  BEGIN
    v := p_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN '[]'::jsonb;
  END;
  IF v IS NULL OR jsonb_typeof(v) <> 'array' THEN
    RETURN '[]'::jsonb;
  END IF;
  RETURN v;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_safe_jsonb_array(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_safe_jsonb_array(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_tournament_payout_key_is_place_evidence(p_tournament_id uuid, p_idempotency_key text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'place'
       AND p_idempotency_key LIKE
           'tourney:' || p_tournament_id::text || ':obl:' || o.id::text || ':%'
  );
$function$;
REVOKE ALL ON FUNCTION public.fn_tournament_payout_key_is_place_evidence(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_tournament_payout_key_is_place_evidence(uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_stamp_tournament_elimination_sequence()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status::text = 'eliminated' THEN
      NEW.elimination_sequence := nextval(
        'public.tournament_player_elimination_sequence'::regclass);
    ELSE
      NEW.elimination_sequence := NULL;
    END IF;
  ELSIF OLD.status::text IS DISTINCT FROM 'eliminated'
        AND NEW.status::text = 'eliminated' THEN
    NEW.elimination_sequence := nextval(
      'public.tournament_player_elimination_sequence'::regclass);
  ELSIF OLD.status::text = 'eliminated'
        AND NEW.status::text IS DISTINCT FROM 'eliminated' THEN
    NEW.elimination_sequence := NULL;
  ELSIF NEW.elimination_sequence IS DISTINCT FROM OLD.elimination_sequence THEN
    RAISE EXCEPTION 'elimination_sequence is database-owned'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_stamp_tournament_elimination_sequence() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.fn_tournament_elimination_has_a_place()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status text;
  v_position integer;
  v_tournament text;
BEGIN
  /* THE KNOCKOUT DOOR OWNS EVERY BUST A HAND TOOK (2026-09-10). An eliminated
     row is a finishing place: fn_complete_tournament_entry_reprice reads a row
     without one as an unfinished reprice and refuses the event for ever, and
     the engine's elimination sweep will not run until that proof passes.

     A DEFERRED CHECK READS THE ROW AT COMMIT, NOT THE STATEMENT. NEW is the
     tuple the firing statement produced, so a settlement that writes the status
     first and the place second would be refused on a row that is about to be
     correct - which is what happened to five satellites between 07:24 and
     07:52. Re-read; if the row is gone, there is nothing to judge. */
  SELECT tp.status, tp.position INTO v_status, v_position
    FROM public.tournament_players tp
   WHERE tp.id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF v_status = 'eliminated' AND v_position IS NULL THEN
    SELECT t.status INTO v_tournament FROM public.tournaments t WHERE t.id = NEW.tournament_id;
    IF v_tournament IN ('RUNNING', 'COMPLETING', 'COMPLETED') THEN
      RAISE EXCEPTION 'tournament % player % was recorded eliminated with no finishing place; a bust is recorded through the knockout door, which assigns the place',
        NEW.tournament_id, NEW.user_id USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_tournament_elimination_has_a_place() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_tournament_elimination_has_a_place() TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_latest_committed_knockout_candidate(p_tournament_id uuid, p_user_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_table_id uuid;
  v_hand_number bigint;
  v_candidate_id uuid;
  v_candidate_hand_id uuid;
  v_settlement_hand_id uuid;
  v_settlement_hand_text text;
  v_atomic_stack text;
  v_settlement_stack text;
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'tournament and player are required for knockout evidence'
      USING ERRCODE='22023';
  END IF;

  SELECT c.id,c.table_id,c.hand_number,c.hand_id
    INTO v_candidate_id,v_table_id,v_hand_number,v_candidate_hand_id
    FROM public.tournament_knockout_candidates c
   WHERE c.tournament_id=p_tournament_id
     AND c.eliminated_user_id=p_user_id
     AND c.stack_after=0
   ORDER BY c.hand_number DESC,c.id DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'REBUY_KNOCKOUT_CANDIDATE_REQUIRED: no zero-stack generation names this player'
      USING ERRCODE='55000';
  END IF;

  SELECT a.stack_result->>'hand_id',
         a.stack_result->'written'->>p_user_id::text
    INTO v_settlement_hand_text,v_atomic_stack
    FROM public.hand_atomic_commits a
   WHERE a.table_id=v_table_id
     AND a.hand_number=v_hand_number
     AND a.hand_id=v_candidate_hand_id;
  -- fn_ca_settle_hand_stacks_absolute derives this id from md5(... )::uuid.
  -- PostgreSQL UUIDs are canonical hexadecimal but that deterministic hash is
  -- not required to carry RFC version/variant nibbles.
  IF NOT FOUND
     OR COALESCE(v_settlement_hand_text,'')
          !~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(v_atomic_stack,'')!~'^-?[0-9]+([.][0-9]+)?$' THEN
    RAISE EXCEPTION
      'REBUY_ATOMIC_HAND_REQUIRED: candidate is not the exact accepted zero hand'
      USING ERRCODE='P0404';
  END IF;
  IF v_atomic_stack::numeric<>0 THEN
    RAISE EXCEPTION
      'REBUY_ATOMIC_HAND_REQUIRED: candidate hand did not commit a zero stack'
      USING ERRCODE='P0404';
  END IF;
  v_settlement_hand_id:=v_settlement_hand_text::uuid;

  SELECT k.result->'written'->>p_user_id::text
    INTO v_settlement_stack
    FROM public.settlement_idempotency_keys k
   WHERE k.table_id=v_table_id
     AND k.hand_id=v_settlement_hand_id
     AND k.status='succeeded'
     AND k.completed_at IS NOT NULL
     AND k.result->>'table_id'=v_table_id::text
     AND COALESCE(k.result->>'hand_number','')~'^[0-9]+$'
     AND (k.result->>'hand_number')::bigint=v_hand_number;
  IF NOT FOUND
     OR COALESCE(v_settlement_stack,'')!~'^-?[0-9]+([.][0-9]+)?$' THEN
    RAISE EXCEPTION
      'REBUY_SETTLEMENT_RECEIPT_REQUIRED: atomic zero hand has no exact successful settlement'
      USING ERRCODE='P0404';
  END IF;
  IF v_settlement_stack::numeric<>0 THEN
    RAISE EXCEPTION
      'REBUY_SETTLEMENT_RECEIPT_REQUIRED: exact settlement did not commit a zero stack'
      USING ERRCODE='P0404';
  END IF;

  RETURN v_candidate_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_latest_committed_knockout_candidate(uuid,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.fn_eliminate_player_legacy_candidate_20260907(p_tournament_id uuid, p_user_id uuid, p_position integer, p_prize numeric, p_bubble_refund numeric DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_p public.tournament_players%ROWTYPE;
  v_changed integer;
  v_released_tables uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_position < 2 OR p_prize IS NULL OR p_prize < 0
     OR p_bubble_refund IS NULL OR p_bubble_refund < 0 THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_place_or_prize');
  END IF;
  IF p_bubble_refund <> 0 THEN
    RETURN jsonb_build_object('ok',false,'reason','bubble_refund_requires_finalized_batch');
  END IF;
  SELECT * INTO v_t FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','tournament_not_found'); END IF;
  IF v_t.status <> 'RUNNING' THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_running');
  END IF;
  IF COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
     OR COALESCE(v_t.is_mystery_bounty,false) THEN
    RETURN jsonb_build_object('ok',false,'reason','bounty_requires_outbox_claim');
  END IF;
  SELECT * INTO v_p FROM public.tournament_players
   WHERE tournament_id=p_tournament_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','player_not_found'); END IF;
  IF v_p.status = 'winner' THEN
    RETURN jsonb_build_object('ok',false,'reason','player_is_winner');
  END IF;
  IF v_p.status = 'eliminated' THEN
    IF v_p.position IS DISTINCT FROM p_position
       OR round(COALESCE(v_p.prize,0),2) <> round(p_prize,2) THEN
      RETURN jsonb_build_object('ok',false,'reason','elimination_identity_conflict');
    END IF;
    RETURN jsonb_build_object('ok',true,'already',true,'position',v_p.position,'prize',v_p.prize);
  END IF;
  IF v_p.status <> 'playing' OR COALESCE(v_p.chips,0) > 0 THEN
    RETURN jsonb_build_object('ok',false,'reason','not_busted');
  END IF;
  UPDATE public.tournament_players
     SET status='eliminated',position=p_position,prize=round(p_prize,2),eliminated_at=now()
   WHERE tournament_id=p_tournament_id AND user_id=p_user_id
     AND status='playing' AND COALESCE(chips,0)<=0;
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  IF v_changed <> 1 THEN
    RAISE EXCEPTION 'zero-stack elimination CAS changed % rows',v_changed
      USING ERRCODE='serialization_failure';
  END IF;

  WITH released AS (
    UPDATE public.table_seats s SET left_at=now()
      FROM public.tables tb
     WHERE tb.id=s.table_id AND tb.tournament_id=p_tournament_id
       AND s.user_id=p_user_id AND s.left_at IS NULL
    RETURNING s.table_id
  ) SELECT COALESCE(array_agg(DISTINCT table_id),ARRAY[]::uuid[])
      INTO v_released_tables FROM released;
  UPDATE public.tables tb SET current_players=(
    SELECT count(*) FROM public.table_seats s WHERE s.table_id=tb.id AND s.left_at IS NULL)
   WHERE tb.id=ANY(v_released_tables);
  PERFORM public.fn_sync_seat_first_player_count(p_tournament_id);

  RETURN jsonb_build_object('ok',true,'claimed',true,'position',p_position,
                            'prize',round(p_prize,2),'bubble_refund',0);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric) FROM PUBLIC;

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
REVOKE ALL ON FUNCTION public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_normalize_tournament_final_standings(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status              text;
  v_player_count        integer := 0;
  v_ranked_count        integer := 0;
  v_distinct_positions integer := 0;
  v_min_position        integer := 0;
  v_max_position        integer := 0;
  v_winner_count        integer := 0;
  v_winner_place_one    integer := 0;
  v_nonterminal_count   integer := 0;
  v_missing_bust_time   integer := 0;
  v_negative_prizes     integer := 0;
  v_evidence_invalid    integer := 0;
  v_orphan_payout_keys  integer := 0;
  v_canonical_mismatches integer := 0;
  v_updated             integer := 0;
  v_batch_exists        boolean := false;
  v_failure             text;
  v_failure_state       text;
BEGIN
  IF p_tournament_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_id_required',
                              'retryable', false);
  END IF;

  SELECT t.status INTO v_status
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found',
                              'retryable', false);
  END IF;
  IF v_status NOT IN ('COMPLETING', 'COMPLETED') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_completing',
                              'status', v_status, 'retryable', false);
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id AND p.source = 'final_table_deal'
  ) OR EXISTS (
    SELECT 1 FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'final_table_deal'
  ) THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'final_table_deal_has_its_own_standings',
                              'retryable', false);
  END IF;

  PERFORM 1
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
   ORDER BY tp.id
   FOR UPDATE;

  SELECT count(*), count(tp.position), count(DISTINCT tp.position),
         COALESCE(min(tp.position), 0), COALESCE(max(tp.position), 0),
         count(*) FILTER (WHERE tp.status = 'winner'),
         count(*) FILTER (WHERE tp.status = 'winner' AND tp.position = 1),
         count(*) FILTER (WHERE tp.status NOT IN ('winner', 'eliminated')),
         count(*) FILTER (WHERE tp.status = 'eliminated' AND tp.eliminated_at IS NULL),
         count(*) FILTER (WHERE round(COALESCE(tp.prize, 0) * 100)::bigint < 0)
    INTO v_player_count, v_ranked_count, v_distinct_positions,
         v_min_position, v_max_position, v_winner_count,
         v_winner_place_one, v_nonterminal_count, v_missing_bust_time,
         v_negative_prizes
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;

  IF v_player_count = 0 OR v_winner_count <> 1 OR v_winner_place_one <> 1
     OR v_nonterminal_count <> 0 OR v_missing_bust_time <> 0
     OR v_negative_prizes <> 0 THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'final_result_is_not_proven',
      'players', v_player_count, 'winners', v_winner_count,
      'winner_at_place_one', v_winner_place_one,
      'nonterminal_players', v_nonterminal_count,
      'eliminated_without_time', v_missing_bust_time,
      'negative_prizes', v_negative_prizes, 'retryable', false);
  END IF;

  /* A generic obligation-key payout is classifiable only while its exact
     durable obligation still exists. Silently ignoring an orphan would let a
     deleted place obligation look unpaid and allocate the same chips again;
     guessing that every generic key is a place would instead misclassify
     Bubble Protection and final-table deals. Refuse both ambiguities before
     this result-only function can renumber a single row. */
  SELECT count(*) INTO v_orphan_payout_keys
    FROM (
      SELECT p.idempotency_key
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p.idempotency_key LIKE
             'tourney:' || p_tournament_id::text || ':obl:%'
         AND NOT EXISTS (
           SELECT 1
             FROM public.tournament_obligations o
            WHERE o.tournament_id = p_tournament_id
              AND p.idempotency_key LIKE
                  'tourney:' || p_tournament_id::text || ':obl:' || o.id::text || ':%'
         )
       GROUP BY p.idempotency_key
      HAVING abs(round(sum(p.amount), 2)) > 0.005
    ) orphaned;
  IF v_orphan_payout_keys > 0 THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'unattributed_obligation_key_evidence',
      'keys', v_orphan_payout_keys, 'retryable', false);
  END IF;

  /* Chronology is the result authority: the champion is first and eliminated
     rows run from latest bust in second through earliest bust in last. A
     provisional place/prize is only an estimate. Historical payout evidence
     may prove that a canonical result was already paid; it may never redefine
     that result. Any paid player/place that disagrees requires manual review
     because this function neither claws money back nor moves it to a different
     recipient. */
  WITH eliminated AS (
    SELECT tp.id, tp.user_id,
           v_player_count - (row_number() OVER (
             ORDER BY tp.eliminated_at ASC, tp.id ASC
           ))::integer + 1 AS canonical_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status = 'eliminated'
  ),
  canonical AS (
    SELECT tp.id, tp.user_id, 1 AS canonical_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id AND tp.status = 'winner'
    UNION ALL
    SELECT e.id, e.user_id, e.canonical_position FROM eliminated e
  ),
  evidence AS (
    SELECT p.position, p.user_id
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND (p.source IN ('structure', 'reconcile', 'hu_shortfall',
                         'late_reg_adjustment', 'clawback', 'spin_backpay',
                         'overlay_backpay')
            OR public.fn_tournament_payout_key_is_place_evidence(
                 p.tournament_id, p.idempotency_key))
     GROUP BY p.position, p.user_id
    HAVING abs(round(sum(p.amount), 2)) > 0.005
  )
  SELECT count(*) INTO v_evidence_invalid
    FROM evidence e
   WHERE e.position IS NULL OR NOT EXISTS (
     SELECT 1 FROM canonical c
      WHERE c.canonical_position = e.position AND c.user_id = e.user_id);
  IF v_evidence_invalid > 0 THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'paid_positions_do_not_match_final_results',
      'invalid_payout_groups', v_evidence_invalid, 'retryable', false);
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.tournament_place_settlement_batches b
     WHERE b.tournament_id = p_tournament_id
  ) INTO v_batch_exists;

  WITH eliminated AS (
    SELECT tp.id,
           v_player_count - (row_number() OVER (
             ORDER BY tp.eliminated_at ASC, tp.id ASC
           ))::integer + 1 AS canonical_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status = 'eliminated'
  ),
  canonical AS (
    SELECT tp.id, 1 AS canonical_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id AND tp.status = 'winner'
    UNION ALL
    SELECT e.id, e.canonical_position FROM eliminated e
  )
  SELECT count(*) INTO v_canonical_mismatches
    FROM canonical c
    JOIN public.tournament_players tp ON tp.id = c.id
   WHERE tp.position IS DISTINCT FROM c.canonical_position;

  /* A prepared or completed result is immutable. It may be observed when it
     is already exact, but this repair door never rewrites it. */
  IF v_batch_exists OR v_status = 'COMPLETED' THEN
    IF v_ranked_count = v_player_count
       AND v_distinct_positions = v_player_count
       AND v_min_position = 1 AND v_max_position = v_player_count
       AND v_canonical_mismatches = 0 THEN
      RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                                'players', v_player_count, 'updated', 0,
                                'already_normalized', true, 'retryable', false);
    END IF;
    RETURN jsonb_build_object('ok', false,
                              'reason', 'frozen_final_standings_are_invalid',
                              'retryable', false);
  END IF;

  IF v_canonical_mismatches = 0 THEN
    RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                              'players', v_player_count, 'updated', 0,
                              'already_normalized', true, 'retryable', false);
  END IF;

  BEGIN
    /* Clear every eliminated position first. Besides making the assignment
       deterministic even when the old ladder happened to be contiguous-but-
       wrong, this prevents the collision watcher from logging transient swaps.
       Both statements live in this exception subtransaction and therefore
       publish together or roll back together. */
    UPDATE public.tournament_players tp
       SET position = NULL
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status = 'eliminated';

    WITH assignments AS (
      SELECT tp.id,
             v_player_count - (row_number() OVER (
               ORDER BY tp.eliminated_at ASC, tp.id ASC
             ))::integer + 1 AS position
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status = 'eliminated'
    )
    UPDATE public.tournament_players tp
       SET position = a.position
      FROM assignments a
     WHERE tp.id = a.id AND tp.position IS DISTINCT FROM a.position;
    GET DIAGNOSTICS v_updated = ROW_COUNT;

    SELECT count(*), count(tp.position), count(DISTINCT tp.position),
           COALESCE(min(tp.position), 0), COALESCE(max(tp.position), 0),
           count(*) FILTER (WHERE tp.status = 'winner'),
           count(*) FILTER (WHERE tp.status = 'winner' AND tp.position = 1),
           count(*) FILTER (WHERE tp.status NOT IN ('winner', 'eliminated'))
      INTO v_player_count, v_ranked_count, v_distinct_positions,
           v_min_position, v_max_position, v_winner_count,
           v_winner_place_one, v_nonterminal_count
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id;

    WITH eliminated AS (
      SELECT tp.id,
             v_player_count - (row_number() OVER (
               ORDER BY tp.eliminated_at ASC, tp.id ASC
             ))::integer + 1 AS canonical_position
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status = 'eliminated'
    )
    SELECT count(*) INTO v_canonical_mismatches
      FROM eliminated e
      JOIN public.tournament_players tp ON tp.id = e.id
     WHERE tp.position IS DISTINCT FROM e.canonical_position;
    IF v_player_count = 0 OR v_ranked_count <> v_player_count
       OR v_distinct_positions <> v_player_count
       OR v_min_position <> 1 OR v_max_position <> v_player_count
       OR v_winner_count <> 1 OR v_winner_place_one <> 1
       OR v_nonterminal_count <> 0 OR v_canonical_mismatches <> 0 THEN
      RAISE EXCEPTION USING
        MESSAGE = 'the complete final-standings assignment did not validate',
        ERRCODE = '23514';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_failure = MESSAGE_TEXT,
                            v_failure_state = RETURNED_SQLSTATE;
  END;

  IF v_failure IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'standings_write_aborted',
                              'detail', v_failure, 'sqlstate', v_failure_state,
                              'retryable', v_failure_state IN ('40001', '40P01', '55P03'));
  END IF;
  RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                            'players', v_player_count, 'updated', v_updated,
                            'retryable', false);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_normalize_tournament_final_standings(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_normalize_tournament_final_standings(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_prepare_tournament_place_obligations(p_tournament_id uuid, p_source text DEFAULT 'engine.atomicPlaceSettlement'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_t                    record;
  v_batch                public.tournament_place_settlement_batches%ROWTYPE;
  v_existing             public.tournament_obligations%ROWTYPE;
  v_source               text := COALESCE(NULLIF(btrim(p_source), ''), 'engine.atomicPlaceSettlement');
  v_struct               jsonb := '[]'::jsonb;
  v_trimmed              jsonb := '[]'::jsonb;
  v_plan                 jsonb := '[]'::jsonb;
  v_plan_fingerprint     text;
  v_field_count          integer := 0;
  v_position_count       integer := 0;
  v_distinct_positions   integer := 0;
  v_min_position         integer := 0;
  v_max_position         integer := 0;
  v_winner_count         integer := 0;
  v_winner_place_one     integer := 0;
  v_nonterminal_count    integer := 0;
  v_missing_bust_time    integer := 0;
  v_canonical_mismatches integer := 0;
  v_expected_count       integer := 0;
  v_actual_count         integer := 0;
  v_open_count           integer := 0;
  v_conflicts            integer := 0;
  v_holders              integer := 0;
  v_last_place           integer := 0;
  v_total_bp             bigint := 0;
  v_pool_cents           bigint := 0;
  v_remaining_cents      bigint := 0;
  v_expected_cents       bigint := 0;
  v_expected_total_cents bigint := 0;
  v_player_prize_cents   bigint := 0;
  v_seeded_paid          numeric := 0;
  v_seeded_total_cents   bigint := 0;
  v_required_unpaid_cents bigint := 0;
  v_total_required_unpaid_cents bigint := 0;
  v_escrow_balance       numeric := 0;
  v_escrow_enforced      boolean := false;
  v_escrow_found         boolean := false;
  v_wrong_recipients     integer := 0;
  v_bubble_user          uuid;
  v_bubble_holders       integer := 0;
  v_bubble_obligations   integer := 0;
  v_bubble_matching      integer := 0;
  v_bubble_owed          numeric := 0;
  v_bubble_paid          numeric := 0;
  v_bubble_evidence      numeric := 0;
  v_bubble_evidence_exists boolean := false;
  v_bubble_required      boolean := false;
  v_bubble_contract_required boolean := false;
  v_bubble_obligation_id uuid;
  v_bubble_source        text;
  v_bubble_settled_at    timestamptz;
  v_bubble_unpaid_cents  bigint := 0;
  v_bubble_needs_insert  boolean := false;
  v_actual_total         numeric := 0;
  v_actual_fingerprint   text;
  v_holder               uuid;
  v_holder_club          uuid;
  v_normalized           jsonb;
  v_write_failure        text;
  v_write_state          text;
  r                      record;
BEGIN
  IF p_tournament_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_id_required',
                              'retryable', false);
  END IF;

  SELECT t.id, t.name, t.status, round(COALESCE(t.prize_pool, 0), 2) AS prize_pool,
         round(COALESCE(t.guaranteed_prize, 0), 2) AS guaranteed_prize,
         COALESCE(t.prize_pool_finalized, false) AS prize_pool_finalized,
         t.payout_structure, t.variant, t.tournament_type, t.satellite_target_id,
         t.spin_multiplier, COALESCE(t.bubble_protection, false) AS bubble_protection,
         round(COALESCE(t.buy_in_amount, 0), 2) AS buy_in_amount
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found',
                              'retryable', false);
  END IF;
  IF lower(COALESCE(v_t.variant, '')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type, '')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'satellite_has_its_own_settlement',
                              'retryable', false);
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id AND p.source = 'final_table_deal'
  ) OR EXISTS (
    SELECT 1 FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'final_table_deal'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'final_table_deal_has_its_own_settlement',
                              'retryable', false);
  END IF;
  IF COALESCE(v_t.status, '') NOT IN ('COMPLETING', 'COMPLETED') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_completing',
                              'status', v_t.status, 'retryable', false);
  END IF;
  IF NOT v_t.prize_pool_finalized
     OR v_t.prize_pool + 0.005 < v_t.guaranteed_prize THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'prize_pool_is_not_funded_and_finalized',
                              'prize_pool', v_t.prize_pool,
                              'guaranteed_prize', v_t.guaranteed_prize,
                              'prize_pool_finalized', v_t.prize_pool_finalized,
                              'retryable', false);
  END IF;

  /* Normalization is part of the database money door, not merely an engine
     convention. A caller cannot skip the result RPC, publish a contiguous but
     chronologically false ladder, and have the batch freeze/pay it. The nested
     call takes the same tournament/player locks and moves no money. */
  v_normalized := public.fn_normalize_tournament_final_standings(p_tournament_id);
  IF NOT COALESCE((v_normalized->>'ok')::boolean, false) THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'final_standings_normalization_failed',
      'normalization_reason', v_normalized->>'reason',
      'detail', v_normalized->>'detail',
      'retryable', COALESCE((v_normalized->>'retryable')::boolean, false));
  END IF;

  /* Serialize result edits already in flight. New registrations are rejected
     by the tournament lifecycle once status is COMPLETING. */
  PERFORM 1
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
   ORDER BY tp.id
   FOR UPDATE;

  SELECT count(*), count(tp.position), count(DISTINCT tp.position),
         COALESCE(min(tp.position), 0), COALESCE(max(tp.position), 0),
         count(*) FILTER (WHERE tp.status = 'winner'),
         count(*) FILTER (WHERE tp.status = 'winner' AND tp.position = 1),
         count(*) FILTER (WHERE tp.status NOT IN ('winner', 'eliminated')),
         count(*) FILTER (WHERE tp.status = 'eliminated' AND tp.eliminated_at IS NULL)
    INTO v_field_count, v_position_count, v_distinct_positions,
         v_min_position, v_max_position, v_winner_count,
         v_winner_place_one, v_nonterminal_count, v_missing_bust_time
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;

  IF v_field_count = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_has_no_players',
                              'retryable', false);
  END IF;
  IF v_position_count <> v_field_count OR v_distinct_positions <> v_field_count
     OR v_min_position <> 1 OR v_max_position <> v_field_count
     OR v_winner_count <> 1 OR v_winner_place_one <> 1
     OR v_nonterminal_count <> 0 OR v_missing_bust_time <> 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'standings_are_not_final_unique_and_terminal',
                              'players', v_field_count, 'ranked', v_position_count,
                              'distinct_positions', v_distinct_positions,
                              'min_position', v_min_position,
                              'max_position', v_max_position,
                              'winners', v_winner_count,
                              'winner_at_place_one', v_winner_place_one,
                              'nonterminal_players', v_nonterminal_count,
                              'eliminated_without_time', v_missing_bust_time,
                              'retryable', false);
  END IF;

  WITH eliminated AS (
    SELECT tp.id,
           v_field_count - (row_number() OVER (
             ORDER BY tp.eliminated_at ASC, tp.id ASC
           ))::integer + 1 AS canonical_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id AND tp.status = 'eliminated'
  )
  SELECT count(*) INTO v_canonical_mismatches
    FROM eliminated e
    JOIN public.tournament_players tp ON tp.id = e.id
   WHERE tp.position IS DISTINCT FROM e.canonical_position;
  IF v_canonical_mismatches <> 0 THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'standings_are_not_in_canonical_bust_order',
                              'mismatches', v_canonical_mismatches,
                              'retryable', false);
  END IF;

  v_pool_cents := round(v_t.prize_pool * 100)::bigint;

  IF v_pool_cents > 0 THEN
    BEGIN
      /* A Spin's drawn tier outranks its creation-time placeholder. This is
         the same source used by resolvePayoutStructure in the engine. */
      IF lower(COALESCE(v_t.variant, '')) = 'spin'
         OR upper(COALESCE(v_t.tournament_type, '')) = 'SPIN' THEN
        IF v_t.spin_multiplier IS NULL OR v_t.spin_multiplier <= 0 THEN
          RETURN jsonb_build_object('ok', false,
                                    'reason', 'spin_multiplier_is_not_persisted',
                                    'retryable', false);
        END IF;
        SELECT l.structure INTO v_struct
          FROM public.spin_payout_ladder l
         WHERE l.multiplier = v_t.spin_multiplier;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false,
                                    'reason', 'spin_multiplier_has_no_canonical_ladder',
                                    'spin_multiplier', v_t.spin_multiplier,
                                    'retryable', false);
        END IF;
      ELSE
        v_struct := public.fn_safe_jsonb_array(v_t.payout_structure);
      END IF;
      IF jsonb_array_length(v_struct) = 0 OR EXISTS (
        SELECT 1
          FROM jsonb_array_elements(v_struct) e
         WHERE jsonb_typeof(e) <> 'object'
            OR COALESCE(e->>'place', '') !~ '^[1-9][0-9]*$'
            OR COALESCE(e->>'percentage', '') !~ '^[0-9]+([.][0-9]+)?$'
            OR (e->>'percentage')::numeric < 0
      ) THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'payout_structure_is_invalid',
                                  'retryable', false);
      END IF;

      SELECT COALESCE(jsonb_agg(e ORDER BY (e->>'place')::integer), '[]'::jsonb)
        INTO v_trimmed
        FROM jsonb_array_elements(v_struct) e
       WHERE (e->>'place')::integer <= v_field_count;

      SELECT count(*), count(DISTINCT (e->>'place')::integer),
             COALESCE(min((e->>'place')::integer), 0),
             COALESCE(max((e->>'place')::integer), 0),
             COALESCE(sum(round((e->>'percentage')::numeric * 100)::bigint), 0)
        INTO v_expected_count, v_conflicts, v_position_count, v_last_place, v_total_bp
        FROM jsonb_array_elements(v_trimmed) e;

      IF v_expected_count = 0 OR v_conflicts <> v_expected_count
         OR v_position_count <> 1 OR v_last_place <> v_expected_count
         OR v_total_bp <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'payout_places_are_not_contiguous',
                                  'places', v_expected_count, 'last_place', v_last_place,
                                  'retryable', false);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'payout_structure_is_invalid',
                                'detail', SQLERRM, 'retryable', false);
    END;

    v_remaining_cents := v_pool_cents;
    FOR r IN
      SELECT (e->>'place')::integer AS place,
             round((e->>'percentage')::numeric * 100)::bigint AS bp
        FROM jsonb_array_elements(v_trimmed) e
       ORDER BY (e->>'place')::integer
    LOOP
      IF r.place = v_last_place THEN
        v_expected_cents := GREATEST(v_remaining_cents, 0);
      ELSE
        v_expected_cents := GREATEST(
          LEAST(v_remaining_cents, round(v_pool_cents * r.bp::numeric / v_total_bp)::bigint), 0);
      END IF;
      v_remaining_cents := v_remaining_cents - v_expected_cents;

      SELECT count(*), (array_agg(tp.user_id ORDER BY tp.id))[1],
             (array_agg(tp.club_id ORDER BY tp.id))[1],
             COALESCE(max(round(COALESCE(tp.prize, 0) * 100)::bigint), 0)
        INTO v_holders, v_holder, v_holder_club, v_player_prize_cents
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id AND tp.position = r.place;

      IF v_holders <> 1 OR v_holder IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'payout_place_has_no_unique_holder',
                                  'place', r.place, 'holders', v_holders,
                                  'retryable', false);
      END IF;
      IF v_player_prize_cents <> v_expected_cents THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'recorded_prize_disagrees_with_structure',
                                  'place', r.place,
                                  'recorded', v_player_prize_cents / 100.0,
                                  'expected', v_expected_cents / 100.0,
                                  'retryable', false);
      END IF;

      v_plan := v_plan || jsonb_build_array(jsonb_build_object(
        'place', r.place, 'user_id', v_holder, 'club_id', v_holder_club,
        'cents', v_expected_cents));
      v_expected_total_cents := v_expected_total_cents + v_expected_cents;
    END LOOP;
  ELSE
    /* A zero-pool event has no place money. It still gets a durable empty
       header so the universal completion gate can distinguish proof from an
       omitted plan. */
    v_expected_count := 0;
    IF EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND round(COALESCE(tp.prize, 0) * 100)::bigint <> 0
    ) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'zero_pool_has_recorded_prizes',
                                'retryable', false);
    END IF;
  END IF;

  IF v_expected_total_cents <> v_pool_cents THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'structure_does_not_allocate_the_pool',
                              'allocated', v_expected_total_cents / 100.0,
                              'prize_pool', v_pool_cents / 100.0,
                              'retryable', false);
  END IF;

  SELECT count(*) INTO v_conflicts
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND round(COALESCE(tp.prize, 0) * 100)::bigint > 0
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_plan) p
        WHERE (p->>'place')::integer = tp.position
     );
  IF v_conflicts > 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'recorded_prize_is_outside_structure',
                              'rows', v_conflicts, 'retryable', false);
  END IF;

  v_plan_fingerprint := md5(v_plan::text);

  SELECT * INTO v_batch
    FROM public.tournament_place_settlement_batches b
   WHERE b.tournament_id = p_tournament_id
   FOR UPDATE;
  IF FOUND AND (
       v_batch.mode <> 'structure'
       OR v_batch.plan_fingerprint <> v_plan_fingerprint
       OR v_batch.place_count <> v_expected_count
       OR round(v_batch.amount_owed * 100)::bigint <> v_expected_total_cents
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'prepared_plan_is_immutable',
                              'existing_fingerprint', v_batch.plan_fingerprint,
                              'proposed_fingerprint', v_plan_fingerprint,
                              'retryable', false);
  END IF;

  FOR r IN
    SELECT (p->>'place')::integer AS place,
           (p->>'user_id')::uuid AS user_id,
           (p->>'cents')::bigint AS cents
      FROM jsonb_array_elements(v_plan) p
     ORDER BY (p->>'place')::integer
  LOOP
    SELECT round(COALESCE(sum(tpo.amount), 0), 2)
      INTO v_seeded_paid
      FROM public.tournament_payouts tpo
     WHERE tpo.tournament_id = p_tournament_id
       AND tpo.position = r.place
       AND tpo.user_id = r.user_id
       AND (tpo.source IN ('structure', 'reconcile', 'hu_shortfall',
                           'late_reg_adjustment', 'clawback', 'spin_backpay',
                           'overlay_backpay')
            OR public.fn_tournament_payout_key_is_place_evidence(
                 tpo.tournament_id, tpo.idempotency_key));

    v_seeded_total_cents := v_seeded_total_cents
                            + round(v_seeded_paid * 100)::bigint;

    SELECT count(*) INTO v_wrong_recipients
      FROM (
        SELECT tpo.user_id
          FROM public.tournament_payouts tpo
         WHERE tpo.tournament_id = p_tournament_id
           AND tpo.position = r.place
           AND tpo.user_id IS DISTINCT FROM r.user_id
           AND (tpo.source IN ('structure', 'reconcile', 'hu_shortfall',
                               'late_reg_adjustment', 'clawback', 'spin_backpay',
                               'overlay_backpay')
                OR public.fn_tournament_payout_key_is_place_evidence(
                     tpo.tournament_id, tpo.idempotency_key))
         GROUP BY tpo.user_id
        HAVING abs(round(sum(tpo.amount), 2)) > 0.005
      ) wrong;

    SELECT * INTO v_existing
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'place' AND o.place = r.place
     FOR UPDATE;

    IF v_wrong_recipients > 0 THEN
      RETURN jsonb_build_object('ok', false,
                                'reason', 'legacy_place_paid_to_wrong_player',
                                'place', r.place, 'expected_user_id', r.user_id,
                                'wrong_recipients', v_wrong_recipients,
                                'retryable', false);
    END IF;

    IF v_seeded_paid < -0.005
       OR v_seeded_paid > r.cents / 100.0 + 0.005
       OR (FOUND AND abs(round(v_existing.amount_paid, 2) - v_seeded_paid) > 0.005)
       OR (FOUND AND v_existing.amount_paid > r.cents / 100.0 + 0.005)
       OR (FOUND AND v_existing.amount_owed > r.cents / 100.0 + 0.005)
       OR (FOUND AND v_existing.amount_paid > 0
                    AND v_existing.user_id IS DISTINCT FROM r.user_id) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'legacy_place_conflicts_with_plan',
                                'place', r.place, 'user_id', r.user_id,
                                'expected', r.cents / 100.0,
                                'payout_rows_paid', v_seeded_paid,
                                'retryable', false);
    END IF;
  END LOOP;

  v_required_unpaid_cents := v_expected_total_cents - v_seeded_total_cents;
  IF v_required_unpaid_cents < 0 THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'legacy_place_payments_exceed_plan',
                              'paid', v_seeded_total_cents / 100.0,
                              'plan', v_expected_total_cents / 100.0,
                              'retryable', false);
  END IF;

  /* Evidence for a paid place that the frozen ladder does not contain is not
     ignorable history: allocating the entire pool again would overpay the
     event. Net a historical positive row against any matching clawback, then
     refuse every non-zero position/user group outside the plan (including a
     NULL position). */
  SELECT count(*) INTO v_conflicts
    FROM (
      SELECT tpo.position, tpo.user_id
        FROM public.tournament_payouts tpo
       WHERE tpo.tournament_id = p_tournament_id
         AND (tpo.source IN ('structure', 'reconcile', 'hu_shortfall',
                             'late_reg_adjustment', 'clawback', 'spin_backpay',
                             'overlay_backpay')
              OR public.fn_tournament_payout_key_is_place_evidence(
                   tpo.tournament_id, tpo.idempotency_key))
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(v_plan) p
            WHERE (p->>'place')::integer = tpo.position
         )
       GROUP BY tpo.position, tpo.user_id
      HAVING abs(round(sum(tpo.amount), 2)) > 0.005
    ) unexpected_paid_place;
  IF v_conflicts > 0 THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'legacy_paid_place_is_outside_plan',
                              'rows', v_conflicts, 'retryable', false);
  END IF;

  SELECT count(*) INTO v_conflicts
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_plan) p
        WHERE (p->>'place')::integer = o.place
     );
  IF v_conflicts > 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unexpected_legacy_place_obligation',
                              'rows', v_conflicts, 'retryable', false);
  END IF;

  /* Bubble Protection spends the same enforced prize bank. Derive its exact
     holder only after the entry window is closed, the pool/ladder is finalized
     and the full standings have been normalized. The eliminated result is the
     durable event: creating the zero-paid obligation in this same prepare
     transaction closes the old result-write -> HTTP-obligation gap without
     guessing from a provisional open-registration position. */
  SELECT EXISTS (
           SELECT 1 FROM public.tournament_obligations o
            WHERE o.tournament_id = p_tournament_id
              AND o.kind = 'bubble_protection'
         ) OR EXISTS (
           SELECT 1
             FROM public.tournament_payouts p
            WHERE p.tournament_id = p_tournament_id
              AND p.source = 'bubble_protection'
         )
    INTO v_bubble_evidence_exists;
  v_bubble_required := v_t.bubble_protection OR v_bubble_evidence_exists;
  v_bubble_contract_required := v_bubble_required
    AND v_expected_count > 0 AND v_field_count > v_expected_count;

  /* A mutable display flag is not allowed to erase durable money evidence.
     Conversely, a flagged short field in which every entrant is already paid
     has no stone bubble and owes no refund. Evidence with no coherent contract
     is corruption and must be repaired explicitly, never silently ignored. */
  IF (v_bubble_evidence_exists OR v_bubble_contract_required)
     AND v_t.buy_in_amount <= 0 THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'bubble_protection_evidence_has_no_valid_contract',
      'buy_in_amount', v_t.buy_in_amount, 'paid_places', v_expected_count,
      'field_size', v_field_count, 'retryable', false);
  END IF;
  IF v_bubble_evidence_exists AND NOT v_bubble_contract_required THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'bubble_protection_evidence_has_no_valid_contract',
      'buy_in_amount', v_t.buy_in_amount, 'paid_places', v_expected_count,
      'field_size', v_field_count, 'retryable', false);
  END IF;

  IF v_bubble_contract_required THEN
    SELECT count(*), (array_agg(tp.user_id ORDER BY tp.id))[1]
      INTO v_bubble_holders, v_bubble_user
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = v_expected_count + 1;
    IF v_bubble_holders <> 1 OR v_bubble_user IS NULL THEN
      RETURN jsonb_build_object('ok', false,
                                'reason', 'bubble_protection_holder_is_not_proven',
                                'bubble_place', v_expected_count + 1,
                                'holders', v_bubble_holders,
                                'retryable', false);
    END IF;

    SELECT count(*),
           count(*) FILTER (WHERE o.user_id = v_bubble_user AND o.place IS NULL),
           COALESCE(max(o.amount_owed) FILTER (
             WHERE o.user_id = v_bubble_user AND o.place IS NULL), 0),
           COALESCE(max(o.amount_paid) FILTER (
             WHERE o.user_id = v_bubble_user AND o.place IS NULL), 0)
      INTO v_bubble_obligations, v_bubble_matching, v_bubble_owed, v_bubble_paid
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'bubble_protection';

    SELECT round(COALESCE(sum(p.amount), 0), 2)
      INTO v_bubble_evidence
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.user_id = v_bubble_user AND p.position IS NULL
       AND p.source = 'bubble_protection';

    IF v_bubble_obligations = 0 AND NOT v_bubble_evidence_exists THEN
      v_bubble_obligation_id := gen_random_uuid();
      v_bubble_source := 'engine.atomicPlaceSettlement';
      v_bubble_owed := v_t.buy_in_amount;
      v_bubble_paid := 0;
      v_bubble_settled_at := NULL;
      v_bubble_needs_insert := true;
    ELSIF v_bubble_obligations <> 1 OR v_bubble_matching <> 1 THEN
      RETURN jsonb_build_object('ok', false,
                                'reason', 'bubble_protection_obligation_is_not_exact',
                                'bubble_place', v_expected_count + 1,
                                'user_id', v_bubble_user,
                                'expected', v_t.buy_in_amount,
                                'amount_owed', v_bubble_owed,
                                'amount_paid', v_bubble_paid,
                                'payout_evidence', v_bubble_evidence,
                                'retryable', false);
    END IF;

    IF NOT v_bubble_needs_insert THEN
      SELECT o.id, o.source, o.amount_owed, o.amount_paid, o.settled_at
        INTO v_bubble_obligation_id, v_bubble_source,
             v_bubble_owed, v_bubble_paid, v_bubble_settled_at
        FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'bubble_protection'
         AND o.place IS NULL AND o.user_id = v_bubble_user
       FOR UPDATE;
    END IF;

    IF COALESCE(v_bubble_source, '') NOT IN ('engine.eliminatePlayer', 'engine.atomicPlaceSettlement')
       OR abs(v_bubble_owed - v_t.buy_in_amount) > 0.005
       OR v_bubble_paid < -0.005 OR v_bubble_paid > v_bubble_owed + 0.005
       OR abs(v_bubble_paid - v_bubble_evidence) > 0.005
       OR (v_bubble_paid + 0.005 >= v_bubble_owed
           AND v_bubble_settled_at IS NULL)
       OR (v_bubble_paid + 0.005 < v_bubble_owed
           AND v_bubble_settled_at IS NOT NULL) THEN
      RETURN jsonb_build_object('ok', false,
                                'reason', 'bubble_protection_obligation_is_not_exact',
                                'bubble_place', v_expected_count + 1,
                                'user_id', v_bubble_user,
                                'expected', v_t.buy_in_amount,
                                'amount_owed', v_bubble_owed,
                                'amount_paid', v_bubble_paid,
                                'payout_evidence', v_bubble_evidence,
                                'source', v_bubble_source,
                                'retryable', false);
    END IF;

    SELECT count(*) INTO v_conflicts
      FROM (
        SELECT p.position, p.user_id
          FROM public.tournament_payouts p
         WHERE p.tournament_id = p_tournament_id
           AND p.source = 'bubble_protection'
           AND (p.position IS NOT NULL OR p.user_id IS DISTINCT FROM v_bubble_user)
         GROUP BY p.position, p.user_id
        HAVING abs(round(sum(p.amount), 2)) > 0.005
      ) unexpected_bubble;
    IF v_conflicts > 0 THEN
      RETURN jsonb_build_object('ok', false,
                                'reason', 'bubble_protection_evidence_conflicts',
                                'rows', v_conflicts, 'retryable', false);
    END IF;
    v_bubble_unpaid_cents := round((v_bubble_owed - v_bubble_paid) * 100)::bigint;
  END IF;

  v_total_required_unpaid_cents := v_required_unpaid_cents + v_bubble_unpaid_cents;

  /* The finalized flag is not money. Before freezing any obligation that will
     move chips, lock the enforced tournament escrow and prove that its live
     prize balance covers the complete place + Bubble amount still unpaid. */
  IF v_total_required_unpaid_cents > 0 THEN
    SELECT e.enforced, round(COALESCE(e.prize_balance, 0), 2)
      INTO v_escrow_enforced, v_escrow_balance
      FROM public.tournament_escrow e
     WHERE e.tournament_id = p_tournament_id
     FOR UPDATE;
    v_escrow_found := FOUND;
    IF NOT v_escrow_found OR NOT v_escrow_enforced
       OR round(v_escrow_balance * 100)::bigint < v_total_required_unpaid_cents THEN
      RETURN jsonb_build_object(
        'ok', false, 'reason', 'prize_escrow_is_not_funded',
        'required_unpaid', v_total_required_unpaid_cents / 100.0,
        'place_unpaid', v_required_unpaid_cents / 100.0,
        'bubble_unpaid', v_bubble_unpaid_cents / 100.0,
        'escrow_available', CASE WHEN v_escrow_found THEN v_escrow_balance ELSE NULL END,
        'escrow_enforced', CASE WHEN v_escrow_found THEN v_escrow_enforced ELSE NULL END,
        'retryable', false);
    END IF;
  END IF;

  IF v_batch.tournament_id IS NOT NULL AND (
       v_batch.bubble_contract_required IS DISTINCT FROM v_bubble_contract_required
       OR v_batch.bubble_obligation_id IS DISTINCT FROM v_bubble_obligation_id
       OR v_batch.bubble_user_id IS DISTINCT FROM v_bubble_user
       OR v_batch.bubble_source IS DISTINCT FROM v_bubble_source
       OR abs(v_batch.bubble_amount_owed - v_bubble_owed) > 0.005
       OR v_batch.bubble_amount_paid_before > v_bubble_paid + 0.005
       OR (v_t.status <> 'COMPLETED'
           AND abs(v_batch.bubble_amount_paid_before - v_bubble_paid) > 0.005)
       OR (v_t.status <> 'COMPLETED'
           AND round(v_batch.escrow_required * 100)::bigint
               <> v_total_required_unpaid_cents)
  ) THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'prepared_bubble_contract_is_immutable',
                              'retryable', false);
  END IF;

  /* A prepare replay reads the frozen restart record; it never rewrites place
     rows after the header exists. */
  IF v_batch.tournament_id IS NOT NULL THEN
    SELECT count(*), round(COALESCE(sum(o.amount_owed), 0), 2),
           count(*) FILTER (WHERE o.amount_paid + 0.005 < o.amount_owed),
           md5(COALESCE(jsonb_agg(jsonb_build_object(
             'place', o.place, 'user_id', o.user_id,
             'club_id', tp.club_id,
             'cents', round(o.amount_owed * 100)::bigint)
             ORDER BY o.place), '[]'::jsonb)::text)
      INTO v_actual_count, v_actual_total, v_open_count, v_actual_fingerprint
      FROM public.tournament_obligations o
      JOIN public.tournament_players tp
        ON tp.tournament_id = o.tournament_id
       AND tp.position = o.place AND tp.user_id = o.user_id
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place';

    IF v_actual_count <> v_expected_count
       OR abs(v_actual_total - v_expected_total_cents / 100.0) > 0.005
       OR v_actual_fingerprint <> v_plan_fingerprint THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'prepared_batch_no_longer_matches_plan',
                                'paid', 0, 'retryable', false);
    END IF;
    IF v_batch.escrow_available + 0.005 < v_batch.escrow_required THEN
      RETURN jsonb_build_object('ok', false,
                                'reason', 'prepared_batch_has_no_funding_proof',
                                'retryable', false);
    END IF;
    IF v_t.status = 'COMPLETED' THEN
      IF v_batch.settled_at IS NULL OR v_open_count <> 0
         OR (v_batch.bubble_contract_required
             AND v_bubble_paid + 0.005 < v_bubble_owed) THEN
        RETURN jsonb_build_object('ok', false,
                                  'reason', 'completed_event_has_no_exact_atomic_batch',
                                  'paid', 0, 'retryable', false);
      END IF;
      RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                                'places', v_expected_count, 'amount_owed', v_actual_total,
                                'bubble_obligation_id', v_bubble_obligation_id,
                                'paid', 0, 'already_completed', true,
                                'retryable', false);
    END IF;
    RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                              'places', v_expected_count,
                              'amount_owed', v_expected_total_cents / 100.0,
                              'plan_fingerprint', v_plan_fingerprint,
                              'bubble_obligation_id', v_bubble_obligation_id,
                              'record', 'tournament_obligations',
                              'already_prepared', true, 'retryable', false);
  ELSIF v_t.status = 'COMPLETED' THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'completed_event_has_no_exact_atomic_batch',
                              'paid', 0, 'retryable', false);
  END IF;

  BEGIN
    IF v_bubble_needs_insert THEN
      INSERT INTO public.tournament_obligations
        (id, tournament_id, kind, place, user_id, amount_owed, amount_paid,
         source, settled_at)
      VALUES
        (v_bubble_obligation_id, p_tournament_id, 'bubble_protection', NULL,
         v_bubble_user, v_bubble_owed, 0, v_bubble_source, NULL);
    END IF;

    FOR r IN
      SELECT (p->>'place')::integer AS place,
             (p->>'user_id')::uuid AS user_id,
             (p->>'cents')::bigint AS cents
        FROM jsonb_array_elements(v_plan) p
       ORDER BY (p->>'place')::integer
    LOOP
      SELECT round(COALESCE(sum(tpo.amount), 0), 2)
        INTO v_seeded_paid
        FROM public.tournament_payouts tpo
       WHERE tpo.tournament_id = p_tournament_id
         AND tpo.position = r.place
         AND tpo.user_id = r.user_id
         AND (tpo.source IN ('structure', 'reconcile', 'hu_shortfall',
                             'late_reg_adjustment', 'clawback', 'spin_backpay',
                             'overlay_backpay')
              OR public.fn_tournament_payout_key_is_place_evidence(
                   tpo.tournament_id, tpo.idempotency_key));

      INSERT INTO public.tournament_obligations
        (tournament_id, kind, place, user_id, amount_owed, amount_paid,
         source, settled_at)
      VALUES
        (p_tournament_id, 'place', r.place, r.user_id, r.cents / 100.0,
         v_seeded_paid, v_source,
         CASE WHEN v_seeded_paid + 0.005 >= r.cents / 100.0 THEN now() ELSE NULL END)
      ON CONFLICT (tournament_id, kind, place) WHERE place IS NOT NULL
      DO UPDATE SET
        user_id = CASE
                    WHEN public.tournament_obligations.amount_paid = 0
                      THEN EXCLUDED.user_id
                    ELSE public.tournament_obligations.user_id
                  END,
        amount_owed = EXCLUDED.amount_owed,
        amount_paid = EXCLUDED.amount_paid,
        source = v_source,
        updated_at = now(),
        settled_at = CASE
          WHEN EXCLUDED.amount_paid + 0.005 >= EXCLUDED.amount_owed
            THEN COALESCE(public.tournament_obligations.settled_at, now())
          ELSE NULL
        END;
    END LOOP;

    SELECT count(*), round(COALESCE(sum(o.amount_owed), 0), 2),
           count(*) FILTER (WHERE o.amount_paid + 0.005 < o.amount_owed),
           md5(COALESCE(jsonb_agg(jsonb_build_object(
             'place', o.place, 'user_id', o.user_id,
             'club_id', tp.club_id,
             'cents', round(o.amount_owed * 100)::bigint)
             ORDER BY o.place), '[]'::jsonb)::text)
      INTO v_actual_count, v_actual_total, v_open_count, v_actual_fingerprint
      FROM public.tournament_obligations o
      JOIN public.tournament_players tp
        ON tp.tournament_id = o.tournament_id
       AND tp.position = o.place AND tp.user_id = o.user_id
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place';

    IF v_actual_count <> v_expected_count
       OR abs(v_actual_total - v_expected_total_cents / 100.0) > 0.005
       OR v_actual_fingerprint <> v_plan_fingerprint THEN
      RAISE EXCEPTION USING MESSAGE = 'the written obligation set does not match its frozen plan',
                            ERRCODE = '23514';
    END IF;

    INSERT INTO public.tournament_place_settlement_batches
      (tournament_id, mode, plan_fingerprint, place_count, amount_owed,
       escrow_required, escrow_available,
       bubble_contract_required, bubble_obligation_id, bubble_user_id,
       bubble_source, bubble_amount_owed, bubble_amount_paid_before, source)
    VALUES
      (p_tournament_id, 'structure', v_plan_fingerprint, v_expected_count,
       v_expected_total_cents / 100.0, v_total_required_unpaid_cents / 100.0,
       CASE WHEN v_total_required_unpaid_cents > 0 THEN v_escrow_balance ELSE 0 END,
       v_bubble_contract_required, v_bubble_obligation_id, v_bubble_user,
       v_bubble_source, v_bubble_owed, v_bubble_paid,
       v_source);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_write_failure = MESSAGE_TEXT,
                            v_write_state = RETURNED_SQLSTATE;
  END;

  IF v_write_failure IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'prepare_write_aborted',
                              'detail', v_write_failure, 'sqlstate', v_write_state,
                              'retryable', v_write_state IN ('40001', '40P01', '55P03'));
  END IF;

  RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                            'places', v_expected_count,
                            'amount_owed', v_expected_total_cents / 100.0,
                            'plan_fingerprint', v_plan_fingerprint,
                            'bubble_obligation_id', v_bubble_obligation_id,
                            'record', 'tournament_obligations',
                            'retryable', false);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_prepare_tournament_place_obligations(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_prepare_tournament_place_obligations(uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_place_amounts(p_tournament_id uuid)
 RETURNS TABLE(place integer, amount numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_t record;
  v_pool numeric;
  v_ladder_pool numeric;
  v_bubble_amount numeric := 0;
  v_expected_pool numeric;
  v_pool_cents bigint;
  v_remaining bigint;
  v_share bigint;
  v_total_bp bigint := 0;
  v_bp bigint;
  v_field integer;
  v_struct jsonb;
  v_work jsonb := '[]'::jsonb;
  v_trimmed jsonb := '[]'::jsonb;
  v_entry jsonb;
  v_place_numeric numeric;
  v_pct numeric;
  v_place integer;
  v_valid boolean := true;
  v_is_spin boolean;
  v_known_spin boolean := false;
  v_count integer;
  v_max_place integer;
  v_index integer := 0;
BEGIN
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'place amount derivation requires a tournament id'
      USING ERRCODE = '22004';
  END IF;

  SELECT t.id, t.prize_pool, t.payout_structure, t.variant,
         t.tournament_type, t.is_premium_spin, t.spin_multiplier,
         t.buy_in_amount, t.satellite_target_id, t.satellite_target,
         t.bubble_protection
    INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF lower(COALESCE(v_t.variant, '')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type, '')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % is a satellite, not a cash ladder',
      p_tournament_id USING ERRCODE = '22023';
  END IF;

  v_pool := v_t.prize_pool;
  IF v_pool IS NULL
     OR v_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_pool < 0
     OR v_pool IS DISTINCT FROM round(v_pool, 2) THEN
    RAISE EXCEPTION 'tournament % has invalid whole-cent prize pool %',
      p_tournament_id, v_pool USING ERRCODE = '22003';
  END IF;
  SELECT count(*) INTO v_field FROM public.tournament_players
   WHERE tournament_id = p_tournament_id;
  IF v_field < 1 THEN
    RAISE EXCEPTION 'tournament % has no roster', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;

  v_is_spin := lower(COALESCE(v_t.variant, '')) = 'spin'
               OR COALESCE(v_t.is_premium_spin, false)
               OR upper(COALESCE(v_t.tournament_type, '')) = 'SPIN';
  IF v_is_spin THEN
    IF v_t.spin_multiplier IS NULL
       OR v_t.spin_multiplier::text IN ('NaN','Infinity','-Infinity')
       OR v_t.spin_multiplier <= 0
       OR v_t.buy_in_amount IS NULL
       OR v_t.buy_in_amount::text IN ('NaN','Infinity','-Infinity')
       OR v_t.buy_in_amount < 0
       OR v_t.buy_in_amount IS DISTINCT FROM round(v_t.buy_in_amount, 2) THEN
      RAISE EXCEPTION 'Spin % has invalid locked buy-in/multiplier evidence',
        p_tournament_id USING ERRCODE = '22003';
    END IF;
    v_expected_pool := round(v_t.buy_in_amount * v_t.spin_multiplier, 2);
    IF v_expected_pool::text IN ('NaN','Infinity','-Infinity')
       OR v_pool IS DISTINCT FROM v_expected_pool THEN
      RAISE EXCEPTION
        'Spin % pool % does not equal buy-in % x multiplier % (= %)',
        p_tournament_id, v_pool, v_t.buy_in_amount, v_t.spin_multiplier,
        v_expected_pool USING ERRCODE = '23514';
    END IF;

    IF v_t.spin_multiplier IN (2,3,4,5) THEN
      v_struct := '[{"place":1,"percentage":100}]'::jsonb;
      v_known_spin := true;
    ELSIF v_t.spin_multiplier = 10 THEN
      v_struct := '[{"place":1,"percentage":80},{"place":2,"percentage":20}]'::jsonb;
      v_known_spin := true;
    ELSIF v_t.spin_multiplier IN (25,50,100) THEN
      v_struct := '[{"place":1,"percentage":80},{"place":2,"percentage":12},{"place":3,"percentage":8}]'::jsonb;
      v_known_spin := true;
    END IF;
  END IF;

  -- Unknown/retired Spin multipliers and non-Spins read the stored structure.
  IF NOT v_known_spin THEN
    BEGIN
      v_struct := NULLIF(btrim(COALESCE(v_t.payout_structure::text, '')), '')::jsonb;
    EXCEPTION WHEN invalid_text_representation THEN
      v_struct := NULL;
    END;
  END IF;
  IF v_struct IS NULL OR jsonb_typeof(v_struct) <> 'array'
     OR jsonb_array_length(v_struct) = 0 THEN
    v_valid := false;
  END IF;

  -- Fractional places and non-finite/non-positive shares fail this candidate.
  -- As in computePlacePrize, the first entry for a duplicate place wins.
  IF v_valid THEN
    FOR v_entry IN SELECT value FROM jsonb_array_elements(v_struct) LOOP
      IF jsonb_typeof(v_entry) <> 'object'
         OR v_entry->>'place' IS NULL
         OR v_entry->>'percentage' IS NULL THEN
        v_valid := false; EXIT;
      END IF;
      BEGIN
        v_place_numeric := (v_entry->>'place')::numeric;
        v_pct := (v_entry->>'percentage')::numeric;
      EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        v_valid := false; EXIT;
      END;
      IF v_place_numeric::text IN ('NaN','Infinity','-Infinity')
         OR v_pct::text IN ('NaN','Infinity','-Infinity')
         OR v_place_numeric < 1 OR v_place_numeric <> trunc(v_place_numeric)
         OR v_place_numeric > 2147483647 OR v_pct <= 0 THEN
        v_valid := false; EXIT;
      END IF;
      v_place := v_place_numeric::integer;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_work) e
                  WHERE (e->>'place')::integer = v_place) THEN
        CONTINUE;
      END IF;
      BEGIN
        v_bp := round(v_pct * 100)::bigint;
      EXCEPTION WHEN numeric_value_out_of_range THEN
        v_valid := false; EXIT;
      END;
      IF v_bp <= 0 THEN
        v_valid := false; EXIT;
      END IF;
      v_work := v_work || jsonb_build_object('place',v_place,'bp',v_bp);
    END LOOP;
  END IF;
  IF v_valid AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_work) e
     WHERE (e->>'place')::integer = 1
  ) THEN
    v_valid := false;
  END IF;

  IF NOT v_valid THEN
    RAISE EXCEPTION
      'tournament % has no usable canonical payout ladder',
      p_tournament_id USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(jsonb_agg(e ORDER BY (e->>'place')::integer),'[]'::jsonb)
    INTO v_trimmed FROM jsonb_array_elements(v_work) e
   WHERE (e->>'place')::integer <= v_field;
  IF jsonb_array_length(v_trimmed) = 0 THEN
    RAISE EXCEPTION 'tournament % ladder has no place in final field %',
      p_tournament_id, v_field USING ERRCODE = '22023';
  END IF;
  SELECT count(*), COALESCE(sum((e->>'bp')::bigint),0)
    INTO v_count, v_total_bp FROM jsonb_array_elements(v_trimmed) e;
  IF v_total_bp <= 0 THEN
    RAISE EXCEPTION 'tournament % ladder has no positive percentage',
      p_tournament_id USING ERRCODE = '22023';
  END IF;

  SELECT max((e->>'place')::integer)
    INTO v_max_place
    FROM jsonb_array_elements(v_trimmed) e;

  -- Bubble protection is part of the tournament pool, not a house overlay.
  -- When the final field contains a stone bubble, reserve exactly one base
  -- buy-in before pricing the percentage ladder. The bubble and all places
  -- therefore spend the locked prize_pool exactly once between them.
  IF COALESCE(v_t.bubble_protection, false) AND v_field > v_max_place THEN
    IF v_t.buy_in_amount IS NULL
       OR v_t.buy_in_amount::text IN ('NaN','Infinity','-Infinity')
       OR v_t.buy_in_amount <= 0
       OR v_t.buy_in_amount IS DISTINCT FROM round(v_t.buy_in_amount, 2) THEN
      RAISE EXCEPTION
        'tournament % has bubble protection but invalid whole-cent buy-in %',
        p_tournament_id, v_t.buy_in_amount USING ERRCODE = '22003';
    END IF;
    v_bubble_amount := round(v_t.buy_in_amount, 2);
    IF v_bubble_amount > v_pool THEN
      RAISE EXCEPTION
        'tournament % bubble amount % exceeds locked prize pool %',
        p_tournament_id, v_bubble_amount, v_pool USING ERRCODE = '23514';
    END IF;
  END IF;

  v_ladder_pool := round(v_pool - v_bubble_amount, 2);
  v_pool_cents := round(v_ladder_pool * 100)::bigint;

  -- Mirror computePlacePrize: normalize to surviving basis points, spend down
  -- in place order, and give the exact remaining cents to the last place.
  v_remaining := v_pool_cents;
  FOR v_entry IN
    SELECT e FROM jsonb_array_elements(v_trimmed) e
     ORDER BY (e->>'place')::integer
  LOOP
    v_index := v_index + 1;
    v_place := (v_entry->>'place')::integer;
    v_bp := (v_entry->>'bp')::bigint;
    IF v_index = v_count THEN
      v_share := v_remaining;
    ELSE
      v_share := LEAST(v_remaining,
        round((v_pool_cents::numeric * v_bp::numeric) / v_total_bp::numeric)::bigint);
    END IF;
    v_share := GREATEST(v_share,0);
    v_remaining := v_remaining - v_share;
    place := v_place;
    amount := (v_share::numeric / 100)::numeric(15,2);
    IF amount::text IN ('NaN','Infinity','-Infinity')
       OR amount < 0 OR amount IS DISTINCT FROM round(amount,2) THEN
      RAISE EXCEPTION 'derived invalid amount % for tournament %, place %',
        amount, p_tournament_id, place USING ERRCODE = '22003';
    END IF;
    RETURN NEXT;
  END LOOP;
  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'tournament % ladder left % cents undistributed',
      p_tournament_id, v_remaining USING ERRCODE = '23514';
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_place_amounts(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.fn_settle_tournament_places(p_tournament_id uuid, p_observed_winner_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_t record;
  v_ladder jsonb;
  v_payouts jsonb := '[]'::jsonb;
  v_status text;
  v_live_count integer;
  v_field_size integer;
  v_eliminated_count integer;
  v_sequenced_count integer;
  v_bubble_place integer;
  v_bubble_user_id uuid;
  v_bubble_amount numeric := 0;
  v_bubble_payout_count integer := 0;
  v_bubble_paid numeric := 0;
  v_bubble_ob_count integer := 0;
  v_bubble_ob public.tournament_obligations%ROWTYPE;
  v_bubble_result jsonb;
  v_winner public.tournament_players%ROWTYPE;
  v_row record;
  v_place integer;
  v_amount numeric;
  v_user_id uuid;
  v_ob public.tournament_obligations%ROWTYPE;
  v_evidence numeric;
  v_evidence_count integer;
  v_total_expected numeric := 0;
  v_winner_amount numeric := 0;
  v_result jsonb;
  v_guarantee_result jsonb;
  v_rows integer;
BEGIN
  -- Every rolling and terminal money authority enters one transaction lane
  -- before it can own an event, obligation, bank, or recipient row.
  PERFORM public.fn_ca_lock_settlement_lane_global();
  IF p_tournament_id IS NULL OR p_observed_winner_id IS NULL THEN
    RAISE EXCEPTION 'place settlement requires tournament and observed winner ids'
      USING ERRCODE = '22004';
  END IF;

  -- Canonical lock order. Re-locks inside owner-only callees are rows already
  -- owned by this transaction and therefore cannot invert a wait dependency.
  SELECT t.id, t.status, t.variant, t.tournament_type, t.is_premium_spin,
         t.satellite_target_id, t.satellite_target, t.prize_pool,
         t.bubble_protection, t.buy_in_amount, t.guaranteed_prize,
         t.prize_pool_finalized
    INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  v_status := upper(COALESCE(v_t.status,''));
  IF v_status NOT IN ('RUNNING','COMPLETING','COMPLETED') THEN
    RAISE EXCEPTION 'tournament % cannot settle from status %',
      p_tournament_id, v_t.status USING ERRCODE = '55000';
  END IF;
  IF lower(COALESCE(v_t.variant,'')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type,'')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % is a satellite, not an ordinary cash ladder',
      p_tournament_id USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_payouts p
              WHERE p.tournament_id = p_tournament_id
                AND lower(COALESCE(p.source,'')) = 'final_table_deal')
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id
                   AND o.kind = 'final_table_deal') THEN
    RAISE EXCEPTION
      'tournament % carries final-table-deal evidence; use the deal authority',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Funding the advertised guarantee is part of this settlement transaction,
  -- not a best-effort request made by the game process immediately beforehand.
  -- fn_apply_prize_guarantee re-locks the row already owned here and either
  -- debits the event-owned bank plus finalizes the pool, or raises. Prove its
  -- receipt against the refreshed row before deriving even the first place; a
  -- refusal therefore rolls back the overlay, every payout and the finish.
  IF v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool < 0
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool, 2) THEN
    RAISE EXCEPTION 'tournament % has invalid whole-cent prize pool %',
      p_tournament_id, v_t.prize_pool USING ERRCODE = '22003';
  END IF;
  IF v_t.guaranteed_prize IS NOT NULL
     AND (v_t.guaranteed_prize::text IN ('NaN','Infinity','-Infinity')
       OR v_t.guaranteed_prize < 0
       OR v_t.guaranteed_prize IS DISTINCT FROM round(v_t.guaranteed_prize, 2)) THEN
    RAISE EXCEPTION 'tournament % has invalid whole-cent guarantee %',
      p_tournament_id, v_t.guaranteed_prize USING ERRCODE = '22003';
  END IF;
  v_guarantee_result := public.fn_apply_prize_guarantee(
    p_tournament_id, 'engine.fn_settle_tournament_places');
  IF COALESCE((v_guarantee_result->>'ok')::boolean, false) IS NOT TRUE
     OR (COALESCE((v_guarantee_result->>'overlay')::numeric,0) > 0
         AND COALESCE(
           (v_guarantee_result->>'overlay_journaled')::boolean,false)
             IS NOT TRUE) THEN
    RAISE EXCEPTION 'tournament % guarantee funding refused: %',
      p_tournament_id, v_guarantee_result USING ERRCODE = 'P0404';
  END IF;

  SELECT t.id, t.status, t.variant, t.tournament_type, t.is_premium_spin,
         t.satellite_target_id, t.satellite_target, t.prize_pool,
         t.bubble_protection, t.buy_in_amount, t.guaranteed_prize,
         t.prize_pool_finalized
    INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF COALESCE(v_t.prize_pool_finalized, false) IS NOT TRUE
     OR v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool, 2)
     OR v_t.prize_pool < COALESCE(v_t.guaranteed_prize, 0)
     OR v_guarantee_result->>'prize_pool' IS NULL
     OR (v_guarantee_result->>'prize_pool')::numeric IS DISTINCT FROM v_t.prize_pool THEN
    RAISE EXCEPTION
      'tournament % guarantee funding did not produce one finalized locked pool: result %, pool %, guarantee %, finalized %',
      p_tournament_id, v_guarantee_result, v_t.prize_pool,
      v_t.guaranteed_prize, v_t.prize_pool_finalized USING ERRCODE = 'P0404';
  END IF;

  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
   ORDER BY tp.id FOR UPDATE;
  SELECT count(*) INTO v_field_size
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  IF EXISTS (SELECT 1 FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND tp.status::text = 'registered') THEN
    RAISE EXCEPTION 'tournament % still has a registered unresolved player',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- The helper counts the final field, so derive only after the complete
  -- roster has joined the canonical tournament -> roster lock sequence.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'place',a.place,'amount',a.amount) ORDER BY a.place),'[]'::jsonb)
    INTO v_ladder
    FROM public.fn_ca_tournament_place_amounts(p_tournament_id) a;
  IF jsonb_array_length(v_ladder) = 0 THEN
    RAISE EXCEPTION 'tournament % derived an empty ladder', p_tournament_id
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO v_live_count FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text IN ('playing','winner');
  IF v_live_count > 1 THEN
    RAISE EXCEPTION 'tournament % still has % live players',
      p_tournament_id, v_live_count USING ERRCODE = '55000';
  ELSIF v_live_count = 1 THEN
    SELECT tp.* INTO v_winner FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text IN ('playing','winner');
  ELSE
    -- The observed last survivor may already have crossed through
    -- `eliminated` in an all-in race. The committed transition sequence, not
    -- a wall clock, proves that this row was the final elimination.
    SELECT tp.* INTO v_winner FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id = p_observed_winner_id
       AND tp.status::text = 'eliminated'
       AND tp.elimination_sequence IS NOT NULL;
    IF FOUND AND EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.id <> v_winner.id
         AND tp.elimination_sequence = v_winner.elimination_sequence
    ) THEN
      RAISE EXCEPTION
        'tournament % has an ambiguous final elimination witness',
        p_tournament_id USING ERRCODE = '23505';
    END IF;
    IF FOUND AND EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status::text = 'eliminated'
         AND (tp.elimination_sequence IS NULL
              OR tp.elimination_sequence > v_winner.elimination_sequence)
    ) THEN
      v_winner := NULL;
    END IF;
  END IF;
  IF v_winner.id IS NULL OR v_winner.user_id IS DISTINCT FROM p_observed_winner_id THEN
    RAISE EXCEPTION 'observed winner % does not match locked winner % for tournament %',
      p_observed_winner_id, v_winner.user_id, p_tournament_id
      USING ERRCODE = '40001';
  END IF;

  -- Lock the whole set once, before validation or the ascending-place walk.
  PERFORM 1 FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
   ORDER BY o.kind, o.place NULLS LAST, o.id FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
       AND (o.place IS NULL OR NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_ladder) a
          WHERE (a->>'place')::integer = o.place))
  ) THEN
    RAISE EXCEPTION
      'tournament % has a place obligation outside its derived ladder',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  IF v_status = 'COMPLETED' THEN
    IF v_winner.status::text <> 'winner' OR v_winner.position <> 1 THEN
      RAISE EXCEPTION
        'COMPLETED tournament % is not an exact replay: winner is not durable',
        p_tournament_id USING ERRCODE = '55000';
    END IF;
  ELSE
    -- Recorded finish positions are the engine's live witness. Never rebuild
    -- an all-busted field from timestamps. Promotion may fill first place, but
    -- it cannot displace another recorded first or vacate a ladder place.
    IF EXISTS (SELECT 1 FROM public.tournament_players tp
                WHERE tp.tournament_id = p_tournament_id
                  AND tp.position = 1
                  AND tp.user_id <> v_winner.user_id) THEN
      RAISE EXCEPTION 'tournament % assigns first place to another player',
        p_tournament_id USING ERRCODE = '23505';
    END IF;
    IF v_winner.position IS NOT NULL AND v_winner.position <> 1
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_ladder) a
                    WHERE (a->>'place')::integer = v_winner.position) THEN
      RAISE EXCEPTION
        'promoting winner % would vacate cash place % in tournament %',
        v_winner.user_id, v_winner.position, p_tournament_id
        USING ERRCODE = '55000';
    END IF;
    UPDATE public.tournament_players
       SET status = 'winner', position = 1,
           eliminated_at = NULL, elimination_sequence = NULL
     WHERE id = v_winner.id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION
        'tournament % could not promote exactly one winner',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    -- Final numeric positions are derived from the transition witness, not
    -- from the field size that happened to exist when each player busted.
    -- This is the root fix for late registration enlarging the field after an
    -- early elimination. Existing money evidence is never relabelled: a
    -- legacy event whose paid place would move fails closed for explicit
    -- adjudication instead of rewriting settled history.
    SELECT count(*), count(tp.elimination_sequence),
           count(DISTINCT tp.elimination_sequence)
      INTO v_eliminated_count, v_sequenced_count, v_rows
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text = 'eliminated';
    IF v_eliminated_count <> v_field_size - 1
       OR v_sequenced_count <> v_eliminated_count
       OR v_rows <> v_eliminated_count THEN
      RAISE EXCEPTION
        'tournament % has no complete durable elimination sequence (%/% of %)',
        p_tournament_id, v_sequenced_count, v_rows, v_eliminated_count
        USING ERRCODE = 'P0404';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM (
          SELECT tp.id, tp.position,
                 row_number() OVER (
                   ORDER BY tp.elimination_sequence DESC, tp.id ASC
                 )::integer + 1 AS expected_position
            FROM public.tournament_players tp
           WHERE tp.tournament_id = p_tournament_id
             AND tp.status::text = 'eliminated'
        ) ranked
       WHERE ranked.position IS DISTINCT FROM ranked.expected_position
    ) THEN
      IF EXISTS (
        SELECT 1 FROM public.tournament_payouts p
         WHERE p.tournament_id = p_tournament_id
           AND p."position" IS NOT NULL
      ) OR EXISTS (
        SELECT 1 FROM public.tournament_obligations o
         WHERE o.tournament_id = p_tournament_id
           AND o.kind = 'place'
      ) THEN
        RAISE EXCEPTION
          'tournament % needs a late-entry position normalization but already carries settled place evidence',
          p_tournament_id USING ERRCODE = 'P0404';
      END IF;

      UPDATE public.tournament_players tp
         SET position = NULL
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status::text = 'eliminated';

      WITH ranked AS (
        SELECT tp.id,
               row_number() OVER (
                 ORDER BY tp.elimination_sequence DESC, tp.id ASC
               )::integer + 1 AS expected_position
          FROM public.tournament_players tp
         WHERE tp.tournament_id = p_tournament_id
           AND tp.status::text = 'eliminated'
      )
      UPDATE public.tournament_players tp
         SET position = ranked.expected_position
        FROM ranked
       WHERE tp.id = ranked.id;
    END IF;
  END IF;

  -- Derive the single pool-funded bubble promise after standings are final.
  -- The percentage helper has already reserved this exact amount from its
  -- ladder. Satellites never enter this authority: their bubble is paid the
  -- residual that cannot buy a full seat by the satellite settle path.
  SELECT max((a->>'place')::integer) + 1
    INTO v_bubble_place
    FROM jsonb_array_elements(v_ladder) a;
  IF COALESCE(v_t.bubble_protection, false)
     AND v_bubble_place IS NOT NULL
     AND v_bubble_place <= v_field_size THEN
    IF v_t.buy_in_amount IS NULL
       OR v_t.buy_in_amount::text IN ('NaN','Infinity','-Infinity')
       OR v_t.buy_in_amount <= 0
       OR v_t.buy_in_amount IS DISTINCT FROM round(v_t.buy_in_amount, 2) THEN
      RAISE EXCEPTION 'tournament % has invalid bubble buy-in %',
        p_tournament_id, v_t.buy_in_amount USING ERRCODE = '22003';
    END IF;
    v_bubble_amount := round(v_t.buy_in_amount, 2);
    IF v_bubble_amount > v_t.prize_pool THEN
      RAISE EXCEPTION 'tournament % bubble amount % exceeds pool %',
        p_tournament_id, v_bubble_amount, v_t.prize_pool
        USING ERRCODE = '23514';
    END IF;

    SELECT count(*), min(tp.user_id::text)::uuid
      INTO v_rows, v_bubble_user_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = v_bubble_place
       AND tp.status::text = 'eliminated';
    IF v_rows <> 1 OR v_bubble_user_id IS NULL THEN
      RAISE EXCEPTION 'tournament % has no single eliminated stone bubble at place %',
        p_tournament_id, v_bubble_place USING ERRCODE = 'P0404';
    END IF;
  END IF;

  SELECT count(*), COALESCE(sum(p.amount), 0)
    INTO v_bubble_payout_count, v_bubble_paid
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source = 'bubble_protection';
  SELECT count(*) INTO v_bubble_ob_count
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND o.kind = 'bubble_protection';

  IF v_bubble_amount = 0 THEN
    IF v_bubble_payout_count <> 0 OR v_bubble_paid <> 0
       OR v_bubble_ob_count <> 0 THEN
      RAISE EXCEPTION 'tournament % carries bubble evidence but no bubble is due',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSE
    IF v_bubble_paid > v_bubble_amount
       OR EXISTS (
         SELECT 1 FROM public.tournament_payouts p
          WHERE p.tournament_id = p_tournament_id
            AND p.source = 'bubble_protection'
            AND (p.user_id IS DISTINCT FROM v_bubble_user_id
              OR p."position" IS NOT NULL
              OR p.amount IS NULL
              OR p.amount::text IN ('NaN','Infinity','-Infinity')
              OR p.amount <= 0
              OR p.amount IS DISTINCT FROM round(p.amount, 2)
              OR p.idempotency_key IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM public.wallet_credit_idempotency k
                 WHERE k.key = p.idempotency_key
                   AND k.user_id = p.user_id
                   AND k.amount = p.amount))) THEN
      RAISE EXCEPTION 'tournament % has malformed bubble payout evidence',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    SELECT * INTO v_bubble_ob
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'bubble_protection'
       AND o.user_id = v_bubble_user_id;
    IF v_bubble_ob_count > 0
       AND (v_bubble_ob_count <> 1 OR v_bubble_ob.id IS NULL
         OR v_bubble_ob.place IS NOT NULL
         OR v_bubble_ob.amount_owed IS DISTINCT FROM v_bubble_amount
         OR v_bubble_ob.amount_paid IS DISTINCT FROM v_bubble_paid
         OR v_bubble_ob.amount_paid < 0
         OR v_bubble_ob.amount_paid > v_bubble_ob.amount_owed
         OR (v_bubble_ob.amount_paid = v_bubble_ob.amount_owed) IS DISTINCT FROM
            (v_bubble_ob.settled_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'tournament % has malformed bubble obligation evidence',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    IF v_bubble_ob_count = 0
       AND (v_bubble_payout_count <> 0 OR v_bubble_paid <> 0) THEN
      RAISE EXCEPTION 'tournament % has bubble money without its debt record',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    IF v_status = 'COMPLETED'
       AND (v_bubble_ob_count <> 1
         OR v_bubble_paid IS DISTINCT FROM v_bubble_amount
         OR v_bubble_ob.amount_paid IS DISTINCT FROM v_bubble_amount
         OR v_bubble_ob.settled_at IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM public.tournament_players tp
            WHERE tp.tournament_id = p_tournament_id
              AND tp.user_id = v_bubble_user_id
              AND tp.position = v_bubble_place
              AND tp.prize IS NOT DISTINCT FROM v_bubble_amount)) THEN
      RAISE EXCEPTION 'COMPLETED tournament % has no exact bubble replay',
        p_tournament_id USING ERRCODE = '55000';
    END IF;
  END IF;

  -- Anything paid from the prize bank outside the derived ladder makes a full
  -- structure payout unsafe. Bounty/seat sources belong to other authorities.
  IF EXISTS (
    SELECT 1 FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND COALESCE(p.source,'') NOT IN
           ('bounty','own_bounty','mystery_bounty','mystery_bounty_residual',
            'bounty_residual','satellite_seat','bubble_protection')
       AND (p."position" IS NULL OR NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_ladder) a
          WHERE (a->>'place')::integer = p."position"))
  ) THEN
    RAISE EXCEPTION 'tournament % has prize evidence outside its derived ladder',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Obligation-shaped wallet identity with no exact payout row is mixed
  -- evidence. It is checked globally before any place can move.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_obligations o
      JOIN public.wallet_credit_idempotency k
        ON k.key LIKE 'tourney:' || p_tournament_id::text || ':obl:' || o.id::text || ':%'
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_payouts p
          WHERE p.idempotency_key = k.key
            AND p.tournament_id = p_tournament_id
            AND p.user_id = k.user_id AND p.amount = k.amount)
  ) THEN
    RAISE EXCEPTION
      'tournament % has wallet-credit identity without payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Preflight every place before settling the first one.
  FOR v_row IN
    SELECT (a->>'place')::integer AS place,
           (a->>'amount')::numeric AS amount, tp.user_id,
           tp.prize AS cached_prize
      FROM jsonb_array_elements(v_ladder) a
      LEFT JOIN public.tournament_players tp
        ON tp.tournament_id = p_tournament_id
       AND tp.position = (a->>'place')::integer
     ORDER BY (a->>'place')::integer
  LOOP
    v_place := v_row.place; v_amount := v_row.amount; v_user_id := v_row.user_id;
    IF v_user_id IS NULL THEN
      RAISE EXCEPTION 'tournament % has no finisher for cash place %',
        p_tournament_id, v_place USING ERRCODE = '23502';
    END IF;
    IF v_amount::text IN ('NaN','Infinity','-Infinity') OR v_amount < 0
       OR v_amount IS DISTINCT FROM round(v_amount,2) THEN
      RAISE EXCEPTION 'tournament % derived invalid amount % for place %',
        p_tournament_id, v_amount, v_place USING ERRCODE = '22003';
    END IF;
    v_total_expected := v_total_expected + v_amount;
    IF v_place = 1 THEN v_winner_amount := v_amount; END IF;
    IF v_status = 'COMPLETED'
       AND v_row.cached_prize IS DISTINCT FROM v_amount THEN
      RAISE EXCEPTION
        'COMPLETED tournament %, place % has stale prize cache % (expected %)',
        p_tournament_id, v_place, v_row.cached_prize, v_amount
        USING ERRCODE = '55000';
    END IF;

    -- Each payout row is also required to name an exact wallet-credit identity.
    IF EXISTS (
      SELECT 1 FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id AND p."position" = v_place
         AND (p.user_id IS DISTINCT FROM v_user_id OR p.amount IS NULL
           OR p.amount::text IN ('NaN','Infinity','-Infinity') OR p.amount < 0
           OR p.amount IS DISTINCT FROM round(p.amount,2)
           OR p.idempotency_key IS NULL OR NOT EXISTS (
             SELECT 1 FROM public.wallet_credit_idempotency k
              WHERE k.key = p.idempotency_key AND k.user_id = p.user_id
                AND k.amount = p.amount))
    ) THEN
      RAISE EXCEPTION
        'tournament %, place % has mixed/malformed/wrong-recipient evidence',
        p_tournament_id, v_place USING ERRCODE = 'P0404';
    END IF;
    SELECT count(*), COALESCE(sum(p.amount),0)
      INTO v_evidence_count, v_evidence
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id AND p."position" = v_place;
    v_evidence := round(v_evidence,2);
    IF v_evidence > v_amount THEN
      RAISE EXCEPTION 'tournament %, place % records % above entitlement %',
        p_tournament_id, v_place, v_evidence, v_amount USING ERRCODE = '23514';
    END IF;

    v_ob := NULL;
    SELECT * INTO v_ob FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'place' AND o.place = v_place;
    IF FOUND THEN
      IF v_ob.user_id IS DISTINCT FROM v_user_id OR v_ob.amount_owed IS NULL
         OR v_ob.amount_paid IS NULL
         OR v_ob.amount_owed::text IN ('NaN','Infinity','-Infinity')
         OR v_ob.amount_paid::text IN ('NaN','Infinity','-Infinity')
         OR v_ob.amount_owed IS DISTINCT FROM round(v_ob.amount_owed,2)
         OR v_ob.amount_paid IS DISTINCT FROM round(v_ob.amount_paid,2)
         OR v_ob.amount_owed < 0 OR v_ob.amount_paid < 0
         OR v_ob.amount_paid > v_ob.amount_owed
         OR v_ob.amount_owed > v_amount
         OR v_ob.amount_paid IS DISTINCT FROM v_evidence THEN
        RAISE EXCEPTION 'tournament %, place % has incompatible obligation',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;
    END IF;

    IF v_amount = 0 THEN
      -- Zero-valued ladder places are standings, not debts.
      IF v_evidence <> 0 OR (v_ob.id IS NOT NULL
         AND (v_ob.amount_owed <> 0 OR v_ob.amount_paid <> 0)) THEN
        RAISE EXCEPTION 'zero-value place % in tournament % carries money evidence',
          v_place, p_tournament_id USING ERRCODE = '23514';
      END IF;
    ELSIF v_status = 'COMPLETED' THEN
      IF v_ob.id IS NULL OR v_ob.amount_owed IS DISTINCT FROM v_amount
         OR v_ob.amount_paid IS DISTINCT FROM v_amount
         OR v_evidence IS DISTINCT FROM v_amount THEN
        RAISE EXCEPTION 'COMPLETED tournament %, place % is not an exact replay',
          p_tournament_id, v_place USING ERRCODE = '55000';
      END IF;
    END IF;
  END LOOP;

  IF round(v_total_expected + v_bubble_amount, 2)
       IS DISTINCT FROM v_t.prize_pool THEN
    RAISE EXCEPTION
      'tournament % ladder % plus bubble % does not equal locked pool %',
      p_tournament_id, v_total_expected, v_bubble_amount, v_t.prize_pool
      USING ERRCODE = '23514';
  END IF;

  IF v_status <> 'COMPLETED' THEN
    -- Materialize the bubble and the entire positive ladder before the first
    -- wallet credit. The payment walk is driven from one complete locked debt
    -- set, so failure on any recipient rolls every obligation and credit back.
    IF v_bubble_amount > 0 AND v_bubble_ob_count = 0 THEN
      INSERT INTO public.tournament_obligations
        (tournament_id,kind,place,user_id,amount_owed,amount_paid,source,settled_at)
      VALUES
        (p_tournament_id,'bubble_protection',NULL,v_bubble_user_id,
         v_bubble_amount,0,'engine.fn_settle_tournament_places',NULL)
      RETURNING * INTO v_bubble_ob;
      v_bubble_ob_count := 1;
    END IF;

    FOR v_row IN
      SELECT (a->>'place')::integer AS place,
             (a->>'amount')::numeric AS amount, tp.user_id
        FROM jsonb_array_elements(v_ladder) a
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id
         AND tp.position = (a->>'place')::integer
       WHERE (a->>'amount')::numeric > 0
       ORDER BY (a->>'place')::integer
    LOOP
      SELECT COALESCE(sum(p.amount),0) INTO v_evidence
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p."position" = v_row.place;

      UPDATE public.tournament_obligations o
         SET amount_owed = v_row.amount,
             source = COALESCE(o.source, 'engine.fn_settle_tournament_places'),
             updated_at = now()
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'place' AND o.place = v_row.place;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows = 0 THEN
        INSERT INTO public.tournament_obligations
          (tournament_id,kind,place,user_id,amount_owed,amount_paid,source,settled_at)
        VALUES
          (p_tournament_id,'place',v_row.place,v_row.user_id,v_row.amount,
           v_evidence,'engine.fn_settle_tournament_places',
           CASE WHEN v_evidence = v_row.amount THEN now() ELSE NULL END);
      ELSIF v_rows <> 1 THEN
        RAISE EXCEPTION 'tournament %, place % matched % obligations',
          p_tournament_id, v_row.place, v_rows USING ERRCODE = '23505';
      END IF;
    END LOOP;

    -- Re-lock/prove the complete set immediately before any raw payer runs.
    PERFORM 1 FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind IN ('bubble_protection','place')
     ORDER BY o.kind, o.place NULLS LAST, o.id FOR UPDATE;

    IF v_bubble_amount > 0 THEN
      v_bubble_result := public.fn_ca_settle_tournament_bubble_raw(
        p_tournament_id, v_bubble_user_id, v_bubble_amount);
    END IF;

    FOR v_row IN
      SELECT (a->>'place')::integer AS place,
             (a->>'amount')::numeric AS amount, tp.user_id
        FROM jsonb_array_elements(v_ladder) a
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id
         AND tp.position = (a->>'place')::integer
       WHERE (a->>'amount')::numeric > 0
       ORDER BY (a->>'place')::integer
    LOOP
      v_result := public.fn_ca_settle_tournament_place_raw(
        p_tournament_id,v_row.place,v_row.user_id,v_row.amount);
      IF COALESCE((v_result->>'fully_settled')::boolean,false) IS NOT TRUE THEN
        RAISE EXCEPTION 'tournament %, place % returned a partial settlement',
          p_tournament_id, v_row.place USING ERRCODE = 'P0404';
      END IF;
    END LOOP;

    -- tournament_players.prize is presentation cache, stamped only from the
    -- successfully settled DB ladder and in this same transaction.
    UPDATE public.tournament_players SET prize = 0
     WHERE tournament_id = p_tournament_id;
    FOR v_row IN SELECT (a->>'place')::integer AS place,
                         (a->>'amount')::numeric AS amount
                   FROM jsonb_array_elements(v_ladder) a
    LOOP
      UPDATE public.tournament_players SET prize = v_row.amount
       WHERE tournament_id = p_tournament_id AND position = v_row.place;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'could not stamp one prize cache for tournament %, place %',
          p_tournament_id, v_row.place USING ERRCODE = 'P0404';
      END IF;
    END LOOP;

    IF v_bubble_amount > 0 THEN
      UPDATE public.tournament_players
         SET prize = v_bubble_amount
       WHERE tournament_id = p_tournament_id
         AND user_id = v_bubble_user_id
         AND position = v_bubble_place;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION
          'could not stamp one bubble prize cache for tournament %, place %',
          p_tournament_id, v_bubble_place USING ERRCODE = 'P0404';
      END IF;
    END IF;

    IF v_status = 'RUNNING' THEN
      UPDATE public.tournaments SET status = 'COMPLETING'
       WHERE id = p_tournament_id AND status = 'RUNNING';
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'tournament % lost its RUNNING finish claim',
          p_tournament_id USING ERRCODE = '40001';
      END IF;
      v_status := 'COMPLETING';
    END IF;
  END IF;

  IF v_bubble_amount > 0 AND v_status = 'COMPLETED' THEN
    -- Exact replay only: the completed preflight above proved this call cannot
    -- move money, while the raw helper proves every durable receipt again.
    v_bubble_result := public.fn_ca_settle_tournament_bubble_raw(
      p_tournament_id, v_bubble_user_id, v_bubble_amount);
  END IF;

  IF v_bubble_amount > 0 AND NOT EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id = v_bubble_user_id
       AND tp.position = v_bubble_place
       AND tp.prize IS NOT DISTINCT FROM v_bubble_amount
  ) THEN
    RAISE EXCEPTION
      'post-settlement bubble prize-cache proof failed for tournament %, place %',
      p_tournament_id, v_bubble_place USING ERRCODE = 'P0404';
  END IF;

  -- Prove the durable end-state and build the presentation-only receipt.
  FOR v_row IN
    SELECT (a->>'place')::integer AS place,
           (a->>'amount')::numeric AS amount, tp.user_id,
           tp.prize AS cached_prize
      FROM jsonb_array_elements(v_ladder) a
      JOIN public.tournament_players tp
        ON tp.tournament_id = p_tournament_id
       AND tp.position = (a->>'place')::integer
     ORDER BY (a->>'place')::integer
  LOOP
    IF v_row.cached_prize IS DISTINCT FROM v_row.amount THEN
      RAISE EXCEPTION 'post-settlement prize-cache proof failed for tournament %, place %',
        p_tournament_id, v_row.place USING ERRCODE = 'P0404';
    END IF;
    IF v_row.amount > 0 THEN
      v_ob := NULL;
      SELECT * INTO v_ob FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'place' AND o.place = v_row.place;
      SELECT COALESCE(sum(p.amount),0) INTO v_evidence
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p."position" = v_row.place AND p.user_id = v_row.user_id;
      IF v_ob.id IS NULL OR v_ob.user_id IS DISTINCT FROM v_row.user_id
         OR v_ob.amount_owed IS DISTINCT FROM v_row.amount
         OR v_ob.amount_paid IS DISTINCT FROM v_row.amount
         OR v_evidence IS DISTINCT FROM v_row.amount THEN
        RAISE EXCEPTION 'post-settlement proof failed for tournament %, place %',
          p_tournament_id, v_row.place USING ERRCODE = 'P0404';
      END IF;
    END IF;
    v_payouts := v_payouts || jsonb_build_object(
      'place',v_row.place,'user_id',v_row.user_id,'amount',v_row.amount);
  END LOOP;

  RETURN jsonb_build_object(
    'ok',true,
    'fully_settled',true,
    'status',v_status,
    'payouts',v_payouts,
    'bubble_protection',CASE WHEN v_bubble_amount > 0 THEN
      jsonb_build_object('user_id',v_bubble_user_id,'position',v_bubble_place,
                         'amount',v_bubble_amount)
      ELSE 'null'::jsonb END,
    'winner_amount',v_winner_amount);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_places(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_places(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_bounty_obligation_has_complete_marker(p_obligation_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE((
    SELECT CASE WHEN o.mode='mystery_chest' THEN
      EXISTS (
        SELECT 1 FROM public.tournament_bounty_awards a
         WHERE a.bounty_obligation_id=o.id AND a.status='completed'
           AND (SELECT COALESCE(sum(r.amount_cents),0)
                  FROM public.tournament_bounty_award_recipients r
                 WHERE r.award_id=a.id AND r.paid_at IS NOT NULL)=a.amount_cents
           AND NOT EXISTS (
             SELECT 1
               FROM (
                 SELECT claimant_id,ordinal,claimant_count,
                        floor(a.amount_cents / claimant_count)
                          + CASE WHEN ordinal <= mod(a.amount_cents,claimant_count)
                                 THEN 1 ELSE 0 END AS expected_cents
                   FROM (
                     SELECT (c->>'user_id')::uuid AS claimant_id,
                            row_number() OVER (ORDER BY c->>'user_id') AS ordinal,
                            count(*) OVER () AS claimant_count
                       FROM jsonb_array_elements(o.claimants) c
                   ) ordered_claimants
               ) expected
              WHERE NOT EXISTS (
                SELECT 1 FROM public.tournament_bounty_award_recipients r
                 WHERE r.award_id=a.id AND r.user_id=expected.claimant_id
                   AND r.amount_cents=expected.expected_cents
                   AND r.paid_at IS NOT NULL
              )
           )
           AND NOT EXISTS (
             SELECT 1 FROM public.tournament_bounty_award_recipients r
              WHERE r.award_id=a.id
                AND (r.paid_at IS NULL OR NOT EXISTS (
                  SELECT 1 FROM jsonb_array_elements(o.claimants) c
                   WHERE (c->>'user_id')::uuid=r.user_id
                ))
           )
      )
    ELSE
      NOT EXISTS (
        SELECT 1
          FROM (
            SELECT claimant_id, ordinal, claimant_count,
                   CASE WHEN ordinal < claimant_count
                        THEN floor(head_cents / claimant_count)
                        ELSE head_cents
                             - floor(head_cents / claimant_count) * (claimant_count - 1)
                   END AS expected_cents
              FROM (
                SELECT (c->>'user_id')::uuid AS claimant_id,
                       row_number() OVER (ORDER BY c->>'user_id') AS ordinal,
                       count(*) OVER () AS claimant_count,
                       round(o.head_amount * 100)::bigint AS head_cents
                  FROM jsonb_array_elements(o.claimants) c
              ) ordered_claimants
          ) expected
         WHERE expected.expected_cents > 0
           AND NOT EXISTS (
           SELECT 1 FROM public.tournament_bounties b
            WHERE b.bounty_obligation_id=o.id
              AND b.collector_player_id=expected.claimant_id
              AND round(b.bounty_amount * 100)::bigint=expected.expected_cents
              AND round(COALESCE(b.added_to_collector_bounty,0) * 100)::bigint=
                    CASE WHEN o.mode='pko'
                         THEN expected.expected_cents-floor(expected.expected_cents/2.0)::bigint
                         ELSE 0 END
              AND round((b.bounty_amount-COALESCE(b.added_to_collector_bounty,0))*100)::bigint=
                    CASE WHEN o.mode='pko'
                         THEN floor(expected.expected_cents/2.0)::bigint
                         ELSE expected.expected_cents END
         )
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.tournament_bounties b
         WHERE b.bounty_obligation_id=o.id
           AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(o.claimants) c
              WHERE (c->>'user_id')::uuid=b.collector_player_id
           )
      )
      AND round(COALESCE((
        SELECT sum(b.bounty_amount) FROM public.tournament_bounties b
         WHERE b.bounty_obligation_id=o.id
      ),0),2)=round(o.head_amount,2)
    END
      FROM public.tournament_bounty_obligations o
     WHERE o.id=p_obligation_id
  ),false);
$function$;
REVOKE ALL ON FUNCTION public.fn_bounty_obligation_has_complete_marker(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_bounty_obligation_has_complete_marker(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_claim_bounty_legacy_candidate_20260907(p_tournament_id uuid, p_eliminated_user_id uuid, p_position integer, p_prize numeric, p_table_id uuid, p_hand_id uuid, p_hand_number bigint, p_seat_joined_at timestamp with time zone, p_knocker_user_id uuid, p_claimants jsonb, p_bubble_refund numeric DEFAULT 0, p_allow_existing_eliminated boolean DEFAULT false)
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
  v_settlement_at timestamptz;
  v_settlement_hand_text text;
  v_settlement_hand_id uuid;
  v_mode text;
  v_claimants jsonb;
  v_input_claimants jsonb;
  v_knocker uuid;
  v_head numeric;
  v_hand_created_at timestamptz;
  v_position integer;
  v_prize numeric;
  v_claimed boolean := false;
  v_existing public.tournament_bounty_obligations%ROWTYPE;
  v_obligation_id uuid;
  v_activation_generation bigint := 0;
  v_pko_watermark bigint;
  v_bounty_blocked text := NULL;
BEGIN
  IF p_tournament_id IS NULL OR p_eliminated_user_id IS NULL
     OR p_table_id IS NULL OR p_hand_id IS NULL OR p_hand_number IS NULL
     OR p_hand_number<1000000 OR p_seat_joined_at IS NULL
     OR p_bubble_refund IS NULL OR p_bubble_refund<0 THEN
    RETURN jsonb_build_object('ok',false,'reason','missing_identity');
  END IF;
  IF p_bubble_refund<>0 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','bubble_refund_requires_finalized_batch');
  END IF;

  IF p_claimants IS NOT NULL THEN
    IF jsonb_typeof(p_claimants)<>'array' OR jsonb_array_length(p_claimants)=0
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_claimants) e
          WHERE coalesce(e->>'user_id','')
                  !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             OR coalesce(e->>'weight','') !~ '^[0-9]+([.][0-9]+)?$'
             OR (e->>'weight')::numeric<=0
       ) THEN
      RETURN jsonb_build_object('ok',false,'reason','invalid_claimants');
    END IF;
    SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'weight',1)
                     ORDER BY user_id::text)
      INTO v_input_claimants
      FROM (
        SELECT DISTINCT (e->>'user_id')::uuid AS user_id
          FROM jsonb_array_elements(p_claimants) e
      ) q;
  END IF;

  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;

  -- A hand triple is the immutable replay key. Two legitimate bounties may
  -- have the same player and seat_joined_at after a same-chair rebuy.
  SELECT * INTO v_existing
    FROM public.tournament_bounty_obligations o
   WHERE o.tournament_id=p_tournament_id
     AND o.table_id=p_table_id
     AND o.hand_id=p_hand_id
     AND o.hand_number=p_hand_number
     AND o.eliminated_user_id=p_eliminated_user_id
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing.table_id IS DISTINCT FROM p_table_id
       OR v_existing.hand_id IS DISTINCT FROM p_hand_id
       OR v_existing.seat_joined_at IS DISTINCT FROM p_seat_joined_at
       OR v_existing.bubble_refund IS DISTINCT FROM round(p_bubble_refund,2)
       OR v_existing.position IS DISTINCT FROM p_position
       OR v_existing.prize IS DISTINCT FROM round(p_prize,2)
       OR (p_knocker_user_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(v_existing.claimants) c
              WHERE c->>'user_id'=p_knocker_user_id::text))
       OR (v_input_claimants IS NOT NULL
           AND v_existing.claimants IS DISTINCT FROM v_input_claimants) THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','obligation_identity_conflict');
    END IF;
    IF v_existing.state='settled'
       AND NOT public.fn_bounty_obligation_has_complete_marker(v_existing.id) THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','settled_marker_incomplete',
        'obligation_id',v_existing.id);
    END IF;
    RETURN jsonb_build_object(
      'ok',true,'already',true,'claimed',false,
      'mode',v_existing.mode,'state',v_existing.state,
      'activation_generation',v_existing.activation_generation,
      'obligation_id',v_existing.id);
  END IF;

  IF NOT (coalesce(v_t.is_bounty,false) OR coalesce(v_t.is_pko,false)
          OR coalesce(v_t.is_mystery_bounty,false)) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_bounty_tournament');
  END IF;
  IF upper(coalesce(v_t.status,''))<>'RUNNING'
     AND NOT (p_allow_existing_eliminated
              AND upper(coalesce(v_t.status,''))='COMPLETING') THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_lifecycle_not_claimable',
      'status',v_t.status);
  END IF;

  SELECT * INTO v_player FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.user_id=p_eliminated_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','player_not_found');
  END IF;
  IF coalesce(v_player.chips,0)>0 THEN
    RETURN jsonb_build_object('ok',false,'reason','player_has_chips');
  END IF;
  IF v_player.status<>'playing' THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','status_not_claimable','status',v_player.status);
  END IF;
  IF p_position IS NULL OR p_position<2 OR p_prize IS NULL OR p_prize<0 THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_place_or_prize');
  END IF;
  v_position:=p_position;
  v_prize:=p_prize;

  SELECT a.* INTO v_atomic
    FROM public.hand_atomic_commits a
   WHERE a.table_id=p_table_id
     AND a.hand_number=p_hand_number
     AND a.hand_id=p_hand_id;
  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM public.hand_atomic_commits a
       WHERE a.table_id=p_table_id AND a.hand_number=p_hand_number
    ) THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','atomic_knockout_history_identity_conflict');
    END IF;
    RETURN jsonb_build_object(
      'ok',false,'reason','atomic_knockout_evidence_required');
  END IF;

  v_settlement_hand_text:=v_atomic.stack_result->>'hand_id';
  IF coalesce(v_settlement_hand_text,'')
       !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_atomic.stack_result->>'table_id'<>p_table_id::text
     OR coalesce(v_atomic.stack_result->>'hand_number','')
          !~ '^[0-9]+$'
     OR (v_atomic.stack_result->>'hand_number')::bigint<>p_hand_number
     OR coalesce(v_atomic.stack_result->'written'
                   ->>p_eliminated_user_id::text,'')
          !~ '^-?[0-9]+([.][0-9]+)?$'
     OR (v_atomic.stack_result->'written'
           ->>p_eliminated_user_id::text)::numeric<>0 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','atomic_knockout_candidate_identity_conflict');
  END IF;
  v_settlement_hand_id:=v_settlement_hand_text::uuid;

  SELECT c.* INTO v_candidate
    FROM public.tournament_knockout_candidates c
   WHERE c.tournament_id=p_tournament_id
     AND c.table_id=p_table_id
     AND c.hand_number=p_hand_number
     AND c.hand_id=p_hand_id
     AND c.eliminated_user_id=p_eliminated_user_id;
  IF NOT FOUND
     OR v_candidate.seat_joined_at IS DISTINCT FROM p_seat_joined_at THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','atomic_knockout_candidate_identity_conflict');
  END IF;

  SELECT k.completed_at INTO v_settlement_at
    FROM public.settlement_idempotency_keys k
   WHERE k.table_id=p_table_id
     AND k.hand_id=v_settlement_hand_id
     AND k.status='succeeded'
     AND k.completed_at IS NOT NULL
     AND k.completed_at>=p_seat_joined_at
     AND coalesce(k.result->>'hand_number','') ~ '^[0-9]+$'
     AND (k.result->>'hand_number')::bigint=p_hand_number
     AND k.result->>'table_id'=p_table_id::text
     AND k.result->'written' ? p_eliminated_user_id::text
     AND coalesce(k.result->'written'->>p_eliminated_user_id::text,'')
           ~ '^-?[0-9]+([.][0-9]+)?$'
     AND (k.result->'written'->>p_eliminated_user_id::text)::numeric=0;
  IF v_settlement_at IS NULL THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','accepted_zero_settlement_not_found');
  END IF;

  SELECT h.created_at INTO v_hand_created_at
    FROM public.hand_history h
   WHERE h.id=p_hand_id
     AND h.table_id=p_table_id
     AND h.hand_number=p_hand_number
     AND h.hand_number>=1000000
     AND h.created_at>=v_settlement_at
     AND h.created_at>=p_seat_joined_at
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(coalesce(h.players,'[]'::jsonb)) player
        WHERE coalesce(player->>'userId',player->>'user_id')=
                p_eliminated_user_id::text
          AND coalesce(player->>'stack','') ~ '^-?[0-9]+([.][0-9]+)?$'
          AND (player->>'stack')::numeric=0
     );
  IF v_hand_created_at IS NULL THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','exact_knockout_history_not_found');
  END IF;

  v_claimants:=public.fn_exact_tournament_knockout_claimants(
    p_tournament_id,p_hand_id,p_eliminated_user_id);
  IF v_claimants IS NULL OR jsonb_array_length(v_claimants)=0 THEN
    /* A PLACE IS NOT A BOUNTY (2026-09-10).
       fn_exact_tournament_knockout_claimants returns NULL when it cannot
       name the exact winner of the last pot the busted player was eligible
       for, and it is right to refuse to guess. That is a reason not to PAY
       a bounty. It is not a reason to withhold a finishing place from a
       player who provably busted - refusing here left 33 busts unrecorded
       across nine events and held their prize escrow for days. */
    v_bounty_blocked:='exact_pot_claimants_not_found';
    v_claimants:='[]'::jsonb;
  END IF;
  SELECT (e->>'user_id')::uuid INTO v_knocker
    FROM jsonb_array_elements(v_claimants) e
   ORDER BY e->>'user_id' LIMIT 1;
  IF v_bounty_blocked IS NULL AND p_knocker_user_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_claimants) e
        WHERE e->>'user_id'=p_knocker_user_id::text
     ) THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_knocker');
  END IF;
  IF v_bounty_blocked IS NULL AND v_input_claimants IS NOT NULL
     AND v_input_claimants IS DISTINCT FROM v_claimants THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','claimants_do_not_match_exact_pot');
  END IF;

  v_mode:=CASE
    WHEN coalesce(v_t.is_mystery_bounty,false)
         AND v_t.mystery_bounty_stage='active' THEN 'mystery_chest'
    WHEN coalesce(v_t.is_pko,false) THEN 'pko'
    WHEN coalesce(v_t.is_mystery_bounty,false) THEN 'mystery_pre'
    ELSE 'regular'
  END;
  v_activation_generation:=CASE WHEN v_mode='mystery_chest'
    THEN v_t.mystery_bounty_activation_generation ELSE 0 END;
  IF v_mode='mystery_chest' AND (
       v_activation_generation<=0 OR NOT EXISTS (
         SELECT 1 FROM public.tournament_mystery_activation_receipts ar
          WHERE ar.tournament_id=p_tournament_id
            AND ar.activation_generation=v_activation_generation
       )) THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','mystery_activation_evidence_missing');
  END IF;

  IF v_mode='pko' THEN
    SELECT w.last_settled_hand_number INTO v_pko_watermark
      FROM public.tournament_pko_settlement_watermarks w
     WHERE w.tournament_id=p_tournament_id FOR UPDATE;
    IF v_pko_watermark IS NOT NULL AND p_hand_number<v_pko_watermark THEN
      /* The watermark keeps PKO bounties in payment order and cannot be
         rewound without letting settled bounties re-settle, so a bust
         behind it can never be paid in order. The player still busted and
         the place is still theirs: record it, and leave the head in the
         pool for fn_finalize_bounty_pool to resolve as residual. */
      v_bounty_blocked:=COALESCE(v_bounty_blocked,'pko_order_already_advanced');
    END IF;
  END IF;

  IF v_bounty_blocked IS NULL AND v_mode='pko' AND EXISTS (
    SELECT 1 FROM public.tournament_bounty_obligations prior
     WHERE prior.tournament_id=p_tournament_id
       AND prior.mode='pko' AND prior.state='pending'
       AND (prior.hand_number<p_hand_number
            OR (prior.hand_number=p_hand_number
                AND prior.eliminated_user_id::text<
                    p_eliminated_user_id::text))
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(prior.claimants) c
          WHERE c->>'user_id'=p_eliminated_user_id::text
       )
  ) THEN
    RETURN jsonb_build_object('ok',false,'reason','pending_pko_predecessor');
  END IF;

  IF v_bounty_blocked IS NULL AND v_mode='pko' AND EXISTS (
    SELECT 1
      FROM public.hand_history h
      CROSS JOIN LATERAL
        jsonb_array_elements(coalesce(h.players,'[]'::jsonb)) hp
     WHERE h.id=p_hand_id
       AND coalesce(hp->>'userId',hp->>'user_id','')
             ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND coalesce(hp->>'userId',hp->>'user_id')<>
             p_eliminated_user_id::text
       AND coalesce(hp->>'stack','') ~ '^-?[0-9]+([.][0-9]+)?$'
       AND (hp->>'stack')::numeric<=0
       AND public.fn_exact_tournament_knockout_claimants(
             p_tournament_id,h.id,
             coalesce(hp->>'userId',hp->>'user_id')::uuid)
             @> jsonb_build_array(jsonb_build_object(
                  'user_id',p_eliminated_user_id,'weight',1))
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_bounty_obligations predecessor
          WHERE predecessor.tournament_id=p_tournament_id
            AND predecessor.hand_number=p_hand_number
            AND predecessor.eliminated_user_id=
                coalesce(hp->>'userId',hp->>'user_id')::uuid
            AND predecessor.state='settled'
       )
  ) THEN
    RETURN jsonb_build_object('ok',false,'reason','same_hand_pko_predecessor');
  END IF;

  v_head:=coalesce(nullif(v_player.current_bounty,0),
                   nullif(v_t.bounty_amount,0));
  IF coalesce(v_head,0)<=0 THEN
    v_bounty_blocked:=COALESCE(v_bounty_blocked,'exact_head_value_not_found');
  END IF;

  UPDATE public.tournament_players tp
     SET status='eliminated',position=p_position,prize=p_prize,
         eliminated_at=now()
   WHERE tp.tournament_id=p_tournament_id
     AND tp.user_id=p_eliminated_user_id
     AND tp.status='playing' AND tp.chips<=0;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bounty elimination CAS missed after locked claim'
      USING ERRCODE='serialization_failure';
  END IF;
  v_claimed:=true;

  IF v_bounty_blocked IS NULL THEN
  INSERT INTO public.tournament_bounty_obligations(
    tournament_id,eliminated_user_id,table_id,hand_id,hand_number,
    settlement_completed_at,seat_joined_at,position,prize,bubble_refund,
    mode,activation_generation,head_amount,knocker_user_id,claimants,
    next_attempt_at)
  VALUES (
    p_tournament_id,p_eliminated_user_id,p_table_id,p_hand_id,p_hand_number,
    v_settlement_at,p_seat_joined_at,v_position,round(v_prize,2),0,
    v_mode,v_activation_generation,round(v_head,2),v_knocker,v_claimants,
    CASE WHEN v_mode='mystery_chest' THEN now()+interval '30 seconds'
         ELSE now() END)
  RETURNING id INTO v_obligation_id;
  ELSE
    /* The bust is recorded and placed above. The head could not be
       attributed, so no obligation is written: fn_tournament_has_unsettled_bounties
       only sees obligations that EXIST, so the event can finish, and the
       head stays in tournaments.bounty_pool for fn_finalize_bounty_pool to
       resolve as residual with its own completion receipt. This row is the
       record that it happened - severity `warning`, so
       fn_ca_financial_alert_to_incident (which promotes only `critical`)
       does not raise a board item per bust. A listed fact, not an alarm. */
    INSERT INTO public.financial_alerts(severity,source,message,context)
    VALUES ('warning',
      'fn_claim_tournament_bounty_elimination.bounty_head_not_attributed',
      'A bust was recorded and placed, but its bounty head could not be '
        ||'attributed ('||v_bounty_blocked||'); the head stays in the '
        ||'bounty pool as residual.',
      jsonb_build_object('tournament_id',p_tournament_id,
        'eliminated_user_id',p_eliminated_user_id,'table_id',p_table_id,
        'hand_id',p_hand_id,'hand_number',p_hand_number,
        'position',v_position,'head_amount',round(coalesce(v_head,0),2),
        'mode',v_mode,'reason',v_bounty_blocked));
  END IF;

  UPDATE public.table_seats s
     SET left_at=coalesce(s.left_at,now())
   WHERE s.table_id=p_table_id AND s.user_id=p_eliminated_user_id
     AND s.joined_at=p_seat_joined_at AND s.left_at IS NULL;
  UPDATE public.tables tb
     SET current_players=(
       SELECT count(*) FROM public.table_seats s
        WHERE s.table_id=p_table_id AND s.left_at IS NULL)
   WHERE tb.id=p_table_id;
  PERFORM public.fn_sync_seat_first_player_count(p_tournament_id);

  UPDATE public.tournament_bounty_obligations o
     SET state='settled',settled_at=now()
   WHERE o.id=v_obligation_id
     AND public.fn_bounty_obligation_has_complete_marker(o.id);

  RETURN jsonb_build_object(
    'ok',true,'already',false,'claimed',v_claimed,'mode',v_mode,
    'bounty_blocked',v_bounty_blocked,
    'state',(SELECT o.state FROM public.tournament_bounty_obligations o
              WHERE o.id=v_obligation_id),
    'activation_generation',v_activation_generation,'bubble_refund',0,
    'obligation_id',v_obligation_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean) FROM PUBLIC;

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
  v_atomic public.hand_atomic_commits%ROWTYPE;
  v_live public.table_seats%ROWTYPE;
  v_evidence_stack numeric;
  v_settlement_hand_text text;
  v_settlement_hand_id uuid;
  v_live_count integer;
  v_changed integer;
  v_result jsonb;
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

  SELECT c.* INTO v_candidate
    FROM public.tournament_knockout_candidates c
   WHERE c.id=public.fn_ca_latest_committed_knockout_candidate(
     p_tournament_id,p_eliminated_user_id);
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
  IF EXISTS (
    SELECT 1 FROM public.tournament_knockout_candidates c
     WHERE c.tournament_id=p_tournament_id
       AND c.eliminated_user_id=p_eliminated_user_id
       AND c.hand_number<v_candidate.hand_number
       AND c.state<>'rebought'
  ) THEN
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
        USING ERRCODE='serialization_failure';
    END IF;
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_finished_but_not_completed(p_minutes integer DEFAULT 15)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_count   int := 0;
  v_sample  jsonb := '[]'::jsonb;
  v_open    boolean;
  v_cutoff  interval := make_interval(mins => GREATEST(COALESCE(p_minutes, 15), 1));
BEGIN
  WITH stuck AS (
    SELECT t.id AS tournament_id,
           t.name,
           t.started_at,
           (SELECT count(*) FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id
               AND tp.status IN ('playing', 'active', 'registered')) AS alive,
           (SELECT max(tp.eliminated_at) FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id AND tp.eliminated_at IS NOT NULL) AS last_elimination,
           (SELECT count(*) FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id) AS entrants
      FROM public.tournaments t
     WHERE t.status = 'RUNNING'
       AND COALESCE(t.variant, '') <> 'satellite'
       AND upper(COALESCE(t.tournament_type, '')) <> 'SATELLITE'
  )
  SELECT count(*),
         COALESCE(jsonb_agg(jsonb_build_object(
           'tournament_id', tournament_id,
           'name', left(COALESCE(name, ''), 60),
           'entrants', entrants,
           'alive', alive,
           'last_elimination', last_elimination,
           'stuck_for_minutes', round(extract(epoch FROM (now() - last_elimination)) / 60.0, 1))
           ORDER BY last_elimination), '[]'::jsonb)
    INTO v_count, v_sample
    FROM stuck
   WHERE alive <= 1
     AND last_elimination IS NOT NULL
     AND last_elimination < now() - v_cutoff;

  IF v_count > 0 THEN
    SELECT EXISTS (
      SELECT 1 FROM public.financial_alerts fa
       WHERE fa.source = 'fn_ca_tournament_finished_but_not_completed'
         AND COALESCE(fa.resolved, false) = false
    ) INTO v_open;

    IF NOT v_open THEN
      INSERT INTO public.financial_alerts (severity, source, message, context)
      VALUES (
        'critical',
        'fn_ca_tournament_finished_but_not_completed',
        format(
          '%s tournament(s) have one player or fewer left and have not completed '
          || 'for over %s minute(s). Their winners are unpaid, and every other payout '
          || 'check on this database only judges COMPLETED tournaments, so nothing '
          || 'else can see them. Healthy tournaments settle within 20s of the final '
          || 'elimination (p99 over 4,242 events).',
          v_count, GREATEST(COALESCE(p_minutes, 15), 1)),
        jsonb_build_object(
          'checked_at', now(),
          'threshold_minutes', GREATEST(COALESCE(p_minutes, 15), 1),
          'tournaments', v_sample,
          'cause', 'elimination sweep overruns on a saturated engine thread - '
                || 'see docs/HANDOFF_CURRENT_STATE.md section 16 (P0/P1) and '
                || 'docs/changelog/2026-09-07-the-collapse-was-not-the-reload-storm.md')
      );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'checked_at', now(),
    'threshold_minutes', GREATEST(COALESCE(p_minutes, 15), 1),
    'stuck', v_count,
    'tournaments', v_sample
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_finished_but_not_completed(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_finished_but_not_completed(integer) TO service_role;

CREATE TRIGGER zz_stamp_tournament_elimination_sequence
  BEFORE INSERT OR UPDATE OF status, elimination_sequence ON public.tournament_players
  FOR EACH ROW EXECUTE FUNCTION public.fn_stamp_tournament_elimination_sequence();
CREATE CONSTRAINT TRIGGER tournament_elimination_has_a_place
  AFTER INSERT OR UPDATE OF status, "position" ON public.tournament_players
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_tournament_elimination_has_a_place();
