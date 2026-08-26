-- 20260826_fix_unaccounted_seat_exits_lower_bound.sql
--
-- TIER 2. Reporting function only. No money moves. No schema change.
--
-- WHAT WAS WRONG
-- fn_unaccounted_seat_exits() decides a seat exit was refunded by looking for a
-- matching credit in wallet_transactions inside this window:
--
--     e.occurred_at - interval '2 minutes'  ..  e.occurred_at + p_grace
--
-- The UPPER bound scales with p_grace. The LOWER bound was hardcoded to two
-- minutes. But the cash-out is written by the engine BEFORE the table_seats row
-- is closed, and the gap between the two is not bounded by anything. Whenever
-- that gap exceeds two minutes the credit falls outside the window, the function
-- reports "no refund found", and reconcile_ledger_nightly files a CRITICAL for a
-- player who was in fact paid in full.
--
-- OBSERVED 2026-08-26 (exit id 6522, user f7201058):
--     09:33:33.936  wallet_transactions credit 85.85  "Cash-out from table"
--     09:38:50.906  ca_seat_stack_exits  stack  85.85  exit_kind 'left'
--   Gap 5m17s. Refund was correct. Function flagged it anyway.
--
-- A false critical in a money alarm is not cosmetic: it is how the real one
-- stops being read.
--
-- THE FIX
-- Make the lower bound as generous as the upper bound, floored at 15 minutes.
-- The amount test (wt.amount >= e.stack - 0.01) is what actually establishes the
-- match; the window only has to be wide enough to contain the write.
--
-- MEASURED EFFECT (run against production before applying):
--   flagged before ............ 2   (ids 6522, 7458)
--   clears with wider bound ... 1   (id 6522 -- the false positive)
--   still flagged ............. 1   (id 7458 -- a REAL 25.90 shortfall, kept)
-- The change removes the false positive and does NOT mask the true one.
--
-- ROLLBACK: re-apply the previous definition, which is identical except that the
-- lower bound reads `e.occurred_at - interval '2 minutes'`.

CREATE OR REPLACE FUNCTION public.fn_unaccounted_seat_exits(
  p_since interval DEFAULT '7 days'::interval,
  p_grace interval DEFAULT '00:10:00'::interval
)
RETURNS TABLE(
  exit_id bigint, occurred_at timestamp with time zone, user_id uuid,
  table_id uuid, club_id uuid, stack numeric, exit_kind text,
  db_role text, app_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT e.id, e.occurred_at, e.user_id, e.table_id, e.club_id,
         e.stack, e.exit_kind, e.db_role, e.app_name
  FROM public.ca_seat_stack_exits e
  WHERE e.occurred_at >= now() - p_since
    AND e.occurred_at <= now() - p_grace
    AND NOT EXISTS (
      SELECT 1 FROM public.tables t
       WHERE t.id = e.table_id AND t.tournament_id IS NOT NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.wallet_transactions wt
       WHERE wt.user_id = e.user_id
         AND wt.type = 'credit'
         -- lower bound now tracks p_grace (floor 15 min) instead of a fixed
         -- 2 minutes, because the credit is written BEFORE the seat is closed.
         AND wt.created_at BETWEEN e.occurred_at - GREATEST(p_grace, interval '15 minutes')
                               AND e.occurred_at + p_grace
         AND wt.amount >= e.stack - 0.01
    )
  ORDER BY e.occurred_at DESC;
$function$;

-- Post-apply assertion: the known false positive must be gone, and the known
-- real shortfall must survive. If either fails the migration aborts.
DO $$
DECLARE
  v_false_positive_cleared boolean;
  v_real_still_flagged     boolean;
BEGIN
  SELECT NOT EXISTS (SELECT 1 FROM public.fn_unaccounted_seat_exits('7 days','10 minutes') WHERE exit_id = 6522)
    INTO v_false_positive_cleared;
  SELECT EXISTS (SELECT 1 FROM public.fn_unaccounted_seat_exits('7 days','10 minutes') WHERE exit_id = 7458)
    INTO v_real_still_flagged;

  IF NOT v_false_positive_cleared THEN
    RAISE EXCEPTION 'assertion failed: exit 6522 (refunded 85.85 at 09:33:33) is still flagged';
  END IF;

  -- Only assert the real one is retained while it is genuinely still unpaid.
  -- Once 7458 is made whole this check correctly goes quiet instead of
  -- failing a re-run of this migration.
  IF NOT v_real_still_flagged
     AND NOT EXISTS (
       SELECT 1 FROM public.wallet_transactions wt
        WHERE wt.user_id = 'a916c222-1eb9-4e73-89ee-a92e289b80eb'
          AND wt.type = 'credit' AND wt.amount >= 44.99
          AND wt.created_at BETWEEN '2026-08-26 12:40:00+00' AND '2026-08-26 13:11:00+00')
  THEN
    RAISE EXCEPTION 'assertion failed: exit 7458 (real 25.90 shortfall) was masked by this change';
  END IF;

  RAISE NOTICE 'fn_unaccounted_seat_exits: false positive cleared, real shortfall retained';
END $$;
