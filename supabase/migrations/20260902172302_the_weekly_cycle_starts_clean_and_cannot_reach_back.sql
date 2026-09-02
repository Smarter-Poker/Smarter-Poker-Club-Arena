-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902172302; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- Dan 2026-09-02, asked whether the three unsettled weeks (2026-08-17, 08-24,
-- 08-31) should be settled as they stand, back-attributed first, or skipped:
-- "start clean with the first week."
--
-- Rake attribution only became correct at 2026-09-02 17:13 UTC (see
-- rake_is_earned_by_the_players_club_not_the_table_owner). Weeks here run
-- Monday to Monday, so the current week 2026-08-31 is half mis-attributed and
-- the first FULLY clean week is 2026-09-07 to 2026-09-14. That is the floor.
--
-- WHY A FLOOR IS NEEDED AT ALL, rather than just not running the settler:
-- fn_union_weekly_rakeback_close_all does not take a period. It reads
-- MAX(period_end) from union_rakeback_log as its cursor - currently
-- 2026-08-17, the last close that ran - and then walks forward one week at a
-- time closing everything up to the current week. So the very first time
-- anyone runs it, with no floor, it would close 08-17 and 08-24 on the old
-- all-to-the-union basis, which is exactly the outcome Dan ruled out. The
-- danger is in the resume logic, not in anybody's intent.
--
-- The floor is DATA, not a hard-coded date, so Dan can move it without a code
-- change and so the reason travels with it.
--
-- Two guards, because they fail differently:
--   1. fn_union_weekly_rakeback_close_all starts its cursor no earlier than
--      the floor. This is what protects the scheduled path.
--   2. fn_union_weekly_rakeback_close refuses any period starting before the
--      floor outright. This is what protects a direct call - an agent or an
--      operator closing a single week by hand, which bypasses the cursor
--      entirely.
--
-- SEPARATELY, AND MORE IMPORTANTLY: settlement is currently FROZEN. Three
-- GLOBAL_SETTLEMENT_FREEZE locks (one per club) were set 2026-08-26 13:38 UTC
-- with reason "EMERGENCY: PROFIT DRIFT INVESTIGATION" and unlock_at 2099-01-01.
-- They are still active and the drift they were raised for is still firing
-- today - hourly ledger imbalance incidents, and six tournaments in the last
-- 24h that paid out more than their prize pool. This migration does NOT touch
-- those locks. It only makes sure that when they are eventually lifted, the
-- cycle resumes at the right week instead of reaching backwards.
--
-- ROLLBACK:
--   DELETE FROM public.union_settlement_floor
--    WHERE union_id = 'fade0000-0000-0000-0000-000000000001';
--   -- (the two function guards are no-ops with no floor row present, so the
--   --  delete alone restores the previous behaviour; drop the table too if
--   --  the concept is being abandoned)
--
CREATE TABLE IF NOT EXISTS public.union_settlement_floor (
  union_id              uuid PRIMARY KEY REFERENCES public.unions(id) ON DELETE CASCADE,
  earliest_period_start timestamptz NOT NULL,
  reason                text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.union_settlement_floor IS
  'Earliest week a union may settle. Guards the weekly rakeback close and its resume cursor so a period before the floor can never be closed. One row per union; absent means no floor.';

INSERT INTO public.union_settlement_floor (union_id, earliest_period_start, reason)
VALUES (
  'fade0000-0000-0000-0000-000000000001',
  timestamptz '2026-09-07 00:00:00+00',
  'Dan 2026-09-02: start clean with the first week. Rake attribution became correct at 2026-09-02 17:13 UTC, so 2026-09-07 is the first fully clean Monday-to-Monday week. The weeks of 08-17, 08-24 and 08-31 are deliberately never settled - they would pay out on the old basis, which credited the union-as-a-club and zero to the member clubs.'
)
ON CONFLICT (union_id) DO UPDATE
  SET earliest_period_start = EXCLUDED.earliest_period_start,
      reason = EXCLUDED.reason;

DO $mig$
DECLARE
  v_def text;
  v_new text;
  v_ok  int;
BEGIN
  -- GUARD 1: the resume cursor never starts before the floor.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_union_weekly_rakeback_close_all';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fn_union_weekly_rakeback_close_all not found';
  END IF;

  v_new := replace(v_def, '    v_guard := 0;',
    '    -- Never resume before the union''s settlement floor. GREATEST ignores' || chr(10) ||
    '    -- NULLs, so a union with no floor row is unaffected.' || chr(10) ||
    '    v_cursor := GREATEST(v_cursor, (SELECT f.earliest_period_start' || chr(10) ||
    '                                      FROM public.union_settlement_floor f' || chr(10) ||
    '                                     WHERE f.union_id = v_union.id));' || chr(10) || chr(10) ||
    '    v_guard := 0;');
  IF v_new = v_def THEN
    RAISE EXCEPTION 'close_all anchor not found - refusing to patch';
  END IF;
  EXECUTE v_new;

  -- GUARD 2: a direct call for a pre-floor period is refused.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_union_weekly_rakeback_close';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fn_union_weekly_rakeback_close not found';
  END IF;

  v_new := replace(v_def,
    '  IF EXISTS (' || chr(10) || '    SELECT 1 FROM union_rakeback_log',
    '  IF EXISTS (SELECT 1 FROM public.union_settlement_floor f' || chr(10) ||
    '              WHERE f.union_id = p_union_id' || chr(10) ||
    '                AND p_period_start < f.earliest_period_start) THEN' || chr(10) ||
    '    RETURN jsonb_build_object(''success'', false, ''error'', ''before_settlement_floor'');' || chr(10) ||
    '  END IF;' || chr(10) || chr(10) ||
    '  IF EXISTS (' || chr(10) || '    SELECT 1 FROM union_rakeback_log');
  IF v_new = v_def THEN
    RAISE EXCEPTION 'close anchor not found - refusing to patch';
  END IF;
  EXECUTE v_new;

  SELECT count(*) INTO v_ok
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('fn_union_weekly_rakeback_close', 'fn_union_weekly_rakeback_close_all')
     AND p.prosrc LIKE '%union_settlement_floor%';
  IF v_ok <> 2 THEN
    RAISE EXCEPTION 'post-apply check failed: expected both functions guarded, got %', v_ok;
  END IF;

  RAISE NOTICE 'settlement floor active: Midway Union cannot settle before 2026-09-07';
END $mig$;
