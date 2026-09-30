-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821214039 "fn_payout_leaderboard_credits_club_balances"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 868b93ecb02449c8cec630e370d49400 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Fourth and last defect in the branch's payout path, and the one that decides
-- the design: the branch credits PLATFORM balances, and the platform refuses.
--
--   ERROR 42501: profiles.diamonds is server-managed and cannot be modified
--   HINT: Diamond balances, multipliers and VIP state are written only by
--         service_role (award_diamonds_v2, Stripe webhooks) or deduct_diamonds.
--
-- fn_guard_profile_privileged_columns() blocks increment_diamonds() outright,
-- so the diamonds path could never have run no matter how the call was
-- written. And the sanctioned writer is no substitute: award_diamonds_v2 takes
-- an ACTION KEY and pays whatever that action is worth in the diamond
-- catalogue - it cannot pay an arbitrary prize a club owner typed into a
-- settings modal.
--
-- Crediting the platform balance from a club's prize table is therefore not a
-- bug to patch; it is an economy decision (does club money mint spendable
-- platform currency?) and it is not mine to make. So the payout stays inside
-- the club economy, which needs no such decision and is what the money already
-- is: club_diamond_wallets pays out, club_members.diamonds and
-- club_members.chip_balance receive. The club's wallet pays the club's members
-- in the club's currency.
--
-- If Dan wants leaderboard prizes to mint PLATFORM diamonds, that needs the
-- guard's whitelist extended (or a catalogue action added) as a deliberate
-- change to the diamond economy - not a side effect of a leaderboard feature.
--
-- Everything else stays as the branch authored it: OWNER-ONLY, closed periods
-- only, defaults created on first finalise, weekly/monthly prize tables.

CREATE OR REPLACE FUNCTION public.fn_payout_leaderboard(
  p_club_id uuid,
  p_period text,
  p_metric text,
  p_start_date timestamptz,
  p_end_date timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
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
  v_missing    integer;
  r            record;
BEGIN
  IF v_actor IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.clubs WHERE id = p_club_id AND owner_id = v_actor) THEN
    RAISE EXCEPTION 'Not authorized. Only the Club Owner can finalize the leaderboard.'
      USING ERRCODE = '42501';
  END IF;

  IF p_start_date IS NULL OR p_end_date IS NULL OR p_end_date <= p_start_date THEN
    RAISE EXCEPTION 'invalid window % -> %', p_start_date, p_end_date;
  END IF;
  IF p_end_date >= now() THEN
    RAISE EXCEPTION 'Cannot finalize a period that has not ended yet.';
  END IF;

  SELECT count(*) INTO v_existing FROM public.leaderboard_payouts
   WHERE club_id = p_club_id AND period = p_period AND metric = p_metric
     AND start_date = p_start_date;
  IF v_existing > 0 THEN
    RAISE EXCEPTION 'this period is already finalised (% award(s) exist)', v_existing;
  END IF;

  INSERT INTO public.club_leaderboard_settings (club_id) VALUES (p_club_id)
    ON CONFLICT (club_id) DO NOTHING;

  SELECT payout_currency,
         CASE p_period WHEN 'weekly' THEN weekly_prizes
                       WHEN 'monthly' THEN monthly_prizes ELSE NULL END
    INTO v_currency, v_prizes
    FROM public.club_leaderboard_settings WHERE club_id = p_club_id;

  IF v_prizes IS NULL THEN
    RAISE EXCEPTION 'Unsupported period. Must be weekly or monthly.';
  END IF;
  IF jsonb_array_length(v_prizes) = 0 THEN
    RAISE EXCEPTION 'the % prize table is empty', p_period;
  END IF;

  SELECT max((e->>'rank')::int) INTO v_max_rank FROM jsonb_array_elements(v_prizes) e;

  -- `value` is deliberately not selected: fn_club_leaderboard_by_dates has no
  -- such column, and prizes key on RANK alone. The branch's version selected it
  -- and 42703'd on every call.
  CREATE TEMP TABLE _lb_awards ON COMMIT DROP AS
  SELECT b.user_id, b.rank, (pz->>'amount')::numeric AS amount
    FROM fn_club_leaderboard_by_dates(
           p_club_id, p_metric, p_start_date::date, p_end_date::date, v_max_rank, 0) b
    JOIN jsonb_array_elements(v_prizes) pz ON (pz->>'rank')::int = b.rank
   WHERE b.qualified
     AND (pz->>'amount')::numeric > 0;

  SELECT COALESCE(sum(amount), 0), count(*) INTO v_total, v_paid_count FROM _lb_awards;
  IF v_paid_count = 0 THEN
    RETURN jsonb_build_object('ok', true, 'awarded', 0, 'total', 0,
      'note', 'nobody placed in the prize ranks for this window');
  END IF;

  -- Everyone being paid must still be a member, checked before any money moves
  -- rather than discovered partway through the loop.
  SELECT count(*) INTO v_missing FROM _lb_awards a
   WHERE NOT EXISTS (SELECT 1 FROM public.club_members m
                      WHERE m.club_id = p_club_id AND m.user_id = a.user_id);
  IF v_missing > 0 THEN
    RAISE EXCEPTION '% prize winner(s) have left the club; finalise is blocked', v_missing;
  END IF;

  IF v_currency = 'diamonds' THEN
    INSERT INTO public.club_diamond_wallets (club_id) VALUES (p_club_id)
      ON CONFLICT (club_id) DO NOTHING;
    SELECT balance INTO v_balance FROM public.club_diamond_wallets
     WHERE club_id = p_club_id FOR UPDATE;

    IF COALESCE(v_balance, 0) < v_total THEN
      RAISE EXCEPTION 'Insufficient club diamonds: wallet holds %, this payout needs %',
        COALESCE(v_balance, 0), v_total;
    END IF;

    UPDATE public.club_diamond_wallets
       SET balance = balance - v_total,
           total_withdrawn = COALESCE(total_withdrawn, 0) + v_total,
           last_transaction_at = now(), updated_at = now()
     WHERE club_id = p_club_id;

    UPDATE public.club_members m
       SET diamonds = COALESCE(m.diamonds, 0) + a.amount
      FROM _lb_awards a
     WHERE m.club_id = p_club_id AND m.user_id = a.user_id;
  ELSIF v_currency = 'chips' THEN
    -- Minted, as the settings modal says: nothing is debited.
    UPDATE public.club_members m
       SET chip_balance = COALESCE(m.chip_balance, 0) + a.amount
      FROM _lb_awards a
     WHERE m.club_id = p_club_id AND m.user_id = a.user_id;
  ELSE
    RAISE EXCEPTION 'unknown payout currency %', v_currency;
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
  IF has_function_privilege('anon',
       'public.fn_payout_leaderboard(uuid, text, text, timestamptz, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute the payout function';
  END IF;
END $$;
