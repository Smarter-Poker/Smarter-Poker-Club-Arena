-- ═══════════════════════════════════════════════════════════════════════════════
--  THE STATS PAGE WAS NOT SLOW. IT WAS BEING CANCELLED.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- MEASURED, 2026-08-25, production (kuklfnapbkmacvwxktbh), heaviest account
-- (88,503 indexed hands):
--
--   ca_player_stats_full  fully warm ........      34 ms  (3,730 buffers, 0 read)
--                         partly warm ......   1,315 ms  (2,047 hit / 1,710 read)
--                         cold .............  15,071 ms
--   authenticated statement_timeout .........   8,000 ms
--
-- On a cold buffer cache the page did not render slowly. It did not render:
-- Postgres cancelled the query and the player saw a failure. The warm number is
-- the proof that this was never CPU and never the analysis SQL, which was
-- already capped at 750 hands and already carefully written. It was page count.
-- All 3,730 of those buffers are random reads, and at ~4 ms per cold random read
-- on network storage, 3,730 of them IS the 15 seconds.
--
-- WHY 750 HANDS COST 3,730 PAGES
--   hand_history is 8,700 MB of heap over 1,416,541 rows - about 6.4 KB a row,
--   because players/actions/winners are JSONB stored INLINE (the TOAST relation
--   is only 100 MB, so almost nothing spilled out of line). At that width a page
--   holds roughly one hand, so 750 hands scattered through a heavy player's
--   history are ~750 separate page reads, plus 757 more for the index scan on
--   ca_hand_player_idx, plus the rest.
--
-- WHAT THIS DOES
--   The expensive part of a hand is the part the page throws away: 6.4 KB of
--   JSONB reduced to about thirty scalars per player. This precomputes those
--   scalars into ca_hand_player_stat and has the RPC read THEM - ~20 pages
--   instead of 3,730.
--
--   Sizing is why this is worth building rather than merely tempting. There are
--   585 players with hands, and the RPC never looks past a player's most recent
--   750. Retaining 1,000 each is ~585,000 rows, not the 14,180,471 that one row
--   per player per hand would be, and it is pruned to that continuously.
--
-- ONE COPY OF THE MATH
--   The obvious way to build a rollup is to write the per-hand analysis a second
--   time for the builder. That is how a rollup silently starts disagreeing with
--   the page it feeds. ca_hand_player_facts owns the math; the builder calls it,
--   and so does the RPC for the tail the builder has not reached yet. There is
--   exactly one definition of what VPIP means in this database.
--
--   It is a generalisation of the RPC's own per-hand block, not a copy: that
--   block computes facts for ONE player, with p_user baked into every filter,
--   and the rollup needs every player in the hand. Parity was verified against
--   the original math on live data before anything was written - 1,138
--   (hand, player) rows across 400 hands, zero differences on all fifteen
--   derived facts including showdown and n_players.
--
-- TWO THINGS THAT LOOKED RIGHT AND WERE NOT, both caught by measurement:
--
--   1. A FAITHFUL generalisation is quadratic here. Keeping the original's four
--      correlated subqueries per player is fine over ONE hand's ~30 actions, and
--      catastrophic over a 2,000-hand chunk's ~9,200: >55 ms/hand, 21 hours for
--      the table. Every one of them is an ordinary aggregate or hash join below,
--      which measured 1.6 ms/hand - a 34x cut. See the notes at each site.
--
--   2. Selecting hands by id list is 60x more expensive than by time range:
--        h.id = ANY(array of 2,000) ....  2,000 hands in 51.1s = 25.0 ms/hand
--        h.created_at >= x AND < y ..... 44,008 hands in 17.8s =  0.4 ms/hand
--      hand_history is physically ordered by insertion, which is created_at, so
--      a range is a near-sequential read while an id list is thousands of
--      independent random fetches of 6.4 KB rows. Hence the range signature.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE FACTS FUNCTION - the single definition of a hand's per-player numbers
-- ─────────────────────────────────────────────────────────────────────────────
-- Half-open range [p_from, p_to). Serves both callers: the builder rolls a
-- window, and ca_player_stats_full covers (rolled_ceil, now()] filtered to one
-- player. `seat_position`, not `position`: the latter is a col_name_keyword,
-- legal as a table column but NOT as a name in a RETURNS TABLE list.

CREATE OR REPLACE FUNCTION public.ca_hand_player_facts(
  p_from timestamptz,
  p_to   timestamptz,
  p_user uuid DEFAULT NULL
)
RETURNS TABLE (
  user_id uuid, hand_id uuid, created_at timestamptz, is_cash boolean,
  tournament_id uuid, game_variant text, big_blind numeric, small_blind numeric,
  n_players int, seat_position text, my_blind numeric, won_amt numeric,
  is_winner boolean, invested_actions numeric, aggro_cnt int, call_cnt int,
  vpip boolean, pfr boolean, folded boolean, three_bet boolean,
  three_bet_opp boolean, faced_three_bet boolean, folded_to_three_bet boolean,
  cbet_opp boolean, cbet_made boolean, showdown boolean, hand_secs numeric,
  profit numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
WITH my_hands AS MATERIALIZED (
  SELECT h.id, h.tournament_id,
         lower(coalesce(h.game_variant, 'nlh')) AS game_variant,
         coalesce(h.big_blind, 0)::numeric   AS big_blind,
         coalesce(h.small_blind, 0)::numeric AS small_blind,
         h.button_seat, h.created_at, h.started_at, h.ended_at,
         h.players,
         coalesce(h.actions, '[]'::jsonb) AS actions,
         coalesce(h.winners, '[]'::jsonb) AS winners
  FROM hand_history h
  WHERE h.created_at >= p_from AND h.created_at < p_to
),
acts AS MATERIALIZED (
  SELECT mh.id AS hand_id, x.ord,
         x.act->>'userId' AS auid, x.act->>'stage' AS stage,
         x.act->>'action' AS action,
         coalesce((x.act->>'amount')::numeric, 0) AS amount
  FROM my_hands mh
  CROSS JOIN LATERAL jsonb_array_elements(mh.actions) WITH ORDINALITY x(act, ord)
),
-- EVERY entry of the players array, including ones whose userId is absent or is
-- not a uuid. no_fold_players is defined over this, exactly as the original was:
-- it counts bodies at the table, not registered accounts.
players_all AS (
  SELECT mh.id AS hand_id, pl->>'userId' AS puid, (pl->>'seat')::int AS seat
  FROM my_hands mh
  CROSS JOIN LATERAL jsonb_array_elements(mh.players) pl
),
seatmap AS (
  SELECT hand_id, array_agg(seat ORDER BY seat) AS seats
  FROM players_all GROUP BY hand_id
),
-- The rows the rollup is keyed by: real accounts only. Some historical rows seat
-- a horse under a non-uuid id, and a cast that throws would take down the whole
-- backfill, so they are filtered by shape rather than trusted.
--
-- p_user narrows ONLY this. Every hand-level CTE above and below still reads all
-- of the hand's players and actions, because those are properties of the hand
-- and the retained player's numbers depend on them - "the first preflop raise by
-- someone other than me" is still computed against everyone who raised. So the
-- rows returned for that player are identical to the unfiltered call; what
-- disappears is only the rows nobody asked for. Verified: 62 rows either way,
-- zero rows in either direction of an EXCEPT.
--
-- The builder passes NULL and wants everyone. ca_player_stats_full passes one
-- player for its tail, which was otherwise computing ~27,000 (player, hand) rows
-- over a 15-minute window so that ~30 survived its WHERE.
seated AS (
  SELECT hand_id, puid::uuid AS uid, seat AS my_seat
  FROM players_all
  WHERE puid ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    AND (p_user IS NULL OR puid = p_user::text)
),
folders AS (
  SELECT DISTINCT hand_id, auid FROM acts WHERE action = 'fold' AND auid IS NOT NULL
),
no_fold AS (
  -- `p.puid IS NOT NULL` reproduces the original's NOT IN semantics: a players
  -- entry with no userId gave `NULL NOT IN (...)` = NULL, so it was not counted.
  -- A plain LEFT JOIN would count it, quietly inflating showdown for everyone at
  -- that table.
  SELECT p.hand_id,
         count(*) FILTER (WHERE f.auid IS NULL AND p.puid IS NOT NULL) AS no_fold_players
  FROM players_all p
  LEFT JOIN folders f ON f.hand_id = p.hand_id AND f.auid = p.puid
  GROUP BY p.hand_id
),
pf_raise AS (
  SELECT hand_id, ord, auid FROM acts
  WHERE stage = 'preflop' AND action IN ('raise','all_in')
),
-- "The first preflop raise by someone other than me" only ever needs two numbers
-- per hand: the first raise, and the first raise by a DIFFERENT actor. One
-- windowed pass gets both, and each player picks between them by comparing the
-- first actor to itself. The original ran this as a correlated subquery per
-- player.
pf_ranked AS (
  SELECT hand_id, ord, auid,
         first_value(auid) OVER w AS first_actor,
         first_value(ord)  OVER w AS first_ord,
         last_value(auid)  OVER (PARTITION BY hand_id ORDER BY ord
                                 ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS last_actor
  FROM pf_raise
  WINDOW w AS (PARTITION BY hand_id ORDER BY ord)
),
hand_pf AS (
  SELECT hand_id,
         min(first_ord)   AS first_ord,
         min(first_actor) AS first_actor,
         min(last_actor)  AS last_pf_raiser,
         min(ord) FILTER (WHERE auid IS DISTINCT FROM first_actor) AS first_other_ord
  FROM pf_ranked GROUP BY hand_id
),
flop_first AS (
  SELECT DISTINCT ON (hand_id) hand_id, auid AS first_flop_bettor
  FROM acts WHERE stage = 'flop' AND action IN ('bet','all_in')
  ORDER BY hand_id, ord
),
-- The LEFT JOIN is what preserves a seated player who never acted: the original
-- produced a row for them too, with zeroed action facts, because its lateral
-- aggregates over an empty filter yield 0 / false rather than NULL.
per_player_base AS (
  SELECT s.hand_id, s.uid, s.my_seat,
    coalesce(sum(a.amount) FILTER (WHERE a.action IN ('bet','call','raise','all_in')), 0) AS invested_actions,
    coalesce(bool_or(a.stage = 'preflop' AND a.action IN ('call','bet','raise','all_in')), false) AS vpip,
    coalesce(bool_or(a.stage = 'preflop' AND a.action IN ('raise','all_in')), false) AS pfr,
    count(*) FILTER (WHERE a.action IN ('bet','raise','all_in'))::int AS aggro_cnt,
    count(*) FILTER (WHERE a.action = 'call')::int AS call_cnt,
    coalesce(bool_or(a.action = 'fold'), false) AS folded,
    coalesce(bool_or(a.stage = 'flop'), false) AS acted_on_flop,
    min(a.ord) FILTER (WHERE a.stage = 'preflop' AND a.action IN ('raise','all_in')) AS my_first_pf_raise,
    max(a.ord) FILTER (WHERE a.stage = 'preflop' AND a.action IN ('raise','all_in')) AS my_last_pf_raise,
    max(a.ord) FILTER (WHERE a.stage = 'preflop') AS my_last_pf_any,
    max(a.ord) FILTER (WHERE a.stage = 'preflop' AND a.action = 'fold') AS my_last_pf_fold
  FROM seated s
  LEFT JOIN acts a ON a.hand_id = s.hand_id AND a.auid = s.uid::text
  GROUP BY s.hand_id, s.uid, s.my_seat
),
with_first_other AS (
  SELECT b.*,
    CASE WHEN hp.first_actor IS DISTINCT FROM b.uid::text
         THEN hp.first_ord ELSE hp.first_other_ord END AS first_other_pf_raise,
    hp.last_pf_raiser
  FROM per_player_base b
  LEFT JOIN hand_pf hp ON hp.hand_id = b.hand_id
),
reraise AS (
  SELECT b.hand_id, b.uid, min(p.ord) AS reraise_after_me
  FROM with_first_other b
  JOIN pf_raise p ON p.hand_id = b.hand_id
  WHERE p.auid IS DISTINCT FROM b.uid::text AND p.ord > b.my_first_pf_raise
  GROUP BY b.hand_id, b.uid
)
SELECT
  d.uid, mh.id, mh.created_at,
  (mh.tournament_id IS NULL), mh.tournament_id, mh.game_variant,
  mh.big_blind, mh.small_blind, array_length(sm.seats, 1),
  pos.seat_position, pos.my_blind, w.won_amt, w.is_winner,
  d.invested_actions, d.aggro_cnt, d.call_cnt, d.vpip, d.pfr, d.folded,
  -- The two three-bet tests were EXISTS(... ord > first_other_pf_raise). They
  -- are the same question as "is my last such ordinal past it", and the NULL
  -- propagation is preserved on purpose: where the EXISTS returned false because
  -- first_other_pf_raise was NULL, `x > NULL` is NULL and the same coalesce
  -- turns it into the same false.
  coalesce(d.my_last_pf_raise > d.first_other_pf_raise, false),
  coalesce(d.my_last_pf_any   > d.first_other_pf_raise, false),
  (r.reraise_after_me IS NOT NULL),
  coalesce(d.my_last_pf_fold > r.reraise_after_me, false),
  coalesce(d.last_pf_raiser = d.uid::text AND d.acted_on_flop, false),
  coalesce(d.last_pf_raiser = d.uid::text AND ff.first_flop_bettor = d.uid::text, false),
  (NOT d.folded AND nf.no_fold_players >= 2),
  CASE
    WHEN mh.started_at IS NOT NULL AND mh.ended_at IS NOT NULL
    THEN GREATEST(0, LEAST(1800, EXTRACT(epoch FROM (mh.ended_at - mh.started_at))))::numeric
    ELSE 45
  END,
  (w.won_amt - d.invested_actions - pos.my_blind)
FROM with_first_other d
JOIN my_hands mh ON mh.id = d.hand_id
JOIN seatmap  sm ON sm.hand_id = d.hand_id
JOIN no_fold  nf ON nf.hand_id = d.hand_id
LEFT JOIN reraise    r  ON r.hand_id  = d.hand_id AND r.uid = d.uid
LEFT JOIN flop_first ff ON ff.hand_id = d.hand_id
CROSS JOIN LATERAL (
  SELECT
    coalesce(sum((w1->>'amount')::numeric) FILTER (WHERE w1->>'userId' = d.uid::text), 0) AS won_amt,
    count(*) FILTER (WHERE w1->>'userId' = d.uid::text) > 0 AS is_winner
  FROM jsonb_array_elements(mh.winners) w1
) w
CROSS JOIN LATERAL (
  SELECT
    CASE
      WHEN ofs.pos_offset IS NULL THEN 0
      WHEN array_length(sm.seats, 1) = 2 THEN
        CASE WHEN ofs.pos_offset = 0 THEN mh.small_blind ELSE mh.big_blind END
      WHEN ofs.pos_offset = 1 THEN mh.small_blind
      WHEN ofs.pos_offset = 2 THEN mh.big_blind
      ELSE 0
    END AS my_blind,
    CASE
      WHEN ofs.pos_offset IS NULL THEN 'UNK'
      WHEN array_length(sm.seats, 1) = 2 THEN CASE WHEN ofs.pos_offset = 0 THEN 'BTN' ELSE 'BB' END
      WHEN ofs.pos_offset = 0 THEN 'BTN'
      WHEN ofs.pos_offset = 1 THEN 'SB'
      WHEN ofs.pos_offset = 2 THEN 'BB'
      WHEN ofs.pos_offset = array_length(sm.seats, 1) - 1 THEN 'CO'
      WHEN ofs.pos_offset = 3 THEN 'UTG'
      WHEN ofs.pos_offset = 4 AND array_length(sm.seats, 1) >= 8 THEN 'UTG+1'
      ELSE 'MP'
    END AS seat_position
  FROM (SELECT CASE
      WHEN mh.button_seat IS NULL OR sm.seats IS NULL
        OR d.my_seat IS NULL OR array_length(sm.seats, 1) < 2
        OR array_position(sm.seats, mh.button_seat::int) IS NULL THEN NULL
      ELSE (array_position(sm.seats, d.my_seat)
            - array_position(sm.seats, mh.button_seat::int)
            + array_length(sm.seats, 1)) % array_length(sm.seats, 1)
    END AS pos_offset) ofs
) pos;
$function$;

COMMENT ON FUNCTION public.ca_hand_player_facts(timestamptz, timestamptz, uuid) IS
  'The single definition of a hand''s per-player statistics, over a half-open time range [p_from, p_to). p_user narrows the OUTPUT to one player without changing any hand-level input, so the rows it returns are identical to the unfiltered call. ca_hand_player_stat is built from it (p_user NULL) and ca_player_stats_full uses it for the not-yet-rolled tail (p_user set).';

-- REVOKING PUBLIC AND anon IS NOT ENOUGH IN THIS DATABASE, and the first version
-- of this migration got it wrong. It did exactly the REVOKE PUBLIC / REVOKE anon
-- / GRANT service_role dance used elsewhere in this repo and left the function
-- callable from any logged-in browser - a SECURITY DEFINER function that takes an
-- arbitrary time range and returns one row per (player, hand) for EVERY player.
--
-- The cause is that this database carries
--   ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role
-- so a newly created function is born with an EXPLICIT grant to `authenticated`.
-- REVOKE ... FROM PUBLIC does not touch an explicit grant, and revoking anon
-- removes only half of what the default handed out. It was caught by the Supabase
-- security advisor, not by this file's own assertion - which checked grantee = 0
-- and anon only, and so could not fail on the one grant that mattered.
--
-- Name `authenticated` explicitly, and assert it afterwards.
REVOKE ALL ON FUNCTION public.ca_hand_player_facts(timestamptz, timestamptz, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ca_hand_player_facts(timestamptz, timestamptz, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.ca_hand_player_facts(timestamptz, timestamptz, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ca_hand_player_facts(timestamptz, timestamptz, uuid) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. THE ROLLUP TABLES
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ca_hand_player_stat (
  user_id uuid NOT NULL, hand_id uuid NOT NULL, created_at timestamptz NOT NULL,
  is_cash boolean NOT NULL, tournament_id uuid, game_variant text NOT NULL,
  big_blind numeric NOT NULL, small_blind numeric NOT NULL, n_players int,
  seat_position text NOT NULL, my_blind numeric NOT NULL, won_amt numeric NOT NULL,
  is_winner boolean NOT NULL, invested_actions numeric NOT NULL,
  aggro_cnt int NOT NULL, call_cnt int NOT NULL, vpip boolean NOT NULL,
  pfr boolean NOT NULL, folded boolean NOT NULL, three_bet boolean NOT NULL,
  three_bet_opp boolean NOT NULL, faced_three_bet boolean NOT NULL,
  folded_to_three_bet boolean NOT NULL, cbet_opp boolean NOT NULL,
  cbet_made boolean NOT NULL, showdown boolean NOT NULL,
  hand_secs numeric NOT NULL, profit numeric NOT NULL,
  PRIMARY KEY (user_id, hand_id)
);

-- The read path is always "this player's most recent N hands", so the index is
-- the access pattern spelled out. fillfactor is left at the default on purpose:
-- rows are written once and never updated, so reserving free space per page
-- would only spread the read across more pages, which is the exact cost this
-- table exists to remove.
CREATE INDEX IF NOT EXISTS idx_ca_hand_player_stat_user_time
  ON public.ca_hand_player_stat (user_id, created_at DESC);

COMMENT ON TABLE public.ca_hand_player_stat IS
  'Precomputed per-(player,hand) statistics. Exists because reading 750 raw hand_history rows costs ~3,730 random page reads (~15s cold) against an 8s statement_timeout, so the Stats page was being CANCELLED on heavy accounts rather than merely being slow. Retention is the most recent 1,000 hands per player, which is ~585k rows, not 14.2m.';

-- Nobody reads these directly. They are an implementation detail of an RPC that
-- does its own authorisation, and they hold EVERY player's results - a direct
-- read would be a straightforward leak of other people's numbers. RLS is enabled
-- with no policy, which denies everything that is not a superuser or a SECURITY
-- DEFINER function owned by one.
ALTER TABLE public.ca_hand_player_stat ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_hand_player_stat FROM PUBLIC;
REVOKE ALL ON TABLE public.ca_hand_player_stat FROM anon;
REVOKE ALL ON TABLE public.ca_hand_player_stat FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ca_hand_player_stat TO service_role;

CREATE TABLE IF NOT EXISTS public.ca_hand_player_stat_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  rolled_ceil timestamptz, rolled_floor timestamptz,
  complete boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.ca_hand_player_stat_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.ca_hand_player_stat_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_hand_player_stat_state FROM PUBLIC;
REVOKE ALL ON TABLE public.ca_hand_player_stat_state FROM anon;
REVOKE ALL ON TABLE public.ca_hand_player_stat_state FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.ca_hand_player_stat_state TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. THE BUILDERS
-- ─────────────────────────────────────────────────────────────────────────────
-- statement_timeout is set on the functions themselves. These are bulk jobs and
-- need longer than a page request does; service_role carries no timeout of its
-- own but PostgREST still applies one per request, which cancelled a 20,000-hand
-- chunk from outside. A function-level GUC applies for exactly the duration of
-- the call, is visible in \df+ rather than hidden in a caller, and both are
-- already revoked from anon and authenticated so nothing reachable from a
-- browser can start one. 10 minutes rather than 0: an unbounded backfill that
-- wedges is worse than one that gives up, and these are resumable by design.

-- Walks BACKWARDS from rolled_floor, newest first, because newest is what
-- players look at - so a half-finished backfill is already useful.
CREATE OR REPLACE FUNCTION public.ca_roll_hand_stats(p_limit int DEFAULT 20000)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
SET statement_timeout = '10min'
AS $function$
DECLARE
  v_floor timestamptz;
  v_next  timestamptz;
  v_hands int;
BEGIN
  SELECT rolled_floor INTO v_floor FROM ca_hand_player_stat_state WHERE id;
  IF v_floor IS NULL THEN
    SELECT max(created_at) + interval '1 second' INTO v_floor FROM hand_history;
    IF v_floor IS NULL THEN RETURN 0; END IF;
  END IF;

  -- Where does the next window start? Reading p_limit created_at values off the
  -- index is cheap; it is fetching the 6.4 KB rows that is not, and the range
  -- passed to the facts function does that in physical order.
  SELECT min(created_at), count(*) INTO v_next, v_hands
  FROM (SELECT created_at FROM hand_history
         WHERE created_at < v_floor
         ORDER BY created_at DESC LIMIT p_limit) q;

  IF v_next IS NULL OR v_hands = 0 THEN
    UPDATE ca_hand_player_stat_state SET complete = true, updated_at = now() WHERE id;
    RETURN 0;
  END IF;

  -- Hands can share a created_at, so a window is half-open [v_next, v_floor) and
  -- the next one starts at v_next: the boundary hands are simply rolled twice,
  -- which ON CONFLICT absorbs. Without this guard a window in which every hand
  -- shares one timestamp would set v_next = v_floor and loop forever.
  IF v_next >= v_floor THEN
    v_next := v_floor - interval '1 microsecond';
  END IF;

  -- Columns are NAMED, not positional. `INSERT ... SELECT *` lines up today and
  -- keeps lining up right until someone adds a column to one of the two
  -- definitions, at which point it silently writes every value into the wrong
  -- field instead of failing.
  INSERT INTO ca_hand_player_stat (
    user_id, hand_id, created_at, is_cash, tournament_id, game_variant,
    big_blind, small_blind, n_players, seat_position, my_blind, won_amt, is_winner,
    invested_actions, aggro_cnt, call_cnt, vpip, pfr, folded, three_bet,
    three_bet_opp, faced_three_bet, folded_to_three_bet, cbet_opp, cbet_made,
    showdown, hand_secs, profit)
  SELECT
    f.user_id, f.hand_id, f.created_at, f.is_cash, f.tournament_id, f.game_variant,
    f.big_blind, f.small_blind, f.n_players, f.seat_position, f.my_blind, f.won_amt, f.is_winner,
    f.invested_actions, f.aggro_cnt, f.call_cnt, f.vpip, f.pfr, f.folded, f.three_bet,
    f.three_bet_opp, f.faced_three_bet, f.folded_to_three_bet, f.cbet_opp, f.cbet_made,
    f.showdown, f.hand_secs, f.profit
  FROM ca_hand_player_facts(v_next, v_floor) f
  ON CONFLICT (user_id, hand_id) DO NOTHING;

  UPDATE ca_hand_player_stat_state
     SET rolled_floor = v_next,
         rolled_ceil  = coalesce(rolled_ceil, (SELECT max(created_at) FROM hand_history)),
         updated_at   = now()
   WHERE id;

  -- HANDS CONSUMED, not rows inserted. Returning the INSERT's row count made a
  -- window whose rows were already present look identical to "nothing left", and
  -- a caller looping until 0 stopped believing the backfill had finished.
  RETURN v_hands;
END;
$function$;

COMMENT ON FUNCTION public.ca_roll_hand_stats(int) IS
  'Rolls one window of hand_history into ca_hand_player_stat, newest first, and returns the hand count consumed. Loop until it returns 0.';

REVOKE ALL ON FUNCTION public.ca_roll_hand_stats(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ca_roll_hand_stats(int) FROM anon;
REVOKE ALL ON FUNCTION public.ca_roll_hand_stats(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ca_roll_hand_stats(int) TO service_role;

-- The backfill walks backwards and stops. Hands played AFTER it started are
-- newer than rolled_ceil and belong to nobody until this runs. Called from
-- pages/api/cron/club-stats-maintenance.js in the World Hub every 15 minutes,
-- beside the ca_hand_player_idx refresh that lives there for the same reason:
-- CLAUDE.md 11.3/11.5 fail CI on net-new cron files, so sharing an
-- already-scheduled route is the sanctioned move rather than a shortcut.
--
-- The cadence is not cosmetic. ca_player_stats_full covers whatever this has not
-- reached by computing it live, so the tail length IS a term in the page's
-- response time: 15 minutes is about 1,500 hands, well inside budget, while a
-- day of this failing silently would be 142,000 and would put the page back
-- where it started.
CREATE OR REPLACE FUNCTION public.ca_roll_hand_stats_forward()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
SET statement_timeout = '4min'
AS $function$
DECLARE
  v_ceil  timestamptz;
  v_now   timestamptz := now();
  v_hands int;
BEGIN
  SELECT rolled_ceil INTO v_ceil FROM ca_hand_player_stat_state WHERE id;
  IF v_ceil IS NULL OR v_ceil >= v_now THEN RETURN 0; END IF;

  SELECT count(*) INTO v_hands FROM hand_history
   WHERE created_at >= v_ceil AND created_at < v_now;

  IF v_hands = 0 THEN
    UPDATE ca_hand_player_stat_state SET rolled_ceil = v_now, updated_at = now() WHERE id;
    RETURN 0;
  END IF;

  INSERT INTO ca_hand_player_stat (
    user_id, hand_id, created_at, is_cash, tournament_id, game_variant,
    big_blind, small_blind, n_players, seat_position, my_blind, won_amt, is_winner,
    invested_actions, aggro_cnt, call_cnt, vpip, pfr, folded, three_bet,
    three_bet_opp, faced_three_bet, folded_to_three_bet, cbet_opp, cbet_made,
    showdown, hand_secs, profit)
  SELECT
    f.user_id, f.hand_id, f.created_at, f.is_cash, f.tournament_id, f.game_variant,
    f.big_blind, f.small_blind, f.n_players, f.seat_position, f.my_blind, f.won_amt, f.is_winner,
    f.invested_actions, f.aggro_cnt, f.call_cnt, f.vpip, f.pfr, f.folded, f.three_bet,
    f.three_bet_opp, f.faced_three_bet, f.folded_to_three_bet, f.cbet_opp, f.cbet_made,
    f.showdown, f.hand_secs, f.profit
  FROM ca_hand_player_facts(v_ceil, v_now) f
  ON CONFLICT (user_id, hand_id) DO NOTHING;

  -- Advanced only in the transaction that committed the insert, so a failure
  -- leaves the window to be retried rather than skipped.
  UPDATE ca_hand_player_stat_state SET rolled_ceil = v_now, updated_at = now() WHERE id;
  RETURN v_hands;
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_roll_hand_stats_forward() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ca_roll_hand_stats_forward() FROM anon;
REVOKE ALL ON FUNCTION public.ca_roll_hand_stats_forward() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ca_roll_hand_stats_forward() TO service_role;

-- Retention. The RPC reads at most 750 rows per player; 1,000 is the headroom
-- that keeps a player's window intact between prunes. Without this the table
-- grows towards the 14.2m rows this design exists to avoid - the backfill alone
-- would have reached ~19m before finishing, so it is run DURING the backfill and
-- not only after it. Pruning mid-backfill is safe precisely because the walk is
-- newest-first: anything dropped is older than 1,000 hands the player already
-- has rolled.
CREATE OR REPLACE FUNCTION public.ca_prune_hand_player_stat(p_keep int DEFAULT 1000)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
SET statement_timeout = '10min'
AS $function$
DECLARE v_deleted int;
BEGIN
  WITH ranked AS (
    SELECT user_id, hand_id,
           row_number() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
    FROM ca_hand_player_stat
  )
  DELETE FROM ca_hand_player_stat s
  USING ranked r
  WHERE r.rn > p_keep AND s.user_id = r.user_id AND s.hand_id = r.hand_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_prune_hand_player_stat(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ca_prune_hand_player_stat(int) FROM anon;
REVOKE ALL ON FUNCTION public.ca_prune_hand_player_stat(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ca_prune_hand_player_stat(int) TO service_role;

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a ON true
      WHERE n.nspname = 'public'
        AND p.proname IN ('ca_hand_player_facts','ca_roll_hand_stats',
                          'ca_roll_hand_stats_forward','ca_prune_hand_player_stat')
        AND (a.grantee = 0
             OR a.grantee = 'anon'::regrole
             OR a.grantee = 'authenticated'::regrole)) > 0 THEN
    RAISE EXCEPTION 'An internal rollup function is reachable from a browser.';
  END IF;
  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a ON true
      WHERE n.nspname = 'public'
        AND c.relname IN ('ca_hand_player_stat','ca_hand_player_stat_state')
        AND (a.grantee = 0 OR a.grantee = 'anon'::regrole
             OR a.grantee = 'authenticated'::regrole)) > 0 THEN
    RAISE EXCEPTION 'The rollup tables are readable by a client role. They hold every player''s results.';
  END IF;
END $$;
