-- 20260911062048_a_bust_is_ranked_by_when_it_happened
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-11 06:20:48 UTC.
--
-- WHAT WAS WRONG (read from production 2026-09-11, read-only).
--
-- 1. THE DOOR STAMPED THE WRONG TIME. fn_eliminate_player_legacy_candidate_20260907,
--    the write half of fn_eliminate_tournament_player_atomic, set
--    eliminated_at = now(): the moment the door ACCEPTED a bust, not the moment
--    the hand took the stack. fn_normalize_tournament_final_standings and
--    fn_prepare_tournament_place_obligations rank every finishing place from
--    eliminated_at, and the engine's skip rule for a player the door keeps
--    refusing (TournamentManagerEliminations) assumed it was the bust time.
--    It was not: in 798866ae 64 of 83 eliminations were recorded
--    more than a minute after the bust, 26 more than an hour, one 26h42m later,
--    so a bust the door refused for a while took a better place than everyone
--    who busted after it.
--
-- 2. THE NORMALIZER MOVED PLACES WITHOUT MOVING THEIR PRICE. When chronology
--    disagreed with the provisional ladder it renumbered positions and left
--    tp.prize on the player, so a prize stamped at one place travelled to
--    another and fn_prepare_tournament_place_obligations then refused the event
--    for ever with recorded_prize_disagrees_with_structure.
--
-- 3. AN ORPHANED GENERATION BLOCKED A REAL BUST FOR EVER. The 2026-09-08/09
--    rebuy chain bought players back in without resolving the busted knockout
--    generation to 'rebought'. The door then refused each of those players' next,
--    real bust with unresolved_knockout_generation_chain: 356 refusals of
--    9bb330b7 in 798866ae in 39 minutes, and 3a7ad729, f44d72f2, f8058099 in
--    7aa16fa7. Each orphan is followed by a posted 1.00 'rebuy' leg from the
--    player's wallet to the event's prize liability, seconds after the bust
--    (09-09 05:27:55 and 05:28:32 for 9bb330b7).
--
-- WHAT THIS CHANGES. Three existing functions, same signatures, same owner,
-- same grants (restated below), nothing else in them touched:
--
--   fn_eliminate_player_legacy_candidate_20260907 stamps eliminated_at from the
--     bust hand: hand_atomic_commits.committed_at of the latest committed
--     zero-stack generation (the candidate the door has just bound), plus one
--     microsecond per earlier rank in the same hand, smaller hand-start stack
--     first, then user id. eliminated_at order is therefore bust order. A bust
--     whose hand cannot be read is refused (knockout_bust_time_unproven), never
--     stamped with the clock.
--   fn_eliminate_tournament_player_atomic resolves an older PENDING generation
--     to 'rebought' when, and only when, a posted 'rebuy' leg from this player's
--     wallet to this event's prize liability was written after that generation
--     was captured and before the player's next generation was. Anything
--     unproven is refused exactly as before. The resolution commits with the
--     newer bust and is reported as rebought_generations.
--   fn_normalize_tournament_final_standings re-prices every row it moves with
--     fn_prepare_tournament_place_obligations's own rule, in the same write.
--     It refuses (moved_places_cannot_be_repriced_after_money_moved) rather than
--     re-price once any tournament_payouts or tournament_obligations row exists
--     for the event, and refuses (moved_places_cannot_be_priced) when the ladder
--     cannot be derived; in both cases nothing is renumbered. A prepared batch
--     or a COMPLETED event is still never rewritten. Satellites are renumbered
--     exactly as before.
--
-- WHAT IT DOES NOT CHANGE, AND A REVIEWER MUST READ THIS. The engine's terminal
-- path (fn_complete_tournament_terminal -> fn_settle_tournament_places) does not
-- rank by eliminated_at: it orders eliminated players by elimination_sequence,
-- which a trigger stamps when the status flips, i.e. in RECORDING order, and it
-- renumbers positions to that order before paying. This migration therefore
-- fixes the prepare/ruling path and makes eliminated_at a true bust witness; it
-- does not by itself make a late-recorded bust take its true place on the
-- engine's finish. That is a decision about fn_settle_tournament_places, left
-- out of this change on purpose.
--
-- MEASURED BEFORE APPLYING (2026-09-11 ~06:20 UTC): exactly four players in
-- RUNNING events are held by an older non-rebought generation, and all four are
-- proven by the rule above (798866ae 9bb330b7; 7aa16fa7 3a7ad729, f44d72f2,
-- f8058099). The engine's next bust pass can record them, subject to every other
-- check the door makes (798866ae's other stuck player, 65f99ae2, is refused for
-- a zero-stack live seat, which this does not touch).
--
-- PROVED in PostgreSQL 17 against a byte-exact capture of the live bodies:
-- scripts/dev/probe-a-bust-is-ranked-by-when-it-happened-pg17.sh runs every
-- scenario against the old bodies (each fixed behaviour must fail there), then
-- applies this file twice and runs them again.
--
-- One transaction (CLAUDE.md production DDL policy). The preflight refuses to
-- apply over any body, owner, grant or setting it was not reviewed against,
-- including the two functions it reads (fn_ca_latest_committed_knockout_candidate
-- and fn_prepare_tournament_place_obligations, whose pricing rule is copied).
-- Apply outside the :50-:03 break window.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)')
       AND md5(p.prosrc) IN ('f596d731cacf8d7e62a4549204ce73fc', '334c7166d2b46972bf965857864c90cd')
       AND p.proowner = 'postgres'::regrole
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.prosecdef AND NOT p.proisstrict AND p.provolatile = 'v'
       AND NOT p.proretset AND p.prorettype = 'jsonb'::regtype
       AND p.prolang = (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql')
       AND p.proconfig::text = '{"search_path=public, pg_temp"}'
  ) THEN
    RAISE EXCEPTION 'Source function body or authority changed; review before applying: public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)')
       AND md5(p.prosrc) IN ('b4937067d9bf337e1466095b9e1d5424', 'e7b370dfa13a2f98b2292b104d886afd')
       AND p.proowner = 'postgres'::regrole
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.prosecdef AND NOT p.proisstrict AND p.provolatile = 'v'
       AND NOT p.proretset AND p.prorettype = 'jsonb'::regtype
       AND p.prolang = (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql')
       AND p.proconfig::text = '{"search_path=public, pg_temp"}'
  ) THEN
    RAISE EXCEPTION 'Source function body or authority changed; review before applying: public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_normalize_tournament_final_standings(uuid)')
       AND md5(p.prosrc) IN ('ad865880f99bc28896bec03c66ae55a9', '1b93c5dde741b7dd6f48e9d4ee0177e5')
       AND p.proowner = 'postgres'::regrole
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.prosecdef AND NOT p.proisstrict AND p.provolatile = 'v'
       AND NOT p.proretset AND p.prorettype = 'jsonb'::regtype
       AND p.prolang = (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql')
       AND p.proconfig::text = '{search_path=public}'
  ) THEN
    RAISE EXCEPTION 'Source function body or authority changed; review before applying: public.fn_normalize_tournament_final_standings(uuid)'
      USING ERRCODE = '55000';
  END IF;
  -- Read, not replaced: the candidate the door binds, and the ladder rule the
  -- normalizer now prices with. Either one changing means this was not the
  -- change that was reviewed.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_ca_latest_committed_knockout_candidate(uuid,uuid)')
       AND md5(p.prosrc) = '0602827901be20bbb6e0dce6ece17f94'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_prepare_tournament_place_obligations(uuid,text)')
       AND md5(p.prosrc) = 'ca0abbc6d297f3009143676261d8cf19'
  ) THEN
    RAISE EXCEPTION 'A function this change reads was redefined; review before applying'
      USING ERRCODE = '55000';
  END IF;
END;
$preflight$;

-- The write half of the door: eliminated_at is the commit time of the bust hand.
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
  v_bust_at timestamptz;
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
  /* A BUST IS RANKED BY WHEN IT HAPPENED (2026-09-11). This stamped now(),
     the moment the door ACCEPTED the bust, and every finishing place is
     ranked from eliminated_at. A bust the door refused for a while - an
     orphaned generation, a stale seat - therefore took a better place than
     every player who busted after it: in 798866ae 64 of 83 busts were
     recorded more than a minute late, 26 more than an hour, one 26h42m.
     The bust is the accepted hand that took the stack: the latest committed
     zero-stack generation, the same candidate the calling door has just
     bound and proved, and its hand_atomic_commits row carries the commit
     time. Players who bust in one hand are one microsecond apart per rank,
     smaller hand-start stack first (it busts first and finishes lower), then
     user id, so eliminated_at order is bust order. A bust whose hand cannot
     be read is refused; it is never stamped with the clock. */
  SELECT a.committed_at
         + (SELECT count(*)
              FROM public.tournament_knockout_candidates s
             WHERE s.tournament_id=c.tournament_id
               AND s.table_id=c.table_id
               AND s.hand_number=c.hand_number
               AND s.hand_id=c.hand_id
               AND (s.stack_before,s.eliminated_user_id)
                   <(c.stack_before,c.eliminated_user_id))::integer
           * interval '1 microsecond'
    INTO v_bust_at
    FROM public.tournament_knockout_candidates c
    JOIN public.hand_atomic_commits a
      ON a.table_id=c.table_id
     AND a.hand_number=c.hand_number
     AND a.hand_id=c.hand_id
   WHERE c.id=public.fn_ca_latest_committed_knockout_candidate(
           p_tournament_id,p_user_id)
     AND c.tournament_id=p_tournament_id
     AND c.eliminated_user_id=p_user_id
     AND c.state='pending';
  IF v_bust_at IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','knockout_bust_time_unproven');
  END IF;
  UPDATE public.tournament_players
     SET status='eliminated',position=p_position,prize=round(p_prize,2),eliminated_at=v_bust_at
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

-- The door: a generation a rebuy paid for is not a live bust. Nothing else in it changes.
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
  v_rebought_generations uuid[] := ARRAY[]::uuid[];
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
  /* A GENERATION A REBUY PAID FOR IS NOT A LIVE BUST (2026-09-11).
     The 2026-09-08/09 rebuy chain bought players back in without marking the
     busted generation 'rebought', so each left an older 'pending' row, and
     this check then refused every later, real bust of the same player for
     ever: 798866ae 9bb330b7 (356 refusals in 39 minutes), 7aa16fa7 3a7ad729,
     f44d72f2 and f8058099. Two further orphans sit in a5aa6984.
     A pending generation is proven bought back - not a bust anybody still
     owes a place - when a posted 'rebuy' leg moved this player's own wallet
     into this event's prize liability AFTER that generation was captured and
     BEFORE the player's next generation was: the chips busted at the next
     hand are the chips that leg paid for. Only such rows are resolved to
     'rebought', and only in the transaction that records the newer bust. A
     leg outside that window proves nothing, a generation in any other state
     is not touched, and anything unproven is refused exactly as before. */
  SELECT COALESCE(array_agg(c.id ORDER BY c.hand_number,c.id),ARRAY[]::uuid[])
    INTO v_rebought_generations
    FROM public.tournament_knockout_candidates c
   WHERE c.tournament_id=p_tournament_id
     AND c.eliminated_user_id=p_user_id
     AND c.hand_number<v_candidate.hand_number
     AND c.state='pending'
     AND EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.from_entity_id=p_user_id
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
               AND n.eliminated_user_id=p_user_id
               AND n.hand_number>c.hand_number
             ORDER BY n.hand_number,n.id
             LIMIT 1));
  IF EXISTS (
    SELECT 1 FROM public.tournament_knockout_candidates c
     WHERE c.tournament_id=p_tournament_id
       AND c.eliminated_user_id=p_user_id
       AND c.hand_number<v_candidate.hand_number
       AND c.state<>'rebought'
       AND c.id<>ALL(v_rebought_generations)
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
  -- The proven older generations close with the bust that proved them.
  IF coalesce((v_result->>'ok')::boolean,false)
     AND cardinality(v_rebought_generations)>0 THEN
    UPDATE public.tournament_knockout_candidates c
       SET state='rebought',resolved_at=clock_timestamp()
     WHERE c.id=ANY(v_rebought_generations)
       AND c.tournament_id=p_tournament_id
       AND c.eliminated_user_id=p_user_id
       AND c.state='pending';
    GET DIAGNOSTICS v_changed=ROW_COUNT;
    IF v_changed<>cardinality(v_rebought_generations) THEN
      RAISE EXCEPTION 'a bought-back knockout generation changed while elimination committed'
        USING ERRCODE='serialization_failure';
    END IF;
    v_result:=v_result||jsonb_build_object(
      'rebought_generations',to_jsonb(v_rebought_generations));
  END IF;
  RETURN v_result;
END;
$function$;

-- The standings normalizer: a moved place is re-priced in the same write.
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
  v_t                   record;
  v_struct              jsonb := '[]'::jsonb;
  v_trimmed             jsonb := '[]'::jsonb;
  v_prices              jsonb := '{}'::jsonb;
  v_reprice             jsonb := '{}'::jsonb;
  v_price_failure       text;
  v_pool_cents          bigint := 0;
  v_remaining_cents     bigint := 0;
  v_expected_cents      bigint := 0;
  v_total_bp            bigint := 0;
  v_price_places        integer := 0;
  v_price_distinct      integer := 0;
  v_price_first         integer := 0;
  v_price_last          integer := 0;
  v_reprice_rows        integer := 0;
  v_repriced            integer := 0;
  v_price_mismatches    integer := 0;
  v_money_payouts       integer := 0;
  v_money_obligations   integer := 0;
  r                     record;
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

  /* A MOVED PLACE IS RE-PRICED IN THE SAME WRITE (2026-09-11).
     This renumbered positions and left tp.prize where it was, so the prize a
     player was provisionally stamped with at one place travelled with them to
     another, and fn_prepare_tournament_place_obligations - which demands that
     every paid place holds exactly its structure amount - then refused the
     event for ever with recorded_prize_disagrees_with_structure. Every row
     this assignment moves is priced here with prepare's own rule: the
     structure trimmed to the field, bp = round(percentage * 100), each place
     least(remaining, round(pool_cents * bp / total_bp)), the last paid place
     takes the remainder, a Spin's drawn ladder by spin_multiplier. A place
     outside the ladder is worth zero. Satellites pay seats, not this ladder,
     and are renumbered exactly as before.
     It prices only while no money has moved for the event. A payout or an
     obligation means a place was paid or promised against the old order;
     re-pricing under it could pay a place twice or take one back, so that is
     refused, loudly, and nothing is renumbered. (A prepared batch already
     returned above as frozen.) A ladder that cannot be derived is refused the
     same way rather than guessed. */
  SELECT round(COALESCE(t.prize_pool, 0), 2) AS prize_pool,
         round(COALESCE(t.guaranteed_prize, 0), 2) AS guaranteed_prize,
         COALESCE(t.prize_pool_finalized, false) AS prize_pool_finalized,
         t.payout_structure, t.variant, t.tournament_type,
         t.satellite_target_id, t.spin_multiplier
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;

  IF NOT (lower(COALESCE(v_t.variant, '')) = 'satellite'
          OR upper(COALESCE(v_t.tournament_type, '')) = 'SATELLITE'
          OR v_t.satellite_target_id IS NOT NULL) THEN
    IF NOT v_t.prize_pool_finalized
       OR v_t.prize_pool + 0.005 < v_t.guaranteed_prize THEN
      v_price_failure := 'prize_pool_is_not_funded_and_finalized';
    ELSE
      v_pool_cents := round(v_t.prize_pool * 100)::bigint;
    END IF;

    IF v_price_failure IS NULL AND v_pool_cents > 0 THEN
      BEGIN
        IF lower(COALESCE(v_t.variant, '')) = 'spin'
           OR upper(COALESCE(v_t.tournament_type, '')) = 'SPIN' THEN
          IF v_t.spin_multiplier IS NULL OR v_t.spin_multiplier <= 0 THEN
            v_price_failure := 'spin_multiplier_is_not_persisted';
          ELSE
            SELECT l.structure INTO v_struct
              FROM public.spin_payout_ladder l
             WHERE l.multiplier = v_t.spin_multiplier;
            IF NOT FOUND THEN
              v_price_failure := 'spin_multiplier_has_no_canonical_ladder';
            END IF;
          END IF;
        ELSE
          v_struct := public.fn_safe_jsonb_array(v_t.payout_structure);
        END IF;
        IF v_price_failure IS NULL AND (jsonb_array_length(v_struct) = 0 OR EXISTS (
          SELECT 1
            FROM jsonb_array_elements(v_struct) e
           WHERE jsonb_typeof(e) <> 'object'
              OR COALESCE(e->>'place', '') !~ '^[1-9][0-9]*$'
              OR COALESCE(e->>'percentage', '') !~ '^[0-9]+([.][0-9]+)?$'
              OR (e->>'percentage')::numeric < 0
        )) THEN
          v_price_failure := 'payout_structure_is_invalid';
        END IF;
        IF v_price_failure IS NULL THEN
          SELECT COALESCE(jsonb_agg(e ORDER BY (e->>'place')::integer), '[]'::jsonb)
            INTO v_trimmed
            FROM jsonb_array_elements(v_struct) e
           WHERE (e->>'place')::integer <= v_player_count;

          SELECT count(*), count(DISTINCT (e->>'place')::integer),
                 COALESCE(min((e->>'place')::integer), 0),
                 COALESCE(max((e->>'place')::integer), 0),
                 COALESCE(sum(round((e->>'percentage')::numeric * 100)::bigint), 0)
            INTO v_price_places, v_price_distinct, v_price_first, v_price_last,
                 v_total_bp
            FROM jsonb_array_elements(v_trimmed) e;

          IF v_price_places = 0 OR v_price_distinct <> v_price_places
             OR v_price_first <> 1 OR v_price_last <> v_price_places
             OR v_total_bp <= 0 THEN
            v_price_failure := 'payout_places_are_not_contiguous';
          END IF;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_price_failure := 'payout_structure_is_invalid';
      END;

      IF v_price_failure IS NULL THEN
        v_remaining_cents := v_pool_cents;
        FOR r IN
          SELECT (e->>'place')::integer AS place,
                 round((e->>'percentage')::numeric * 100)::bigint AS bp
            FROM jsonb_array_elements(v_trimmed) e
           ORDER BY (e->>'place')::integer
        LOOP
          IF r.place = v_price_last THEN
            v_expected_cents := GREATEST(v_remaining_cents, 0);
          ELSE
            v_expected_cents := GREATEST(
              LEAST(v_remaining_cents, round(v_pool_cents * r.bp::numeric / v_total_bp)::bigint), 0);
          END IF;
          v_remaining_cents := v_remaining_cents - v_expected_cents;
          v_prices := v_prices || jsonb_build_object(r.place::text, v_expected_cents);
        END LOOP;
      END IF;
    END IF;

    WITH eliminated AS (
      SELECT tp.id, tp.position AS old_position,
             round(COALESCE(tp.prize, 0) * 100)::bigint AS old_cents,
             v_player_count - (row_number() OVER (
               ORDER BY tp.eliminated_at ASC, tp.id ASC
             ))::integer + 1 AS canonical_position
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status = 'eliminated'
    )
    SELECT count(*),
           COALESCE(jsonb_object_agg(e.id::text,
             COALESCE((v_prices->>e.canonical_position::text)::bigint, 0)), '{}'::jsonb)
      INTO v_reprice_rows, v_reprice
      FROM eliminated e
     WHERE e.old_position IS DISTINCT FROM e.canonical_position
       AND (v_price_failure IS NOT NULL
            OR e.old_cents <> COALESCE((v_prices->>e.canonical_position::text)::bigint, 0));

    IF v_reprice_rows > 0 AND v_price_failure IS NOT NULL THEN
      RAISE WARNING 'tournament %: % moved place(s) cannot be priced (%); final standings left as they were',
        p_tournament_id, v_reprice_rows, v_price_failure;
      RETURN jsonb_build_object('ok', false, 'reason', 'moved_places_cannot_be_priced',
                                'detail', v_price_failure, 'rows', v_reprice_rows,
                                'retryable', false);
    END IF;

    IF v_reprice_rows > 0 THEN
      SELECT count(*) INTO v_money_payouts
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id;
      SELECT count(*) INTO v_money_obligations
        FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id;
      IF v_money_payouts > 0 OR v_money_obligations > 0 THEN
        RAISE WARNING 'tournament %: % moved place(s) would be re-priced after money moved (% payout row(s), % obligation(s)); refused, final standings left as they were',
          p_tournament_id, v_reprice_rows, v_money_payouts, v_money_obligations;
        RETURN jsonb_build_object('ok', false,
                                  'reason', 'moved_places_cannot_be_repriced_after_money_moved',
                                  'rows', v_reprice_rows, 'payouts', v_money_payouts,
                                  'obligations', v_money_obligations, 'retryable', false);
      END IF;
    END IF;
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

    IF v_reprice_rows > 0 THEN
      UPDATE public.tournament_players tp
         SET prize = round((v_reprice->>tp.id::text)::numeric / 100, 2)
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status = 'eliminated'
         AND v_reprice ? tp.id::text;
      GET DIAGNOSTICS v_repriced = ROW_COUNT;
      SELECT count(*) INTO v_price_mismatches
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status = 'eliminated'
         AND v_reprice ? tp.id::text
         AND round(COALESCE(tp.prize, 0) * 100)::bigint
             <> COALESCE((v_prices->>tp.position::text)::bigint, 0);
      IF v_repriced <> v_reprice_rows OR v_price_mismatches <> 0 THEN
        RAISE EXCEPTION USING
          MESSAGE = 'the moved places were not re-priced to the ladder',
          ERRCODE = '23514';
      END IF;
    END IF;

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
                            'repriced', v_repriced, 'retryable', false);
END;
$function$;

-- Restate the current authority explicitly; no new caller is admitted.
REVOKE ALL ON FUNCTION public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_normalize_tournament_final_standings(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_normalize_tournament_final_standings(uuid)
  TO service_role;

DO $postflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)')
       AND md5(p.prosrc) IN ('334c7166d2b46972bf965857864c90cd')
       AND p.proowner = 'postgres'::regrole
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.prosecdef AND NOT p.proisstrict AND p.provolatile = 'v'
       AND NOT p.proretset AND p.prorettype = 'jsonb'::regtype
       AND p.prolang = (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql')
       AND p.proconfig::text = '{"search_path=public, pg_temp"}'
  ) THEN
    RAISE EXCEPTION 'Reviewed function body or authority changed during migration: public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)')
       AND md5(p.prosrc) IN ('e7b370dfa13a2f98b2292b104d886afd')
       AND p.proowner = 'postgres'::regrole
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.prosecdef AND NOT p.proisstrict AND p.provolatile = 'v'
       AND NOT p.proretset AND p.prorettype = 'jsonb'::regtype
       AND p.prolang = (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql')
       AND p.proconfig::text = '{"search_path=public, pg_temp"}'
  ) THEN
    RAISE EXCEPTION 'Reviewed function body or authority changed during migration: public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_normalize_tournament_final_standings(uuid)')
       AND md5(p.prosrc) IN ('1b93c5dde741b7dd6f48e9d4ee0177e5')
       AND p.proowner = 'postgres'::regrole
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.prosecdef AND NOT p.proisstrict AND p.provolatile = 'v'
       AND NOT p.proretset AND p.prorettype = 'jsonb'::regtype
       AND p.prolang = (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql')
       AND p.proconfig::text = '{search_path=public}'
  ) THEN
    RAISE EXCEPTION 'Reviewed function body or authority changed during migration: public.fn_normalize_tournament_final_standings(uuid)'
      USING ERRCODE = '55000';
  END IF;
END;
$postflight$;
COMMIT;
