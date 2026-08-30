-- ═══════════════════════════════════════════════════════════════════════════
--  THE BOUNTY RESIDUAL IS MEASURED FROM THE LEDGER, NOT FROM A COUNTER
--  (2026-08-29)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- LIVE OVERPAYMENT, FOUND BY CONSERVATION CHECK. Eight mystery bounty events
-- completed in one afternoon paid out MORE than their bounty pool held:
--
--   Evening Mystery Bounty  pool 180.00  paid 191.00   (+11.00)
--   Union Mystery Bounty    pool 420.00  paid 445.00   (+25.00)
--   Evening Mystery Bounty  pool 174.00  paid 192.00   (+18.00)
--   Union Mystery Bounty    pool 420.00  paid 439.00   (+19.00)
--   Evening Mystery Bounty  pool 180.00  paid 189.50   (+9.50)
--   Union Mystery Bounty    pool 420.00  paid 459.00   (+39.00)
--   Evening Mystery Bounty  pool 180.00  paid 189.60   (+9.60)
--   Evening Mystery Bounty  pool 180.00  paid 189.50   (+9.50)
--
-- 140.60 of chips minted in about four hours, and `bounty_pool_paid` agreed
-- with the ledger the whole time -- so the counter was not merely wrong, it
-- had been updated to match the overpayment and nothing objected.
--
-- THE MECHANISM. Taking the 180.00 event apart: 30 entrants x 6.00 = 180.00
-- funded, and the knockers received 180.00 -- the WHOLE pool, correctly, with
-- fn_collect_bounty's cap doing its job. The champion was then paid 11.00 on
-- top as an "unclaimed" residual.
--
-- fn_finalize_bounty_pool computed that residual as
--
--     v_residual := bounty_pool - bounty_pool_paid;
--
-- read under a FOR UPDATE lock on `tournaments`. The lock is real but it
-- protects the wrong thing: `bounty_pool_paid` is a COUNTER that
-- fn_collect_bounty increments as knockouts settle, and finalisation runs
-- while collections are still landing. So it read a stale 169.00, concluded
-- 11.00 was unclaimed, and paid it -- after which the outstanding collections
-- arrived and took the pool to exactly 180.00 anyway.
--
-- THE FIX. The residual is now measured from the LEDGER, which is the only
-- record that cannot be stale relative to the money: sum every `bounty`
-- wallet_transaction already written for this tournament, signed off `type`
-- (a debit is not a payment -- the same rule the tournament payout reconciler
-- learned on 2026-08-28). The residual is what is left of the pool after that,
-- floored at zero.
--
-- This makes OVERPAYMENT IMPOSSIBLE rather than unlikely, whatever order
-- finalisation and collection happen in. It does not by itself guarantee the
-- residual reaches the right player: if finalisation still runs early, the
-- champion is paid a residual that later collections would have claimed, and
-- those knockouts then find the pool empty. That is a SHORTFALL -- visible,
-- correctable, and with the money still inside the pool -- rather than chips
-- created from nothing.
--
-- `bounty_pool_paid` is also reconciled to the ledger here, so the counter
-- stops disagreeing with reality.
--
-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- Restore the previous body: v_residual := bounty_pool - bounty_pool_paid,
-- with no ledger read. That re-opens the overpayment.
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_finalize_bounty_pool(
  p_tournament_id uuid,
  p_winner_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t        record;
  v_residual numeric;
  v_own      numeric;
  v_paid     numeric;
BEGIN
  SELECT id, is_bounty, is_pko, is_mystery_bounty, bounty_pool, bounty_pool_paid
    INTO v_t FROM tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF NOT (COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
          OR COALESCE(v_t.is_mystery_bounty,false)) THEN
    RETURN jsonb_build_object('ok', true, 'residual', 0, 'reason', 'not_a_bounty_tournament');
  END IF;

  IF COALESCE(v_t.bounty_pool, 0) <= 0 THEN
    -- Legacy unfunded event: pay the champion their own remaining head, which
    -- is what the pre-funding-model code did.
    SELECT COALESCE(NULLIF(current_bounty,0), NULLIF(mystery_bounty_value,0), 0)
      INTO v_own FROM tournament_players
     WHERE tournament_id = p_tournament_id AND user_id = p_winner_user_id;
    IF COALESCE(v_own,0) <= 0 OR p_winner_user_id IS NULL THEN
      RETURN jsonb_build_object('ok', true, 'residual', 0, 'funded', false);
    END IF;
    PERFORM public.credit_player_wallet(p_winner_user_id, v_own,
      'tourney:' || p_tournament_id || ':ownbounty:' || p_winner_user_id);
    PERFORM public.log_wallet_transaction(
      p_winner_user_id, 'PLAYER', v_own, 'credit', 'bounty',
      'Tournament champion: own bounty head collected', NULL, NULL, p_tournament_id);
    UPDATE tournament_players
       SET bounty_winnings = round(COALESCE(bounty_winnings,0) + v_own, 2),
           current_bounty = 0
     WHERE tournament_id = p_tournament_id AND user_id = p_winner_user_id;
    RETURN jsonb_build_object('ok', true, 'residual', v_own, 'funded', false,
                              'paid_to', p_winner_user_id);
  END IF;

  /**
   * MEASURED FROM THE LEDGER (2026-08-29). `bounty_pool_paid` is a counter
   * that fn_collect_bounty increments as knockouts settle, and this function
   * runs while collections are still landing -- so reading it produced an
   * "unclaimed" residual for money that was about to be claimed, and paid it
   * to the champion on top of a pool the knockers went on to exhaust.
   *
   * The ledger cannot be stale relative to the money: it IS the money. Signed
   * off `type`, because a corrective debit is not a payment.
   */
  SELECT round(COALESCE(SUM(
           CASE WHEN lower(wt.type) = 'debit' THEN -abs(wt.amount) ELSE wt.amount END
         ), 0), 2)
    INTO v_paid
    FROM wallet_transactions wt
   WHERE wt.related_entity_id = p_tournament_id
     AND wt.category = 'bounty';

  v_residual := round(COALESCE(v_t.bounty_pool,0) - COALESCE(v_paid,0), 2);

  -- Keep the counter honest even when nothing is owed, so the next reader is
  -- not misled the way this function was.
  IF COALESCE(v_t.bounty_pool_paid,0) IS DISTINCT FROM COALESCE(v_paid,0) THEN
    UPDATE tournaments SET bounty_pool_paid = COALESCE(v_paid,0) WHERE id = p_tournament_id;
  END IF;

  IF v_residual <= 0 OR p_winner_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'residual', GREATEST(v_residual,0),
                              'funded', true, 'ledger_paid', v_paid);
  END IF;

  PERFORM public.credit_player_wallet(p_winner_user_id, v_residual,
    'tourney:' || p_tournament_id || ':ownbounty:' || p_winner_user_id);
  PERFORM public.log_wallet_transaction(
    p_winner_user_id, 'PLAYER', v_residual, 'credit', 'bounty',
    'Unclaimed bounty pool awarded to champion', NULL, NULL, p_tournament_id);

  UPDATE tournaments
     SET bounty_pool_paid = round(COALESCE(v_paid,0) + v_residual, 2)
   WHERE id = p_tournament_id;
  UPDATE tournament_players
     SET bounty_winnings = round(COALESCE(bounty_winnings,0) + v_residual, 2),
         current_bounty = 0
   WHERE tournament_id = p_tournament_id AND user_id = p_winner_user_id;

  RETURN jsonb_build_object('ok', true, 'residual', v_residual, 'funded', true,
                            'ledger_paid', v_paid, 'paid_to', p_winner_user_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_finalize_bounty_pool(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_finalize_bounty_pool(uuid, uuid) TO service_role;

DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_finalize_bounty_pool';
  IF position('FROM wallet_transactions wt' in v_def) = 0 THEN
    RAISE EXCEPTION 'the residual is still not measured from the ledger';
  END IF;
END $$;
