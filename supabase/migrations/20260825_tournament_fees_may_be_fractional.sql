-- ═══════════════════════════════════════════════════════════════════════════
-- FEES MAY BE FRACTIONAL
-- ───────────────────────────────────────────────────────────────────────────
-- Dan 2026-08-25: "FRACTIONAL FEE'S NEED TO BE ALLOWED, WE HAVE 1 BUY IN,
-- 5 BUY IN'S ETC THOSE SHOULD BE .10 RAKE AND .50 RAKE PER BUY IN."
--
-- tournaments_rake_within_10_pct capped the fee at floor(total * 0.1) — a
-- WHOLE number of chips. On a 1-chip game that is floor(0.1) = 0, so a 0.10
-- fee was not merely unused, it was UN-INSERTABLE, and the entire micro end of
-- the ladder (1, 2, 3, 5) ran rake-free by arithmetic accident. The comment in
-- src/utils/buyIn.ts called that an unavoidable trade — "that rule cannot
-- coexist with a hard 10% cap while fees stay whole numbers". They never had
-- to stay whole: buy_in_fee is numeric(15,2).
--
-- The CEILING IS UNCHANGED at 10%. Only floor() is removed, so the check now
-- states the rule it was always meant to state: the house never takes more
-- than a tenth of what a player pays. The total the player pays is still a
-- whole number, because the fee is cut OUT of it (0.90 + 0.10 = 1.00).
--
-- APPLIED to production 2026-08-25 via the Supabase MCP, with both probes run:
-- a 0.95/0.05 heads-up seat inserts, and a 0.85/0.15 row is still refused.
-- ═══════════════════════════════════════════════════════════════════════════

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

-- POST-APPLY ASSERTIONS: accept the fees this exists to allow, refuse the rest.
DO $verify$
DECLARE ok boolean;
BEGIN
  SELECT (0.10 <= ((0.90 + 0.10) * 0.1) + 1e-9) AND (0.50 <= ((4.50 + 0.50) * 0.1) + 1e-9) INTO ok;
  IF NOT ok THEN RAISE EXCEPTION 'the new rule rejects the fees it exists to allow'; END IF;

  SELECT (0.05 <= ((0.95 + 0.05) * 0.1) + 1e-9) INTO ok;
  IF NOT ok THEN RAISE EXCEPTION 'the new rule rejects a 5 percent heads-up fee'; END IF;

  SELECT (0.11 <= ((0.89 + 0.11) * 0.1) + 1e-9) INTO ok;
  IF ok THEN RAISE EXCEPTION 'the ceiling is gone - 11 percent would now be accepted'; END IF;
END
$verify$;

-- ROLLBACK
--   ALTER TABLE public.tournaments DROP CONSTRAINT tournaments_rake_within_10_pct;
--   ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_rake_within_10_pct
--     CHECK (COALESCE(buy_in_fee, 0::numeric)
--            <= floor(((COALESCE(buy_in_amount,0::numeric) + COALESCE(buy_in_fee,0::numeric)) * 0.1)
--                     + 0.000000001)) NOT VALID;
--   Restoring floor() re-blocks every fractional fee. Rows written in the
--   meantime with a sub-chip fee would then fail a future VALIDATE CONSTRAINT,
--   so the rollback is only safe alongside reverting src/utils/buyIn.ts and
--   server/src/config/buyIn.ts to the whole-chip split.
