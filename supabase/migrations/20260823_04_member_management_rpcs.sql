-- ============================================================================
-- 20260823_04_member_management_rpcs
--
-- The Players tab (migration 03) answers "who is in this club". Tapping a row
-- has to answer "who is this person", and that screen is modelled on the
-- PokerBros Member Management panel: identity and role at the top, the agent
-- they sit under, their wallets, how many people are beneath them, then a band
-- of range-filtered numbers -- hands, fees, winnings, MTT equivalents, what
-- rakeback they have claimed and what they have sent out -- with an Overall /
-- date-range switch above it. A second tab holds the poker statistics proper,
-- per game variant, with a dropdown of the variants that player has actually
-- played.
--
-- Three RPCs, because that is three screens: the detail header, the statistics
-- tab, and the downline list. Everything each one needs comes back in a single
-- round trip. The alternative -- and this is what the roster page did before
-- migration 03 -- is a fan of six or seven client queries per member tap, each
-- one a chance to half-load and render a blank panel.
--
-- -- WHY EVERY NUMBER IS COALESCED TO ZERO --------------------------------
-- These functions are read by a UI that formats with .toLocaleString(). A null
-- reaching that call is a crash, and a JSON string reaching it renders as the
-- literal text. So every numeric key in the returned object is present, is a
-- JSON number, and is 0 rather than null when there is nothing to report. A
-- member who has never played a hand gets zeros, not an empty object -- and a
-- user_id that is not a member of this club at all gets nulls in identity and
-- zeros in the numbers rather than an exception, because the screen is reached
-- by deep link and a stale link must not 500.
--
-- -- SCHEMA SURPRISE: wallet_transactions.amount HAS NO SIGN ---------------
-- The obvious way to total "chips sent out" is to sum the negative amounts.
-- That returns nothing here. In production 1.4M of the 1.42M wallet_transactions
-- rows carry a POSITIVE amount and encode direction in `type` instead: buyin
-- and tournament_buyin are category='buyin'/type='debit' with amount > 0, and
-- across the entire table exactly five rows have amount < 0. Summing negatives
-- would have produced a permanent 0 in the "Sent Out" cell and nobody would
-- have known it was a bug rather than an empty column. So the outflow test is
-- sign-agnostic: a row counts as money leaving if EITHER the amount is negative
-- OR the type is a debit-shaped word, and abs() is applied either way.
--
-- The same trap sits on the other side. category='rake' with type='credit' is
-- the 1.33M-row firehose of rake COLLECTED from a player, not rakeback PAID to
-- one. Matching on 'rake' would have reported every player's lifetime rake as
-- their claimed rakeback. The pattern therefore matches rakeback / rake_back /
-- rake back / commission, none of which the bare 'rake' category satisfies --
-- there are 1,571 genuine category='rakeback' rows and 2 'commission' rows, and
-- those are the ones that belong in the cell.
--
-- -- WHY THE UPLINE COMES FROM agent_id ------------------------------------
-- club_members has both agent_id and parent_agent_id. parent_agent_id is NULL
-- on every production row; agent_id holds the USER id of the upline and is what
-- the grant RPCs write. The tree is walked over agent_id only, capped at depth
-- 20, which is well past the deepest real chain and stops a cycle introduced by
-- a bad grant from spinning the query forever.
--
-- -- DATES ARE UTC DAYS ------------------------------------------------------
-- member_fee_rollup.day is a UTC date. p_from/p_to are inclusive UTC days, and
-- the wallet_transactions timestamp window is built to match them exactly:
-- >= p_from 00:00 UTC and < (p_to + 1 day) 00:00 UTC. Both NULL means Overall,
-- which applies no date filter at all rather than guessing a wide range.
-- ============================================================================

-- Return types differ from anything that may exist under these names, and
-- CREATE OR REPLACE cannot change a return type, so drop first.
DROP FUNCTION IF EXISTS public.ca_club_member_detail(uuid, uuid, date, date);
DROP FUNCTION IF EXISTS public.ca_club_member_statistics(uuid, uuid, text, date, date);
DROP FUNCTION IF EXISTS public.ca_club_member_downline(uuid, uuid);

-- ---------------------------------------------------------------------------
-- (A) The member detail header
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.ca_club_member_detail(
  p_club_id uuid,
  p_user_id uuid,
  p_from    date DEFAULT NULL,
  p_to      date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_scope   uuid[];
  v_overall boolean := (p_from IS NULL AND p_to IS NULL);
  v_ts_from timestamptz := CASE WHEN p_from IS NULL THEN NULL
                                ELSE (p_from::timestamp AT TIME ZONE 'UTC') END;
  v_ts_to   timestamptz := CASE WHEN p_to IS NULL THEN NULL
                                ELSE ((p_to + 1)::timestamp AT TIME ZONE 'UTC') END;
  v_out     jsonb;
BEGIN
  v_scope := public.fn_club_scope_ids(p_club_id);
  IF v_scope IS NULL OR array_length(v_scope, 1) IS NULL THEN
    v_scope := ARRAY[p_club_id];
  END IF;

  WITH RECURSIVE
  -- The membership row. A person can hold a seat in the union and in one of its
  -- clubs; that is one member, shown at the higher role, same rule as the roster.
  mem AS (
    SELECT DISTINCT ON (cm.user_id)
           cm.user_id, cm.club_id, cm.role, cm.agent_id, cm.chip_balance,
           cm.nickname, cm.notes, cm.display_name, cm.joined_at,
           CASE cm.role
             WHEN 'owner' THEN 100 WHEN 'co_owner' THEN 90 WHEN 'admin' THEN 80
             WHEN 'super_agent' THEN 60 WHEN 'agent' THEN 40 WHEN 'sub_agent' THEN 20
             ELSE 0 END AS role_rank
    FROM public.club_members cm
    WHERE cm.user_id = p_user_id
      AND cm.club_id = ANY(v_scope)
    ORDER BY cm.user_id,
             CASE cm.role
               WHEN 'owner' THEN 100 WHEN 'co_owner' THEN 90 WHEN 'admin' THEN 80
               WHEN 'super_agent' THEN 60 WHEN 'agent' THEN 40 WHEN 'sub_agent' THEN 20
               ELSE 0 END DESC,
             cm.joined_at ASC
  ),
  edges AS (
    SELECT DISTINCT cm.user_id AS child, cm.agent_id AS parent
    FROM public.club_members cm
    WHERE cm.club_id = ANY(v_scope)
      AND cm.agent_id IS NOT NULL
      AND cm.agent_id <> cm.user_id
  ),
  tree AS (
    SELECT e.child, 1 AS depth FROM edges e WHERE e.parent = p_user_id
    UNION ALL
    SELECT e.child, t.depth + 1
    FROM tree t JOIN edges e ON e.parent = t.child
    WHERE t.depth < 20
  ),
  down AS (
    SELECT count(DISTINCT child) FILTER (WHERE depth = 1)::int AS direct,
           count(DISTINCT child)::int                          AS total
    FROM tree
  ),
  -- A horse at a live table is online. table_seats.club_id is the player's HOME
  -- club and the table may belong to the union above it, so either side counts.
  seat AS (
    SELECT 1 AS seated
    FROM public.table_seats ts
    JOIN public.tables t ON t.id = ts.table_id
    WHERE ts.user_id = p_user_id
      AND ts.left_at IS NULL
      AND t.status IN ('waiting', 'running')
      AND (ts.club_id = ANY(v_scope) OR t.club_id = ANY(v_scope))
    LIMIT 1
  ),
  wal AS (
    SELECT sum(w.balance) FILTER (WHERE w.wallet_type = 'PLAYER')   AS w_player,
           sum(w.balance) FILTER (WHERE w.wallet_type = 'BUSINESS') AS w_agent,
           sum(w.balance) FILTER (WHERE w.wallet_type = 'PROMO')    AS w_promo
    FROM public.wallets w
    WHERE w.user_id = p_user_id
  ),
  roll AS (
    SELECT
      coalesce(sum(r.hands) FILTER (WHERE NOT r.is_mtt), 0)::bigint AS hands,
      coalesce(sum(r.hands) FILTER (WHERE r.is_mtt), 0)::bigint     AS mtt_hands,
      coalesce(sum(r.fees)  FILTER (WHERE NOT r.is_mtt), 0)         AS fees,
      coalesce(sum(r.fees)  FILTER (WHERE r.is_mtt), 0)             AS mtt_fees,
      coalesce(sum(r.won - r.contributed) FILTER (WHERE NOT r.is_mtt), 0) AS net,
      coalesce(sum(r.won - r.contributed) FILTER (WHERE r.is_mtt), 0)     AS mtt_net
    FROM public.member_fee_rollup r
    WHERE r.user_id = p_user_id
      AND (v_overall OR (p_from IS NULL OR r.day >= p_from))
      AND (v_overall OR (p_to   IS NULL OR r.day <= p_to))
  ),
  -- See the header: direction lives in `type`, not in the sign of `amount`, and
  -- the bare 'rake' category is rake taken, not rakeback given.
  txn AS (
    SELECT
      coalesce(sum(wt.amount) FILTER (
        WHERE wt.amount > 0
          AND lower(coalesce(wt.type, '')) NOT IN ('debit', 'withdrawal')
          AND lower(coalesce(wt.category, '') || ' ' || coalesce(wt.type, ''))
              ~ '(rakeback|rake_back|rake back|commission)'
      ), 0) AS claimed_back,
      coalesce(sum(abs(wt.amount)) FILTER (
        WHERE (wt.amount < 0 OR lower(coalesce(wt.type, ''))
                                IN ('debit', 'withdrawal', 'send', 'transfer_out'))
          AND lower(coalesce(wt.category, '') || ' ' || coalesce(wt.type, ''))
              ~ '(transfer|send|distribute)'
      ), 0) AS sent_out
    FROM public.wallet_transactions wt
    WHERE wt.user_id = p_user_id
      AND (v_ts_from IS NULL OR wt.created_at >= v_ts_from)
      AND (v_ts_to   IS NULL OR wt.created_at <  v_ts_to)
  )
  SELECT jsonb_build_object(
    'identity', jsonb_build_object(
      'user_id',              p_user_id,
      'player_number',        pr.player_number,
      -- profiles.alias is the Club Arena name and wins; username is last because
      -- a trigger forces it lowercase and it reads as an id, not a name.
      'alias',                coalesce(nullif(btrim(pr.alias), ''),
                                       nullif(btrim(m.display_name), ''),
                                       nullif(btrim(pr.display_name), ''),
                                       pr.username),
      'username',             pr.username,
      'display_name',         coalesce(nullif(btrim(pr.display_name), ''), pr.username),
      'avatar_url',           coalesce(nullif(pr.arena_avatar_url, ''), pr.avatar_url),
      'role',                 m.role,
      'role_rank',            coalesce(m.role_rank, 0),
      'nickname',             m.nickname,
      'remark',               m.notes,
      'last_login',           pr.last_login,
      'joined_at',            m.joined_at,
      'home_club_id',         m.club_id,
      'home_club_name',       cl.name,
      'upline_user_id',       m.agent_id,
      'upline_name',          up.up_name,
      'upline_player_number', up.up_number
    ),
    'presence', jsonb_build_object(
      'is_online', (s.seated IS NOT NULL)
                   OR (coalesce(pr.is_online, false)
                       AND pr.last_seen > now() - interval '5 minutes'),
      'is_seated', (s.seated IS NOT NULL)
    ),
    'wallets', jsonb_build_object(
      'chip_balance',  coalesce(m.chip_balance, 0),
      'player_wallet', coalesce(w.w_player, 0),
      'agent_wallet',  coalesce(w.w_agent, 0),
      'promo_wallet',  coalesce(w.w_promo, 0)
    ),
    'downline', jsonb_build_object(
      'downline_direct', coalesce(d.direct, 0),
      'downline_total',  coalesce(d.total, 0)
    ),
    'stats', jsonb_build_object(
      'hands',          coalesce(rl.hands, 0),
      'mtt_hands',      coalesce(rl.mtt_hands, 0),
      'total_fee',      round(coalesce(rl.fees, 0), 2),
      'mtt_fee',        round(coalesce(rl.mtt_fees, 0), 2),
      'total_winnings', round(coalesce(rl.net, 0), 2),
      'mtt_winnings',   round(coalesce(rl.mtt_net, 0), 2),
      'claimed_back',   round(coalesce(tx.claimed_back, 0), 2),
      'sent_out',       round(coalesce(tx.sent_out, 0), 2)
    ),
    'range', jsonb_build_object(
      'from',       p_from,
      'to',         p_to,
      'is_overall', v_overall
    )
  )
  INTO v_out
  -- Anchored on a synthetic single row so a non-member, or a user_id that does
  -- not exist at all, still yields exactly one object instead of no rows.
  FROM (SELECT 1) anchor
  LEFT JOIN mem m         ON true
  LEFT JOIN public.profiles pr ON pr.id = p_user_id
  LEFT JOIN public.clubs cl    ON cl.id = m.club_id
  LEFT JOIN seat s        ON true
  LEFT JOIN wal  w        ON true
  LEFT JOIN down d        ON true
  LEFT JOIN roll rl       ON true
  LEFT JOIN txn  tx       ON true
  LEFT JOIN LATERAL (
    SELECT coalesce(nullif(btrim(u.alias), ''),
                    nullif(btrim(u.display_name), ''),
                    u.username) AS up_name,
           u.player_number       AS up_number
    FROM public.profiles u WHERE u.id = m.agent_id
  ) up ON true;

  RETURN v_out;
END;
$fn$;

COMMENT ON FUNCTION public.ca_club_member_detail(uuid, uuid, date, date) IS
  'Member Management detail header for one member of a club or union: identity, role, upline, presence, wallets, downline counts and range-filtered hands/fees/winnings/rakeback/transfers, as one jsonb object. NULL p_from/p_to means Overall. Never errors on a missing member; returns nulls in identity and zeros in every number.';

REVOKE ALL ON FUNCTION public.ca_club_member_detail(uuid, uuid, date, date) FROM public;
GRANT EXECUTE ON FUNCTION public.ca_club_member_detail(uuid, uuid, date, date) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- (B) The statistics tab
-- ---------------------------------------------------------------------------
-- The variant dropdown is deliberately built from the player's ENTIRE history,
-- not from the selected range. If it were range-filtered, narrowing the dates
-- would silently delete options from the dropdown underneath the user's finger
-- and the variant they had selected would vanish.
CREATE FUNCTION public.ca_club_member_statistics(
  p_club_id uuid,
  p_user_id uuid,
  p_variant text DEFAULT NULL,
  p_from    date DEFAULT NULL,
  p_to      date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_overall boolean := (p_from IS NULL AND p_to IS NULL);
  v_variant text    := nullif(lower(btrim(coalesce(p_variant, ''))), '');
  v_all     boolean;
  v_out     jsonb;
BEGIN
  -- p_club_id is accepted for signature symmetry with the other two RPCs and
  -- for future per-club scoping; member_fee_rollup is keyed by user only.
  PERFORM p_club_id;
  v_all := (v_variant IS NULL OR v_variant = 'all');

  WITH
  agg AS (
    SELECT
      coalesce(sum(r.hands), 0)::bigint            AS hands,
      coalesce(sum(r.wins), 0)::bigint             AS wins,
      coalesce(sum(r.vpip_hands), 0)::bigint       AS vpip_hands,
      coalesce(sum(r.pfr_hands), 0)::bigint        AS pfr_hands,
      coalesce(sum(r.three_bet_hands), 0)::bigint  AS tb_hands,
      coalesce(sum(r.three_bet_opps), 0)::bigint   AS tb_opps,
      coalesce(sum(r.cbet_hands), 0)::bigint       AS cb_hands,
      coalesce(sum(r.cbet_opps), 0)::bigint        AS cb_opps,
      coalesce(sum(r.won - r.contributed), 0)      AS net,
      coalesce(sum(r.fees), 0)                     AS fees,
      -- A session proxy: the rollup has no session concept, so a day on which
      -- the player was dealt in counts as one "game".
      count(DISTINCT r.day) FILTER (WHERE r.hands > 0)::int AS total_games
    FROM public.member_fee_rollup r
    WHERE r.user_id = p_user_id
      AND (v_all OR r.game_variant = v_variant)
      AND (p_from IS NULL OR r.day >= p_from)
      AND (p_to   IS NULL OR r.day <= p_to)
  ),
  vars AS (
    SELECT coalesce(
             jsonb_agg(DISTINCT r.game_variant ORDER BY r.game_variant),
             '[]'::jsonb
           ) AS list
    FROM public.member_fee_rollup r
    WHERE r.user_id = p_user_id
      AND r.game_variant IS NOT NULL
  )
  SELECT jsonb_build_object(
    'variant',     coalesce(v_variant, 'all'),
    'variants',    vars.list,
    'total_games', coalesce(a.total_games, 0),
    'total_hands', coalesce(a.hands, 0),
    'wins',        coalesce(a.wins, 0),
    -- Every percentage guards its denominator with NULLIF and falls back to 0.
    -- A player with zero preflop opportunities has a 0% 3-bet, not a null and
    -- certainly not a division error.
    'vpip',        coalesce(round(100.0 * a.vpip_hands / nullif(a.hands, 0), 2), 0),
    'pfr',         coalesce(round(100.0 * a.pfr_hands  / nullif(a.hands, 0), 2), 0),
    'three_bet',   coalesce(round(100.0 * a.tb_hands   / nullif(a.tb_opps, 0), 2), 0),
    'cbet',        coalesce(round(100.0 * a.cb_hands   / nullif(a.cb_opps, 0), 2), 0),
    -- PokerBros labels the won-hand count "Winner"; it is the same figure as
    -- wins, carried under both names so the UI can use either label verbatim.
    'winner',      coalesce(a.wins, 0),
    'net',         round(coalesce(a.net, 0), 2),
    'fees',        round(coalesce(a.fees, 0), 2),
    'from',        p_from,
    'to',          p_to,
    'is_overall',  v_overall
  )
  INTO v_out
  FROM agg a CROSS JOIN vars;

  RETURN v_out;
END;
$fn$;

COMMENT ON FUNCTION public.ca_club_member_statistics(uuid, uuid, text, date, date) IS
  'Poker statistics tab for one member: hands, sessions, wins, VPIP/PFR/3-bet/C-bet percentages, net and fees, filtered by game variant and date range, plus the list of variants that player has ever played for the dropdown. NULL or ''all'' variant combines every variant; NULL dates mean Overall.';

REVOKE ALL ON FUNCTION public.ca_club_member_statistics(uuid, uuid, text, date, date) FROM public;
GRANT EXECUTE ON FUNCTION public.ca_club_member_statistics(uuid, uuid, text, date, date) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- (C) The downline list
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.ca_club_member_downline(
  p_club_id uuid,
  p_user_id uuid
)
RETURNS TABLE (
  user_id       uuid,
  player_number text,
  alias         text,
  username      text,
  role          text,
  role_rank     int,
  depth         int,
  chip_balance  numeric,
  total_fees    numeric,
  is_online     boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_scope uuid[];
BEGIN
  v_scope := public.fn_club_scope_ids(p_club_id);
  IF v_scope IS NULL OR array_length(v_scope, 1) IS NULL THEN
    v_scope := ARRAY[p_club_id];
  END IF;

  RETURN QUERY
  WITH RECURSIVE
  edges AS (
    SELECT DISTINCT cm.user_id AS child, cm.agent_id AS parent
    FROM public.club_members cm
    WHERE cm.club_id = ANY(v_scope)
      AND cm.agent_id IS NOT NULL
      AND cm.agent_id <> cm.user_id
  ),
  tree AS (
    SELECT e.child, 1 AS depth FROM edges e WHERE e.parent = p_user_id
    UNION ALL
    SELECT e.child, t.depth + 1
    FROM tree t JOIN edges e ON e.parent = t.child
    WHERE t.depth < 20
  ),
  -- The same person can be reached by more than one path if a grant ever wrote
  -- a second edge; keep the shortest, so each descendant is listed once.
  flat AS (
    SELECT t.child AS uid, min(t.depth)::int AS depth
    FROM tree t
    GROUP BY t.child
  ),
  mem AS (
    SELECT DISTINCT ON (cm.user_id)
           cm.user_id AS uid, cm.role, cm.chip_balance,
           CASE cm.role
             WHEN 'owner' THEN 100 WHEN 'co_owner' THEN 90 WHEN 'admin' THEN 80
             WHEN 'super_agent' THEN 60 WHEN 'agent' THEN 40 WHEN 'sub_agent' THEN 20
             ELSE 0 END AS role_rank
    FROM public.club_members cm
    WHERE cm.club_id = ANY(v_scope)
      AND cm.user_id IN (SELECT f.uid FROM flat f)
    ORDER BY cm.user_id,
             CASE cm.role
               WHEN 'owner' THEN 100 WHEN 'co_owner' THEN 90 WHEN 'admin' THEN 80
               WHEN 'super_agent' THEN 60 WHEN 'agent' THEN 40 WHEN 'sub_agent' THEN 20
               ELSE 0 END DESC,
             cm.joined_at ASC
  ),
  seated AS (
    SELECT DISTINCT ts.user_id AS uid
    FROM public.table_seats ts
    JOIN public.tables t ON t.id = ts.table_id
    WHERE ts.left_at IS NULL
      AND ts.user_id IN (SELECT f.uid FROM flat f)
      AND t.status IN ('waiting', 'running')
      AND (ts.club_id = ANY(v_scope) OR t.club_id = ANY(v_scope))
  ),
  fees AS (
    SELECT r.user_id AS uid, sum(r.fees) AS f
    FROM public.member_fee_rollup r
    WHERE r.user_id IN (SELECT f.uid FROM flat f)
    GROUP BY r.user_id
  )
  SELECT
    f.uid,
    pr.player_number::text,
    coalesce(nullif(btrim(pr.alias), ''),
             nullif(btrim(pr.display_name), ''),
             pr.username,
             'Unknown')::text,
    coalesce(pr.username, '')::text,
    coalesce(m.role, 'player')::text,
    coalesce(m.role_rank, 0),
    f.depth,
    coalesce(m.chip_balance, 0)::numeric,
    round(coalesce(fe.f, 0), 2)::numeric,
    (s.uid IS NOT NULL)
      OR (coalesce(pr.is_online, false) AND pr.last_seen > now() - interval '5 minutes')
  FROM flat f
  LEFT JOIN mem m               ON m.uid  = f.uid
  LEFT JOIN public.profiles pr  ON pr.id  = f.uid
  LEFT JOIN seated s            ON s.uid  = f.uid
  LEFT JOIN fees fe             ON fe.uid = f.uid
  ORDER BY f.depth ASC,
           coalesce(m.role_rank, 0) DESC,
           lower(coalesce(nullif(btrim(pr.alias), ''), pr.display_name, pr.username, ''));
END;
$fn$;

COMMENT ON FUNCTION public.ca_club_member_downline(uuid, uuid) IS
  'Every member beneath one agent in the club_members.agent_id tree, within the club or union scope, depth-capped at 20 and shortest-path deduplicated. Ordered by depth, then role, then Club Arena name.';

REVOKE ALL ON FUNCTION public.ca_club_member_downline(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.ca_club_member_downline(uuid, uuid) TO authenticated, service_role;
