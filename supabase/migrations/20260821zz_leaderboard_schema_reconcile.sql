-- LEADERBOARD SCHEMA — what production actually has, and why it differs from
-- the phase files next to it.
--
-- 20260821_leaderboard_payouts_and_settings.sql, 20260821z_phase12_* and
-- 20260821z_phase15_* were authored on this branch but NEVER APPLIED. Nothing
-- in either repo runs `supabase db push` or `supabase migration up` - migrations
-- reach this database through the Supabase MCP - so none of that SQL had ever
-- executed against a server. The CI phantom gate was right: two tables and six
-- functions the client calls did not exist.
--
-- Applying them surfaced four defects, each a hard runtime failure the first
-- time a club owner pressed Finalize:
--
--   1. `SELECT user_id, value, rank FROM fn_club_leaderboard_by_dates(...)`.
--      That function returns no `value` column, in either author's version.
--      42703 on every call. Prizes key on RANK alone, so `value` is dropped.
--
--   2. `credit_player_wallet(user_id, amount)` - the real signature is
--      (p_user_id uuid, p_amount numeric, p_idempotency_key text). Two
--      arguments is 42883, so the whole chips path was dead.
--
--   3. `increment_diamonds(user, amount::INT)` truncates: a prize of 100.7
--      silently paid 100.
--
--   4. The decisive one. increment_diamonds writes profiles.diamonds, and
--      fn_guard_profile_privileged_columns() refuses:
--
--        42501: profiles.diamonds is server-managed and cannot be modified
--        HINT: written only by service_role (award_diamonds_v2, Stripe
--              webhooks) or deduct_diamonds.
--
--      So the diamonds path could not have run however it was written. And the
--      sanctioned writer is no substitute: award_diamonds_v2 takes an ACTION
--      KEY and pays what that action is worth in the diamond catalogue - it
--      cannot pay an arbitrary prize typed into a settings modal.
--
-- Crediting the PLATFORM balance out of a club's prize table is therefore not a
-- bug to patch, it is an economy decision - does club money mint spendable
-- platform currency? - and it is not an agent's to make. The payout stays
-- inside the club economy, which needs no such decision and is what the money
-- already is: club_diamond_wallets pays, club_members.diamonds and
-- club_members.chip_balance receive. If leaderboard prizes SHOULD mint platform
-- diamonds, that means extending the guard's whitelist deliberately, not as a
-- side effect of a leaderboard feature.
--
-- Kept from the branch: OWNER-ONLY authorisation, closed periods only, default
-- settings created on first finalise, weekly/monthly prize tables.
--
-- Applied to production 2026-08-21 via Supabase MCP across
-- leaderboard_by_dates_functions, leaderboard_settings_payouts_and_finalise
-- and fn_payout_leaderboard_credits_club_balances.
--
-- Proven against production inside rolled-back probes, not assumed:
--   * a 7-day window ending today returns rows IDENTICAL to
--     fn_club_leaderboard_period_v2's 'weekly' - all 10, same users, ranks and
--     profit, so the money matches the table players were shown;
--   * a 2-rank weekly diamonds payout moved the wallet 50000 -> 49850 and
--     credited rank 1 exactly 100, writing 2 rows;
--   * refused: a non-owner, a period that has not closed, an underfunded
--     wallet, a re-finalise, and a prize table with a duplicate rank;
--   * diamonds and chips finalised in the SAME transaction, which previously
--     failed with 'relation "_lb_awards" already exists' because ON COMMIT DROP
--     fires at commit, not at function exit. Harmless for one RPC per request,
--     fatal for any batch finalise; the function now drops first and is
--     re-entrant.
--
-- This file is the record. The DDL itself is already live; re-running it is
-- safe and idempotent.

-- The two tables, as production has them. Differences from the phase file,
-- all deliberate:
--   * gen_random_uuid() (core) rather than uuid_generate_v4(), which lives in
--     the `extensions` schema and is not on every search_path;
--   * CHECK constraints on the prize tables - this JSON decides what leaves a
--     wallet, so a duplicate rank or a negative amount is refused at write
--     time rather than discovered during a payout;
--   * RLS scoped to the club. The phase file used `USING (true)` on both
--     tables, which would let any signed-in user read every club's prize
--     configuration and every payout ever made.

CREATE TABLE IF NOT EXISTS public.club_leaderboard_settings (
  club_id         uuid PRIMARY KEY REFERENCES public.clubs(id) ON DELETE CASCADE,
  payout_currency text NOT NULL DEFAULT 'diamonds'
                    CHECK (payout_currency IN ('diamonds','chips')),
  weekly_prizes   jsonb NOT NULL DEFAULT '[]'::jsonb,
  monthly_prizes  jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.fn_valid_prize_table(p jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $$
  SELECT jsonb_typeof(p) = 'array'
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p) e
        WHERE jsonb_typeof(e) <> 'object'
           OR (e->>'rank')   IS NULL OR (e->>'amount') IS NULL
           OR (e->>'rank')   !~ '^[0-9]+$'
           OR (e->>'amount') !~ '^[0-9]+(\.[0-9]+)?$'
           OR (e->>'rank')::int < 1)
     AND (SELECT count(DISTINCT (e->>'rank')::int) = count(*)
            FROM jsonb_array_elements(p) e);
$$;

ALTER TABLE public.club_leaderboard_settings
  DROP CONSTRAINT IF EXISTS club_leaderboard_settings_weekly_ok,
  DROP CONSTRAINT IF EXISTS club_leaderboard_settings_monthly_ok;
ALTER TABLE public.club_leaderboard_settings
  ADD CONSTRAINT club_leaderboard_settings_weekly_ok  CHECK (public.fn_valid_prize_table(weekly_prizes)),
  ADD CONSTRAINT club_leaderboard_settings_monthly_ok CHECK (public.fn_valid_prize_table(monthly_prizes));

CREATE TABLE IF NOT EXISTS public.leaderboard_payouts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id         uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  period          text NOT NULL,
  metric          text NOT NULL,
  -- timestamptz, not date: the client filters with
  -- .eq('start_date', start.toISOString()).
  start_date      timestamptz NOT NULL,
  end_date        timestamptz NOT NULL,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rank            integer NOT NULL CHECK (rank >= 1),
  payout_amount   numeric NOT NULL CHECK (payout_amount >= 0),
  payout_currency text NOT NULL CHECK (payout_currency IN ('diamonds','chips')),
  awarded_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS leaderboard_payouts_once
  ON public.leaderboard_payouts (club_id, period, metric, start_date, user_id);
CREATE INDEX IF NOT EXISTS leaderboard_payouts_lookup
  ON public.leaderboard_payouts (club_id, period, metric, start_date);
CREATE INDEX IF NOT EXISTS leaderboard_payouts_by_user
  ON public.leaderboard_payouts (user_id, awarded_at DESC);

ALTER TABLE public.club_leaderboard_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leaderboard_payouts       ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS club_lb_settings_read  ON public.club_leaderboard_settings;
DROP POLICY IF EXISTS club_lb_settings_write ON public.club_leaderboard_settings;
CREATE POLICY club_lb_settings_read ON public.club_leaderboard_settings
  FOR SELECT TO authenticated USING (public.is_club_member(club_id, auth.uid()));
CREATE POLICY club_lb_settings_write ON public.club_leaderboard_settings
  FOR ALL TO authenticated
  USING (public.fn_has_club_role(auth.uid(), club_id, 'admin'))
  WITH CHECK (public.fn_has_club_role(auth.uid(), club_id, 'admin'));

DROP POLICY IF EXISTS lb_payouts_read ON public.leaderboard_payouts;
-- A member sees their club's awards; anyone sees their own, which is what the
-- trophy shelf is - it spans every club they have been paid by.
CREATE POLICY lb_payouts_read ON public.leaderboard_payouts
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_club_member(club_id, auth.uid()));
-- No write policy at all: rows come only from fn_payout_leaderboard, which is
-- SECURITY DEFINER. There is no path by which a client writes its own trophy.

GRANT SELECT, INSERT, UPDATE ON public.club_leaderboard_settings TO authenticated;
GRANT SELECT ON public.leaderboard_payouts TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.leaderboard_payouts FROM authenticated, anon;
