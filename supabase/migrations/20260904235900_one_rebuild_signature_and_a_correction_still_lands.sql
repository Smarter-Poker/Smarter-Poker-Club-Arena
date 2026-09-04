-- ═══════════════════════════════════════════════════════════════════════════
--  ONE REBUILD SIGNATURE, AND A CORRECTION STILL LANDS
--  Club Operations upgrade, phase 6 of 8. Third correction to 20260904220000.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The previous migration added a three-argument
-- fn_ca_club_rake_daily_rebuild_range(start, end, include_today) and kept the
-- two-argument form beside it "so nothing that already calls it breaks". With
-- the third argument defaulted, a two-argument call matches BOTH:
--
--   ERROR:  function fn_ca_club_rake_daily_rebuild_range(date, date)
--           is not unique
--
-- and the one caller that uses that shape is
-- trg_ca_club_rake_daily_change - the trigger that repairs the rollup when a
-- rake row is UPDATEd or DELETEd. It catches its own errors and warns, so the
-- failure would not have been loud: a rake correction would simply stop being
-- reflected, silently, which is the exact class of defect this phase exists
-- to remove.
--
-- So: one signature, and the change trigger names its intent. A correction to
-- a rake row is precisely when the rollup must follow, so that trigger asks
-- for the day it touched even when that day is today. Rebuilding a live day
-- can lose a slice of whatever commits during the pass (measured: ~21 chips
-- in 194,000 on the busiest club), and the reconcile makes it exact at
-- midnight - but not repairing a correction at all would leave the rollup
-- wrong about a number somebody deliberately changed.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

SET LOCAL lock_timeout = '20s';
SET LOCAL statement_timeout = '0';

DROP FUNCTION IF EXISTS public.fn_ca_club_rake_daily_rebuild_range(date, date);

CREATE OR REPLACE FUNCTION public.trg_ca_club_rake_daily_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_lo date; v_hi date;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Transition tables cannot be combined with a column list, so the
    -- trigger fires on every UPDATE and the filter is here. A hand_id relink
    -- or a metadata touch names no day.
    SELECT min(x.d), max(x.d) INTO v_lo, v_hi
      FROM (
        SELECT (o.created_at AT TIME ZONE 'UTC')::date AS d
          FROM old_rows o JOIN new_rows n ON n.id = o.id
         WHERE o.rake_amount IS DISTINCT FROM n.rake_amount
            OR o.bbj_contribution IS DISTINCT FROM n.bbj_contribution
            OR o.pot_size IS DISTINCT FROM n.pot_size
            OR o.created_at IS DISTINCT FROM n.created_at
            OR o.club_id IS DISTINCT FROM n.club_id
            OR o.table_id IS DISTINCT FROM n.table_id
            OR o.is_tournament IS DISTINCT FROM n.is_tournament
            OR o.player_contributions IS DISTINCT FROM n.player_contributions
        UNION ALL
        SELECT (n.created_at AT TIME ZONE 'UTC')::date
          FROM old_rows o JOIN new_rows n ON n.id = o.id
         WHERE o.rake_amount IS DISTINCT FROM n.rake_amount
            OR o.bbj_contribution IS DISTINCT FROM n.bbj_contribution
            OR o.pot_size IS DISTINCT FROM n.pot_size
            OR o.created_at IS DISTINCT FROM n.created_at
            OR o.club_id IS DISTINCT FROM n.club_id
            OR o.table_id IS DISTINCT FROM n.table_id
            OR o.is_tournament IS DISTINCT FROM n.is_tournament
            OR o.player_contributions IS DISTINCT FROM n.player_contributions
      ) x;
  ELSE
    SELECT min((o.created_at AT TIME ZONE 'UTC')::date), max((o.created_at AT TIME ZONE 'UTC')::date)
      INTO v_lo, v_hi
      FROM old_rows o;
  END IF;
  IF v_lo IS NOT NULL THEN
    -- include_today => true: somebody changed a rake row, and the rollup has
    -- to follow it today, not tomorrow.
    PERFORM public.fn_ca_club_rake_daily_rebuild_range(v_lo, v_hi, true);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'ca_club_rake_daily change rollup failed: %', SQLERRM;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_ca_club_rake_daily_change() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE v_n integer; v_src text;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_club_rake_daily_rebuild_range';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the rebuild still has % signatures; a two-argument call is ambiguous', v_n;
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'trg_ca_club_rake_daily_change'
     AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%fn_ca_club_rake_daily_rebuild_range(v_lo, v_hi, true)%' THEN
    RAISE EXCEPTION 'a rake correction would not reach the rollup on the day it was made';
  END IF;
  -- And the trigger is still attached, all three of them.
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgrelid = 'public.rake_records'::regclass AND tgname LIKE 'trg_ca_club_rake_daily%';
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'expected three rake rollup triggers, found %', v_n;
  END IF;
END $$;

COMMIT;
