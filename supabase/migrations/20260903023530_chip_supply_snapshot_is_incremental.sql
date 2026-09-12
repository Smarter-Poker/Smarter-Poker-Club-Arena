-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260903023530; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260903023530   (the stamp IS the apply time, UTC: 2026-09-03 02:35:30)
--   name        chip_supply_snapshot_is_incremental
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 5460 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260903023530 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_snapshot_chip_supply
--
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- CHIP SUPPLY SNAPSHOT IS INCREMENTAL (2026-09-03)
-- fn_snapshot_chip_supply summed the entire wallet_transactions ledger
-- (2.57M rows, 1 GB, +48k rows/day) every hour at :00, alongside every other
-- hourly job, and hit the 8s service_role statement timeout 18 times in 24h
-- (Hetzner dispatcher journal). The previous snapshot already carries the
-- running totals; only rows written since it are new. Probed in a rolled-back
-- transaction first: 0.058s, tx_net identical to a fresh full scan
-- (-27,093,439.32 both ways), per-category drift 0.00.
-- Supporting index idx_wallet_tx_created_at was built CONCURRENTLY beforehand
-- (55 MB, valid) so no write lock was taken on the ledger.
-- Falls back to the full scan when the previous row lacks totals (baseline).
CREATE OR REPLACE FUNCTION public.fn_snapshot_chip_supply()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_prev public.chip_supply_snapshots%ROWTYPE; v_new public.chip_supply_snapshots%ROWTYPE;
  v_w numeric; v_l numeric; v_wc integer; v_cash numeric; v_tourney numeric; v_sc integer;
  v_c numeric; v_d numeric; v_cbc jsonb; v_dbc jsonb; v_club numeric;
  v_comparable boolean; v_incremental boolean; v_hold_now numeric; v_hold_prev numeric;
  v_since timestamptz; v_now timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO v_prev FROM public.chip_supply_snapshots ORDER BY taken_at DESC LIMIT 1;
  SELECT COALESCE(sum(balance),0), COALESCE(sum(COALESCE(locked_balance,0)),0), count(*) INTO v_w, v_l, v_wc FROM public.wallets;
  -- UNION LAW: per-club player chips are real holdings and must be counted.
  SELECT COALESCE(sum(COALESCE(chip_balance,0)), 0) INTO v_club FROM public.club_members;
  -- Cash seats and tournament seats are different currencies. Keep them apart.
  SELECT COALESCE(sum(ts.stack) FILTER (WHERE t.tournament_id IS NULL), 0), COALESCE(sum(ts.stack) FILTER (WHERE t.tournament_id IS NOT NULL), 0), count(*)
    INTO v_cash, v_tourney, v_sc FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id WHERE ts.left_at IS NULL;
  -- INCREMENTAL LEDGER TOTALS: previous snapshot totals + rows since it.
  v_incremental := v_prev.id IS NOT NULL AND v_prev.tx_credits IS NOT NULL AND v_prev.tx_debits IS NOT NULL
                   AND v_prev.credits_by_category IS NOT NULL AND v_prev.debits_by_category IS NOT NULL;
  IF v_incremental THEN
    v_since := v_prev.taken_at;
    WITH agg AS (SELECT type, category, sum(amount) AS total FROM public.wallet_transactions WHERE created_at > v_since AND created_at <= v_now GROUP BY type, category),
    merged_c AS (SELECT key, sum(val) AS total FROM (SELECT key, value::numeric AS val FROM jsonb_each_text(v_prev.credits_by_category) UNION ALL SELECT category, total FROM agg WHERE type='credit') s GROUP BY key),
    merged_d AS (SELECT key, sum(val) AS total FROM (SELECT key, value::numeric AS val FROM jsonb_each_text(v_prev.debits_by_category)  UNION ALL SELECT category, total FROM agg WHERE type='debit')  s GROUP BY key)
    SELECT v_prev.tx_credits + COALESCE((SELECT sum(total) FROM agg WHERE type='credit'),0),
           v_prev.tx_debits  + COALESCE((SELECT sum(total) FROM agg WHERE type='debit'),0),
           COALESCE((SELECT jsonb_object_agg(key, round(total,2)) FROM merged_c),'{}'::jsonb),
           COALESCE((SELECT jsonb_object_agg(key, round(total,2)) FROM merged_d),'{}'::jsonb)
    INTO v_c, v_d, v_cbc, v_dbc;
  ELSE
    WITH agg AS (SELECT type, category, sum(amount) AS total FROM public.wallet_transactions WHERE created_at <= v_now GROUP BY type, category)
    SELECT COALESCE(sum(total) FILTER (WHERE type='credit'),0), COALESCE(sum(total) FILTER (WHERE type='debit'),0),
           COALESCE(jsonb_object_agg(category, round(total,2)) FILTER (WHERE type='credit'),'{}'::jsonb),
           COALESCE(jsonb_object_agg(category, round(total,2)) FILTER (WHERE type='debit'),'{}'::jsonb)
    INTO v_c, v_d, v_cbc, v_dbc FROM agg;
  END IF;
  -- Only difference against a row measured the SAME way.
  v_comparable := v_prev.id IS NOT NULL AND v_prev.tournament_stacks IS NOT NULL AND v_prev.club_wallets_total IS NOT NULL;
  v_hold_now := v_w + v_club + v_cash;
  v_hold_prev := CASE WHEN v_comparable THEN v_prev.wallets_total + v_prev.club_wallets_total + v_prev.table_stacks END;
  INSERT INTO public.chip_supply_snapshots (taken_at, wallets_total, wallets_locked, club_wallets_total, table_stacks, tournament_stacks, tx_credits, tx_debits, wallet_count, seat_count, credits_by_category, debits_by_category, delta_holdings, delta_tx_net, unexplained_delta)
  VALUES (v_now, v_w, v_l, v_club, v_cash, v_tourney, v_c, v_d, v_wc, v_sc, v_cbc, v_dbc,
    CASE WHEN NOT v_comparable THEN NULL ELSE v_hold_now - v_hold_prev END,
    CASE WHEN NOT v_comparable THEN NULL ELSE (v_c - v_d) - (v_prev.tx_credits - v_prev.tx_debits) END,
    CASE WHEN NOT v_comparable THEN NULL ELSE (v_hold_now - v_hold_prev) - ((v_c - v_d) - (v_prev.tx_credits - v_prev.tx_debits)) END)
  RETURNING * INTO v_new;
  RETURN jsonb_build_object('ok', true, 'snapshot_id', v_new.id, 'taken_at', v_new.taken_at, 'holdings', v_hold_now, 'wallets_total', v_w, 'club_wallets_total', v_club, 'cash_table_stacks', v_cash, 'tournament_stacks', v_tourney, 'tx_net', v_c - v_d, 'delta_holdings', v_new.delta_holdings, 'delta_tx_net', v_new.delta_tx_net, 'unexplained_delta', v_new.unexplained_delta, 'is_baseline', NOT v_comparable, 'incremental', v_incremental);
END; $fn$;
