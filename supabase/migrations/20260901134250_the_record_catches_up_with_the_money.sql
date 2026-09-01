-- ═══════════════════════════════════════════════════════════════════════════
--  THE RECORD CATCHES UP WITH THE MONEY (2026-09-01)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 73 completed events paid 5,677.21 chips of prizes into player wallets and
-- never wrote them to tournament_payouts. Nobody is short: the money moved.
-- The record is what did not.
--
-- WHY THAT IS DANGEROUS AND NOT MERELY UNTIDY. fn_tournament_payout_reconcile
-- decides what an event still owes by summing tournament_payouts for the holder
-- of each place, and it only counts the sources it recognises:
--
--   structure, reconcile, hu_shortfall, late_reg_adjustment,
--   clawback, final_table_deal, spin_backpay
--
-- It falls back to the ledger ONLY when an event has no payout record at all.
-- Every one of these 73 has a PARTIAL record, which is the worst case: the
-- fallback does not trigger, the sum comes up short, and the reconciler
-- concludes the event still owes money it has already paid. Today it concludes
-- exactly that for 5,315.41 chips. The only thing that has stopped a second
-- payment is that those pools cannot back one - luck, not a safety property,
-- and 20260901140000 added a conservation guard so it stops being luck.
--
-- This migration removes the cause instead of guarding it: it reconstructs the
-- missing rows from wallet_transactions, per player, for the exact difference.
--
-- IT MOVES NO MONEY. Not one credit, not one debit. The only writes are rows in
-- tournament_payouts describing payments that already happened.
--
-- SOURCE IS 'structure', NOT 'ledger_backfill'. These were structure prizes,
-- and the reconciler's source filter above is a closed list - a row under any
-- name it does not know would be invisible to it, which would leave the phantom
-- debt exactly where it was. recorded_by carries the provenance instead.
--
-- ROLLBACK
--   DELETE FROM public.tournament_payouts
--    WHERE recorded_by = 'ledger_backfill_20260901';

DO $backfill$
DECLARE
  v_rows integer := 0;
  v_chips numeric := 0;
  v_events integer := 0;
  v_before numeric;
  v_after numeric;
BEGIN
  SELECT count(*), COALESCE(round(sum(gap), 2), 0) INTO v_events, v_before
    FROM (
      SELECT t.id,
             COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
                        WHERE w.related_entity_id = t.id AND w.type='credit'
                          AND w.category='prize'), 0)
           - COALESCE((SELECT sum(p.amount) FROM public.tournament_payouts p
                        WHERE p.tournament_id = t.id
                          AND p.source IN ('structure','reconcile','hu_shortfall',
                                           'late_reg_adjustment','clawback',
                                           'final_table_deal','spin_backpay')), 0) AS gap
        FROM public.tournaments t
       WHERE t.status='COMPLETED' AND COALESCE(t.prize_pool,0) > 0
    ) g
   WHERE g.gap > 0.01;

  WITH per_user AS (
    SELECT t.id AS tournament_id, w.user_id,
           round(sum(w.amount), 2) AS credited,
           max(w.created_at) AS last_credit
      FROM public.tournaments t
      JOIN public.wallet_transactions w
        ON w.related_entity_id = t.id AND w.type='credit' AND w.category='prize'
     WHERE t.status='COMPLETED' AND COALESCE(t.prize_pool,0) > 0
     GROUP BY t.id, w.user_id
  ), gap AS (
    SELECT pu.*,
           COALESCE((SELECT round(sum(p.amount), 2) FROM public.tournament_payouts p
                      WHERE p.tournament_id = pu.tournament_id
                        AND p.user_id = pu.user_id
                        AND p.source IN ('structure','reconcile','hu_shortfall',
                                         'late_reg_adjustment','clawback',
                                         'final_table_deal','spin_backpay')), 0) AS recorded
      FROM per_user pu
  )
  INSERT INTO public.tournament_payouts
    (tournament_id, user_id, "position", amount, source, idempotency_key,
     paid_at, tournament_type, field_size, prize_pool, recorded_by)
  SELECT g.tournament_id, g.user_id,
         (SELECT tp."position" FROM public.tournament_players tp
           WHERE tp.tournament_id = g.tournament_id AND tp.user_id = g.user_id),
         round(g.credited - g.recorded, 2),
         'structure',
         'ledgerbackfill:' || g.tournament_id::text || ':' || g.user_id::text,
         g.last_credit,
         t.tournament_type,
         (SELECT count(*) FROM public.tournament_players tp
           WHERE tp.tournament_id = g.tournament_id),
         t.prize_pool,
         'ledger_backfill_20260901'
    FROM gap g
    JOIN public.tournaments t ON t.id = g.tournament_id
   WHERE g.credited - g.recorded > 0.005
  ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  SELECT COALESCE(round(sum(amount), 2), 0) INTO v_chips
    FROM public.tournament_payouts
   WHERE recorded_by = 'ledger_backfill_20260901';

  SELECT COALESCE(round(sum(gap), 2), 0) INTO v_after
    FROM (
      SELECT COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
                        WHERE w.related_entity_id = t.id AND w.type='credit'
                          AND w.category='prize'), 0)
           - COALESCE((SELECT sum(p.amount) FROM public.tournament_payouts p
                        WHERE p.tournament_id = t.id
                          AND p.source IN ('structure','reconcile','hu_shortfall',
                                           'late_reg_adjustment','clawback',
                                           'final_table_deal','spin_backpay')), 0) AS gap
        FROM public.tournaments t
       WHERE t.status='COMPLETED' AND COALESCE(t.prize_pool,0) > 0
    ) g
   WHERE g.gap > 0.01;

  RAISE NOTICE 'ledger backfill: % event(s) short % chips before, % row(s) written for % chips, % chips short after',
    v_events, v_before, v_rows, v_chips, v_after;

  IF v_after > 0.01 THEN
    RAISE EXCEPTION 'the record is still % chips behind the ledger after the backfill', v_after;
  END IF;
END
$backfill$;
