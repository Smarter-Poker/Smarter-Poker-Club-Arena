BEGIN;
SET LOCAL lock_timeout = '8s';

/* TOURNAMENT RAKE ATTRIBUTION RETRIES INSIDE ITS OWN TRANSACTION.
   CLAUDE.md 10.12: "if the live path can fail - a crash mid-settle, a lock, a
   timeout - then the live path is what has to become atomic, retried INSIDE
   ITS OWN TRANSACTION, or restartable from its own record. Not swept up an
   hour later by somebody else."

   MEASURED, 2026-09-09, the last seven days: 77,627 tournament rake
   settlements. Every one was eventually attributed - and 435 of them only by
   the repair sweep, 21 minutes late on average, worst 6.9 hours. The settle
   raised "Rake settled but attribution failed" 474 times: 336 deadlocks, 133
   lock timeouts. Until attribution lands nobody in that event has their VIP
   points, agent commission or rakeback basis - horses and humans alike (10.5)
   - and a repair job that has run 435 times for one cause is proof the cause
   was never fixed.

   THE CAUSE. fn_attribute_tournament_rake walks the event's players in uid
   order so two SETTLEMENTS cannot deadlock each other. But the live cash path
   locks the same players' VIP, agent-wallet and player_stats rows in HAND
   order - fn_award_vip_points_from_rake fires on every rake_records insert -
   and at 77k settlements a week a 200-player walk collides with live play.
   Postgres kills one side; when it is the settlement, the subtransaction
   below rolled back, the alert fired, attributed_at stayed NULL, and a cron
   picked it up some time later.

   THE FIX. A deadlock and a lock timeout are transient by definition - the
   competing hand finishes in milliseconds. The attribution block was already
   a subtransaction (BEGIN/EXCEPTION), so a failed attempt already rolls back
   cleanly and leaves the settle intact. It simply never tried again. Now it
   tries up to four times on exactly those two SQLSTATEs - 40P01
   deadlock_detected and 55P03 lock_not_available - with 100/300/600 ms
   between attempts, and stamps attributed_at in the SAME call the moment it
   succeeds. Every other error still fails once and alerts, as before. The
   back-off total is bounded at one second so the club_wallets lock this
   function holds cannot stall cash hands at that club for longer than that.

   The alert stays and is now expected to find nothing; the repair sweep
   stays until its 30-day zero window and is then deleted (BAND-AIDS-REGISTER). */

CREATE OR REPLACE FUNCTION public.fn_settle_tournament_rake(p_tournament_id uuid, p_source text DEFAULT 'engine'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_t record; v_union uuid; v_net numeric; v_dest text; v_res jsonb;
  v_claimed integer; v_prior record; v_att jsonb; v_att_ok boolean := false;
  v_att_err text; v_users integer; v_members integer; v_done boolean := false;
  v_attempt integer := 0; v_attempts integer := 0; v_state text;
BEGIN
  SELECT t.id, t.status, t.club_id, t.name, t.current_players
    INTO v_t FROM public.tournaments t WHERE t.id = p_tournament_id FOR NO KEY UPDATE;
  /* NO KEY UPDATE, not UPDATE (20260906): a cash hand's rake_records row
     references this tournament and takes KEY SHARE on it, which FOR UPDATE
     refused and NO KEY UPDATE admits. Settlement is still serialised against
     itself. */
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF upper(COALESCE(v_t.status, '')) NOT IN ('COMPLETING', 'COMPLETED', 'CANCELLED', 'CANCELED') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_terminal', 'status', v_t.status);
  END IF;

  INSERT INTO public.tournament_rake_settlements (tournament_id, club_id, amount, destination, source)
  VALUES (p_tournament_id, v_t.club_id, 0, 'pending', COALESCE(p_source, 'engine'))
  ON CONFLICT (tournament_id) DO NOTHING;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    SELECT amount, destination, settled_at INTO v_prior
      FROM public.tournament_rake_settlements WHERE tournament_id = p_tournament_id;
    RETURN jsonb_build_object('ok', true, 'already_settled', true,
      'amount', v_prior.amount, 'destination', v_prior.destination,
      'settled_at', v_prior.settled_at);
  END IF;

  SELECT round(COALESCE(sum(r.rake_amount), 0), 2) INTO v_net
    FROM public.rake_records r
   WHERE r.tournament_id = p_tournament_id AND r.is_tournament;

  IF v_net <= 0 OR v_t.club_id IS NULL THEN
    UPDATE public.tournament_rake_settlements
       SET amount = GREATEST(v_net, 0),
           destination = CASE WHEN v_t.club_id IS NULL THEN 'no_club' ELSE 'none' END,
           settled_at = now(),
           attributed_at = now(),
           attributed_users = 0
     WHERE tournament_id = p_tournament_id;
    RETURN jsonb_build_object('ok', true, 'amount', GREATEST(v_net, 0), 'destination', 'none');
  END IF;

  SELECT c.union_id INTO v_union FROM public.clubs c WHERE c.id = v_t.club_id;

  /* ONE LOCK ORDER WITH atomic_distribute_rake (20260906). The cash path
     locks club_wallets FIRST and then union_wallets or clubs. This function
     credited the union wallet (or the club treasury) first and touched
     club_wallets last - the mirror image - and the two met in the middle 249
     times a day. Taking the club_wallets row here, before either credit, puts
     both writers in the same order: club_wallets -> union_wallets | clubs. */
  PERFORM 1 FROM public.club_wallets WHERE club_id = v_t.club_id FOR NO KEY UPDATE;

  -- ZERO-DRIFT phase 2: banked tournament rake = 'rake' vs the tournament.
  PERFORM set_config('app.ledger_category', 'rake', true);
  PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
  PERFORM set_config('app.ledger_counterparty_entity', p_tournament_id::text, true);

  IF v_union IS NOT NULL THEN
    v_res := public.increment_union_wallet(
      v_union, v_net, v_t.club_id,
      'Tournament rake: ' || COALESCE(v_t.name, 'tournament')
        || ' (' || COALESCE(v_t.current_players, 0) || ' entries)'
        || ' [tournament ' || p_tournament_id || ']');
    IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'fn_settle_tournament_rake: union wallet credit failed for %: %',
        p_tournament_id, v_res;
    END IF;
    v_dest := 'union:' || v_union;
  ELSE
    PERFORM public.credit_club_rake_to_treasury(v_t.club_id, v_net);
    v_dest := 'club_treasury:' || v_t.club_id;
  END IF;

  UPDATE public.club_wallets
     SET period_rake_collected   = COALESCE(period_rake_collected, 0) + v_net,
         lifetime_rake_collected = COALESCE(lifetime_rake_collected, 0) + v_net,
         updated_at = now()
   WHERE club_id = v_t.club_id;

  /* ATTRIBUTION, RETRIED INSIDE THIS TRANSACTION (2026-09-09 - see header).
     Each attempt is its own subtransaction: a deadlock or a lock timeout
     inside it rolls back only the attempt, never the settle above. The two
     SQLSTATEs retried are the two that are transient by construction; any
     other error fails once and alerts exactly as before. */
  LOOP
    v_attempt := v_attempt + 1;
    BEGIN
      v_att := public.fn_attribute_tournament_rake(p_tournament_id);
      v_att_ok := COALESCE((v_att->>'ok')::boolean, false);
      v_att_err := CASE WHEN v_att_ok THEN NULL
                        ELSE COALESCE(v_att->>'reason', 'attribution returned ok=false') END;
      EXIT;
    EXCEPTION
      WHEN deadlock_detected OR lock_not_available THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
        IF v_attempt >= 4 THEN
          v_att_err := SQLERRM || ' (after ' || v_attempt || ' attempts)';
          v_att := jsonb_build_object('ok', false, 'reason', v_att_err);
          INSERT INTO public.financial_alerts (severity, source, message, context)
          VALUES ('warning', 'fn_settle_tournament_rake',
                  'Rake settled but attribution failed: ' || v_att_err,
                  jsonb_build_object('tournament_id', p_tournament_id, 'net', v_net,
                                     'sqlstate', v_state, 'attempts', v_attempt));
          EXIT;
        END IF;
        PERFORM pg_sleep(CASE v_attempt WHEN 1 THEN 0.1 WHEN 2 THEN 0.3 ELSE 0.6 END);
      WHEN OTHERS THEN
        v_att_err := SQLERRM;
        v_att := jsonb_build_object('ok', false, 'reason', v_att_err);
        INSERT INTO public.financial_alerts (severity, source, message, context)
        VALUES ('warning', 'fn_settle_tournament_rake',
                'Rake settled but attribution failed: ' || v_att_err,
                jsonb_build_object('tournament_id', p_tournament_id, 'net', v_net,
                                   'attempts', v_attempt));
        EXIT;
    END;
  END LOOP;
  v_attempts := v_attempt;

  v_users   := COALESCE((v_att->>'attributed_users')::int, 0);
  v_members := COALESCE((v_att->>'members')::int, 0);

  /* ZERO IS NOT SUCCESS. Banked rake that credited nobody, while there were
     players to credit, is a FAILURE: it stays in the repair queue
     (attributed_at IS NULL) instead of being stamped as done. A settlement
     with no members is terminal - retrying it forever would pin the head of
     that queue, which is the failure mode the Heads-Up back-pay hit. */
  v_done := v_att_ok AND (v_users > 0 OR v_members = 0);
  IF v_att_ok AND v_users = 0 AND v_members > 0 THEN
    v_att_err := 'attributed_nobody';
  END IF;

  UPDATE public.tournament_rake_settlements
     SET amount = v_net, union_id = v_union, destination = v_dest, settled_at = now(),
         attributed_at = CASE WHEN v_done THEN now() ELSE NULL END,
         attributed_users = v_users,
         attribution_error = v_att_err
   WHERE tournament_id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'amount', v_net, 'destination', v_dest,
                            'attributed', v_done,
                            'attributed_users', v_users, 'members', v_members,
                            'attribution_attempts', v_attempts);
END;
$function$;

DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_settle_tournament_rake';
  IF v_src NOT LIKE '%WHEN deadlock_detected OR lock_not_available THEN%' THEN
    RAISE EXCEPTION 'the retry did not land';
  END IF;
  IF v_src NOT LIKE '%IF v_attempt >= 4 THEN%' THEN
    RAISE EXCEPTION 'the retry is unbounded';
  END IF;
  IF has_function_privilege('anon', 'public.fn_settle_tournament_rake(uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_settle_tournament_rake(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can settle tournament rake';
  END IF;
END $$;

COMMIT;
