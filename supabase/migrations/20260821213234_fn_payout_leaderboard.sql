-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821213234 "fn_payout_leaderboard"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 558a133fe202729dcd926430cae3b0cb of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Finalises a leaderboard period and pays the prize table.
--
-- Everything this function does is a money movement, so it is written to be
-- refused rather than to guess:
--
--   * only club staff (admin and above) may call it;
--   * only a period that has actually CLOSED may be finalised - the UI only
--     offers the button for a past period, but the UI is not the authority;
--   * a period already paid is refused, not topped up. The unique index is the
--     backstop; this is the readable error;
--   * diamonds come OUT of the club's wallet and the wallet is locked and
--     checked first, so an underfunded club fails before anyone is credited
--     rather than halfway through;
--   * ranks come from fn_club_leaderboard_by_dates, the same function the page
--     renders from, so the money matches the table the players were looking at.
--
-- Chips are MINTED (the club's own scrip, matching the settings modal's
-- "Chips Are Minted"); diamonds are transferred, because they are not.

CREATE OR REPLACE FUNCTION public.fn_payout_leaderboard(
  p_club_id uuid,
  p_period text,
  p_metric text,
  p_start_date timestamptz,
  p_end_date timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_actor      uuid := auth.uid();
  v_currency   text;
  v_prizes     jsonb;
  v_total      numeric := 0;
  v_paid_count integer := 0;
  v_existing   integer;
  v_balance    numeric;
  v_max_rank   integer;
  r            record;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not signed in' USING ERRCODE = '42501';
  END IF;
  IF NOT public.fn_has_club_role(v_actor, p_club_id, 'admin') THEN
    RAISE EXCEPTION 'only club admins and above can finalise a leaderboard period'
      USING ERRCODE = '42501';
  END IF;

  IF p_start_date IS NULL OR p_end_date IS NULL OR p_end_date <= p_start_date THEN
    RAISE EXCEPTION 'invalid window % -> %', p_start_date, p_end_date;
  END IF;
  IF p_end_date > now() THEN
    RAISE EXCEPTION 'cannot finalise a period that has not closed yet (ends %)', p_end_date;
  END IF;

  SELECT count(*) INTO v_existing FROM public.leaderboard_payouts
   WHERE club_id = p_club_id AND period = p_period AND metric = p_metric
     AND start_date = p_start_date;
  IF v_existing > 0 THEN
    RAISE EXCEPTION 'this period is already finalised (% award(s) exist)', v_existing;
  END IF;

  SELECT payout_currency,
         CASE p_period
           WHEN 'weekly'  THEN weekly_prizes
           WHEN 'monthly' THEN monthly_prizes
           ELSE NULL
         END
    INTO v_currency, v_prizes
    FROM public.club_leaderboard_settings
   WHERE club_id = p_club_id;

  IF v_currency IS NULL THEN
    RAISE EXCEPTION 'this club has no leaderboard payout settings yet';
  END IF;
  IF v_prizes IS NULL THEN
    RAISE EXCEPTION 'no prize table is configured for the % period', p_period;
  END IF;
  IF jsonb_array_length(v_prizes) = 0 THEN
    RAISE EXCEPTION 'the % prize table is empty', p_period;
  END IF;

  SELECT max((e->>'rank')::int) INTO v_max_rank FROM jsonb_array_elements(v_prizes) e;

  CREATE TEMP TABLE _lb_awards ON COMMIT DROP AS
  SELECT b.user_id, b.rank, (pz->>'amount')::numeric AS amount
    FROM fn_club_leaderboard_by_dates(
           p_club_id, p_metric, p_start_date::date, p_end_date::date, v_max_rank, 0) b
    JOIN jsonb_array_elements(v_prizes) pz ON (pz->>'rank')::int = b.rank
   WHERE b.qualified                    -- a ratio metric below the hand floor wins nothing
     AND (pz->>'amount')::numeric > 0;

  SELECT COALESCE(sum(amount), 0), count(*) INTO v_total, v_paid_count FROM _lb_awards;

  IF v_paid_count = 0 THEN
    RETURN jsonb_build_object('ok', true, 'awarded', 0, 'total', 0,
      'note', 'nobody placed in the prize ranks for this window');
  END IF;

  IF v_currency = 'diamonds' THEN
    -- Lock the wallet before reading it, so two finalisations cannot both see
    -- a sufficient balance and both spend it.
    INSERT INTO public.club_diamond_wallets (club_id) VALUES (p_club_id)
      ON CONFLICT (club_id) DO NOTHING;
    SELECT balance INTO v_balance FROM public.club_diamond_wallets
     WHERE club_id = p_club_id FOR UPDATE;

    IF COALESCE(v_balance, 0) < v_total THEN
      RAISE EXCEPTION 'club diamond wallet holds % but this payout needs %',
        COALESCE(v_balance, 0), v_total;
    END IF;

    UPDATE public.club_diamond_wallets
       SET balance = balance - v_total,
           total_withdrawn = COALESCE(total_withdrawn, 0) + v_total,
           last_transaction_at = now(),
           updated_at = now()
     WHERE club_id = p_club_id;

    FOR r IN SELECT * FROM _lb_awards LOOP
      UPDATE public.club_members
         SET diamonds = COALESCE(diamonds, 0) + r.amount
       WHERE club_id = p_club_id AND user_id = r.user_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'rank % winner % is no longer a member of this club', r.rank, r.user_id;
      END IF;
    END LOOP;
  ELSE
    FOR r IN SELECT * FROM _lb_awards LOOP
      UPDATE public.club_members
         SET chip_balance = COALESCE(chip_balance, 0) + r.amount
       WHERE club_id = p_club_id AND user_id = r.user_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'rank % winner % is no longer a member of this club', r.rank, r.user_id;
      END IF;
    END LOOP;
  END IF;

  INSERT INTO public.leaderboard_payouts
    (club_id, period, metric, start_date, end_date, user_id, rank, payout_amount, payout_currency)
  SELECT p_club_id, p_period, p_metric, p_start_date, p_end_date,
         a.user_id, a.rank, a.amount, v_currency
    FROM _lb_awards a;

  RETURN jsonb_build_object('ok', true, 'awarded', v_paid_count,
                            'total', v_total, 'currency', v_currency);
END; $function$;

REVOKE ALL ON FUNCTION public.fn_payout_leaderboard(uuid, text, text, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_payout_leaderboard(uuid, text, text, timestamptz, timestamptz)
  TO authenticated, service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='fn_payout_leaderboard') THEN
    RAISE EXCEPTION 'fn_payout_leaderboard not created';
  END IF;
  -- anon must never be able to spend a club's wallet.
  IF has_function_privilege('anon',
       'public.fn_payout_leaderboard(uuid, text, text, timestamptz, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute the payout function';
  END IF;
END $$;
