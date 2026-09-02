-- ============================================================================
--  A SETTLED CHEST CANNOT BE PAID A SECOND TIME (2026-08-30)
-- ============================================================================
--
--  20260829223000 taught fn_finalize_bounty_pool to measure its residual from
--  the ledger, and 20260830033037 taught the second payer the same lesson.
--  A conservation check run at 03:44 UTC still found two events over pool:
--
--    Saturday Mystery                pool 776.00  paid 783.20   (+7.20)
--    Pre-Dawn Mystery Bounty (PLO5)  pool  30.00  paid  32.60   (+2.60)
--
--  Taking the PLO5 event apart, chest e794df3d is worth 260 cents and it was
--  paid TWICE, ten seconds apart, to the same person:
--
--    03:33:01  "Unclaimed mystery bounty chests awarded to champion"   2.60
--    03:33:11  "Mystery bounty revealed from eliminated player"        2.60
--
--  fn_mystery_bounty_settle sweeps every chest still in 'available',
--  'reserved' or 'revealed' to the champion and marks those chests 'void'.
--  It does NOT touch the AWARD attached to them. So an elimination whose
--  reveal was still in flight kept a live award, fn_mystery_bounty_pay landed
--  moments later, credited the knocker under its own idempotency key
--  ('mb:<award>:<user>' -- a different key from the residual's
--  'mb-residual:<tournament>'), and set the chest back to 'paid'. Two credits,
--  one chest, and neither key could see the other.
--
--  THREE CHANGES, because one of them alone leaves a window open:
--
--   1. SETTLE PAYS WHAT IS ALREADY REVEALED, FIRST. A chest the player has
--      opened belongs to the player who opened it, not to the champion. Those
--      awards are paid inside the settlement transaction, which marks their
--      chests 'paid' and takes them out of the unclaimed sweep entirely.
--
--   2. SETTLE VOIDS THE AWARDS IT SWEEPS. Whatever is still unopened when the
--      event ends goes to the champion, and its award is marked 'void' in the
--      same transaction, so there is nothing left for a late reveal to pay.
--
--   3. THE PAYER REFUSES A SETTLED CHEST. Belt and braces for an award that is
--      mid-flight in another transaction: fn_mystery_bounty_pay now refuses a
--      'void' award and a 'void' chest instead of quietly re-paying it.
--
--  And a floor under all three: the champion residual is CLAMPED to what the
--  funded pool still holds according to the ledger, and clamping raises a
--  critical financial alert. Had that clamp existed at 03:33, the ledger
--  already stood at exactly 30.00 of a 30.00 pool, the residual would have
--  been 0, and the 2.60 would never have been minted.
--
--  ROLLBACK: re-apply the definitions of fn_mystery_bounty_settle and
--  fn_mystery_bounty_pay from the 20260829 mystery-bounty migrations and drop
--  'void' from tournament_bounty_awards_status_check. Rolling back re-opens
--  the double-spend; do not do it to make a test pass.
-- ============================================================================

-- 'void' is a terminal state for an award whose chest was settled to the
-- champion. It is not 'completed': nobody was paid under it.
ALTER TABLE public.tournament_bounty_awards
  DROP CONSTRAINT IF EXISTS tournament_bounty_awards_status_check;
ALTER TABLE public.tournament_bounty_awards
  ADD CONSTRAINT tournament_bounty_awards_status_check
  CHECK (status = ANY (ARRAY['reserved'::text, 'revealed'::text, 'paid'::text,
                             'completed'::text, 'void'::text]));

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_pay(p_award_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_a record; v_r record; v_paid bigint := 0; v_credited boolean; v_refused int := 0;
  v_chest_status text;
BEGIN
  SELECT * INTO v_a FROM public.tournament_bounty_awards WHERE id = p_award_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'award_not_found'); END IF;

  IF v_a.status = 'completed' THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'award_id', p_award_id,
                              'amount_cents', v_a.amount_cents);
  END IF;
  IF v_a.status = 'reserved' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_yet_revealed');
  END IF;

  -- SETTLED IS SETTLED (2026-08-30). fn_mystery_bounty_settle swept this chest
  -- to the champion and voided the award in the same transaction. Paying it
  -- again mints the chest a second time under a different idempotency key --
  -- which is exactly how 2.60 left the PLO5 event ten seconds after it ended.
  IF v_a.status = 'void' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'award_voided_by_settlement',
                              'award_id', p_award_id);
  END IF;

  SELECT status INTO v_chest_status
    FROM public.tournament_bounty_chests WHERE id = v_a.chest_id;
  IF v_chest_status = 'void' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'chest_settled_to_champion',
                              'award_id', p_award_id);
  END IF;

  FOR v_r IN
    SELECT * FROM public.tournament_bounty_award_recipients
     WHERE award_id = p_award_id AND paid_at IS NULL AND amount_cents > 0
     ORDER BY user_id
     FOR UPDATE
  LOOP
    -- fn_credit_and_log is the ONLY way money reaches a wallet. The key makes
    -- the credit itself idempotent, so calling this twice cannot pay twice
    -- even if the paid_at stamp below never lands.
    v_credited := public.fn_credit_and_log(
      v_r.user_id,
      (v_r.amount_cents / 100.0)::numeric,
      'mb:' || p_award_id::text || ':' || v_r.user_id::text,
      'bounty',
      'Mystery bounty revealed from eliminated player',
      v_a.tournament_id
    );

    IF COALESCE(v_credited, false) THEN
      -- PAID MEANS PAID (2026-08-29). This stamp used to sit ABOVE the IF, so
      -- a refused credit was recorded as settled and excluded from the retry
      -- loop above for good -- and fn_mystery_bounty_settle then reported the
      -- event balanced off this same flag.
      UPDATE public.tournament_bounty_award_recipients SET paid_at = now() WHERE id = v_r.id;

      v_paid := v_paid + v_r.amount_cents;
      UPDATE public.tournament_players
         SET bounties_collected = COALESCE(bounties_collected, 0) + 1,
             bounty_winnings = round(COALESCE(bounty_winnings, 0) + (v_r.amount_cents / 100.0), 2)
       WHERE tournament_id = v_a.tournament_id AND user_id = v_r.user_id;

      -- Keep the LEGACY bounty ledger in step: tournament_bounties is what
      -- every existing leaderboard, stat and audit query reads.
      INSERT INTO public.tournament_bounties
        (tournament_id, eliminated_player_id, collector_player_id, bounty_amount, is_mystery_revealed)
      VALUES (v_a.tournament_id, v_a.eliminated_user_id, v_r.user_id,
              (v_r.amount_cents / 100.0)::numeric, true)
      ON CONFLICT (tournament_id, eliminated_player_id, collector_player_id) DO NOTHING;
    ELSE
      -- Left NULL on purpose: the row stays retryable. Counted so the award is
      -- not silently marked complete over a recipient who holds nothing.
      v_refused := v_refused + 1;
    END IF;
  END LOOP;

  IF v_paid > 0 THEN
    -- fn_finalize_bounty_pool settles bounty_pool - bounty_pool_paid to the
    -- champion, so a mystery payment that did not move this number would be
    -- paid twice: once to the knocker and again to the winner as "unclaimed".
    UPDATE public.tournaments
       SET bounty_pool_paid = round(COALESCE(bounty_pool_paid, 0) + (v_paid / 100.0), 2)
     WHERE id = v_a.tournament_id;
  END IF;

  -- An award is only COMPLETE when every recipient was actually credited.
  -- Marking it complete over a refusal would strand that recipient's share.
  IF v_refused = 0 THEN
    UPDATE public.tournament_bounty_awards
       SET status = 'completed', paid_at = now() WHERE id = p_award_id;
    UPDATE public.tournament_bounty_chests SET status = 'paid' WHERE id = v_a.chest_id;
  ELSE
    INSERT INTO financial_alerts (severity, source, message, context)
    VALUES ('critical', 'fn_mystery_bounty_pay',
            'Mystery bounty award left incomplete: a recipient credit was refused',
            jsonb_build_object('award_id', p_award_id,
                               'tournament_id', v_a.tournament_id,
                               'refused_recipients', v_refused,
                               'paid_cents', v_paid,
                               'award_cents', v_a.amount_cents,
                               'detail', 'the award is NOT marked completed and the chest is NOT marked paid, so it stays retryable'));
  END IF;

  RETURN jsonb_build_object('ok', true, 'already', false, 'award_id', p_award_id,
    'amount_cents', v_a.amount_cents, 'paid_cents', v_paid,
    'refused_recipients', v_refused,
    'recipients', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('user_id', user_id, 'amount_cents', amount_cents))
        FROM public.tournament_bounty_award_recipients WHERE award_id = p_award_id), '[]'::jsonb));
END;
$function$;

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

-- NOBODY IN A BROWSER CALLS EITHER OF THESE. Both are SECURITY DEFINER money
-- writers driven by the engine: the engine reveals and pays awards, and the
-- engine settles the event. Production already held exactly these grants --
-- CREATE OR REPLACE preserves an ACL -- and they are restated here so the
-- migration cannot be read as widening them. PUBLIC is named as well as the
-- roles: revoking one role while PUBLIC still holds it reads as a fix and does
-- nothing.
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_pay(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_pay(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.fn_mystery_bounty_settle(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_settle(uuid, uuid) TO service_role;

-- The assumptions this migration is built on, asserted rather than assumed.
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
END
$do$;
