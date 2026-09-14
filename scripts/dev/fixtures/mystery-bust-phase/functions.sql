-- Installed function bodies captured read-only with pg_get_functiondef on 2026-09-11
-- (production, PostgreSQL 17.6), byte-for-byte. The three bodies the migration
-- rewrites are captured BEFORE it, so its anchors are proven against live text.
SET check_function_bodies = off;
-- live: public.fn_ca_lock_settlement_lane_for_tournament
CREATE OR REPLACE FUNCTION public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id uuid, p_table_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid := p_tournament_id;
BEGIN
  -- Resolve the tournament before any lock, so G's mode can depend on it.
  -- tables.tournament_id is fixed for the life of a table: reading it here
  -- gives the answer reading it under G did.
  IF v_tournament_id IS NULL AND p_table_id IS NOT NULL THEN
    SELECT tb.tournament_id INTO v_tournament_id
    FROM public.tables tb
    WHERE tb.id = p_table_id;
  END IF;

  IF v_tournament_id IS NULL THEN
    -- Nothing to scope to: the whole lane, as it always was - G exclusive,
    -- then B exclusive (the shape of fn_ca_lock_settlement_lane_global).
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ca:tournament-terminal-settlement:v1', 0));
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ca:hand-settlement-barrier:v1', 0));
    RETURN;
  END IF;

  -- G SHARED: waits for, and excludes, terminal authorities (G exclusive)
  -- and nothing else. Rolling authorities of different tournaments run side
  -- by side; the trigger guards take T(id) held exclusively as their proof.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-terminal-settlement:v1', 0));

  -- T(id) EXCLUSIVE: one rolling authority per tournament at a time, and
  -- this tournament's hand settlements (T(id) shared) wait for it.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1:' || v_tournament_id::text, 0));
END;
$function$;
-- live: public.fn_bounty_obligation_has_complete_marker
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
-- live: public.fn_tournament_has_unsettled_bounties
CREATE OR REPLACE FUNCTION public.fn_tournament_has_unsettled_bounties(p_tournament_id uuid)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    EXISTS (
      SELECT 1 FROM public.tournament_bounty_obligations o
       WHERE o.tournament_id=p_tournament_id AND o.state='pending'
    )
    OR EXISTS (
      -- `settled` is only a cache of the marker trigger's last verdict. The
      -- canonical ledger/award can never be allowed to drift underneath it:
      -- finalisation re-proves the complete generation marker every time.
      SELECT 1 FROM public.tournament_bounty_obligations o
       WHERE o.tournament_id=p_tournament_id AND o.state='settled'
         AND NOT public.fn_bounty_obligation_has_complete_marker(o.id)
    )
    OR EXISTS (
      SELECT 1 FROM public.tournament_bounty_awards a
       WHERE a.tournament_id=p_tournament_id AND a.status IN ('reserved','revealed','paid')
    );
$function$;
-- live: public.fn_exact_tournament_knockout_claimants
CREATE OR REPLACE FUNCTION public.fn_exact_tournament_knockout_claimants(p_tournament_id uuid, p_hand_id uuid, p_eliminated_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pots jsonb;
  v_winners jsonb;
  v_last_pot integer;
  v_winning_pot integer;
  v_chosen_pot_count integer;
  v_raw_winner_count integer;
  v_valid_winner_count integer;
  v_distinct_winner_count integer;
  v_chosen_eligible jsonb;
  v_chosen_pot jsonb;
  v_claimants jsonb;
BEGIN
  SELECT h.pots, h.winners INTO v_pots, v_winners
    FROM public.hand_history h
   WHERE h.id = p_hand_id;
  IF jsonb_typeof(v_pots) <> 'array' OR jsonb_array_length(v_pots) = 0
     OR jsonb_typeof(v_winners) <> 'array' OR jsonb_array_length(v_winners) = 0 THEN
    RETURN NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_winners) w
     WHERE COALESCE(w->>'potIndex',w->>'pot_index','') !~ '^[0-9]+$'
  ) THEN
    RETURN NULL;
  END IF;

  WITH pots AS (
    SELECT CASE WHEN COALESCE(p->>'index','') ~ '^[0-9]+$'
                THEN (p->>'index')::integer ELSE ordinality::integer - 1 END AS pot_index,
           COALESCE(p->'eligible', p->'eligiblePlayers', '[]'::jsonb) AS eligible
      FROM jsonb_array_elements(v_pots) WITH ORDINALITY AS q(p, ordinality)
  )
  SELECT max(pot_index) INTO v_last_pot
    FROM pots
   WHERE jsonb_typeof(eligible) = 'array'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(eligible) e(user_id)
                  WHERE e.user_id = p_eliminated_user_id::text);
  IF v_last_pot IS NULL THEN RETURN NULL; END IF;

  -- A modern row that cannot name a valid winner of the exact last pot is
  -- incomplete. Do not walk down to a different pot or largest winner: that
  -- would assign money to somebody who did not own the knockout.
  v_winning_pot := v_last_pot;

  SELECT count(*)
    INTO v_chosen_pot_count
    FROM jsonb_array_elements(v_pots) WITH ORDINALITY AS q(p,ordinality)
   WHERE CASE WHEN COALESCE(p->>'index','') ~ '^[0-9]+$'
              THEN (p->>'index')::integer ELSE ordinality::integer-1 END=v_winning_pot;
  IF v_chosen_pot_count<>1 THEN
    RETURN NULL;
  END IF;
  SELECT p, COALESCE(p->'eligible',p->'eligiblePlayers','[]'::jsonb)
    INTO v_chosen_pot, v_chosen_eligible
    FROM jsonb_array_elements(v_pots) WITH ORDINALITY AS q(p,ordinality)
   WHERE CASE WHEN COALESCE(p->>'index','') ~ '^[0-9]+$'
              THEN (p->>'index')::integer ELSE ordinality::integer-1 END=v_winning_pot;
  IF jsonb_typeof(v_chosen_eligible)<>'array' THEN RETURN NULL; END IF;

  -- New accepted hands preserve each actual pot/half award beside that pot.
  -- The flat winners list contains merged paid totals and only the first
  -- potIndex for a player who won several pots. Do not reconstruct from it
  -- when exact evidence is supplied, including malformed or empty evidence.
  IF v_chosen_pot ? 'awards' THEN
    v_winners := v_chosen_pot->'awards';
    IF jsonb_typeof(v_winners) IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
    IF jsonb_array_length(v_winners)=0 THEN RETURN NULL; END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_winners) w
       WHERE COALESCE(w->>'potIndex',w->>'pot_index','') !~ '^[0-9]+$'
    ) THEN RETURN NULL; END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_winners) w
       WHERE (COALESCE(w->>'potIndex',w->>'pot_index'))::numeric<>v_winning_pot
    ) THEN RETURN NULL; END IF;
  END IF;


  -- Never canonicalise corruption by filtering it away. Every winner row for
  -- the exact pot must name one distinct tournament participant who is in the
  -- pot's eligible set. A malformed outsider in a tie makes the whole money
  -- authority unavailable; it does not enlarge the valid player's share.
  WITH exact_winners AS (
    SELECT w,COALESCE(w->>'userId',w->>'user_id','') AS user_id_text
      FROM jsonb_array_elements(v_winners) w
     WHERE COALESCE(w->>'potIndex',w->>'pot_index')::integer=v_winning_pot
  ), classified AS (
    SELECT user_id_text,
           user_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             AND user_id_text<>p_eliminated_user_id::text
             AND EXISTS (SELECT 1 FROM public.tournament_players tp
                          WHERE tp.tournament_id=p_tournament_id
                            AND tp.user_id=CASE
                              WHEN user_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                              THEN user_id_text::uuid ELSE NULL END)
             AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_chosen_eligible) e(user_id)
                          WHERE e.user_id=user_id_text) AS valid
      FROM exact_winners
  )
  SELECT count(*),count(*) FILTER (WHERE valid),
         count(DISTINCT user_id_text) FILTER (WHERE valid)
    INTO v_raw_winner_count,v_valid_winner_count,v_distinct_winner_count
    FROM classified;
  -- Hi-lo histories legitimately contain one row for the high half and one
  -- for the low half when the same player scoops. Validate every source row,
  -- then canonicalise to distinct claimant ids below; duplicate winner rows
  -- are not duplicate people and must not invalidate an otherwise exact pot.
  IF v_raw_winner_count=0 OR v_valid_winner_count<>v_raw_winner_count
     OR v_distinct_winner_count=0 THEN
    RETURN NULL;
  END IF;

  WITH participants AS (
    SELECT DISTINCT COALESCE(w->>'userId',w->>'user_id')::uuid AS user_id
      FROM jsonb_array_elements(v_winners) w
     WHERE COALESCE(w->>'potIndex',w->>'pot_index')::integer=v_winning_pot
  )
  SELECT jsonb_agg(jsonb_build_object('user_id', user_id, 'weight', 1)
                   ORDER BY user_id::text)
    INTO v_claimants FROM participants;
  RETURN v_claimants;
END;
$function$;
-- live: public.fn_claim_bounty_legacy_candidate_20260907
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
-- live: public.fn_collect_bounty
CREATE OR REPLACE FUNCTION public.fn_collect_bounty(p_tournament_id uuid, p_eliminated_user_id uuid, p_collector_user_id uuid, p_claimants jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  o public.tournament_bounty_obligations%ROWTYPE;
  v_result jsonb;
  v_shares jsonb;
  v_paid_cash numeric;
  v_added_to_head numeric;
  v_context text := current_setting('app.bounty_obligation_id',true);
  v_prior_context text;
  v_obligation_count integer;
  v_pko_watermark bigint;
  v_t record;
  v_elim record;
  v_head numeric;
  v_available numeric;
  v_payable numeric;
  v_cash numeric;
  v_to_head numeric;
  v_cents integer;
  v_cash_cents integer;
  v_mode text;
  v_funded boolean;
  v_claimants jsonb;
  v_n integer;
  v_total_weight numeric;
  v_paid_total numeric := 0;
  v_head_total numeric := 0;
  c record;
  v_share_cents integer;
  v_assigned_cents integer := 0;
  v_i integer := 0;
  v_prior numeric;
  v_settle jsonb;
  v_desc text;
  v_core_collector_user_id uuid;
  v_core_claimants jsonb;
BEGIN
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  PERFORM 1 FROM public.tournaments t WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','tournament_not_found'); END IF;

  IF COALESCE(v_context,'')
       ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    SELECT * INTO o FROM public.tournament_bounty_obligations bo
     WHERE bo.id=v_context::uuid AND bo.tournament_id=p_tournament_id
       AND bo.eliminated_user_id=p_eliminated_user_id
       AND bo.mode<>'mystery_chest'
     FOR UPDATE;
  ELSE
    SELECT count(*) INTO v_obligation_count
      FROM public.tournament_bounty_obligations bo
     WHERE bo.tournament_id=p_tournament_id
       AND bo.eliminated_user_id=p_eliminated_user_id
       AND bo.mode<>'mystery_chest';
    IF v_obligation_count>1 THEN
      RETURN jsonb_build_object('ok',false,'reason','bounty_generation_identity_required');
    END IF;
    SELECT * INTO o FROM public.tournament_bounty_obligations bo
     WHERE bo.tournament_id=p_tournament_id
       AND bo.eliminated_user_id=p_eliminated_user_id
       AND bo.mode<>'mystery_chest'
     FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','bounty_obligation_not_ready');
  END IF;
  IF o.mode='pko' THEN
    SELECT w.last_settled_hand_number INTO v_pko_watermark
      FROM public.tournament_pko_settlement_watermarks w
     WHERE w.tournament_id=o.tournament_id FOR UPDATE;
    IF v_pko_watermark IS NOT NULL AND o.hand_number<v_pko_watermark THEN
      RETURN jsonb_build_object('ok',false,'reason','pko_order_already_advanced',
                                'last_settled_hand_number',v_pko_watermark);
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.tournament_bounty_obligations prior
       WHERE prior.tournament_id=o.tournament_id AND prior.mode='pko'
         AND prior.state='pending' AND prior.hand_number<o.hand_number
    ) THEN
      RETURN jsonb_build_object('ok',false,'reason','pending_pko_predecessor');
    END IF;
  END IF;
  IF o.state='settled' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'user_id',b.collector_player_id,
             'cash',GREATEST(0,b.bounty_amount-COALESCE(b.added_to_collector_bounty,0)),
             'to_head',COALESCE(b.added_to_collector_bounty,0))
             ORDER BY b.collector_player_id),'[]'::jsonb),
           COALESCE(sum(GREATEST(0,b.bounty_amount-COALESCE(b.added_to_collector_bounty,0))),0),
           COALESCE(sum(b.added_to_collector_bounty),0)
      INTO v_shares,v_paid_cash,v_added_to_head
      FROM public.tournament_bounties b
     WHERE b.bounty_obligation_id=o.id;
    IF NOT public.fn_bounty_obligation_has_complete_marker(o.id) THEN
      RETURN jsonb_build_object('ok',false,'reason','settled_marker_incomplete',
                                'obligation_id',o.id);
    END IF;
    IF o.mode='pko' THEN
      INSERT INTO public.tournament_pko_settlement_watermarks
        (tournament_id,last_settled_hand_number,last_obligation_id)
      VALUES (o.tournament_id,o.hand_number,o.id)
      ON CONFLICT (tournament_id) DO UPDATE
        SET last_settled_hand_number=GREATEST(
              public.tournament_pko_settlement_watermarks.last_settled_hand_number,
              EXCLUDED.last_settled_hand_number),
            last_obligation_id=CASE
              WHEN EXCLUDED.last_settled_hand_number>=
                   public.tournament_pko_settlement_watermarks.last_settled_hand_number
              THEN EXCLUDED.last_obligation_id
              ELSE public.tournament_pko_settlement_watermarks.last_obligation_id END,
            updated_at=now();
    END IF;
    RETURN jsonb_build_object('ok',true,'already',true,'obligation_id',o.id,
      'marker_verified',true,'mode',o.mode,'head',o.head_amount,
      'paid_cash',v_paid_cash,'added_to_head',v_added_to_head,
      'split',jsonb_array_length(v_shares)>1,'shares',v_shares);
  END IF;

  -- Ignore caller ordering/weights. The exact pot-derived, roster-validated
  -- snapshot stored by the atomic claim is the only payout authority. The
  -- audited payer is inlined here so this root survives retirement of the
  -- temporary rolling-deployment body.
  v_core_collector_user_id := o.knocker_user_id;
  v_core_claimants := o.claimants;
  v_prior_context := current_setting('app.bounty_obligation_id',true);
  PERFORM set_config('app.bounty_obligation_id',o.id::text,true);

  <<collect_core>>
  BEGIN
    IF v_core_collector_user_id IS NULL OR p_eliminated_user_id IS NULL THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'missing_party');
      EXIT collect_core;
    END IF;

    SELECT id, is_bounty, is_pko, is_mystery_bounty, bounty_amount,
           bounty_pool, bounty_pool_paid, mystery_bounty_stage
      INTO v_t FROM tournaments WHERE id = p_tournament_id FOR UPDATE;
    IF NOT FOUND THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
      EXIT collect_core;
    END IF;
    IF NOT (COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
            OR COALESCE(v_t.is_mystery_bounty,false)) THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'not_a_bounty_tournament');
      EXIT collect_core;
    END IF;

    IF COALESCE(v_t.is_pko, false) AND COALESCE(v_t.is_mystery_bounty, false) THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'undefined_pko_mystery_hybrid',
        'detail', 'PKO heads claim against bounty_pool; mystery chests are a sealed '
               || 'inventory. No split satisfies both. This event should not exist.');
      EXIT collect_core;
    END IF;

    IF COALESCE(v_t.is_mystery_bounty, false)
       AND v_t.mystery_bounty_stage = 'active' THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'mystery_phase_active');
      EXIT collect_core;
    END IF;

    IF EXISTS (
      SELECT 1 FROM tournament_bounties b
       WHERE b.tournament_id = p_tournament_id
         AND b.eliminated_player_id = p_eliminated_user_id
         AND (
           b.bounty_obligation_id = (SELECT pending.id
             FROM tournament_bounty_obligations pending
            WHERE pending.tournament_id=p_tournament_id
              AND pending.eliminated_user_id=p_eliminated_user_id
              AND pending.mode <> 'mystery_chest' AND pending.state='pending'
            ORDER BY pending.hand_number, pending.created_at LIMIT 1)
           OR (b.bounty_obligation_id IS NULL AND NOT EXISTS (
             SELECT 1 FROM tournament_bounty_obligations pending
              WHERE pending.tournament_id=p_tournament_id
                AND pending.eliminated_user_id=p_eliminated_user_id
                AND pending.mode <> 'mystery_chest' AND pending.state='pending'))
         )
    ) THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'already_collected');
      EXIT collect_core;
    END IF;

    SELECT current_bounty INTO v_elim
      FROM tournament_players
     WHERE tournament_id = p_tournament_id AND user_id = p_eliminated_user_id
     FOR UPDATE;
    IF NOT FOUND THEN
      v_result := jsonb_build_object(
        'ok', false, 'reason', 'eliminated_player_not_in_tournament');
      EXIT collect_core;
    END IF;

    v_mode := CASE WHEN COALESCE(v_t.is_pko,false) THEN 'pko'
                   WHEN COALESCE(v_t.is_mystery_bounty,false) THEN 'mystery_pre'
                   ELSE 'regular' END;

    v_head := COALESCE(NULLIF(v_elim.current_bounty, 0), v_t.bounty_amount, 0);
    IF v_head <= 0 THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'no_head_value');
      EXIT collect_core;
    END IF;
    IF EXISTS (
      SELECT 1 FROM tournament_bounty_obligations pending
       WHERE pending.tournament_id=p_tournament_id
         AND pending.eliminated_user_id=p_eliminated_user_id
         AND pending.mode <> 'mystery_chest' AND pending.state='pending'
         AND pending.head_amount IS DISTINCT FROM round(v_head,2)
    ) THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'head_snapshot_changed');
      EXIT collect_core;
    END IF;

    v_funded := COALESCE(v_t.bounty_pool, 0) > 0;
    SELECT round(COALESCE(v_t.bounty_pool,0) - COALESCE(SUM(
             CASE WHEN lower(wt.type) = 'debit' THEN -abs(wt.amount)
                  ELSE wt.amount END), 0), 2)
      INTO v_available
      FROM wallet_transactions wt
     WHERE wt.related_entity_id = p_tournament_id
       AND wt.category = 'bounty';

    IF v_funded THEN
      IF v_available <= 0 THEN
        v_result := jsonb_build_object('ok', false, 'reason', 'bounty_pool_exhausted',
                                      'head', v_head, 'available', v_available);
        EXIT collect_core;
      END IF;
      IF v_available < v_head THEN
        v_result := jsonb_build_object('ok', false, 'reason', 'bounty_pool_underfunded',
                                      'head', v_head, 'available', v_available);
        EXIT collect_core;
      END IF;
      v_payable := v_head;
    ELSE
      v_payable := v_head;
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'user_id', x.uid, 'weight', x.w)), '[]'::jsonb)
      INTO v_claimants
      FROM (
        SELECT (e->>'user_id')::uuid AS uid, (e->>'weight')::numeric AS w
          FROM jsonb_array_elements(COALESCE(v_core_claimants, '[]'::jsonb)) e
         WHERE (e->>'user_id') IS NOT NULL
           AND COALESCE((e->>'weight')::numeric, 0) > 0
           AND EXISTS (
             SELECT 1 FROM tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND tp.user_id = (e->>'user_id')::uuid)
      ) x;
    v_n := jsonb_array_length(v_claimants);
    IF v_n <= 1 THEN
      v_claimants := jsonb_build_array(jsonb_build_object(
        'user_id', v_core_collector_user_id, 'weight', 1));
      v_n := 1;
    END IF;
    SELECT sum((e->>'weight')::numeric) INTO v_total_weight
      FROM jsonb_array_elements(v_claimants) e;

    v_cents := round(v_payable * 100)::integer;
    v_desc := CASE v_mode
      WHEN 'pko' THEN 'PKO bounty (cash half) from eliminated player'
      WHEN 'mystery_pre' THEN 'Bounty collected before the mystery phase opened'
      ELSE 'Bounty collected from eliminated player' END
      || CASE WHEN v_n > 1 THEN ' (split pot, ' || v_n || ' winners)' ELSE '' END;
    v_shares := '[]'::jsonb;

    FOR c IN
      SELECT (e->>'user_id')::uuid AS uid, (e->>'weight')::numeric AS w
        FROM jsonb_array_elements(v_claimants) e
       ORDER BY (e->>'weight')::numeric ASC, (e->>'user_id')
    LOOP
      v_i := v_i + 1;
      IF v_i < v_n THEN
        v_share_cents := floor(v_cents * c.w / v_total_weight)::integer;
      ELSE
        v_share_cents := v_cents - v_assigned_cents;
      END IF;
      v_assigned_cents := v_assigned_cents + v_share_cents;
      CONTINUE WHEN v_share_cents <= 0;

      IF v_mode = 'pko' THEN
        v_cash_cents := (v_share_cents / 2)::integer;
        v_cash := v_cash_cents / 100.0;
        v_to_head := (v_share_cents - v_cash_cents) / 100.0;
      ELSE
        v_cash := v_share_cents / 100.0;
        v_to_head := 0;
      END IF;

      IF v_cash > 0 THEN
        v_prior := COALESCE((
          SELECT debt.amount_paid FROM public.tournament_obligations debt
           WHERE debt.tournament_id = p_tournament_id
             AND debt.kind = 'bounty'
             AND debt.place IS NULL
             AND debt.user_id = c.uid), 0);
        v_settle := public.fn_settle_tournament_obligation(
          p_tournament_id, 'bounty', NULL, c.uid, round(v_prior + v_cash, 2),
          'fn_collect_bounty', v_desc);
        IF NOT COALESCE((v_settle->>'ok')::boolean, false) THEN
          RAISE EXCEPTION
            'fn_collect_bounty: bounty of % to % in tournament % refused (%); nothing recorded',
            v_cash, c.uid, p_tournament_id,
            COALESCE(v_settle->>'refused_reason', 'unknown');
        END IF;
        IF round(COALESCE((v_settle->>'paid')::numeric, 0), 2)
             <> round(v_cash, 2) THEN
          RAISE EXCEPTION
            'fn_collect_bounty: obligation paid % but the share is % for % in tournament %; nothing recorded',
            v_settle->>'paid', v_cash, c.uid, p_tournament_id;
        END IF;
      END IF;

      UPDATE tournament_players
         SET bounties_collected = COALESCE(bounties_collected,0) + 1,
             bounty_winnings = round(COALESCE(bounty_winnings,0) + v_cash, 2),
             current_bounty = round(COALESCE(current_bounty,0) + v_to_head, 2)
       WHERE tournament_id = p_tournament_id AND user_id = c.uid;

      INSERT INTO tournament_bounties
        (tournament_id, eliminated_player_id, collector_player_id, bounty_amount,
         added_to_collector_bounty, is_mystery_revealed)
      VALUES
        (p_tournament_id, p_eliminated_user_id, c.uid,
         round(v_share_cents / 100.0, 2),
         CASE WHEN v_to_head > 0 THEN v_to_head ELSE NULL END, false);

      v_paid_total := v_paid_total + v_cash;
      v_head_total := v_head_total + v_to_head;
      v_shares := v_shares || jsonb_build_object(
        'user_id', c.uid, 'cash', v_cash, 'to_head', v_to_head);
    END LOOP;

    UPDATE tournament_players SET current_bounty = 0
     WHERE tournament_id = p_tournament_id AND user_id = p_eliminated_user_id;

    IF v_funded THEN
      UPDATE tournaments
         SET bounty_pool_paid = round(COALESCE(bounty_pool_paid,0) + v_paid_total, 2)
       WHERE id = p_tournament_id;
    END IF;

    v_result := jsonb_build_object(
      'ok', true, 'mode', v_mode, 'funded', v_funded,
      'head', v_head, 'paid_cash', round(v_paid_total, 2),
      'added_to_head', round(v_head_total, 2),
      'split', v_n > 1, 'shares', v_shares,
      'capped', v_funded AND v_payable < v_head,
      'pool_remaining', CASE WHEN v_funded
                             THEN round(v_available - v_paid_total, 2) END);
  END collect_core;

  PERFORM set_config('app.bounty_obligation_id',COALESCE(v_prior_context,''),true);

  IF NOT COALESCE((v_result->>'ok')::boolean,false) THEN
    -- A semantic pre-write refusal is safe to commit and stays pending. Any
    -- accepted payer result below must satisfy the exact marker postcondition
    -- or raise so its wallet/head/counter mutations roll back atomically.
    RETURN v_result || jsonb_build_object('obligation_id',o.id);
  END IF;

  UPDATE public.tournament_bounty_obligations bo
     SET state='settled',settled_at=COALESCE(settled_at,now()),last_error=NULL
   WHERE bo.id=o.id AND bo.state='pending'
     AND public.fn_bounty_obligation_has_complete_marker(bo.id);
  IF NOT public.fn_bounty_obligation_has_complete_marker(o.id)
     OR NOT EXISTS (SELECT 1 FROM public.tournament_bounty_obligations bo
                     WHERE bo.id=o.id AND bo.state='settled') THEN
    RAISE EXCEPTION 'accepted bounty payout did not produce the exact settled marker for %',o.id
      USING ERRCODE='check_violation';
  END IF;
  IF o.mode='pko' THEN
    INSERT INTO public.tournament_pko_settlement_watermarks
      (tournament_id,last_settled_hand_number,last_obligation_id)
    VALUES (o.tournament_id,o.hand_number,o.id)
    ON CONFLICT (tournament_id) DO UPDATE
      SET last_settled_hand_number=GREATEST(
            public.tournament_pko_settlement_watermarks.last_settled_hand_number,
            EXCLUDED.last_settled_hand_number),
          last_obligation_id=CASE
            WHEN EXCLUDED.last_settled_hand_number>=
                 public.tournament_pko_settlement_watermarks.last_settled_hand_number
            THEN EXCLUDED.last_obligation_id
            ELSE public.tournament_pko_settlement_watermarks.last_obligation_id END,
          updated_at=now();
  END IF;
  RETURN v_result || jsonb_build_object('obligation_id',o.id,'marker_verified',true);
END;
$function$;
-- live: public.fn_collect_bounty_obligation
CREATE OR REPLACE FUNCTION public.fn_collect_bounty_obligation(p_obligation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  o public.tournament_bounty_obligations%ROWTYPE;
  v_prior_context text := current_setting('app.bounty_obligation_id',true);
  v_result jsonb;
BEGIN
  SELECT * INTO o FROM public.tournament_bounty_obligations WHERE id=p_obligation_id;
  IF NOT FOUND OR o.mode='mystery_chest' THEN
    RETURN jsonb_build_object('ok',false,'reason','bounty_obligation_not_found');
  END IF;
  PERFORM set_config('app.bounty_obligation_id',o.id::text,true);
  v_result := public.fn_collect_bounty(
    o.tournament_id,o.eliminated_user_id,o.knocker_user_id,o.claimants);
  PERFORM set_config('app.bounty_obligation_id',COALESCE(v_prior_context,''),true);
  RETURN v_result;
END;
$function$;
-- live: public.fn_mystery_bounty_seed
CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_seed(p_tournament_id uuid, p_players_remaining integer, p_chests jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record;
  v_pool_cents bigint;
  v_bounty_cents bigint;
  v_m numeric; v_r numeric;
  v_sum bigint; v_count int;
BEGIN
  SELECT id, is_mystery_bounty, prize_pool_finalized, bounty_pool,
         bounty_pool_paid, mystery_bounty_stage,
         mystery_bounty_pool_percent, mystery_bounty_regular_pool_percent,
         mystery_bounty_pool_cents
    INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;

  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;
  IF NOT COALESCE(v_t.is_mystery_bounty, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_mystery_bounty');
  END IF;

  -- IDEMPOTENT. The engine's activation check runs on a five-second sweep and
  -- a restart re-runs it; seeding twice would double the inventory and the
  -- event could never reconcile.
  IF v_t.mystery_bounty_stage <> 'pending' THEN
    SELECT count(*), COALESCE(sum(amount_cents), 0) INTO v_count, v_sum
      FROM public.tournament_bounty_chests WHERE tournament_id = p_tournament_id;
    RETURN jsonb_build_object('ok', true, 'already_seeded', true,
      'stage', v_t.mystery_bounty_stage, 'chests', v_count,
      'pool_cents', COALESCE(v_t.mystery_bounty_pool_cents, v_sum));
  END IF;

  -- ENTRY MUST BE CLOSED. bounty_pool still grows with every late entry,
  -- rebuy and add-on; an inventory built before the close is built from a pool
  -- smaller than the one the event ends up holding.
  IF NOT COALESCE(v_t.prize_pool_finalized, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'entry_still_open');
  END IF;

  IF p_chests IS NULL OR jsonb_typeof(p_chests) <> 'array' OR jsonb_array_length(p_chests) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'chests_required');
  END IF;
  IF jsonb_array_length(p_chests) <> GREATEST(p_players_remaining - 1, 0) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'chest_count_mismatch',
      'chests', jsonb_array_length(p_chests), 'players_remaining', p_players_remaining);
  END IF;

  v_bounty_cents := round(COALESCE(v_t.bounty_pool, 0) * 100)::bigint;
  v_m := GREATEST(0, COALESCE(v_t.mystery_bounty_pool_percent, 50));
  v_r := GREATEST(0, COALESCE(v_t.mystery_bounty_regular_pool_percent, 50));
  IF v_m + v_r <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pool_split_misconfigured');
  END IF;
  v_pool_cents := floor(v_bounty_cents * v_m / (v_m + v_r))::bigint;

  IF v_pool_cents > v_bounty_cents - round(COALESCE(v_t.bounty_pool_paid, 0) * 100)::bigint THEN
    v_pool_cents := GREATEST(0, v_bounty_cents - round(COALESCE(v_t.bounty_pool_paid, 0) * 100)::bigint);
  END IF;

  IF v_pool_cents <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'empty_pool');
  END IF;

  SELECT COALESCE(sum((c->>'amount_cents')::bigint), 0) INTO v_sum
    FROM jsonb_array_elements(p_chests) c;

  IF v_sum <> v_pool_cents THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'inventory_mismatch',
      'inventory_cents', v_sum, 'pool_cents', v_pool_cents);
  END IF;

  INSERT INTO public.tournament_bounty_chests (tournament_id, seq, tier, amount_cents)
  SELECT p_tournament_id,
         COALESCE((c->>'seq')::int, ord::int),
         c->>'tier',
         (c->>'amount_cents')::bigint
    FROM jsonb_array_elements(p_chests) WITH ORDINALITY AS t(c, ord)
  ON CONFLICT (tournament_id, seq) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> jsonb_array_length(p_chests) THEN
    RAISE EXCEPTION 'mystery bounty seed inserted % of % chests', v_count, jsonb_array_length(p_chests);
  END IF;

  UPDATE public.tournaments
     SET mystery_bounty_stage = 'active',
         mystery_bounty_activated_at = now(),
         mystery_bounty_activated_players = p_players_remaining,
         mystery_bounty_pool_cents = v_pool_cents
   WHERE id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'already_seeded', false,
    'pool_cents', v_pool_cents, 'chests', v_count, 'stage', 'active');
END;
$function$;
-- live: public.fn_receipt_mystery_activation
CREATE OR REPLACE FUNCTION public.fn_receipt_mystery_activation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_chest_count integer;
  v_pool_cents bigint;
  v_receipt public.tournament_mystery_activation_receipts%ROWTYPE;
BEGIN
  IF NEW.mystery_bounty_stage='active'
     AND OLD.mystery_bounty_stage IS DISTINCT FROM 'active' THEN
    SELECT count(*)::integer,COALESCE(sum(c.amount_cents),0)::bigint
      INTO v_chest_count,v_pool_cents
      FROM public.tournament_bounty_chests c WHERE c.tournament_id=NEW.id;
    IF v_chest_count<=0 OR v_pool_cents<=0
       OR v_pool_cents IS DISTINCT FROM NEW.mystery_bounty_pool_cents THEN
      RAISE EXCEPTION 'mystery activation inventory is missing or does not match its sealed pool'
        USING ERRCODE='check_violation';
    END IF;
    INSERT INTO public.tournament_mystery_activation_receipts
      (tournament_id,activation_generation,activated_at,chest_count,pool_cents)
    VALUES (NEW.id,NEW.mystery_bounty_activation_generation,
            COALESCE(NEW.mystery_bounty_activated_at,now()),v_chest_count,v_pool_cents)
    ON CONFLICT (tournament_id,activation_generation) DO NOTHING;
    SELECT * INTO v_receipt FROM public.tournament_mystery_activation_receipts
     WHERE tournament_id=NEW.id
       AND activation_generation=NEW.mystery_bounty_activation_generation;
    IF NOT FOUND OR v_receipt.chest_count<>v_chest_count
       OR v_receipt.pool_cents<>v_pool_cents THEN
      RAISE EXCEPTION 'mystery activation receipt identity conflict'
        USING ERRCODE='check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
-- live: public.fn_refuse_mystery_activation_with_pending_heads
CREATE OR REPLACE FUNCTION public.fn_refuse_mystery_activation_with_pending_heads()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.mystery_bounty_stage = 'active'
     AND OLD.mystery_bounty_stage IS DISTINCT FROM 'active' THEN
    IF public.fn_tournament_has_unsettled_bounties(NEW.id) THEN
      RAISE EXCEPTION 'tournament % has pending pre-mystery bounty obligations', NEW.id
        USING ERRCODE='check_violation';
    END IF;
    NEW.mystery_bounty_activation_generation :=
      OLD.mystery_bounty_activation_generation + 1;
  ELSIF NEW.mystery_bounty_activation_generation
            IS DISTINCT FROM OLD.mystery_bounty_activation_generation THEN
    RAISE EXCEPTION 'mystery activation generation is database-managed'
      USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$function$;
-- live: public.fn_emit_tournament_manager_wake
CREATE OR REPLACE FUNCTION public.fn_emit_tournament_manager_wake(p_tournament_id uuid, p_reason text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id bigint;
  v_status text;
BEGIN
  IF p_reason NOT IN (
    'rebuy','reentry','addon','late_registration','deal_vote','bounty_settled'
  ) THEN
    RAISE EXCEPTION 'invalid tournament manager wake reason';
  END IF;

  -- Serialize every emitter with the tournament lifecycle transition. UPDATE
  -- takes a NO KEY UPDATE lock, which conflicts with FOR SHARE: an emitter that
  -- commits first is consumed by the terminal AFTER trigger, while an emitter
  -- that arrives second observes the terminal state and cannot strand work for
  -- a manager that has already stopped. Terminal recovery can still settle a
  -- legacy financial obligation; it simply has no live manager to wake.
  SELECT upper(COALESCE(t.status,''))
    INTO v_status
    FROM public.tournaments t
   WHERE t.id=p_tournament_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE='foreign_key_violation';
  END IF;
  IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.tournament_manager_wakes AS pending(tournament_id,reason,generation)
  VALUES (p_tournament_id,p_reason,1)
  ON CONFLICT (tournament_id,reason) WHERE consumed_at IS NULL
  DO UPDATE SET
    generation=pending.generation+1,
    created_at=clock_timestamp()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;
-- live: public.fn_emit_manager_wake_for_settled_bounty
CREATE OR REPLACE FUNCTION public.fn_emit_manager_wake_for_settled_bounty()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF OLD.state IS DISTINCT FROM 'settled' AND NEW.state='settled' THEN
    PERFORM public.fn_emit_tournament_manager_wake(NEW.tournament_id,'bounty_settled');
  END IF;
  RETURN NEW;
END;
$function$;
-- live: public.fn_attach_bounty_ledger_obligation
CREATE OR REPLACE FUNCTION public.fn_attach_bounty_ledger_obligation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_context text := current_setting('app.bounty_obligation_id',true);
  v_obligation_id uuid;
  /* A REVEALED MYSTERY BOUNTY MAY NAME ITS OWN OBLIGATION (2026-09-10).
     A paid mystery chest is a bounty ledger entry like any other and its
     provenance is the mystery obligation. Only a row that says so may name
     one; a regular bounty still cannot borrow a mystery generation. */
  v_mystery_ok boolean := COALESCE(NEW.is_mystery_revealed, false);
BEGIN
  IF NEW.bounty_obligation_id IS NULL THEN
    IF COALESCE(v_context,'')
         ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_obligation_id := v_context::uuid;
      SELECT o.id INTO NEW.bounty_obligation_id
        FROM public.tournament_bounty_obligations o
       WHERE o.id=v_obligation_id AND o.tournament_id=NEW.tournament_id
         AND o.eliminated_user_id=NEW.eliminated_player_id
         AND (o.mode<>'mystery_chest' OR v_mystery_ok);
      IF NEW.bounty_obligation_id IS NULL THEN
        RAISE EXCEPTION 'bounty ledger context does not match its exact generation'
          USING ERRCODE='check_violation';
      END IF;
    ELSIF EXISTS (
      SELECT 1 FROM public.tournament_bounty_obligations o
       WHERE o.tournament_id=NEW.tournament_id
         AND o.eliminated_user_id=NEW.eliminated_player_id
         AND o.mode<>'mystery_chest' AND o.state='pending'
    ) THEN
      RAISE EXCEPTION 'generation-bound bounty ledger insert has no exact obligation context'
        USING ERRCODE='check_violation';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.tournament_bounty_obligations o
     WHERE o.id=NEW.bounty_obligation_id AND o.tournament_id=NEW.tournament_id
       AND o.eliminated_user_id=NEW.eliminated_player_id
       AND (o.mode<>'mystery_chest' OR v_mystery_ok)
  ) THEN
    RAISE EXCEPTION 'bounty ledger names a mismatched obligation generation'
      USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$function$;
-- live: public.fn_ack_bounty_obligation_from_ledger
CREATE OR REPLACE FUNCTION public.fn_ack_bounty_obligation_from_ledger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.tournament_bounty_obligations o
     SET state = 'settled', settled_at = COALESCE(settled_at, now()), last_error = NULL
   WHERE o.id=NEW.bounty_obligation_id AND o.mode <> 'mystery_chest' AND o.state='pending'
     AND public.fn_bounty_obligation_has_complete_marker(o.id);
  RETURN NEW;
END;
$function$;
-- STUBS (not production code): the seat-count projection and the wallet payer.
CREATE OR REPLACE FUNCTION public.fn_sync_seat_first_player_count(p_tournament_id uuid)
RETURNS integer LANGUAGE sql AS $$ SELECT 0 $$;
-- A stand-in for the audited payer: cumulative per (tournament, kind, user),
-- pays the increment into wallet_transactions, refuses beyond the bounty pool.
CREATE OR REPLACE FUNCTION public.fn_settle_tournament_obligation(
  p_tournament_id uuid, p_kind text, p_place integer, p_user_id uuid,
  p_amount numeric, p_source text, p_description text DEFAULT NULL::text,
  p_adjustment_id uuid DEFAULT NULL::uuid)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_prior numeric; v_inc numeric; v_room numeric;
BEGIN
  SELECT amount_paid INTO v_prior FROM public.tournament_obligations
   WHERE tournament_id=p_tournament_id AND kind=p_kind AND place IS NULL AND user_id=p_user_id;
  v_inc := round(p_amount - COALESCE(v_prior,0),2);
  SELECT t.bounty_pool - COALESCE((SELECT sum(amount) FROM public.wallet_transactions w
           WHERE w.related_entity_id=t.id AND w.category='bounty'),0)
    INTO v_room FROM public.tournaments t WHERE t.id=p_tournament_id;
  IF p_kind IN ('bounty','mystery_bounty') AND v_inc > v_room THEN
    RETURN jsonb_build_object('ok',false,'paid',0,'refused_reason','escrow_bounty_exhausted');
  END IF;
  INSERT INTO public.tournament_obligations(tournament_id,kind,place,user_id,amount_owed,amount_paid,source,settled_at)
  VALUES (p_tournament_id,p_kind,NULL,p_user_id,p_amount,p_amount,p_source,now())
  ON CONFLICT (tournament_id,kind,user_id) WHERE place IS NULL
  DO UPDATE SET amount_owed=EXCLUDED.amount_owed, amount_paid=EXCLUDED.amount_paid, updated_at=now();
  INSERT INTO public.wallet_transactions(user_id,amount,type,category,description,related_entity_id)
  VALUES (p_user_id,v_inc,'credit',CASE WHEN p_kind='mystery_bounty' THEN 'bounty' ELSE p_kind END,p_description,p_tournament_id);
  RETURN jsonb_build_object('ok',true,'paid',v_inc);
END $$;
CREATE TRIGGER trg_ack_bounty_obligation_from_ledger AFTER INSERT ON public.tournament_bounties FOR EACH ROW EXECUTE FUNCTION fn_ack_bounty_obligation_from_ledger();
CREATE TRIGGER trg_attach_bounty_ledger_obligation BEFORE INSERT ON public.tournament_bounties FOR EACH ROW EXECUTE FUNCTION fn_attach_bounty_ledger_obligation();
CREATE TRIGGER trg_emit_manager_wake_for_settled_bounty AFTER UPDATE OF state ON public.tournament_bounty_obligations FOR EACH ROW EXECUTE FUNCTION fn_emit_manager_wake_for_settled_bounty();
CREATE TRIGGER trg_receipt_mystery_activation AFTER UPDATE OF mystery_bounty_stage ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_receipt_mystery_activation();
CREATE TRIGGER trg_refuse_mystery_activation_with_pending_heads BEFORE UPDATE OF mystery_bounty_stage, mystery_bounty_activation_generation ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_refuse_mystery_activation_with_pending_heads();
