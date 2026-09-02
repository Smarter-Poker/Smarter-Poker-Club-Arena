-- Paid Leaderboard Settlement: Promo First, Owner Overlay Second
--
-- The opening wizard seeds one round into the Promo Wallet. Each closed round
-- then consumes the recorded funding owner's Promo Wallet first and covers any
-- shortfall from that owner's operating wallet. Winners, funding debits, the
-- immutable batch receipt, and individual payout receipts commit together.

CREATE TABLE IF NOT EXISTS public.leaderboard_payout_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON DELETE RESTRICT,
  period text NOT NULL CHECK (period IN ('weekly', 'monthly')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  metric text NOT NULL,
  program_id uuid NOT NULL REFERENCES public.leaderboard_reward_program_versions(id) ON DELETE RESTRICT,
  program_version integer NOT NULL,
  program_hash text NOT NULL,
  funding_owner_type text NOT NULL CHECK (funding_owner_type IN ('club', 'union')),
  funding_union_id uuid REFERENCES public.unions(id) ON DELETE RESTRICT,
  total_paid numeric(18,2) NOT NULL CHECK (total_paid >= 0),
  seed_funded numeric(18,2) NOT NULL CHECK (seed_funded >= 0),
  promo_funded numeric(18,2) NOT NULL CHECK (promo_funded >= 0),
  overlay_funded numeric(18,2) NOT NULL CHECK (overlay_funded >= 0),
  winner_count integer NOT NULL CHECK (winner_count >= 0),
  settled_at timestamptz NOT NULL DEFAULT now(),
  CHECK (total_paid = seed_funded + promo_funded + overlay_funded),
  CHECK (
    (funding_owner_type = 'club' AND funding_union_id IS NULL)
    OR (funding_owner_type = 'union' AND funding_union_id IS NOT NULL)
  ),
  UNIQUE (club_id, period, period_start)
);

CREATE TABLE IF NOT EXISTS public.leaderboard_payout_failures (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  period text NOT NULL,
  period_start date NOT NULL,
  error_message text NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (club_id, period, period_start)
);

ALTER TABLE public.leaderboard_payout_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leaderboard_payout_failures ENABLE ROW LEVEL SECURITY;

CREATE POLICY leaderboard_batches_funding_owner_read
  ON public.leaderboard_payout_batches FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.clubs club
      WHERE club.id = leaderboard_payout_batches.club_id
        AND club.owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.profiles profile
      WHERE profile.id = auth.uid() AND profile.role IN ('admin', 'superadmin', 'god')
    )
  );

CREATE POLICY leaderboard_failures_funding_owner_read
  ON public.leaderboard_payout_failures FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.clubs club
      WHERE club.id = leaderboard_payout_failures.club_id
        AND club.owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.profiles profile
      WHERE profile.id = auth.uid() AND profile.role IN ('admin', 'superadmin', 'god')
    )
  );

REVOKE INSERT, UPDATE, DELETE ON public.leaderboard_payout_batches
  FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.leaderboard_payout_failures
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_payout_leaderboard(
  p_club_id uuid,
  p_period text,
  p_metric text,
  p_start_date timestamptz,
  p_end_date timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_start date := (p_start_date AT TIME ZONE 'UTC')::date;
  v_end date := (p_end_date AT TIME ZONE 'UTC')::date;
  v_plan jsonb;
  v_existing public.leaderboard_payout_batches%ROWTYPE;
  v_winners jsonb := '[]'::jsonb;
  v_winner jsonb;
  v_total numeric(18,2) := 0;
  v_promo_available numeric(18,2) := 0;
  v_operating_available numeric(18,2) := 0;
  v_seed_available numeric(18,2) := 0;
  v_seed_debit numeric(18,2) := 0;
  v_seed_release numeric(18,2) := 0;
  v_promo_debit numeric(18,2) := 0;
  v_overlay numeric(18,2) := 0;
  v_union_id uuid;
  v_batch_id uuid;
  v_credited boolean;
BEGIN
  IF p_period NOT IN ('weekly', 'monthly') THEN
    RAISE EXCEPTION 'Only Weekly And Monthly Leaderboards Can Be Settled';
  END IF;
  IF v_start IS NULL OR v_end IS NULL OR v_end <= v_start THEN
    RAISE EXCEPTION 'Leaderboard Settlement Requires A Closed Date Range';
  END IF;
  IF v_end > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'An Open Leaderboard Round Cannot Be Paid';
  END IF;
  IF (p_period = 'weekly' AND (EXTRACT(DOW FROM v_start) <> 0 OR v_end <> v_start + 7))
     OR (p_period = 'monthly' AND (EXTRACT(DAY FROM v_start) <> 1 OR v_end <> (v_start + interval '1 month')::date)) THEN
    RAISE EXCEPTION 'Leaderboard Settlement Must Use A Canonical UTC Round';
  END IF;

  SELECT batch.* INTO v_existing
  FROM public.leaderboard_payout_batches batch
  WHERE batch.club_id = p_club_id
    AND batch.period = p_period
    AND batch.period_start = v_start;
  IF v_existing.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true, 'already_settled', true, 'batch_id', v_existing.id,
      'total_paid', v_existing.total_paid,
      'seed_funded', v_existing.seed_funded,
      'promo_funded', v_existing.promo_funded,
      'overlay_funded', v_existing.overlay_funded,
      'winner_count', v_existing.winner_count
    );
  END IF;

  v_plan := public.fn_get_leaderboard_reward_plan(p_club_id, p_period, v_start);
  IF v_plan IS NULL OR NOT COALESCE((v_plan ->> 'rewards_enabled')::boolean, false) THEN
    RAISE EXCEPTION 'No Paid Leaderboard Program Applies To This Round';
  END IF;
  IF p_metric IS DISTINCT FROM v_plan ->> 'payout_metric' THEN
    RAISE EXCEPTION 'Leaderboard Metric Does Not Match The Published Program';
  END IF;

  WITH board AS (
    SELECT ranked.*,
           row_number() OVER (ORDER BY ranked.rank, ranked.user_id) AS position
    FROM public.fn_club_leaderboard_by_dates(
      p_club_id, p_metric, v_start, v_end, 10, 0
    ) ranked
    WHERE ranked.qualified
  ), prizes AS (
    SELECT prize.rank, round(prize.amount, 2) AS amount
    FROM jsonb_to_recordset(COALESCE(v_plan -> 'prizes', '[]'::jsonb))
      AS prize(rank integer, amount numeric)
  ), winners AS (
    SELECT board.user_id, board.position::integer AS rank, prizes.amount
    FROM board JOIN prizes ON prizes.rank = board.position
    WHERE prizes.amount > 0
  )
  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'user_id', winners.user_id,
      'rank', winners.rank,
      'amount', winners.amount
    ) ORDER BY winners.rank), '[]'::jsonb),
    COALESCE(round(sum(winners.amount), 2), 0)
  INTO v_winners, v_total
  FROM winners;

  IF v_plan ->> 'funding_owner_type' = 'union' THEN
    v_union_id := (v_plan ->> 'funding_union_id')::uuid;
    SELECT COALESCE(wallet.promo_wallet, 0), COALESCE(wallet.chip_balance, 0)
    INTO v_promo_available, v_operating_available
    FROM public.union_wallets wallet
    WHERE wallet.union_id = v_union_id
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Leaderboard Funding Union Has No Wallet'; END IF;
  ELSE
    SELECT COALESCE(setup.leaderboard_seed_remaining, 0)
    INTO v_seed_available
    FROM public.club_opening_setups setup
    WHERE setup.club_id = p_club_id
    FOR UPDATE;

    SELECT COALESCE(club.promo_balance, 0), COALESCE(club.chip_treasury, 0)
    INTO v_promo_available, v_operating_available
    FROM public.clubs club
    WHERE club.id = p_club_id
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Leaderboard Club Not Found'; END IF;
  END IF;

  v_seed_debit := LEAST(v_total, v_seed_available);
  v_seed_release := v_seed_available - v_seed_debit;
  v_promo_debit := LEAST(v_total - v_seed_debit, v_promo_available);
  v_overlay := v_total - v_seed_debit - v_promo_debit;
  IF v_operating_available < v_overlay THEN
    RAISE EXCEPTION 'Leaderboard Requires % Chips But Promo And Operating Wallets Hold %',
      v_total, v_seed_available + v_promo_available + v_operating_available;
  END IF;

  IF v_plan ->> 'funding_owner_type' = 'union' THEN
    UPDATE public.union_wallets
    SET promo_wallet = promo_wallet - v_promo_debit,
        chip_balance = chip_balance - v_overlay,
        updated_at = now()
    WHERE union_id = v_union_id;
  ELSE
    PERFORM set_config('app.ledger_category', 'leaderboard_payout', true);
    PERFORM set_config('app.ledger_counterparty', 'leaderboard_round', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_club_id::text, true);
    UPDATE public.clubs
    SET promo_balance = promo_balance - v_promo_debit + v_seed_release,
        chip_treasury = chip_treasury - v_overlay,
        updated_at = now()
    WHERE id = p_club_id;

    UPDATE public.club_opening_setups
    SET leaderboard_seed_remaining = 0,
        updated_at = now()
    WHERE club_id = p_club_id AND leaderboard_seed_remaining > 0;
  END IF;

  INSERT INTO public.leaderboard_payout_batches (
    club_id, period, period_start, period_end, metric,
    program_id, program_version, program_hash,
    funding_owner_type, funding_union_id,
    total_paid, seed_funded, promo_funded, overlay_funded, winner_count
  ) VALUES (
    p_club_id, p_period, v_start, v_end, p_metric,
    (v_plan ->> 'program_id')::uuid,
    (v_plan ->> 'program_version')::integer,
    v_plan ->> 'program_hash',
    v_plan ->> 'funding_owner_type', v_union_id,
    v_total, v_seed_debit, v_promo_debit, v_overlay, jsonb_array_length(v_winners)
  ) RETURNING id INTO v_batch_id;

  FOR v_winner IN SELECT value FROM jsonb_array_elements(v_winners)
  LOOP
    v_credited := public.fn_credit_and_log(
      (v_winner ->> 'user_id')::uuid,
      (v_winner ->> 'amount')::numeric,
      format('leaderboard:%s:%s:%s:%s', p_club_id, p_period, v_start, v_winner ->> 'user_id'),
      'leaderboard_payout',
      format('%s Leaderboard, Rank %s', initcap(p_period), v_winner ->> 'rank'),
      (v_plan ->> 'program_id')::uuid
    );
    IF NOT v_credited THEN
      RAISE EXCEPTION 'Leaderboard Credit Key Already Exists Without A Batch Receipt';
    END IF;

    INSERT INTO public.leaderboard_payouts (
      club_id, period, metric, start_date, end_date, user_id, rank,
      payout_amount, payout_currency, awarded_at
    ) VALUES (
      p_club_id, p_period, p_metric, v_start, v_end,
      (v_winner ->> 'user_id')::uuid,
      (v_winner ->> 'rank')::integer,
      (v_winner ->> 'amount')::numeric,
      'chips', now()
    );
  END LOOP;

  DELETE FROM public.leaderboard_payout_failures
  WHERE club_id = p_club_id AND period = p_period AND period_start = v_start;

  RETURN jsonb_build_object(
    'success', true, 'already_settled', false, 'batch_id', v_batch_id,
    'total_paid', v_total, 'seed_funded', v_seed_debit, 'promo_funded', v_promo_debit,
    'overlay_funded', v_overlay, 'winner_count', jsonb_array_length(v_winners)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_settle_due_leaderboards()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_today date := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date;
  v_setting record;
  v_period text;
  v_start date;
  v_result jsonb;
  v_settled integer := 0;
  v_failed integer := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('settle-due-leaderboards')) THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'Already Running');
  END IF;

  FOR v_setting IN
    SELECT settings.club_id, settings.payout_metric
    FROM public.club_leaderboard_settings settings
    WHERE settings.rewards_enabled
  LOOP
    FOREACH v_period IN ARRAY ARRAY['weekly', 'monthly']
    LOOP
      IF v_period = 'weekly' AND EXTRACT(DOW FROM v_today) = 0 THEN
        v_start := v_today - 7;
      ELSIF v_period = 'monthly' AND EXTRACT(DAY FROM v_today) = 1 THEN
        v_start := (v_today - interval '1 month')::date;
      ELSE
        CONTINUE;
      END IF;

      BEGIN
        v_result := public.fn_payout_leaderboard(
          v_setting.club_id, v_period, v_setting.payout_metric,
          v_start::timestamptz, v_today::timestamptz
        );
        v_settled := v_settled + CASE WHEN COALESCE((v_result ->> 'already_settled')::boolean, false) THEN 0 ELSE 1 END;
      EXCEPTION WHEN OTHERS THEN
        v_failed := v_failed + 1;
        INSERT INTO public.leaderboard_payout_failures
          (club_id, period, period_start, error_message, failed_at)
        VALUES (v_setting.club_id, v_period, v_start, left(SQLERRM, 500), now())
        ON CONFLICT (club_id, period, period_start) DO UPDATE
          SET error_message = EXCLUDED.error_message, failed_at = now();
      END;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('success', v_failed = 0, 'settled', v_settled, 'failed', v_failed);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_payout_leaderboard(uuid, text, text, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_payout_leaderboard(uuid, text, text, timestamptz, timestamptz)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_settle_due_leaderboards()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_due_leaderboards()
  TO service_role;

COMMENT ON FUNCTION public.fn_payout_leaderboard(uuid, text, text, timestamptz, timestamptz) IS
  'Atomic paid-leaderboard settlement. Debits the published owner Promo Wallet first, covers any shortfall from its operating wallet as overlay, credits ranked winners exactly once, and records immutable batch evidence.';

SELECT cron.schedule(
  'leaderboard-payout-waterfall-daily',
  '20 0 * * *',
  'SELECT public.fn_settle_due_leaderboards();'
);
