-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821213153 "leaderboard_settings_payouts_and_finalise"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 23d730fc3775342fcbaee905e2c67b9b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- club_leaderboard_settings, leaderboard_payouts and fn_payout_leaderboard.
-- LeaderboardService has referenced all three since the leaderboard work
-- landed; none existed, so the settings modal, the payouts strip and the
-- Finalize button were each a PostgREST error the caller swallowed.

CREATE TABLE IF NOT EXISTS public.club_leaderboard_settings (
  club_id         uuid PRIMARY KEY REFERENCES public.clubs(id) ON DELETE CASCADE,
  payout_currency text NOT NULL DEFAULT 'diamonds'
                    CHECK (payout_currency IN ('diamonds','chips')),
  -- [{ "rank": 1, "amount": 500 }, ...]. Ranks are 1-based and must be
  -- distinct; amounts non-negative. Enforced below rather than trusted,
  -- because this table decides what leaves the club's wallet.
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
  -- .eq('start_date', start.toISOString()), so the stored value has to be the
  -- same instant it asks for.
  start_date      timestamptz NOT NULL,
  end_date        timestamptz NOT NULL,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rank            integer NOT NULL CHECK (rank >= 1),
  payout_amount   numeric NOT NULL CHECK (payout_amount >= 0),
  payout_currency text NOT NULL CHECK (payout_currency IN ('diamonds','chips')),
  awarded_at      timestamptz NOT NULL DEFAULT now()
);

-- One award per player per finalised window. This is the idempotency key: a
-- second Finalize on the same period cannot double-pay, whatever the UI does.
CREATE UNIQUE INDEX IF NOT EXISTS leaderboard_payouts_once
  ON public.leaderboard_payouts (club_id, period, metric, start_date, user_id);
CREATE INDEX IF NOT EXISTS leaderboard_payouts_lookup
  ON public.leaderboard_payouts (club_id, period, metric, start_date);
-- getUserTrophies reads by user across every club, ordered by award time.
CREATE INDEX IF NOT EXISTS leaderboard_payouts_by_user
  ON public.leaderboard_payouts (user_id, awarded_at DESC);

ALTER TABLE public.club_leaderboard_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leaderboard_payouts       ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS club_lb_settings_read  ON public.club_leaderboard_settings;
DROP POLICY IF EXISTS club_lb_settings_write ON public.club_leaderboard_settings;
CREATE POLICY club_lb_settings_read ON public.club_leaderboard_settings
  FOR SELECT TO authenticated
  USING (public.is_club_member(club_id, auth.uid()));
-- Prize tables decide what leaves the wallet, so writing them is an admin act.
CREATE POLICY club_lb_settings_write ON public.club_leaderboard_settings
  FOR ALL TO authenticated
  USING (public.fn_has_club_role(auth.uid(), club_id, 'admin'))
  WITH CHECK (public.fn_has_club_role(auth.uid(), club_id, 'admin'));

DROP POLICY IF EXISTS lb_payouts_read ON public.leaderboard_payouts;
-- A member sees their club's awards; anyone sees their own, which is what the
-- trophy shelf is - it spans every club they have ever been paid by.
CREATE POLICY lb_payouts_read ON public.leaderboard_payouts
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_club_member(club_id, auth.uid()));
-- No INSERT/UPDATE/DELETE policy at all: rows are created only by
-- fn_payout_leaderboard, which is SECURITY DEFINER. There is no path by which
-- a client writes its own trophy.

GRANT SELECT ON public.club_leaderboard_settings TO authenticated;
GRANT INSERT, UPDATE ON public.club_leaderboard_settings TO authenticated;
GRANT SELECT ON public.leaderboard_payouts TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.leaderboard_payouts FROM authenticated, anon;

COMMENT ON TABLE public.club_leaderboard_settings IS
  'Per-club leaderboard payout configuration: currency and the rank->amount prize tables.';
COMMENT ON TABLE public.leaderboard_payouts IS
  'Awards made when a leaderboard period is finalised. Written only by fn_payout_leaderboard; unique per (club, period, metric, window, user) so a period cannot pay twice.';

DO $$
DECLARE v_cols text[];
BEGIN
  SELECT array_agg(column_name::text ORDER BY column_name) INTO v_cols
    FROM information_schema.columns
   WHERE table_schema='public' AND table_name='leaderboard_payouts';
  IF NOT (v_cols @> ARRAY['id','club_id','period','metric','start_date','end_date',
                          'user_id','rank','payout_amount','payout_currency','awarded_at']) THEN
    RAISE EXCEPTION 'leaderboard_payouts missing columns the client selects: %', v_cols;
  END IF;
END $$;
