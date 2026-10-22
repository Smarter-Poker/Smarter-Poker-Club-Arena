-- 20261021234526_tournament_finishers_are_paid_the_moment_they_bust.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, 2026-10-21: "PAYOUTS FOR TOURNAMENTS WHEN A PLAYER BUSTS NEEDS TO BE
-- REAL TIME PAYOUT, IT SHOULD NOT WAIT UNTIL THE END OF THE TOURNAMENT FOR A
-- PLAYER TO GET PAID. THEY SHOULD GET THE CHIPS SENT TO THERE ACCOUNT AS SOON
-- AS THEY BUST OUT."
--
-- Until now the elimination doors (fn_eliminate_tournament_player_atomic and
-- fn_claim_tournament_bounty_elimination) recorded a PROVISIONAL place and
-- moved no money; every place and the Bubble Protection refund waited for the
-- terminal settlement (fn_settle_tournament_places). A player who busted 46th
-- of 526 waited hours for 3.50.
--
-- The root fix is in the live path: the commit that records a bust now pays
-- it. A deferred constraint trigger on tournament_players (playing ->
-- eliminated) and one on tournaments (prize_pool_finalized false -> true) run
-- fn_ca_pay_tournament_finishers_now at COMMIT of that same transaction, when
-- the door has finished every write. It pays through the SAME idempotent
-- obligation door the terminal settlement uses (fn_ca_settle_tournament_place_raw
-- and fn_ca_settle_tournament_bubble_raw -> fn_settle_tournament_obligation ->
-- fn_credit_and_log, per-obligation idempotency keys, escrow-capped), so the
-- terminal settlement later finds each of these places exactly settled and
-- pays only what remains. Nobody can be paid twice, and nothing is taken back.
--
-- WHEN A PLACE IS FINAL (the only time it may be paid):
--   * the event is RUNNING and its pool is finalized (late registration is
--     closed; no further entry can move a place or a prize);
--   * not a satellite (seats go to survivors) and no final-table deal or
--     place batch owns the event;
--   * no bust is waiting to be recorded (a 'playing' row at zero chips) - its
--     own commit calls this again, so a simultaneous multi-bust is paid by
--     the last commit of the batch;
--   * the place is derived by the terminal's own rule (2026-09-11: ordered by
--     when each bust happened, the accepted hand's commit time plus one
--     microsecond per smaller hand-start stack), as live field + rank. The
--     engine's sweep places are provisional by design (late registration
--     enlarges the field after early busts; measured live on 2026-10-21:
--     481 of 481 standings in a 526-entry event differed); unpaid ones are
--     restamped to the true place, exactly as the terminal would restamp
--     them. A PAID place is never relabelled: if one no longer matches, this
--     pays nothing and leaves the event to the terminal settlement.
--
-- Probed against production in a self-aborting DO block (CLAUDE.md 11.5) on
-- RUNNING event 48d2a79d (Afternoon Free Buy, 526 entries, 53 paid): paid
-- places 53..46 for 3.15..3.50, a replay paid nothing, escrow prize balance
-- moved 500.00 -> 480.35 = pool minus paid, every obligation matched its
-- standing and its payout row, every payout row named its wallet key, no
-- orphaned keys, and the 526 standings stayed distinct and contiguous.
--
-- A failure here never blocks a bust: the payer runs in its own
-- subtransaction inside the trigger; a refusal rolls back only the payment,
-- is written to financial_alerts, and the terminal settlement pays it exactly
-- as it always has.

BEGIN;

-- Two triggers on hot tables: never queue writers behind a long transaction.
SET LOCAL lock_timeout = '5s';

INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
 ('fn_ca_pay_tournament_finishers_now','approved','Real-time tournament place/Bubble payment at bust commit. RUNNING finalized non-satellite events only; derives the terminal place rule; pays through fn_ca_settle_tournament_place_raw / fn_ca_settle_tournament_bubble_raw (obligation idempotency, escrow-capped); never relabels a paid place; no direct wallet writes.'),
 ('trg_ca_pay_tournament_finishers_at_commit','approved','Deferred trigger wrapper for fn_ca_pay_tournament_finishers_now; one call per tournament per transaction; failures roll back only the payment and are recorded in financial_alerts.')
ON CONFLICT (proname) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_ca_pay_tournament_finishers_now(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record;
  v_live integer;
  v_field integer;
  v_max_place integer;
  v_bubble_place integer;
  v_bubble_amount numeric := 0;
  v_rows jsonb;
  v_ladder jsonb;
  v_row jsonb;
  v_bad_paid integer;
  v_mismatch integer;
  v_normalized integer := 0;
  v_paid jsonb := '[]'::jsonb;
  v_amount numeric;
  v_user uuid;
  v_place integer;
  v_result jsonb;
  v_ob public.tournament_obligations%ROWTYPE;
BEGIN
  IF p_tournament_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'skipped','no_tournament');
  END IF;

  -- The same rolling lane every place/bounty authority enters, then the row.
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  SELECT t.id, t.status, t.variant, t.tournament_type, t.satellite_target_id,
         t.satellite_target, t.prize_pool, t.prize_pool_finalized,
         t.bubble_protection, t.buy_in_amount
    INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'skipped','tournament_not_found');
  END IF;

  -- Real-time pay is for a live event whose pool is locked. Before the pool is
  -- finalized nobody's prize is known yet; the finalization itself calls this.
  IF upper(COALESCE(v_t.status,'')) <> 'RUNNING' THEN
    RETURN jsonb_build_object('ok',true,'skipped','not_running');
  END IF;
  IF COALESCE(v_t.prize_pool_finalized,false) IS NOT TRUE THEN
    RETURN jsonb_build_object('ok',true,'skipped','pool_not_finalized');
  END IF;
  -- Satellites award seats to survivors; a deal has its own authority.
  IF lower(COALESCE(v_t.variant,'')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type,'')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    RETURN jsonb_build_object('ok',true,'skipped','satellite');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_payouts p
              WHERE p.tournament_id = p_tournament_id
                AND lower(COALESCE(p.source,'')) = 'final_table_deal')
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id
                   AND o.kind = 'final_table_deal')
     OR EXISTS (SELECT 1 FROM public.tournament_place_settlement_batches b
                 WHERE b.tournament_id = p_tournament_id) THEN
    RETURN jsonb_build_object('ok',true,'skipped','terminal_authority_owns_it');
  END IF;

  -- A bust that has happened but is not recorded yet (zero chips, still
  -- 'playing') may finish below someone already eliminated. Pay nobody until
  -- the door has recorded it; its own commit calls this again.
  IF EXISTS (SELECT 1 FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND tp.status::text = 'playing'
                AND COALESCE(tp.chips,0) <= 0)
     OR EXISTS (SELECT 1 FROM public.tournament_players tp
                 WHERE tp.tournament_id = p_tournament_id
                   AND tp.status::text = 'registered') THEN
    RETURN jsonb_build_object('ok',true,'skipped','bust_not_recorded_yet');
  END IF;

  SELECT count(*) FILTER (WHERE tp.status::text IN ('playing','winner')),
         count(*)
    INTO v_live, v_field
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  IF v_live < 1 THEN
    -- The last survivor has crossed through 'eliminated'; the terminal
    -- settlement names the winner and pays the rest in the same transaction.
    RETURN jsonb_build_object('ok',true,'skipped','no_live_survivor');
  END IF;

  SELECT COALESCE(jsonb_object_agg(a.place::text, a.amount), '{}'::jsonb),
         max(a.place)
    INTO v_ladder, v_max_place
    FROM public.fn_ca_tournament_place_amounts(p_tournament_id) a;
  IF v_max_place IS NULL THEN
    RETURN jsonb_build_object('ok',true,'skipped','no_ladder');
  END IF;
  IF COALESCE(v_t.bubble_protection,false) AND v_field > v_max_place THEN
    v_bubble_place := v_max_place + 1;
    v_bubble_amount := round(v_t.buy_in_amount, 2);
  END IF;

  -- Every eliminated finisher sits strictly below the live field. If the best
  -- of them is still outside the money there is nothing to pay yet.
  IF v_live + 1 > COALESCE(v_bubble_place, v_max_place) THEN
    RETURN jsonb_build_object('ok',true,'skipped','nobody_in_the_money_yet',
                              'live',v_live,'paid_places',v_max_place);
  END IF;

  /* The finishing place of each eliminated player, by the rule the terminal
     settlement ranks with (fn_settle_tournament_places, 2026-09-11): busts
     are ordered by when they happened - the accepted hand's commit time plus
     one microsecond per smaller hand-start stack in that hand - then
     elimination_sequence, then id. While the event is live the place is the
     live field plus that rank, which is exactly the terminal's place once the
     field is down to its winner. */
  WITH busts AS (
    SELECT tp.id, tp.user_id, tp.position, tp.elimination_sequence,
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
    SELECT b.id, b.user_id, b.position, b.bust_at,
           v_live + row_number() OVER (
             ORDER BY b.bust_at DESC, b.elimination_sequence DESC, b.id ASC
           )::integer AS place
      FROM busts b
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id',r.id,'user_id',r.user_id,'position',r.position,'place',r.place,
           'unwitnessed',r.bust_at IS NULL,
           'evidence',(
             EXISTS (SELECT 1 FROM public.tournament_obligations o
                      WHERE o.tournament_id = p_tournament_id
                        AND o.kind IN ('place','bubble_protection')
                        AND o.user_id = r.user_id AND o.amount_paid > 0)
             OR EXISTS (SELECT 1 FROM public.tournament_payouts p
                         WHERE p.tournament_id = p_tournament_id
                           AND p.user_id = r.user_id
                           AND COALESCE(p.source,'') NOT IN
                             ('bounty','own_bounty','mystery_bounty',
                              'mystery_bounty_residual','bounty_residual',
                              'satellite_seat'))))
           ORDER BY r.place), '[]'::jsonb)
    INTO v_rows
    FROM ranked r;

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) e
              WHERE (e->>'unwitnessed')::boolean) THEN
    RETURN jsonb_build_object('ok',true,'skipped','bust_time_unwitnessed');
  END IF;

  -- A paid place is never relabelled. If one no longer matches the rule,
  -- leave everything to the terminal settlement, which will say so.
  SELECT count(*) INTO v_bad_paid
    FROM jsonb_array_elements(v_rows) e
   WHERE (e->>'evidence')::boolean
     AND (e->>'position')::integer IS DISTINCT FROM (e->>'place')::integer;
  IF v_bad_paid > 0 THEN
    RETURN jsonb_build_object('ok',false,'skipped','paid_place_out_of_order',
                              'rows',v_bad_paid);
  END IF;

  /* Unpaid standings recorded against a smaller field (a bust during late
     registration) or in a different same-hand order are restamped with their
     true place now, exactly as the terminal settlement would restamp them,
     so the place paid now is the place they finish in. Clear first, then
     stamp, so the collision guard never sees two players on one place. */
  SELECT count(*) INTO v_mismatch
    FROM jsonb_array_elements(v_rows) e
   WHERE (e->>'position')::integer IS DISTINCT FROM (e->>'place')::integer;
  IF v_mismatch > 0 THEN
    UPDATE public.tournament_players tp
       SET position = NULL
      FROM jsonb_array_elements(v_rows) e
     WHERE tp.id = (e->>'id')::uuid
       AND tp.tournament_id = p_tournament_id
       AND (e->>'position')::integer IS DISTINCT FROM (e->>'place')::integer;
    UPDATE public.tournament_players tp
       SET position = (e->>'place')::integer
      FROM jsonb_array_elements(v_rows) e
     WHERE tp.id = (e->>'id')::uuid
       AND tp.tournament_id = p_tournament_id
       AND (e->>'position')::integer IS DISTINCT FROM (e->>'place')::integer;
    GET DIAGNOSTICS v_normalized = ROW_COUNT;
    IF v_normalized <> v_mismatch THEN
      RAISE EXCEPTION 'tournament % restamped % of % standings',
        p_tournament_id, v_normalized, v_mismatch USING ERRCODE = 'P0404';
    END IF;
  END IF;

  -- tournament_players.prize is the presentation cache of each standing. The
  -- engine stamps it from its provisional place; restate it from the locked
  -- ladder at the true place so a player sees what was actually paid.
  UPDATE public.tournament_players tp
     SET prize = CASE
           WHEN v_bubble_place IS NOT NULL AND (e->>'place')::integer = v_bubble_place
             THEN v_bubble_amount
           ELSE COALESCE((v_ladder->>(e->>'place'))::numeric, 0)
         END
    FROM jsonb_array_elements(v_rows) e
   WHERE tp.id = (e->>'id')::uuid
     AND tp.tournament_id = p_tournament_id
     AND tp.prize IS DISTINCT FROM CASE
           WHEN v_bubble_place IS NOT NULL AND (e->>'place')::integer = v_bubble_place
             THEN v_bubble_amount
           ELSE COALESCE((v_ladder->>(e->>'place'))::numeric, 0)
         END;

  -- Pay every finisher in the money who is not fully paid, through the same
  -- idempotent obligation door the terminal settlement uses.
  FOR v_row IN
    SELECT e FROM jsonb_array_elements(v_rows) e
     WHERE (e->>'place')::integer <= COALESCE(v_bubble_place, v_max_place)
     ORDER BY (e->>'place')::integer DESC
  LOOP
    v_place := (v_row->>'place')::integer;
    v_user := (v_row->>'user_id')::uuid;
    IF v_bubble_place IS NOT NULL AND v_place = v_bubble_place THEN
      IF v_bubble_amount > 0 AND NOT EXISTS (
        SELECT 1 FROM public.tournament_obligations o
         WHERE o.tournament_id = p_tournament_id
           AND o.kind = 'bubble_protection'
           AND o.user_id = v_user
           AND o.amount_paid >= o.amount_owed AND o.amount_owed = v_bubble_amount) THEN
        v_result := public.fn_ca_settle_tournament_bubble_raw(
          p_tournament_id, v_user, v_bubble_amount);
        v_paid := v_paid || jsonb_build_object('place',v_place,'user_id',v_user,
          'amount',v_bubble_amount,'kind','bubble_protection');
      END IF;
      CONTINUE;
    END IF;
    v_amount := (v_ladder->>v_place::text)::numeric;
    IF v_amount IS NULL OR v_amount <= 0 THEN
      CONTINUE;
    END IF;
    v_ob := NULL;
    SELECT * INTO v_ob FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place' AND o.place = v_place;
    IF v_ob.id IS NOT NULL AND v_ob.user_id = v_user
       AND v_ob.amount_owed = v_amount AND v_ob.amount_paid >= v_amount THEN
      CONTINUE;
    END IF;
    v_result := public.fn_ca_settle_tournament_place_raw(
      p_tournament_id, v_place, v_user, v_amount);
    v_paid := v_paid || jsonb_build_object('place',v_place,'user_id',v_user,
      'amount',v_amount,'kind','place');
  END LOOP;

  RETURN jsonb_build_object('ok',true,'paid',v_paid,'restamped',v_normalized,
                            'live',v_live,'paid_places',v_max_place);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_pay_tournament_finishers_now(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_pay_tournament_finishers_now(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.trg_ca_pay_tournament_finishers_at_commit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_flag text;
  v_result jsonb;
  v_state text;
  v_message text;
BEGIN
  IF TG_TABLE_NAME = 'tournaments' THEN
    v_tournament_id := NEW.id;
  ELSE
    v_tournament_id := NEW.tournament_id;
  END IF;
  IF v_tournament_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Deferred triggers fire at COMMIT after every row is written, so one call
  -- per tournament per transaction sees the whole batch.
  v_flag := 'ca_instant_pay.t' || replace(v_tournament_id::text, '-', '');
  IF current_setting(v_flag, true) = 'done' THEN
    RETURN NULL;
  END IF;
  PERFORM set_config(v_flag, 'done', true);

  BEGIN
    v_result := public.fn_ca_pay_tournament_finishers_now(v_tournament_id);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    v_result := jsonb_build_object('ok', false, 'sqlstate', v_state, 'error', v_message);
  END;

  IF COALESCE((v_result->>'ok')::boolean, false) IS NOT TRUE THEN
    -- The bust stays recorded and the terminal settlement still pays the
    -- place; this says, once per event, that it was not paid at the bust.
    INSERT INTO public.financial_alerts(severity, source, message, context)
    SELECT 'warning', 'tournament.real_time_payout_refused',
           'A finisher was not paid at the moment of the bust; the terminal settlement will pay the place.',
           jsonb_build_object('tournament_id', v_tournament_id, 'result', v_result)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts fa
        WHERE fa.source = 'tournament.real_time_payout_refused'
          AND NOT fa.resolved
          AND fa.context->>'tournament_id' = v_tournament_id::text);
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_ca_pay_tournament_finishers_at_commit() FROM PUBLIC, anon, authenticated;

CREATE CONSTRAINT TRIGGER zzz_pay_finisher_at_bust
  AFTER UPDATE OF status ON public.tournament_players
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.status::text = 'playing' AND NEW.status::text = 'eliminated')
  EXECUTE FUNCTION public.trg_ca_pay_tournament_finishers_at_commit();

CREATE CONSTRAINT TRIGGER zzz_pay_finishers_when_pool_finalizes
  AFTER UPDATE OF prize_pool_finalized ON public.tournaments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.prize_pool_finalized IS TRUE AND OLD.prize_pool_finalized IS DISTINCT FROM TRUE)
  EXECUTE FUNCTION public.trg_ca_pay_tournament_finishers_at_commit();

-- Both triggers sit on money tables, so they are declared in this migration.
INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note) VALUES
 ('tournament_players','zzz_pay_finisher_at_bust','Dan 2026-10-21: real-time tournament payouts. DEFERRABLE INITIALLY DEFERRED AFTER UPDATE OF status (playing -> eliminated): at the commit of the bust runs fn_ca_pay_tournament_finishers_now, which pays finishers in the money of a RUNNING finalized non-satellite event only through fn_ca_settle_tournament_place_raw / fn_ca_settle_tournament_bubble_raw (idempotent, escrow-capped obligations). Never blocks the bust: failures roll back only the payment and are written to financial_alerts.'),
 ('tournaments','zzz_pay_finishers_when_pool_finalizes','Dan 2026-10-21: real-time tournament payouts. DEFERRABLE INITIALLY DEFERRED AFTER UPDATE OF prize_pool_finalized (to true): pays, at that commit, any finisher already in the money through fn_ca_pay_tournament_finishers_now. Same gates and same obligation doors; never blocks the finalization.')
ON CONFLICT (table_name, trigger_name) DO UPDATE SET note = EXCLUDED.note;

COMMIT;
