-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820195357 "spin_no_fee_constraint_case_insensitive"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 4b11377bf2d5a28972d13242a0e218f8 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Harden tournaments_spin_has_no_fee against CASE.
--
-- The original checked `variant IS DISTINCT FROM 'spin'`, and the audit then
-- found a creation path writing variant: 'SPIN' (uppercase). That row would
-- have slipped past the constraint AND failed the engine's own
-- `variant === 'spin'` check, so it would have been mispriced and never
-- settled. Match on lower(), and cover tournament_type too, so neither
-- spelling can carry a fee.

ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS tournaments_spin_has_no_fee;

ALTER TABLE public.tournaments
  ADD CONSTRAINT tournaments_spin_has_no_fee
  CHECK (
    (lower(COALESCE(variant, '')) <> 'spin'
     AND upper(COALESCE(tournament_type, '')) <> 'SPIN')
    OR COALESCE(buy_in_fee, 0) = 0
  ) NOT VALID;

COMMENT ON CONSTRAINT tournaments_spin_has_no_fee ON public.tournaments IS
  'A Spin charges the buy-in and nothing else; its rake is engineered into the multiplier distribution (src/config/spinSpec.ts). Case-insensitive and covers tournament_type, because a path writing variant=''SPIN'' was found slipping past the first version. NOT VALID so pre-2026-08-20 rows keep their historical fee.';
