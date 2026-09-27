-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820024304 "rakeback_close_redistributes_union_attributed_rake"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a00c78ebd0e5bba80a131de47bafbb78 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- 90% RAKEBACK REACHES THE CLUBS AGAIN (2026-08-19)
--
-- Dan: "all clubs inside the union get their rake back every monday morning.
-- 90% rake back." And: "rake is held by the union, but players inside the
-- clubs generate the rake."
--
-- THE BREAK. This function built its payout basis by grouping
-- union_wallet_transactions on club_id and then paying every club EXCEPT the
-- union's own row. That was right while each game belonged to a member club.
-- Now that all games are created BY the union, every rake credit carries
-- club_id = <union id>, so the basis collapsed to one self-club row, the payout
-- loop skipped it, and this Monday JAQK and SHARK would have received NOTHING
-- while the union retained 100%.
--
-- THE FIX. Rake credited to the union is split across member clubs by WHOSE
-- PLAYERS PAID IT, via fn_union_rake_basis_by_club (weighted by
-- rake_records.player_contributions — the same weighting the per-player
-- rakeback settler already uses, grouped one level up).
--
-- Rake still credited directly to a member club (legacy rows) keeps its
-- existing treatment, so nothing about historical periods changes.
--
-- If attribution cannot account for the union-held rake (no contribution data
-- in the window), the unattributable remainder is RETAINED rather than
-- silently spread — a club is never paid on a number that was guessed.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_union_weekly_rakeback_close(
  p_union_id uuid, p_period_start timestamptz, p_period_end timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_wallet       public.union_wallets%ROWTYPE;
  v_period_total numeric := 0;
  v_payout_total numeric := 0;
  v_retained     numeric := 0;
  v_clubs_paid   integer := 0;
  v_club         record;
  v_rw_debit     numeric;
  v_new_rw       numeric;
  v_new_cb       numeric;
  v_credit       jsonb;
  v_union_held   numeric := 0;
  v_basis_total  numeric := 0;
BEGIN
  IF p_union_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
     OR p_period_end <= p_period_start THEN
    RETURN jsonb_build_object('success', false, 'error', 'bad_params');
  END IF;

  IF EXISTS (SELECT 1 FROM union_rakeback_log
              WHERE union_id = p_union_id AND period_start = p_period_start AND period_end = p_period_end) THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_executed');
  END IF;

  SELECT * INTO v_wallet FROM union_wallets WHERE union_id = p_union_id FOR UPDATE;
  IF v_wallet.union_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_wallet');
  END IF;

  -- Rake credited straight to a member club (legacy attribution).
  DROP TABLE IF EXISTS _uwrb;
  CREATE TEMP TABLE _uwrb ON COMMIT DROP AS
  SELECT t.club_id,
         SUM(t.amount) AS rake_in,
         trunc(SUM(t.amount) * COALESCE(uc.club_commission_rate, 0.90) * 100) / 100 AS payout
    FROM union_wallet_transactions t
    LEFT JOIN union_clubs uc ON uc.union_id = t.union_id AND uc.club_id = t.club_id
   WHERE t.union_id = p_union_id
     AND t.wallet = 'rake_wallet' AND t.direction = 'credit' AND t.tx_type = 'rake'
     AND t.created_at >= p_period_start AND t.created_at < p_period_end
     AND t.club_id IS NOT NULL AND t.club_id <> p_union_id
   GROUP BY t.club_id, uc.club_commission_rate;

  -- Rake held by the union (club_id = union, or unattributed): split it by
  -- whose players generated it, then apply each club's commission rate.
  SELECT COALESCE(SUM(t.amount), 0) INTO v_union_held
    FROM union_wallet_transactions t
   WHERE t.union_id = p_union_id
     AND t.wallet = 'rake_wallet' AND t.direction = 'credit' AND t.tx_type = 'rake'
     AND t.created_at >= p_period_start AND t.created_at < p_period_end
     AND (t.club_id IS NULL OR t.club_id = p_union_id);

  IF v_union_held > 0 THEN
    DROP TABLE IF EXISTS _basis;
    CREATE TEMP TABLE _basis ON COMMIT DROP AS
      SELECT b.club_id, b.rake_share
        FROM fn_union_rake_basis_by_club(p_union_id, p_period_start, p_period_end) b
        JOIN union_clubs uc ON uc.union_id = p_union_id AND uc.club_id = b.club_id
       WHERE b.rake_share > 0;

    SELECT COALESCE(SUM(rake_share), 0) INTO v_basis_total FROM _basis;

    IF v_basis_total > 0 THEN
      INSERT INTO _uwrb (club_id, rake_in, payout)
      SELECT bs.club_id,
             round(v_union_held * bs.rake_share / v_basis_total, 2),
             trunc(round(v_union_held * bs.rake_share / v_basis_total, 2)
                   * COALESCE(uc.club_commission_rate, 0.90) * 100) / 100
        FROM _basis bs
        LEFT JOIN union_clubs uc ON uc.union_id = p_union_id AND uc.club_id = bs.club_id;
    END IF;
    -- No contribution data: the union keeps it rather than guessing a split.
  END IF;

  SELECT COALESCE(SUM(rake_in), 0) INTO v_period_total FROM _uwrb;
  v_period_total := GREATEST(v_period_total, v_union_held);
  SELECT COALESCE(SUM(payout), 0) INTO v_payout_total
    FROM _uwrb WHERE club_id IS NOT NULL AND club_id <> p_union_id;

  IF v_period_total <= 0 THEN
    INSERT INTO union_rakeback_log (union_id, period_start, period_end, total_rakeback, executed_at)
    VALUES (p_union_id, p_period_start, p_period_end, 0, now());
    RETURN jsonb_build_object('success', true, 'clubs_paid', 0, 'period_rake', 0,
                              'total_rakeback', 0, 'union_retained', 0, 'note', 'no_rake');
  END IF;

  IF v_payout_total > COALESCE(v_wallet.rake_wallet, 0) THEN
    INSERT INTO financial_alerts (severity, source, message, context)
    VALUES ('critical', 'fn_union_weekly_rakeback_close',
      'Weekly union rakeback REJECTED: payout exceeds the rake treasury',
      jsonb_build_object('union_id', p_union_id, 'period_start', p_period_start,
        'period_end', p_period_end, 'payout', v_payout_total, 'rake_wallet', v_wallet.rake_wallet));
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_treasury',
      'payout', v_payout_total, 'rake_wallet', v_wallet.rake_wallet);
  END IF;

  FOR v_club IN SELECT club_id, rake_in, payout FROM _uwrb
                 WHERE club_id IS NOT NULL AND club_id <> p_union_id AND payout > 0
  LOOP
    v_credit := fn_credit_treasury(
      v_club.club_id, v_club.payout,
      'Union weekly rakeback ' || to_char(p_period_start,'YYYY-MM-DD') || '..' || to_char(p_period_end,'YYYY-MM-DD'),
      jsonb_build_object('union_id', p_union_id, 'period_start', p_period_start,
                         'period_end', p_period_end, 'rake_basis', v_club.rake_in,
                         'rate', 'club_commission_rate'));
    IF COALESCE((v_credit->>'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'treasury credit failed for club %: %', v_club.club_id, v_credit;
    END IF;
    v_clubs_paid := v_clubs_paid + 1;
  END LOOP;

  v_retained := round(v_period_total - v_payout_total, 2);
  v_rw_debit := LEAST(v_period_total, COALESCE(v_wallet.rake_wallet, 0));

  UPDATE union_wallets
     SET rake_wallet       = round(rake_wallet - v_rw_debit, 2),
         chip_balance      = round(chip_balance + v_retained, 2),
         total_settlements = round(COALESCE(total_settlements, 0) + v_payout_total, 2),
         updated_at        = now()
   WHERE union_id = p_union_id
   RETURNING rake_wallet, chip_balance INTO v_new_rw, v_new_cb;

  INSERT INTO union_wallet_transactions
    (union_id, club_id, amount, tx_type, wallet, direction, balance_after, notes)
  SELECT p_union_id, club_id, payout, 'rakeback', 'rake_wallet', 'debit', v_new_rw,
         'Weekly 90% rakeback to club (period ' || to_char(p_period_start,'YYYY-MM-DD')
           || '..' || to_char(p_period_end,'YYYY-MM-DD') || ')'
    FROM _uwrb WHERE club_id IS NOT NULL AND club_id <> p_union_id AND payout > 0;

  IF v_retained > 0 THEN
    INSERT INTO union_wallet_transactions
      (union_id, amount, tx_type, wallet, direction, balance_after, notes)
    VALUES
      (p_union_id, v_retained, 'rake_hold', 'rake_wallet', 'debit', v_new_rw,
       'Union retained share leaves the rake treasury (period '
         || to_char(p_period_start,'YYYY-MM-DD') || '..' || to_char(p_period_end,'YYYY-MM-DD') || ')'),
      (p_union_id, v_retained, 'rake_hold', 'chip_balance', 'credit', v_new_cb,
       'Union retained share earned into the Union Bank (period '
         || to_char(p_period_start,'YYYY-MM-DD') || '..' || to_char(p_period_end,'YYYY-MM-DD') || ')');
  END IF;

  INSERT INTO union_rakeback_log (union_id, period_start, period_end, total_rakeback, executed_at)
  VALUES (p_union_id, p_period_start, p_period_end, v_payout_total, now());

  RETURN jsonb_build_object('success', true, 'clubs_paid', v_clubs_paid,
    'period_rake', v_period_total, 'total_rakeback', v_payout_total,
    'union_retained', v_retained, 'union_held_redistributed', v_union_held,
    'rake_wallet_after', v_new_rw, 'chip_balance_after', v_new_cb);
END $function$;
