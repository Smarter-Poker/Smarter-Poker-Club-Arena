-- ═══════════════════════════════════════════════════════════════════════════
-- ca_rake_tier.min_bb IS DEAD DATA — say so in the schema
-- ═══════════════════════════════════════════════════════════════════════════
--
-- @unapplied: comment-only. Harmless, but it is DDL and every DDL statement on
-- this project costs a ~28s PostgREST schema reload (CLAUDE.md, production DDL
-- policy), so it should ride along with another apply rather than fire on its
-- own.
--
-- WHY. public.fn_effective_rake_cap selects a tier with
--
--     WHERE t.max_bb IS NULL OR p_bb <= t.max_bb
--     ORDER BY t.max_bb ASC NULLS LAST
--     LIMIT 1
--
-- which never looks at min_bb. That is CORRECT and matches the engine exactly:
-- server/src/config/RakeConfig.ts's getTierForBB is a pure max_bb cascade
-- (<=0.2, <=0.8, <=3, <=8, <=40, else nosebleeds), and STAKES_TIERS' minBB
-- values leave deliberate GAPS between tiers (0.2 -> 0.3, 0.8 -> 1, 3 -> 3.5,
-- 8 -> 9, 40 -> 41). A stake landing in a gap - a 0.25 big blind, say - has no
-- tier at all if min_bb is honoured, and the correct tier if it is not.
--
-- So min_bb is not merely unread. Any future WHERE clause that starts reading
-- it would introduce a hole in the ladder at every gap, and the failure would
-- be a NULL cap on a legal stake. This comment exists to stop that.
--
-- The same is true of public.bbj_stakes_tiers.min_bb, which encodes the bands
-- CONTIGUOUSLY (0.01, 0.21, 0.81, 3.01, 8.01, 40.01) - a third encoding of the
-- same ladder, agreeing with neither the code nor ca_rake_tier, and read by
-- nothing.
--
-- scripts/ci/check-db-mirror-parity.mjs compares every OTHER column of both
-- tables against STAKES_TIERS on every pull request, and deliberately excludes
-- min_bb for exactly this reason.
--
-- ROLLBACK (Tier 1): COMMENT ON COLUMN ... IS NULL, twice.

BEGIN;

COMMENT ON COLUMN public.ca_rake_tier.min_bb IS
  'DEAD DATA. fn_effective_rake_cap orders by max_bb only and never reads this, which matches the engine: getTierForBB in server/src/config/RakeConfig.ts is a pure max_bb cascade. STAKES_TIERS.minBB leaves gaps between tiers (0.2->0.3, 0.8->1, 3->3.5, 8->9, 40->41), so honouring min_bb would leave a stake in a gap with NO tier and a NULL cap. Do not add it to a WHERE clause. Excluded on purpose by scripts/ci/check-db-mirror-parity.mjs.';

COMMENT ON COLUMN public.bbj_stakes_tiers.min_bb IS
  'DEAD DATA, and a third encoding of the ladder: contiguous bands (0.01, 0.21, 0.81, 3.01, 8.01, 40.01) that agree with neither STAKES_TIERS.minBB nor ca_rake_tier.min_bb. Nothing reads it. Tier selection is by max_bb everywhere. See ca_rake_tier.min_bb.';

DO $$
BEGIN
  IF col_description('public.ca_rake_tier'::regclass,
       (SELECT attnum FROM pg_attribute
         WHERE attrelid = 'public.ca_rake_tier'::regclass AND attname = 'min_bb')) IS NULL THEN
    RAISE EXCEPTION 'ca_rake_tier.min_bb comment did not land';
  END IF;
  IF col_description('public.bbj_stakes_tiers'::regclass,
       (SELECT attnum FROM pg_attribute
         WHERE attrelid = 'public.bbj_stakes_tiers'::regclass AND attname = 'min_bb')) IS NULL THEN
    RAISE EXCEPTION 'bbj_stakes_tiers.min_bb comment did not land';
  END IF;
END $$;

COMMIT;
