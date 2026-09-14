-- 20260911133435_the_mini_jackpot_is_seen_and_discoverable_like_the_main.sql
--
-- Version 20260911133435 is the one production recorded when this was applied (the
-- reserved 20260911133122 was renamed to match it, so the file and the record agree).
--
-- WHAT THIS CHANGES, AND WHY (BBJ programme, phase 2 of 5 - Dan 2026-09-09:
-- "MINI BBJ NEEDS TO BE SEEN AND DISCOVERABLE LIKE THE BBJ CURRENTLY IS"):
--
-- Two days after the mini launched it had paid nineteen times (11,600 chips)
-- and a player could learn of its existence from exactly three places, all of
-- them AFTER a hit: the celebration on the hitting table, the ticker's MINI
-- chip, and the winners list. Nothing before a hand said a second tier
-- existed, what it paid, what qualified for it, or that the "Backup Pool"
-- figure on the jackpot page is what funds it. The engine, the payout RPC and
-- the ledger all knew; the surfaces did not, because no read path existed for
-- the surfaces to ask.
--
-- This migration is the read path. Three functions, all SECURITY DEFINER with
-- explicit grants, none of them moving a chip:
--
--   fn_bbj_mini_for_club(p_club_id)   the mini as a player sees it: which tiers
--                                      pay what, whether each one CAN pay right
--                                      now (the reserve floor, the same test
--                                      fn_bbj_mini_payout applies), the reserve
--                                      itself, and the last thirty days of hits.
--   fn_bbj_hand_detail(p_payout_id)    now says which jackpot a hand was. The
--                                      drilldown of a mini hand looked exactly
--                                      like a main one.
--   fn_bbj_analytics(p_pool_id)        the operator panel gains the mini's own
--                                      count, spend, reserve floor and headroom.
--                                      Its existing columns keep their meaning
--                                      (every hit of either kind), so nothing
--                                      already reading them changes.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL search_path TO public, pg_temp;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The mini, as a player sees it
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_bbj_mini_for_club(p_club_id uuid)
RETURNS TABLE(
  pool_id uuid,
  enabled boolean,
  backup_balance numeric,
  reserve_floor numeric,
  parked numeric,
  available numeric,
  tiers jsonb,
  hits_30d bigint,
  paid_30d numeric,
  last_hit_at timestamptz
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH pool AS (
    SELECT p.pool_id, p.backup_balance
      FROM public.fn_bbj_pool_for_club(p_club_id) p
  ),
  floor_row AS (
    SELECT bp.id, COALESCE(bp.mini_reserve_floor, 0) AS reserve_floor
      FROM public.bbj_pools bp JOIN pool ON pool.pool_id = bp.id
  ),
  parked_row AS (
    /* A parked mini share is still in the reserve but already owed. The
       payout RPC subtracts it before it tests the floor; so does this, or the
       felt would promise a mini the RPC is about to refuse. */
    SELECT public.fn_bbj_parked_reserve(pool.pool_id, 'backup') AS parked FROM pool
  ),
  tier_rows AS (
    SELECT st.id AS tier_id, st.label, st.blind_range, st.min_bb, st.max_bb,
           mt.amount, mt.enabled,
           /* Exactly fn_bbj_mini_payout's refusal, inverted:
                refuse when backup - parked - amount < floor */
           (mt.enabled
            AND COALESCE(pool.backup_balance, 0) - parked_row.parked - mt.amount
                >= floor_row.reserve_floor) AS payable
      FROM public.bbj_stakes_tiers st
      JOIN public.bbj_mini_tiers mt ON mt.tier_id = st.id
      CROSS JOIN pool CROSS JOIN floor_row CROSS JOIN parked_row
  ),
  hits AS (
    SELECT count(*) AS n,
           COALESCE(sum(w.total_payout), 0) AS paid,
           max(w.awarded_at) AS last_at
      FROM public.bbj_winners w JOIN pool ON w.pool_id = pool.pool_id
     WHERE w.kind = 'mini' AND w.awarded_at > now() - interval '30 days'
  )
  SELECT pool.pool_id,
         EXISTS (SELECT 1 FROM public.bbj_mini_tiers t WHERE t.enabled) AS enabled,
         COALESCE(pool.backup_balance, 0) AS backup_balance,
         floor_row.reserve_floor,
         parked_row.parked,
         GREATEST(0, COALESCE(pool.backup_balance, 0) - parked_row.parked - floor_row.reserve_floor)
           AS available,
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
                     'tierId', tr.tier_id,
                     'label', tr.label,
                     'blindRange', tr.blind_range,
                     'minBB', tr.min_bb,
                     'maxBB', tr.max_bb,
                     'amount', tr.amount,
                     'enabled', tr.enabled,
                     'payable', tr.payable) ORDER BY tr.min_bb)
                   FROM tier_rows tr), '[]'::jsonb) AS tiers,
         hits.n AS hits_30d,
         hits.paid AS paid_30d,
         (SELECT max(w.awarded_at) FROM public.bbj_winners w
           WHERE w.pool_id = pool.pool_id AND w.kind = 'mini') AS last_hit_at
    FROM pool, floor_row, parked_row, hits;
$$;

REVOKE ALL ON FUNCTION public.fn_bbj_mini_for_club(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_mini_for_club(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_bbj_mini_for_club(uuid) IS
  'The mini jackpot as a player sees it for one club: every stakes tier''s flat amount, whether that tier can pay right now (backup reserve minus parked shares minus the amount must stay at or above mini_reserve_floor - the same test fn_bbj_mini_payout applies), the reserve itself and thirty days of hits. Reads only.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The hand drilldown says which jackpot it was
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_bbj_hand_detail(p_payout_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH pay AS (SELECT * FROM public.bbj_payouts WHERE id = p_payout_id),
  hh AS (
    SELECT h.* FROM public.hand_history h
    JOIN pay ON h.table_id = pay.table_id AND h.hand_number = pay.hand_number
    ORDER BY h.created_at DESC LIMIT 1
  ),
  win AS (
    SELECT w.* FROM public.bbj_winners w
    JOIN pay ON w.table_id = pay.table_id AND w.hand_number = pay.hand_number
    LIMIT 1
  ),
  seats AS (
    SELECT e.value AS p FROM hh, LATERAL jsonb_array_elements(COALESCE(hh.players, '[]'::jsonb)) e
  ),
  players_out AS (
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'userId',       s.p->>'userId',
          'username',     COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name), pr.username, s.p->>'username', 'Player'),
          'playerNumber', pr.player_number::text,
          -- The CLUB avatar. profiles.avatar_url is the social media photo and
          -- is not Club Arena's to display.
          'avatarUrl',    NULLIF(pr.arena_avatar_url, ''),
          'seat',         NULLIF(s.p->>'seat', '')::int,
          'stack',        NULLIF(s.p->>'stack', '')::numeric,
          'cards',        COALESCE((SELECT hh.hole_cards -> (s.p->>'userId') FROM hh), 'null'::jsonb)
        ) ORDER BY NULLIF(s.p->>'seat', '')::int), '[]'::jsonb) AS v
    FROM seats s LEFT JOIN public.profiles pr ON pr.id::text = s.p->>'userId'
  ),
  board_out AS (
    SELECT CASE
      WHEN (SELECT community_cards FROM hh) IS NULL THEN '[]'::jsonb
      ELSE COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'rank', regexp_replace(c, '(hearts|diamonds|clubs|spades)$', ''),
                 'suit', substring(c from '(hearts|diamonds|clubs|spades)$')) ORDER BY ord)
        FROM unnest((SELECT community_cards FROM hh)) WITH ORDINALITY AS t(c, ord)
        WHERE substring(c from '(hearts|diamonds|clubs|spades)$') IS NOT NULL
      ), '[]'::jsonb)
    END AS v
  ),
  extra_boards AS (
    SELECT COALESCE(jsonb_agg(b ORDER BY ord), '[]'::jsonb) AS v
    FROM (
      SELECT e.value AS b, e.ordinality AS ord
      FROM hh, LATERAL jsonb_array_elements(COALESCE(hh.rit_boards, '[]'::jsonb))
                       WITH ORDINALITY e(value, ordinality)
      UNION ALL
      SELECT to_jsonb(hh.community_cards2), 1000
      FROM hh WHERE hh.community_cards2 IS NOT NULL
                AND array_length(hh.community_cards2, 1) > 0
    ) t
  ),
  recips AS (
    SELECT COALESCE(jsonb_agg(
             jsonb_build_object(
               'userId', r.user_id,
               'name',   COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name), pr.username, 'Player'),
               -- The summary card has no seat roster to look a number up in,
               -- so it travels with the recipient.
               'playerNumber', pr.player_number::text,
               'amount', r.amount,
               'role',   CASE
                           WHEN r.user_id = (SELECT winner_user_id FROM pay) THEN 'bad_beat'
                           WHEN r.user_id = (SELECT loser_user_id  FROM pay) THEN 'hand_winner'
                           ELSE 'table'
                         END) ORDER BY r.amount DESC), '[]'::jsonb) AS v
    FROM public.bbj_payout_recipients r
    LEFT JOIN public.profiles pr ON pr.id = r.user_id
    WHERE r.payout_id = p_payout_id
  ),
  jackpot AS (
    SELECT jsonb_build_object(
             'payoutId',         p_payout_id,
             -- 2026-09-11: which jackpot this was. A mini hand opened looking
             -- exactly like a main one; the row always knew.
             'kind',             COALESCE((SELECT kind FROM pay), 'main'),
             'total',            (SELECT total_amount FROM pay),
             'badBeatUserId',    (SELECT winner_user_id FROM pay),
             'handWinnerUserId', (SELECT loser_user_id FROM pay),
             'recipients',       (SELECT v FROM recips)) AS v
  )
  SELECT CASE
    -- No such payout. A genuine nothing, and still a NULL.
    WHEN (SELECT count(*) FROM pay) = 0 THEN NULL

    -- THE HAND IS GONE. Everything the payout ledger knows, and an honest flag
    -- saying the street-by-street part is not coming.
    WHEN (SELECT count(*) FROM hh) = 0 THEN jsonb_build_object(
      'handAvailable', false,
      'kind',          COALESCE((SELECT kind FROM pay), 'main'),
      'handNumber',    (SELECT hand_number FROM pay),
      'playedAt',      (SELECT created_at FROM pay),
      'gameVariant',   NULL,
      'tablePlayerCount', (SELECT table_player_count FROM pay),
      -- bbj_winners names the two hands. Note the deliberate inversion the
      -- rest of this feature lives with: in bbj_winners, "winner" is the
      -- winner OF THE JACKPOT (the bad-beat holder, who LOST the hand).
      'badBeatName',   (SELECT COALESCE(NULLIF(winner_display_name,''), 'Player') FROM win),
      'badBeatHand',   (SELECT NULLIF(winner_hand, 'Unknown') FROM win),
      'handWinnerName',(SELECT COALESCE(NULLIF(loser_display_name,''), 'Player') FROM win),
      'handWinnerHand',(SELECT NULLIF(loser_hand, 'Unknown') FROM win),
      'poolAtHit',     (SELECT pool_amount_at_hit FROM win),
      'jackpot',       (SELECT v FROM jackpot)
    )

    ELSE jsonb_build_object(
      'handAvailable', true,
      'kind',        COALESCE((SELECT kind FROM pay), 'main'),
      'handNumber',  (SELECT hand_number FROM hh),
      'playedAt',    COALESCE((SELECT started_at FROM hh), (SELECT created_at FROM hh)),
      'gameVariant', (SELECT game_variant FROM hh),
      'smallBlind',  (SELECT small_blind FROM hh),
      'bigBlind',    (SELECT big_blind FROM hh),
      'potSize',     (SELECT pot_size FROM hh),
      'rakeAmount',  (SELECT rake_amount FROM hh),
      'bbjAmount',   (SELECT bbj_amount FROM hh),
      'buttonSeat',  (SELECT button_seat FROM hh),
      'board',       (SELECT v FROM board_out),
      'extraBoards', (SELECT v FROM extra_boards),
      'players',     (SELECT v FROM players_out),
      'actions',     COALESCE((SELECT jsonb_agg(a ORDER BY ord)
                        FROM jsonb_array_elements((SELECT COALESCE(actions, '[]'::jsonb) FROM hh))
                             WITH ORDINALITY AS t(a, ord)
                        WHERE COALESCE(a->>'userId', '') <> 'system'), '[]'::jsonb),
      'winners',     (SELECT COALESCE(winners, '[]'::jsonb) FROM hh),
      'showdown',    (SELECT COALESCE(showdown, '[]'::jsonb) FROM hh),
      'pots',        (SELECT COALESCE(pots, '[]'::jsonb) FROM hh),
      'jackpot',     (SELECT v FROM jackpot)
    )
  END;
$function$;

REVOKE ALL ON FUNCTION public.fn_bbj_hand_detail(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_hand_detail(uuid) TO authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The operator panel sees the mini's own numbers
-- ───────────────────────────────────────────────────────────────────────────
-- The return type grows, so the function is dropped and re-created rather than
-- replaced. Every existing column keeps its position and its meaning.
DROP FUNCTION IF EXISTS public.fn_bbj_analytics(uuid);

CREATE FUNCTION public.fn_bbj_analytics(p_pool_id uuid)
RETURNS TABLE(
  main_balance numeric, backup_balance numeric, promo_balance numeric,
  contributions_24h numeric, contributions_7d numeric, contributions_30d numeric,
  hands_24h bigint, hands_7d bigint, total_contributed_all_time numeric,
  hit_count bigint, total_paid_all_time numeric, biggest_hit numeric,
  last_hit_at timestamptz, avg_days_between_hits numeric, days_since_last_hit numeric,
  net_pool_position numeric,
  -- 2026-09-11: the mini's own numbers. The columns above count every hit of
  -- either kind, exactly as before; these say how much of that was the mini.
  mini_enabled boolean,
  mini_hit_count bigint,
  mini_paid_all_time numeric,
  mini_hits_30d bigint,
  mini_paid_30d numeric,
  mini_last_hit_at timestamptz,
  mini_reserve_floor numeric,
  mini_parked numeric,
  mini_available numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_club_id uuid;
  v_union_id uuid;
  v_allowed boolean := false;
BEGIN
  SELECT bp.club_id, bp.union_id INTO v_club_id, v_union_id
  FROM public.bbj_pools bp WHERE bp.id = p_pool_id;

  IF v_club_id IS NULL AND v_union_id IS NULL THEN
    RAISE EXCEPTION 'BBJ pool not found';
  END IF;

  -- Admin of the owning club, or of ANY club in the owning union.
  IF v_club_id IS NOT NULL THEN
    v_allowed := public.fn_is_club_admin_uid(v_club_id);
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.clubs c
      WHERE c.union_id = v_union_id
        AND public.fn_is_club_admin_uid(c.id)
    ) INTO v_allowed;
  END IF;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Not authorized: club admin role required for this jackpot pool';
  END IF;

  RETURN QUERY
  WITH pool AS (
    SELECT bp.main_balance, bp.backup_balance, bp.promo_balance,
           COALESCE(bp.mini_reserve_floor, 0) AS reserve_floor
    FROM public.bbj_pools bp WHERE bp.id = p_pool_id
  ),
  contrib AS (
    SELECT
      COALESCE(SUM(amount) FILTER (WHERE created_at > now() - interval '24 hours'), 0) AS c24,
      COALESCE(SUM(amount) FILTER (WHERE created_at > now() - interval '7 days'), 0) AS c7,
      COALESCE(SUM(amount) FILTER (WHERE created_at > now() - interval '30 days'), 0) AS c30,
      COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours') AS h24,
      COUNT(*) FILTER (WHERE created_at > now() - interval '7 days') AS h7,
      COALESCE(SUM(amount), 0) AS call_time
    FROM public.bbj_contributions WHERE pool_id = p_pool_id
  ),
  hits AS (
    SELECT
      COUNT(*) AS n,
      COALESCE(SUM(total_payout), 0) AS paid,
      COALESCE(MAX(total_payout), 0) AS biggest,
      MAX(awarded_at) AS last_at,
      MIN(awarded_at) AS first_at
    FROM public.bbj_winners WHERE pool_id = p_pool_id
  ),
  mini AS (
    SELECT
      COUNT(*) AS n,
      COALESCE(SUM(total_payout), 0) AS paid,
      COUNT(*) FILTER (WHERE awarded_at > now() - interval '30 days') AS n30,
      COALESCE(SUM(total_payout) FILTER (WHERE awarded_at > now() - interval '30 days'), 0) AS paid30,
      MAX(awarded_at) AS last_at
    FROM public.bbj_winners WHERE pool_id = p_pool_id AND kind = 'mini'
  ),
  parked AS (
    SELECT public.fn_bbj_parked_reserve(p_pool_id, 'backup') AS amt
  )
  SELECT
    p.main_balance,
    p.backup_balance,
    p.promo_balance,
    c.c24,
    c.c7,
    c.c30,
    c.h24,
    c.h7,
    c.call_time,
    h.n,
    h.paid,
    h.biggest,
    h.last_at,
    -- Average interval between hits (needs 2+ hits to mean anything).
    CASE WHEN h.n > 1
      THEN ROUND(EXTRACT(EPOCH FROM (h.last_at - h.first_at)) / 86400.0 / (h.n - 1), 2)
      ELSE NULL END,
    CASE WHEN h.last_at IS NOT NULL
      THEN ROUND(EXTRACT(EPOCH FROM (now() - h.last_at)) / 86400.0, 2)
      ELSE NULL END,
    -- Net position: everything ever collected minus everything ever paid.
    ROUND(c.call_time - h.paid, 2),
    EXISTS (SELECT 1 FROM public.bbj_mini_tiers t WHERE t.enabled),
    m.n,
    m.paid,
    m.n30,
    m.paid30,
    m.last_at,
    p.reserve_floor,
    pk.amt,
    GREATEST(0, COALESCE(p.backup_balance, 0) - pk.amt - p.reserve_floor)
  FROM pool p, contrib c, hits h, mini m, parked pk;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_bbj_analytics(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_analytics(uuid) TO authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Assertions: the three functions exist with the shape the client reads
-- ───────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'fn_bbj_mini_for_club') THEN
    RAISE EXCEPTION 'fn_bbj_mini_for_club missing';
  END IF;
  IF pg_get_function_result('public.fn_bbj_mini_for_club(uuid)'::regprocedure)
     NOT LIKE '%tiers jsonb%' THEN
    RAISE EXCEPTION 'fn_bbj_mini_for_club does not return tiers';
  END IF;
  IF pg_get_function_result('public.fn_bbj_analytics(uuid)'::regprocedure)
     NOT LIKE '%mini_available numeric%' THEN
    RAISE EXCEPTION 'fn_bbj_analytics does not return the mini columns';
  END IF;
  IF position('''kind''' IN pg_get_functiondef('public.fn_bbj_hand_detail(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'fn_bbj_hand_detail does not say which jackpot a hand was';
  END IF;
END $$;

COMMIT;
