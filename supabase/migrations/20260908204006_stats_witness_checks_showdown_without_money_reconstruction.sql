-- The 15-minute witness audit timed out at 120s during the 20:24 UTC
-- settlement latency spike. Its showdown check invokes the full opaque
-- SECURITY DEFINER hand-stat reconstruction, including unused money paths.
-- This replacement preserves that function's exact fold/seat rules while
-- reading only the requested window. All other audit checks, grants, grace,
-- logging and schedule remain unchanged. Isolated PostgreSQL compares the
-- old live reconstruction against the replacement before deployment.
BEGIN;

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
  v_without_idx       integer := 0;
  v_human_hands       integer := 0;
  v_human_no_facts    integer := 0;
  v_allin_sd          integer := 0;
  v_allin_sd_no_eq    integer := 0;
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

  -- 2b. Only showdown is needed here. The full range function is a
  -- SECURITY DEFINER boundary and computes every betting/money statistic
  -- even when the caller selects only showdown. Reconstruct its exact fold
  -- and non-folder rules directly over the bounded audit window instead.
  -- Raw player IDs govern non-folder counts; canonical UUID IDs govern a
  -- seated player's own fold, matching the original range function.
  WITH h AS MATERIALIZED (
    SELECT id, players, coalesce(actions, '[]'::jsonb) AS actions,
           coalesce(showdown, '[]'::jsonb) AS showdown
    FROM public.hand_history
    WHERE created_at >= v_from AND created_at < v_to
  ), seats AS MATERIALIZED (
    SELECT h.id AS hand_id, pl->>'userId' AS puid, (pl->>'seat')::int AS seat
    FROM h CROSS JOIN LATERAL jsonb_array_elements(h.players) pl
  ), folders AS MATERIALIZED (
    SELECT DISTINCT h.id AS hand_id, act->>'userId' AS puid
    FROM h CROSS JOIN LATERAL jsonb_array_elements(h.actions) act
    WHERE lower(act->>'action') = 'fold' AND act->>'userId' IS NOT NULL
  ), no_fold AS (
    SELECT s.hand_id,
           count(*) FILTER (WHERE f.puid IS NULL AND s.puid IS NOT NULL) AS n
    FROM seats s
    LEFT JOIN folders f ON f.hand_id = s.hand_id AND f.puid = s.puid
    GROUP BY s.hand_id
  ), seated AS (
    SELECT DISTINCT hand_id, puid::uuid AS user_id, seat
    FROM seats
    WHERE puid ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ), facts AS (
    SELECT s.hand_id, s.user_id, (f.puid IS NULL AND n.n >= 2) AS showdown
    FROM seated s
    JOIN no_fold n ON n.hand_id = s.hand_id
    LEFT JOIN folders f ON f.hand_id = s.hand_id AND f.puid = s.user_id::text
  )
  SELECT count(*)::int INTO v_showdown_disagree
  FROM facts f
  JOIN h ON h.id = f.hand_id
  WHERE f.showdown IS DISTINCT FROM EXISTS (
    SELECT 1 FROM jsonb_array_elements(h.showdown) sd
    WHERE sd->>'user_id' = f.user_id::text
  );

  -- 2c. Hands with no stat row at all (uses idx_ca_hand_player_stat_hand_id).
  SELECT count(*)::int INTO v_without_stat
  FROM hand_history h
  WHERE h.created_at >= v_from AND h.created_at < v_to
    AND NOT EXISTS (SELECT 1 FROM public.ca_hand_player_stat s WHERE s.hand_id = h.id);

  -- 2d. Seats with no index row. Every uuid-shaped seat, horse or human,
  -- must have one (uses idx_ca_hand_player_idx_hand_id).
  SELECT count(*)::int INTO v_without_idx
  FROM (
    SELECT h.id AS hand_id, (pl->>'userId')::uuid AS uid
    FROM hand_history h
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(h.players, '[]'::jsonb)) pl
    WHERE h.created_at >= v_from AND h.created_at < v_to
      AND (pl->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ) seat
  WHERE NOT EXISTS (
    SELECT 1 FROM public.ca_hand_player_idx i WHERE i.hand_id = seat.hand_id AND i.user_id = seat.uid
  );

  -- 2e. Human player-hands with no settlement row. ca_hand_facts is written
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

  -- 2f. EV coverage, trailing seven days (phase 3, refined the same day).
  --
  -- What the engine prices: an ALL-IN RUNOUT, i.e. the moment a stack is
  -- committed with cards to come and NO FURTHER BETTING is possible
  -- (HandController.advanceStage parks the hand when fewer than two players
  -- can still act, and broadcastAllInEquity fires there). A short stack
  -- shoving into two players who keep betting a side pot is NOT a runout:
  -- the hand plays on, one of them may fold on the river, and the shover
  -- reaches showdown with no equity figure by design, the same rule every
  -- tracker uses. The first cut of this measure counted those as gaps and
  -- read 715 owed / 11 missing (98.46%); ten of the eleven were exactly
  -- that, side-pot action after the all-in. Read against the action log
  -- the owed set is 711 and the gap is ONE hand (7be0defa, a 3-way bomb pot
  -- runout on 2026-09-01 whose equity broadcast never reached settlement).
  --
  -- So a seat is OWED equity when it was all-in before the river, reached
  -- showdown, and either carries a figure or nobody checked, bet or raised
  -- after the hand's last all-in. hand_history is read by primary key for
  -- the ~400 all-in hands a week; a hand the pruner has already taken is
  -- unknown and counted as neither owed nor missing. A river all-in has no
  -- cards to come and is not counted at all.
  WITH cand AS (
    SELECT f.hand_id, f.all_in_equity
    FROM public.ca_hand_facts f
    WHERE f.was_all_in = true
      AND f.went_to_showdown
      AND coalesce(f.all_in_street, '') <> 'river'
      AND f.played_at >= now() - interval '7 days'
  ), hands AS (
    SELECT c.hand_id,
           (SELECT bool_or(a.act->>'action' IN ('check', 'bet', 'raise') AND a.ord > la.last_allin)
              FROM public.hand_history h
              CROSS JOIN LATERAL (
                SELECT max(b.ord) AS last_allin
                FROM jsonb_array_elements(h.actions) WITH ORDINALITY b(act, ord)
                WHERE b.act->>'action' IN ('all_in', 'allin')
              ) la
              CROSS JOIN LATERAL jsonb_array_elements(h.actions) WITH ORDINALITY a(act, ord)
             WHERE h.id = c.hand_id) AS betting_continued
    FROM (SELECT DISTINCT hand_id FROM cand) c
  )
  SELECT count(*) FILTER (WHERE c.all_in_equity IS NOT NULL
                             OR NOT coalesce(h.betting_continued, true))::int,
         count(*) FILTER (WHERE c.all_in_equity IS NULL
                            AND NOT coalesce(h.betting_continued, true))::int
    INTO v_allin_sd, v_allin_sd_no_eq
  FROM cand c
  JOIN hands h USING (hand_id);

  SELECT extract(epoch FROM (now() - idx_ceil))::numeric(12,1) INTO v_idx_lag
  FROM public.ca_hand_player_idx_state WHERE id;
  SELECT done INTO v_repair_done FROM public.ca_hand_player_stat_repair_state WHERE id;

  INSERT INTO public.ca_stats_witness_audit_log (
    window_from, window_to, hands, player_hands, hands_with_posts,
    button_disagree, showdown_disagree, hands_without_stat, player_hands_without_idx,
    human_player_hands, human_without_facts, allin_showdown_7d, allin_showdown_without_equity_7d,
    idx_lag_seconds, repair_done, duration_ms
  ) VALUES (
    v_from, v_to, v_hands, v_player_hands, v_with_posts,
    v_button_disagree, v_showdown_disagree, v_without_stat, v_without_idx,
    v_human_hands, v_human_no_facts, v_allin_sd, v_allin_sd_no_eq,
    v_idx_lag, v_repair_done,
    (extract(epoch FROM (clock_timestamp() - t0)) * 1000)::int
  )
  RETURNING * INTO v_row;

  -- Thirty days of history is plenty; the row is 100 bytes and it runs 96
  -- times a day.
  DELETE FROM public.ca_stats_witness_audit_log WHERE ran_at < now() - interval '30 days';

  RETURN to_jsonb(v_row);
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_stats_witness_audit(integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_stats_witness_audit(integer, integer)
  TO service_role;
COMMIT;
