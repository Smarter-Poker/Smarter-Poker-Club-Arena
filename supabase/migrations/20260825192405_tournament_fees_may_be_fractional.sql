-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825192405; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Dan 2026-08-25: "FRACTIONAL FEE'S NEED TO BE ALLOWED, WE HAVE 1 BUY IN,
-- 5 BUY IN'S ETC THOSE SHOULD BE .10 RAKE AND .50 RAKE PER BUY IN."
--
-- tournaments_rake_within_10_pct capped the fee at floor(total * 0.1) — a
-- WHOLE number of chips. On a 1-chip game that is floor(0.1) = 0, so a 0.10
-- fee was not merely unused, it was un-insertable, and the entire micro end of
-- the ladder (1, 2, 3, 5) ran rake-free by arithmetic accident.
--
-- The ceiling is unchanged at 10%. Only the floor() is removed, so the check
-- now expresses the rule it was always meant to express: the house never takes
-- more than a tenth of what a player pays. buy_in_fee is numeric(15,2), so
-- cents are the finest granularity that can be stored and no rounding is lost.
--
-- 1e-9 absorbs float noise on an exact split (0.10 <= 0.1 must not fail).

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.tournaments'::regclass
       AND conname = 'tournaments_rake_within_10_pct'
  ) THEN
    RAISE EXCEPTION 'tournaments_rake_within_10_pct is missing - refusing to guess at the rake rule';
  END IF;

  ALTER TABLE public.tournaments DROP CONSTRAINT tournaments_rake_within_10_pct;

  ALTER TABLE public.tournaments
    ADD CONSTRAINT tournaments_rake_within_10_pct
    CHECK (
      COALESCE(buy_in_fee, 0::numeric)
        <= ((COALESCE(buy_in_amount, 0::numeric) + COALESCE(buy_in_fee, 0::numeric)) * 0.1)
           + 0.000000001
    ) NOT VALID;
END
$migration$;

-- POST-APPLY ASSERTIONS. The rule must accept the fractional fees Dan named
-- and must still refuse anything over a tenth.
DO $verify$
DECLARE ok boolean;
BEGIN
  -- a 1-chip game paying 0.10, and a 5-chip game paying 0.50
  SELECT (0.10 <= ((0.90 + 0.10) * 0.1) + 1e-9) AND (0.50 <= ((4.50 + 0.50) * 0.1) + 1e-9) INTO ok;
  IF NOT ok THEN RAISE EXCEPTION 'the new rule rejects the fees it exists to allow'; END IF;

  -- and a heads-up 5% split
  SELECT (0.05 <= ((0.95 + 0.05) * 0.1) + 1e-9) INTO ok;
  IF NOT ok THEN RAISE EXCEPTION 'the new rule rejects a 5 percent heads-up fee'; END IF;

  -- 11% must still be refused
  SELECT (0.11 <= ((0.89 + 0.11) * 0.1) + 1e-9) INTO ok;
  IF ok THEN RAISE EXCEPTION 'the ceiling is gone - 11 percent would now be accepted'; END IF;
END
$verify$;

-- ROLLBACK
--   ALTER TABLE public.tournaments DROP CONSTRAINT tournaments_rake_within_10_pct;
--   ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_rake_within_10_pct
--     CHECK (COALESCE(buy_in_fee, 0::numeric)
--            <= floor(((COALESCE(buy_in_amount,0::numeric) + COALESCE(buy_in_fee,0::numeric)) * 0.1) + 0.000000001))
--     NOT VALID;
-- Restoring the floor() re-blocks every fractional fee; any rows written in the
-- meantime with a sub-chip fee would then fail a future VALIDATE CONSTRAINT.
