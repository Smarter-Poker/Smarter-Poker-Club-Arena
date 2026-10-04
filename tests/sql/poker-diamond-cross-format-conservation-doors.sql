-- ============================================================================
-- THE INSTALLED READERS THIS FIXTURE PROVES, IN PRODUCTION'S EXACT TEXT
-- ============================================================================
--
-- Every function below is pg_get_functiondef() as read from production
-- (project kuklfnapbkmacvwxktbh) on 2026-10-04 through the Supabase MCP
-- inside BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY. Not one
-- byte is edited, which is the point: the runner asserts
-- md5(pg_get_functiondef(oid)) of each one against
-- diamond-cross-format-conservation-doors.manifest.json, and the migration
-- under test pins the same md5s. A fixture that reproduced its own idea of
-- these functions would prove nothing about the ones production runs.
--
-- Created in dependency order: fn_ca_diamond_register_vs_supply is LANGUAGE
-- sql and is parsed at creation, so fn_ca_arena_diamonds exists first. The
-- plpgsql bodies resolve at run time and need no ordering.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_ca_arena_diamonds()
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT (SELECT COALESCE(sum(balance),0)::numeric FROM public.poker_diamond_custody)
   +(SELECT COALESCE(sum(pending_diamonds),0)::numeric FROM public.diamond_spin_days WHERE status='open');
$function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_capture_freeze_mark(p_kind text)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_win TIMESTAMPTZ; m NUMERIC; f NUMERIC; t NUMERIC; i INTEGER := 0;
BEGIN
  IF p_kind NOT IN ('pre','post') THEN
    RAISE EXCEPTION 'p_kind must be pre or post, got %', p_kind;
  END IF;
  v_win := CASE WHEN p_kind = 'pre'
                THEN date_trunc('hour', now()) + interval '1 hour'
                ELSE date_trunc('hour', now() + interval '2 minutes') END;
  -- A pre mark taken before the freeze engages measures three seconds of live
  -- play, not the freeze. Wait for the platform to actually be frozen.
  IF p_kind = 'pre' THEN
    WHILE NOT public.fn_platform_frozen() AND i < 25 LOOP
      PERFORM pg_sleep(1); i := i + 1;
    END LOOP;
  END IF;
  SELECT member_wallets, on_the_felt, total INTO m, f, t FROM public.fn_ca_circulation_total();
  INSERT INTO public.ca_freeze_circulation_marks (window_hour, kind, member_wallets, on_the_felt, total)
  VALUES (v_win, p_kind, m, f, t)
  ON CONFLICT (window_hour, kind) DO UPDATE
     SET member_wallets = EXCLUDED.member_wallets,
         on_the_felt    = EXCLUDED.on_the_felt,
         total          = EXCLUDED.total,
         mark_at        = now();
  RETURN v_win;
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_register_vs_supply()
 RETURNS TABLE(register_net numeric, meter_total numeric, player_diamonds numeric, house_diamonds numeric, difference numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH r AS (SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) AS net
               FROM public.ca_mint_ledger WHERE asset = 'diamonds'),
       p AS (SELECT COALESCE(SUM(COALESCE(diamonds, 0)), 0)::numeric AS held FROM public.profiles),
       h AS (SELECT COALESCE(SUM(COALESCE(balance, 0)), 0)::numeric AS held FROM public.ca_diamond_house)
  SELECT round(r.net, 2), round(p.held + h.held + public.fn_ca_arena_diamonds(), 2), round(p.held, 2), round(h.held, 2),
         round(p.held + h.held + public.fn_ca_arena_diamonds() - r.net, 2)
    FROM r, p, h;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_circulation_total()
 RETURNS TABLE(member_wallets numeric, on_the_felt numeric, total numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    COALESCE((SELECT sum(chip_balance) FROM public.club_members), 0)::numeric,
    COALESCE((SELECT sum(stack) FROM public.table_seats WHERE left_at IS NULL), 0)::numeric,
    COALESCE((SELECT sum(chip_balance) FROM public.club_members), 0)::numeric
      + COALESCE((SELECT sum(stack) FROM public.table_seats WHERE left_at IS NULL), 0)::numeric;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_club_chip_circulation(p_club_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(club_id uuid, club_name text, member_wallets numeric, on_the_felt numeric, treasury numeric, total numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT c.id, c.name,
         COALESCE((SELECT SUM(cm.chip_balance) FROM public.club_members cm
                    WHERE cm.club_id = c.id), 0),
         COALESCE((SELECT SUM(ts.stack) FROM public.table_seats ts
                    WHERE ts.club_id = c.id AND ts.left_at IS NULL), 0),
         COALESCE(c.chip_pool, 0),
         COALESCE((SELECT SUM(cm.chip_balance) FROM public.club_members cm
                    WHERE cm.club_id = c.id), 0)
         + COALESCE((SELECT SUM(ts.stack) FROM public.table_seats ts
                      WHERE ts.club_id = c.id AND ts.left_at IS NULL), 0)
         + COALESCE(c.chip_pool, 0)
  FROM public.clubs c
  WHERE p_club_id IS NULL OR c.id = p_club_id
  ORDER BY 6 DESC;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_snapshot_chip_supply()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
END; $function$
;
