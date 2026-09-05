-- 20260905041033_one_mint_for_diamonds_the_register_follows_the_diamond_journ.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ONE MINT FOR DIAMONDS - THE REGISTER FOLLOWS THE DIAMOND JOURNAL
-- (diamond standard, 2026-09-05)
--
-- Dan (2026-09-04, verbatim): "ALL DIAMOND WALLETS NEED TO BE CONNECTED TO
-- 'THE MINT' THATS WHERE ALL PURCHASED DIAMONDS COME FROM, AND ALL 'EARNED'
-- DIAMONDS DERIVE AND SEND FROM THE MINT. MAKE SURE THAT FUNCTIONALITY IS
-- FULLY BUILT, AND IMPLEMENTED."
--
-- MEASURED BEFORE THIS MIGRATION (production, 2026-09-05 04:00 UTC)
--   The chip side has had "the register follows the journal" since Phase 3.1
--   (20260904183408): every chip_ledger leg out of a non-circulating store
--   gets a ca_mint_ledger row at commit, whatever door wrote it. The diamond
--   side had NOTHING of the kind. ca_mint_ledger held diamond rows from
--   exactly four writers - the 2026-09-03 opening baseline, fn_ca_mint seeds
--   (632 rows, 316,000), fn_ca_burn deletions (307 rows, 920,425) - and the
--   register's diamond net stood at 418,767 against 1,030,607 diamonds in
--   player balances. Every purchase (add_diamonds_to_balance type
--   'purchase'), every reward (award_diamonds_v2, daily_login, training,
--   easter_egg, tournament_prize ...), every refund and every spend
--   (deduct_diamonds: throwables, time banks, VIP, club shop, merch, chip
--   mint) reached a wallet with no register row. The Mint did not know about
--   them. 20 functions write profiles.diamonds; all of them journal to
--   diamond_transactions, so the journal is the one door.
--
-- WHAT THIS DOES, IN ORDER
--   1. THE REGISTER FOLLOWS THE DIAMOND JOURNAL. An AFTER INSERT trigger on
--      diamond_transactions: a positive row that is not a player-to-player
--      transfer is an ISSUANCE from the Mint (register 'mint', holder the
--      player, origin purchase / reward / promotion / refund / adjustment /
--      arena); a negative row that is not a transfer is a RETIREMENT to the
--      Mint ('burn', origin spend / bridge / adjustment). Rows fn_ca_mint and
--      fn_ca_burn write themselves (source = 'the_mint') are already
--      registered and are skipped. Transfers move supply between players
--      and create none. Bookkeeping never blocks money: a register failure
--      files a DR incident and the journal row stands.
--   2. ORIGIN SAYS WHERE A DIAMOND CAME FROM. The generated `origin` column
--      learns the diamond-journal prefixes, so the Mint panel and the ledger
--      filter can show purchases, rewards and spends by name.
--   3. ONE REGISTER ROW PER JOURNAL ROW. Partial unique index on
--      diamond_tx_id, the diamond twin of the chip_ledger_id key.
--   4. THE ERA IS BACKFILLED. Every live journal row since the diamond
--      baseline (2026-09-03 00:22 UTC) that the register never saw gets its
--      row now, with the journal row's own timestamp, so the register reads
--      the history the way it should have been written.
--   5. THE OPENING CORRECTION. After the backfill the register's diamond net
--      is set equal to the meter (sum of profiles.diamonds plus the house
--      account) at this instant by ONE labelled correction row, origin
--      'baseline', whose reason states the measured gap and what it covers
--      (the deleted certification accounts' archived history and the
--      pre-standard credits the register never carried). No diamond moves.
--   6. THE OVERVIEW RECONCILES DIAMONDS. fn_ca_diamond_register_vs_supply()
--      and a 'diamonds' block in fn_ca_mint_overview: register net, meter,
--      difference, issued and retired in 24h and since the baseline, and a
--      by-origin breakdown, so the Mint panel can say whether every diamond
--      is accounted for.
--
-- One transaction. Probed rolled-back first; asserted 0 difference at the end.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;
SET LOCAL statement_timeout = '5min';

-- ── 2. origin learns the diamond journal ───────────────────────────────────
-- A generated column cannot be altered in place. Drop and re-add with the
-- superset of prefixes; 1,301 rows rewrite in milliseconds.
DROP INDEX IF EXISTS public.ca_mint_ledger_origin_idx;
ALTER TABLE public.ca_mint_ledger DROP COLUMN IF EXISTS origin;
ALTER TABLE public.ca_mint_ledger
  ADD COLUMN origin text GENERATED ALWAYS AS (
    CASE
      WHEN op_id LIKE 'ledger:%'                               THEN 'journal'
      WHEN op_id LIKE 'register-opening-baseline:%'            THEN 'baseline'
      WHEN op_id LIKE 'register-opening-baseline-correction:%' THEN 'baseline'
      WHEN op_id LIKE 'baseline:%'                             THEN 'baseline'
      WHEN op_id LIKE 'diamond-mint:%'                         THEN 'diamond-mint'
      WHEN op_id LIKE 'club-opening-grant:%'                   THEN 'opening-grant'
      WHEN op_id LIKE 'seat_credit_erased:%'                   THEN 'restoration'
      WHEN op_id LIKE 'seed:%'                                 THEN 'seed'
      WHEN op_id LIKE 'deletion:%'                             THEN 'deletion'
      WHEN op_id LIKE 'diamond-journal:purchase:%'             THEN 'purchase'
      WHEN op_id LIKE 'diamond-journal:reward:%'               THEN 'reward'
      WHEN op_id LIKE 'diamond-journal:promotion:%'            THEN 'promotion'
      WHEN op_id LIKE 'diamond-journal:refund:%'               THEN 'refund'
      WHEN op_id LIKE 'diamond-journal:spend:%'                THEN 'spend'
      WHEN op_id LIKE 'diamond-journal:bridge:%'               THEN 'bridge'
      WHEN op_id LIKE 'diamond-journal:adjustment:%'           THEN 'adjustment'
      WHEN op_id LIKE 'diamond-journal:arena:%'                THEN 'arena'
      WHEN op_id LIKE 'diamond-journal:%'                      THEN 'unclassified'
      ELSE 'operator'
    END) STORED;
CREATE INDEX ca_mint_ledger_origin_idx ON public.ca_mint_ledger (origin, created_at DESC);
COMMENT ON COLUMN public.ca_mint_ledger.origin IS
  'Derived from op_id: operator (the Mint panel / fn_ca_mint), journal (registered from a chip_ledger leg at commit), baseline (opening baseline or its correction, not issuance), diamond-mint, opening-grant, restoration, seed, deletion; and for diamonds registered from the diamond journal: purchase, reward, promotion, refund, adjustment, arena (issuance) and spend, bridge (retirement).';

-- ── 3. One register row per diamond journal row ────────────────────────────
DO $$
DECLARE v_dup int;
BEGIN
  SELECT count(*) INTO v_dup FROM (
    SELECT diamond_tx_id FROM public.ca_mint_ledger WHERE diamond_tx_id IS NOT NULL
     GROUP BY 1 HAVING count(*) > 1) d;
  IF v_dup <> 0 THEN
    RAISE EXCEPTION 'the register already links % diamond journal row(s) twice - resolve before adding the unique index', v_dup;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS ca_mint_ledger_diamond_tx_id_key
  ON public.ca_mint_ledger (diamond_tx_id) WHERE diamond_tx_id IS NOT NULL;

-- ── 1a. Which side of the Mint a journal row is on ─────────────────────────
-- Returns the register origin for a journal row, or NULL when the row is not
-- an issuance or a retirement (a player-to-player transfer, a row the Mint
-- wrote itself, a deletion the deletion door already registered).
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_journal_origin(
  p_type text, p_transaction_type text, p_source text, p_issuance_class text, p_amount numeric)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_kind  text := lower(COALESCE(NULLIF(btrim(p_transaction_type), ''), NULLIF(btrim(p_type), ''), ''));
  v_class text := lower(COALESCE(NULLIF(btrim(p_issuance_class), ''), ''));
BEGIN
  IF p_amount IS NULL OR p_amount = 0 THEN RETURN NULL; END IF;
  -- The Mint's own doors register their own rows.
  IF lower(COALESCE(p_source, '')) = 'the_mint' THEN RETURN NULL; END IF;
  -- Player to player: supply moves, none is created or retired.
  IF v_class = 'transferred'
     OR v_kind IN ('transfer', 'diamond_gift_sent', 'diamond_gift_received', 'diamond_received',
                   'live_gift_sent', 'live_gift_received', 'wallet_transfer',
                   'wallet_diamond_transfer', 'stream_gift', 'union_grant_transfer')
     OR v_kind LIKE '%gift%' OR v_kind LIKE '%transfer%' THEN
    RETURN NULL;
  END IF;
  -- The deletion door writes its own register row.
  IF v_class = 'deletion' THEN RETURN NULL; END IF;
  -- A test fixture row is not supply the Mint issued.
  IF v_kind LIKE 'test%' THEN RETURN NULL; END IF;

  IF p_amount > 0 THEN
    IF v_class = 'purchased' OR v_kind IN ('purchase', 'stripe_purchase', 'diamond_purchase') THEN
      RETURN 'purchase';
    ELSIF v_class = 'refund' OR v_kind LIKE '%refund%' OR v_kind = 'diamond_refund' THEN
      RETURN 'refund';
    ELSIF v_class = 'promotional' OR v_kind IN ('signup_bonus', 'union_grant', 'bonus', 'promo',
                                                 'promo_purchased', 'easter_egg', 'vip_daily',
                                                 'vip_stipend', 'vip_monthly') THEN
      RETURN 'promotion';
    ELSIF v_class = 'admin' OR v_kind IN ('adjustment', 'reconciliation', 'admin', 'admin_grant') THEN
      RETURN 'adjustment';
    ELSIF v_class = 'arena' OR v_kind LIKE 'arcade%' THEN
      RETURN 'arena';
    ELSE
      RETURN 'reward';   -- earned: daily_login, training, tournament_prize, pvp_win, trivia ...
    END IF;
  ELSE
    IF v_kind IN ('chip_mint', 'chip_purchase', 'mint_chips', 'diamonds_to_chips') OR v_class = 'bridge' THEN
      RETURN 'bridge';   -- diamonds retired to become chips (registered on the chip side as diamond-mint)
    ELSIF v_class = 'admin' OR v_kind IN ('adjustment', 'reconciliation', 'admin', 'chargeback', 'clawback') THEN
      RETURN 'adjustment';
    ELSE
      RETURN 'spend';    -- feature purchases, VIP, club shop, merch, stakes, entries
    END IF;
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_journal_origin(text, text, text, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_journal_origin(text, text, text, text, numeric) TO service_role;

-- ── 1b. Register one diamond journal row ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_register_diamond_journal_row(p_tx_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  t record; v_origin text; v_action text; v_label text; v_actorlb text;
  v_before numeric; v_after numeric; v_supply numeric; v_reason text; v_op text;
  v_actor uuid := auth.uid();
BEGIN
  SELECT * INTO t FROM public.diamond_transactions WHERE id = p_tx_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.ca_mint_ledger m WHERE m.diamond_tx_id = t.id) THEN
    RETURN false;
  END IF;
  v_origin := public.fn_ca_diamond_journal_origin(t.type, t.transaction_type, t.source, t.issuance_class, t.amount);
  IF v_origin IS NULL THEN RETURN false; END IF;

  v_action := CASE WHEN t.amount > 0 THEN 'mint' ELSE 'burn' END;
  v_after  := COALESCE(t.balance_after, 0);
  v_before := v_after - t.amount;
  SELECT COALESCE(NULLIF(btrim(p.username), ''), p.full_name, p.id::text)
    INTO v_label FROM public.profiles p WHERE p.id = t.user_id;
  v_label := COALESCE(v_label, t.user_id::text);
  SELECT COALESCE(NULLIF(btrim(p.username), ''), p.full_name, p.id::text)
    INTO v_actorlb FROM public.profiles p WHERE p.id = v_actor;
  v_op := 'diamond-journal:' || v_origin || ':' || t.id::text;
  v_reason := CASE v_action
                WHEN 'mint' THEN 'The Mint issued ' || abs(t.amount)::text || ' diamonds (' || v_origin || '): '
                ELSE 'The Mint retired ' || abs(t.amount)::text || ' diamonds (' || v_origin || '): '
              END
              || COALESCE(NULLIF(btrim(t.description), ''), COALESCE(t.transaction_type, t.type, 'diamond movement'));

  -- Serialise supply_after the way fn_ca_mint does.
  PERFORM pg_advisory_xact_lock(hashtext('ca_mint_ledger:diamonds'));
  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0)
    INTO v_supply FROM public.ca_mint_ledger WHERE asset = 'diamonds';
  v_supply := v_supply + CASE WHEN v_action = 'mint' THEN abs(t.amount) ELSE -abs(t.amount) END;

  INSERT INTO public.ca_mint_ledger
    (op_id, action, asset, holder_type, holder_id, holder_label, amount,
     balance_before, balance_after, supply_after, reason,
     performed_by, performed_by_label, chip_ledger_id, diamond_tx_id, created_at)
  VALUES
    (v_op, v_action, 'diamonds', 'player', t.user_id, v_label, abs(t.amount),
     v_before, v_after, v_supply, v_reason,
     v_actor, v_actorlb, NULL, t.id, COALESCE(t.created_at, now()))
  ON CONFLICT (op_id) DO NOTHING;
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_register_diamond_journal_row(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_register_diamond_journal_row(uuid) TO service_role;

-- ── 1c. The trigger: never raises ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_register_follows_journal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  BEGIN
    PERFORM public.fn_ca_register_diamond_journal_row(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    -- The diamonds already moved and the journal row stands. A register that
    -- could not be written is an incident, not a refused purchase.
    BEGIN
      PERFORM public.fn_ca_diamond_incident(
        'MINT:register_follow_failed', 'critical', NEW.user_id, NEW.amount,
        'fn_ca_diamond_register_follows_journal',
        jsonb_build_object('sqlstate', SQLSTATE, 'sqlerrm', SQLERRM,
                           'journal_id', NEW.id, 'reference_id', NEW.reference_id));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_register_follows_journal() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_ca_diamond_register_follows_journal ON public.diamond_transactions;
CREATE TRIGGER trg_ca_diamond_register_follows_journal
  AFTER INSERT ON public.diamond_transactions
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_diamond_register_follows_journal();

-- ── 6a. The diamond reconciliation ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_register_vs_supply()
 RETURNS TABLE(register_net numeric, meter_total numeric, player_diamonds numeric,
               house_diamonds numeric, difference numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH r AS (SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) AS net
               FROM public.ca_mint_ledger WHERE asset = 'diamonds'),
       p AS (SELECT COALESCE(SUM(COALESCE(diamonds, 0)), 0)::numeric AS held FROM public.profiles),
       h AS (SELECT COALESCE(SUM(COALESCE(balance, 0)), 0)::numeric AS held FROM public.ca_diamond_house)
  SELECT round(r.net, 2), round(p.held + h.held, 2), round(p.held, 2), round(h.held, 2),
         round(p.held + h.held - r.net, 2)
    FROM r, p, h;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_register_vs_supply() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_register_vs_supply() TO service_role;

-- ── 4. Backfill the era ────────────────────────────────────────────────────
DO $$
DECLARE
  v_base timestamptz;
  v_n int := 0;
  r record;
BEGIN
  SELECT min(created_at) INTO v_base
    FROM public.ca_mint_ledger WHERE asset = 'diamonds' AND origin = 'baseline';
  IF v_base IS NULL THEN
    RAISE EXCEPTION 'no diamond opening baseline in the register - refusing to backfill without one';
  END IF;
  FOR r IN
    SELECT dt.id
      FROM public.diamond_transactions dt
     WHERE dt.created_at > v_base
       AND NOT EXISTS (SELECT 1 FROM public.ca_mint_ledger m WHERE m.diamond_tx_id = dt.id)
     ORDER BY dt.created_at, dt.id
  LOOP
    IF public.fn_ca_register_diamond_journal_row(r.id) THEN v_n := v_n + 1; END IF;
  END LOOP;
  RAISE NOTICE 'diamond journal backfill: % register rows written since %', v_n, v_base;
END $$;

-- ── 5. The opening correction ──────────────────────────────────────────────
DO $$
DECLARE
  v_gap numeric; v_reg numeric; v_meter numeric; v_players numeric; v_house numeric;
  v_op text := 'register-opening-baseline-correction:diamonds:' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
BEGIN
  SELECT register_net, meter_total, player_diamonds, house_diamonds, difference
    INTO v_reg, v_meter, v_players, v_house, v_gap
    FROM public.fn_ca_diamond_register_vs_supply();
  IF v_gap <> 0 THEN
    INSERT INTO public.ca_mint_ledger
      (op_id, action, asset, holder_type, holder_id, holder_label, amount,
       balance_before, balance_after, supply_after, reason, performed_by, performed_by_label)
    VALUES
      (v_op, CASE WHEN v_gap > 0 THEN 'mint' ELSE 'burn' END, 'diamonds', 'circulation',
       '00000000-0000-0000-0000-00000000c1c0', 'circulation', abs(v_gap),
       v_reg, v_meter, v_meter,
       format('Opening correction 2026-09-05: the diamond register read %s against a meter of %s '
              '(%s in player balances + %s in the house account). The gap is the history the '
              'register never carried before the diamond journal fed it: purchases, rewards, '
              'refunds and spends written between the 2026-09-03 baseline and today, and the '
              'archived journal of deleted certification accounts whose deletion burns retired '
              'more than their registered seeds. From this row on the register follows the '
              'journal and the difference is asserted at zero. No diamond moved.',
              v_reg, v_meter, v_players, v_house),
       auth.uid(), 'migration 20260905041033');
    RAISE NOTICE 'diamond opening correction: % %', CASE WHEN v_gap > 0 THEN 'mint' ELSE 'burn' END, abs(v_gap);
  ELSE
    RAISE NOTICE 'diamond register already equals the meter; no correction row';
  END IF;
END $$;

-- ── 6b. The overview carries diamonds ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_mint_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_rec record; v_pol public.ca_mint_policy%ROWTYPE; v_base timestamptz;
  v_issued_24h numeric; v_retired_24h numeric; v_issued_base numeric; v_retired_base numeric;
  v_drec record; v_dbase timestamptz;
  v_dissued_24h numeric; v_dretired_24h numeric; v_dissued_base numeric; v_dretired_base numeric;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND NOT EXISTS (SELECT 1 FROM public.profiles p
                      WHERE p.id = v_actor AND p.role IN ('admin', 'god')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'the_mint_is_admin_only');
  END IF;
  SELECT * INTO v_rec FROM public.fn_ca_mint_register_vs_supply();
  SELECT * INTO v_pol FROM public.ca_mint_policy WHERE id = 1;
  SELECT min(created_at) INTO v_base FROM public.ca_mint_ledger WHERE op_id LIKE 'register-opening-baseline:%';
  SELECT COALESCE(sum(amount) FILTER (WHERE action = 'mint' AND created_at > now() - interval '24 hours'), 0),
         COALESCE(sum(amount) FILTER (WHERE action = 'burn' AND created_at > now() - interval '24 hours'), 0),
         COALESCE(sum(amount) FILTER (WHERE action = 'mint' AND created_at > v_base), 0),
         COALESCE(sum(amount) FILTER (WHERE action = 'burn' AND created_at > v_base), 0)
    INTO v_issued_24h, v_retired_24h, v_issued_base, v_retired_base
    FROM public.ca_mint_ledger WHERE asset = 'chips' AND origin <> 'baseline';

  -- Diamonds: the register against the live meter (player balances + house).
  SELECT * INTO v_drec FROM public.fn_ca_diamond_register_vs_supply();
  SELECT min(created_at) INTO v_dbase FROM public.ca_mint_ledger WHERE asset = 'diamonds' AND origin = 'baseline';
  SELECT COALESCE(sum(amount) FILTER (WHERE action = 'mint' AND created_at > now() - interval '24 hours'), 0),
         COALESCE(sum(amount) FILTER (WHERE action = 'burn' AND created_at > now() - interval '24 hours'), 0),
         COALESCE(sum(amount) FILTER (WHERE action = 'mint' AND created_at > v_dbase), 0),
         COALESCE(sum(amount) FILTER (WHERE action = 'burn' AND created_at > v_dbase), 0)
    INTO v_dissued_24h, v_dretired_24h, v_dissued_base, v_dretired_base
    FROM public.ca_mint_ledger WHERE asset = 'diamonds' AND origin <> 'baseline';

  RETURN jsonb_build_object(
    'ok', true,
    -- as before (add, never rename)
    'chips_issued',      public.fn_ca_mint_supply('chips'),
    'diamonds_issued',   public.fn_ca_mint_supply('diamonds'),
    'mint_operations',   (SELECT count(*) FROM public.ca_mint_ledger),
    'club_treasuries',   (SELECT COALESCE(SUM(COALESCE(chip_treasury, 0)), 0) FROM public.clubs),
    'union_banks',       (SELECT COALESCE(SUM(COALESCE(chip_balance, 0)), 0) FROM public.union_wallets),
    'member_wallets',    (SELECT COALESCE(SUM(COALESCE(chip_balance, 0)), 0) FROM public.club_members),
    'chips_on_the_felt', (SELECT COALESCE(SUM(COALESCE(stack, 0)), 0) FROM public.table_seats WHERE left_at IS NULL),
    'diamonds_held',     (SELECT COALESCE(SUM(COALESCE(diamonds, 0)), 0) FROM public.profiles),
    'diamond_holders',   (SELECT count(*) FROM public.profiles WHERE COALESCE(diamonds, 0) > 0),
    -- the reconciliation: the register against the supply meter
    'reconciliation', jsonb_build_object(
      'register_net',               v_rec.register_net,
      'register_net_at_meter',      v_rec.register_net_at_meter,
      'meter_total',                v_rec.meter_total,
      'meter_taken_at',             v_rec.meter_taken_at,
      'meter_age_seconds',          extract(epoch FROM (now() - v_rec.meter_taken_at))::int,
      'difference',                 v_rec.difference,
      'unexplained_since_baseline', v_rec.unexplained_since_baseline,
      'baseline_at',                v_base,
      'balanced',                   (v_rec.difference = v_rec.unexplained_since_baseline)),
    'issuance', jsonb_build_object(
      'issued_since_baseline',  v_issued_base,
      'retired_since_baseline', v_retired_base,
      'issued_24h',             v_issued_24h,
      'retired_24h',            v_retired_24h),
    -- diamonds: every wallet is connected to the Mint (2026-09-05)
    'diamonds', jsonb_build_object(
      'register_net',     v_drec.register_net,
      'meter_total',      v_drec.meter_total,
      'player_diamonds',  v_drec.player_diamonds,
      'house_diamonds',   v_drec.house_diamonds,
      'difference',       v_drec.difference,
      'balanced',         (v_drec.difference = 0),
      'baseline_at',      v_dbase,
      'issued_24h',       v_dissued_24h,
      'retired_24h',      v_dretired_24h,
      'issued_since_baseline',  v_dissued_base,
      'retired_since_baseline', v_dretired_base,
      'headroom_24h',     v_pol.rolling_24h_cap_diamonds - public.fn_ca_mint_issued_24h('diamonds'),
      'by_origin_24h', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                          'origin', o.origin, 'action', o.action, 'operations', o.n, 'amount', o.total)
                          ORDER BY o.action, o.total DESC), '[]'::jsonb)
                         FROM (SELECT origin, action, count(*) n, sum(amount) total
                                 FROM public.ca_mint_ledger
                                WHERE asset = 'diamonds' AND created_at > now() - interval '24 hours'
                                GROUP BY 1, 2) o),
      'by_origin', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                      'origin', o.origin, 'action', o.action, 'operations', o.n, 'amount', o.total)
                      ORDER BY o.action, o.total DESC), '[]'::jsonb)
                     FROM (SELECT origin, action, count(*) n, sum(amount) total
                             FROM public.ca_mint_ledger
                            WHERE asset = 'diamonds' AND origin <> 'baseline'
                            GROUP BY 1, 2) o)),
    'policy', jsonb_build_object(
      'per_operation_cap_chips',    v_pol.per_operation_cap_chips,
      'rolling_24h_cap_chips',      v_pol.rolling_24h_cap_chips,
      'per_operation_cap_diamonds', v_pol.per_operation_cap_diamonds,
      'rolling_24h_cap_diamonds',   v_pol.rolling_24h_cap_diamonds,
      'headroom_24h_chips',         v_pol.rolling_24h_cap_chips - v_issued_24h,
      'note',                       v_pol.note,
      'updated_at',                 v_pol.updated_at),
    'by_origin', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                     'origin', o.origin, 'asset', o.asset, 'action', o.action,
                     'operations', o.n, 'amount', o.total) ORDER BY o.asset, o.origin, o.action), '[]'::jsonb)
                    FROM (SELECT origin, asset, action, count(*) n, sum(amount) total
                            FROM public.ca_mint_ledger GROUP BY 1, 2, 3) o)
  );
END;
$function$;

-- ── Assertions ─────────────────────────────────────────────────────────────
DO $$
DECLARE v_gap numeric; v_null int; v_trg int;
BEGIN
  SELECT difference INTO v_gap FROM public.fn_ca_diamond_register_vs_supply();
  IF v_gap <> 0 THEN
    RAISE EXCEPTION 'diamond register does not equal the meter after the correction: difference %', v_gap;
  END IF;
  SELECT count(*) INTO v_null FROM public.ca_mint_ledger WHERE origin IS NULL;
  IF v_null <> 0 THEN
    RAISE EXCEPTION 'origin did not derive for every row (% null)', v_null;
  END IF;
  SELECT count(*) INTO v_trg FROM pg_trigger
   WHERE tgrelid = 'public.diamond_transactions'::regclass
     AND tgname = 'trg_ca_diamond_register_follows_journal' AND NOT tgisinternal;
  IF v_trg <> 1 THEN
    RAISE EXCEPTION 'the diamond register trigger is not installed';
  END IF;
  -- The classifier: a purchase issues, a spend retires, a gift is neither.
  IF public.fn_ca_diamond_journal_origin('purchase', 'purchase', NULL, 'purchased', 500) <> 'purchase' THEN
    RAISE EXCEPTION 'classifier: purchase';
  END IF;
  IF public.fn_ca_diamond_journal_origin('daily_login', 'daily_login', NULL, NULL, 7) <> 'reward' THEN
    RAISE EXCEPTION 'classifier: reward';
  END IF;
  IF public.fn_ca_diamond_journal_origin('feature_purchase', 'feature_purchase', 'feature_purchase', 'spend', -5) <> 'spend' THEN
    RAISE EXCEPTION 'classifier: spend';
  END IF;
  IF public.fn_ca_diamond_journal_origin('diamond_gift_sent', 'diamond_gift_sent', 'wallet_diamond_transfer', 'transferred', -50) IS NOT NULL THEN
    RAISE EXCEPTION 'classifier: transfer must not register';
  END IF;
  IF public.fn_ca_diamond_journal_origin('earn', 'mint', 'the_mint', 'seeded', 500) IS NOT NULL THEN
    RAISE EXCEPTION 'classifier: the Mint''s own row must not register twice';
  END IF;
  IF public.fn_ca_diamond_journal_origin('chip_mint', 'chip_mint', NULL, NULL, -100) <> 'bridge' THEN
    RAISE EXCEPTION 'classifier: bridge';
  END IF;
END $$;

COMMIT;
