-- 20260911062053_the_operator_sees_the_money_and_the_room.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  THE OPERATOR SEES THE MONEY AND THE ROOM
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Phase 3 of 6. A host now runs three games that take diamonds in and pay
-- chips out of a wallet the host funds, and the two operations consoles show
-- balances and a realised return against the 80 percent spec. Neither answers
-- the two questions an operator actually has.
--
--   "What did this earn me?"  Balances are a photograph. The realised-return
--   windows are about fairness, not money: they say what fraction of the
--   intake came back out as chips, and they do not count the diamond prizes at
--   all, so the one figure an owner cares about - what they are up or down -
--   appears nowhere.
--
--   "How close am I to it stopping?"  The cover reading goes red at zero. By
--   then the games have already been refusing bets for a while, because every
--   game caps the multiplier it will offer by what the cover can pay. There
--   was nothing between "fine" and "stopped".
--
-- Three reads, no writes, and nothing that runs on a schedule. CLAUDE.md 10.12
-- forbids a monitor, a watch or an alert presented as the resolution, and this
-- is not one: these are computed when the operator opens the page they already
-- open, out of the rows the games already wrote. No cron, no table, no job.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  1. fn_diamond_game_pnl: what the host is up or down
-- ═══════════════════════════════════════════════════════════════════════════
--
-- One reading across all three games, over four windows, with a per-game
-- breakdown. Stated in chips, because a chip is a dollar (Dan 2026-09-07) and
-- an owner thinks in dollars:
--
--     net = intake / rate - chips paid - diamonds paid / rate - welcome chips
--
-- Every term is money that actually moved. The intake is what the owner
-- received; chips paid is what left the promo wallet and the bank; diamonds
-- paid is what left the owner's own diamond balance as prizes; and the welcome
-- spins are separated out rather than buried, because they are a gift the host
-- chose to make and an owner should be able to see what it cost without it
-- being mistaken for the paid game losing money.
--
-- Fixture and certification accounts are excluded throughout. They are not
-- real money and an operator counting them would be reading a fiction. Horses
-- are NOT excluded: a horse is a player (CLAUDE.md 10.5), its diamonds are
-- real, and it is never asked about by any other name.
--
-- An open crash round is excluded from every window: it has taken the bet but
-- not decided the payout, so counting it would report a profit that has not
-- happened yet.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  2. fn_diamond_game_room: how much game is left in the cover
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Per game, the biggest win a player could take RIGHT NOW at the largest bet
-- the host allows, next to the biggest win the configuration would allow if
-- money were no object. The two are the same number on a well funded host. As
-- the cover falls the first drops below the second, and it keeps dropping
-- until the game refuses every bet. That gives three honest states:
--
--     open       the cover is not what is limiting the game
--     thin       the cover is capping the top prize below the configured one
--     stopped    the cover cannot pay a win on the smallest bet offered
--
-- The number is taken from fn_diamond_game_cap_cents, the same function the
-- door uses to decide what it will offer, so the console cannot say one thing
-- while the game does another. The wheel is stated in its own terms, because
-- its prizes are a fixed table rather than a multiplier: the top chip prize
-- and whether the cover covers it, and the top diamond prize and whether the
-- OWNER'S diamonds cover it, which is a separate way for the wheel to go thin
-- that no chip reading would ever show.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  3. fn_diamond_game_players: who is playing, and what it is costing them
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Per-player caps have existed since the games opened and no surface has ever
-- shown an operator who is near one. This lists today's players for the host,
-- their rounds against the two daily ceilings, what they have spent and what
-- they have won. "Today" is the America/Chicago day the caps themselves are
-- counted on, so the console and the door agree about when the day turns.

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The money
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_diamond_game_pnl(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  v_rate integer := public.fn_ca_bridge_rate();
  v_windows jsonb;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In First');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  IF NOT public.fn_wheel_can_operate(v_host, v_kind, v_user) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Only The Host''s Owners And Admins Read This');
  END IF;

  WITH ev AS (
    SELECT 'wheel'::text AS game, s.created_at AS at,
           CASE WHEN s.is_welcome THEN 0 ELSE s.spin_price_diamonds END::numeric AS intake_dia,
           CASE WHEN s.is_welcome THEN 0
                WHEN s.outcome_kind = 'chips' THEN COALESCE(s.outcome_amount, 0) ELSE 0 END AS chips_out,
           CASE WHEN s.is_welcome THEN 0
                WHEN s.outcome_kind = 'diamonds' THEN COALESCE(s.outcome_amount, 0) ELSE 0 END AS dia_out,
           CASE WHEN s.is_welcome THEN COALESCE(s.prize_value_chips, 0) ELSE 0 END AS welcome_chips
      FROM public.wheel_spins s
     WHERE s.host_id = v_host AND NOT COALESCE(s.is_fixture, false)
    UNION ALL
    SELECT 'plinko', d.created_at, d.bet_diamonds::numeric, COALESCE(d.payout_chips, 0), 0, 0
      FROM public.plinko_drops d
     WHERE d.host_id = v_host AND NOT COALESCE(d.is_fixture, false)
    UNION ALL
    -- An open round has taken the bet and not decided the payout. Counting it
    -- would report a profit that has not happened yet.
    SELECT 'crash', c.started_at, c.bet_diamonds::numeric, COALESCE(c.payout_chips, 0), 0, 0
      FROM public.crash_rounds c
     WHERE c.host_id = v_host AND NOT COALESCE(c.is_fixture, false) AND c.status <> 'open'
  ), w(lbl, ord, since) AS (
    VALUES ('24 Hours', 1, now() - interval '24 hours'),
           ('7 Days',   2, now() - interval '7 days'),
           ('30 Days',  3, now() - interval '30 days'),
           ('All Time', 4, '-infinity'::timestamptz)
  ), per_game AS (
    SELECT w.lbl, w.ord, ev.game,
           count(*)::integer AS rounds,
           sum(ev.intake_dia) AS intake_dia,
           sum(ev.chips_out) AS chips_out,
           sum(ev.dia_out) AS dia_out,
           sum(ev.welcome_chips) AS welcome_chips
      FROM w JOIN ev ON ev.at >= w.since
     GROUP BY w.lbl, w.ord, ev.game
  ), per_window AS (
    SELECT w.lbl, w.ord,
           COALESCE(count(ev.*), 0)::integer AS rounds,
           COALESCE(sum(ev.intake_dia), 0) AS intake_dia,
           COALESCE(sum(ev.chips_out), 0) AS chips_out,
           COALESCE(sum(ev.dia_out), 0) AS dia_out,
           COALESCE(sum(ev.welcome_chips), 0) AS welcome_chips
      FROM w LEFT JOIN ev ON ev.at >= w.since
     GROUP BY w.lbl, w.ord
  )
  SELECT jsonb_agg(
           jsonb_build_object(
             'window', p.lbl,
             'rounds', p.rounds,
             'intake_diamonds', p.intake_dia,
             'intake_chips', round(p.intake_dia / v_rate, 2),
             'chips_paid', round(p.chips_out, 2),
             'diamonds_paid', p.dia_out,
             'welcome_chips', round(p.welcome_chips, 2),
             'net_chips', round(p.intake_dia / v_rate - p.chips_out - p.dia_out / v_rate - p.welcome_chips, 2),
             'games', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                         'game', g.game,
                         'rounds', g.rounds,
                         'intake_diamonds', g.intake_dia,
                         'chips_paid', round(g.chips_out, 2),
                         'diamonds_paid', g.dia_out,
                         'net_chips', round(g.intake_dia / v_rate - g.chips_out - g.dia_out / v_rate - g.welcome_chips, 2))
                       ORDER BY g.game)
                  FROM per_game g WHERE g.lbl = p.lbl), '[]'::jsonb))
           ORDER BY p.ord)
    INTO v_windows
    FROM per_window p;

  RETURN jsonb_build_object('ok', true, 'host_id', v_host, 'host_kind', v_kind,
                            'diamonds_per_chip', v_rate,
                            'windows', COALESCE(v_windows, '[]'::jsonb));
END $function$;

REVOKE ALL ON FUNCTION public.fn_diamond_game_pnl(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_diamond_game_pnl(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_pnl(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_pnl(uuid) TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The room
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_diamond_game_room(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  v_rate integer := public.fn_ca_bridge_rate();
  v_cover numeric; v_promo numeric; v_bank numeric;
  v_owner uuid; v_owner_dia numeric;
  cfg public.diamond_game_configs%ROWTYPE;
  pool public.diamond_game_pools%ROWTYPE;
  wcfg public.wheel_configs%ROWTYPE;
  v_games jsonb := '[]'::jsonb;
  v_g text; v_min_chips numeric; v_max_chips numeric;
  v_cap_max integer; v_cap_min integer; v_cap_free integer; v_state text;
  v_mult integer := 1; v_top_chip numeric := 0; v_top_dia numeric := 0;
  v_wheel jsonb;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In First');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  IF NOT public.fn_wheel_can_operate(v_host, v_kind, v_user) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Only The Host''s Owners And Admins Read This');
  END IF;

  v_promo := public.fn_diamond_game_promo(v_host, v_kind);
  v_bank  := public.fn_diamond_game_bank(v_host, v_kind);
  v_cover := public.fn_diamond_game_cover(v_host, v_kind);
  v_owner := public.fn_diamond_game_owner(v_host, v_kind);
  SELECT COALESCE(p.diamonds, 0) INTO v_owner_dia FROM public.profiles p WHERE p.id = v_owner;

  FOREACH v_g IN ARRAY ARRAY['plinko', 'crash'] LOOP
    SELECT * INTO cfg FROM public.diamond_game_configs WHERE host_id = v_host AND game = v_g;
    CONTINUE WHEN cfg.host_id IS NULL;
    SELECT * INTO pool FROM public.diamond_game_pools WHERE host_id = v_host AND game = v_g;
    v_max_chips := cfg.max_bet_diamonds::numeric / v_rate;
    v_min_chips := GREATEST(cfg.min_bet_diamonds, 1)::numeric / v_rate;
    -- The same function the door uses, so the console cannot say one thing
    -- while the game does another.
    v_cap_max := public.fn_diamond_game_cap_cents(cfg, pool, v_cover, v_max_chips, cfg.max_multiplier_cents);
    v_cap_min := public.fn_diamond_game_cap_cents(cfg, pool, v_cover, v_min_chips, cfg.max_multiplier_cents);
    -- TWO DIFFERENT CEILINGS, AND ONLY ONE OF THEM IS THE OPERATOR'S TO FIX.
    -- fn_diamond_game_cap_cents takes the LEAST of the configured ceiling, the
    -- intake headroom and the cover. Asking it again with a bank nothing could
    -- exhaust isolates the first two, so the console can say which is binding:
    --   the INTAKE headroom means the game has not taken enough in yet to risk
    --   a payout that size, which is the never-pay-more-than-taken-in law
    --   working exactly as intended and nothing to act on;
    --   the COVER means the promo wallet and the bank cannot carry the win,
    --   which is the operator's to fix and the only thing worth a warning.
    -- Reporting them as one number would tell an owner to move chips they do
    -- not need to move.
    v_cap_free := public.fn_diamond_game_cap_cents(cfg, pool, 1000000000000, v_max_chips, cfg.max_multiplier_cents);
    v_state := CASE
      WHEN NOT cfg.enabled THEN 'closed'
      WHEN v_cap_min <= 100 THEN 'stopped'
      WHEN v_cap_max < v_cap_free THEN 'thin'
      ELSE 'open' END;
    v_games := v_games || jsonb_build_object(
      'game', v_g,
      'enabled', cfg.enabled,
      'state', v_state,
      'max_bet_diamonds', cfg.max_bet_diamonds,
      'max_win_chips', round(v_max_chips * v_cap_max / 100.0, 2),
      'intake_win_chips', round(v_max_chips * v_cap_free / 100.0, 2),
      'ceiling_win_chips', round(v_max_chips * cfg.max_multiplier_cents / 100.0, 2),
      'capped_by_cover', v_cap_max < v_cap_free,
      'capped_by_intake', v_cap_free < cfg.max_multiplier_cents,
      'reserved_chips', COALESCE(pool.reserved_chips, 0));
  END LOOP;

  SELECT * INTO wcfg FROM public.wheel_configs WHERE host_id = v_host;
  IF wcfg.host_id IS NOT NULL THEN
    SELECT COALESCE(wcfg.spin_price_diamonds / v.spin_price_diamonds, 1) INTO v_mult
      FROM public.wheel_segment_versions v WHERE v.version = wcfg.segment_version;
    v_mult := COALESCE(v_mult, 1);
    SELECT COALESCE(max(CASE WHEN g.kind = 'chips' THEN g.amount::numeric * v_mult ELSE 0 END), 0),
           COALESCE(max(CASE WHEN g.kind = 'diamonds' THEN g.amount::numeric * v_mult ELSE 0 END), 0)
      INTO v_top_chip, v_top_dia
      FROM public.wheel_segments g WHERE g.version = wcfg.segment_version;
    v_wheel := jsonb_build_object(
      'game', 'wheel',
      'enabled', wcfg.enabled,
      -- The wheel does not cap a multiplier; it locks the tiers it cannot pay.
      -- It can therefore go thin in a way no chip reading would show: on the
      -- OWNER'S diamonds, which is what its diamond prizes come out of.
      'state', CASE
        WHEN NOT wcfg.enabled THEN 'closed'
        WHEN v_cover < v_top_chip AND v_owner_dia < v_top_dia THEN 'stopped'
        WHEN v_cover < v_top_chip OR v_owner_dia < v_top_dia THEN 'thin'
        ELSE 'open' END,
      'top_chip_prize_chips', round(v_top_chip, 2),
      'top_diamond_prize_diamonds', v_top_dia,
      'chip_prize_covered', v_cover >= v_top_chip,
      'diamond_prize_covered', v_owner_dia >= v_top_dia,
      'spin_price_diamonds', wcfg.spin_price_diamonds);
    v_games := v_games || v_wheel;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'host_id', v_host, 'host_kind', v_kind, 'diamonds_per_chip', v_rate,
    'cover_chips', round(v_cover, 2),
    'promo_chips', round(v_promo, 2),
    'bank_chips', round(v_bank, 2),
    'owner_diamonds', v_owner_dia,
    'games', v_games);
END $function$;

REVOKE ALL ON FUNCTION public.fn_diamond_game_room(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_diamond_game_room(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_room(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_room(uuid) TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Who is playing
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_diamond_game_players(p_club_id uuid, p_limit integer DEFAULT 25)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  v_rate integer := public.fn_ca_bridge_rate();
  v_spin_cap integer; v_round_cap integer;
  v_rows jsonb; v_n integer := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 200);
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In First');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  IF NOT public.fn_wheel_can_operate(v_host, v_kind, v_user) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Only The Host''s Owners And Admins Read This');
  END IF;
  SELECT max_spins_per_player_per_day INTO v_spin_cap FROM public.wheel_configs WHERE host_id = v_host;
  SELECT max(max_rounds_per_player_per_day) INTO v_round_cap FROM public.diamond_game_configs WHERE host_id = v_host;

  WITH ev AS (
    -- The day the CAPS are counted on, so the console and the door agree about
    -- when the day turns.
    SELECT s.user_id, 'wheel'::text AS game, 1 AS spins, 0 AS rounds,
           CASE WHEN s.is_welcome THEN 0 ELSE s.spin_price_diamonds END::numeric AS spent_dia,
           CASE WHEN s.outcome_kind = 'chips' THEN COALESCE(s.outcome_amount, 0) ELSE 0 END AS won_chips,
           CASE WHEN s.outcome_kind = 'diamonds' THEN COALESCE(s.outcome_amount, 0) ELSE 0 END AS won_dia
      FROM public.wheel_spins s
     WHERE s.host_id = v_host AND NOT COALESCE(s.is_fixture, false)
       AND (s.created_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date
    UNION ALL
    SELECT d.user_id, 'plinko', 0, 1, d.bet_diamonds::numeric, COALESCE(d.payout_chips, 0), 0
      FROM public.plinko_drops d
     WHERE d.host_id = v_host AND NOT COALESCE(d.is_fixture, false)
       AND (d.created_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date
    UNION ALL
    SELECT c.user_id, 'crash', 0, 1, c.bet_diamonds::numeric, COALESCE(c.payout_chips, 0), 0
      FROM public.crash_rounds c
     WHERE c.host_id = v_host AND NOT COALESCE(c.is_fixture, false) AND c.status <> 'open'
       AND (c.started_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date
  ), agg AS (
    SELECT user_id,
           sum(spins)::integer AS spins,
           sum(rounds)::integer AS rounds,
           sum(spent_dia) AS spent_dia,
           sum(won_chips) AS won_chips,
           sum(won_dia) AS won_dia
      FROM ev GROUP BY user_id
  )
  SELECT jsonb_agg(r ORDER BY (r->>'spent_diamonds')::numeric DESC) INTO v_rows
    FROM (
      SELECT jsonb_build_object(
               'user_id', a.user_id,
               'name', public.fn_player_display_name(a.user_id),
               'spins', a.spins,
               'rounds', a.rounds,
               'spins_cap', COALESCE(v_spin_cap, 0),
               'rounds_cap', COALESCE(v_round_cap, 0),
               'at_spin_cap', COALESCE(v_spin_cap, 0) > 0 AND a.spins >= v_spin_cap,
               'at_round_cap', COALESCE(v_round_cap, 0) > 0 AND a.rounds >= v_round_cap,
               'spent_diamonds', a.spent_dia,
               'spent_chips', round(a.spent_dia / v_rate, 2),
               'won_chips', round(a.won_chips, 2),
               'won_diamonds', a.won_dia,
               -- What the player is up or down, from the player's side.
               'net_chips', round(a.won_chips + a.won_dia / v_rate - a.spent_dia / v_rate, 2)) AS r
        FROM agg a
       ORDER BY a.spent_dia DESC
       LIMIT v_n
    ) t;

  RETURN jsonb_build_object('ok', true, 'host_id', v_host, 'host_kind', v_kind,
                            'diamonds_per_chip', v_rate,
                            'spins_cap', COALESCE(v_spin_cap, 0),
                            'rounds_cap', COALESCE(v_round_cap, 0),
                            'players', COALESCE(v_rows, '[]'::jsonb));
END $function$;

REVOKE ALL ON FUNCTION public.fn_diamond_game_players(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_diamond_game_players(uuid, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_players(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_players(uuid, integer) TO service_role;

COMMIT;
