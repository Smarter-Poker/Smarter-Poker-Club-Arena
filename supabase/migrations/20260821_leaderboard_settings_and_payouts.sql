CREATE TABLE IF NOT EXISTS public.club_leaderboard_settings (
  club_id uuid PRIMARY KEY REFERENCES public.clubs(id) ON DELETE CASCADE,
  payout_currency text NOT NULL DEFAULT 'diamonds' CHECK (payout_currency IN ('diamonds', 'chips')),
  weekly_prizes jsonb NOT NULL DEFAULT '[]'::jsonb,
  monthly_prizes jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.club_leaderboard_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Managers can manage leaderboard settings"
  ON public.club_leaderboard_settings
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.club_members m
      WHERE m.club_id = club_leaderboard_settings.club_id
      AND m.user_id = auth.uid()
      AND m.role IN ('owner', 'manager')
    )
  );

CREATE POLICY "Anyone can read leaderboard settings"
  ON public.club_leaderboard_settings
  FOR SELECT
  TO authenticated
  USING (true);

CREATE TABLE IF NOT EXISTS public.leaderboard_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  period text NOT NULL,
  metric text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  rank integer NOT NULL,
  payout_amount numeric NOT NULL,
  payout_currency text NOT NULL,
  awarded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_leaderboard_payouts_club_period ON public.leaderboard_payouts(club_id, period, start_date);
CREATE INDEX idx_leaderboard_payouts_user ON public.leaderboard_payouts(user_id);

ALTER TABLE public.leaderboard_payouts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read leaderboard payouts"
  ON public.leaderboard_payouts
  FOR SELECT
  TO authenticated
  USING (true);

-- The payout function is called securely by a manager.
CREATE OR REPLACE FUNCTION public.fn_payout_leaderboard(
  p_club_id uuid,
  p_period text,
  p_metric text,
  p_start_date date,
  p_end_date date
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Logic to be implemented or run externally
  -- This is a stub to fulfill the service layer contract for now.
  -- In the future, this will loop over winners and dispense diamonds/chips.
  NULL;
END;
$$;
