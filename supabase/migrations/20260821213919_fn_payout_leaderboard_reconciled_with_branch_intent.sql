-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821213919 "fn_payout_leaderboard_reconciled_with_branch_intent"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 27db7ee24ecdcb6e49051a0829860d06 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Reconciles fn_payout_leaderboard with the version authored on
-- fix/reapply-500x-retirement-2 (20260821_leaderboard_payouts_and_settings.sql,
-- later 20260821z_phase15_fix_payout_rpc.sql), adopting ITS semantics and
-- fixing three defects that made it unrunnable. Those migrations were written
-- but never applied - nothing in either repo runs `supabase db push` - so none
-- of this had ever executed against a database.
--
-- Adopted from the branch, replacing my earlier improvisation:
--   * OWNER-ONLY. Their check is clubs.owner_id = auth.uid(). Stricter than the
--     admin+ I had used, and it is their call to make about their own feature.
--   * GLOBAL wallets, not per-club. increment_diamonds() and
--     credit_player_wallet() credit the player's platform balance. That is what
--     the settings modal describes - "Diamonds Are Deducted From The Club
--     Diamond Wallet. Chips Are Minted" - the club pays, the player receives
--     spendable currency.
--
-- Fixed, each a hard runtime failure the moment the button was pressed:
--
--   1. `SELECT user_id, value, rank FROM fn_club_leaderboard_by_dates(...)`.
--      That function returns no `value` column - never has, in their version or
--      mine. 42703 on every call. Prizes are keyed on RANK alone, so `value`
--      was never needed; it is simply dropped.
--   2. `credit_player_wallet(user_id, amount)` - the function's signature is
--      (p_user_id uuid, p_amount numeric, p_idempotency_key text). Two args is
--      42883, so the entire chips path was dead. Now passes a deterministic key
--      built from the window, which also makes a retry unable to double-mint.
--   3. increment_diamonds takes an INTEGER. `v_amount::INT` truncates, so a
--      prize of 100.7 silently paid 100. Fractional diamond prizes are now
--      refused outright rather than quietly shaved.
--
-- Kept from my version, because they are safety properties rather than product
-- decisions:
--   * the wallet is locked FOR UPDATE and the TOTAL is checked before anyone is
--     credited. Theirs checked and deducted per winner inside the loop, so an
--     underfunded club paid rank 1 and 2 and then threw on rank 3 - and since
--     the whole call is one transaction that rolled back anyway, but only after
--     doing the work. Checking the total first fails cleanly and cheaply.
--   * an already-finalised period is refused with one clear error instead of
--     being silently skipped winner-by-winner. The unique index remains the
--     backstop.

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
  v_fractional integer;
  r            record;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authorized. Only the Club Owner can finalize the leaderboard.'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.clubs WHERE id = p_club_id AND owner_id = v_actor) THEN
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

  -- Their behaviour: a club with no settings row gets the defaults rather than
  -- an error, so a first finalise works without visiting the settings modal.
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

  IF v_currency = 'diamonds' THEN
    SELECT count(*) INTO v_fractional FROM _lb_awards WHERE amount <> trunc(amount);
    IF v_fractional > 0 THEN
      RAISE EXCEPTION 'diamond prizes must be whole numbers; % prize(s) are fractional', v_fractional;
    END IF;

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
           last_transaction_at = now(),
           updated_at = now()
     WHERE club_id = p_club_id;

    FOR r IN SELECT * FROM _lb_awards LOOP
      PERFORM public.increment_diamonds(r.user_id, r.amount::int);
    END LOOP;
  ELSIF v_currency = 'chips' THEN
    FOR r IN SELECT * FROM _lb_awards LOOP
      PERFORM public.credit_player_wallet(
        r.user_id, r.amount,
        'leaderboard:' || p_club_id || ':' || p_period || ':' || p_metric
                       || ':' || p_start_date::text || ':' || r.user_id);
    END LOOP;
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
  -- The two credit helpers must exist with the arities this function calls,
  -- or the money path is dead again the moment someone presses the button.
  IF to_regprocedure('public.increment_diamonds(uuid, integer)') IS NULL THEN
    RAISE EXCEPTION 'increment_diamonds(uuid, integer) is missing';
  END IF;
  IF to_regprocedure('public.credit_player_wallet(uuid, numeric, text)') IS NULL THEN
    RAISE EXCEPTION 'credit_player_wallet(uuid, numeric, text) is missing';
  END IF;
END $$;
