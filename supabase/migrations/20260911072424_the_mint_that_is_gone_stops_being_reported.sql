-- 20260911072424_the_mint_that_is_gone_stops_being_reported.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  THE MINT THAT IS GONE STOPS BEING REPORTED
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Phase 6 of 6. The games stopped minting chips on 2026-09-10: the host is the
-- house, the intake goes to its owner and the prize comes out of its promo
-- wallet, and nothing is created. chips_minted has read zero on every round
-- since, and five read payloads have been handing that zero to the browser
-- ever since, where two service files type it, map it and carry it into three
-- page states that never print it. A number that is structurally zero for ever
-- is not data; it is a promise the schema no longer makes.
--
-- WHAT IS NOT DONE HERE, AND WHY.
--
-- The COLUMNS stay. They are not empty: 25 rows across wheel_spins,
-- plinko_drops, crash_rounds and the two pool tables carry real historical
-- mints totalling about nineteen chips, from the weeks when the platform did
-- mint. Dropping them would destroy the record of the thing this branch spent
-- a day undoing, which is exactly the record somebody will want.
--
-- The WRITES stay too, at zero. fn_spin_chip_conservation_check and
-- fn_ca_mint_velocity_watch both read chips_minted as a series, and a round
-- that writes 0 is making a statement they can check: this one minted nothing.
-- A round that wrote nothing at all would be a hole in that series.
--
-- So only the REPORTING goes: the five reads stop putting it in the payload,
-- and the browser stops typing a field it cannot use. The column keeps its
-- history, the integrity checks keep their series, and the wire stops carrying
-- a zero that means "this concept was retired".

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The two state reads
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_wheel_state(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.wheel_configs%ROWTYPE;
  pool public.wheel_pools%ROWTYPE;
  v_rate integer := public.fn_ca_bridge_rate();
  v_mult integer;
  v_bank numeric := 0;
  v_intake numeric; v_dia_now numeric; v_intake_chips numeric;
  v_owner uuid; v_owner_dia numeric;
  v_segments jsonb;
  v_diamonds numeric := 0; v_purchased integer := 0; v_spendable integer := 0;
  v_today integer := 0; v_last timestamptz; v_wait integer := 0;
  v_member boolean := false; v_member_chips numeric;
  v_frozen boolean;
  a record;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Spin');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  SELECT * INTO cfg FROM public.wheel_configs WHERE host_id = v_host;
  IF cfg.host_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'available', false, 'reason', 'not_configured',
                              'host_id', v_host, 'host_kind', v_kind);
  END IF;
  SELECT * INTO pool FROM public.wheel_pools WHERE host_id = v_host;
  SELECT x.* INTO a FROM public.fn_wheel_segments_audit(cfg.segment_version) x;
  SELECT cfg.spin_price_diamonds / v.spin_price_diamonds INTO v_mult
    FROM public.wheel_segment_versions v WHERE v.version = cfg.segment_version;
  v_intake   := cfg.spin_price_diamonds::numeric / v_rate;
  v_dia_now  := cfg.spin_price_diamonds;
  v_intake_chips := round((COALESCE(pool.intake_diamonds, 0) + cfg.spin_price_diamonds)::numeric / v_rate, 2);
  -- The prizes come out of the host's PROMO WALLET, its own bank behind that,
  -- and its owner's diamonds. v_bank is the cover: the two wallets together.
  v_bank  := public.fn_diamond_game_cover(v_host, v_kind);
  v_owner := public.fn_diamond_game_owner(v_host, v_kind);
  SELECT COALESCE(p.diamonds, 0) INTO v_owner_dia FROM public.profiles p WHERE p.id = v_owner;
  v_owner_dia := COALESCE(v_owner_dia, 0);

  SELECT jsonb_agg(jsonb_build_object(
           'ord', g.ord, 'label', g.label, 'kind', g.kind,
           'amount', g.amount * v_mult,
           'value_chips', CASE g.kind WHEN 'chips' THEN g.amount * v_mult
                                      WHEN 'diamonds' THEN round(g.amount * v_mult / v_rate, 4) ELSE 0 END,
           'weight', g.weight,
           'probability', round(g.weight::numeric / a.weight_total, 6),
           'locked', CASE
              WHEN g.kind = 'chips' AND (
                     COALESCE(pool.chips_paid, 0) + g.amount * v_mult
                       > v_intake_chips + cfg.exposure_allowance_chips
                  OR v_bank < g.amount * v_mult) THEN true
              WHEN g.kind = 'diamonds' AND (COALESCE(pool.diamond_float, 0) + v_dia_now < g.amount * v_mult
                  OR v_owner_dia + cfg.spin_price_diamonds < g.amount * v_mult) THEN true
              ELSE false END,
           'unlocks_at', CASE
              WHEN g.kind = 'chips' THEN round(GREATEST(
                     COALESCE(pool.chips_paid, 0) + g.amount * v_mult - cfg.exposure_allowance_chips,
                     g.amount * v_mult), 2)
              WHEN g.kind = 'diamonds' THEN round(g.amount * v_mult - v_dia_now, 0)
              ELSE NULL END
         ) ORDER BY g.ord)
    INTO v_segments
    FROM public.wheel_segments g WHERE g.version = cfg.segment_version;

  SELECT COALESCE(p.diamonds, 0) INTO v_diamonds FROM public.profiles p WHERE p.id = v_user;
  v_purchased := public.fn_wheel_purchased_available(v_user);
  v_spendable := CASE WHEN cfg.purchased_only THEN LEAST(v_diamonds, v_purchased)::integer ELSE v_diamonds::integer END;

  SELECT count(*)::integer, max(s.created_at) INTO v_today, v_last
    FROM public.wheel_spins s
   WHERE s.user_id = v_user AND s.host_id = v_host
     AND (s.created_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date;
  IF v_last IS NOT NULL THEN
    v_wait := GREATEST(0, cfg.min_seconds_between_spins - floor(extract(epoch FROM (now() - v_last)))::integer);
  END IF;
  SELECT true, COALESCE(cm.chip_balance, 0) INTO v_member, v_member_chips
    FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id = v_user
     AND COALESCE(cm.status, 'active') IN ('active', 'approved') LIMIT 1;
  v_frozen := public.fn_platform_frozen()
           OR EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = 'wheel' AND f.cleared_at IS NULL);

  RETURN jsonb_build_object(
    'ok', true, 'available', cfg.enabled, 'host_id', v_host, 'host_kind', v_kind, 'club_id', p_club_id,
    'config', jsonb_build_object(
      'spin_price_diamonds', cfg.spin_price_diamonds, 'diamonds_per_chip', v_rate,
      'spin_price_chips', v_intake, 'segment_version', cfg.segment_version, 'multiplier', v_mult,
      'purchased_only', cfg.purchased_only, 'max_spins_per_player_per_day', cfg.max_spins_per_player_per_day,
      'min_seconds_between_spins', cfg.min_seconds_between_spins,
      -- THE CONSOLE COULD NOT SEE ITS OWN SWITCH (2026-09-11). Neither of these
      -- was ever in this payload, so the operations page read undefined: the
      -- welcome pill always said Off however the switch was actually set, "Turn
      -- It Off" always posted ON, and the window field always showed the 30 day
      -- default, so an operator who had set 7 and then saved the budget silently
      -- put it back to 30.
      'welcome_spin_enabled', COALESCE(cfg.welcome_spin_enabled, false),
      'welcome_budget_period_days', COALESCE(cfg.welcome_budget_period_days, 0),
      'spec_rtp', a.spec_rtp, 'chip_share', a.chip_share, 'diamond_share', a.diamond_share,
      'house_share', a.house_share, 'hit_rate', a.hit_rate),
    'segments', COALESCE(v_segments, '[]'::jsonb),
    'pool', jsonb_build_object(
      'spins', COALESCE(pool.spins, 0), 'intake_diamonds', COALESCE(pool.intake_diamonds, 0),
      'chips_paid', COALESCE(pool.chips_paid, 0),
      'promo_wallet_chips', public.fn_diamond_game_promo(v_host, v_kind),
      'bank_chips', public.fn_diamond_game_bank(v_host, v_kind),
      'cover_chips', v_bank,
      'welcome_chips_paid', COALESCE(pool.welcome_chips_paid, 0),
      'welcome_budget_chips', COALESCE(cfg.welcome_budget_chips, 0),
      'welcome_spins', COALESCE(pool.welcome_spins, 0),
      'intake_chips', round(COALESCE(pool.intake_diamonds, 0)::numeric / v_rate, 2),
      'diamond_float', COALESCE(pool.diamond_float, 0), 'diamonds_paid', COALESCE(pool.diamonds_paid, 0),
      'realized_rtp', CASE WHEN COALESCE(pool.intake_diamonds, 0) > 0
                           THEN round((COALESCE(pool.chips_paid, 0) + COALESCE(pool.diamonds_paid, 0)::numeric / v_rate)
                                      / (pool.intake_diamonds::numeric / v_rate), 4) END),
    'player', jsonb_build_object(
      'diamonds', v_diamonds, 'purchased_available', v_purchased, 'spendable', v_spendable,
      'spins_today', v_today, 'seconds_until_next', v_wait,
      -- WHAT THE DAY HAS COST (2026-09-11). One figure across all three games
      -- at this host, because the player's diamonds are one wallet and the day
      -- is the day the caps are counted on.
      'diamonds_today', public.fn_diamond_games_spent_today(v_host, v_user),
      'is_member', COALESCE(v_member, false), 'member_chips', v_member_chips),
    'frozen', v_frozen);
END $function$;

CREATE OR REPLACE FUNCTION public.fn_diamond_game_state(p_club_id uuid, p_game text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.diamond_game_configs%ROWTYPE;
  pool public.diamond_game_pools%ROWTYPE;
  v_rate integer := public.fn_ca_bridge_rate();
  v_bank numeric := 0;
  v_diamonds numeric := 0; v_purchased integer := 0; v_spendable integer := 0;
  v_today integer := 0; v_last timestamptz; v_wait integer := 0;
  v_member boolean := false; v_member_chips numeric;
  v_frozen boolean;
  v_bets jsonb; v_tables jsonb; v_open jsonb;
  r public.crash_rounds;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Play');
  END IF;
  IF p_game NOT IN ('plinko', 'crash') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Game Does Not Exist');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  SELECT * INTO cfg FROM public.diamond_game_configs WHERE host_id = v_host AND game = p_game;
  IF cfg.host_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'available', false, 'reason', 'not_configured',
                              'game', p_game, 'host_id', v_host, 'host_kind', v_kind);
  END IF;

  -- Time settles what it has decided before anybody reads the headroom.
  IF p_game = 'crash' THEN
    PERFORM 1 FROM public.diamond_game_configs WHERE host_id = v_host AND game = 'crash' FOR UPDATE;
    PERFORM public.fn_crash_settle_decided(v_host);
    SELECT * INTO r FROM public.crash_rounds c WHERE c.host_id = v_host AND c.user_id = v_user AND c.status = 'open'
     ORDER BY c.started_at DESC LIMIT 1;
    IF r.id IS NOT NULL THEN
      v_open := public.fn_crash_round_result(r);
    END IF;
  END IF;
  SELECT * INTO pool FROM public.diamond_game_pools WHERE host_id = v_host AND game = p_game;

  -- The bank a prize comes out of is the host's PROMO WALLET (Dan 2026-09-10).
  -- Cover: the promo wallet the payouts come out of first, and the host's own
  -- chip bank standing behind it (Dan 2026-09-10).
  v_bank := public.fn_diamond_game_cover(v_host, v_kind);

  -- Every bet option with the cap the pool can promise on it right now.
  SELECT jsonb_agg(jsonb_build_object(
           'bet_diamonds', b, 'bet_chips', round(b::numeric / v_rate, 2),
           'cap_cents', public.fn_diamond_game_cap_cents(cfg, pool, v_bank, b::numeric / v_rate, cfg.max_multiplier_cents),
           'playable', public.fn_diamond_game_cap_cents(cfg, pool, v_bank, b::numeric / v_rate, cfg.max_multiplier_cents) >= 101)
         ORDER BY b)
    INTO v_bets
    FROM unnest(cfg.bet_options) b
   WHERE b BETWEEN cfg.min_bet_diamonds AND cfg.max_bet_diamonds AND b % v_rate = 0;

  IF p_game = 'plinko' THEN
    SELECT jsonb_agg(jsonb_build_object(
             'version', t.version, 'name', t.name, 'rows', t.board_rows,
             'multipliers_cents', to_jsonb(t.multipliers_cents),
             'max_multiplier_cents', t.max_multiplier_cents,
             'spec_rtp', t.spec_rtp, 'sd_chips', t.sd_chips, 'hit_rate', t.hit_rate, 'note', t.note)
           ORDER BY t.version)
      INTO v_tables
      FROM public.plinko_tables t WHERE t.activated_at IS NOT NULL;
  END IF;

  SELECT COALESCE(p.diamonds, 0) INTO v_diamonds FROM public.profiles p WHERE p.id = v_user;
  v_purchased := public.fn_wheel_purchased_available(v_user);
  v_spendable := CASE WHEN cfg.purchased_only THEN LEAST(v_diamonds, v_purchased)::integer ELSE v_diamonds::integer END;

  IF p_game = 'plinko' THEN
    SELECT count(*)::integer, max(d.created_at) INTO v_today, v_last
      FROM public.plinko_drops d
     WHERE d.user_id = v_user AND d.host_id = v_host
       AND (d.created_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date;
  ELSE
    SELECT count(*)::integer, max(c.created_at) INTO v_today, v_last
      FROM public.crash_rounds c
     WHERE c.user_id = v_user AND c.host_id = v_host
       AND (c.created_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date;
  END IF;
  IF v_last IS NOT NULL THEN
    v_wait := GREATEST(0, cfg.min_seconds_between_rounds - floor(extract(epoch FROM (now() - v_last)))::integer);
  END IF;
  SELECT true, COALESCE(cm.chip_balance, 0) INTO v_member, v_member_chips
    FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id = v_user
     AND COALESCE(cm.status, 'active') IN ('active', 'approved') LIMIT 1;
  v_frozen := public.fn_platform_frozen()
           OR EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = p_game AND f.cleared_at IS NULL);

  RETURN jsonb_build_object(
    'ok', true, 'available', cfg.enabled, 'game', p_game, 'host_id', v_host, 'host_kind', v_kind, 'club_id', p_club_id,
    'config', jsonb_build_object(
      'diamonds_per_chip', v_rate, 'min_bet_diamonds', cfg.min_bet_diamonds, 'max_bet_diamonds', cfg.max_bet_diamonds,
      'exposure_allowance_chips', cfg.exposure_allowance_chips, 'cap_fraction', cfg.cap_fraction,
      'max_multiplier_cents', cfg.max_multiplier_cents, 'growth_k', cfg.growth_k,
      'purchased_only', cfg.purchased_only, 'max_rounds_per_player_per_day', cfg.max_rounds_per_player_per_day,
      'min_seconds_between_rounds', cfg.min_seconds_between_rounds, 'spec_rtp', 0.800000, 'house_share', 0.200000),
    'bets', COALESCE(v_bets, '[]'::jsonb),
    'tables', COALESCE(v_tables, '[]'::jsonb),
    'open_round', v_open,
    'pool', jsonb_build_object(
      'rounds', COALESCE(pool.rounds, 0), 'intake_diamonds', COALESCE(pool.intake_diamonds, 0),
      'chips_paid', COALESCE(pool.chips_paid, 0),
      'reserved_chips', COALESCE(pool.reserved_chips, 0),
      'intake_chips', round(COALESCE(pool.intake_diamonds, 0)::numeric / v_rate, 2),
      'promo_wallet_chips', public.fn_diamond_game_promo(v_host, v_kind),
      'bank_chips', public.fn_diamond_game_bank(v_host, v_kind),
      'cover_chips', v_bank,
      'headroom_chips', round(COALESCE(pool.intake_diamonds, 0)::numeric / v_rate, 2) + cfg.exposure_allowance_chips - COALESCE(pool.chips_paid, 0) - COALESCE(pool.reserved_chips, 0),
      'realized_rtp', CASE WHEN COALESCE(pool.intake_diamonds, 0) > 0
                           THEN round(COALESCE(pool.chips_paid, 0) / (pool.intake_diamonds::numeric / v_rate), 4) END),
    'player', jsonb_build_object(
      'diamonds', v_diamonds, 'purchased_available', v_purchased, 'spendable', v_spendable,
      'rounds_today', v_today, 'seconds_until_next', v_wait,
      -- The same one figure the wheel shows, from the same helper.
      'diamonds_today', public.fn_diamond_games_spent_today(v_host, v_user),
      'is_member', COALESCE(v_member, false), 'member_chips', v_member_chips),
    'frozen', v_frozen);
END $function$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The three result shapes
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_wheel_spin_result(s wheel_spins)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'ok', true, 'welcome', COALESCE(s.is_welcome, false),
    'spin_id', s.id, 'club_id', s.club_id, 'host_id', s.host_id,
    'segment_version', s.segment_version, 'spin_price_diamonds', s.spin_price_diamonds,
    'diamonds_per_chip', s.diamonds_per_chip,
    'outcome', jsonb_build_object('ord', s.outcome_ord, 'kind', s.outcome_kind, 'amount', s.outcome_amount,
                                  'label', (SELECT g.label FROM public.wheel_segments g
                                             WHERE g.version = s.segment_version AND g.ord = s.outcome_ord),
                                  'value_chips', s.prize_value_chips),
    'fairness', jsonb_build_object('commit_id', s.commit_id, 'server_seed_hash', s.server_seed_hash,
                                   'server_seed', s.server_seed, 'client_seed', s.client_seed,
                                   'nonce', s.nonce, 'roll', s.roll, 'weight_total', s.weight_total,
                                   'eligible_ords', to_jsonb(s.eligible_ords), 'locked', s.locked),
    'balances', jsonb_build_object('diamonds', s.diamonds_after, 'member_chips', s.member_chips_after),
    'pool', jsonb_build_object('chips_paid', s.pool_chips_paid_after,
                               'diamond_float', s.pool_diamond_float_after),
    'created_at', s.created_at);
$function$;

CREATE OR REPLACE FUNCTION public.fn_plinko_drop_result(d public.plinko_drops)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'ok', true, 'game', 'plinko', 'drop_id', d.id, 'club_id', d.club_id, 'host_id', d.host_id,
    'table_version', d.table_version, 'bet_diamonds', d.bet_diamonds, 'bet_chips', d.bet_chips,
    'diamonds_per_chip', d.diamonds_per_chip,
    'outcome', jsonb_build_object(
      'slot', d.slot, 'path_bits', d.path_bits,
      'path', (SELECT jsonb_agg(((d.path_bits >> i) & 1) ORDER BY i) FROM generate_series(0, 15) i),
      'table_multiplier_cents', d.table_multiplier_cents, 'cap_multiplier_cents', d.cap_multiplier_cents,
      'multiplier_cents', d.multiplier_cents, 'capped', d.capped, 'payout_chips', d.payout_chips),
    'fairness', jsonb_build_object('commit_id', d.commit_id, 'server_seed_hash', d.server_seed_hash,
                                   'server_seed', d.server_seed, 'client_seed', d.client_seed,
                                   'nonce', d.nonce, 'hmac_hex', d.hmac_hex),
    'balances', jsonb_build_object('diamonds', d.diamonds_after, 'member_chips', d.member_chips_after),
    'pool', jsonb_build_object('chips_paid', d.pool_chips_paid_after),
    'created_at', d.created_at);
$function$;

CREATE OR REPLACE FUNCTION public.fn_crash_round_result(r public.crash_rounds)
RETURNS jsonb
LANGUAGE sql
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'ok', true, 'game', 'crash', 'round_id', r.id, 'club_id', r.club_id, 'host_id', r.host_id,
    'status', r.status, 'bet_diamonds', r.bet_diamonds, 'bet_chips', r.bet_chips,
    'diamonds_per_chip', r.diamonds_per_chip,
    'cap_cents', r.cap_cents, 'growth_k', r.growth_k, 'auto_cashout_cents', r.auto_cashout_cents,
    'started_at', r.started_at, 'server_now', clock_timestamp(),
    'elapsed_ms', CASE WHEN r.status = 'open'
                       THEN floor(extract(epoch FROM (clock_timestamp() - r.started_at)) * 1000)::bigint
                       ELSE r.elapsed_ms END,
    'multiplier_now_cents', CASE WHEN r.status = 'open'
                       THEN public.fn_crash_multiplier_cents(r.growth_k,
                              floor(extract(epoch FROM (clock_timestamp() - r.started_at)) * 1000)::bigint, r.cap_cents) END,
    'outcome', CASE WHEN r.status = 'open' THEN NULL ELSE jsonb_build_object(
      'status', r.status, 'cashout_cents', r.cashout_cents, 'crash_cents', r.crash_cents,
      'payout_chips', r.payout_chips, 'settled_by', r.settled_by, 'settled_at', r.settled_at) END,
    'fairness', jsonb_build_object('commit_id', r.commit_id, 'server_seed_hash', r.server_seed_hash,
                                   'client_seed', r.client_seed, 'nonce', r.nonce)
                || CASE WHEN r.status = 'open' THEN '{}'::jsonb
                        ELSE jsonb_build_object('server_seed', r.server_seed, 'roll', r.roll, 'crash_cents', r.crash_cents) END,
    'balances', jsonb_build_object('diamonds', r.diamonds_after, 'member_chips', r.member_chips_after),
    'pool', jsonb_build_object('chips_paid', r.pool_chips_paid_after),
    'created_at', r.created_at);
$function$;

COMMIT;
