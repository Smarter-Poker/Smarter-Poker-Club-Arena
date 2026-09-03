-- Player Stats page: the money is exact, the numbers are live.
--
-- FOUND 2026-09-03, live E2E of /hub/club-arena/stats against production.
--
-- 1. THE HEADLINE CASH RESULT WAS WRONG BY 16x. ca_hand_player_facts (the
--    reconstruction every stat on the page is built from) summed
--    actions[].amount as if every verb were incremental. It is not:
--    bet / raise / all_in store the raise-TO level for the street, and the
--    `return` verb (an uncalled bet coming back, written since 2026-08-27) was
--    not subtracted at all. The client-side replay (src/utils/handReplay.ts)
--    documents both rules and reconciles to pot_size on 99.18% of hands; the
--    SQL never learned them. Measured on the account in the screenshot Dan
--    sent: 484 cash hands, reconstructed result -21,891.48, exact settlement
--    result -1,328.54. One hand read -9,752 where the engine paid the player
--    +149 (all-in 10,000, 9,851 returned uncalled, 298 collected).
--
--    Fixed two ways. The reconstruction now does street-committed differencing,
--    subtracts returns, and counts posted blinds/antes/straddles from the log
--    when the log carries them. And the page RPC OVERLAYS the exact settlement
--    row from ca_hand_facts (engine-written, cent-exact, rake-aware) wherever
--    one exists, and reports which source it used in the v2 contract.
--
-- 2. NOTHING ON THE PAGE WAS LIVE. ca_player_stats_full read only rows below
--    ca_hand_player_stat_state.rolled_ceil, which a 15-minute cron advances.
--    The live tail was removed on 2026-08-31 because it was UNBOUNDED when the
--    cron fell behind. The bounded answer is to write the per-hand stat row at
--    the moment the hand is recorded: an AFTER INSERT trigger on hand_history
--    now writes ca_hand_player_idx and ca_hand_player_stat for that one hand
--    (measured 28 ms cold for one hand including planning; the roll's
--    ON CONFLICT DO NOTHING makes the two writers idempotent). The trigger
--    never raises: a stats row is not a financial event and must not fail the
--    engine's hand write. The ceiling filter in the RPC is gone, and
--    live_tail_included is now a true statement.
--
-- 3. "HANDS PLAYED" WAS 17 HOURS STALE AND FALLING FURTHER BEHIND FOREVER.
--    ca_refresh_hand_player_index caps itself at 3,000 hands per run
--    (`least(..., 3000)`), i.e. 12,000/hour, against a measured intake of
--    28,191 hands/hour. The lifetime count on the hero and the "Most Recent"
--    notable hands both read that index. It now loops in chunks under a time
--    budget, the same shape as ca_roll_hand_stats_forward, and the trigger
--    above keeps it current between runs.
--
-- 4. "WORST LOSSES" RANKED BY THE SAME BROKEN ARITHMETIC. ca_player_hands
--    re-implemented the naive sum. It now ranks by ca_hand_player_stat.profit
--    (exact where a settlement row exists) and only reads hand_history for the
--    board and pot.
--
-- 5. THE TOURNAMENT BLOCK IGNORED THE RANGE. "7 Days" showed lifetime entries,
--    cashes and ROI. Windowed on tournaments.start_time now.
--
-- 6. Every row already in ca_hand_player_stat carries the old arithmetic.
--    ca_repair_hand_player_stat_money() recomputes them in bounded batches
--    from hand_history where the hand still exists, and overlays exact
--    settlement where ca_hand_facts has it. A pg_cron job drives it every two
--    minutes and unschedules itself when the backlog is gone (383,325 hands
--    at the time of writing). Hands already pruned from hand_history (horse-
--    only rows past the 7-day retention) cannot be recomputed and are left as
--    they are; the page's 750-hand analysis window is almost entirely inside
--    retention for anyone who plays.
--
-- 7. ca_hand_player_idx joins the realtime publication with an owner-only
--    SELECT policy, so the page can subscribe to its own inserts and refresh
--    when a hand finishes at a table in ANOTHER tab. (masterBus only sees the
--    tables this tab is watching.)
--
-- One transaction, per the DDL policy in CLAUDE.md section 2.

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. THE RECONSTRUCTION, WITH THE ENGINE'S ACTUAL AMOUNT SEMANTICS
-- ────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.ca_hand_player_facts(timestamptz, timestamptz, uuid);

CREATE FUNCTION public.ca_hand_player_facts(
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
  WHERE (p_hand_id IS NULL AND h.created_at >= p_from AND h.created_at < p_to)
     OR (p_hand_id IS NOT NULL AND h.id = p_hand_id)
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
  WHERE sb.implied_blind > 0
    AND NOT coalesce(hs.has_posts, false)
    AND NOT EXISTS (SELECT 1 FROM street_committed_raw r
                    WHERE r.hand_id = sb.hand_id AND r.auid = sb.auid AND r.stage = 'preflop')
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
hand_pot_check AS (
  SELECT mh.id AS hand_id,
         mh.pot_size,
         coalesce((SELECT sum(live_committed) FROM money_per_player mp WHERE mp.hand_id = mh.id), 0)
           + coalesce((SELECT sum(dead_money - returned) FROM money_extras mx WHERE mx.hand_id = mh.id), 0) AS pot_without,
         coalesce((SELECT sum(inferred) FROM inferred_ret ir WHERE ir.hand_id = mh.id), 0) AS inferred_total
  FROM my_hands mh
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
$function$;

REVOKE ALL ON FUNCTION public.ca_hand_player_facts(timestamptz, timestamptz, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_hand_player_facts(timestamptz, timestamptz, uuid, uuid) TO service_role;


-- ────────────────────────────────────────────────────────────────────────────
-- 2. LIVE: the per-hand stat row is written when the hand is recorded
-- ────────────────────────────────────────────────────────────────────────────
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
  FROM public.ca_hand_player_facts(NULL, NULL, NULL, NEW.id) f
  ON CONFLICT (user_id, hand_id) DO NOTHING;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- A stats row is not a financial event. The hand write must land whatever
  -- happens here; the forward roll picks up anything this missed.
  RAISE WARNING 'trg_ca_stats_live_from_hand: % (hand %)', SQLERRM, NEW.id;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_ca_stats_live_from_hand ON public.hand_history;
CREATE TRIGGER trg_ca_stats_live_from_hand
  AFTER INSERT ON public.hand_history
  FOR EACH ROW EXECUTE FUNCTION public.trg_ca_stats_live_from_hand();

-- ────────────────────────────────────────────────────────────────────────────
-- 3. THE INDEX REFRESH KEEPS UP: chunks under a time budget, not 3,000 and stop
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ca_refresh_hand_player_index(p_max_hands integer DEFAULT 50000)
RETURNS TABLE(hands_indexed integer, rows_added integer, floor_at timestamptz, ceil_at timestamptz, complete boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '10min'
AS $function$
DECLARE
  f timestamptz; c timestamptz; done boolean; new_floor timestamptz; new_ceil timestamptz;
  n_hands int := 0; n_rows int := 0; k int; kr int;
  v_chunk constant int := 3000;
  v_budget int := least(greatest(coalesce(p_max_hands, 3000), 1), 200000);
  v_deadline timestamptz := clock_timestamp() + interval '90 seconds';
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('ca_refresh_hand_player_index')) THEN
    RETURN QUERY SELECT 0, 0, NULL::timestamptz, NULL::timestamptz, false;
    RETURN;
  END IF;

  SELECT idx_floor, idx_ceil, backfill_complete INTO f, c, done
  FROM public.ca_hand_player_idx_state WHERE id FOR UPDATE;
  IF f IS NULL THEN f := now(); END IF;
  IF c IS NULL THEN c := now(); END IF;

  -- Forward, in chunks, until caught up, out of budget, or out of time.
  LOOP
    EXIT WHEN n_hands >= v_budget OR clock_timestamp() >= v_deadline;
    SELECT max(created_at) INTO new_ceil
    FROM (
      SELECT created_at FROM public.hand_history
      WHERE created_at > c ORDER BY created_at, id LIMIT v_chunk
    ) bounded;
    EXIT WHEN new_ceil IS NULL;
    WITH src AS (
      SELECT h.id, h.created_at, h.players FROM public.hand_history h
      WHERE h.created_at > c AND h.created_at <= new_ceil
    ), expanded AS (
      SELECT DISTINCT ((pl->>'userId')::uuid) AS user_id, s.created_at, s.id AS hand_id
      FROM src s, jsonb_array_elements(s.players) pl
      WHERE pl->>'userId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ), ins AS (
      INSERT INTO public.ca_hand_player_idx (user_id, created_at, hand_id)
      SELECT user_id, created_at, hand_id FROM expanded
      ON CONFLICT DO NOTHING RETURNING 1
    )
    SELECT (SELECT count(*) FROM src)::int, (SELECT count(*) FROM ins)::int INTO k, kr;
    n_hands := n_hands + coalesce(k, 0); n_rows := n_rows + coalesce(kr, 0); c := new_ceil;
  END LOOP;

  -- Backward, one chunk per run, exactly as before.
  IF NOT done AND clock_timestamp() < v_deadline THEN
    SELECT min(created_at) INTO new_floor FROM (
      SELECT created_at FROM public.hand_history
      WHERE created_at < f ORDER BY created_at DESC LIMIT v_chunk
    ) q;
    IF new_floor IS NULL THEN done := true;
    ELSE
      WITH src AS (
        SELECT h.id, h.created_at, h.players FROM public.hand_history h
        WHERE h.created_at < f AND h.created_at >= new_floor
      ), expanded AS (
        SELECT DISTINCT ((pl->>'userId')::uuid) AS user_id, s.created_at, s.id AS hand_id
        FROM src s, jsonb_array_elements(s.players) pl
        WHERE pl->>'userId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      ), ins AS (
        INSERT INTO public.ca_hand_player_idx (user_id, created_at, hand_id)
        SELECT user_id, created_at, hand_id FROM expanded
        ON CONFLICT DO NOTHING RETURNING 1
      )
      SELECT (SELECT count(*) FROM src)::int, (SELECT count(*) FROM ins)::int INTO k, kr;
      n_hands := n_hands + coalesce(k, 0); n_rows := n_rows + coalesce(kr, 0); f := new_floor;
      IF NOT EXISTS (SELECT 1 FROM public.hand_history WHERE created_at < f) THEN done := true; END IF;
    END IF;
  END IF;

  UPDATE public.ca_hand_player_idx_state
  SET idx_floor = least(coalesce(idx_floor, f), f),
      idx_ceil = greatest(coalesce(idx_ceil, c), c),
      backfill_complete = done,
      rows_indexed = rows_indexed + n_rows,
      updated_at = now()
  WHERE id;

  RETURN QUERY SELECT n_hands, n_rows, f, c, done;
END;
$function$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. THE FORWARD ROLL: now a gap-filler behind the trigger. Its retention
--    prune keyed on "users whose rows I inserted", which with the trigger
--    writing first is nobody; it prunes users seen in the window instead.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ca_roll_hand_stats_forward()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '4min'
AS $function$
DECLARE
  v_ceil timestamptz;
  v_start timestamptz;
  v_now timestamptz := now();
  v_deadline timestamptz := clock_timestamp() + interval '100 seconds';
  v_last_hand_at timestamptz;
  v_end timestamptz;
  v_hands int;
  v_total int := 0;
  v_over uuid[];
  v_chunk constant int := 2000;
  v_max_chunks constant int := 12;
  v_i int := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('ca_roll_hand_stats_forward')) THEN
    RETURN 0;
  END IF;

  SELECT rolled_ceil INTO v_ceil
  FROM public.ca_hand_player_stat_state
  WHERE id
  FOR UPDATE;

  IF v_ceil IS NULL OR v_ceil >= v_now THEN RETURN 0; END IF;
  v_start := v_ceil;

  WHILE v_i < v_max_chunks AND clock_timestamp() < v_deadline AND v_ceil < v_now LOOP
    v_i := v_i + 1;

    SELECT max(created_at) INTO v_last_hand_at
    FROM (
      SELECT created_at
      FROM public.hand_history
      WHERE created_at >= v_ceil AND created_at < v_now
      ORDER BY created_at, id
      LIMIT v_chunk
    ) bounded;

    IF v_last_hand_at IS NULL THEN
      v_ceil := v_now;
      EXIT;
    END IF;

    v_end := least(v_now, v_last_hand_at + interval '1 microsecond');

    SELECT count(*) INTO v_hands
    FROM public.hand_history
    WHERE created_at >= v_ceil AND created_at < v_end;

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
    FROM public.ca_hand_player_facts(v_ceil, v_end) f
    ON CONFLICT (user_id, hand_id) DO NOTHING;

    v_total := v_total + coalesce(v_hands, 0);
    v_ceil := v_end;
  END LOOP;

  -- Retention (1,000 rows per player), for every player with a row in the
  -- window this run covered, whoever wrote it.
  SELECT array_agg(user_id) INTO v_over
  FROM (
    SELECT user_id
    FROM public.ca_hand_player_stat
    WHERE user_id IN (SELECT DISTINCT user_id FROM public.ca_hand_player_stat
                      WHERE created_at >= v_start AND created_at < v_ceil)
    GROUP BY user_id
    HAVING count(*) > 1000
  ) o;

  IF v_over IS NOT NULL THEN
    DELETE FROM public.ca_hand_player_stat s
    USING (
      SELECT user_id, hand_id,
             row_number() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
      FROM public.ca_hand_player_stat
      WHERE user_id = ANY(v_over)
    ) r
    WHERE r.rn > 1000 AND s.user_id = r.user_id AND s.hand_id = r.hand_id;
  END IF;

  UPDATE public.ca_hand_player_stat_state
  SET rolled_ceil = greatest(coalesce(rolled_ceil, v_ceil), v_ceil), updated_at = now()
  WHERE id;

  RETURN v_total;
END;
$function$;


-- ────────────────────────────────────────────────────────────────────────────
-- 5. THE PAGE RPC: no ceiling, exact settlement overlaid, tournaments windowed
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ca_player_stats_full(p_user uuid, p_days integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  c_cap constant int := 750;
  v_since timestamptz := CASE WHEN p_days IS NULL OR p_days <= 0
                              THEN NULL ELSE now() - make_interval(days => p_days) END;
  v_life_hands int := 0;
  v_life_first timestamptz;
  v_life_last  timestamptz;
BEGIN
  SELECT count(*)::int, min(created_at), max(created_at)
  INTO v_life_hands, v_life_first, v_life_last
  FROM ca_hand_player_idx WHERE user_id = p_user;

RETURN (
WITH scored AS MATERIALIZED (
  -- The most recent c_cap rows for this player, whoever wrote them (the
  -- hand_history trigger, live, or the forward roll behind it). Where the
  -- engine wrote an exact settlement row (ca_hand_facts) the money columns
  -- come from it; the reconstruction is the fallback, and `exact` says which.
  SELECT s.created_at, s.is_cash, s.tournament_id, s.game_variant, s.big_blind,
         s.seat_position AS position,
         coalesce(x.returned, s.won_amt) AS won_amt,
         s.is_winner,
         coalesce(x.invested, s.invested_actions + s.my_blind) AS invested,
         s.aggro_cnt, s.call_cnt, s.vpip, s.pfr, s.three_bet,
         s.three_bet_opp, s.faced_three_bet, s.folded_to_three_bet, s.cbet_opp,
         s.cbet_made, s.showdown, s.hand_secs,
         coalesce(x.net, s.profit) AS profit,
         (x.hand_id IS NOT NULL) AS exact
  FROM ca_hand_player_stat s
  LEFT JOIN ca_hand_facts x ON x.hand_id = s.hand_id AND x.user_id = s.user_id
  WHERE s.user_id = p_user
    AND (v_since IS NULL OR s.created_at >= v_since)
  ORDER BY s.created_at DESC
  LIMIT c_cap
),
totals AS (
  SELECT
    count(*)::int AS hands,
    count(*) FILTER (WHERE is_cash)::int AS cash_hands,
    count(*) FILTER (WHERE is_cash AND exact)::int AS exact_cash_hands,
    count(*) FILTER (WHERE NOT is_cash)::int AS tourney_hands,
    count(DISTINCT tournament_id) FILTER (WHERE NOT is_cash)::int AS tournaments_with_hands,
    count(*) FILTER (WHERE is_winner)::int AS hands_won,
    count(*) FILTER (WHERE vpip)::int AS vpip_hands,
    count(*) FILTER (WHERE pfr)::int AS pfr_hands,
    count(*) FILTER (WHERE three_bet)::int AS three_bet_hands,
    count(*) FILTER (WHERE three_bet_opp)::int AS three_bet_opps,
    count(*) FILTER (WHERE faced_three_bet)::int AS faced_three_bet_hands,
    count(*) FILTER (WHERE folded_to_three_bet)::int AS folded_to_three_bet_hands,
    count(*) FILTER (WHERE cbet_opp)::int AS cbet_opps,
    count(*) FILTER (WHERE cbet_made)::int AS cbet_made_hands,
    coalesce(sum(aggro_cnt), 0)::int AS aggro_actions,
    coalesce(sum(call_cnt), 0)::int AS call_actions,
    count(*) FILTER (WHERE showdown)::int AS showdowns,
    count(*) FILTER (WHERE showdown AND is_winner)::int AS showdowns_won,
    coalesce(sum(profit) FILTER (WHERE is_cash), 0) AS cash_profit,
    coalesce(sum(won_amt) FILTER (WHERE is_cash), 0) AS cash_won,
    coalesce(sum(invested) FILTER (WHERE is_cash), 0) AS cash_invested,
    coalesce(max(won_amt) FILTER (WHERE is_cash), 0) AS biggest_pot_won,
    coalesce(min(profit) FILTER (WHERE is_cash), 0) AS biggest_hand_loss,
    coalesce(sum(profit / NULLIF(big_blind, 0)) FILTER (WHERE is_cash), 0) AS cash_bb_profit,
    coalesce(sum(hand_secs), 0) AS total_secs,
    min(created_at) AS first_hand_at,
    max(created_at) AS last_hand_at
  FROM scored
),
daily AS (
  SELECT date(created_at) AS d, count(*)::int AS hands,
         round(coalesce(sum(profit), 0), 2) AS profit
  FROM scored WHERE is_cash AND created_at >= now() - interval '90 days'
  GROUP BY 1 ORDER BY 1
),
sess_marked AS (
  SELECT *, CASE WHEN created_at - lag(created_at) OVER (ORDER BY created_at) > interval '45 minutes'
                 OR lag(created_at) OVER (ORDER BY created_at) IS NULL
            THEN 1 ELSE 0 END AS new_sess
  FROM scored WHERE is_cash
),
sess_grouped AS (
  SELECT *, sum(new_sess) OVER (ORDER BY created_at) AS sess_no FROM sess_marked
),
sessions_agg AS (
  SELECT sess_no, min(created_at) AS started, max(created_at) AS ended,
         count(*)::int AS hands,
         round(coalesce(sum(profit), 0), 2) AS profit,
         round(coalesce(sum(invested), 0), 2) AS invested
  FROM sess_grouped GROUP BY sess_no ORDER BY sess_no DESC LIMIT 50
),
positions AS (
  SELECT position, count(*)::int AS hands_played,
         count(*) FILTER (WHERE vpip)::int AS vpip_count,
         count(*) FILTER (WHERE pfr)::int AS pfr_count,
         count(*) FILTER (WHERE three_bet)::int AS three_bet_count,
         count(*) FILTER (WHERE three_bet_opp)::int AS three_bet_opps,
         count(*) FILTER (WHERE is_winner)::int AS hands_won,
         round(coalesce(sum(profit) FILTER (WHERE is_cash), 0), 2) AS total_profit,
         CASE WHEN count(*) FILTER (WHERE is_cash) > 0
              THEN round(coalesce(sum(profit / NULLIF(big_blind, 0)) FILTER (WHERE is_cash), 0)
                   / count(*) FILTER (WHERE is_cash) * 100, 2)
              ELSE 0 END AS bb100
  FROM scored WHERE position <> 'UNK' GROUP BY position
),
stakes AS (
  SELECT big_blind, count(*)::int AS hands,
         count(*) FILTER (WHERE is_winner)::int AS hands_won,
         round(coalesce(sum(profit), 0), 2) AS profit,
         CASE WHEN count(*) > 0
              THEN round(coalesce(sum(profit / NULLIF(big_blind, 0)), 0) / count(*) * 100, 2)
              ELSE 0 END AS bb100
  FROM scored WHERE is_cash AND big_blind > 0
  GROUP BY big_blind ORDER BY big_blind DESC
),
variants AS (
  SELECT game_variant, count(*)::int AS hands,
         count(*) FILTER (WHERE is_winner)::int AS hands_won,
         round(coalesce(sum(profit) FILTER (WHERE is_cash), 0), 2) AS profit,
         CASE WHEN count(*) FILTER (WHERE is_cash) > 0
              THEN round(coalesce(sum(profit / NULLIF(big_blind, 0)) FILTER (WHERE is_cash), 0)
                   / count(*) FILTER (WHERE is_cash) * 100, 2)
              ELSE 0 END AS bb100
  FROM scored GROUP BY game_variant ORDER BY count(*) DESC
),
-- The tournament block honours the analysis window like everything else on
-- the page. It used to be lifetime under a "7 Days" label.
tourn_rows AS (
  SELECT tp.*, t.buy_in_amount, t.buy_in_fee, t.rebuy_cost, t.addon_cost,
         t.name, t.start_time, t.variant, t.is_mystery_bounty
  FROM tournament_players tp
  LEFT JOIN tournaments t ON t.id = tp.tournament_id
  WHERE tp.user_id = p_user
    AND (v_since IS NULL OR coalesce(t.start_time, tp.registered_at, now()) >= v_since)
),
tourn AS (
  SELECT count(*)::int AS entries,
         count(*) FILTER (WHERE coalesce(tp.prize, 0) > 0)::int AS cashes,
         count(*) FILTER (WHERE tp.position = 1 OR tp.status = 'winner')::int AS wins,
         min(tp.position) FILTER (WHERE tp.position IS NOT NULL) AS best_finish,
         coalesce(sum(coalesce(tp.buy_in_amount, 0) + coalesce(tp.buy_in_fee, 0)
           + coalesce(tp.rebuys, 0) * coalesce(tp.rebuy_cost, 0)
           + CASE WHEN tp.add_on THEN coalesce(tp.addon_cost, 0) ELSE 0 END), 0) AS total_buyins,
         coalesce(sum(coalesce(tp.prize, 0) + coalesce(tp.bounty_winnings, 0)), 0) AS total_winnings,
         coalesce(sum(coalesce(tp.prize, 0)), 0) AS total_prizes,
         coalesce(sum(coalesce(tp.bounty_winnings, 0)), 0) AS total_bounty_winnings,
         coalesce(sum(coalesce(tp.bounties_collected, 0)), 0)::int AS total_bounties
  FROM tourn_rows tp
),
tourn_recent AS (
  SELECT tp.tournament_id, tp.name, tp.start_time, tp.variant,
         coalesce(tp.is_mystery_bounty, false) AS is_mystery_bounty,
         tp.position AS finish_rank, tp.status,
         coalesce(tp.prize, 0) AS prize,
         coalesce(tp.bounty_winnings, 0) AS bounty_winnings,
         coalesce(tp.bounties_collected, 0)::int AS bounties,
         coalesce(tp.prize, 0) + coalesce(tp.bounty_winnings, 0) AS total_won,
         coalesce(tp.buy_in_amount, 0) + coalesce(tp.buy_in_fee, 0)
           + coalesce(tp.rebuys, 0) * coalesce(tp.rebuy_cost, 0)
           + CASE WHEN tp.add_on THEN coalesce(tp.addon_cost, 0) ELSE 0 END AS buyin
  FROM tourn_rows tp
  WHERE tp.tournament_id IS NOT NULL
  ORDER BY tp.start_time DESC NULLS LAST LIMIT 25
)
SELECT jsonb_build_object(
  'generated_at', now(),
  'window_days', p_days,
  'lifetime', jsonb_build_object(
    'hands', v_life_hands,
    'first_hand_at', v_life_first,
    'last_hand_at', v_life_last,
    'indexed_complete', (SELECT backfill_complete FROM ca_hand_player_idx_state WHERE id)
  ),
  'user_id', p_user,
  'overall', (SELECT jsonb_build_object(
    'total_hands', hands,
    'cash_hands', cash_hands,
    'exact_cash_hands', exact_cash_hands,
    'tourney_hands', tourney_hands,
    'tournaments_with_hands', tournaments_with_hands,
    'hands_won', hands_won,
    'hands_lost', hands - hands_won,
    'vpip', CASE WHEN hands > 0 THEN round(vpip_hands::numeric / hands, 4) ELSE 0 END,
    'pfr', CASE WHEN hands > 0 THEN round(pfr_hands::numeric / hands, 4) ELSE 0 END,
    'three_bet_percent', CASE WHEN three_bet_opps > 0
        THEN round(three_bet_hands::numeric / three_bet_opps, 4) ELSE 0 END,
    'fold_to_three_bet', CASE WHEN faced_three_bet_hands > 0
        THEN round(folded_to_three_bet_hands::numeric / faced_three_bet_hands, 4) ELSE 0 END,
    'cbet_flop', CASE WHEN cbet_opps > 0
        THEN round(cbet_made_hands::numeric / cbet_opps, 4) ELSE 0 END,
    'aggression_factor', CASE WHEN call_actions > 0
        THEN round(aggro_actions::numeric / call_actions, 2) ELSE aggro_actions END,
    'showdowns_total', showdowns,
    'showdowns_won', showdowns_won,
    'wtsd', CASE WHEN hands > 0 THEN round(showdowns::numeric / hands, 4) ELSE 0 END,
    'total_profit', round(cash_profit, 2),
    'total_winnings', round(cash_won, 2),
    'total_invested', round(cash_invested, 2),
    'biggest_pot_won', round(biggest_pot_won, 2),
    'biggest_hand_loss', round(biggest_hand_loss, 2),
    'bb_per_100', CASE WHEN cash_hands > 0
        THEN round(cash_bb_profit / cash_hands * 100, 2) ELSE 0 END,
    'hours_played', round(total_secs / 3600.0, 2),
    'hand_cap', c_cap,
    'hands_capped', (hands >= c_cap),
    'first_hand_at', first_hand_at,
    'last_hand_at', last_hand_at
  ) FROM totals),
  'daily', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'date', d, 'hands', hands, 'profit', profit) ORDER BY d) FROM daily), '[]'::jsonb),
  'sessions', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', sess_no, 'date', started, 'ended', ended,
      'duration_minutes', GREATEST(1, round(EXTRACT(epoch FROM (ended - started)) / 60)::int),
      'hands_played', hands, 'buy_in', invested,
      'cash_out', round(invested + profit, 2),
      'profit_loss', profit) ORDER BY sess_no DESC) FROM sessions_agg), '[]'::jsonb),
  'positions', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'position', position, 'hands_played', hands_played, 'vpip_count', vpip_count,
      'pfr_count', pfr_count, 'three_bet_count', three_bet_count,
      'three_bet_opps', three_bet_opps,
      'hands_won', hands_won, 'total_profit', total_profit,
      'bb100', bb100)) FROM positions), '[]'::jsonb),
  'variants', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'variant', game_variant, 'hands', hands, 'hands_won', hands_won,
      'profit', profit, 'bb100', bb100)) FROM variants), '[]'::jsonb),
  'stakes', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'big_blind', big_blind, 'hands', hands, 'hands_won', hands_won,
      'profit', profit, 'bb100', bb100) ORDER BY big_blind DESC) FROM stakes), '[]'::jsonb),
  'tournaments', (SELECT jsonb_build_object(
      'entries', entries, 'cashes', cashes, 'wins', wins, 'best_finish', best_finish,
      'itm_percent', CASE WHEN entries > 0 THEN round(cashes::numeric / entries, 4) ELSE 0 END,
      'total_buyins', round(total_buyins, 2),
      'total_winnings', round(total_winnings, 2),
      'total_prizes', round(total_prizes, 2),
      'total_bounty_winnings', round(total_bounty_winnings, 2),
      'total_bounties', total_bounties,
      'net_profit', round(total_winnings - total_buyins, 2),
      'roi', CASE WHEN total_buyins > 0
          THEN round((total_winnings - total_buyins) / total_buyins, 4) ELSE 0 END
  ) FROM tourn),
  'recent_tournaments', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'tournament_id', tournament_id,
      'name', name, 'start_time', start_time, 'variant', variant,
      'is_mystery_bounty', is_mystery_bounty,
      'finish_rank', finish_rank, 'status', status,
      'prize', prize,
      'bounty_winnings', bounty_winnings,
      'bounties', bounties,
      'total_won', total_won,
      'buyin', buyin) ORDER BY start_time DESC NULLS LAST) FROM tourn_recent), '[]'::jsonb)
)
);
END;
$function$;

CREATE OR REPLACE FUNCTION public.ca_player_stats_overview_v2(
  p_user uuid,
  p_days integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_result jsonb;
  v_rollup_ceil timestamptz;
  v_rollup_updated_at timestamptz;
  v_cash int;
  v_exact int;
  v_source text;
  v_days integer := CASE
    WHEN p_days IS NULL THEN NULL
    ELSE least(greatest(p_days, 1), 3650)
  END;
BEGIN
  PERFORM public.ca_assert_self(p_user);

  SELECT rolled_ceil, updated_at
    INTO v_rollup_ceil, v_rollup_updated_at
  FROM public.ca_hand_player_stat_state
  WHERE id;

  v_result := public.ca_player_stats_full(p_user, v_days);
  v_cash  := coalesce((v_result #>> '{overall,cash_hands}')::int, 0);
  v_exact := coalesce((v_result #>> '{overall,exact_cash_hands}')::int, 0);
  -- The money source is a MEASUREMENT of this payload, not a constant.
  v_source := CASE
    WHEN v_cash = 0 OR v_exact = v_cash THEN 'exact_settlement'
    WHEN v_exact = 0 THEN 'reconstructed_actions'
    ELSE 'mixed'
  END;

  RETURN coalesce(v_result, '{}'::jsonb) || jsonb_build_object(
    'contract_version', 2,
    'scope', jsonb_build_object(
      'target_user_id', p_user,
      'club_id', NULL,
      'range_days', v_days,
      'visibility', 'owner'
    ),
    'quality', jsonb_build_object(
      'cash_money_source', v_source,
      'cash_money_exact', (v_source = 'exact_settlement'),
      'exact_cash_hands', v_exact,
      'advanced_facts_source', 'ca_hand_player_stat',
      'historical_club_breakdown_available', false,
      -- The hand_history trigger writes the stat row in the same transaction
      -- as the hand, so the payload includes every recorded hand.
      'live_tail_included', true
    ),
    'coverage', jsonb_build_object(
      'analysis_hand_cap', coalesce((v_result #>> '{overall,hand_cap}')::integer, 750),
      'analysis_hands_capped', coalesce((v_result #>> '{overall,hands_capped}')::boolean, false),
      'lifetime_index_complete', coalesce((v_result #>> '{lifetime,indexed_complete}')::boolean, false),
      'first_hand_at', v_result #> '{lifetime,first_hand_at}',
      'last_hand_at', v_result #> '{lifetime,last_hand_at}',
      'rollup_covered_through', to_jsonb(v_rollup_ceil),
      'rollup_updated_at', to_jsonb(v_rollup_updated_at)
    )
  );
END;
$function$;

-- ────────────────────────────────────────────────────────────────────────────
-- 6. NOTABLE HANDS: ranked by the same money the rest of the page shows
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ca_player_hands(p_user uuid, p_mode text DEFAULT 'recent', p_limit integer DEFAULT 25)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  c_window constant int := 750;   -- same analysis window as ca_player_stats_full
  v_limit  int := LEAST(GREATEST(coalesce(p_limit, 25), 1), 100);
  v_self   boolean := (auth.uid() IS NOT NULL AND auth.uid() = p_user);
  v_mode   text := lower(coalesce(p_mode, 'recent'));
BEGIN
  IF v_mode NOT IN ('recent', 'biggest_won', 'biggest_lost') THEN
    v_mode := 'recent';
  END IF;

RETURN (
WITH mine AS (
  SELECT s.hand_id, s.created_at, s.tournament_id, s.game_variant AS variant,
         s.big_blind, s.seat_position AS position, s.is_winner, s.n_players,
         coalesce(x.returned, s.won_amt) AS won_amt,
         coalesce(x.net, s.profit) AS profit
  FROM ca_hand_player_stat s
  LEFT JOIN ca_hand_facts x ON x.hand_id = s.hand_id AND x.user_id = s.user_id
  WHERE s.user_id = p_user
    -- The "biggest" modes rank chips, and tournament chips are not money: a
    -- -71,330 in a freeroll outranked every cash hand the player ever lost.
    -- Cash only for those; "recent" shows everything.
    AND (v_mode = 'recent' OR s.is_cash)
  ORDER BY s.created_at DESC
  LIMIT CASE WHEN v_mode = 'recent' THEN v_limit ELSE c_window END
),
ranked AS (
  SELECT * FROM mine
  ORDER BY CASE WHEN v_mode = 'biggest_won'  THEN profit END DESC NULLS LAST,
           CASE WHEN v_mode = 'biggest_lost' THEN profit END ASC  NULLS LAST,
           CASE WHEN v_mode = 'recent'       THEN created_at END DESC NULLS LAST
  LIMIT v_limit
)
SELECT coalesce(jsonb_agg(jsonb_build_object(
  'id', r.hand_id,
  'played_at', r.created_at,
  'variant', r.variant,
  'big_blind', r.big_blind,
  'is_tournament', (r.tournament_id IS NOT NULL),
  'position', NULLIF(r.position, 'UNK'),
  'pot_size', round(coalesce(h.pot_size, 0)::numeric, 2),
  'won', round(r.won_amt, 2),
  'profit', round(r.profit, 2),
  'is_winner', r.is_winner,
  'players', coalesce(r.n_players, (SELECT count(*) FROM jsonb_array_elements(coalesce(h.players, '[]'::jsonb)))),
  'board', coalesce(h.board, to_jsonb(h.community_cards)),
  -- Own cards only. Never expose another player's hole cards.
  'hole_cards', CASE WHEN v_self THEN h.hole_cards -> p_user::text ELSE NULL END
) ORDER BY CASE WHEN v_mode = 'biggest_won'  THEN r.profit END DESC NULLS LAST,
           CASE WHEN v_mode = 'biggest_lost' THEN r.profit END ASC  NULLS LAST,
           CASE WHEN v_mode = 'recent'       THEN r.created_at END DESC NULLS LAST),
  '[]'::jsonb)
FROM ranked r
LEFT JOIN hand_history h ON h.id = r.hand_id
);
END;
$function$;


-- Grants restated (they already hold in production from the 2026-08-31
-- foundation migrations; CREATE OR REPLACE keeps them, and the pre-push
-- definer check reads this file on its own). Owner-only: the browser reaches
-- these only through the v2 wrappers, which assert auth.uid() = p_user.
REVOKE ALL ON FUNCTION public.ca_player_stats_full(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_full(uuid, integer) TO service_role;
REVOKE ALL ON FUNCTION public.ca_player_hands(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_player_hands(uuid, text, integer) TO service_role;
-- The v2 wrapper is the browser's door; ca_assert_self inside it refuses any
-- caller other than the owner (auth.uid() = p_user) or service_role.
REVOKE ALL ON FUNCTION public.ca_player_stats_overview_v2(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_overview_v2(uuid, integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.ca_refresh_hand_player_index(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_refresh_hand_player_index(integer) TO service_role;
REVOKE ALL ON FUNCTION public.ca_roll_hand_stats_forward() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_roll_hand_stats_forward() TO service_role;
REVOKE ALL ON FUNCTION public.trg_ca_stats_live_from_hand() FROM PUBLIC, anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 7. REPAIR THE ROWS ALREADY WRITTEN WITH THE OLD ARITHMETIC
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ca_hand_player_stat_repair_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  cursor_at timestamptz NOT NULL,
  ceiling_at timestamptz NOT NULL,
  hands_seen bigint NOT NULL DEFAULT 0,
  rows_changed bigint NOT NULL DEFAULT 0,
  done boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ca_hand_player_stat_repair_state ENABLE ROW LEVEL SECURITY;

INSERT INTO public.ca_hand_player_stat_repair_state (id, cursor_at, ceiling_at)
SELECT true, coalesce(min(created_at), now()), now()
FROM public.ca_hand_player_stat
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.ca_repair_hand_player_stat_money(p_max_hands integer DEFAULT 24000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '4min'
AS $function$
DECLARE
  v_cur timestamptz;
  v_ceiling timestamptz;
  v_deadline timestamptz := clock_timestamp() + interval '100 seconds';
  v_chunk constant int := 2000;
  v_last timestamptz;
  v_end timestamptz;
  v_hands int := 0;
  v_changed int := 0;
  v_k int;
  v_done boolean := false;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('ca_repair_hand_player_stat_money')) THEN
    RETURN jsonb_build_object('skipped', 'locked');
  END IF;

  SELECT cursor_at, ceiling_at, done INTO v_cur, v_ceiling, v_done
  FROM public.ca_hand_player_stat_repair_state WHERE id FOR UPDATE;
  IF v_done OR v_cur IS NULL THEN
    RETURN jsonb_build_object('done', true);
  END IF;

  WHILE v_hands < p_max_hands AND clock_timestamp() < v_deadline AND v_cur < v_ceiling LOOP
    SELECT max(created_at) INTO v_last
    FROM (SELECT created_at FROM public.hand_history
          WHERE created_at >= v_cur AND created_at < v_ceiling
          ORDER BY created_at, id LIMIT v_chunk) b;
    IF v_last IS NULL THEN
      v_cur := v_ceiling;
      EXIT;
    END IF;
    v_end := least(v_ceiling, v_last + interval '1 microsecond');

    WITH f AS (
      SELECT * FROM public.ca_hand_player_facts(v_cur, v_end)
    ), upd AS (
      UPDATE public.ca_hand_player_stat s
      SET my_blind = f.my_blind,
          invested_actions = f.invested_actions,
          won_amt = f.won_amt,
          profit = f.profit
      FROM f
      WHERE s.user_id = f.user_id AND s.hand_id = f.hand_id
        AND (s.profit IS DISTINCT FROM f.profit
             OR s.invested_actions IS DISTINCT FROM f.invested_actions
             OR s.my_blind IS DISTINCT FROM f.my_blind)
      RETURNING 1
    )
    SELECT count(*) INTO v_k FROM upd;
    v_changed := v_changed + coalesce(v_k, 0);
    v_hands := v_hands + v_chunk;
    v_cur := v_end;
  END LOOP;

  v_done := (v_cur >= v_ceiling);

  UPDATE public.ca_hand_player_stat_repair_state
  SET cursor_at = v_cur, hands_seen = hands_seen + v_hands,
      rows_changed = rows_changed + v_changed, done = v_done, updated_at = now()
  WHERE id;

  IF v_done THEN
    BEGIN
      PERFORM cron.unschedule('ca-stats-money-repair');
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'ca_repair_hand_player_stat_money: could not unschedule: %', SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object('cursor_at', v_cur, 'ceiling_at', v_ceiling,
                            'hands', v_hands, 'rows_changed', v_changed, 'done', v_done);
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_repair_hand_player_stat_money(integer) FROM PUBLIC, anon, authenticated;

-- One-off, self-unscheduling. Measured in the rolled-back probe: ~2,000 hands
-- per 34 s on cold rows, so ~6,000 hands inside each 100 s budget. Hands past
-- the 7-day horse retention are already gone from hand_history and cost
-- nothing to skip; the remaining ~380k hands take about three hours at this
-- cadence, at roughly half duty cycle.
-- Throttled after apply (measured live: with the repair at half duty the
-- engine's hand_history insert mean rose from 58 ms to 267 ms from IO
-- contention; the trigger itself is 2-5 ms warm). 4,000 hands every 5
-- minutes is about a fifth of the box, and it finishes in a night.
SELECT cron.schedule('ca-stats-money-repair', '*/5 * * * *',
  $$SELECT public.ca_repair_hand_player_stat_money(4000)$$);

-- ────────────────────────────────────────────────────────────────────────────
-- 8. REALTIME: the page can hear its own hands finish in another tab
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS ca_hand_player_idx_owner_read ON public.ca_hand_player_idx;
CREATE POLICY ca_hand_player_idx_owner_read ON public.ca_hand_player_idx
  FOR SELECT TO authenticated USING (user_id = auth.uid());
GRANT SELECT ON public.ca_hand_player_idx TO authenticated;

DO $pub$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime' AND tablename = 'ca_hand_player_idx') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.ca_hand_player_idx;
  END IF;
END
$pub$;

COMMIT;
