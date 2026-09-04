-- 20260904092705_stats_phase_1_every_seat_is_indexed.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- STATS PAGE PROGRAMME, PHASE 1 (verification pass): EVERY SEAT IS INDEXED
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Found while verifying phase 1 against production on 2026-09-04. In the
-- previous two hours, 57 players sat at tables, played 9,750 hands that the
-- live trigger duly wrote to ca_hand_player_stat, and received ZERO rows in
-- ca_hand_player_idx. All 57 are horses, and all 57 have synthetic ids:
-- 00000000-0000-0000-0000-000000000003, face0000-0000-0000-0000-00000000000a,
-- and so on. Valid uuid shapes, castable, present in profiles; they just do
-- not carry the RFC 4122 version nibble and variant bits that the index
-- writer's regex demanded:
--
--     ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$
--
-- The stat writer (ca_hand_player_facts, `seated`) uses the plain shape and
-- so counted them; the index writer (trg_ca_stats_live_from_hand part (a) and
-- ca_refresh_hand_player_index) did not. For those 57 players "Hands Played"
-- reads 0, the notable-hands list is empty, and the live subscription on the
-- index never fires. That is a horse being denied something a human gets, by
-- a regex nobody chose on purpose (CLAUDE.md 10.5). About 0.35% of hands in
-- the last six hours had at least one such seat.
--
-- 1. Both index writers accept the same uuid shape the stat writer accepts.
-- 2. ca_index_every_seat(p_minutes) walks retained hand_history forward from
--    a cursor and inserts the missing index rows for exactly those ids, in
--    bounded windows; pg_cron drives it every minute and it unschedules
--    itself when the cursor reaches the present. hand_history keeps seven
--    days, so the backfill covers what can be covered.
-- 3. The witness audit gains `player_hands_without_idx` (every seat with a
--    uuid-shaped id must have an index row) and ca_stats_health() reports it,
--    so the next regex of this kind is found within fifteen minutes.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. THE INDEX WRITERS ACCEPT WHAT THE STAT WRITER ACCEPTS
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.trg_ca_stats_live_from_hand()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- (a) the player -> hand index: one row per seat, three columns. The id
  -- shape is the one ca_hand_player_facts accepts: any uuid-shaped string,
  -- not only RFC 4122 v1-v5 (horses carry synthetic ids like
  -- 00000000-0000-0000-0000-000000000003, and a horse is a player).
  INSERT INTO public.ca_hand_player_idx (user_id, created_at, hand_id)
  SELECT DISTINCT (pl->>'userId')::uuid, NEW.created_at, NEW.id
  FROM jsonb_array_elements(coalesce(NEW.players, '[]'::jsonb)) pl
  WHERE pl->>'userId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
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
      WHERE pl->>'userId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    ), ins AS (
      INSERT INTO public.ca_hand_player_idx (user_id, created_at, hand_id)
      SELECT user_id, created_at, hand_id FROM expanded
      ON CONFLICT DO NOTHING RETURNING 1
    )
    SELECT (SELECT count(*) FROM src)::int, (SELECT count(*) FROM ins)::int INTO k, kr;
    n_hands := n_hands + coalesce(k, 0); n_rows := n_rows + coalesce(kr, 0); c := new_ceil;
  END LOOP;

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
        WHERE pl->>'userId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
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

REVOKE ALL ON FUNCTION public.ca_refresh_hand_player_index(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_refresh_hand_player_index(integer) TO service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. THE BACKFILL: index rows for the seats the old regex skipped
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ca_idx_every_seat_state (
  id           boolean PRIMARY KEY DEFAULT true CHECK (id),
  cursor_at    timestamptz NOT NULL,
  hands_seen   bigint NOT NULL DEFAULT 0,
  rows_added   bigint NOT NULL DEFAULT 0,
  done         boolean NOT NULL DEFAULT false,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ca_idx_every_seat_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_idx_every_seat_state FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.ca_idx_every_seat_state TO service_role;

-- Start at the oldest retained hand.
INSERT INTO public.ca_idx_every_seat_state (id, cursor_at)
SELECT true, coalesce((SELECT min(created_at) FROM public.hand_history), now())
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.ca_index_every_seat(p_minutes integer DEFAULT 60)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_from     timestamptz;
  v_to       timestamptz;
  v_end      timestamptz := now() - interval '2 minutes';
  v_deadline timestamptz := clock_timestamp() + interval '50 seconds';
  v_hands    bigint := 0;
  v_rows     bigint := 0;
  k int; kr int;
  v_done     boolean := false;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('ca_index_every_seat')) THEN
    RETURN jsonb_build_object('skipped', 'locked');
  END IF;

  SELECT cursor_at, done INTO v_from, v_done FROM public.ca_idx_every_seat_state WHERE id FOR UPDATE;
  IF v_done THEN RETURN jsonb_build_object('done', true, 'cursor_at', v_from); END IF;

  LOOP
    EXIT WHEN clock_timestamp() >= v_deadline OR v_from >= v_end;
    v_to := least(v_from + make_interval(mins => greatest(p_minutes, 1)), v_end);
    WITH src AS (
      SELECT h.id, h.created_at, h.players FROM public.hand_history h
      WHERE h.created_at >= v_from AND h.created_at < v_to
    ), expanded AS (
      SELECT DISTINCT ((pl->>'userId')::uuid) AS user_id, s.created_at, s.id AS hand_id
      FROM src s, jsonb_array_elements(coalesce(s.players, '[]'::jsonb)) pl
      WHERE pl->>'userId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND NOT pl->>'userId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ), ins AS (
      INSERT INTO public.ca_hand_player_idx (user_id, created_at, hand_id)
      SELECT user_id, created_at, hand_id FROM expanded
      ON CONFLICT DO NOTHING RETURNING 1
    )
    SELECT (SELECT count(*) FROM src)::int, (SELECT count(*) FROM ins)::int INTO k, kr;
    v_hands := v_hands + coalesce(k, 0);
    v_rows  := v_rows + coalesce(kr, 0);
    v_from  := v_to;
  END LOOP;

  v_done := v_from >= v_end;

  UPDATE public.ca_idx_every_seat_state
  SET cursor_at = v_from, hands_seen = hands_seen + v_hands,
      rows_added = rows_added + v_rows, done = v_done, updated_at = now()
  WHERE id;

  -- The live trigger now indexes every seat, so once the cursor reaches the
  -- present there is nothing left for this to do.
  IF v_done AND EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-stats-idx-every-seat-1m') THEN
    PERFORM cron.unschedule('ca-stats-idx-every-seat-1m');
  END IF;

  RETURN jsonb_build_object('cursor_at', v_from, 'hands_seen', v_hands, 'rows_added', v_rows, 'done', v_done);
END;
$function$;

COMMENT ON FUNCTION public.ca_index_every_seat(integer) IS
  'One-off backfill: index rows in ca_hand_player_idx for seats whose uuid-shaped id the old RFC 4122 regex skipped (synthetic horse ids). Walks retained hand_history forward from ca_idx_every_seat_state.cursor_at in p_minutes windows under a 50 s deadline; unschedules its own cron when it reaches the present. Service role only.';

REVOKE ALL ON FUNCTION public.ca_index_every_seat(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_index_every_seat(integer) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-stats-idx-every-seat-1m') THEN
    PERFORM cron.unschedule('ca-stats-idx-every-seat-1m');
  END IF;
END $$;

SELECT cron.schedule(
  'ca-stats-idx-every-seat-1m',
  '* * * * *',
  $$SELECT set_config('statement_timeout', '58s', true) IS NOT NULL AND public.ca_index_every_seat(60) IS NOT NULL$$
);

-- ────────────────────────────────────────────────────────────────────────────
-- 3. THE AUDIT COUNTS SEATS WITHOUT AN INDEX ROW
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.ca_stats_witness_audit_log
  ADD COLUMN IF NOT EXISTS player_hands_without_idx integer NOT NULL DEFAULT 0;

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
  FROM public.ca_hand_player_facts_range(v_from, v_to, NULL) f
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

  SELECT extract(epoch FROM (now() - idx_ceil))::numeric(12,1) INTO v_idx_lag
  FROM public.ca_hand_player_idx_state WHERE id;
  SELECT done INTO v_repair_done FROM public.ca_hand_player_stat_repair_state WHERE id;

  INSERT INTO public.ca_stats_witness_audit_log (
    window_from, window_to, hands, player_hands, hands_with_posts,
    button_disagree, showdown_disagree, hands_without_stat, player_hands_without_idx,
    human_player_hands, human_without_facts, idx_lag_seconds, repair_done,
    duration_ms
  ) VALUES (
    v_from, v_to, v_hands, v_player_hands, v_with_posts,
    v_button_disagree, v_showdown_disagree, v_without_stat, v_without_idx,
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

REVOKE ALL ON FUNCTION public.ca_stats_witness_audit(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_stats_witness_audit(integer, integer) TO service_role;

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
  seatfill AS (
    SELECT done, cursor_at, rows_added FROM public.ca_idx_every_seat_state WHERE id
  ),
  audit AS (
    SELECT ran_at, hands, button_disagree, showdown_disagree, hands_without_stat,
           player_hands_without_idx, human_player_hands, human_without_facts, duration_ms
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
    'seatBackfill', (SELECT jsonb_build_object('done', done, 'cursorAt', cursor_at, 'rowsAdded', rows_added)
                     FROM seatfill),
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
