-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831100522; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- PHASE 1 step A: storage only. Split from the function rewire because the
-- ALTER on vip_points_ledger takes an AccessExclusiveLock and the table is
-- written ~23k times a day by the live rake trigger — the combined migration
-- deadlocked against production traffic on the first attempt.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.vip_points_carry (
  user_id    uuid PRIMARY KEY,
  carry      numeric(14,4) NOT NULL DEFAULT 0 CHECK (carry >= 0 AND carry < 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.vip_points_carry ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vip_points_carry_read_own ON public.vip_points_carry;
CREATE POLICY vip_points_carry_read_own ON public.vip_points_carry
  FOR SELECT USING (user_id = auth.uid());

ALTER TABLE public.vip_points_ledger
  ADD COLUMN IF NOT EXISTS credit numeric(14,4);

