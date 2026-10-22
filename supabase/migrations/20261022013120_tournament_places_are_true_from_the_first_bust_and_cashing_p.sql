-- 20261022013120_tournament_places_are_true_from_the_first_bust_and_cashing_p.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch.
--
-- WHAT THIS CHANGES, AND WHY (Dan, 2026-10-21: "fully build, fix and enhance
-- all of these"):
--
-- 1. A CASHING PLAYER IS TOLD. No tournament prize ever produced a bell or a
--    push; the only record was the wallet line. zzz_notify_tournament_cash on
--    tournament_obligations writes one 'tournament_cash' notification the
--    moment a place, Bubble Protection, satellite seat or satellite cash
--    obligation becomes fully paid - at the bust for a real-time place, at the
--    finish for the winner - and the existing notification -> push_outbox
--    mirror delivers it as a push under every normal preference, quiet-hour
--    and device gate. Exactly once per obligation (keyed on obligation_id),
--    and a failure is a warning inside its own subtransaction: a notice can
--    never roll back the payment that caused it. Horses receive it exactly as
--    humans do (CLAUDE.md 10.5); the dispatcher skips any account with no
--    device, as it does for achievements today.
--    Probed (self-aborting DO block): place, winner, bubble, seat and
--    satellite-cash notices each written once on a replay, Diamond events
--    worded in Diamonds, every one mirrored to push_outbox as pending.
--
-- 2. THE PLACE IS TRUE FROM THE FIRST BUST AFTER THE FIELD IS FIXED.
--    fn_ca_pay_tournament_finishers_now used to return before restamping the
--    standings until somebody was in the money, so between late
--    registration closing and the bubble every bust kept the engine's
--    provisional place (measured live: a 222-entry event showed places 2 to
--    200 with 25 players left). Once the pool is finalized it now restamps
--    place and prize cache on every bust, in the money or not. Before the
--    pool is finalized the field can still grow, so no place is final and
--    nothing changes. Payment gates and doors are unchanged.
--
-- 3. SATELLITE CASH IS ALREADY PAID AT THE BUST. Measured on the last three
--    satellites: the satellite remainder goes to the bust that ends the
--    satellite and was credited 5 seconds after it (01:21:52 -> 01:21:57,
--    01:11:01 -> 01:11:06, 00:53:02 -> 00:53:07), by the cohort settlement the
--    same bust triggers. No second payment path is added; the notice above
--    now tells that player too.

BEGIN;

SET LOCAL lock_timeout = '5s';

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
  v_finalized boolean;
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

  -- A live event whose pool is locked. Until late registration closes the
  -- field can still grow, so no place is final and none is paid; the
  -- finalization itself calls this again.
  IF upper(COALESCE(v_t.status,'')) <> 'RUNNING' THEN
    RETURN jsonb_build_object('ok',true,'skipped','not_running');
  END IF;
  v_finalized := COALESCE(v_t.prize_pool_finalized,false);
  IF NOT v_finalized THEN
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

  v_ladder := '{}'::jsonb;
  IF v_finalized THEN
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

  /* THE PLACE IS TRUE FROM THE FIRST BUST AFTER THE FIELD IS FIXED
     (2026-10-21). This used to stop before the restamp until somebody was in
     the money, so every bust between late registration closing and the
     bubble kept the engine's provisional place (measured: a 222-entry event
     showed places 2 to 200 with 25 players left). The standings are now
     restamped on every bust once the pool is finalized, in the money or not. */
  -- Every eliminated finisher sits strictly below the live field. If the best
  -- of them is still outside the money there is nothing to pay yet.
  IF v_live + 1 > COALESCE(v_bubble_place, v_max_place) THEN
    RETURN jsonb_build_object('ok',true,'skipped','nobody_in_the_money_yet',
                              'restamped',v_normalized,'live',v_live,'paid_places',v_max_place);
  END IF;

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

CREATE OR REPLACE FUNCTION public.fn_ca_ordinal(p_n integer)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT p_n::text || CASE
    WHEN p_n % 100 IN (11,12,13) THEN 'th'
    WHEN p_n % 10 = 1 THEN 'st'
    WHEN p_n % 10 = 2 THEN 'nd'
    WHEN p_n % 10 = 3 THEN 'rd'
    ELSE 'th' END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_ca_notify_tournament_cash()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record;
  v_target text;
  v_diamond boolean;
  v_unit text;
  v_amount_text text;
  v_title text;
  v_message text;
BEGIN
  -- Exactly once: the moment the obligation becomes fully paid.
  IF NEW.settled_at IS NULL OR NEW.user_id IS NULL
     OR COALESCE(NEW.amount_paid,0) <= 0
     OR NEW.kind NOT IN ('place','bubble_protection','satellite_remainder','seat') THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.settled_at IS NOT NULL THEN
    RETURN NULL;
  END IF;

  /* A notice can never cost a player their money: it runs in its own
     subtransaction and a failure is a warning, never a rollback of the
     payment that triggered it. */
  BEGIN
    IF EXISTS (SELECT 1 FROM public.notifications n
                WHERE n.user_id = NEW.user_id
                  AND n.type = 'tournament_cash'
                  AND n.data->>'obligation_id' = NEW.id::text) THEN
      RETURN NULL;
    END IF;

    SELECT t.id, t.name, t.satellite_target_id INTO v_t
      FROM public.tournaments t WHERE t.id = NEW.tournament_id;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    v_diamond := public.fn_poker_diamond_tournament(NEW.tournament_id);
    v_unit := CASE WHEN v_diamond THEN 'Diamonds' ELSE 'Chips' END;
    v_amount_text := CASE WHEN v_diamond
      THEN to_char(round(NEW.amount_paid), 'FM999,999,999,990')
      ELSE to_char(NEW.amount_paid, 'FM999,999,999,990.00') END;

    IF NEW.kind = 'seat' THEN
      SELECT x.name INTO v_target FROM public.tournaments x WHERE x.id = v_t.satellite_target_id;
      v_title := 'You Won A Seat';
      v_message := format('You Won A Seat To %s From %s.',
        COALESCE(v_target, 'The Target Event'), COALESCE(v_t.name, 'Your Satellite'));
    ELSIF NEW.kind = 'bubble_protection' THEN
      v_title := 'Bubble Protection Paid';
      v_message := format('Your Buy-In Of %s %s From %s Is Back In Your Wallet.',
        v_amount_text, v_unit, COALESCE(v_t.name, 'Your Tournament'));
    ELSIF NEW.kind = 'satellite_remainder' THEN
      v_title := 'Satellite Cash Paid';
      v_message := format('You Won %s %s In %s. It Is Already In Your Wallet.',
        v_amount_text, v_unit, COALESCE(v_t.name, 'Your Satellite'));
    ELSIF NEW.place = 1 THEN
      v_title := 'You Won The Tournament';
      v_message := format('You Won %s %s For First Place In %s. It Is Already In Your Wallet.',
        v_amount_text, v_unit, COALESCE(v_t.name, 'Your Tournament'));
    ELSE
      v_title := format('You Finished %s', public.fn_ca_ordinal(NEW.place));
      v_message := format('You Won %s %s For %s Place In %s. It Is Already In Your Wallet.',
        v_amount_text, v_unit, public.fn_ca_ordinal(NEW.place), COALESCE(v_t.name, 'Your Tournament'));
    END IF;

    INSERT INTO public.notifications(user_id, type, title, message, data, link)
    VALUES (NEW.user_id, 'tournament_cash', v_title, v_message,
      jsonb_build_object(
        'obligation_id', NEW.id,
        'tournament_id', NEW.tournament_id,
        'kind', NEW.kind,
        'place', NEW.place,
        'amount', NEW.amount_paid,
        'asset', CASE WHEN v_diamond THEN 'diamonds' ELSE 'chips' END),
      '/hub/club-arena/tournaments/' || NEW.tournament_id::text);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'tournament cash notice for obligation % failed: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_ca_notify_tournament_cash() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER zzz_notify_tournament_cash
  AFTER INSERT OR UPDATE OF settled_at ON public.tournament_obligations
  FOR EACH ROW
  WHEN (NEW.settled_at IS NOT NULL)
  EXECUTE FUNCTION public.trg_ca_notify_tournament_cash();

COMMIT;
