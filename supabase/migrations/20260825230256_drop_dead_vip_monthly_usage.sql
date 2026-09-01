-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825230256; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
--  DROP THE VIP USAGE TABLE THAT NEVER WORKED
-- ═══════════════════════════════════════════════════════════════════════════
--
-- There are two VIP monthly-usage tables. `vip_feature_usage_monthly`
-- (month TEXT 'YYYY-MM') is the live one: 585 rows, read by VIPService and
-- written by fn_increment_vip_usage, fn_consume_time_bank and
-- fn_consume_rabbit_hunt. `vip_monthly_usage` (period_start DATE) is the 2026-01
-- original and has NEVER held a row.
--
-- It did not simply fall out of use — it could not work. VIPService's own
-- comment records that the old fallback upserted columns this table does not
-- have, so every write failed. A quota table that silently accepts no writes is
-- worse than no quota table: it reads as "this player has used nothing".
--
-- Verified before dropping:
--   rows                     0
--   references in src/, server/src/   0  (one comment, no code)
--   referenced by any function        0
--
-- ROLLBACK
--   CREATE TABLE public.vip_monthly_usage (
--     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
--     user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
--     feature text NOT NULL,
--     period_start date NOT NULL,
--     usage_count integer NOT NULL DEFAULT 0,
--     UNIQUE (user_id, feature, period_start)
--   );
--   -- No data to restore: it was empty.

DO $$
DECLARE
  v_rows bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='vip_monthly_usage'
  ) THEN
    RAISE NOTICE 'vip_monthly_usage already gone';
    RETURN;
  END IF;

  -- Refuse to drop a table that has started being used since this was written.
  EXECUTE 'SELECT count(*) FROM public.vip_monthly_usage' INTO v_rows;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'vip_monthly_usage now holds % row(s) — not dropping', v_rows;
  END IF;

  DROP TABLE public.vip_monthly_usage;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='vip_monthly_usage'
  ) THEN
    RAISE EXCEPTION 'vip_monthly_usage still exists';
  END IF;
  -- The live table must be untouched.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='vip_feature_usage_monthly'
  ) THEN
    RAISE EXCEPTION 'vip_feature_usage_monthly is missing — wrong table was dropped';
  END IF;
END $$;
