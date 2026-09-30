-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260721182804 "settlement_periods_reconcile_one_open_20260721"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a1e67ce6969a9557861d7d12a16417a6 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Task #50: reconcile duplicate open settlement_periods + enforce one-open invariant.
-- Findings (verified live): two rows with status='open' for club a41434bb.
--   P1 21d817b2 (period 1): real data (4719.32 rake, 267k hands) + 1 settlement_invoice
--       + 1 settlement_lock, window ended 2026-03-11 -> a settlement was STARTED but
--       never finalized (still 'open', settled_at null).
--   P2 2fa6fda9 (period 2): empty (0 rake/0 hands), no child rows, window 2026-04-20..27.
-- Resolution: keep P2 as the single canonical open period; close the stuck P1 to
-- 'disputed' (the CHECK-allowed "needs manual reconciliation" status) with a note.

-- 1. Add notes column. The partial-settlement path in SettlementService writes
--    settlement_periods.notes, but the column never existed (latent runtime failure).
ALTER TABLE public.settlement_periods ADD COLUMN IF NOT EXISTS notes text;

-- 2. Close the stuck period (real data preserved; flagged for manual reconciliation).
UPDATE public.settlement_periods
SET status = 'disputed',
    notes = COALESCE(notes || ' | ', '')
      || 'Auto-closed 2026-07-21 during duplicate-open-period reconciliation. '
      || 'Settlement was initiated (settlement_invoice + settlement_lock present) but '
      || 'never finalized; accrued rake (4719.32) + BBJ (259.07) pending manual reconciliation.',
    updated_at = now()
WHERE id = '21d817b2-a416-42c2-843c-e86f7e21325a' AND status = 'open';

-- 3. Enforce one open period per club going forward (NULL club -> sentinel bucket so
--    the club-less get-or-create RPC is also constrained to a single open row).
CREATE UNIQUE INDEX IF NOT EXISTS settlement_periods_one_open_per_club_uidx
ON public.settlement_periods (COALESCE(club_id, '00000000-0000-0000-0000-000000000000'::uuid))
WHERE status = 'open';

-- 4. Harden the get-or-create RPC to be race-safe: after the (conflict-guarded) insert,
--    re-select the open period rather than by the just-generated id, so a lost insert
--    race still returns the winning row instead of an empty result.
CREATE OR REPLACE FUNCTION public.get_current_settlement_period()
 RETURNS TABLE(id uuid, period_start timestamp with time zone, period_end timestamp with time zone, status text, total_rake numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_now timestamptz := now(); v_start timestamptz; v_end timestamptz;
BEGIN
  -- Existing open period wins.
  RETURN QUERY SELECT sp.id, sp.start_at, sp.end_at, sp.status::text, COALESCE(sp.total_rake_collected, 0)
  FROM settlement_periods sp WHERE sp.status = 'open' ORDER BY sp.start_at DESC LIMIT 1;
  IF FOUND THEN RETURN; END IF;

  -- None open: create one. The partial-unique index makes concurrent creates safe.
  v_start := date_trunc('week', v_now) - interval '1 day';
  v_end := v_start + interval '7 days';
  INSERT INTO settlement_periods (id, start_at, end_at, status, total_rake_collected)
  VALUES (gen_random_uuid(), v_start, v_end, 'open', 0)
  ON CONFLICT DO NOTHING;

  -- Re-select the open period (works whether our insert won or a concurrent one did).
  RETURN QUERY SELECT sp.id, sp.start_at, sp.end_at, sp.status::text, COALESCE(sp.total_rake_collected, 0)
  FROM settlement_periods sp WHERE sp.status = 'open' ORDER BY sp.start_at DESC LIMIT 1;
END;
$function$;
