CREATE OR REPLACE FUNCTION public.fn_enforce_leaderboard_program_funding()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_balance numeric := 0;
  v_other_commitments numeric := 0;
  v_requested_commitment numeric := 0;
BEGIN
  v_requested_commitment := public.fn_leaderboard_program_commitment(
    NEW.rewards_enabled,
    NEW.weekly_prizes,
    NEW.monthly_prizes
  );

  IF NOT NEW.rewards_enabled THEN
    RETURN NEW;
  END IF;

  IF NEW.funding_owner_type = 'union' THEN
    IF NEW.funding_union_id IS NULL THEN
      RAISE EXCEPTION 'A Union-Funded Leaderboard Requires A Funding Union'
        USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(wallet.promo_wallet, 0)
      INTO v_balance
      FROM public.union_wallets wallet
     WHERE wallet.union_id = NEW.funding_union_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Leaderboard Funding Union Has No Promo Wallet'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.funding_owner_type = 'club' THEN
    IF NEW.funding_union_id IS NOT NULL THEN
      RAISE EXCEPTION 'A Standalone Club Leaderboard Cannot Name A Funding Union'
        USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(club.promo_balance, 0)
      INTO v_balance
      FROM public.clubs club
     WHERE club.id = NEW.club_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Club Not Found' USING ERRCODE = 'P0002';
    END IF;

    -- Only the actual Promo Wallet contributes publication capacity.
  ELSE
    RAISE EXCEPTION 'Leaderboard Funding Owner Must Be A Union Or Club'
      USING ERRCODE = '23514';
  END IF;

  WITH latest AS MATERIALIZED (
    SELECT DISTINCT ON (program.club_id)
      program.club_id,
      program.rewards_enabled,
      program.weekly_prizes,
      program.monthly_prizes,
      program.funding_owner_type,
      program.funding_union_id
    FROM public.leaderboard_reward_program_versions program
    WHERE program.club_id <> NEW.club_id
    ORDER BY program.club_id, program.version DESC
  )
  SELECT COALESCE(sum(public.fn_leaderboard_program_commitment(
    latest.rewards_enabled,
    latest.weekly_prizes,
    latest.monthly_prizes
  )), 0)
  INTO v_other_commitments
  FROM latest
  WHERE NEW.funding_owner_type = 'union'
    AND latest.funding_owner_type = 'union'
    AND latest.funding_union_id = NEW.funding_union_id;

  IF v_requested_commitment + v_other_commitments > v_balance THEN
    RAISE EXCEPTION
      'Leaderboard Prize Program Requires % Promo Chips But Only % Are Available After Other Published Commitments',
      round(v_requested_commitment, 2),
      round(GREATEST(v_balance - v_other_commitments, 0), 2)
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$
