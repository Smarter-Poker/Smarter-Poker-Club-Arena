-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825190330; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- See supabase/migrations/20260825400000_stats_hand_rollup.sql for the full
-- rationale. Summary: ca_player_stats_full measured 15,071ms cold against an
-- 8,000ms statement_timeout, so Stats was being CANCELLED on heavy accounts.
-- Fully warm it is 34ms, so the cost is page count, not CPU: 3,730 random reads
-- because hand_history is 6.4KB/row (JSONB inline) and 750 hands are ~750 pages.
-- This precomputes the ~28 scalars per (player,hand) so the RPC reads ~20 pages.
--
-- The column is seat_position, not position: `position` is a col_name_keyword,
-- legal as a table column but NOT as a name in a RETURNS TABLE list, and having
-- the two disagree is exactly the kind of difference that makes a later
-- copy-paste fail confusingly.

CREATE OR REPLACE FUNCTION public.ca_hand_player_facts(p_hand_ids uuid[])
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
  WHERE h.id = ANY(p_hand_ids)
),
seatmap AS (
  SELECT mh.id AS hand_id,
         (SELECT array_agg((pl->>'seat')::int ORDER BY (pl->>'seat')::int)
            FROM jsonb_array_elements(mh.players) pl) AS seats
  FROM my_hands mh
),
acts AS MATERIALIZED (
  SELECT mh.id AS hand_id, x.ord,
         x.act->>'userId' AS auid, x.act->>'stage' AS stage,
         x.act->>'action' AS action,
         coalesce((x.act->>'amount')::numeric, 0) AS amount
  FROM my_hands mh
  CROSS JOIN LATERAL jsonb_array_elements(mh.actions) WITH ORDINALITY x(act, ord)
),
hand_level AS (
  SELECT mh.id AS hand_id,
         (SELECT (array_agg(a.auid ORDER BY a.ord DESC)
                    FILTER (WHERE a.stage = 'preflop' AND a.action IN ('raise','all_in')))[1]
            FROM acts a WHERE a.hand_id = mh.id) AS last_pf_raiser,
         (SELECT (array_agg(a.auid ORDER BY a.ord)
                    FILTER (WHERE a.stage = 'flop' AND a.action IN ('bet','all_in')))[1]
            FROM acts a WHERE a.hand_id = mh.id) AS first_flop_bettor,
         (SELECT count(*) FROM jsonb_array_elements(mh.players) pl
           WHERE pl->>'userId' NOT IN (
             SELECT a.auid FROM acts a
             WHERE a.hand_id = mh.id AND a.action = 'fold' AND a.auid IS NOT NULL)
         ) AS no_fold_players,
         CASE
           WHEN mh.started_at IS NOT NULL AND mh.ended_at IS NOT NULL
           THEN GREATEST(0, LEAST(1800, EXTRACT(epoch FROM (mh.ended_at - mh.started_at))))::numeric
           ELSE 45
         END AS hand_secs
  FROM my_hands mh
),
seated AS (
  SELECT mh.id AS hand_id,
         (pl->>'userId')::uuid AS uid,
         (pl->>'seat')::int    AS my_seat
  FROM my_hands mh
  CROSS JOIN LATERAL jsonb_array_elements(mh.players) pl
  WHERE pl->>'userId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
),
per_player_base AS (
  SELECT s.hand_id, s.uid,
    coalesce(sum(a.amount) FILTER (WHERE a.action IN ('bet','call','raise','all_in')), 0) AS invested_actions,
    coalesce(bool_or(a.stage = 'preflop' AND a.action IN ('call','bet','raise','all_in')), false) AS vpip,
    coalesce(bool_or(a.stage = 'preflop' AND a.action IN ('raise','all_in')), false) AS pfr,
    count(*) FILTER (WHERE a.action IN ('bet','raise','all_in'))::int AS aggro_cnt,
    count(*) FILTER (WHERE a.action = 'call')::int AS call_cnt,
    coalesce(bool_or(a.action = 'fold'), false) AS folded,
    min(a.ord) FILTER (WHERE a.stage = 'preflop' AND a.action IN ('raise','all_in')) AS my_first_pf_raise,
    coalesce(bool_or(a.stage = 'flop'), false) AS acted_on_flop
  FROM seated s
  LEFT JOIN acts a ON a.hand_id = s.hand_id AND a.auid = s.uid::text
  GROUP BY s.hand_id, s.uid
),
per_player_derived AS (
  SELECT b.*,
    (SELECT min(a.ord) FROM acts a
      WHERE a.hand_id = b.hand_id AND a.auid <> b.uid::text
        AND a.stage = 'preflop' AND a.action IN ('raise','all_in')) AS first_other_pf_raise,
    (SELECT min(a.ord) FROM acts a
      WHERE a.hand_id = b.hand_id AND a.auid <> b.uid::text
        AND a.stage = 'preflop' AND a.action IN ('raise','all_in')
        AND a.ord > b.my_first_pf_raise) AS reraise_after_me
  FROM per_player_base b
)
SELECT
  d.uid, mh.id, mh.created_at,
  (mh.tournament_id IS NULL), mh.tournament_id, mh.game_variant,
  mh.big_blind, mh.small_blind, array_length(sm.seats, 1),
  pos.seat_position, pos.my_blind, w.won_amt, w.is_winner,
  d.invested_actions, d.aggro_cnt, d.call_cnt, d.vpip, d.pfr, d.folded,
  coalesce(EXISTS (SELECT 1 FROM acts a
    WHERE a.hand_id = d.hand_id AND a.auid = d.uid::text AND a.stage = 'preflop'
      AND a.action IN ('raise','all_in') AND a.ord > d.first_other_pf_raise), false),
  coalesce(EXISTS (SELECT 1 FROM acts a
    WHERE a.hand_id = d.hand_id AND a.auid = d.uid::text AND a.stage = 'preflop'
      AND a.ord > d.first_other_pf_raise), false),
  (d.reraise_after_me IS NOT NULL),
  coalesce(d.reraise_after_me IS NOT NULL AND EXISTS (
    SELECT 1 FROM acts a
    WHERE a.hand_id = d.hand_id AND a.auid = d.uid::text AND a.stage = 'preflop'
      AND a.action = 'fold' AND a.ord > d.reraise_after_me), false),
  coalesce(hl.last_pf_raiser = d.uid::text AND d.acted_on_flop, false),
  coalesce(hl.last_pf_raiser = d.uid::text AND hl.first_flop_bettor = d.uid::text, false),
  (NOT d.folded AND hl.no_fold_players >= 2),
  hl.hand_secs,
  (w.won_amt - d.invested_actions - pos.my_blind)
FROM per_player_derived d
JOIN my_hands   mh ON mh.id = d.hand_id
JOIN seatmap    sm ON sm.hand_id = d.hand_id
JOIN hand_level hl ON hl.hand_id = d.hand_id
JOIN seated     st ON st.hand_id = d.hand_id AND st.uid = d.uid
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
        OR st.my_seat IS NULL OR array_length(sm.seats, 1) < 2
        OR array_position(sm.seats, mh.button_seat::int) IS NULL THEN NULL
      ELSE (array_position(sm.seats, st.my_seat)
            - array_position(sm.seats, mh.button_seat::int)
            + array_length(sm.seats, 1)) % array_length(sm.seats, 1)
    END AS pos_offset) ofs
) pos;
$function$;

COMMENT ON FUNCTION public.ca_hand_player_facts(uuid[]) IS
  'The single definition of a hand''s per-player statistics. ca_hand_player_stat is built from it and ca_player_stats_full falls back to it for hands not yet rolled up, so the rollup cannot drift from the page it feeds.';

REVOKE ALL ON FUNCTION public.ca_hand_player_facts(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ca_hand_player_facts(uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.ca_hand_player_facts(uuid[]) TO service_role;

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

CREATE INDEX IF NOT EXISTS idx_ca_hand_player_stat_user_time
  ON public.ca_hand_player_stat (user_id, created_at DESC);

COMMENT ON TABLE public.ca_hand_player_stat IS
  'Precomputed per-(player,hand) statistics. Exists because reading 750 raw hand_history rows costs ~3,730 random page reads (~15s cold) against an 8s statement_timeout, so the Stats page was being CANCELLED on heavy accounts rather than merely being slow. Retention is the most recent 1,000 hands per player, which is ~585k rows, not 14.2m.';

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

CREATE OR REPLACE FUNCTION public.ca_roll_hand_stats(p_limit int DEFAULT 2000)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_floor timestamptz;
  v_next  timestamptz;
  v_ids   uuid[];
BEGIN
  SELECT rolled_floor INTO v_floor FROM ca_hand_player_stat_state WHERE id;

  SELECT array_agg(id ORDER BY created_at DESC), min(created_at)
  INTO v_ids, v_next
  FROM (
    SELECT h.id, h.created_at FROM hand_history h
    WHERE (v_floor IS NULL OR h.created_at < v_floor)
    ORDER BY h.created_at DESC LIMIT p_limit
  ) q;

  IF v_ids IS NULL THEN
    UPDATE ca_hand_player_stat_state SET complete = true, updated_at = now() WHERE id;
    RETURN 0;
  END IF;

  -- Columns are named rather than positional. `INSERT ... SELECT *` lines up
  -- today and keeps lining up right until someone adds a column to one of the
  -- two definitions, at which point it silently writes every value into the
  -- wrong field instead of failing.
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
  FROM ca_hand_player_facts(v_ids) f
  ON CONFLICT (user_id, hand_id) DO NOTHING;

  UPDATE ca_hand_player_stat_state
     SET rolled_floor = v_next,
         rolled_ceil  = greatest(coalesce(rolled_ceil, '-infinity'::timestamptz),
                                 (SELECT max(h.created_at) FROM hand_history h WHERE h.id = ANY(v_ids))),
         updated_at   = now()
   WHERE id;

  RETURN array_length(v_ids, 1);
END;
$function$;

COMMENT ON FUNCTION public.ca_roll_hand_stats(int) IS
  'Rolls one chunk of hand_history into ca_hand_player_stat, newest first, and returns the hand count consumed. Loop until it returns 0.';

REVOKE ALL ON FUNCTION public.ca_roll_hand_stats(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ca_roll_hand_stats(int) FROM anon;
REVOKE ALL ON FUNCTION public.ca_roll_hand_stats(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ca_roll_hand_stats(int) TO service_role;

CREATE OR REPLACE FUNCTION public.ca_prune_hand_player_stat(p_keep int DEFAULT 1000)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
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
        AND p.proname IN ('ca_hand_player_facts','ca_roll_hand_stats','ca_prune_hand_player_stat')
        AND (a.grantee = 0 OR a.grantee = 'anon'::regrole)) > 0 THEN
    RAISE EXCEPTION 'A rollup function is executable by anon or PUBLIC.';
  END IF;
  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a ON true
      WHERE n.nspname = 'public'
        AND c.relname IN ('ca_hand_player_stat','ca_hand_player_stat_state')
        AND (a.grantee = 0 OR a.grantee = 'anon'::regrole OR a.grantee = 'authenticated'::regrole)) > 0 THEN
    RAISE EXCEPTION 'The rollup tables are readable by a client role. They hold every player''s results.';
  END IF;
END $$;
