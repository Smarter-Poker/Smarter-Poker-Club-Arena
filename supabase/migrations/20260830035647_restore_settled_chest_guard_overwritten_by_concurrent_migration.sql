-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830035647; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- RESTORE fn_mystery_bounty_settle TO THE BRANCH DEFINITION (2026-08-30)
--
-- Two agents diagnosed the same live overpayment within minutes of each other
-- and both wrote a fix for fn_mystery_bounty_settle:
--
--   20260830035009  a_settled_chest_cannot_be_paid_a_second_time   (branch, better)
--   20260830035124  a_chest_with_a_reveal_in_flight_is_not_unclaimed (mine, applied second)
--
-- Mine landed 75 seconds later and its CREATE OR REPLACE silently overwrote
-- theirs. Nothing was double-paid by the mixed state -- my version simply
-- declined to sweep in-flight chests -- but it under-distributed them and it
-- dropped the award-voiding half of their design, while their
-- fn_mystery_bounty_pay guard (which I never touched) stayed live. The
-- database therefore disagreed with the migration the repo believes in.
--
-- Theirs is the better fix and is the one committed to the pull request, so it
-- wins: it PAYS the revealed awards inside the settlement transaction rather
-- than alerting about them, and it voids the award and the chest together so a
-- reveal still in flight cannot mint the chest again.
--
-- This restores their definition verbatim. My migration is withdrawn.
--
-- ROLLBACK: none wanted. Reverting re-opens the under-distribution.

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_settle(p_tournament_id uuid, p_winner_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pool bigint; v_paid bigint; v_unclaimed bigint; v_stage text;
  v_award record;
  v_funded numeric; v_ledger numeric;
  v_room bigint; v_residual bigint;
BEGIN
  SELECT mystery_bounty_stage, COALESCE(mystery_bounty_pool_cents, 0), COALESCE(bounty_pool, 0)
    INTO v_stage, v_pool, v_funded
    FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;
  IF v_stage = 'pending' THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'never_activated', 'unclaimed_cents', 0,
                              'pool_cents', 0, 'settled_cents', 0, 'balanced', true, 'variance_cents', 0);
  END IF;

  -- AN OPENED CHEST BELONGS TO WHOEVER OPENED IT (2026-08-30). A reveal that
  -- landed just before the event ended used to leave a live award behind while
  -- the sweep below paid the same chest to the champion. Pay it here, inside
  -- the settlement transaction: that marks the chest 'paid' and takes it out
  -- of the unclaimed set, so the two payers can no longer both see it.
  FOR v_award IN
    SELECT id FROM public.tournament_bounty_awards
     WHERE tournament_id = p_tournament_id AND status = 'revealed'
     ORDER BY id
     FOR UPDATE
  LOOP
    PERFORM public.fn_mystery_bounty_pay(v_award.id);
  END LOOP;

  SELECT COALESCE(sum(r.amount_cents), 0) INTO v_paid
    FROM public.tournament_bounty_award_recipients r
    JOIN public.tournament_bounty_awards a ON a.id = r.award_id
   WHERE a.tournament_id = p_tournament_id AND r.paid_at IS NOT NULL;

  SELECT COALESCE(sum(amount_cents), 0) INTO v_unclaimed
    FROM public.tournament_bounty_chests
   WHERE tournament_id = p_tournament_id AND status IN ('available','reserved','revealed');

  v_residual := v_unclaimed;

  -- THE RESIDUAL CANNOT EXCEED WHAT THE POOL STILL HOLDS. Measured from the
  -- ledger for the same reason fn_finalize_bounty_pool measures from it: the
  -- ledger cannot be stale relative to the money, because it IS the money.
  IF v_residual > 0 AND v_funded > 0 THEN
    SELECT round(COALESCE(SUM(
             CASE WHEN lower(wt.type) = 'debit' THEN -abs(wt.amount) ELSE wt.amount END
           ), 0), 2)
      INTO v_ledger
      FROM wallet_transactions wt
     WHERE wt.related_entity_id = p_tournament_id
       AND wt.category = 'bounty';

    v_room := GREATEST(0, floor((v_funded - COALESCE(v_ledger, 0)) * 100))::bigint;

    IF v_residual > v_room THEN
      INSERT INTO financial_alerts (severity, source, message, context)
      VALUES ('critical', 'fn_mystery_bounty_settle',
              'Champion residual clamped: the unclaimed chests are worth more than the bounty pool still holds',
              jsonb_build_object('tournament_id', p_tournament_id,
                                 'unclaimed_cents', v_unclaimed,
                                 'room_cents', v_room,
                                 'ledger_paid', v_ledger,
                                 'bounty_pool', v_funded,
                                 'detail', 'the clamp is not the bug, it is the seatbelt -- find the payer that already spent the pool'));
      v_residual := v_room;
    END IF;
  END IF;

  IF p_winner_user_id IS NOT NULL THEN
    IF v_residual > 0 THEN
      -- UNCLAIMED CHESTS GO TO THE CHAMPION. The last player standing was never
      -- knocked out, so their own chest - and any chest a broken elimination
      -- left behind - is theirs. The idempotency key is the tournament, so a
      -- re-run cannot pay it twice.
      PERFORM public.fn_credit_and_log(
        p_winner_user_id, (v_residual / 100.0)::numeric,
        'mb-residual:' || p_tournament_id::text,
        'bounty', 'Unclaimed mystery bounty chests awarded to champion',
        p_tournament_id);
      UPDATE public.tournament_players
         SET bounty_winnings = round(COALESCE(bounty_winnings, 0) + (v_residual / 100.0), 2)
       WHERE tournament_id = p_tournament_id AND user_id = p_winner_user_id;
      UPDATE public.tournaments
         SET bounty_pool_paid = round(COALESCE(bounty_pool_paid, 0) + (v_residual / 100.0), 2)
       WHERE id = p_tournament_id;
      v_paid := v_paid + v_residual;
    END IF;

    -- NOTHING MAY PAY THESE CHESTS AFTER THIS POINT. The award is voided in the
    -- same transaction as the sweep, and fn_mystery_bounty_pay refuses a voided
    -- award, so a reveal still in flight cannot mint the chest a second time.
    UPDATE public.tournament_bounty_awards a
       SET status = 'void'
     WHERE a.tournament_id = p_tournament_id
       AND a.status <> 'completed'
       AND EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                    WHERE c.id = a.chest_id
                      AND c.status IN ('available','reserved','revealed'));

    UPDATE public.tournament_bounty_chests SET status = 'void'
     WHERE tournament_id = p_tournament_id AND status IN ('available','reserved','revealed');
  END IF;

  UPDATE public.tournaments SET mystery_bounty_stage = 'complete' WHERE id = p_tournament_id;

  RETURN jsonb_build_object('ok', true,
    'pool_cents', v_pool, 'settled_cents', v_paid, 'unclaimed_cents', v_unclaimed,
    'residual_paid_cents', v_residual,
    'balanced', v_paid = v_pool,
    'variance_cents', v_paid - v_pool);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_mystery_bounty_settle(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_settle(uuid, uuid) TO service_role;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tournament_bounty_awards_status_check'
       AND pg_get_constraintdef(oid) LIKE '%void%'
  ) THEN
    RAISE EXCEPTION 'tournament_bounty_awards_status_check does not admit void';
  END IF;

  IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'fn_mystery_bounty_pay')
       NOT LIKE '%award_voided_by_settlement%' THEN
    RAISE EXCEPTION 'fn_mystery_bounty_pay still pays a voided award';
  END IF;

  IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'fn_mystery_bounty_settle')
       NOT LIKE '%fn_mystery_bounty_pay%' THEN
    RAISE EXCEPTION 'fn_mystery_bounty_settle no longer pays revealed awards before sweeping';
  END IF;

  IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'fn_mystery_bounty_settle')
       LIKE '%v_cap := GREATEST(v_pool - v_paid - v_inflight%' THEN
    RAISE EXCEPTION 'the overwriting definition is still live - the restore did not take';
  END IF;
END
$do$;
