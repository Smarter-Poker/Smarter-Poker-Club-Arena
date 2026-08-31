-- ═══════════════════════════════════════════════════════════════════════════
-- THE RAKE ROW NO TABLE CAN MATCH — delete ca_rake_schedule (sb 5, bb 5)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT IT IS. public.ca_rake_schedule carried a row (sb = 5, bb = 5,
-- rake_percent 10, rake_cap 7.50, bbj_fee_bb 0.12, source 'engine_mirror'),
-- seeded by 20260831140000_the_rake_law_gets_an_alarm.sql as a mirror of the
-- RAKE_SCHEDULE array in src/config/RakeConfig.ts and its server twin.
--
-- WHY IT GOES. Nothing can ever match it, and nothing ever did:
--
--   * ca_rake_schedule prices CASH tables only, and the creation guard
--     trg_tables_creation_guard -> fn_tables_creation_guard raises
--     'big blind must exceed small blind' for a cash table. A 5/5 cash table
--     cannot be created, so the row can never be read for a real table.
--   * Zero live tables at 5/5, and zero hands have ever been priced by it.
--   * src/config/blindsPresets.ts offers no 5/5 preset.
--   * It sorted out of order in the source array, between 2/5 and 3/6 — the
--     tell that it was a typo entered by big blind (2/5, then 5/5 where 5/10
--     belongs, then 3/6).
--
-- Dan ruled it a typo. It is DELETED, not legalised: bb = sb stays illegal for
-- a cash table and this migration does not touch the creation guard.
--
-- WHAT CHANGES OBSERVABLY. Nothing that anything can ask. findScheduleMatch
-- (server/src/config/RakeConfig.ts) requires an exact sb/bb match, so no live
-- table's price moves. The only difference is hypothetical:
-- fn_effective_rake_cap(5, 5) returned 7.50 from this row and will now return
-- 8.00 from the 'mid' tier — a question no table can pose.
--
-- LANDED WITH the same row removed from both source copies in the same commit,
-- because scripts/ci/check-rake-schedule-parity.mjs is blocking and compares
-- the client and server arrays entry for entry:
--   src/config/RakeConfig.ts
--   server/src/config/RakeConfig.ts
--
-- IDEMPOTENT: the DELETE is a no-op on a second run, and the CHECK constraint
-- is added only if it is not already there.
--
-- ROLLBACK (Tier 3 — this removes a priced row):
--   ALTER TABLE public.ca_rake_schedule
--     DROP CONSTRAINT IF EXISTS ca_rake_schedule_bb_exceeds_sb;
--   INSERT INTO public.ca_rake_schedule (sb, bb, rake_percent, rake_cap, bbj_fee_bb, source)
--   VALUES (5, 5, 10, 7.5, 0.12, 'engine_mirror')
--   ON CONFLICT (sb, bb) DO NOTHING;

BEGIN;

SET LOCAL lock_timeout = '4s';

DELETE FROM public.ca_rake_schedule WHERE sb = 5 AND bb = 5;

-- The seed in 20260831140000 is re-runnable (INSERT ... ON CONFLICT DO UPDATE),
-- so on its own the DELETE above could be silently undone by anyone replaying
-- that file out of order. This constraint makes that impossible: a re-seed
-- carrying the 5/5 row now FAILS LOUDLY instead of resurrecting a stake no
-- table can have. A clean ordered replay is unaffected — 20260831140000 runs
-- and inserts before this file exists, and this file then deletes and locks.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.ca_rake_schedule'::regclass
       AND conname  = 'ca_rake_schedule_bb_exceeds_sb'
  ) THEN
    ALTER TABLE public.ca_rake_schedule
      ADD CONSTRAINT ca_rake_schedule_bb_exceeds_sb CHECK (bb > sb);
  END IF;
END $$;

COMMENT ON CONSTRAINT ca_rake_schedule_bb_exceeds_sb ON public.ca_rake_schedule IS
  'Cash tables require big blind > small blind (fn_tables_creation_guard). A schedule row that breaks it can never price a hand, so it is a typo by definition. Added 2026-09-01 with the deletion of the 5/5 row.';

-- ── Post-apply assertions ──
DO $$
DECLARE
  v_bad int;
BEGIN
  SELECT count(*) INTO v_bad FROM public.ca_rake_schedule WHERE sb = 5 AND bb = 5;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'the 5/5 rake schedule row is still present (% row(s))', v_bad;
  END IF;

  SELECT count(*) INTO v_bad FROM public.ca_rake_schedule WHERE bb <= sb;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '% schedule row(s) still have bb <= sb', v_bad;
  END IF;

  -- Deleting the row must not have disturbed any stake a table can actually
  -- sit at. Spot-checked either side of where it sat, plus the tier fallback
  -- the vacated stake now resolves through.
  IF public.fn_effective_rake_cap(2, 5)  IS DISTINCT FROM 7.5  THEN
    RAISE EXCEPTION '2/5 no longer caps at 7.50';
  END IF;
  IF public.fn_effective_rake_cap(3, 6)  IS DISTINCT FROM 8.0  THEN
    RAISE EXCEPTION '3/6 no longer caps at 8.00';
  END IF;
  IF public.fn_effective_rake_cap(5, 10) IS DISTINCT FROM 12.5 THEN
    RAISE EXCEPTION '5/10 no longer caps at 12.50';
  END IF;
  IF public.fn_effective_rake_cap(5, 5)  IS NULL THEN
    RAISE EXCEPTION '5/5 now resolves to no cap at all rather than to its tier';
  END IF;
END $$;

COMMIT;
