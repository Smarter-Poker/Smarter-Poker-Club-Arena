-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260423231445 "20260421080000_remove_home_games_escrow_and_money_features"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 12ebc46d378e445d99ec6fd901f1e3af of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- PHASE 1: Complete removal of real-world money transaction infrastructure
-- from Home Games.
--
-- Per CEO directive: "completely remove #6 100% and everywhere we do not
-- have a single thing to do with real world money transactions at all ever!"
--
-- What this removes:
--   1. commander_escrow_transactions table (10 test rows, all home_game_id=null)
--   2. Any RLS policies, triggers, or indexes attached to it
--
-- What is NOT touched (intentionally):
--   • Club Arena chip_escrow  — internal play-chip accounting, not real money
--   • Club Commander cash/comp/buyin transactions — B2B brick-and-mortar venue
--     tracking, platform does not hold funds
--   • Commander Stripe subscription billing — standard B2B SaaS subscription
--     that is orthogonal to player-facing game transactions
--   • commander_home_games.buyin_min/buyin_max columns — these remain as
--     informational stakes descriptors ("$100-$500 buy-in" display only)
--
-- Paired with code changes (separate commit):
--   • Deleted 5 escrow API route files under pages/api/commander/escrow/
--   • Removed escrow handlers from stripe webhook (3 blocks)
--   • Removed Finances tab + all escrow state/handlers from Home Games manage.js
--   • Replaced "Escrow option" in FAQ with reputation/reviews mitigation
--   • Added explicit "Smarter Poker does not hold, transfer, or process any
--     money" notice (see platform_policies table below)
--
-- Result: the platform has ZERO code paths that can accept, hold, route, or
-- release real-world money on behalf of Home Games players. All money matters
-- are strictly between host and players, off-platform.

BEGIN;

-- Drop the table. CASCADE to catch any stray FK/trigger/index.
DROP TABLE IF EXISTS public.commander_escrow_transactions CASCADE;

-- Platform policy record — makes the stance queryable from the client.
-- Useful for the "how does this work?" modals in the UI, TOS page,
-- and for compliance audits showing the platform's scope is declared.
CREATE TABLE IF NOT EXISTS public.platform_policies (
  key          text PRIMARY KEY,
  value        text NOT NULL,
  description  text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Allow anon + authenticated to read (policies are public-by-design).
ALTER TABLE public.platform_policies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_policies_select ON public.platform_policies;
CREATE POLICY platform_policies_select
  ON public.platform_policies FOR SELECT
  USING (true);

INSERT INTO public.platform_policies (key, value, description)
VALUES
  ('home_games.money_policy',
   'coordination_only',
   'Smarter Poker is a coordination tool for home poker games. The platform does not hold, transfer, process, or facilitate any real-world money transactions. All deposits, buy-ins, payouts, and settlements are strictly between the host and players, off-platform.'),
  ('home_games.money_policy.version',
   '1.0',
   'Policy version. Increment when the stance changes so clients can re-prompt for acknowledgement.'),
  ('home_games.money_policy.effective_at',
   to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
   'Effective timestamp for the current money policy.')
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      description = EXCLUDED.description,
      updated_at = now();

COMMIT;
