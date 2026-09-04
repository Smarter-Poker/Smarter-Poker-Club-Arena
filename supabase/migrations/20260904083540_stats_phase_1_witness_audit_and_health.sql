-- 20260904083540_stats_phase_1_witness_audit_and_health.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- STATS PAGE PROGRAMME, PHASE 1: THE WITNESS AUDIT AND THE HEALTH READOUT
-- (docs/STATS-PAGE-PROGRAMME-2026-09-03.md, section 1 and section 8 phase 1)
--
-- WHAT THIS CHANGES, AND WHY:
--
-- 1. THE BUTTON IS RIGHT. THE RECORD SAID IT WAS NOT.
--    The 2026-09-03 changelog left "~3% of hands carry a button_seat that
--    disagrees with the action order" as an open defect. Measured properly on
--    2026-09-04 against 48,362 hands from the previous 90 minutes: 47,871 of
--    them carry blind-post rows (the seat that posted the small blind, the
--    seat that posted the big blind), and on EVERY ONE the stored button_seat
--    is the seat before the small-blind poster in seat order (the poster
--    itself heads-up). Zero disagreements. The "3%" was the measuring stick:
--    a first-to-act heuristic that did not know about straddles (533 of the
--    551 hands it flagged in an hour had a straddle) and about a small blind
--    who is all-in from the post and never gets a turn (the other 18). The
--    witness that was there - the post rows - agrees with the engine.
--
--    Likewise the derived `showdown` flag was checked against the engine's
--    own hand_history.showdown roster over 27,418 player-hands: 3,445
--    showdowns, zero disagreements either way.
--
--    So there is no position fix to ship. What ships instead is the thing
--    that would have caught a real one, and will catch the next:
--
-- 2. ca_stats_witness_audit(p_minutes, p_grace_seconds)
--    Re-runs both comparisons over a recent window and counts every
--    disagreement, plus the two coverage gaps that would silently hollow the
--    page out: hands that got no ca_hand_player_stat row (the live trigger or
--    the forward roll failed) and human player-hands that got no
--    ca_hand_facts row (the engine's settlement writer failed, so the money
--    falls back to reconstruction). One row per run in
--    ca_stats_witness_audit_log. pg_cron runs it every 15 minutes.
--
-- 3. ca_stats_health()
--    The cheap readout the engine polls every minute and publishes on
--    /health and /metrics: how far the player->hand index is behind, whether
--    the last three minutes of hands all have stat rows, where the money
--    repair is, and what the last witness audit found. The hand index fell
--    17 hours behind on 2026-09-03 and nothing said so; the engine now says
--    so at 30 minutes (server/src/observability/StatsHealthMonitor.ts).
--
-- Both functions are SECURITY DEFINER because they read every player's
-- hands. Both are executable by service_role only. Neither moves money.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 0. THE FACTS FUNCTION, SPLIT BY ACCESS PATH (measured 2026-09-04)
-- ────────────────────────────────────────────────────────────────────────────
--
-- ca_hand_player_facts(p_from, p_to, p_user, p_hand_id) grew a fourth argument
-- on 2026-09-03 so the live trigger could ask for ONE hand:
--
--     WHERE (p_hand_id IS NULL AND created_at range) OR (p_hand_id IS NOT NULL AND id = p_hand_id)
--
-- That OR is fine for one hand and ruinous for a range. With it, four minutes
-- of hands (4,400 player-hands) took 14-27 s; the identical body with a plain
-- range predicate took 1.1 s. The planner cannot see past a parameter inside
-- an OR, and every downstream join was planned for the wrong row count. The
-- forward roll and the money repair both use the range form, which is why
-- ca_roll_hand_stats_forward averaged 54 s per call.
--
-- Two further rewrites inside the body, both output-identical (proved with
-- EXCEPT in both directions over 2,622 range rows and 588 single-hand rows
-- before this was written): the stored-pot arbitration summed three CTEs with
-- a correlated subquery per hand (quadratic in the window) and now GROUPs
-- once and joins; the never-acted blind seat used NOT EXISTS against a CTE
-- and now anti-joins.
--
-- So: ONE body, written once below, instantiated twice by the DO block with a
-- different access predicate -
--
--     ca_hand_player_facts_range(p_from, p_to, p_user)   the window form
--     ca_hand_player_facts_one(p_hand_id, p_user)        the trigger form
--
-- and the four-argument ca_hand_player_facts stays as a plpgsql dispatcher so
-- every existing caller (the forward roll, the money repair, the audit below)
-- keeps working and simply gets fast. The trigger calls the _one form
-- directly: RETURN QUERY through the dispatcher measured ~9 ms per hand
-- against 1-5 ms direct, and the trigger runs inside every hand insert.

DO $do$
DECLARE
  v_sig  text := $sig$RETURNS TABLE(
  user_id uuid, hand_id uuid, created_at timestamptz, is_cash boolean,
  tournament_id uuid, game_variant text, big_blind numeric, small_blind numeric,
  n_players integer, seat_position text, my_blind numeric, won_amt numeric,
  is_winner boolean, invested_actions numeric, aggro_cnt integer, call_cnt integer,
  vpip boolean, pfr boolean, folded boolean, three_bet boolean, three_bet_opp boolean,
  faced_three_bet boolean, folded_to_three_bet boolean, cbet_opp boolean,
  cbet_made boolean, showdown boolean, hand_secs numeric, profit numeric
)$sig$;
  v_body text := $tmpl$
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
  WHERE __HAND_FILTER__
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
$tmpl$;
BEGIN
  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION public.ca_hand_player_facts_range(
      p_from timestamptz,
      p_to timestamptz,
      p_user uuid DEFAULT NULL
    )
    %s
    LANGUAGE sql
    STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$%s$fn$
  $f$, v_sig, replace(v_body, '__HAND_FILTER__', 'h.created_at >= p_from AND h.created_at < p_to'));

  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION public.ca_hand_player_facts_one(
      p_hand_id uuid,
      p_user uuid DEFAULT NULL
    )
    %s
    LANGUAGE sql
    STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$%s$fn$
  $f$, v_sig, replace(v_body, '__HAND_FILTER__', 'h.id = p_hand_id'));
END $do$;

CREATE OR REPLACE FUNCTION public.ca_hand_player_facts(
  p_from timestamptz,
  p_to timestamptz,
  p_user uuid DEFAULT NULL,
  p_hand_id uuid DEFAULT NULL
)
RETURNS TABLE(
  user_id uuid, hand_id uuid, created_at timestamptz, is_cash boolean,
  tournament_id uuid, game_variant text, big_blind numeric, small_blind numeric,
  n_players integer, seat_position text, my_blind numeric, won_amt numeric,
  is_winner boolean, invested_actions numeric, aggro_cnt integer, call_cnt integer,
  vpip boolean, pfr boolean, folded boolean, three_bet boolean, three_bet_opp boolean,
  faced_three_bet boolean, folded_to_three_bet boolean, cbet_opp boolean,
  cbet_made boolean, showdown boolean, hand_secs numeric, profit numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Dispatcher only. The body lives in _range and _one (see the DO block
  -- above); pick by access path so the planner never sees a parameter in
  -- an OR.
  IF p_hand_id IS NOT NULL THEN
    RETURN QUERY SELECT * FROM public.ca_hand_player_facts_one(p_hand_id, p_user);
  ELSE
    RETURN QUERY SELECT * FROM public.ca_hand_player_facts_range(p_from, p_to, p_user);
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.ca_hand_player_facts_range(timestamptz, timestamptz, uuid) IS
  'Per player per hand stat facts for every hand in [p_from, p_to). The window form of ca_hand_player_facts; same body as _one with a range predicate. Service role only.';
COMMENT ON FUNCTION public.ca_hand_player_facts_one(uuid, uuid) IS
  'Per player per hand stat facts for one hand. The trigger form of ca_hand_player_facts; same body as _range with an id predicate. Service role only.';

REVOKE ALL ON FUNCTION public.ca_hand_player_facts_range(timestamptz, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_hand_player_facts_range(timestamptz, timestamptz, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.ca_hand_player_facts_one(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_hand_player_facts_one(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.ca_hand_player_facts(timestamptz, timestamptz, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_hand_player_facts(timestamptz, timestamptz, uuid, uuid) TO service_role;

-- The live trigger, re-pointed at the single-hand form. Body otherwise as
-- 20260903190000.
CREATE OR REPLACE FUNCTION public.trg_ca_stats_live_from_hand()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- (a) the player -> hand index: one row per seat, three columns.
  INSERT INTO public.ca_hand_player_idx (user_id, created_at, hand_id)
  SELECT DISTINCT (pl->>'userId')::uuid, NEW.created_at, NEW.id
  FROM jsonb_array_elements(coalesce(NEW.players, '[]'::jsonb)) pl
  WHERE pl->>'userId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ON CONFLICT DO NOTHING;

  -- (b) the ~28 scalars the stats page reads, for this one hand.
  INSERT INTO public.ca_hand_player_stat (
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
  FROM public.ca_hand_player_facts_one(NEW.id, NULL) f
  ON CONFLICT (user_id, hand_id) DO NOTHING;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- A stats row is not a financial event. The hand write must land whatever
  -- happens here; the forward roll picks up anything this missed.
  RAISE WARNING 'trg_ca_stats_live_from_hand: % (hand %)', SQLERRM, NEW.id;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_ca_stats_live_from_hand() FROM PUBLIC, anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. THE LOG
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ca_stats_witness_audit_log (
  id                  bigserial PRIMARY KEY,
  ran_at              timestamptz NOT NULL DEFAULT now(),
  window_from         timestamptz NOT NULL,
  window_to           timestamptz NOT NULL,
  hands               integer NOT NULL,
  player_hands        integer NOT NULL,
  hands_with_posts    integer NOT NULL,
  button_disagree     integer NOT NULL,
  showdown_disagree   integer NOT NULL,
  hands_without_stat  integer NOT NULL,
  human_player_hands  integer NOT NULL,
  human_without_facts integer NOT NULL,
  idx_lag_seconds     numeric,
  repair_done         boolean,
  duration_ms         integer NOT NULL
);

COMMENT ON TABLE public.ca_stats_witness_audit_log IS
  'One row per run of ca_stats_witness_audit(): the engine''s recorded button and showdown roster checked against the action log, and the two coverage gaps (hands with no stat row, human hands with no settlement row). Zero in every disagree/without column is the healthy state.';

CREATE INDEX IF NOT EXISTS idx_ca_stats_witness_audit_log_ran_at
  ON public.ca_stats_witness_audit_log (ran_at DESC);

ALTER TABLE public.ca_stats_witness_audit_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_stats_witness_audit_log FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.ca_stats_witness_audit_log TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.ca_stats_witness_audit_log_id_seq TO service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. THE WITNESS AUDIT
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ca_stats_witness_audit(
  p_minutes       integer DEFAULT 10,
  p_grace_seconds integer DEFAULT 90
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  t0                  timestamptz := clock_timestamp();
  v_to                timestamptz;
  v_from              timestamptz;
  v_hands             integer := 0;
  v_player_hands      integer := 0;
  v_with_posts        integer := 0;
  v_button_disagree   integer := 0;
  v_showdown_disagree integer := 0;
  v_without_stat      integer := 0;
  v_human_hands       integer := 0;
  v_human_no_facts    integer := 0;
  v_idx_lag           numeric;
  v_repair_done       boolean;
  v_row               public.ca_stats_witness_audit_log;
BEGIN
  -- The grace keeps the trigger's own write and the settlement writer's
  -- (asynchronous, seconds behind the hand) out of the window, so a hand
  -- that is simply still being written is not counted as a gap.
  v_to   := now() - make_interval(secs => greatest(p_grace_seconds, 0));
  v_from := v_to  - make_interval(mins => greatest(p_minutes, 1));

  -- 2a. The button against the blind posts. The seat that posted the small
  -- blind sits directly after the button in seat order (heads-up the small
  -- blind IS the button). A hand without post rows cannot be judged and is
  -- counted only in `hands`.
  WITH h AS (
    SELECT id, button_seat::int AS stored, players, coalesce(actions, '[]'::jsonb) AS actions
    FROM hand_history
    WHERE created_at >= v_from AND created_at < v_to
  ),
  seats AS (
    SELECT h.id AS hand_id, pl->>'userId' AS puid, (pl->>'seat')::int AS seat
    FROM h CROSS JOIN LATERAL jsonb_array_elements(h.players) pl
  ),
  sm AS (
    SELECT hand_id, array_agg(seat ORDER BY seat) AS seats, count(*)::int AS n
    FROM seats GROUP BY hand_id
  ),
  posts AS (
    SELECT a.hand_id, min(s.seat) AS sb_seat
    FROM (
      SELECT h.id AS hand_id, x.act->>'userId' AS auid, lower(x.act->>'action') AS action
      FROM h CROSS JOIN LATERAL jsonb_array_elements(h.actions) x(act)
    ) a
    JOIN seats s ON s.hand_id = a.hand_id AND s.puid = a.auid
    WHERE a.action IN ('sb', 'post_sb', 'small_blind')
    GROUP BY a.hand_id
  ),
  judged AS (
    SELECT h.id, h.stored, sm.n, (p.sb_seat IS NOT NULL) AS has_posts,
      CASE
        WHEN p.sb_seat IS NULL OR array_position(sm.seats, p.sb_seat) IS NULL THEN NULL
        WHEN sm.n = 2 THEN p.sb_seat
        ELSE sm.seats[((array_position(sm.seats, p.sb_seat) - 2 + sm.n) % sm.n) + 1]
      END AS derived
    FROM h
    JOIN sm ON sm.hand_id = h.id
    LEFT JOIN posts p ON p.hand_id = h.id
  )
  SELECT count(*)::int,
         coalesce(sum(n), 0)::int,
         count(*) FILTER (WHERE has_posts)::int,
         count(*) FILTER (WHERE has_posts AND derived IS DISTINCT FROM stored)::int
    INTO v_hands, v_player_hands, v_with_posts, v_button_disagree
  FROM judged;

  -- 2b. The derived showdown flag against the engine's showdown roster.
  SELECT count(*)::int INTO v_showdown_disagree
  FROM public.ca_hand_player_facts(v_from, v_to, NULL, NULL) f
  JOIN hand_history h ON h.id = f.hand_id
  WHERE f.showdown IS DISTINCT FROM EXISTS (
    SELECT 1 FROM jsonb_array_elements(coalesce(h.showdown, '[]'::jsonb)) sd
    WHERE sd->>'user_id' = f.user_id::text
  );

  -- 2c. Hands with no stat row at all (uses idx_ca_hand_player_stat_hand_id).
  SELECT count(*)::int INTO v_without_stat
  FROM hand_history h
  WHERE h.created_at >= v_from AND h.created_at < v_to
    AND NOT EXISTS (SELECT 1 FROM public.ca_hand_player_stat s WHERE s.hand_id = h.id);

  -- 2d. Human player-hands with no settlement row. ca_hand_facts is written
  -- for human seats (and horses at NIT tables) by the engine's handFacts
  -- writer; a human seat without one means the page fell back to
  -- reconstruction for that hand.
  SELECT count(*)::int,
         count(*) FILTER (WHERE NOT EXISTS (
           SELECT 1 FROM public.ca_hand_facts x
           WHERE x.hand_id = hp.hand_id AND x.user_id = hp.uid
         ))::int
    INTO v_human_hands, v_human_no_facts
  FROM (
    SELECT h.id AS hand_id, (pl->>'userId')::uuid AS uid
    FROM hand_history h
    CROSS JOIN LATERAL jsonb_array_elements(h.players) pl
    WHERE h.created_at >= v_from AND h.created_at < v_to
      AND h.has_human IS TRUE
      AND (pl->>'userId') ~ '^[0-9a-fA-F-]{36}$'
  ) hp
  JOIN public.profiles pr ON pr.id = hp.uid AND NOT coalesce(pr.is_horse, false);

  SELECT extract(epoch FROM (now() - idx_ceil))::numeric(12,1) INTO v_idx_lag
  FROM public.ca_hand_player_idx_state WHERE id;
  SELECT done INTO v_repair_done FROM public.ca_hand_player_stat_repair_state WHERE id;

  INSERT INTO public.ca_stats_witness_audit_log (
    window_from, window_to, hands, player_hands, hands_with_posts,
    button_disagree, showdown_disagree, hands_without_stat,
    human_player_hands, human_without_facts, idx_lag_seconds, repair_done,
    duration_ms
  ) VALUES (
    v_from, v_to, v_hands, v_player_hands, v_with_posts,
    v_button_disagree, v_showdown_disagree, v_without_stat,
    v_human_hands, v_human_no_facts, v_idx_lag, v_repair_done,
    (extract(epoch FROM (clock_timestamp() - t0)) * 1000)::int
  )
  RETURNING * INTO v_row;

  -- Thirty days of history is plenty; the row is 100 bytes and it runs 96
  -- times a day.
  DELETE FROM public.ca_stats_witness_audit_log WHERE ran_at < now() - interval '30 days';

  RETURN to_jsonb(v_row);
END;
$function$;

COMMENT ON FUNCTION public.ca_stats_witness_audit(integer, integer) IS
  'Checks the engine''s recorded button_seat and showdown roster against the action log over a recent window, and counts hands with no stat row and human seats with no settlement row. Writes one row to ca_stats_witness_audit_log and returns it. Zero disagreements is healthy. Service role only.';

REVOKE ALL ON FUNCTION public.ca_stats_witness_audit(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_stats_witness_audit(integer, integer) TO service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. THE HEALTH READOUT
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ca_stats_health()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH idx AS (
    SELECT idx_ceil, backfill_complete, rows_indexed, updated_at
    FROM public.ca_hand_player_idx_state WHERE id
  ),
  -- The last three minutes of hands, less a 90 s grace for the write itself:
  -- every one must already carry a stat row, because the trigger writes it in
  -- the same transaction as the hand.
  recent AS (
    SELECT count(*)::int AS hands,
           count(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM public.ca_hand_player_stat s WHERE s.hand_id = h.id
           ))::int AS without_stat
    FROM hand_history h
    WHERE h.created_at >= now() - interval '3 minutes 30 seconds'
      AND h.created_at <  now() - interval '90 seconds'
  ),
  repair AS (
    SELECT done, cursor_at, ceiling_at, hands_seen, rows_changed, updated_at
    FROM public.ca_hand_player_stat_repair_state WHERE id
  ),
  audit AS (
    SELECT ran_at, hands, button_disagree, showdown_disagree, hands_without_stat,
           human_player_hands, human_without_facts, duration_ms
    FROM public.ca_stats_witness_audit_log
    ORDER BY ran_at DESC LIMIT 1
  )
  SELECT jsonb_build_object(
    'checkedAt',            now(),
    'indexCeil',            (SELECT idx_ceil FROM idx),
    'indexLagSeconds',      (SELECT extract(epoch FROM (now() - idx_ceil))::numeric(12,1) FROM idx),
    'indexBackfillComplete',(SELECT backfill_complete FROM idx),
    'indexRows',            (SELECT rows_indexed FROM idx),
    'recentHands',          (SELECT hands FROM recent),
    'recentHandsWithoutStat', (SELECT without_stat FROM recent),
    'repair', (SELECT jsonb_build_object(
                 'done', done, 'cursorAt', cursor_at, 'ceilingAt', ceiling_at,
                 'handsSeen', hands_seen, 'rowsChanged', rows_changed, 'updatedAt', updated_at)
               FROM repair),
    'lastAudit', (SELECT jsonb_build_object(
                    'ranAt', ran_at, 'hands', hands,
                    'buttonDisagree', button_disagree,
                    'showdownDisagree', showdown_disagree,
                    'handsWithoutStat', hands_without_stat,
                    'humanPlayerHands', human_player_hands,
                    'humanWithoutFacts', human_without_facts,
                    'durationMs', duration_ms)
                  FROM audit)
  );
$function$;

COMMENT ON FUNCTION public.ca_stats_health() IS
  'The stats pipeline in one cheap read: player->hand index lag, whether the last three minutes of hands all have stat rows, the money repair cursor, and the last witness audit. Polled by the engine every minute for /health and /metrics. Service role only.';

REVOKE ALL ON FUNCTION public.ca_stats_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_stats_health() TO service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. THE SCHEDULE. Every 15 minutes, off the :55 break minute, one copy at a
-- time, bounded so a slow window cannot pile up behind the next.
-- ────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-stats-witness-audit-15m') THEN
    PERFORM cron.unschedule('ca-stats-witness-audit-15m');
  END IF;
END $$;

SELECT cron.schedule(
  'ca-stats-witness-audit-15m',
  '9,24,39,54 * * * *',
  $$SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-stats-witness-audit'))
      THEN (SELECT set_config('statement_timeout', '120s', true) IS NOT NULL
            AND public.ca_stats_witness_audit(10, 90) IS NOT NULL)
      ELSE false END$$
);

COMMIT;
