-- 20261026053730_digest_player_time_ends_at_the_last_hand_of_a_seat_left_open.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Follow-up to 20261026033215 (Real Player Totals in the daily digest).
--
-- FOUND ON PRODUCTION DATA, 2026-10-26: cash_player_session rows stay open
-- (closed_at NULL) after a player has left the seat. The first version ended an
-- open session at now(), so for Oct 25 Kokimo (10 hands between 22:15 and 22:23
-- UTC) read 406 minutes played, ford 486 and Lucky 506.
--
-- The same read found the opposite case closed properly: danimal5022 sat at a
-- PLO5 1/2 seat on Oct 24 from 06:22 to 14:39 UTC with no hand dealt, which
-- counted as 8 hours played.
--
-- WHAT THIS CHANGES: only the "sess" source of time played. A seat now counts
-- from two minutes before the first cash hand dealt to the player in it (same
-- game and stakes) to their last hand there; an open seat is bounded by the
-- player's next seat at that game. A seat with no hand dealt adds nothing. Every money, rake, balance and game
-- figure is unchanged. Execute stays service_role only.
-- Rollback: re-apply 20261026033215's function body.
--
-- @live-proof: (SELECT count(*)=1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_sp_digest_player_totals' AND prosecdef AND position('never at now()' in prosrc) > 0 AND NOT has_function_privilege('anon', oid, 'EXECUTE'))

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_sp_digest_player_totals(p_day date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
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

COMMENT ON FUNCTION public.fn_sp_digest_player_totals(date) IS
  'Daily digest: every real player''s result, games, rake, end-of-day balances and time played for one Central day. Read only.';

COMMIT;
