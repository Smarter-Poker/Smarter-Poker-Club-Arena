-- ═══════════════════════════════════════════════════════════════════════════
--  A RECIPIENT IS ONLY "PAID" IF THE CREDIT ACTUALLY MOVED (2026-08-29)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan, 2026-08-29: "THERE CAN NEVER EVER EVER BE MISTAKES WHEN PAYING OUT."
--
-- fn_mystery_bounty_pay did this:
--
--     v_credited := fn_credit_and_log(...);
--     UPDATE tournament_bounty_award_recipients SET paid_at = now() ...;  -- unconditional
--     IF COALESCE(v_credited, false) THEN
--       v_paid := v_paid + v_r.amount_cents;   -- and the ledger/stat writes
--     END IF;
--
-- The stamp landed whether or not the credit did, and the retry loop selects
-- `WHERE paid_at IS NULL`. So a recipient whose credit was refused is marked
-- paid, excluded from every future retry, never increments `bounty_pool_paid`,
-- and never gets a `tournament_bounties` row.
--
-- The second half is what makes it dangerous rather than merely wrong.
-- fn_mystery_bounty_settle computes what was paid from `paid_at IS NOT NULL`
-- -- the very flag just set falsely -- and reports `balanced = (v_paid =
-- v_pool)`. The one check designed to catch a shortfall is fed by the
-- corrupted flag and says the event reconciled exactly while a player received
-- nothing.
--
-- Also fixed here: the award was marked 'completed' and the chest 'paid'
-- unconditionally at the end. Marking an award complete over a refused
-- recipient strands that recipient's share -- the award is never revisited and
-- fn_mystery_bounty_settle sweeps the difference to the champion as
-- "unclaimed". Now it stays retryable and raises a critical alert.
--
-- BLAST RADIUS: tournament_bounty_award_recipients is empty and
-- tournament_bounty_awards has never had a row -- 104 chests built across 27
-- events, every one voided without ever being reserved. This is a fix to a
-- latent defect on a reachable path, not a repair of existing damage.
--
-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- Move the `UPDATE ... SET paid_at = now()` back above the IF and make the
-- award/chest status writes unconditional. Doing so restores the
-- silent-non-payment path.
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_pay(p_award_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_a record; v_r record; v_paid bigint := 0; v_credited boolean; v_refused int := 0;
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

REVOKE ALL ON FUNCTION public.fn_mystery_bounty_pay(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_pay(uuid) TO service_role;

DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_mystery_bounty_pay';
  IF position('IF COALESCE(v_credited, false) THEN' in v_def) = 0 THEN
    RAISE EXCEPTION 'the credited branch is gone';
  END IF;
  IF position('v_refused' in v_def) = 0 THEN
    RAISE EXCEPTION 'a refused credit is not being counted';
  END IF;
END $$;
