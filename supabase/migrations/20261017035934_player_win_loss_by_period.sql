-- 20261017035934_player_win_loss_by_period.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan 2026-10-16: "WHEN YOU ARE ON THE PLAYERS OR PLAYER MANAGEMENT, YOU
-- SHOULD BE ABLE TO SEE THERE OVERALL WIN LOSS NUMBERS, AS WELL AS BROKEN
-- DOWN BY DAILY, WEEKLY MONTHLY ETC. CURRENTLY THAT DOESN'T EXIST."
--
-- Two read-only functions. Nothing here writes, and no table changes.
--
--   ca_club_member_win_loss(club, user)
--       One member: Today, This Week, This Month and Overall, each split into
--       cash and tournament and summed. For the Player Record.
--   ca_club_members_win_loss(club, users[], period)
--       Up to 100 members for ONE period. For the Players list, which asks for
--       the rows on screen after the roster page has arrived.
--
-- WHAT EACH NUMBER IS, read from the same exact sources the record already uses:
--
--   Cash      the signed hand result of every cash hand the player played in
--             this club (after rake): club_member_play_totals.net for Overall,
--             club_member_daily_facts.net (is_mtt = false) for a dated period.
--             The record's existing "Total Winnings" is the same figure.
--   Tournament money, not tournament chips: every posted chip_ledger leg
--             between this player's wallet and a tournament's prize pool in
--             this club. Prizes, bounties and refunds back to the wallet count
--             up; buy-ins (fee included), rebuys and add-ons out of it count
--             down. The record's "MTT Winnings" is tournament-hand CHIP net,
--             which is not money, so it is deliberately not used here.
--   Net       Cash + Tournament.
--
-- PERIODS are UTC calendar days, because club_member_daily_facts buckets hands
-- by (played_at AT TIME ZONE 'UTC')::date, and the tournament legs are cut on
-- the same boundaries so the two halves always describe the same window.
-- This Week starts Monday. Overall is all retained activity.
--
-- ACCESS is the record's own: ca_club_roster_access must be staff, downline or
-- service, exactly the rule that decides whether the record shows wallets and
-- statistics. Anyone else gets NULL (one member) or no row (the list). Horses
-- are players (CLAUDE.md 10.5): nothing here looks at is_horse.
--
-- PERFORMANCE, measured 2026-10-17 on production before writing this: Overall
-- tournament net for the heaviest tournament player of the last day (185
-- buy-ins that day) took 159 ms through the (club_id, from/to_entity_id,
-- created_at) indexes. The list function caps a call at 100 members.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '2s';

-- The tournament money one member moved in one club over [p_from, p_to).
-- NULL bounds mean unbounded. Positive is money back to the wallet.
CREATE OR REPLACE FUNCTION public.ca_club_member_tournament_money(
  p_club_id uuid,
  p_user_id uuid,
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL
)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT coalesce(sum(leg.signed), 0)
    FROM (
      SELECT l.amount AS signed
        FROM public.chip_ledger l
       WHERE l.club_id = p_club_id
         AND l.to_entity_id = p_user_id
         AND l.to_type = 'player_wallet'
         AND l.from_type = 'prize_liability'
         AND l.tournament_id IS NOT NULL
         AND l.status = 'posted'
         AND (p_from IS NULL OR l.created_at >= p_from)
         AND (p_to IS NULL OR l.created_at < p_to)
      UNION ALL
      SELECT -l.amount
        FROM public.chip_ledger l
       WHERE l.club_id = p_club_id
         AND l.from_entity_id = p_user_id
         AND l.from_type = 'player_wallet'
         AND l.to_type = 'prize_liability'
         AND l.tournament_id IS NOT NULL
         AND l.status = 'posted'
         AND (p_from IS NULL OR l.created_at >= p_from)
         AND (p_to IS NULL OR l.created_at < p_to)
    ) leg;
$function$;

CREATE OR REPLACE FUNCTION public.ca_club_member_win_loss(p_club_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_access text := public.ca_club_roster_access(p_club_id, p_user_id);
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_week date := date_trunc('week', v_today)::date;
  v_month date := date_trunc('month', v_today)::date;
  v_earliest date;
  v_cash_today numeric; v_cash_week numeric; v_cash_month numeric; v_cash_all numeric;
  v_mtt_today numeric; v_mtt_week numeric; v_mtt_month numeric; v_mtt_all numeric;
BEGIN
  IF v_access IS NULL OR v_access NOT IN ('staff', 'downline', 'service') THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.club_member_daily_facts_state WHERE singleton AND initialized)
  THEN RAISE EXCEPTION 'Member daily facts are not initialized'; END IF;

  -- A week that started last month reaches back past the 1st.
  v_earliest := least(v_week, v_month);

  SELECT coalesce(sum(f.net) FILTER (WHERE f.played_on = v_today), 0),
         coalesce(sum(f.net) FILTER (WHERE f.played_on >= v_week), 0),
         coalesce(sum(f.net) FILTER (WHERE f.played_on >= v_month), 0)
    INTO v_cash_today, v_cash_week, v_cash_month
    FROM public.club_member_daily_facts f
   WHERE f.club_id = p_club_id AND f.user_id = p_user_id
     AND NOT f.is_mtt
     AND f.played_on >= v_earliest AND f.played_on <= v_today;

  SELECT coalesce(t.net, 0) INTO v_cash_all
    FROM (SELECT 1) anchor
    LEFT JOIN public.club_member_play_totals t
      ON t.club_id = p_club_id AND t.user_id = p_user_id;

  v_mtt_today := public.ca_club_member_tournament_money(
    p_club_id, p_user_id, v_today::timestamp AT TIME ZONE 'UTC', NULL);
  v_mtt_week := public.ca_club_member_tournament_money(
    p_club_id, p_user_id, v_week::timestamp AT TIME ZONE 'UTC', NULL);
  v_mtt_month := public.ca_club_member_tournament_money(
    p_club_id, p_user_id, v_month::timestamp AT TIME ZONE 'UTC', NULL);
  v_mtt_all := public.ca_club_member_tournament_money(p_club_id, p_user_id, NULL, NULL);

  RETURN jsonb_build_object(
    'as_of', v_today,
    'week_from', v_week,
    'month_from', v_month,
    'today', jsonb_build_object('cash', round(v_cash_today, 2), 'mtt', round(v_mtt_today, 2),
                                'net', round(v_cash_today + v_mtt_today, 2)),
    'week', jsonb_build_object('cash', round(v_cash_week, 2), 'mtt', round(v_mtt_week, 2),
                               'net', round(v_cash_week + v_mtt_week, 2)),
    'month', jsonb_build_object('cash', round(v_cash_month, 2), 'mtt', round(v_mtt_month, 2),
                                'net', round(v_cash_month + v_mtt_month, 2)),
    'overall', jsonb_build_object('cash', round(v_cash_all, 2), 'mtt', round(v_mtt_all, 2),
                                  'net', round(v_cash_all + v_mtt_all, 2))
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ca_club_members_win_loss(
  p_club_id uuid,
  p_user_ids uuid[],
  p_period text DEFAULT 'overall'
)
 RETURNS TABLE(user_id uuid, cash numeric, mtt numeric, net numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_period text := lower(btrim(coalesce(p_period, 'overall')));
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_from date;
BEGIN
  IF v_period NOT IN ('today', 'week', 'month', 'overall') THEN
    RAISE EXCEPTION 'Invalid win loss period' USING ERRCODE = '22023';
  END IF;
  IF coalesce(cardinality(p_user_ids), 0) > 100 THEN
    RAISE EXCEPTION 'At most 100 members per call' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.club_member_daily_facts_state WHERE singleton AND initialized)
  THEN RAISE EXCEPTION 'Member daily facts are not initialized'; END IF;

  v_from := CASE v_period
    WHEN 'today' THEN v_today
    WHEN 'week' THEN date_trunc('week', v_today)::date
    WHEN 'month' THEN date_trunc('month', v_today)::date
    ELSE NULL END;

  RETURN QUERY
  WITH asked AS (
    SELECT DISTINCT u AS uid FROM unnest(coalesce(p_user_ids, ARRAY[]::uuid[])) u WHERE u IS NOT NULL
  ), allowed AS (
    SELECT a.uid FROM asked a
     WHERE public.ca_club_roster_access(p_club_id, a.uid) IN ('staff', 'downline', 'service')
  ), cash AS (
    SELECT al.uid,
           CASE WHEN v_from IS NULL THEN
             (SELECT coalesce(t.net, 0) FROM (SELECT 1) anchor
                LEFT JOIN public.club_member_play_totals t
                  ON t.club_id = p_club_id AND t.user_id = al.uid)
           ELSE
             (SELECT coalesce(sum(f.net), 0) FROM public.club_member_daily_facts f
               WHERE f.club_id = p_club_id AND f.user_id = al.uid AND NOT f.is_mtt
                 AND f.played_on >= v_from AND f.played_on <= v_today)
           END AS cash_net
      FROM allowed al
  )
  SELECT c.uid,
         round(c.cash_net, 2),
         round(m.mtt_net, 2),
         round(c.cash_net + m.mtt_net, 2)
    FROM cash c
    CROSS JOIN LATERAL (
      SELECT public.ca_club_member_tournament_money(
        p_club_id, c.uid,
        CASE WHEN v_from IS NULL THEN NULL ELSE v_from::timestamp AT TIME ZONE 'UTC' END,
        NULL) AS mtt_net
    ) m;
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_club_member_tournament_money(uuid, uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_club_member_tournament_money(uuid, uuid, timestamptz, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.ca_club_member_win_loss(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_member_win_loss(uuid, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.ca_club_members_win_loss(uuid, uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_members_win_loss(uuid, uuid[], text) TO authenticated, service_role;

COMMIT;
