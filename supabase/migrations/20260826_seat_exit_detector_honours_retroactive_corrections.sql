-- 20260826_seat_exit_detector_honours_retroactive_corrections.sql
--
-- TIER 2. Reporting function only. No money moves.
--
-- WHY
-- fn_unaccounted_seat_exits() clears an exit when it finds a matching credit
-- inside a window around the exit. That is right for the normal case: the engine
-- writes the cash-out within seconds of closing the seat.
--
-- It is wrong for a REPAIR. When a shortfall is discovered hours or days later
-- and paid back by migration, the correcting credit is nowhere near the exit
-- timestamp, so the exit stays flagged forever even though the player has been
-- made whole. That was exactly the state after
-- 20260826_repay_seat_exit_7458_addon_shortfall: 25.90 repaid, balance verified
-- 50956.04 -> 50981.94, and the alarm still reporting the exit as unaccounted.
--
-- An alarm that keeps firing after the thing it is about has been fixed trains
-- people to ignore it, which is the same failure the lower-bound fix earlier
-- today was about.
--
-- THE CONVENTION
-- A credit whose description begins 'Correction: seat exit <id>' settles that
-- exit, whenever it was written. Any future repayment migration must use that
-- prefix for the exit to fall silent.
--
-- ROLLBACK: re-apply the previous definition, which is identical minus the third
-- NOT EXISTS block.

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
         AND wt.created_at BETWEEN e.occurred_at - GREATEST(p_grace, interval '15 minutes')
                               AND e.occurred_at + p_grace
         AND wt.amount >= e.stack - 0.01
    )
    -- A retroactive repair settles the exit whenever it was written.
    AND NOT EXISTS (
      SELECT 1 FROM public.wallet_transactions wt
       WHERE wt.user_id = e.user_id
         AND wt.type = 'credit'
         AND wt.description ILIKE 'Correction: seat exit ' || e.id || '%'
    )
  ORDER BY e.occurred_at DESC;
$function$;

DO $$
DECLARE v_left int; v_ids text;
BEGIN
  SELECT count(*), coalesce(string_agg(exit_id::text, ','), 'none')
    INTO v_left, v_ids
    FROM public.fn_unaccounted_seat_exits('7 days','10 minutes');

  IF EXISTS (SELECT 1 FROM public.fn_unaccounted_seat_exits('7 days','10 minutes') WHERE exit_id = 7458) THEN
    RAISE EXCEPTION 'assertion failed: exit 7458 was repaid but is still flagged';
  END IF;

  RAISE NOTICE 'fn_unaccounted_seat_exits: % unaccounted exit(s) remain (%)', v_left, v_ids;
END $$;
