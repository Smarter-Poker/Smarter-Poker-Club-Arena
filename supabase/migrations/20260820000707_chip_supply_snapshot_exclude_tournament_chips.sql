-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820000707 "chip_supply_snapshot_exclude_tournament_chips"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 bf85af789ab1b6ad7179a5cb5b62e6a9 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- CHIP SUPPLY MONITOR — STOP COUNTING TOURNAMENT SCRIP AS MONEY (2026-08-19)
--
-- THE BUG: fn_snapshot_chip_supply summed EVERY seat stack
--     SELECT sum(stack) FROM table_seats WHERE left_at IS NULL
-- and compared the result against wallet_transactions cash flows.
--
-- But a tournament seat's `stack` is TOURNAMENT CHIPS — granted from
-- tournaments.starting_chips, never bought with wallet money. A 10-chip
-- buy-in grants 10,000 tournament chips. They are a different unit entirely.
--
-- Measured at the time of this fix: of 31,166,604 chips sitting on seats,
-- 31,080,208 (99.7%) were tournament scrip across 1,027 seats, against just
-- 86,396 in real cash chips across 191 seats. So every tournament that starts
-- injected millions of "unexplained delta" into a money-supply monitor.
-- The last eight hourly snapshots reported 0.6M–4.4M unexplained, every hour,
-- forever.
--
-- That is worse than having no monitor: a number that always screams is a
-- number nobody reads, and it would have masked a real conservation break.
--
-- FIX: cash stacks and tournament stacks are recorded separately, and the
-- conservation delta is computed against CASH stacks only — the pool that is
-- actually conserved against wallet flows. Tournament chips are still
-- recorded, for visibility, but never differenced against money.
--
-- Historical rows used the old (mixed) definition, so the first snapshot after
-- this change would otherwise show a ~31M phantom drop. Rows are therefore
-- treated as a fresh baseline until one exists with the new definition.
-- ============================================================================

ALTER TABLE chip_supply_snapshots ADD COLUMN IF NOT EXISTS tournament_stacks numeric;

COMMENT ON COLUMN chip_supply_snapshots.table_stacks IS
  'CASH table stacks only (tournament_id IS NULL). Tournament chips are scrip, not money — see tournament_stacks.';
COMMENT ON COLUMN chip_supply_snapshots.tournament_stacks IS
  'Tournament seat stacks. Recorded for visibility; never differenced against wallet flows.';

CREATE OR REPLACE FUNCTION public.fn_snapshot_chip_supply()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_prev  public.chip_supply_snapshots%ROWTYPE;
  v_new   public.chip_supply_snapshots%ROWTYPE;
  v_w numeric; v_l numeric; v_wc integer;
  v_cash numeric; v_tourney numeric; v_sc integer;
  v_c numeric; v_d numeric;
  v_cbc jsonb; v_dbc jsonb;
  v_comparable boolean;
BEGIN
  SELECT COALESCE(sum(balance),0), COALESCE(sum(COALESCE(locked_balance,0)),0), count(*)
    INTO v_w, v_l, v_wc
  FROM public.wallets;

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

  -- Only difference against a row measured the same way. Pre-fix rows mixed
  -- tournament scrip into table_stacks and are not comparable.
  v_comparable := v_prev.id IS NOT NULL AND v_prev.tournament_stacks IS NOT NULL;

  INSERT INTO public.chip_supply_snapshots (
    wallets_total, wallets_locked, table_stacks, tournament_stacks,
    tx_credits, tx_debits, wallet_count, seat_count,
    credits_by_category, debits_by_category,
    delta_holdings, delta_tx_net, unexplained_delta
  )
  VALUES (
    v_w, v_l, v_cash, v_tourney, v_c, v_d, v_wc, v_sc, v_cbc, v_dbc,
    CASE WHEN NOT v_comparable THEN NULL
         ELSE (v_w + v_cash) - (v_prev.wallets_total + v_prev.table_stacks) END,
    CASE WHEN NOT v_comparable THEN NULL
         ELSE (v_c - v_d) - (v_prev.tx_credits - v_prev.tx_debits) END,
    CASE WHEN NOT v_comparable THEN NULL
         ELSE ((v_w + v_cash) - (v_prev.wallets_total + v_prev.table_stacks))
              - ((v_c - v_d) - (v_prev.tx_credits - v_prev.tx_debits)) END
  )
  RETURNING * INTO v_new;

  RETURN jsonb_build_object(
    'ok', true,
    'snapshot_id', v_new.id,
    'taken_at', v_new.taken_at,
    'holdings', v_w + v_cash,
    'wallets_total', v_w,
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

-- Establish the new baseline immediately so the next hourly run is comparable.
DO $$ BEGIN PERFORM fn_snapshot_chip_supply(); END $$;
