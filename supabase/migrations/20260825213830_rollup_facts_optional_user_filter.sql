-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825213830; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ca_hand_player_facts gains an optional p_user.
--
-- The builder wants every player in the window; the RPC's tail wants exactly
-- one, and was paying for the other twelve. A 15-minute tail is roughly 2,100
-- hands, which is ~27,000 (player, hand) rows computed so that ~30 survive the
-- WHERE f.user_id = p_user immediately above it.
--
-- Only `seated` is filtered. Every hand-level CTE - the seat map, no_fold_players,
-- the first/last preflop raiser, the first flop bettor - still reads ALL of the
-- hand's players and actions, because those are properties of the hand and the
-- retained player's numbers depend on them. "The first preflop raise by someone
-- other than me" is still computed against everyone who raised. So the rows
-- returned for that player are bit-for-bit what the unfiltered call returns;
-- what disappears is only the rows nobody asked for. Asserted below rather than
-- asserted in prose.
--
-- NULL keeps the old behaviour, so the builder is untouched.

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
players_all AS (
  SELECT mh.id AS hand_id, pl->>'userId' AS puid, (pl->>'seat')::int AS seat
  FROM my_hands mh
  CROSS JOIN LATERAL jsonb_array_elements(mh.players) pl
),
seatmap AS (
  SELECT hand_id, array_agg(seat ORDER BY seat) AS seats
  FROM players_all GROUP BY hand_id
),
-- The ONLY thing p_user narrows.
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

REVOKE ALL ON FUNCTION public.ca_hand_player_facts(timestamptz, timestamptz, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ca_hand_player_facts(timestamptz, timestamptz, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.ca_hand_player_facts(timestamptz, timestamptz, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ca_hand_player_facts(timestamptz, timestamptz, uuid) TO service_role;

-- The 2-arg form is gone: leaving it beside the 3-arg one is an ambiguous
-- overload waiting to be resolved the wrong way by a future caller.
DROP FUNCTION IF EXISTS public.ca_hand_player_facts(timestamptz, timestamptz);

DO $$
DECLARE v_leaky text;
BEGIN
  SELECT string_agg(DISTINCT p.proname, ', ') INTO v_leaky
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a ON true
  WHERE n.nspname = 'public'
    AND p.proname IN ('ca_hand_player_facts', 'ca_roll_hand_stats',
                      'ca_roll_hand_stats_forward', 'ca_prune_hand_player_stat')
    AND (a.grantee = 0 OR a.grantee = 'anon'::regrole
         OR a.grantee = 'authenticated'::regrole);
  IF v_leaky IS NOT NULL THEN
    RAISE EXCEPTION 'Internal rollup function(s) reachable from a browser: %', v_leaky;
  END IF;
END $$;
