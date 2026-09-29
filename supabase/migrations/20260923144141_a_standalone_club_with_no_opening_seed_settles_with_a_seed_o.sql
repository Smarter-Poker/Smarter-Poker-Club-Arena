-- 20260923144141_a_standalone_club_with_no_opening_seed_settles_with_a_seed_o.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- APPLY AFTER 20260923143157 (it asserts that migration's fn_payout_leaderboard).
--
-- WHAT THIS CHANGES, AND WHY:
--
-- A standalone club with NO club_opening_setups row - every club that never ran
-- the opening wizard - settles a paid round on a seed that does not exist.
-- fn_payout_leaderboard reads the opening seed with
--
--     SELECT COALESCE(setup.leaderboard_seed_remaining, 0) INTO v_seed_available
--       FROM public.club_opening_setups setup WHERE setup.club_id = p_club_id ...
--
-- and a SELECT INTO over ZERO rows assigns NULL: the COALESCE is inside the
-- select list and never runs. From there:
--   * IF v_seed_available + v_promo_available < v_total  is NULL, so an empty
--     Promo Wallet is never refused;
--   * LEAST(v_total, NULL) is v_total (LEAST skips NULLs), so the whole round is
--     booked as seed_funded and promo_funded is 0;
--   * v_seed_release is NULL, so promo_balance is set to NULL (the >= 0 CHECK
--     passes a NULL), and the journal records the WHOLE Promo Wallet leaving;
--   * every winner is credited: chips paid out of nothing.
-- Reproduced on the isolated fixture built from the live definitions: a club
-- with 1,000 in its Promo Wallet and a 300 round ended with promo_balance NULL,
-- a batch of seed 300 / promo 0, a 1,000.00 promo_wallet leg out and 300.00 in
-- winner credits. The live code has done this since 20260906084547.
--
-- The fix is one assignment: a club with no setup row holds a seed of zero.
-- Clubs WITH a setup row are unaffected (their SELECT finds the row). A club
-- without one now settles exactly as the 09-06 contract says: from its Promo
-- Wallet, or, when the Promo Wallet is short, not at all (unpaid, retried by
-- the daily sweep) unless its owner opted into the Club Bank overlay.
--
-- THIS CHANGES BEHAVIOUR FOR EXISTING CLUBS, which the Phase 2 data hold
-- (Deep Stack Society, Shark Club, Club Jaqk and every existing club keep
-- today's behaviour) puts in the lead's hands. Before applying, read which
-- clubs it touches (the handover lists the queries): any standalone club with
-- an enabled club-funded program and no setup row, any batch with
-- seed_funded > 0 for such a club, and any club whose promo_balance IS NULL.
-- A club whose promo_balance is already NULL will read a Promo Wallet of 0 and
-- its next round will wait, unpaid and retryable, until it is funded.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_payout_leaderboard(uuid,text,text,timestamptz,timestamptz)')
       AND md5(p.prosrc) = 'b311250f543badd00a461b461cf2b591'
       AND md5(pg_get_functiondef(p.oid)) = '3457438a87f4aa704fe2d12152fe8914'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION 'NO_SETUP_ROW_SEED_PREIMAGE_DRIFT: apply 20260923143157 first, or the function moved';
  END IF;
END
$pre$;

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
  v_seed_available numeric(18,2) := 0;
  v_seed_debit numeric(18,2) := 0;
  v_seed_release numeric(18,2) := 0;
  v_promo_debit numeric(18,2) := 0;
  v_bank_available numeric(18,2) := 0;
  v_overlay_enabled boolean := false;
  v_overlay numeric := 0;
  v_union_id uuid;
  v_batch_id uuid;
  v_credited boolean;
BEGIN
  IF p_period NOT IN ('weekly', 'monthly') THEN
    RAISE EXCEPTION 'LEADERBOARD_PROGRAM_INVALID|Only Weekly And Monthly Leaderboards Can Be Settled';
  END IF;
  IF v_start IS NULL OR v_end IS NULL OR v_end <= v_start THEN
    RAISE EXCEPTION 'LEADERBOARD_PROGRAM_INVALID|Leaderboard Settlement Requires A Closed Date Range';
  END IF;
  IF v_end > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'LEADERBOARD_PROGRAM_INVALID|An Open Leaderboard Round Cannot Be Paid';
  END IF;
  IF (p_period = 'weekly' AND (EXTRACT(DOW FROM v_start) <> 0 OR v_end <> v_start + 7))
     OR (p_period = 'monthly' AND (
       EXTRACT(DAY FROM v_start) <> 1
       OR v_end <> (v_start + interval '1 month')::date
     )) THEN
    RAISE EXCEPTION 'LEADERBOARD_PROGRAM_INVALID|Leaderboard Settlement Must Use A Canonical UTC Round';
  END IF;

  SELECT batch.* INTO v_existing
  FROM public.leaderboard_payout_batches batch
  WHERE batch.club_id = p_club_id
    AND batch.period = p_period
    AND batch.period_start = v_start;
  IF v_existing.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_settled', true,
      'batch_id', v_existing.id,
      'total_paid', v_existing.total_paid,
      'seed_funded', v_existing.seed_funded,
      'promo_funded', v_existing.promo_funded,
      'overlay_funded', v_existing.overlay_funded,
      'winner_count', v_existing.winner_count,
      'tie_policy', v_existing.tie_policy
    );
  END IF;

  v_plan := public.fn_get_leaderboard_reward_plan(p_club_id, p_period, v_start);
  IF v_plan IS NULL OR NOT COALESCE((v_plan ->> 'rewards_enabled')::boolean, false) THEN
    RAISE EXCEPTION 'LEADERBOARD_PROGRAM_INVALID|No Paid Leaderboard Program Applies To This Round';
  END IF;
  IF p_metric IS DISTINCT FROM v_plan ->> 'payout_metric' THEN
    RAISE EXCEPTION 'LEADERBOARD_PROGRAM_INVALID|Leaderboard Metric Does Not Match The Published Program';
  END IF;

  WITH board AS MATERIALIZED (
    SELECT ranked.user_id, ranked.rank
    FROM public.fn_club_leaderboard_by_dates(
      p_club_id, p_metric, v_start, v_end, 1000000, 0
    ) ranked
    WHERE ranked.qualified
  ), tied AS MATERIALIZED (
    SELECT
      board.user_id,
      board.rank,
      count(*) OVER (PARTITION BY board.rank)::integer AS tie_count,
      row_number() OVER (PARTITION BY board.rank ORDER BY board.user_id)::integer AS tie_order
    FROM board
  ), prizes AS MATERIALIZED (
    SELECT prize.rank, round(prize.amount, 2) AS amount
    FROM jsonb_to_recordset(COALESCE(v_plan -> 'prizes', '[]'::jsonb))
      AS prize(rank integer, amount numeric)
    WHERE prize.amount > 0
  ), pooled AS MATERIALIZED (
    SELECT
      tied.user_id,
      tied.rank,
      tied.tie_count,
      tied.tie_order,
      COALESCE(sum(prizes.amount), 0)::numeric(18,2) AS pool_amount
    FROM tied
    LEFT JOIN prizes
      ON prizes.rank >= tied.rank
     AND prizes.rank < tied.rank + tied.tie_count
    GROUP BY tied.user_id, tied.rank, tied.tie_count, tied.tie_order
  ), winners AS (
    SELECT
      pooled.user_id,
      pooled.rank,
      (
        trunc(pooled.pool_amount / pooled.tie_count, 2)
        + CASE
            WHEN pooled.tie_order <= mod((pooled.pool_amount * 100)::bigint, pooled.tie_count)
              THEN 0.01
            ELSE 0
          END
      )::numeric(18,2) AS amount
    FROM pooled
    WHERE pooled.pool_amount > 0
  )
  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'user_id', winners.user_id,
      'rank', winners.rank,
      'amount', winners.amount
    ) ORDER BY winners.rank, winners.user_id), '[]'::jsonb),
    COALESCE(round(sum(winners.amount), 2), 0)
  INTO v_winners, v_total
  FROM winners;

  IF v_plan ->> 'funding_owner_type' = 'union' THEN
    v_union_id := (v_plan ->> 'funding_union_id')::uuid;
    SELECT COALESCE(wallet.promo_wallet, 0)
    INTO v_promo_available
    FROM public.union_wallets wallet
    WHERE wallet.union_id = v_union_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'LEADERBOARD_PROMO_WALLET_MISSING|Leaderboard Funding Union Has No Promo Wallet';
    END IF;
  ELSE
    SELECT COALESCE(setup.leaderboard_seed_remaining, 0)
    INTO v_seed_available
    FROM public.club_opening_setups setup
    WHERE setup.club_id = p_club_id
    FOR UPDATE;
    -- A CLUB WITH NO OPENING SETUP ROW HOLDS NO SEED (2026-09-23). SELECT INTO
    -- over zero rows assigns NULL, not the COALESCE above: the underfunded test
    -- then read NULL, LEAST() skipped it, the whole round was booked as a seed
    -- that does not exist, and promo_balance was set to NULL. Zero is the only
    -- true value, and it is what every other reader of this column uses.
    v_seed_available := COALESCE(v_seed_available, 0);

    SELECT COALESCE(club.promo_balance, 0), COALESCE(club.chip_treasury, 0)
    INTO v_promo_available, v_bank_available
    FROM public.clubs club
    WHERE club.id = p_club_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'LEADERBOARD_PROMO_WALLET_MISSING|Leaderboard Club Not Found';
    END IF;

    -- THE CLUB BANK OVERLAY OPT-IN (2026-09-23), read from the exact
    -- immutable program version this round is paid under. It is false on
    -- every program published before this migration and on every program
    -- whose owner did not choose it, and it can only be true on a standalone
    -- club's own program (leaderboard_reward_program_overlay_scope).
    SELECT program.overlay_enabled
    INTO v_overlay_enabled
    FROM public.leaderboard_reward_program_versions program
    WHERE program.id = (v_plan ->> 'program_id')::uuid
      AND program.club_id = p_club_id
      AND program.funding_owner_type = 'club';
    v_overlay_enabled := COALESCE(v_overlay_enabled, false);
  END IF;

  IF v_seed_available + v_promo_available < v_total THEN
    IF NOT v_overlay_enabled THEN
      RAISE EXCEPTION
        'LEADERBOARD_PROMO_UNDERFUNDED|Leaderboard Requires % Promo Chips But The Recorded Promo Wallet Holds %',
        v_total,
        v_seed_available + v_promo_available;
    END IF;
    -- Only the SHORTFALL is an overlay, and only a Club Bank that holds all
    -- of it pays it. Otherwise the round stays unpaid and the daily sweep
    -- retries it, exactly as an underfunded round without the opt-in.
    v_overlay := v_total - v_seed_available - v_promo_available;
    IF v_bank_available < v_overlay THEN
      RAISE EXCEPTION
        'LEADERBOARD_PROMO_UNDERFUNDED|Leaderboard Requires % Chips But The Recorded Promo Wallet Holds % And The Club Bank Can Overlay Only %',
        v_total,
        v_seed_available + v_promo_available,
        v_bank_available;
    END IF;
  END IF;

  v_seed_debit := LEAST(v_total, v_seed_available);
  v_seed_release := v_seed_available - v_seed_debit;
  v_promo_debit := v_total - v_seed_debit - v_overlay;

  PERFORM set_config('app.ledger_category', 'leaderboard_payout', true);
  PERFORM set_config('app.ledger_counterparty', 'leaderboard_round', true);
  PERFORM set_config('app.ledger_counterparty_entity', p_club_id::text, true);

  IF v_plan ->> 'funding_owner_type' = 'union' THEN
    UPDATE public.union_wallets
    SET promo_wallet = promo_wallet - v_promo_debit,
        updated_at = now()
    WHERE union_id = v_union_id;
  ELSE
    UPDATE public.clubs
    SET promo_balance = promo_balance - v_promo_debit + v_seed_release,
        updated_at = now()
    WHERE id = p_club_id;

    UPDATE public.club_opening_setups
    SET leaderboard_seed_remaining = 0,
        updated_at = now()
    WHERE club_id = p_club_id AND leaderboard_seed_remaining > 0;

    IF v_overlay > 0 THEN
      -- THE OVERLAY LEG. Its own statement, so the journal writes it as its
      -- own leg: Club Bank to this leaderboard round, category overlay, under
      -- a key that names the round and can be claimed once.
      PERFORM set_config('app.ledger_category', 'overlay', true);
      PERFORM set_config('app.ledger_idempotency_key',
        format('leaderboard-overlay:%s:%s:%s', p_club_id, p_period, v_start), true);
      UPDATE public.clubs
      SET chip_treasury = chip_treasury - v_overlay,
          updated_at = now()
      WHERE id = p_club_id;
      PERFORM set_config('app.ledger_idempotency_key', '', true);
      PERFORM set_config('app.ledger_category', 'leaderboard_payout', true);
    END IF;
  END IF;

  INSERT INTO public.leaderboard_payout_batches (
    club_id, period, period_start, period_end, metric,
    program_id, program_version, program_hash,
    funding_owner_type, funding_union_id,
    total_paid, seed_funded, promo_funded, overlay_funded, winner_count, tie_policy
  ) VALUES (
    p_club_id, p_period, v_start, v_end, p_metric,
    (v_plan ->> 'program_id')::uuid,
    (v_plan ->> 'program_version')::integer,
    v_plan ->> 'program_hash',
    v_plan ->> 'funding_owner_type', v_union_id,
    v_total, v_seed_debit, v_promo_debit, v_overlay, jsonb_array_length(v_winners),
    'split_occupied_places'
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
      RAISE EXCEPTION 'LEADERBOARD_CREDIT_CONFLICT|Leaderboard Credit Key Already Exists Without A Batch Receipt';
    END IF;

    INSERT INTO public.leaderboard_payouts (
      club_id, period, metric, start_date, end_date, user_id, rank,
      payout_amount, payout_currency, awarded_at, batch_id
    ) VALUES (
      p_club_id, p_period, p_metric, v_start, v_end,
      (v_winner ->> 'user_id')::uuid,
      (v_winner ->> 'rank')::integer,
      (v_winner ->> 'amount')::numeric,
      'chips', now(), v_batch_id
    );
  END LOOP;

  UPDATE public.leaderboard_payout_failures
  SET resolved_at = now(),
      resolution = 'Settlement Completed Automatically'
  WHERE club_id = p_club_id
    AND period = p_period
    AND period_start = v_start
    AND resolved_at IS NULL;

  RETURN jsonb_build_object(
    'success', true,
    'already_settled', false,
    'batch_id', v_batch_id,
    'total_paid', v_total,
    'seed_funded', v_seed_debit,
    'promo_funded', v_promo_debit,
    'overlay_funded', v_overlay,
    'winner_count', jsonb_array_length(v_winners),
    'tie_policy', 'split_occupied_places'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_payout_leaderboard(uuid, text, text, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_payout_leaderboard(uuid, text, text, timestamptz, timestamptz)
  TO service_role;

DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_payout_leaderboard(uuid,text,text,timestamptz,timestamptz)')
       AND md5(p.prosrc) = '2ba8db49240eac826b2f3efe0e262648'
       AND md5(pg_get_functiondef(p.oid)) = '42b7add95575407dcc35229c3741bd4f'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND (SELECT string_agg(e.grant_text, ',' ORDER BY e.grant_text)
              FROM (SELECT CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(g.grantee) END
                           || ':' || g.privilege_type AS grant_text
                      FROM aclexplode(p.proacl) g) e) = 'postgres:EXECUTE,service_role:EXECUTE'
       AND p.prosecdef
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION 'NO_SETUP_ROW_SEED_POSTIMAGE_DRIFT';
  END IF;
END
$post$;

COMMIT;
