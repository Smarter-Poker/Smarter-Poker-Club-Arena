-- Selected production column contracts; local fixture only.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE TABLE public.ca_hand_player_idx (user_id uuid,
created_at timestamp with time zone,
hand_id uuid);
CREATE TABLE public.ca_hand_player_stat (user_id uuid,
hand_id uuid,
created_at timestamp with time zone,
is_cash boolean,
tournament_id uuid,
game_variant text,
big_blind numeric,
small_blind numeric,
n_players integer,
seat_position text,
my_blind numeric,
won_amt numeric,
is_winner boolean,
invested_actions numeric,
aggro_cnt integer,
call_cnt integer,
vpip boolean,
pfr boolean,
folded boolean,
three_bet boolean,
three_bet_opp boolean,
faced_three_bet boolean,
folded_to_three_bet boolean,
cbet_opp boolean,
cbet_made boolean,
showdown boolean,
hand_secs numeric,
profit numeric);
CREATE TABLE public.engine_table_leases (table_id uuid,
instance_id text,
engine_version text,
acquired_at timestamp with time zone DEFAULT now(),
heartbeat_at timestamp with time zone DEFAULT now(),
lease_generation uuid DEFAULT gen_random_uuid(),
protocol_version integer DEFAULT 1);
CREATE TABLE public.engine_tournament_leases (tournament_id uuid,
instance_id text,
engine_version text,
acquired_at timestamp with time zone DEFAULT now(),
heartbeat_at timestamp with time zone DEFAULT now(),
lease_generation uuid DEFAULT gen_random_uuid(),
protocol_version integer DEFAULT 1);
CREATE TABLE public.hand_atomic_commits (table_id uuid,
hand_number bigint,
hand_id uuid,
payload_hash text,
stack_result jsonb,
committed_at timestamp with time zone DEFAULT clock_timestamp(),
post_commit_payload jsonb,
post_commit_request_hash text,
post_commit_payload_hash text,
post_commit_completed_at timestamp with time zone,
post_commit_result jsonb);
CREATE TABLE public.hand_history (id uuid DEFAULT gen_random_uuid(),
winner_name text,
pot_size numeric(12,2),
created_at timestamp with time zone DEFAULT now(),
table_id uuid,
tournament_id uuid,
hand_number integer,
game_variant text DEFAULT 'nlh'::text,
small_blind numeric(12,2) DEFAULT 0,
big_blind numeric(12,2) DEFAULT 0,
rake_amount numeric(12,2) DEFAULT 0,
community_cards text[],
winners jsonb,
players jsonb DEFAULT '[]'::jsonb,
actions jsonb DEFAULT '[]'::jsonb,
summary text,
bbj_amount numeric(12,2) DEFAULT 0,
source text DEFAULT 'manual'::text,
hand_name text,
seed text,
version text DEFAULT 'v1'::text,
started_at timestamp with time zone DEFAULT now(),
ended_at timestamp with time zone,
hole_cards jsonb,
board jsonb,
reported boolean DEFAULT false,
reported_at timestamp with time zone,
button_seat smallint,
has_human boolean,
community_cards2 text[],
pots jsonb,
showdown jsonb,
rit_boards jsonb,
community_cards3 text[],
bomb_pot jsonb,
daily_mission_events jsonb,
winners_by_board jsonb);
CREATE TABLE public.hand_projection_outbox (hand_id uuid,
table_id uuid,
hand_number bigint,
created_at timestamp with time zone DEFAULT clock_timestamp());
CREATE TABLE public.table_pending_addons (id uuid DEFAULT gen_random_uuid(),
table_id uuid,
user_id uuid,
amount numeric,
created_at timestamp with time zone DEFAULT now(),
resolved_at timestamp with time zone,
applied_to_stack numeric,
refunded numeric,
kind text DEFAULT 'addon'::text);
ALTER TABLE hand_history ADD PRIMARY KEY(id), ADD UNIQUE(table_id,hand_number);
ALTER TABLE hand_atomic_commits ADD PRIMARY KEY(table_id,hand_number),ADD UNIQUE(hand_id);
ALTER TABLE hand_projection_outbox ADD PRIMARY KEY(hand_id);
ALTER TABLE ca_hand_player_idx ADD PRIMARY KEY(user_id,hand_id);
ALTER TABLE ca_hand_player_stat ADD PRIMARY KEY(user_id,hand_id);
ALTER TABLE engine_table_leases ADD PRIMARY KEY(table_id);
ALTER TABLE table_seats ADD COLUMN status text,ADD COLUMN time_bank_uses_remaining integer DEFAULT 3,ADD COLUMN time_bank_remaining integer DEFAULT 30;
CREATE OR REPLACE FUNCTION public.ca_hand_player_facts_one(p_hand_id uuid, p_user uuid DEFAULT NULL::uuid)
 RETURNS TABLE(user_id uuid, hand_id uuid, created_at timestamp with time zone, is_cash boolean, tournament_id uuid, game_variant text, big_blind numeric, small_blind numeric, n_players integer, seat_position text, my_blind numeric, won_amt numeric, is_winner boolean, invested_actions numeric, aggro_cnt integer, call_cnt integer, vpip boolean, pfr boolean, folded boolean, three_bet boolean, three_bet_opp boolean, faced_three_bet boolean, folded_to_three_bet boolean, cbet_opp boolean, cbet_made boolean, showdown boolean, hand_secs numeric, profit numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH my_hands AS MATERIALIZED (
  SELECT h.id, h.tournament_id,
         lower(coalesce(h.game_variant, 'nlh')) AS game_variant,
         coalesce(h.big_blind, 0)::numeric   AS big_blind,
         coalesce(h.small_blind, 0)::numeric AS small_blind,
         coalesce(h.pot_size, 0)::numeric    AS pot_size,
         h.button_seat, h.created_at, h.started_at, h.ended_at,
         h.players,
         coalesce(h.actions, '[]'::jsonb) AS actions,
         coalesce(h.winners, '[]'::jsonb) AS winners
  FROM hand_history h
  WHERE h.id = p_hand_id
),
acts AS MATERIALIZED (
  SELECT mh.id AS hand_id, x.ord,
         x.act->>'userId' AS auid, x.act->>'stage' AS stage,
         lower(x.act->>'action') AS action,
         coalesce((x.act->>'amount')::numeric, 0) AS amount,
         coalesce((x.act->>'dead')::boolean, false) AS dead_flag
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
  WHERE stage = 'preflop' AND action IN ('raise','all_in','allin')
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
  FROM acts WHERE stage = 'flop' AND action IN ('bet','all_in','allin')
  ORDER BY hand_id, ord
),
-- ── MONEY. actions[].amount is NOT one unit (src/utils/handReplay.ts:16-35):
--    bet / raise / all_in  -> raise-TO level for the street (CUMULATIVE)
--    call, blind posts     -> chips actually added           (INCREMENTAL)
--    return                -> uncalled chips handed back     (SUBTRACT)
--    ante (or dead=true)   -> in the pot, NOT in the live bet level
-- Computed for EVERY seat in the hand, not just p_user: the uncalled-bet
-- inference below needs the whole table's bet levels.
money_acts AS (
  SELECT a.hand_id, a.auid, a.stage, a.ord, a.amount,
         CASE
           WHEN a.action IN ('bet','raise','all_in','allin') THEN 'to'
           WHEN a.action = 'return' THEN 'ret'
           WHEN a.action IN ('call','sb','bb','post','post_sb','post_bb','blind',
                             'small_blind','big_blind','straddle','ante') THEN 'inc'
           ELSE 'none'
         END AS kind,
         (a.dead_flag OR a.action = 'ante') AS dead,
         a.action IN ('sb','bb','post','post_sb','post_bb','blind','small_blind','big_blind') AS is_blind_post
  FROM acts a
  WHERE a.auid IS NOT NULL
),
hand_log_shape AS (
  SELECT hand_id,
         bool_or(is_blind_post) AS has_posts,
         bool_or(kind = 'ret')  AS has_returns
  FROM money_acts GROUP BY hand_id
),
-- Position-implied blind for every seat (the rows written before
-- FORCED_BETS_POSTED carry no post rows, so the blinds have to be synthesised
-- exactly as src/utils/handReplay.ts does when !logHasBlinds).
seat_blind AS (
  SELECT p.hand_id, p.puid AS auid, p.seat,
         CASE
           WHEN ofs.pos_offset IS NULL THEN 0
           WHEN array_length(sm.seats, 1) = 2 THEN
             CASE WHEN ofs.pos_offset = 0 THEN mh.small_blind ELSE mh.big_blind END
           WHEN ofs.pos_offset = 1 THEN mh.small_blind
           WHEN ofs.pos_offset = 2 THEN mh.big_blind
           ELSE 0
         END AS implied_blind
  FROM players_all p
  JOIN my_hands mh ON mh.id = p.hand_id
  JOIN seatmap sm ON sm.hand_id = p.hand_id
  CROSS JOIN LATERAL (SELECT CASE
      WHEN mh.button_seat IS NULL OR sm.seats IS NULL
        OR p.seat IS NULL OR array_length(sm.seats, 1) < 2
        OR array_position(sm.seats, mh.button_seat::int) IS NULL THEN NULL
      ELSE (array_position(sm.seats, p.seat)
            - array_position(sm.seats, mh.button_seat::int)
            + array_length(sm.seats, 1)) % array_length(sm.seats, 1)
    END AS pos_offset) ofs
  WHERE p.puid IS NOT NULL
),
money_w AS (
  SELECT m.*,
         max(ord) FILTER (WHERE kind = 'to')
           OVER (PARTITION BY hand_id, auid, stage ORDER BY ord
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS last_to_ord,
         coalesce(sum(amount) FILTER (WHERE kind = 'inc' AND NOT dead)
           OVER (PARTITION BY hand_id, auid, stage ORDER BY ord
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 0) AS inc_cum,
         row_number() OVER (PARTITION BY hand_id, auid, stage ORDER BY ord DESC) AS rn_desc
  FROM money_acts m
),
street_committed_raw AS (
  SELECT w.hand_id, w.auid, w.stage,
         CASE WHEN w.last_to_ord IS NULL THEN w.inc_cum
              ELSE t.amount + (w.inc_cum - t.inc_cum) END AS committed,
         (w.last_to_ord IS NOT NULL) AS to_level
  FROM money_w w
  LEFT JOIN money_w t ON t.hand_id = w.hand_id AND t.auid = w.auid
                     AND t.stage = w.stage AND t.ord = w.last_to_ord
  WHERE w.rn_desc = 1
),
-- Seed the blinds into preflop when the log has no post rows. A player whose
-- preflop bet level is a raise-TO already has the blind inside it.
street_committed AS (
  SELECT r.hand_id, r.auid, r.stage,
         r.committed
           + CASE WHEN r.stage = 'preflop' AND NOT r.to_level AND NOT coalesce(hs.has_posts, false)
                  THEN coalesce(sb.implied_blind, 0) ELSE 0 END AS committed
  FROM street_committed_raw r
  LEFT JOIN hand_log_shape hs ON hs.hand_id = r.hand_id
  LEFT JOIN seat_blind sb ON sb.hand_id = r.hand_id AND sb.auid = r.auid
  UNION ALL
  -- Blind seats that never acted (walk, or a fold with no logged row).
  SELECT sb.hand_id, sb.auid, 'preflop', sb.implied_blind
  FROM seat_blind sb
  LEFT JOIN hand_log_shape hs ON hs.hand_id = sb.hand_id
  LEFT JOIN street_committed_raw r
         ON r.hand_id = sb.hand_id AND r.auid = sb.auid AND r.stage = 'preflop'
  WHERE sb.implied_blind > 0
    AND NOT coalesce(hs.has_posts, false)
    AND r.hand_id IS NULL
),
-- An uncalled bet on a log that does not record returns: the street's top
-- contributor's excess over the next highest was matched by nobody.
street_rank AS (
  SELECT sc.hand_id, sc.stage, sc.auid, sc.committed,
         row_number() OVER (PARTITION BY sc.hand_id, sc.stage ORDER BY sc.committed DESC) AS rn,
         lead(sc.committed) OVER (PARTITION BY sc.hand_id, sc.stage ORDER BY sc.committed DESC) AS next_committed
  FROM street_committed sc
),
inferred_ret AS (
  SELECT r.hand_id, r.auid,
         sum(r.committed - coalesce(r.next_committed, 0)) AS inferred
  FROM street_rank r
  JOIN hand_log_shape hs ON hs.hand_id = r.hand_id
  WHERE r.rn = 1 AND NOT hs.has_returns
    AND r.committed - coalesce(r.next_committed, 0) > 0.005
  GROUP BY r.hand_id, r.auid
),
money_extras AS (
  SELECT hand_id, auid,
         coalesce(sum(amount) FILTER (WHERE kind = 'inc' AND dead), 0) AS dead_money,
         coalesce(sum(amount) FILTER (WHERE kind = 'ret'), 0) AS returned,
         coalesce(sum(amount) FILTER (WHERE is_blind_post AND NOT dead), 0) AS posted_blind
  FROM money_acts GROUP BY hand_id, auid
),
money_per_player AS (
  SELECT sc.hand_id, sc.auid,
         sum(sc.committed) AS live_committed
  FROM street_committed sc GROUP BY sc.hand_id, sc.auid
),
-- THE STORED POT ARBITRATES THE INFERENCE (handReplay.ts, same rule): if the
-- rebuild WITH inferred returns misses pot_size and the rebuild WITHOUT them
-- lands on it, the inference was wrong for this hand and is withdrawn.
--
-- Per-hand totals are GROUPed once and joined, never re-scanned per hand:
-- the correlated form this replaced walked the whole CTE for every hand,
-- which is quadratic in the window and is why the range form took 10 s for
-- four minutes of hands (2026-09-04). Same numbers, hash joins.
pot_live AS (
  SELECT hand_id, sum(live_committed) AS s FROM money_per_player GROUP BY hand_id
),
pot_extras AS (
  SELECT hand_id, sum(dead_money - returned) AS s FROM money_extras GROUP BY hand_id
),
pot_inferred AS (
  SELECT hand_id, sum(inferred) AS s FROM inferred_ret GROUP BY hand_id
),
hand_pot_check AS (
  SELECT mh.id AS hand_id,
         mh.pot_size,
         coalesce(pl.s, 0) + coalesce(px.s, 0) AS pot_without,
         coalesce(pi.s, 0) AS inferred_total
  FROM my_hands mh
  LEFT JOIN pot_live     pl ON pl.hand_id = mh.id
  LEFT JOIN pot_extras   px ON px.hand_id = mh.id
  LEFT JOIN pot_inferred pi ON pi.hand_id = mh.id
),
inference_ok AS (
  SELECT hand_id,
         NOT (inferred_total > 0
              AND abs((pot_without - inferred_total) - pot_size) >= 0.02
              AND abs(pot_without - pot_size) < 0.02) AS use_inference
  FROM hand_pot_check
),
per_player_base AS (
  SELECT s.hand_id, s.uid, s.my_seat,
    coalesce(bool_or(a.stage = 'preflop' AND a.action IN ('call','bet','raise','all_in','allin')), false) AS vpip,
    coalesce(bool_or(a.stage = 'preflop' AND a.action IN ('raise','all_in','allin')), false) AS pfr,
    count(*) FILTER (WHERE a.action IN ('bet','raise','all_in','allin'))::int AS aggro_cnt,
    count(*) FILTER (WHERE a.action = 'call')::int AS call_cnt,
    coalesce(bool_or(a.action = 'fold'), false) AS folded,
    coalesce(bool_or(a.stage = 'flop'), false) AS acted_on_flop,
    min(a.ord) FILTER (WHERE a.stage = 'preflop' AND a.action IN ('raise','all_in','allin')) AS my_first_pf_raise,
    max(a.ord) FILTER (WHERE a.stage = 'preflop' AND a.action IN ('raise','all_in','allin')) AS my_last_pf_raise,
    max(a.ord) FILTER (WHERE a.stage = 'preflop' AND a.action NOT IN ('sb','bb','post','post_sb','post_bb','blind','small_blind','big_blind','ante','straddle','return')) AS my_last_pf_any,
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
  pos.seat_position,
  -- my_blind: what the log says was posted when it says anything, else the
  -- blind the position implies (rows written before FORCED_BETS_POSTED).
  inv.my_blind,
  w.won_amt, w.is_winner,
  -- invested_actions EXCLUDES the blind above, so `invested_actions + my_blind`
  -- keeps meaning "everything this seat put in", as every reader assumes.
  inv.total_invested - inv.my_blind,
  d.aggro_cnt, d.call_cnt, d.vpip, d.pfr, d.folded,
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
  (w.won_amt - inv.total_invested)
FROM with_first_other d
JOIN my_hands mh ON mh.id = d.hand_id
JOIN seatmap  sm ON sm.hand_id = d.hand_id
JOIN no_fold  nf ON nf.hand_id = d.hand_id
LEFT JOIN reraise    r  ON r.hand_id  = d.hand_id AND r.uid = d.uid
LEFT JOIN flop_first ff ON ff.hand_id = d.hand_id
LEFT JOIN money_per_player mp ON mp.hand_id = d.hand_id AND mp.auid = d.uid::text
LEFT JOIN money_extras     mx ON mx.hand_id = d.hand_id AND mx.auid = d.uid::text
LEFT JOIN inferred_ret     ir ON ir.hand_id = d.hand_id AND ir.auid = d.uid::text
LEFT JOIN hand_log_shape   hs ON hs.hand_id = d.hand_id
LEFT JOIN inference_ok     io ON io.hand_id = d.hand_id
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
) pos
CROSS JOIN LATERAL (
  -- Everything this seat put in: live bet levels per street (blinds seeded
  -- when the log has no post rows), plus dead money, minus what came back -
  -- recorded, or inferred when the log predates recorded returns.
  SELECT coalesce(mp.live_committed, 0)
       + coalesce(mx.dead_money, 0)
       - coalesce(mx.returned, 0)
       - CASE WHEN coalesce(io.use_inference, true) THEN coalesce(ir.inferred, 0) ELSE 0 END AS total_invested,
         CASE WHEN coalesce(hs.has_posts, false) THEN coalesce(mx.posted_blind, 0) ELSE pos.my_blind END AS my_blind
) inv;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_engine_lease_stale_seconds()
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT 30;
$function$
;