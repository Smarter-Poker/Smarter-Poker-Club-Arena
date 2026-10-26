-- 20261026140704_digest_real_player_totals_for_the_last_7_days_and_month_to_d.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, 2026-10-26: "FOR THE REAL PLAYERS TOTAL, GIVE ME A MONTH TO DATE,
-- WEEKLY AND DAILY COUNT." The Real Player Totals card in the Daily Operations
-- Digest shows one Central day. It now shows the day, the last 7 days and the
-- month to date side by side.
--
-- WHY NOT ONE QUERY OVER THE MONTH: measured on production 2026-10-26, the
-- day's totals take 2.4-5 s, and the same query over Oct 1-25 ran past 120 s.
-- So each day's per-player result is kept once, in sp_digest_player_days, and
-- the week and month are added up from those kept days. Every figure on the
-- card is a sum of daily figures (each day's minutes are clipped to that day,
-- so nothing is counted twice) except two, which are worked out exactly:
-- players is a distinct count, and the wallets are the period's players'
-- balances at the end of the period.
--
-- fn_sp_digest_player_period(day):
--   1. builds the day itself (fn_sp_digest_player_totals) and keeps it;
--   2. reads earlier kept days of the 7-day window/month. Any day not
--      kept yet in a finite explicit installation fill, outside the email
--      request. One production day measured27.2s, so three additional daily
--      reports must never share the email request budget. Missing history
--      remains explicit until the installation fill completes;
--   3. returns the day's full totals (what the digest already shows) plus
--      period.day / period.week / period.month.
-- A failure in the period part never takes the day's totals with it.
--
-- fn_sp_digest_player_totals is re-created only to add each player's user_id
-- (the distinct count needs it; usernames can change). Its body is otherwise
-- byte-identical to 20261026053730, and it keeps SET statement_timeout 60s
-- from 20261026130853.
--
-- The kept rows are a reporting snapshot (CLAUDE.md 10.12 allows snapshots for
-- reporting); nothing reads them to move money. No foreign key to any hot
-- table (section 2 rule 7). Execute and table access are service_role only.
-- Rollback: drop fn_sp_digest_player_period and the two tables, and
-- re-apply 20261026053730 plus 20261026130853.
--
-- @live-proof: (SELECT count(*)=1 FROM pg_proc WHERE oid = to_regprocedure('public.fn_sp_digest_player_period(date)') AND prosecdef AND 'statement_timeout=60s' = ANY(proconfig) AND NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')) AND (SELECT 'statement_timeout=60s' = ANY(proconfig) AND position('''user_id'', r.user_id' in prosrc) > 0 FROM pg_proc WHERE oid = to_regprocedure('public.fn_sp_digest_player_totals(date)'))
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.sp_digest_player_days (
  day date NOT NULL,
  user_id uuid NOT NULL,
  username text,
  net numeric NOT NULL DEFAULT 0,
  cash_net numeric NOT NULL DEFAULT 0,
  tournament_net numeric NOT NULL DEFAULT 0,
  cash_rake numeric NOT NULL DEFAULT 0,
  tournament_rake numeric NOT NULL DEFAULT 0,
  hands bigint NOT NULL DEFAULT 0,
  minutes numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id)
);

CREATE TABLE IF NOT EXISTS public.sp_digest_player_day_runs (
  day date PRIMARY KEY,
  players int NOT NULL,
  built_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE public.sp_digest_player_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sp_digest_player_day_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sp_digest_player_days, public.sp_digest_player_day_runs FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.sp_digest_player_days, public.sp_digest_player_day_runs TO service_role;

COMMENT ON TABLE public.sp_digest_player_days IS
  'Daily digest: one row per real player per Central day, kept by fn_sp_digest_player_period so the week and month can be added up. Reporting snapshot only.';
COMMENT ON TABLE public.sp_digest_player_day_runs IS
  'Daily digest: which Central days are kept in sp_digest_player_days (a day with no real players is kept with players = 0).';

CREATE OR REPLACE FUNCTION public.fn_sp_digest_player_totals(p_day date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '60s'
AS $function$
DECLARE
  s timestamptz := (p_day::timestamp AT TIME ZONE 'America/Chicago');
  e timestamptz := ((p_day + 1)::timestamp AT TIME ZONE 'America/Chicago');
  v_da uuid := public.fn_diamond_arena_club();
  v jsonb;
BEGIN
  WITH hu AS MATERIALIZED (SELECT id, username FROM smarter_private.sp_real_humans),
  hf AS MATERIALIZED (
    SELECT f.hand_id, f.user_id, f.club_id, f.table_id, f.tournament_id, f.played_at,
           f.game_variant, f.big_blind, f.net
      FROM public.ca_hand_facts f
     WHERE f.played_at >= s AND f.played_at < e
       AND f.user_id IN (SELECT id FROM hu)),
  ra AS MATERIALIZED (
    SELECT r.player_id AS user_id, r.hand_id, r.club_id, r.rake_amount
      FROM public.rake_attributions r
     WHERE r.club_id IS NOT NULL AND r.created_at >= s AND r.created_at < e
       AND r.player_id IN (SELECT id FROM hu)),
  -- one row per cash hand (or rake line) of a real player, with its game
  cash AS (
    SELECT COALESCE(h.user_id, r.user_id) AS user_id,
           (COALESCE(h.club_id, r.club_id) IS NOT DISTINCT FROM v_da) AS da,
           COALESCE(h.game_variant, hh.game_variant) AS variant,
           COALESCE(h.big_blind, hh.big_blind) AS bb,
           h.table_id, h.played_at, h.hand_id IS NOT NULL AS dealt,
           COALESCE(h.net, 0) AS net, COALESCE(r.rake_amount, 0) AS rake
      FROM (SELECT * FROM hf WHERE tournament_id IS NULL) h
      FULL JOIN ra r ON r.hand_id = h.hand_id AND r.user_id = h.user_id
      LEFT JOIN public.hand_history hh ON h.hand_id IS NULL AND hh.id = r.hand_id),
  -- A seat counts only while hands are dealt to the player in it: from two
  -- minutes before their first hand to their last hand. A seat left open
  -- after they went (closed_at NULL hours later) ends at that last hand, never
  -- at now(), and a seat where no hand was dealt (waiting at an empty table)
  -- is not time played.
  sess AS (
    SELECT c.player_id AS user_id, c.variant, c.bb,
           tstzrange(GREATEST(c.opened_at, x.first_hand - interval '2 minutes'), LEAST(x.last_hand, e)) AS r
      FROM public.cash_player_session c
      CROSS JOIN LATERAL (
        SELECT min(f.played_at) AS first_hand, max(f.played_at) AS last_hand
          FROM public.ca_hand_facts f
         WHERE f.user_id = c.player_id AND f.tournament_id IS NULL
           AND f.game_variant = c.variant AND f.big_blind = c.bb
           AND f.played_at >= c.opened_at
           AND f.played_at <= COALESCE(c.closed_at, c.final_stack_captured_at,
                 (SELECT min(c2.opened_at) FROM public.cash_player_session c2
                   WHERE c2.player_id = c.player_id AND c2.variant = c.variant
                     AND c2.bb = c.bb AND c2.opened_at > c.opened_at), 'infinity')) x
     WHERE c.player_id IN (SELECT id FROM hu)
       AND c.opened_at < e AND COALESCE(c.closed_at, c.final_stack_captured_at, 'infinity') > s
       AND x.last_hand > s
       AND LEAST(x.last_hand, e) > GREATEST(c.opened_at, x.first_hand - interval '2 minutes')),
  cash_games AS (
    SELECT g.user_id, g.da, g.variant, g.bb,
           count(*) FILTER (WHERE g.dealt) AS hands, sum(g.net) AS net, sum(g.rake) AS rake,
           (SELECT max(t.small_blind) FROM public.tables t WHERE t.id = ANY (array_agg(DISTINCT g.table_id))) AS sb,
           range_agg(tstzrange(g.played_at - interval '2 minutes', g.played_at)) FILTER (WHERE g.played_at IS NOT NULL) AS played
      FROM cash g GROUP BY 1, 2, 3, 4),
  -- tournament money the way Win / Loss counts it: entries out, prizes, bounties and refunds back
  tl AS MATERIALIZED (
    SELECT x.user_id, x.tournament_id, x.signed, x.paid_in, x.refunded FROM (
      SELECT CASE WHEN l.to_type = 'player_wallet' THEN l.to_entity_id ELSE l.from_entity_id END AS user_id,
             l.tournament_id,
             CASE WHEN l.to_type = 'player_wallet' THEN l.amount ELSE -l.amount END AS signed,
             CASE WHEN l.from_type = 'player_wallet' THEN l.amount ELSE 0 END AS paid_in,
             CASE WHEN l.to_type = 'player_wallet' AND l.category = 'refund' THEN l.amount ELSE 0 END AS refunded
        FROM public.chip_ledger l
       WHERE l.created_at >= s AND l.created_at < e AND l.status = 'posted' AND l.tournament_id IS NOT NULL
         AND ((l.from_type = 'player_wallet' AND l.to_type = 'prize_liability')
           OR (l.from_type = 'prize_liability' AND l.to_type = 'player_wallet'))) x
     WHERE x.user_id IN (SELECT id FROM hu)),
  tkeys AS (
    SELECT user_id, tournament_id FROM tl
    UNION SELECT user_id, tournament_id FROM hf WHERE tournament_id IS NOT NULL),
  -- each tournament's posted rake and the entry money it was taken from
  trk AS (
    SELECT k.tid,
           COALESCE((SELECT sum(l.amount) FROM public.chip_ledger l
                      WHERE l.tournament_id = k.tid AND l.category = 'rake'
                        AND l.from_type = 'prize_liability' AND l.status = 'posted'), 0) AS rake,
           COALESCE((SELECT sum(CASE WHEN l.to_type = 'prize_liability' THEN l.amount ELSE -l.amount END)
                       FROM public.chip_ledger l
                      WHERE l.tournament_id = k.tid AND l.status = 'posted'
                        AND ((l.category IN ('tournament_buyin','rebuy','addon','ticket_redeem')
                              AND l.from_type IN ('player_wallet','escrow') AND l.to_type = 'prize_liability')
                          OR (l.category = 'refund' AND l.from_type = 'prize_liability' AND l.to_type = 'player_wallet'))), 0) AS entries
      FROM (SELECT DISTINCT tournament_id AS tid FROM tkeys) k),
  t_games AS (
    SELECT k.user_id, k.tournament_id, t.name, t.tournament_type,
           COALESCE(m.net, 0) AS net,
           CASE WHEN trk.entries > 0 THEN round(trk.rake * GREATEST(COALESCE(m.paid_in, 0) - COALESCE(m.refunded, 0), 0) / trk.entries, 2) ELSE 0 END AS rake,
           COALESCE(hs.hands, 0) AS hands, hs.played
      FROM tkeys k
      JOIN trk ON trk.tid = k.tournament_id
      LEFT JOIN public.tournaments t ON t.id = k.tournament_id
      LEFT JOIN (SELECT user_id, tournament_id, sum(signed) net, sum(paid_in) paid_in, sum(refunded) refunded
                   FROM tl GROUP BY 1, 2) m ON m.user_id = k.user_id AND m.tournament_id = k.tournament_id
      LEFT JOIN (SELECT user_id, tournament_id, count(*) hands,
                        range_agg(tstzrange(played_at - interval '2 minutes', played_at)) played
                   FROM hf WHERE tournament_id IS NOT NULL GROUP BY 1, 2) hs
             ON hs.user_id = k.user_id AND hs.tournament_id = k.tournament_id),
  games AS (
    SELECT g.user_id,
           CASE WHEN g.da THEN 'diamond_arena' ELSE 'cash' END AS kind,
           CASE WHEN g.variant IS NULL THEN 'Other'
                ELSE CASE lower(g.variant) WHEN 'nlh' THEN 'NLH' WHEN 'short_deck' THEN 'Short Deck'
                                           WHEN 'pineapple' THEN 'Pineapple' ELSE upper(g.variant) END
                     || COALESCE(' ' || trim_scale(COALESCE(g.sb, g.bb / 2))::text || '/' || trim_scale(g.bb)::text, '')
           END AS label,
           NULL::text AS type, NULL::bigint AS entries,
           g.hands, round(g.net, 2) AS net, round(g.rake, 2) AS rake,
           COALESCE(g.played, '{}'::tstzmultirange)
             + COALESCE((SELECT range_agg(x.r) FROM sess x WHERE x.user_id = g.user_id AND NOT g.da
                           AND x.variant = g.variant AND x.bb = g.bb), '{}'::tstzmultirange) AS played
      FROM cash_games g
    UNION ALL
    -- a recurring event (the same name and type) is one line, with how many were played
    SELECT tg.user_id, 'tournament', COALESCE(tg.name, 'Tournament'), tg.tournament_type, count(*),
           sum(tg.hands), round(sum(tg.net), 2), sum(tg.rake), range_agg(COALESCE(tg.played, '{}'::tstzmultirange))
      FROM t_games tg GROUP BY tg.user_id, COALESCE(tg.name, 'Tournament'), tg.tournament_type),
  per AS (
    SELECT g.user_id,
           sum(g.net) FILTER (WHERE g.kind = 'cash') AS cash_net,
           sum(g.net) FILTER (WHERE g.kind = 'tournament') AS tournament_net,
           sum(g.net) FILTER (WHERE g.kind = 'diamond_arena') AS diamond_arena_net,
           sum(g.rake) FILTER (WHERE g.kind = 'cash') AS cash_rake,
           sum(g.rake) FILTER (WHERE g.kind = 'tournament') AS tournament_rake,
           sum(g.rake) FILTER (WHERE g.kind = 'diamond_arena') AS diamond_arena_rake,
           sum(g.hands) AS hands,
           range_agg(g.played) AS played,
           jsonb_agg(jsonb_build_object(
               'kind', g.kind, 'label', g.label, 'type', g.type, 'entries', g.entries,
               'hands', g.hands, 'net', g.net, 'rake', g.rake,
               'minutes', (SELECT round(COALESCE(sum(extract(epoch FROM upper(z) - lower(z))), 0) / 60)
                             FROM unnest(g.played * tstzmultirange(tstzrange(s, e))) z))
             ORDER BY CASE g.kind WHEN 'cash' THEN 1 WHEN 'tournament' THEN 2 ELSE 3 END, g.net DESC) AS games
      FROM games g
     GROUP BY g.user_id),
  rows AS (
    SELECT hu.username, p.*,
           (SELECT round(COALESCE(sum(extract(epoch FROM upper(z) - lower(z))), 0) / 60)
              FROM unnest((COALESCE(p.played, '{}'::tstzmultirange)
                           + COALESCE((SELECT range_agg(x.r) FROM sess x WHERE x.user_id = p.user_id), '{}'::tstzmultirange))
                          * tstzmultirange(tstzrange(s, e))) z) AS minutes,
           -- wallet at the end of the day: today's balance with every later posted leg taken back out
           (SELECT COALESCE(sum(cm.chip_balance), 0) FROM public.club_members cm
             WHERE cm.user_id = p.user_id AND cm.club_id IS DISTINCT FROM v_da)
           - COALESCE((SELECT sum(l.amount) FROM public.chip_ledger l
                        WHERE l.to_entity_id = p.user_id AND l.to_type = 'player_wallet' AND l.status = 'posted'
                          AND l.created_at >= e AND l.club_id IS DISTINCT FROM v_da), 0)
           + COALESCE((SELECT sum(l.amount) FROM public.chip_ledger l
                        WHERE l.from_entity_id = p.user_id AND l.from_type = 'player_wallet' AND l.status = 'posted'
                          AND l.created_at >= e AND l.club_id IS DISTINCT FROM v_da), 0) AS wallet_end,
           COALESCE((SELECT b.balance FROM public.user_diamond_balance b WHERE b.user_id = p.user_id), 0)
           - COALESCE((SELECT sum(d.amount) FROM public.diamond_transactions d
                        WHERE d.user_id = p.user_id AND d.created_at >= e), 0) AS diamonds_end
      FROM per p JOIN hu ON hu.id = p.user_id)
  SELECT jsonb_build_object(
    'players', COALESCE(jsonb_agg(jsonb_build_object(
        'user_id', r.user_id,
        'username', r.username,
        'net', round(COALESCE(r.cash_net, 0) + COALESCE(r.tournament_net, 0), 2),
        'cash_net', round(COALESCE(r.cash_net, 0), 2),
        'tournament_net', round(COALESCE(r.tournament_net, 0), 2),
        'diamond_arena_net', round(COALESCE(r.diamond_arena_net, 0), 2),
        'cash_rake', round(COALESCE(r.cash_rake, 0), 2),
        'tournament_rake', round(COALESCE(r.tournament_rake, 0), 2),
        'diamond_arena_rake', round(COALESCE(r.diamond_arena_rake, 0), 2),
        'hands', COALESCE(r.hands, 0),
        'minutes', COALESCE(r.minutes, 0),
        'wallet_end', round(r.wallet_end, 2),
        'diamonds_end', r.diamonds_end,
        'games', r.games)
      ORDER BY COALESCE(r.cash_net, 0) + COALESCE(r.tournament_net, 0) DESC, r.username), '[]'::jsonb),
    'totals', jsonb_build_object(
        'players', count(*),
        'net', round(COALESCE(sum(COALESCE(r.cash_net, 0) + COALESCE(r.tournament_net, 0)), 0), 2),
        'cash_net', round(COALESCE(sum(r.cash_net), 0), 2),
        'tournament_net', round(COALESCE(sum(r.tournament_net), 0), 2),
        'diamond_arena_net', round(COALESCE(sum(r.diamond_arena_net), 0), 2),
        'cash_rake', round(COALESCE(sum(r.cash_rake), 0), 2),
        'tournament_rake', round(COALESCE(sum(r.tournament_rake), 0), 2),
        'diamond_arena_rake', round(COALESCE(sum(r.diamond_arena_rake), 0), 2),
        'hands', COALESCE(sum(r.hands), 0),
        'minutes', COALESCE(sum(r.minutes), 0),
        'wallet_end', round(COALESCE(sum(r.wallet_end), 0), 2)))
    INTO v
    FROM rows r;

  RETURN jsonb_build_object('day', p_day, 'window', jsonb_build_object('start', s, 'end', e)) || v;
EXCEPTION WHEN OTHERS THEN
  -- The digest still goes out; its card says these totals could not be built.
  RETURN jsonb_build_object('day', p_day, 'error', SQLERRM);
END $function$;

REVOKE ALL ON FUNCTION public.fn_sp_digest_player_totals(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sp_digest_player_totals(date) TO service_role;

-- Keep one day: the day's totals, written as one row per player.
CREATE OR REPLACE FUNCTION public.fn_sp_digest_keep_player_day(p_day date, p_totals jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_totals IS NULL OR p_totals ? 'error' OR jsonb_typeof(p_totals -> 'players') IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;
  DELETE FROM public.sp_digest_player_days WHERE day = p_day;
  INSERT INTO public.sp_digest_player_days (day, user_id, username, net, cash_net, tournament_net,
                                            cash_rake, tournament_rake, hands, minutes)
  SELECT p_day, (p ->> 'user_id')::uuid, p ->> 'username',
         COALESCE((p ->> 'net')::numeric, 0), COALESCE((p ->> 'cash_net')::numeric, 0),
         COALESCE((p ->> 'tournament_net')::numeric, 0), COALESCE((p ->> 'cash_rake')::numeric, 0),
         COALESCE((p ->> 'tournament_rake')::numeric, 0), COALESCE((p ->> 'hands')::bigint, 0),
         COALESCE((p ->> 'minutes')::numeric, 0)
    FROM jsonb_array_elements(p_totals -> 'players') p
   WHERE p ->> 'user_id' IS NOT NULL;
  INSERT INTO public.sp_digest_player_day_runs (day, players)
  VALUES (p_day, jsonb_array_length(p_totals -> 'players'))
  ON CONFLICT (day) DO UPDATE SET players = EXCLUDED.players, built_at = clock_timestamp();
  RETURN true;
END $function$;

REVOKE ALL ON FUNCTION public.fn_sp_digest_keep_player_day(date, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sp_digest_keep_player_day(date, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_sp_digest_player_period(p_day date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_daily jsonb := public.fn_sp_digest_player_totals(p_day);
  v_week_from date := p_day - 6;
  v_month_from date := date_trunc('month', p_day)::date;
  v_from date := LEAST(p_day - 6, date_trunc('month', p_day)::date);
  v_e timestamptz := ((p_day + 1)::timestamp AT TIME ZONE 'America/Chicago');
  v_da uuid := public.fn_diamond_arena_club();
  v_built int := 0;
  v_missing date[];
  v_period jsonb;
BEGIN
  BEGIN
    PERFORM public.fn_sp_digest_keep_player_day(p_day, v_daily);

    -- History is initialized by a finite, explicitly invoked reporting fill.
    -- Never compute older full daily reports inside the email/view request:
    -- production pg_stat_statements measured27.2s for one day on2026-10-26.
    -- Each normal request keeps only its own day; missing history stays explicit.

    SELECT COALESCE(array_agg(g::date ORDER BY g), '{}') INTO v_missing
      FROM generate_series(v_from, p_day, interval '1 day') g
     WHERE NOT EXISTS (SELECT 1 FROM public.sp_digest_player_day_runs r WHERE r.day = g::date);

    WITH w(k, f) AS (VALUES ('day', p_day), ('week', v_week_from), ('month', v_month_from)),
    agg AS (
      SELECT w.k, w.f,
             count(DISTINCT pd.user_id) AS players,
             COALESCE(sum(pd.hands), 0) AS hands,
             COALESCE(sum(pd.minutes), 0) AS minutes,
             round(COALESCE(sum(pd.net), 0), 2) AS net,
             round(COALESCE(sum(pd.cash_net), 0), 2) AS cash_net,
             round(COALESCE(sum(pd.tournament_net), 0), 2) AS tournament_net,
             round(COALESCE(sum(pd.cash_rake), 0), 2) AS cash_rake,
             round(COALESCE(sum(pd.tournament_rake), 0), 2) AS tournament_rake,
             array_agg(DISTINCT pd.user_id) FILTER (WHERE pd.user_id IS NOT NULL) AS ids,
             (SELECT count(*) FROM unnest(v_missing) m WHERE m >= w.f) AS missing_days
        FROM w LEFT JOIN public.sp_digest_player_days pd ON pd.day BETWEEN w.f AND p_day
       GROUP BY w.k, w.f),
    -- wallets of the period's players at the end of the day, the way the day's
    -- card reads them: today's balance with every later posted leg taken out
    wal AS (
      SELECT a.k,
             round(COALESCE((SELECT sum(cm.chip_balance) FROM public.club_members cm
                              WHERE cm.user_id = ANY (a.ids) AND cm.club_id IS DISTINCT FROM v_da), 0)
             - COALESCE((SELECT sum(l.amount) FROM public.chip_ledger l
                          WHERE l.to_entity_id = ANY (a.ids) AND l.to_type = 'player_wallet' AND l.status = 'posted'
                            AND l.created_at >= v_e AND l.club_id IS DISTINCT FROM v_da), 0)
             + COALESCE((SELECT sum(l.amount) FROM public.chip_ledger l
                          WHERE l.from_entity_id = ANY (a.ids) AND l.from_type = 'player_wallet' AND l.status = 'posted'
                            AND l.created_at >= v_e AND l.club_id IS DISTINCT FROM v_da), 0), 2) AS wallet_end
        FROM agg a)
    SELECT jsonb_object_agg(a.k, jsonb_build_object(
             'from', a.f, 'to', p_day,
             'players', a.players, 'hands', a.hands, 'minutes', a.minutes,
             'net', a.net, 'cash_net', a.cash_net, 'tournament_net', a.tournament_net,
             'cash_rake', a.cash_rake, 'tournament_rake', a.tournament_rake,
             'rake', a.cash_rake + a.tournament_rake,
             'wallet_end', wal.wallet_end,
             'missing_days', a.missing_days))
      INTO v_period
      FROM agg a JOIN wal ON wal.k = a.k;

    v_period := v_period || jsonb_build_object('complete', cardinality(v_missing) = 0, 'built_now', v_built);
  EXCEPTION WHEN OTHERS THEN
    -- the day's totals still go out; the card says the week and month could not be built
    v_period := jsonb_build_object('error', SQLERRM);
  END;
  RETURN COALESCE(v_daily, '{}'::jsonb) || jsonb_build_object('period', v_period);
END $function$;

REVOKE ALL ON FUNCTION public.fn_sp_digest_player_period(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sp_digest_player_period(date) TO service_role;

COMMENT ON FUNCTION public.fn_sp_digest_player_period(date) IS
  'Daily digest: the day''s real player totals (as fn_sp_digest_player_totals) plus period.day / period.week (last 7 days) / period.month (month to date), added up from the kept days in sp_digest_player_days.';

COMMIT;
