-- ═══════════════════════════════════════════════════════════════════════════
--  fn_admin_platform_aggregates — the admin dashboard stops guessing
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY. src/pages/admin/AnalyticsDashboard.tsx computed its headline numbers in
-- the browser from `.limit(5000)` slices with no ORDER BY, and invented one of
-- them outright:
--
--   * "Total Hands"     — SUM over an arbitrary 5,000 of 5,919
--                         `player_position_stats` rows. True total: 23,027,717.
--   * "Active Players"  — DISTINCT over that same arbitrary slice.
--   * "Total Rake"      — `0.05 * hands_played`. Not rake. A constant times a
--                         truncated hand count, rendered to two decimals.
--                         True all-time rake: 4,791,761.19 across 1,681,381
--                         `rake_records` rows, a table the page never read.
--   * "VIP Diamonds"    — SUM over `diamond_ledger`, which has 0 rows and
--                         always has. The live ledger is `diamond_transactions`.
--
-- Because there was no ORDER BY, the first three could differ between two
-- refreshes a second apart. An operator cannot tell a moving number from a
-- changing business.
--
-- Doing this client-side cannot be fixed by raising the limit: the honest
-- query is an aggregate over 1.68M rake rows, which belongs in the database.
-- One round trip replaces four, and the numbers become reproducible.
--
-- SECURITY. SECURITY DEFINER so it can aggregate across every club's rake
-- without granting the caller table-wide SELECT, gated on the estate's
-- existing `public.fn_is_platform_admin()` (zero-arg, already granted to
-- `authenticated`). A non-admin gets 42501, not an empty result — an empty
-- result would read as "the platform earned nothing".
--
-- HORSES ARE PLAYERS (CLAUDE.md 10.5). `live_players` counts every occupied
-- seat. The page it replaces filtered `.is('horse_id', null)`, which is both a
-- 10.5 exclusion by intent and — because `table_seats.horse_id` is populated
-- on zero rows, horses being identified through `profiles.is_horse` — a filter
-- that removed nothing while reading as though it did. No filter here.
--
-- INDEXES. `idx_rake_records_date` (created_at) already backs the p_since
-- window; nothing new is needed and none is created.
--
-- DDL FOOTPRINT (CLAUDE.md production DDL policy): one CREATE OR REPLACE
-- FUNCTION, so exactly one PostgREST schema reload. The GRANT does not trigger
-- one.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.fn_admin_platform_aggregates(timestamptz);
--   (The page falls back to its own error state; no data is touched. This
--    function only reads.)

DO $$
DECLARE
  v_admin_fn int;
BEGIN
  SELECT count(*) INTO v_admin_fn
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'fn_is_platform_admin' AND p.pronargs = 0;

  IF v_admin_fn <> 1 THEN
    RAISE EXCEPTION
      'PRE-FLIGHT: expected exactly one zero-arg public.fn_is_platform_admin, found %.',
      v_admin_fn;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fn_admin_platform_aggregates(
  p_since timestamptz DEFAULT NULL
)
RETURNS TABLE (
  total_hands    bigint,
  active_players bigint,
  total_rake     numeric,
  vip_diamonds   bigint,
  live_players   bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'not_authorized: platform admin required'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    COALESCE((
      SELECT sum(pps.hands_played)
      FROM public.player_position_stats pps
      WHERE p_since IS NULL OR pps.updated_at >= p_since
    ), 0)::bigint,

    COALESCE((
      SELECT count(DISTINCT pps.user_id)
      FROM public.player_position_stats pps
      WHERE p_since IS NULL OR pps.updated_at >= p_since
    ), 0)::bigint,

    -- The real ledger, not 0.05 * hands.
    COALESCE((
      SELECT sum(rr.rake_amount)
      FROM public.rake_records rr
      WHERE p_since IS NULL OR rr.created_at >= p_since
    ), 0)::numeric,

    -- Diamonds AWARDED in the window (positive movements only); spends are not
    -- netted off, because this tile answers "how many did we issue", and a
    -- netted figure silently shrinks when players spend what they earned.
    COALESCE((
      SELECT sum(dt.amount)
      FROM public.diamond_transactions dt
      WHERE dt.amount > 0
        AND (p_since IS NULL OR dt.created_at >= p_since)
    ), 0)::bigint,

    -- Every occupied seat. Horses included, deliberately — see 10.5 above.
    COALESCE((
      SELECT count(*)
      FROM public.table_seats ts
      WHERE ts.status = 'active' AND ts.left_at IS NULL
    ), 0)::bigint;
END $$;

COMMENT ON FUNCTION public.fn_admin_platform_aggregates(timestamptz) IS
  'Platform-wide admin metrics in one round trip. Replaces four browser-side '
  'reductions over unordered .limit(5000) slices, one of which (rake) was '
  '0.05 * hands rather than rake, and one of which (diamonds) read the '
  'permanently empty diamond_ledger. Admin-gated; counts horses as players '
  'per CLAUDE.md 10.5.';

REVOKE ALL ON FUNCTION public.fn_admin_platform_aggregates(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_admin_platform_aggregates(timestamptz) TO authenticated;

DO $$
DECLARE
  v_secdef boolean;
  v_grant  boolean;
BEGIN
  SELECT p.prosecdef INTO v_secdef
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'fn_admin_platform_aggregates';

  IF NOT COALESCE(v_secdef, false) THEN
    RAISE EXCEPTION 'POST-APPLY: fn_admin_platform_aggregates is not SECURITY DEFINER.';
  END IF;

  SELECT has_function_privilege(
    'authenticated', 'public.fn_admin_platform_aggregates(timestamptz)', 'EXECUTE'
  ) INTO v_grant;

  IF NOT v_grant THEN
    RAISE EXCEPTION 'POST-APPLY: authenticated cannot EXECUTE fn_admin_platform_aggregates.';
  END IF;
END $$;
