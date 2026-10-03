-- 20260927144416_stats_gap_and_witness_count_real_gaps_not_pending_projection.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- ca_stats_health() and ca_stats_witness_audit() feed ClubArenaStatsTriggerGap /
-- StatsLiveTriggerMissingHands and ClubArenaStatsWitnessDisagree /
-- StatsWitnessAuditDisagrees. Measured on production 2026-09-27, the firings
-- since 2026-09-24 were correct states read as defects:
--
--  1. Missing stats. Accepted atomic hands publish stat and index rows through
--     hand_projection_outbox (2026-09-08), minutes behind the hand. Both reads
--     still assumed the inline trigger (90 s grace) and counted every pending
--     hand: at 14:35 UTC every hand after 14:30 had no stat row and every one
--     of them had its outbox row. A hand now counts as missing only when it
--     has NEITHER a stat row NOR an outbox row; pending hands are reported
--     separately by the health read (recentHandsPendingProjection).
--
--  2. Button disagreements. The tournament dead button (2026-09-25, #5233)
--     puts the button on an empty seat; the audit's derivation cannot name an
--     empty seat. 157 of 157 disagreements in six hours were that rule
--     applied correctly. A tournament hand whose stored button is an empty
--     seat now agrees exactly when the small blind was the first occupied seat
--     after it. Cash tables are judged as before.
--
-- Everything else in both functions (showdown check, human facts, EV
-- coverage, logging, retention, grants) is the live definition unchanged.
-- Regression: scripts/ci/test-stats-witness-real-gaps.py, run by CI.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

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
  --
  -- A TOURNAMENT BUTTON MAY BE DEAD (2026-09-27). Since 2026-09-25 (#5233,
  -- server/src/engine/deadButton.ts, TDA Rule 30) a tournament table of
  -- three or more keeps the button on the seat that held the small blind
  -- last hand even after that player busted, so button_seat can name a seat
  -- nobody occupies. The derivation below ("the occupied seat before the
  -- small blind") cannot produce an empty seat, and it counted every such
  -- hand as a recording defect: 157 of 157 disagreements in the six hours to
  -- 14:40 UTC 2026-09-27 were tournament hands whose stored button was an
  -- empty seat and whose small blind was the first occupied seat after it -
  -- exactly the rule. Such a hand now agrees when, and only when, the seat
  -- that posted the small blind is the first occupied seat after the stored
  -- button. A cash table has no dead button, so an empty-seat button there
  -- still disagrees.
  WITH h AS (
    SELECT id, button_seat::int AS stored, tournament_id IS NOT NULL AS is_tourney,
           players, coalesce(actions, '[]'::jsonb) AS actions
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
        WHEN h.is_tourney
             AND h.stored IS NOT NULL
             AND array_position(sm.seats, h.stored) IS NULL
             AND p.sb_seat = coalesce(
                   (SELECT min(x) FROM unnest(sm.seats) x WHERE x > h.stored),
                   sm.seats[1])
          THEN h.stored
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
  --
  -- A HAND STILL IN hand_projection_outbox IS PENDING, NOT MISSING
  -- (2026-09-27). Since 2026-09-08 an accepted atomic hand skips the inline
  -- stats trigger (app.atomic_hand_commit) and gets its stat and index rows
  -- from fn_project_hand_side_effects, which writes them and deletes the
  -- outbox row in ONE transaction. So a hand with an outbox row has not been
  -- projected yet, and a hand with neither an outbox row nor a stat row is a
  -- writer that finished without writing - the defect this check exists for.
  -- Counting pending hands made this check a second, unlabelled projection
  -- lag gauge: 10,466 of 10,466 hands at 23:39 UTC 2026-09-26. Projection
  -- lag has its own alerts (HandProjectionOutboxBacklog*,
  -- poker_hand_projection_outbox_oldest_age_seconds).
  SELECT count(*)::int INTO v_without_stat
  FROM hand_history h
  WHERE h.created_at >= v_from AND h.created_at < v_to
    AND NOT EXISTS (SELECT 1 FROM public.ca_hand_player_stat s WHERE s.hand_id = h.id)
    AND NOT EXISTS (SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id = h.id);

  -- 2d. Seats with no index row. Every uuid-shaped seat, horse or human,
  -- must have one (uses idx_ca_hand_player_idx_hand_id).
  SELECT count(*)::int INTO v_without_idx
  FROM (
    SELECT h.id AS hand_id, (pl->>'userId')::uuid AS uid
    FROM hand_history h
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(h.players, '[]'::jsonb)) pl
    WHERE h.created_at >= v_from AND h.created_at < v_to
      AND (pl->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      -- Pending projection owns this hand's index rows too (see 2c).
      AND NOT EXISTS (SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id = h.id)
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
  -- The last three minutes of hands, less a 90 s grace for the write itself.
  -- A hand with no stat row is either PENDING (its hand_projection_outbox
  -- row is still there: the atomic path publishes stats asynchronously, and
  -- the projection writes the stat rows and deletes the outbox row in one
  -- transaction) or MISSING (no outbox row and no stat row: a writer that
  -- finished without writing). Only MISSING is recentHandsWithoutStat; the
  -- pending count is reported beside it so lag stays visible, and lag is
  -- alerted by HandProjectionOutboxBacklog* (2026-09-27: this read counted
  -- 463 of 1,461 recent hands "without stat", every one pending).
  recent AS (
    SELECT count(*)::int AS hands,
           count(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM public.ca_hand_player_stat s WHERE s.hand_id = h.id
           ) AND NOT EXISTS (
             SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id = h.id
           ))::int AS without_stat,
           count(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM public.ca_hand_player_stat s WHERE s.hand_id = h.id
           ) AND EXISTS (
             SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id = h.id
           ))::int AS pending_projection
    FROM hand_history h
    WHERE h.created_at >= now() - interval '3 minutes 30 seconds'
      AND h.created_at <  now() - interval '90 seconds'
  ),
  repair AS (
    SELECT done, cursor_at, ceiling_at, hands_seen, rows_changed, updated_at
    FROM public.ca_hand_player_stat_repair_state WHERE id
  ),
  seatfill AS (
    SELECT done, cursor_at, rows_added FROM public.ca_idx_every_seat_state WHERE id
  ),
  audit AS (
    SELECT ran_at, hands, button_disagree, showdown_disagree, hands_without_stat,
           player_hands_without_idx, human_player_hands, human_without_facts,
           allin_showdown_7d, allin_showdown_without_equity_7d, duration_ms
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
    'recentHandsPendingProjection', (SELECT pending_projection FROM recent),
    'repair', (SELECT jsonb_build_object(
                 'done', done, 'cursorAt', cursor_at, 'ceilingAt', ceiling_at,
                 'handsSeen', hands_seen, 'rowsChanged', rows_changed, 'updatedAt', updated_at)
               FROM repair),
    'seatBackfill', (SELECT jsonb_build_object('done', done, 'cursorAt', cursor_at, 'rowsAdded', rows_added)
                     FROM seatfill),
    'evCoverage7d', (SELECT jsonb_build_object(
                       'allInShowdowns', allin_showdown_7d,
                       'withoutEquity', allin_showdown_without_equity_7d,
                       'ratio', CASE WHEN allin_showdown_7d > 0
                                     THEN round((allin_showdown_7d - allin_showdown_without_equity_7d)::numeric
                                                / allin_showdown_7d, 4)
                                     ELSE NULL END)
                     FROM audit),
    'lastAudit', (SELECT jsonb_build_object(
                    'ranAt', ran_at, 'hands', hands,
                    'buttonDisagree', button_disagree,
                    'showdownDisagree', showdown_disagree,
                    'handsWithoutStat', hands_without_stat,
                    'playerHandsWithoutIdx', player_hands_without_idx,
                    'humanPlayerHands', human_player_hands,
                    'humanWithoutFacts', human_without_facts,
                    'durationMs', duration_ms)
                  FROM audit)
  );
$function$;

REVOKE ALL ON FUNCTION public.ca_stats_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_stats_health() TO service_role;

COMMIT;
