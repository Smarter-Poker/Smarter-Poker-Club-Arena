-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830212623; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- force_close_table_and_refund refunded into a pool nothing reads.
--
-- It credited public.wallets, which has been frozen since 2026-08-21 with
-- 732,591,994.33 chips sitting in it (confirmed: that is its exact balance
-- today). The live pool is club_members.chip_balance. So the one function an
-- admin reaches for to give players their money back when a table has to be
-- destroyed would have moved the money somewhere it can never be spent, and
-- reported success.
--
-- It has been called ZERO times, ever — no wallet_transactions row has
-- category 'force_close_refund'. So nothing needs repairing; this is a landmine
-- being removed before someone stands on it, at the worst possible moment,
-- because the moment you force-close a table is a moment something is already
-- wrong.
--
-- Rewritten to use the same refund the ordinary cash-out uses, via
-- fn_cashout_seats_for_closing_table: chips return to the club the SEAT
-- belonged to (falling back to the player's home club, re-creating the
-- membership if it has gone), with a 'cashout' wallet_transactions row that
-- fn_unaccounted_seat_exits recognises. The audit_trail row is kept, and now
-- records what was actually returned.
--
-- HORSES ARE PLAYERS: no is_horse branch. A horse at a force-closed table is
-- paid exactly as a human is.

CREATE OR REPLACE FUNCTION public.force_close_table_and_refund(
  p_table_id uuid,
  p_actor_id uuid DEFAULT NULL,
  p_reason   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_res            jsonb;
  v_total_refunded numeric := 0;
  v_count          integer := 0;
BEGIN
  IF p_table_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'p_table_id required');
  END IF;

  /* Pay every seated player into the LIVE wallet before anything is released.
     Returns immediately for a tournament table, where a stack is not wallet
     money and is settled by the payout structure instead. */
  v_res := public.fn_cashout_seats_for_closing_table(
             p_table_id,
             'force-closed by admin' || COALESCE(' — ' || p_reason, ''));

  IF COALESCE(v_res->>'ok', 'false') <> 'true' THEN
    RETURN jsonb_build_object('success', false, 'error', v_res->>'reason');
  END IF;

  v_count          := COALESCE((v_res->>'players_paid')::int, 0);
  v_total_refunded := COALESCE((v_res->>'chips_returned')::numeric, 0);

  UPDATE public.table_seats SET left_at = NOW()
   WHERE table_id = p_table_id AND left_at IS NULL;

  UPDATE public.tables SET status = 'closed' WHERE id = p_table_id;

  INSERT INTO public.audit_trail
    (actor_id, actor_role, action, target_type, target_id, amount, reason)
  VALUES (p_actor_id, 'platform_admin', 'force_close_table', 'table',
          p_table_id, v_total_refunded, p_reason);

  RETURN jsonb_build_object('success', true,
    'players_refunded', v_count, 'total_refunded', v_total_refunded);
END;
$fn$;
