-- Exact captured installed dependencies for the local native baseline only.
BEGIN;
SET LOCAL check_function_bodies=off;
CREATE OR REPLACE FUNCTION public.fn_ca_close_tournament_seat_exit_authority(p_token uuid, p_require_consumed boolean DEFAULT true)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_remaining integer;
BEGIN
  SELECT count(*) INTO v_remaining
    FROM public.tournament_seat_exit_authorizations a
   WHERE a.token=p_token;
  DELETE FROM public.tournament_seat_exit_authorizations a
   WHERE a.token=p_token;
  PERFORM set_config('app.tournament_seat_exit_token','',true);
  PERFORM set_config('app.tournament_seat_exit_operation','',true);
  -- 2026-09-11 (20260911081910): only zy_tournament_live_seat_exit_requires_authority
  -- on table_seats consumes a row. Without it nothing can, and requiring
  -- consumption only refuses the exit it was opened for: every finish
  -- from 05:05 UTC. The requirement returns when the consumer exists.
  IF COALESCE(p_require_consumed,true) AND v_remaining<>0
     AND EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger t
        WHERE t.tgrelid='public.table_seats'::regclass
          AND t.tgname='zy_tournament_live_seat_exit_requires_authority'
          AND NOT t.tgisinternal
          AND t.tgenabled IN ('O','A')) THEN
    RAISE EXCEPTION
      'tournament seat-exit authority left % live seat(s) unconsumed',v_remaining
      USING ERRCODE='P0404';
  END IF;
  RETURN v_remaining;
END;
$function$
;
ALTER FUNCTION public.fn_ca_close_tournament_seat_exit_authority(uuid,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_close_tournament_seat_exit_authority(uuid,boolean) FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_ca_close_tournament_seat_exit_authority(uuid,boolean) TO postgres;
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
  v_unwitnessed_busts integer;
  v_misplaced_busts integer;
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

    /* A BUST IS RANKED BY WHEN IT HAPPENED (2026-09-11). Places were
       numbered in elimination_sequence order, which a trigger stamps when
       the knockout door RECORDS a bust, so a bust the door recorded hours
       late was paid a place it did not finish in. Each eliminated row is now
       ranked by when its bust happened, derived in the statement that uses
       it from what the door proved: the commit time of the accepted hand of
       the player's latest 'eliminated' knockout generation, plus one
       microsecond per earlier rank in that hand (smaller hand-start stack
       first, then user id - the rule the door stamps eliminated_at with).
       Busts in different hands are ordered by those hands' commit times.
       The hand-history prune deletes a horse-only hand's commit row after
       its retention window, and only a PENDING generation protects it; the
       generation rows themselves are never pruned, so a hand whose commit
       is gone is timed by when its first generation was captured (the
       earliest created_at of that hand's generations, written before the
       commit) - one time for the whole hand, so the same-hand stack rank
       still decides within it - never by when a bust was recorded. A row
       with no such witness keeps its eliminated_at; a row with neither is
       refused, never guessed. Equal times fall back to
       elimination_sequence, then id. elimination_sequence alone still names
       the last elimination, and so the winner, above. The same order decides
       whether anything moves, so a ladder already in true order is left
       exactly as it is. */
    WITH busts AS (
      SELECT tp.id, tp.position, tp.elimination_sequence,
             COALESCE((
               SELECT COALESCE(a.committed_at,
                               (SELECT min(g.created_at)
                                  FROM public.tournament_knockout_candidates g
                                 WHERE g.tournament_id = c.tournament_id
                                   AND g.table_id = c.table_id
                                   AND g.hand_number = c.hand_number
                                   AND g.hand_id = c.hand_id))
                      + (SELECT count(*)
                           FROM public.tournament_knockout_candidates s
                          WHERE s.tournament_id = c.tournament_id
                            AND s.table_id = c.table_id
                            AND s.hand_number = c.hand_number
                            AND s.hand_id = c.hand_id
                            AND (s.stack_before, s.eliminated_user_id)
                                < (c.stack_before, c.eliminated_user_id))::integer
                        * interval '1 microsecond'
                 FROM (SELECT k.tournament_id, k.table_id, k.hand_number,
                              k.hand_id, k.stack_before, k.eliminated_user_id
                         FROM public.tournament_knockout_candidates k
                        WHERE k.tournament_id = tp.tournament_id
                          AND k.eliminated_user_id = tp.user_id
                          AND k.state = 'eliminated'
                        ORDER BY k.hand_number DESC, k.id DESC
                        LIMIT 1) c
                 LEFT JOIN public.hand_atomic_commits a
                   ON a.table_id = c.table_id
                  AND a.hand_number = c.hand_number
                  AND a.hand_id = c.hand_id
             ), tp.eliminated_at) AS bust_at
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status::text = 'eliminated'
    ),
    ranked AS (
      SELECT b.id, b.position, b.bust_at,
             row_number() OVER (
               ORDER BY b.bust_at DESC, b.elimination_sequence DESC, b.id ASC
             )::integer + 1 AS expected_position
        FROM busts b
    )
    SELECT count(*) FILTER (WHERE ranked.bust_at IS NULL),
           count(*) FILTER (WHERE ranked.position IS DISTINCT FROM ranked.expected_position)
      INTO v_unwitnessed_busts, v_misplaced_busts
      FROM ranked;
    IF v_unwitnessed_busts > 0 THEN
      RAISE EXCEPTION
        'tournament % has % eliminated player(s) with no bust witness and no eliminated_at',
        p_tournament_id, v_unwitnessed_busts USING ERRCODE = 'P0404';
    END IF;

    IF v_misplaced_busts > 0 THEN
      IF EXISTS (
        SELECT 1 FROM public.tournament_payouts p
         WHERE p.tournament_id = p_tournament_id
           AND p."position" IS NOT NULL
      ) OR EXISTS (
        SELECT 1 FROM public.tournament_obligations o
         WHERE o.tournament_id = p_tournament_id
           AND o.kind = 'place'
      ) THEN
        /* Paid places are never relabelled. A COMPLETING event whose
           places are exactly the recording-order ladder was settled by the
           rule this replaces, and is replayed as it was paid, not refused. */
        IF v_status <> 'COMPLETING' OR EXISTS (
          SELECT 1
            FROM (
              SELECT tp.position,
                     row_number() OVER (
                       ORDER BY tp.elimination_sequence DESC, tp.id ASC
                     )::integer + 1 AS expected_position
                FROM public.tournament_players tp
               WHERE tp.tournament_id = p_tournament_id
                 AND tp.status::text = 'eliminated'
            ) recorded
           WHERE recorded.position IS DISTINCT FROM recorded.expected_position
        ) THEN
          RAISE EXCEPTION
            'tournament % needs a late-entry position normalization but already carries settled place evidence',
            p_tournament_id USING ERRCODE = 'P0404';
        END IF;
      ELSE
        UPDATE public.tournament_players tp
           SET position = NULL
         WHERE tp.tournament_id = p_tournament_id
           AND tp.status::text = 'eliminated';

        WITH busts AS (
        SELECT tp.id, tp.position, tp.elimination_sequence,
               COALESCE((
                 SELECT COALESCE(a.committed_at,
                                 (SELECT min(g.created_at)
                                    FROM public.tournament_knockout_candidates g
                                   WHERE g.tournament_id = c.tournament_id
                                     AND g.table_id = c.table_id
                                     AND g.hand_number = c.hand_number
                                     AND g.hand_id = c.hand_id))
                        + (SELECT count(*)
                             FROM public.tournament_knockout_candidates s
                            WHERE s.tournament_id = c.tournament_id
                              AND s.table_id = c.table_id
                              AND s.hand_number = c.hand_number
                              AND s.hand_id = c.hand_id
                              AND (s.stack_before, s.eliminated_user_id)
                                  < (c.stack_before, c.eliminated_user_id))::integer
                          * interval '1 microsecond'
                   FROM (SELECT k.tournament_id, k.table_id, k.hand_number,
                                k.hand_id, k.stack_before, k.eliminated_user_id
                           FROM public.tournament_knockout_candidates k
                          WHERE k.tournament_id = tp.tournament_id
                            AND k.eliminated_user_id = tp.user_id
                            AND k.state = 'eliminated'
                          ORDER BY k.hand_number DESC, k.id DESC
                          LIMIT 1) c
                   LEFT JOIN public.hand_atomic_commits a
                     ON a.table_id = c.table_id
                    AND a.hand_number = c.hand_number
                    AND a.hand_id = c.hand_id
               ), tp.eliminated_at) AS bust_at
          FROM public.tournament_players tp
         WHERE tp.tournament_id = p_tournament_id
           AND tp.status::text = 'eliminated'
        ),
        ranked AS (
          SELECT b.id,
                 row_number() OVER (
                   ORDER BY b.bust_at DESC, b.elimination_sequence DESC, b.id ASC
                 )::integer + 1 AS expected_position
            FROM busts b
        )
        UPDATE public.tournament_players tp
           SET position = ranked.expected_position
          FROM ranked
         WHERE tp.id = ranked.id;
      END IF;
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
$function$
;
ALTER FUNCTION public.fn_settle_tournament_places(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_places(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_places(uuid,uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_places(uuid,uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_complete_tournament_terminal(p_tournament_id uuid, p_observed_winner_id uuid, p_settlement_mode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '45s'
AS $function$
DECLARE
  v_token uuid;
  v_result jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'terminal settlement requires service authority'
      USING ERRCODE='28000';
  END IF;
  PERFORM public.fn_ca_lock_settlement_lane_for_finish(p_tournament_id);
  v_token:=public.fn_ca_open_tournament_seat_exit_authority(
    p_tournament_id,'terminal_finish',NULL);
  BEGIN
    v_result:=public.fn_complete_tournament_terminal_pre_seat_guard(
      p_tournament_id,p_observed_winner_id,p_settlement_mode);
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(
      v_token,COALESCE((v_result->>'ok')::boolean,false));
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
    RAISE;
  END;
  RETURN v_result;
END;
$function$
;
ALTER FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_ca_open_tournament_seat_exit_authority(p_tournament_id uuid, p_operation text, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_token uuid:=gen_random_uuid();
BEGIN
  IF p_tournament_id IS NULL
     OR p_operation NOT IN (
       'unregister','cancel','satellite_finish','terminal_finish','move',
       'elimination') THEN
    RAISE EXCEPTION 'invalid tournament seat-exit authority scope'
      USING ERRCODE='22023';
  END IF;

  -- This tournament's lane (2026-09-10): G shared, T(id) exclusive. Every
  -- row below belongs to this one tournament. Re-entered free by a rolling
  -- caller; granted at once under a terminal caller (G and B exclusive).
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  PERFORM 1 FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist',p_tournament_id
      USING ERRCODE='P0002';
  END IF;

  -- Deterministic seat order matches hand settlement and terminal close.
  PERFORM s.id
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.left_at IS NULL
     AND (p_user_id IS NULL OR s.user_id=p_user_id)
   ORDER BY s.id
   FOR UPDATE OF s;

  INSERT INTO public.tournament_seat_exit_authorizations(
    token,seat_id,tournament_id,user_id,operation)
  SELECT v_token,s.id,p_tournament_id,s.user_id,p_operation
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.left_at IS NULL
     AND s.user_id IS NOT NULL
     AND (p_user_id IS NULL OR s.user_id=p_user_id)
   ORDER BY s.id;

  PERFORM set_config('app.tournament_seat_exit_token',v_token::text,true);
  PERFORM set_config('app.tournament_seat_exit_operation',p_operation,true);
  RETURN v_token;
END;
$function$
;
ALTER FUNCTION public.fn_ca_open_tournament_seat_exit_authority(uuid,text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_open_tournament_seat_exit_authority(uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_ca_open_tournament_seat_exit_authority(uuid,text,uuid) TO postgres;
CREATE OR REPLACE FUNCTION public.fn_complete_tournament_entry_reprice(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_receipt public.tournament_entry_close_receipts%ROWTYPE;
  v_mismatch integer;
BEGIN
  -- Match the lock order used by close/finalize and the satellite entitlement
  -- workflow: tournament first, then its child receipt. Taking these in the
  -- opposite order lets a close replay (tournament -> receipt) deadlock a
  -- completion attempt (receipt -> tournament) exactly when recovery is trying
  -- to prove the durable obligation complete.
  SELECT * INTO v_t
    FROM public.tournaments t
   WHERE t.id=p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','not_found'); END IF;

  SELECT * INTO v_receipt
    FROM public.tournament_entry_close_receipts r
   WHERE r.tournament_id=p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','receipt_missing'); END IF;
  IF v_receipt.reprice_completed_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok',true,'already_completed',true,'mismatches',0);
  END IF;
  IF COALESCE(v_t.prize_pool_finalized,false) IS NOT TRUE
     OR round(COALESCE(v_t.prize_pool,0),2)<>round(v_receipt.final_prize_pool,2)
     OR public.fn_safe_jsonb_array(v_t.payout_structure::text)
        IS DISTINCT FROM v_receipt.payout_structure_snapshot THEN
    RETURN jsonb_build_object('ok',false,'reason','final_pool_or_structure_drifted');
  END IF;

  IF lower(COALESCE(v_t.variant,''))='satellite'
     OR upper(COALESCE(v_t.tournament_type,''))='SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    -- Satellite closeout remains under its existing seat-award contract.
    SELECT count(*)::integer INTO v_mismatch
      FROM public.tournament_players tp
      CROSS JOIN LATERAL (
        SELECT public.fn_tournament_place_prize_exact(
          v_receipt.final_prize_pool,
          v_receipt.payout_structure_snapshot::text,
          tp.position,
          public.fn_ca_tournament_unit_cents(p_tournament_id)) AS expected
      ) entitlement
     WHERE tp.tournament_id=p_tournament_id
       AND tp.status='eliminated'
       AND (
         -- An eliminated row without its finishing place is unfinished causal
         -- work, not a zero-dollar entitlement. Letting it disappear from this
         -- proof would retire the close receipt before any later process can
         -- know which place must be repriced.
         tp.position IS NULL
         OR round(COALESCE(tp.prize,0),2) IS DISTINCT FROM round(entitlement.expected,2)
         OR (
           entitlement.expected>0
           AND (
             SELECT round(COALESCE(sum(p.amount),0),2)
               FROM public.tournament_payouts p
              WHERE p.tournament_id=p_tournament_id
                AND p.user_id=tp.user_id
                AND p.position=tp.position
                AND COALESCE(p.source,'')<>'satellite_seat'
           ) IS DISTINCT FROM round(entitlement.expected,2)
         )
       );
  ELSE
    -- Entry closure proves the cached result facts, not payment. Cash places
    -- are paid only by the terminal authority, so requiring a payout here
    -- leaves every positive unpaid finisher pending forever. Derive once with
    -- that same authority, including its final-field trim and Bubble reserve.
    WITH amounts AS MATERIALIZED (
      SELECT place,amount
        FROM public.fn_ca_tournament_place_amounts(p_tournament_id)
    )
    SELECT count(*)::integer INTO v_mismatch
      FROM public.tournament_players tp
      LEFT JOIN amounts a ON a.place=tp.position
     WHERE tp.tournament_id=p_tournament_id
       AND tp.status='eliminated'
       AND (tp.position IS NULL
            OR tp.prize IS DISTINCT FROM COALESCE(a.amount,0));
  END IF;
  IF v_mismatch>0 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','reprice_incomplete','mismatches',v_mismatch);
  END IF;

  UPDATE public.tournament_entry_close_receipts
     SET reprice_completed_at=clock_timestamp(),updated_at=clock_timestamp()
   WHERE tournament_id=p_tournament_id;
  RETURN jsonb_build_object('ok',true,'completed',true,'mismatches',0);
END;
$function$
;
ALTER FUNCTION public.fn_complete_tournament_entry_reprice(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_complete_tournament_entry_reprice(uuid) FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_entry_reprice(uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_entry_reprice(uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_non_satellite_completed_requires_terminal_receipt()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF upper(COALESCE(NEW.status::text,'')) <> 'COMPLETED' THEN
    RETURN NEW;
  END IF;
  IF lower(COALESCE(NEW.variant::text,'')) = 'satellite'
     OR upper(COALESCE(NEW.tournament_type::text,'')) = 'SATELLITE'
     OR NEW.satellite_target_id IS NOT NULL
     OR NEW.satellite_target IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tournament_terminal_settlements h
     WHERE h.tournament_id = NEW.id
  ) THEN
    RAISE EXCEPTION
      'non-satellite tournament % cannot become COMPLETED without its atomic terminal receipt',
      NEW.id USING ERRCODE = '55000';
  END IF;
  PERFORM public.fn_ca_tournament_terminal_receipt(NEW.id,NULL);
  RETURN NEW;
END;
$function$
;
ALTER FUNCTION public.fn_non_satellite_completed_requires_terminal_receipt() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_non_satellite_completed_requires_terminal_receipt() FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_non_satellite_completed_requires_terminal_receipt() TO postgres;
CREATE OR REPLACE FUNCTION public.fn_stamp_tournament_terminal_evidence_markers()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_terminal_at timestamptz;
BEGIN
  IF upper(COALESCE(NEW.status::text,'')) NOT IN
       ('COMPLETED','CANCELLED','CANCELED')
     OR (TG_OP = 'UPDATE' AND upper(COALESCE(OLD.status::text,'')) IN
       ('COMPLETED','CANCELLED','CANCELED')) THEN
    RETURN NEW;
  END IF;
  v_terminal_at := NEW.ended_at;
  IF v_terminal_at IS NULL OR NOT isfinite(v_terminal_at) THEN
    RAISE EXCEPTION 'terminal tournament % requires one finite close marker',NEW.id
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.tournament_players
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_obligations
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_payouts
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_rake_settlements
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.rake_records
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_bounty_chests
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_bounty_awards
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_guarantee_overlays
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.table_seats s
     SET terminal_closed_at = v_terminal_at
    FROM public.tables tb
   WHERE tb.id = s.table_id AND tb.tournament_id = NEW.id
     AND s.terminal_closed_at IS NULL;
  UPDATE public.wallet_transactions
     SET terminal_closed_at = v_terminal_at
   WHERE related_entity_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_bounty_award_recipients r
     SET terminal_closed_at = v_terminal_at
    FROM public.tournament_bounty_awards a
   WHERE a.id = r.award_id AND a.tournament_id = NEW.id
     AND r.terminal_closed_at IS NULL;
  UPDATE public.tournament_escrow
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  -- Contribution and jackpot-draw rows already have an unconditional
  -- append-only guard. Cancellation reversal/surplus rows intentionally do
  -- not, so give precisely those mutable Spin rows the terminal tuple marker.
  UPDATE public.spin_reserve_ledger
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id
     AND kind NOT IN ('contribution','jackpot_draw')
     AND terminal_closed_at IS NULL;

  IF EXISTS (SELECT 1 FROM public.tournament_players x
              WHERE x.tournament_id=NEW.id
                AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_payouts x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_rake_settlements x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.rake_records x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_guarantee_overlays x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (
       SELECT 1 FROM public.table_seats s
       JOIN public.tables tb ON tb.id=s.table_id
        WHERE tb.tournament_id=NEW.id
          AND s.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.wallet_transactions x
                 WHERE x.related_entity_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (
       SELECT 1 FROM public.tournament_bounty_award_recipients r
       JOIN public.tournament_bounty_awards a ON a.id=r.award_id
        WHERE a.tournament_id=NEW.id
          AND r.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_escrow x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.spin_reserve_ledger x
                 WHERE x.tournament_id=NEW.id
                   AND x.kind NOT IN ('contribution','jackpot_draw')
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at) THEN
    RAISE EXCEPTION 'terminal tournament % did not stamp every mutable evidence row',
      NEW.id USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$function$
;
ALTER FUNCTION public.fn_stamp_tournament_terminal_evidence_markers() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_stamp_tournament_terminal_evidence_markers() FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_stamp_tournament_terminal_evidence_markers() TO postgres;
CREATE OR REPLACE FUNCTION public.fn_guard_tournament_prize_math_contract()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_unit integer;
BEGIN
  IF TG_OP='UPDATE' THEN
    -- Legacy club routing remains governed by its existing contract guards.
    -- This trigger freezes denomination only for an explicitly versioned ladder.
    IF OLD.payout_math_version=1 AND NEW.payout_math_version=1
       AND OLD.payout_unit_cents=1 AND NEW.payout_unit_cents=1 THEN RETURN NEW; END IF;
    IF ROW(NEW.payout_math_version,NEW.payout_unit_cents,NEW.club_id) IS NOT DISTINCT FROM
       ROW(OLD.payout_math_version,OLD.payout_unit_cents,OLD.club_id) THEN RETURN NEW; END IF;
    IF COALESCE(OLD.entry_contract_locked,false) OR COALESCE(OLD.prize_pool_finalized,false)
       OR OLD.started_at IS NOT NULL
       OR upper(COALESCE(OLD.status,'')) NOT IN('ANNOUNCED','REGISTERING','SCHEDULED')
       OR upper(COALESCE(NEW.status,'')) NOT IN('ANNOUNCED','REGISTERING','SCHEDULED')
       OR EXISTS(SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id=OLD.id)
       OR EXISTS(SELECT 1 FROM public.tournament_payouts tp WHERE tp.tournament_id=OLD.id)
       OR EXISTS(SELECT 1 FROM public.tournament_launch_receipts lr WHERE lr.tournament_id=OLD.id) THEN
      RAISE EXCEPTION 'Tournament prize arithmetic is frozen after entry or launch'
        USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.payout_math_version=2 THEN
    SELECT CASE WHEN c.asset='diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL
                THEN 100 ELSE 1 END INTO v_unit FROM public.clubs c WHERE c.id=NEW.club_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Prize contract requires an existing club' USING ERRCODE='23503'; END IF;
    -- The club determines denomination; a caller cannot request fractional Diamonds.
    NEW.payout_unit_cents:=v_unit;
  ELSE
    NEW.payout_unit_cents:=1;
  END IF;
  RETURN NEW;
END;
$function$
;
ALTER FUNCTION public.fn_guard_tournament_prize_math_contract() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_guard_tournament_prize_math_contract() FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_guard_tournament_prize_math_contract() TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_guard_tournament_prize_math_contract() TO service_role;
CREATE OR REPLACE FUNCTION public.fn_retire_manager_wakes_after_terminal_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF upper(COALESCE(NEW.status,'')) IN ('COMPLETED','CANCELLED','CANCELED')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE public.tournament_manager_wakes
       SET consumed_at=COALESCE(consumed_at,clock_timestamp())
     WHERE tournament_id=NEW.id AND consumed_at IS NULL;
  END IF;
  RETURN NEW;
END;
$function$
;
ALTER FUNCTION public.fn_retire_manager_wakes_after_terminal_status() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_retire_manager_wakes_after_terminal_status() FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_retire_manager_wakes_after_terminal_status() TO postgres;
CREATE OR REPLACE FUNCTION public.trg_freeze_finalized_tournament_prize_pool()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_delta numeric;
  v_candidate_count integer := 0;
BEGIN
  IF COALESCE(OLD.prize_pool_finalized, false)
     AND NOT COALESCE(NEW.prize_pool_finalized, false) THEN
    RAISE EXCEPTION
      'finalized tournament % prize pool cannot be reopened', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF COALESCE(OLD.prize_pool_finalized, false)
     AND (NEW.payout_structure IS DISTINCT FROM OLD.payout_structure
          OR NEW.spin_multiplier IS DISTINCT FROM OLD.spin_multiplier) THEN
    RAISE EXCEPTION
      'finalized tournament % payout structure and Spin draw cannot change', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF COALESCE(OLD.prize_pool_finalized, false)
     AND round(COALESCE(NEW.guaranteed_prize, 0), 2)
         IS DISTINCT FROM round(COALESCE(OLD.guaranteed_prize, 0), 2) THEN
    RAISE EXCEPTION 'finalized tournament % guarantee cannot change', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF COALESCE(OLD.prize_pool_finalized, false)
     AND round(COALESCE(NEW.prize_pool, 0), 2)
         IS DISTINCT FROM round(COALESCE(OLD.prize_pool, 0), 2) THEN
    v_delta := round(COALESCE(OLD.prize_pool, 0) - COALESCE(NEW.prize_pool, 0), 2);

    IF v_delta > 0
       AND COALESCE(NEW.prize_pool, 0) >= 0
       AND COALESCE(NEW.prize_pool_finalized, false)
       AND OLD.status = 'COMPLETING'
       AND OLD.satellite_target_id IS NOT NULL
       AND current_setting('app.atomic_satellite_settlement', true) = OLD.id::text
       /* No second column may hitchhike on the narrowly admitted debit. */
       AND (to_jsonb(NEW) - 'prize_pool') = (to_jsonb(OLD) - 'prize_pool') THEN
      SELECT count(*)::integer
        INTO v_candidate_count
        FROM public.tournament_satellite_settlement_batches b
        JOIN public.tournament_satellite_entitlements e
          ON e.tournament_id = b.tournament_id
         AND e.target_tournament_id = b.target_tournament_id
         AND e.target_tournament_id = OLD.satellite_target_id
         AND round(e.ticket_value, 2) = v_delta
        JOIN public.tournament_players source_player
          ON source_player.tournament_id = OLD.id
         AND source_player.position = e.position
         AND source_player.status IN ('winner', 'eliminated')
        JOIN public.tournament_players target_player
          ON target_player.tournament_id = e.target_tournament_id
         AND target_player.user_id = source_player.user_id
         AND COALESCE(target_player.is_satellite_qualifier, false)
         AND target_player.source_satellite_id = OLD.id
        JOIN public.tournaments target
          ON target.id = e.target_tournament_id
       WHERE b.tournament_id = OLD.id
         AND b.settled_at IS NULL
         AND round(
               GREATEST(COALESCE(target.buy_in_amount, 0), 0)
               + GREATEST(COALESCE(target.buy_in_fee, 0), 0),
               2
             ) = v_delta
         AND (
           SELECT count(*)::integer
             FROM public.rake_records target_rake
            WHERE target_rake.tournament_id = target.id
              AND target_rake.source = 'fn_award_satellite_seat'
              AND target_rake.metadata->>'satellite_id' = OLD.id::text
              AND target_rake.metadata->>'user_id' = source_player.user_id::text
              AND target_rake.metadata->>'registration_id' = target_player.id::text
         ) = CASE WHEN COALESCE(target.buy_in_fee, 0) > 0 THEN 1 ELSE 0 END
         AND (
           SELECT count(*)::integer
             FROM public.rake_records exact_target_rake
            WHERE exact_target_rake.tournament_id = target.id
              AND exact_target_rake.source = 'fn_award_satellite_seat'
              AND exact_target_rake.metadata->>'satellite_id' = OLD.id::text
              AND exact_target_rake.metadata->>'user_id' = source_player.user_id::text
              AND exact_target_rake.metadata->>'registration_id' = target_player.id::text
              AND round(exact_target_rake.rake_amount, 2)
                  = round(COALESCE(target.buy_in_fee, 0), 2)
              AND round(COALESCE(exact_target_rake.pot_size, 0), 2) = v_delta
         ) = CASE WHEN COALESCE(target.buy_in_fee, 0) > 0 THEN 1 ELSE 0 END
         /* At this exact instruction the target seat exists, but the source
            payout and transfer journal do not. A replay or second debit has
            either one and therefore cannot match this predicate. */
         AND NOT EXISTS (
           SELECT 1
             FROM public.tournament_payouts payout
            WHERE payout.tournament_id = OLD.id
              AND payout.user_id = source_player.user_id
              AND payout.position = e.position
              AND payout.source = 'satellite_seat'
         )
         AND NOT EXISTS (
           SELECT 1
             FROM public.chip_ledger ledger
            WHERE ledger.idempotency_key =
              'tourney:' || OLD.id::text || ':seat:'
              || source_player.user_id::text || ':pool_transfer'
         );
    END IF;

    IF v_candidate_count = 1 THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'finalized tournament % prize pool cannot change from % to %',
      NEW.id, OLD.prize_pool, NEW.prize_pool USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$
;
ALTER FUNCTION public.trg_freeze_finalized_tournament_prize_pool() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.trg_freeze_finalized_tournament_prize_pool() FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.trg_freeze_finalized_tournament_prize_pool() TO postgres;
CREATE OR REPLACE FUNCTION public.trg_tournament_pool_finalization_window_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_late_level_cap integer := COALESCE(NULLIF(NEW.late_reg_levels, 0),
                                       NULLIF(NEW.rebuy_levels, 0), 0);
  v_rebuy_level_cap integer := COALESCE(NULLIF(NEW.rebuy_levels, 0),
                                        NULLIF(NEW.late_reg_levels, 0), 0);
  v_current_level integer := COALESCE(NEW.current_level, 0);
  /* An unexpired future window is just as binding as one whose start clock has
     arrived. Finalizing it early would publish an add-on promise that the
     finalized-pool trigger later has to refuse. */
  v_addon_open boolean := COALESCE(NEW.add_on_available, false)
                          AND NEW.addon_period_ends_at IS NOT NULL
                          AND clock_timestamp() < NEW.addon_period_ends_at;
BEGIN
  IF COALESCE(OLD.prize_pool_finalized, false)
     AND NOT COALESCE(NEW.prize_pool_finalized, false) THEN
    RAISE EXCEPTION
      'finalized tournament % prize pool cannot be reopened', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT COALESCE(NEW.prize_pool_finalized, false)
     OR COALESCE(OLD.prize_pool_finalized, false) THEN
    RETURN NEW;
  END IF;

  IF NEW.status IN ('ANNOUNCED', 'REGISTERING')
     AND (v_late_level_cap > 0 OR COALESCE(NEW.late_reg_mins, 0) > 0
          OR COALESCE(NEW.is_rebuy, false) OR COALESCE(NEW.is_reentry, false)
          OR COALESCE(NEW.add_on_available, false)) THEN
    RAISE EXCEPTION
      'tournament % cannot finalize its prize pool before its post-start entry windows open', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'RUNNING' THEN
    IF v_late_level_cap > 0 AND v_current_level < v_late_level_cap THEN
      RAISE EXCEPTION
        'tournament % cannot finalize its prize pool before late registration level % closes',
        NEW.id, v_late_level_cap USING ERRCODE = 'check_violation';
    END IF;
    IF v_late_level_cap <= 0 AND COALESCE(NEW.late_reg_mins, 0) > 0
       AND (NEW.started_at IS NULL OR clock_timestamp()
            < NEW.started_at + make_interval(mins => NEW.late_reg_mins)) THEN
      RAISE EXCEPTION
        'tournament % cannot finalize its prize pool while timed late registration is open', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF (COALESCE(NEW.is_rebuy, false) OR COALESCE(NEW.is_reentry, false))
       AND v_rebuy_level_cap <= 0 AND COALESCE(NEW.late_reg_mins, 0) <= 0 THEN
      RAISE EXCEPTION
        'tournament % cannot finalize its prize pool while an uncapped rebuy or re-entry offer is open', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF (COALESCE(NEW.is_rebuy, false) OR COALESCE(NEW.is_reentry, false))
       AND v_rebuy_level_cap > 0 AND v_current_level < v_rebuy_level_cap THEN
      RAISE EXCEPTION
        'tournament % cannot finalize its prize pool before rebuy level % closes',
        NEW.id, v_rebuy_level_cap USING ERRCODE = 'check_violation';
    END IF;
    IF v_addon_open THEN
      RAISE EXCEPTION
        'tournament % cannot finalize its prize pool before its promised add-on window closes', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF COALESCE(NEW.add_on_available, false)
       AND (NEW.addon_period_started_at IS NULL OR NEW.addon_period_ends_at IS NULL) THEN
      RAISE EXCEPTION
        'tournament % cannot finalize its prize pool before its add-on window is durably bounded', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$
;
ALTER FUNCTION public.trg_tournament_pool_finalization_window_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.trg_tournament_pool_finalization_window_guard() FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.trg_tournament_pool_finalization_window_guard() TO postgres;
GRANT EXECUTE ON FUNCTION public.trg_tournament_pool_finalization_window_guard() TO service_role;
CREATE OR REPLACE FUNCTION public.trg_lock_atomic_final_table_deal_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_settled_at timestamptz;
  v_has_batch boolean := false;
BEGIN
  SELECT b.settled_at INTO v_settled_at
    FROM public.tournament_final_table_deal_batches b
   WHERE b.tournament_id = OLD.id;
  v_has_batch := FOUND;

  IF v_has_batch AND EXISTS (
    SELECT 1 FROM public.tournament_final_table_deal_batches b
     WHERE b.tournament_id=OLD.id AND b.contract_version=2
  ) THEN
    IF v_settled_at IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.tournament_finish_receipts f
      JOIN public.tournament_final_table_deal_batches b ON b.tournament_id=f.tournament_id
      WHERE f.tournament_id=OLD.id AND f.finish_kind='final_table_deal'
        AND f.winner_user_id=b.chip_leader
    ) THEN
      RAISE EXCEPTION 'canonical final deal status requires its real settled claim'
        USING ERRCODE='check_violation';
    END IF;
    IF OLD.status='RUNNING' AND NEW.status='COMPLETING'
      AND current_setting('app.tournament_finish_claim',true)=OLD.id::text THEN
      PERFORM public.fn_ca_verify_terminal_final_deal_batch(OLD.id,false);
      RETURN NEW;
    ELSIF OLD.status='COMPLETING' AND NEW.status='COMPLETED' THEN
      PERFORM public.fn_ca_verify_terminal_final_deal_batch(OLD.id,true);
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'canonical final deal status transition has no verified owner'
      USING ERRCODE='check_violation';
  END IF;

  IF v_has_batch
     AND (v_settled_at IS NULL
          OR OLD.status IS DISTINCT FROM 'COMPLETING'
          OR NEW.status IS DISTINCT FROM 'COMPLETED'
          OR current_setting('app.atomic_final_table_deal_batch', true)
               IS DISTINCT FROM OLD.id::text) THEN
    RAISE EXCEPTION
      'tournament % has an atomic final-table-deal batch; only its owning transaction may advance COMPLETING to COMPLETED after full settlement',
      OLD.id USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$
;
ALTER FUNCTION public.trg_lock_atomic_final_table_deal_status() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.trg_lock_atomic_final_table_deal_status() FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.trg_lock_atomic_final_table_deal_status() TO postgres;
GRANT EXECUTE ON FUNCTION public.trg_lock_atomic_final_table_deal_status() TO service_role;
CREATE OR REPLACE FUNCTION public.trg_atomic_final_table_deal_completion_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_check jsonb;
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.tournament_final_table_deal_batches b
        WHERE b.tournament_id = NEW.id
     ) AND NOT EXISTS (
       SELECT 1 FROM public.tournament_obligations o
        WHERE o.tournament_id = NEW.id AND o.kind = 'final_table_deal'
     ) AND NOT EXISTS (
       SELECT 1 FROM public.tournament_payouts p
        WHERE p.tournament_id = NEW.id AND p.source = 'final_table_deal'
     ) THEN
    RETURN NEW;
  END IF;

  IF EXISTS(SELECT 1 FROM public.tournament_final_table_deal_batches b
    WHERE b.tournament_id=NEW.id AND b.contract_version=2) THEN
    v_check:=public.fn_ca_verify_terminal_final_deal_batch(NEW.id,true);
  ELSE
    v_check := public.fn_check_atomic_final_table_deal(NEW.id);
  END IF;
  IF NOT COALESCE((v_check->>'ok')::boolean, false) THEN
    RAISE EXCEPTION
      'final-table-deal tournament % cannot complete: %', NEW.id, v_check::text
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$
;
ALTER FUNCTION public.trg_atomic_final_table_deal_completion_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.trg_atomic_final_table_deal_completion_guard() FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.trg_atomic_final_table_deal_completion_guard() TO postgres;
GRANT EXECUTE ON FUNCTION public.trg_atomic_final_table_deal_completion_guard() TO service_role;
CREATE OR REPLACE FUNCTION smarter_private.f06_source_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE src uuid;dst uuid;u uuid;t uuid;oldj jsonb;newj jsonb;bound boolean;moving boolean;
BEGIN
 oldj:=CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
 newj:=CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) ELSE '{}'::jsonb END;
 src:=(oldj->>'table_id')::uuid;dst:=(newj->>'table_id')::uuid;u:=COALESCE((newj->>'user_id')::uuid,(oldj->>'user_id')::uuid);
 SELECT tournament_id INTO t FROM public.tables WHERE id=COALESCE(src,dst);
 IF t IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
 -- Payload-only writes preserve source custody. They need to exclude a
 -- canonical move/begin, not other accepted hands in this tournament. The
 -- outer hand RPC already holds T shared; promoting it to exclusive here
 -- makes ordinary concurrent hands refuse each other even with no F06 move.
 IF TG_OP='UPDATE' AND (
  (TG_TABLE_NAME='table_seats'
   AND (oldj->>'left_at') IS NOT DISTINCT FROM (newj->>'left_at')
   AND (src,oldj->>'user_id',oldj->>'seat_number') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number'))
  OR (TG_TABLE_NAME='tournament_players'
   AND (src,oldj->>'user_id',oldj->>'seat_number',oldj->>'status') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number',newj->>'status'))
 ) THEN
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0))
   OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:'||t::text,0)) THEN
   RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
 END IF;
 -- Canonical admission authorities already hold T exclusive. A direct row
 -- writer may try it, but cannot wait while holding a row needed by begin.
 -- Closing the exact already-zero generation cannot move funded custody.
 -- Share G/T with other tables' hands, while still excluding every canonical
 -- begin/move/terminal authority, which owns T or G exclusively. Do not
 -- return here: PARK_REQUESTED still needs the original hand receipt and
 -- BEGUN still needs the original move receipt below.
 IF TG_OP='UPDATE' AND TG_TABLE_NAME='table_seats'
  AND oldj->>'left_at' IS NULL AND newj->>'left_at' IS NOT NULL
  AND newj->>'status'='left'
  AND oldj->'stack'='0'::jsonb AND newj->'stack'='0'::jsonb
  AND oldj->>'user_id' IS NOT NULL
  AND (src,oldj->>'id',oldj->>'user_id',oldj->>'seat_number',oldj->>'joined_at',oldj->>'club_id')
      IS NOT DISTINCT FROM
      (dst,newj->>'id',newj->>'user_id',newj->>'seat_number',newj->>'joined_at',newj->>'club_id') THEN
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0))
   OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:'||t::text,0)) THEN
   RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001';
  END IF;
 ELSE
  PERFORM smarter_private.f06_try_lane(t);
 END IF;
 bound:=EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id IN(src,dst) AND state NOT IN ('acknowledged','withdrawn_before_manifest'));
 IF NOT bound THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;

 -- A validated elimination is neither a hand dispatch nor a seat move. The
 -- private core authorizes exactly one row image immediately before its CAS;
 -- this BEFORE trigger consumes it, so later writes cannot reuse it. Existing
 -- lane acquisition above still serializes the source/manifest transition.
 IF TG_OP='UPDATE' AND src=dst AND oldj->>'user_id'=newj->>'user_id'
 AND ((TG_TABLE_NAME='tournament_players' AND oldj->>'status'='playing'
       AND newj->>'status'='eliminated' AND oldj->'chips'='0'::jsonb
       AND newj->'chips'='0'::jsonb)
   OR (TG_TABLE_NAME='table_seats' AND oldj->>'left_at' IS NULL
       AND newj->>'left_at' IS NOT NULL AND oldj->'stack'='0'::jsonb
       AND newj->'stack'='0'::jsonb))
 AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_operations o
   WHERE o.source_table_id=src
     AND o.state NOT IN ('acknowledged','withdrawn_before_manifest')
     AND (o.state<>'park_requested' OR o.manifest IS NOT NULL
       OR o.revision<>0 OR o.custody_id IS NOT NULL OR o.custody_generation IS NOT NULL
       OR o.close_receipt IS NOT NULL OR o.cleanup_kind IS NOT NULL
       OR to_jsonb(o)->>'abort_receipt_id' IS NOT NULL
       OR EXISTS(SELECT 1 FROM smarter_private.f06_members m WHERE m.break_id=o.break_id)
       OR EXISTS(SELECT 1 FROM smarter_private.f06_attempts a WHERE a.break_id=o.break_id))) THEN
   DELETE FROM smarter_private.f06_elimination_dispatch d
   USING public.tournament_knockout_candidates c
   WHERE d.xid=txid_current() AND d.relation_name=TG_TABLE_NAME
     AND d.row_id=(oldj->>'id')::uuid AND d.candidate_id=c.id
     AND d.old_record=oldj AND d.new_record=newj
     AND c.tournament_id=t AND c.table_id=src AND c.eliminated_user_id=u
     AND c.state='pending' AND c.stack_after=0
     AND (TG_TABLE_NAME='tournament_players' AND oldj->>'tournament_id'=t::text
       OR TG_TABLE_NAME='table_seats' AND c.seat_id=(oldj->>'id')::uuid
         AND c.seat_joined_at=(oldj->>'joined_at')::timestamptz);
   IF FOUND THEN RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='table_seats' THEN
 -- Existing accepted final-hand stack updates can drain PARK_REQUESTED. Once
 -- BEGUN, only the one guarded move may vacate/change original custody.
 IF TG_OP='UPDATE' AND (oldj->>'left_at') IS NOT DISTINCT FROM (newj->>'left_at')
 AND (src,oldj->>'user_id',oldj->>'seat_number') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number') THEN
 RETURN NEW; END IF;
 ELSE
 IF TG_OP='UPDATE' AND (src,oldj->>'user_id',oldj->>'seat_number',oldj->>'status') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number',newj->>'status') THEN RETURN NEW; END IF;
 END IF;
 moving:=EXISTS(SELECT 1 FROM smarter_private.f06_dispatch d JOIN smarter_private.f06_attempts a USING(request_id)
 JOIN smarter_private.f06_operations o ON o.break_id=a.break_id WHERE d.xid=txid_current() AND a.user_id=u AND o.source_table_id=src
 AND (TG_TABLE_NAME='table_seats' AND TG_OP='UPDATE' AND src=dst AND newj->>'left_at' IS NOT NULL
 OR TG_TABLE_NAME='tournament_players' AND TG_OP='UPDATE' AND dst=a.destination_table_id AND (newj->>'seat_number')::integer=a.destination_seat_number));
 IF NOT moving AND EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch d JOIN smarter_private.f06_hand_permits h USING(permit_id) JOIN smarter_private.f06_operations o ON o.source_table_id=h.table_id WHERE d.xid=txid_current() AND h.table_id=src AND o.state='park_requested') THEN moving:=true; END IF;
 IF NOT moving THEN RAISE EXCEPTION 'F06_SOURCE_EXCLUDED' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $function$
;
ALTER FUNCTION smarter_private.f06_source_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_source_guard() FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION smarter_private.f06_source_guard() TO postgres;
CREATE OR REPLACE FUNCTION public.fn_terminal_tournament_seat_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_status text;
  v_marker timestamptz;
  v_receipted boolean := false;
  v_old_marker timestamptz;
  v_new_marker timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT tb.tournament_id INTO v_old_tournament_id
      FROM public.tables tb WHERE tb.id = OLD.table_id;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id THEN
    -- Same table on both sides: one lookup answers for both (2026-09-10).
    v_new_tournament_id := v_old_tournament_id;
  ELSIF TG_OP <> 'DELETE' THEN
    SELECT tb.tournament_id INTO v_new_tournament_id
      FROM public.tables tb WHERE tb.id = NEW.table_id;
  END IF;
  IF TG_OP <> 'INSERT' THEN v_old_marker := OLD.terminal_closed_at; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_marker := NEW.terminal_closed_at; END IF;

  -- A CASH SEAT WITH NO TERMINAL MARKER HAS NOTHING TO BE IMMUTABLE ABOUT
  -- (2026-09-10). With no tournament on either side and no marker on either
  -- side, every check below passes and the row is returned; return it here
  -- instead of after a status lookup and three receipt scans on a NULL id.
  IF v_old_tournament_id IS NULL AND v_new_tournament_id IS NULL
     AND v_old_marker IS NULL AND v_new_marker IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND v_new_tournament_id IS DISTINCT FROM v_old_tournament_id THEN
    RAISE EXCEPTION 'seat % cannot move between tournament owners',OLD.id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND v_new_marker IS NOT NULL THEN
    RAISE EXCEPTION 'new tournament seat % cannot supply a terminal marker',NEW.id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' AND v_old_marker IS NOT NULL THEN
    RAISE EXCEPTION 'terminal tournament seat % is immutable',OLD.id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND v_new_marker IS DISTINCT FROM v_old_marker THEN
    IF public.fn_ca_terminal_marker_transition_is_exact(
         to_jsonb(OLD),to_jsonb(NEW),v_old_tournament_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'seat % terminal marker transition is not canonical',OLD.id
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' AND v_new_tournament_id IS NOT NULL THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = v_new_tournament_id
     FOR SHARE;
    SELECT tb.terminal_closed_at INTO v_marker
      FROM public.tables tb
     WHERE tb.id = NEW.table_id
       AND tb.tournament_id = v_new_tournament_id
     FOR SHARE;
  ELSE
    SELECT upper(COALESCE(t.status::text,'')),tb.terminal_closed_at
      INTO v_status,v_marker
      FROM public.tables tb
      LEFT JOIN public.tournaments t ON t.id = tb.tournament_id
     WHERE tb.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.table_id ELSE NEW.table_id END;
  END IF;
  SELECT EXISTS (
           SELECT 1 FROM public.tournament_terminal_settlements h
            WHERE h.tournament_id = COALESCE(v_new_tournament_id,v_old_tournament_id))
      OR EXISTS (
           SELECT 1 FROM public.tournament_satellite_settlements h
            WHERE h.tournament_id = COALESCE(v_new_tournament_id,v_old_tournament_id))
      OR EXISTS (
           SELECT 1 FROM public.tournament_cancellation_receipts h
            WHERE h.tournament_id = COALESCE(v_new_tournament_id,v_old_tournament_id))
    INTO v_receipted;
  IF v_status IN ('COMPLETED','CANCELLED','CANCELED')
     AND (TG_OP = 'INSERT' OR v_receipted) THEN
    RAISE EXCEPTION 'terminal tournament seat % is immutable',
      CASE WHEN TG_OP = 'INSERT' THEN NEW.id ELSE OLD.id END
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$
;
ALTER FUNCTION public.fn_terminal_tournament_seat_is_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_terminal_tournament_seat_is_immutable() FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_terminal_tournament_seat_is_immutable() TO postgres;
CREATE OR REPLACE FUNCTION public.fn_log_seat_stack_exit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_stack numeric;
  v_kind  text;
BEGIN
  IF EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
            WHERE t.id=OLD.table_id AND c.asset='diamonds') THEN
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- A departed seat being tidied up is not an exit: its stack left when
    -- left_at was stamped, and that is already recorded below.
    IF OLD.left_at IS NOT NULL THEN RETURN OLD; END IF;
    v_stack := COALESCE(OLD.stack, 0);
    v_kind  := 'deleted';
  ELSE
    IF OLD.left_at IS NOT NULL OR NEW.left_at IS NULL THEN RETURN NEW; END IF;
    v_stack := COALESCE(OLD.stack, 0);
    v_kind  := 'left';
  END IF;

  IF v_stack <= 0 THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- CASH ONLY. A tournament stack is play money inside the event -- it credits
  -- no wallet when the seat ends, so it cannot be lost in the sense this table
  -- exists to detect. Filtering HERE rather than in the report keeps ~2,000
  -- meaningless rows an hour out of the audit trail entirely.
  IF EXISTS (SELECT 1 FROM public.tables t
              WHERE t.id = OLD.table_id AND t.tournament_id IS NOT NULL) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  INSERT INTO public.ca_seat_stack_exits
    (seat_id, table_id, user_id, club_id, seat_number, stack, exit_kind, db_role, app_name)
  VALUES (OLD.id, OLD.table_id, OLD.user_id, OLD.club_id, OLD.seat_number,
          v_stack, v_kind, current_user,
          NULLIF(current_setting('application_name', true), ''));

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$
;
ALTER FUNCTION public.fn_log_seat_stack_exit() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_log_seat_stack_exit() FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_log_seat_stack_exit() TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_log_seat_stack_exit() TO service_role;
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_seat_keeps_custody()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_ids uuid[];
BEGIN
 IF TG_OP='INSERT' THEN v_ids:=ARRAY[NEW.id];
 ELSIF TG_OP='DELETE' THEN v_ids:=ARRAY[OLD.id];
 ELSE v_ids:=ARRAY[OLD.id,NEW.id]; END IF;
 IF EXISTS (
   SELECT 1 FROM public.poker_diamond_custody c
   WHERE c.seat_id=ANY(v_ids) AND c.state='active' AND c.purpose='cash_seat'
     AND NOT EXISTS(SELECT 1 FROM public.table_seats s
       WHERE s.id=c.seat_id AND s.joined_at=c.seat_joined_at
         AND s.occupancy_id=c.occupancy_id AND s.user_id=c.user_id
         AND s.table_id=c.target_id AND s.club_id=c.arena_id
         AND s.left_at IS NULL AND s.stack=c.balance)
 ) OR EXISTS(
   SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
     JOIN public.clubs a ON a.id=t.club_id
   WHERE s.id=ANY(v_ids) AND a.asset='diamonds' AND s.left_at IS NULL
     AND t.tournament_id IS NULL
     AND NOT EXISTS(SELECT 1 FROM public.poker_diamond_custody c
       WHERE c.seat_id=s.id AND c.seat_joined_at=s.joined_at AND c.occupancy_id=s.occupancy_id
         AND c.user_id=s.user_id AND c.target_id=s.table_id AND c.arena_id=s.club_id
         AND c.purpose='cash_seat' AND c.state='active' AND c.balance=s.stack)
 ) THEN
   RAISE EXCEPTION 'diamond_seat_and_custody_must_commit_together' USING ERRCODE='23514';
 END IF;
 /* A DIAMOND TOURNAMENT SEAT HOLDS AN ENTRY, NOT A BALANCE. The stack is a
    nonredeemable play unit and bears no relation to custody, so nothing in
    this arm compares it to anything. What must be true at every commit is that
    the seat is covered by a live funded entry for THIS event, held against the
    tournament and not against the seat. */
 IF EXISTS(
   SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
     JOIN public.clubs a ON a.id=t.club_id
   WHERE s.id=ANY(v_ids) AND a.asset='diamonds' AND s.left_at IS NULL
     AND t.tournament_id IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM public.poker_diamond_custody c
       WHERE c.user_id=s.user_id AND c.target_id=t.tournament_id AND c.arena_id=s.club_id
         AND c.purpose='tournament_entry' AND c.state='active' AND c.seat_id IS NULL)
 ) THEN
   RAISE EXCEPTION 'A Diamond Tournament Seat Must Hold Its Funded Entry' USING ERRCODE='P0812';
 END IF;
 RETURN NULL;
END $function$
;
ALTER FUNCTION public.fn_poker_diamond_seat_keeps_custody() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_seat_keeps_custody() FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_seat_keeps_custody() TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_seat_keeps_custody() TO service_role;
CREATE OR REPLACE FUNCTION public.trg_refuse_finalized_tournament_entry()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_finalized boolean;
BEGIN
  SELECT COALESCE(t.prize_pool_finalized, false)
    INTO v_finalized
    FROM public.tournaments t
   WHERE t.id = NEW.tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', NEW.tournament_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_finalized THEN
    RAISE EXCEPTION 'registration is closed because tournament % prize pool is finalized',
      NEW.tournament_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$
;
ALTER FUNCTION public.trg_refuse_finalized_tournament_entry() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.trg_refuse_finalized_tournament_entry() FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT EXECUTE ON FUNCTION public.trg_refuse_finalized_tournament_entry() TO postgres;
GRANT EXECUTE ON FUNCTION public.trg_refuse_finalized_tournament_entry() TO service_role;
COMMIT;
