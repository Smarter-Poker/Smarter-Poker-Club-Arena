-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820125610 "union_law_chip_supply_monitor_counts_club_wallets"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e18377e862022f99029866c2528b9e8b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- UNION LAW — CHIP SUPPLY MONITOR MUST COUNT CLUB WALLETS (2026-08-20, pass 5)
--
-- REGRESSION INTRODUCED BY CLUB-SCOPED CHIPS: fn_snapshot_chip_supply measures
-- holdings as (wallets_total + cash_table_stacks). Club chips live in
-- club_members.chip_balance, which it does not count. So under club scoping:
--
--   buy-in 200 from a club wallet
--     -> club_members -200   (INVISIBLE to the monitor)
--     -> table stack  +200   (counted)  => delta_holdings  +200
--     -> wallet_transactions debit 200  => delta_tx_net    -200
--     -> unexplained_delta = +200 - (-200) = +400
--
-- Every club-scoped buy-in would therefore report an unexplained delta of
-- roughly twice its size — burying a genuine leak in false alarms, which is
-- worse than having no monitor at all.
--
-- Club wallets are now a first-class term in holdings. Snapshots taken before
-- this change did not measure club chips, so they are marked non-comparable
-- (same guard the tournament_stacks fix used) and the next snapshot becomes a
-- clean baseline instead of emitting one huge bogus delta.
-- ============================================================================

ALTER TABLE public.chip_supply_snapshots
  ADD COLUMN IF NOT EXISTS club_wallets_total numeric;

COMMENT ON COLUMN public.chip_supply_snapshots.club_wallets_total IS
  'Sum of club_members.chip_balance — per-club player chips under UNION LAW '
  'club-scoped custody. NULL on snapshots taken before 2026-08-20, which are '
  'therefore not delta-comparable.';

CREATE OR REPLACE FUNCTION public.fn_snapshot_chip_supply()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_prev  public.chip_supply_snapshots%ROWTYPE;
  v_new   public.chip_supply_snapshots%ROWTYPE;
  v_w numeric; v_l numeric; v_wc integer;
  v_cash numeric; v_tourney numeric; v_sc integer;
  v_c numeric; v_d numeric;
  v_cbc jsonb; v_dbc jsonb;
  v_club numeric;
  v_comparable boolean;
  v_hold_now numeric; v_hold_prev numeric;
BEGIN
  SELECT COALESCE(sum(balance),0), COALESCE(sum(COALESCE(locked_balance,0)),0), count(*)
    INTO v_w, v_l, v_wc
  FROM public.wallets;

  -- UNION LAW: per-club player chips are real holdings and must be counted.
  SELECT COALESCE(sum(COALESCE(chip_balance,0)), 0) INTO v_club FROM public.club_members;

  -- Cash seats and tournament seats are different currencies. Keep them apart.
  SELECT
    COALESCE(sum(ts.stack) FILTER (WHERE t.tournament_id IS NULL), 0),
    COALESCE(sum(ts.stack) FILTER (WHERE t.tournament_id IS NOT NULL), 0),
    count(*)
    INTO v_cash, v_tourney, v_sc
  FROM public.table_seats ts
  JOIN public.tables t ON t.id = ts.table_id
  WHERE ts.left_at IS NULL;

  WITH agg AS (
    SELECT type, category, sum(amount) AS total
    FROM public.wallet_transactions
    GROUP BY type, category
  )
  SELECT
    COALESCE(sum(total) FILTER (WHERE type = 'credit'), 0),
    COALESCE(sum(total) FILTER (WHERE type = 'debit'),  0),
    COALESCE(jsonb_object_agg(category, round(total,2)) FILTER (WHERE type = 'credit'), '{}'::jsonb),
    COALESCE(jsonb_object_agg(category, round(total,2)) FILTER (WHERE type = 'debit'),  '{}'::jsonb)
    INTO v_c, v_d, v_cbc, v_dbc
  FROM agg;

  SELECT * INTO v_prev
  FROM public.chip_supply_snapshots
  ORDER BY taken_at DESC LIMIT 1;

  -- Only difference against a row measured the SAME way. Rows predating the
  -- tournament split, or predating club-wallet accounting, are not comparable.
  v_comparable := v_prev.id IS NOT NULL
                  AND v_prev.tournament_stacks IS NOT NULL
                  AND v_prev.club_wallets_total IS NOT NULL;

  v_hold_now  := v_w + v_club + v_cash;
  v_hold_prev := CASE WHEN v_comparable
                      THEN v_prev.wallets_total + v_prev.club_wallets_total + v_prev.table_stacks
                      END;

  INSERT INTO public.chip_supply_snapshots (
    wallets_total, wallets_locked, club_wallets_total, table_stacks, tournament_stacks,
    tx_credits, tx_debits, wallet_count, seat_count,
    credits_by_category, debits_by_category,
    delta_holdings, delta_tx_net, unexplained_delta
  )
  VALUES (
    v_w, v_l, v_club, v_cash, v_tourney, v_c, v_d, v_wc, v_sc, v_cbc, v_dbc,
    CASE WHEN NOT v_comparable THEN NULL ELSE v_hold_now - v_hold_prev END,
    CASE WHEN NOT v_comparable THEN NULL
         ELSE (v_c - v_d) - (v_prev.tx_credits - v_prev.tx_debits) END,
    CASE WHEN NOT v_comparable THEN NULL
         ELSE (v_hold_now - v_hold_prev)
              - ((v_c - v_d) - (v_prev.tx_credits - v_prev.tx_debits)) END
  )
  RETURNING * INTO v_new;

  RETURN jsonb_build_object(
    'ok', true,
    'snapshot_id', v_new.id,
    'taken_at', v_new.taken_at,
    'holdings', v_hold_now,
    'wallets_total', v_w,
    'club_wallets_total', v_club,
    'cash_table_stacks', v_cash,
    'tournament_stacks', v_tourney,
    'tx_net', v_c - v_d,
    'delta_holdings', v_new.delta_holdings,
    'delta_tx_net', v_new.delta_tx_net,
    'unexplained_delta', v_new.unexplained_delta,
    'is_baseline', NOT v_comparable
  );
END;
$function$;

