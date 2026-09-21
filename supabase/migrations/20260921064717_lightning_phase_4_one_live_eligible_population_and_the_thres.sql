-- 20260921064717_lightning_phase_4_one_live_eligible_population_and_the_thres.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- LIGHTNING 2.0, PHASE 4: POPULATION / LIQUIDITY ENGINE.
--
--     "Create one authoritative function: getLiveEligiblePopulation(cluster,
--     now). ... The exact population predicate must be centralized and unit
--     tested. Do not copy slightly different player-count logic into multiple
--     services."
--
--     "Live eligible players is NOT simply the count of seated rows. The live
--     population calculation must exclude watchers, waitlist-only users,
--     expired disconnects, and players who are otherwise ineligible under the
--     authoritative rules."
--
-- Nothing in this estate counts that. What exists is a BOARD count - how many
-- players are in this game - pinned by tests/one-definition-of-a-games-
-- players.law.test.ts across fn_cash_cluster_census, get_club_home and
-- fn_cash_game_lobby, and it deliberately counts every occupied seat.
--
-- THIS IS A SECOND NUMBER, AND IT IS NOT THE FIRST ONE.
--
-- That law exists because three readers gave three answers to ONE question.
-- This adds a different question with one answer, and the distinction has to
-- be written down or the next reconciliation pass will helpfully merge them:
--
--   THE BOARD COUNT answers "how many players are in this game". It counts a
--   sitting-out player, a busted player in their rebuy window and a player on
--   their way out, because all three are in the game and the lobby must say so.
--
--   THE LIVE ELIGIBLE POPULATION answers "how many players could Lightning
--   deal to right now". It is the input to a threshold, so it counts only
--   players who are economically active and currently able to be dealt in.
--
-- They are different numbers on purpose and they must never be swapped. The
-- board count is untouched by this migration. fn_cash_cluster_population uses
-- the census's own TABLE predicate byte for byte - same tables, same
-- exclusions - and narrows only the SEAT predicate, so the two can never
-- disagree about which tables belong to the game.
--
-- WHAT MAKES A SEAT INELIGIBLE, AND WHY EACH ONE.
--
--   sitting out        table_seats.is_sitting_out. A player who has sat out is
--                      not dealt in. The spec names sit-out as a category.
--   leaving            table_seats.leave_pending. The estate's own must-move
--                      draw already refuses to move such a player
--                      ("NOT WITH NOTHING, NOT WHILE LEAVING", 2026-09-05).
--   busted             coalesce(stack, 0) = 0. Same rule, same line, same
--                      migration: a busted seat is in its rebuy window and
--                      cannot be dealt in until it is funded.
--   no human           user_id IS NULL. An empty chair.
--
-- AND WHAT DOES NOT MAKE A SEAT INELIGIBLE, WHICH MATTERS MORE.
--
--   A HORSE COUNTS EXACTLY LIKE A HUMAN. LAW 10.5, pinned twice in
--   server/src/cluster/TheTablesOpenAndCloseThemselves.law.test.ts - once
--   against the tick's worklist ("a horse's seat counts exactly like a
--   human's here; the EXISTS reads every seat") and once against the balancer
--   ("LAW 10.5: a horse is balanced exactly like a human"), both asserting
--   the SQL does not mention is_horse. The chips are real, the seat is real
--   and the hand is real. This function does not exclude them either; it
--   REPORTS the count in its breakdown, so an operator can see the
--   composition of a threshold crossing without the threshold treating a
--   horse differently from anyone else.
--
--   A PENDING MOVER COUNTS. They are moving WITHIN the cluster, and the
--   estate's own rule is that a move inside a Cluster is not a leave.
--
-- WHAT THIS FUNCTION CANNOT SEE, SAID OUT LOUD RATHER THAN ROUNDED OFF.
--
-- The specification names thirteen categories. Four of them have no
-- representation in PostgreSQL at all, and this function says so in every
-- answer it gives rather than quietly counting as though it knew:
--
--   disconnected        The authority is DisconnectEngine's in-memory FSM
--                       ('CONNECTED' | 'MISSING' | 'DISCONNECTED' | 'SAT_OUT'),
--                       per table, in the leader process, with its timeouts as
--                       TypeScript constants. It reaches Postgres only as
--                       hand_state_snapshots.disconnect_states, a per-hand
--                       blob that is not current between hands and is not
--                       queryable per player per cluster.
--   expired disconnect  The same, one state further on.
--   ghost BB            Nothing anywhere. 20260920235343 declined to store
--                       per-hand player state on purpose, and correctly.
--   watching            live_viewers exists, holds zero rows and is referenced
--                       by no source file in the estate.
--
-- So every answer carries `unknown` and `confidence` beside the `counted`
-- breakdown that IS the known half, and `confidence` reads
-- 'partial' for as long as that list is not empty. A threshold decision built
-- on this number knows exactly which four things it is not accounting for.
-- The seam for closing it is already cut: p_disconnected is a parameter,
-- defaulting to NULL, which the engine will supply in spec Phase 14 (F16,
-- "live eligible population recalculated using authoritative disconnect
-- rules") without this signature changing meaning. Passing it flips
-- confidence to 'engine' and moves 'disconnected' out of the unknown list.
--
-- THE THRESHOLDS ARE CONFIGURATION, AND THE DEFAULTS LIVE IN ONE PLACE.
--
--     "6-max: lightning_on_threshold = 18, lightning_off_threshold = 12.
--      9-max/full-ring: 27 and 18. ... No magic numbers in business logic."
--
-- fn_cash_cluster_lightning_thresholds is that one place. It reads
-- cash_games.ruleset_snapshot -> 'lightning', the jsonb every other cash rule
-- already lives in, and falls back to the mandated defaults keyed off
-- handedness. Every caller asks it; no caller carries a number. The hysteresis
-- rule (ON strictly above OFF) is enforced there rather than trusted, because
-- a configuration that inverted them would oscillate a Cluster every tick.
--
-- ONE PREDICATE, TWO READERS, AND WHY.
--
-- fn_cash_cluster_live_eligible is the predicate: a scalar, two statements.
-- fn_cash_cluster_population is the breakdown, nine statements, and it does
-- not recompute the number - it calls the scalar. fn_cash_cluster_lightning_
-- state reads the scalar, because fn_cash_game_lobby embeds it and a lobby
-- open must not pay for a breakdown nobody asked for; an operator who wants
-- the categories asks fn_cash_cluster_population directly. An earlier cut had
-- the lobby paying all nine, which is the same class of regression the Phase 3
-- remediation went back for (6.13 ms to 13.97 ms on a five-second path).
--
-- p_now IS HONOURED HERE AND NOWHERE ELSE. The breakdown filters the hold
-- expiry by it and echoes it as `as_of`; the scalar has no time predicate at
-- all. A caller who passes a historical p_now therefore gets holds as of
-- that moment and a population as of now, which is harmless while every
-- caller passes clock_timestamp() and would not be if one stopped.
--
-- THE BREAKDOWN IS CATEGORIES, NOT TERMS. sit_out, leaving and busted overlap
-- - a seat that is sitting out with no chips is in both - an empty chair is in
-- none of them, and seated_main plus seated_feeder can fall short of
-- seated_total because public.tables.role is nullable and its CHECK constrains
-- only non-NULL values. The answer says so in a field of its own rather than
-- leaving a reader to discover it by subtracting.
--
-- WHAT THIS DOES NOT DO.
--
-- It converts nothing. cluster_mode is not written, no epoch moves, no player
-- is seated or unseated, and nothing new runs on the tick's hot path. The
-- verdict this phase produces is descriptive - would_turn_on, would_turn_off -
-- and spec Phase 5 is what acts on it. Phase 4's acceptance is exactly that
-- the number and the comparison are right:
--
--     6-max 18 => pending Lightning conversion.   6-max 17 => remain MUST-MOVE.
--     9-max 27 => pending Lightning conversion.   9-max 26 => remain MUST-MOVE.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
--
-- @live-proof: (SELECT to_regproc('public.fn_cash_cluster_live_eligible') IS NOT NULL)
-- @live-proof: (SELECT to_regproc('public.fn_cash_cluster_population') IS NOT NULL)
-- @live-proof: (SELECT to_regproc('public.fn_cash_cluster_lightning_thresholds') IS NOT NULL)
-- @live-proof: (SELECT to_regproc('public.fn_cash_cluster_pool_health') IS NOT NULL)
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.cash_games g WHERE public.fn_cash_cluster_live_eligible(g.id) IS NULL))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.cash_games g WHERE public.fn_cash_cluster_live_eligible(g.id) < 0))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.cash_games g WHERE public.fn_cash_cluster_live_eligible(g.id) > (SELECT coalesce(sum(c.seated), 0) FROM unnest(public.fn_cash_cluster_census(g.id)) c) + (SELECT count(*) FROM public.lightning_pool_session s WHERE s.cluster_id = g.id AND s.exited_at IS NULL)))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.cash_games g WHERE (public.fn_cash_cluster_population(g.id) ->> 'live_eligible')::integer IS DISTINCT FROM public.fn_cash_cluster_live_eligible(g.id)))
-- @live-proof: (SELECT bool_and((public.fn_cash_cluster_lightning_thresholds(g.id) ->> 'on')::integer > (public.fn_cash_cluster_lightning_thresholds(g.id) ->> 'off')::integer) FROM public.cash_games g)
-- @live-proof: (SELECT bool_and(CASE WHEN g.handedness <= 6 THEN (public.fn_cash_cluster_lightning_thresholds(g.id) ->> 'on')::integer = 18 AND (public.fn_cash_cluster_lightning_thresholds(g.id) ->> 'off')::integer = 12 ELSE (public.fn_cash_cluster_lightning_thresholds(g.id) ->> 'on')::integer = 27 AND (public.fn_cash_cluster_lightning_thresholds(g.id) ->> 'off')::integer = 18 END) FROM public.cash_games g WHERE g.ruleset_snapshot -> 'lightning' IS NULL)
-- @live-proof: (SELECT position('horse' in regexp_replace(pg_get_functiondef('public.fn_cash_cluster_live_eligible(uuid,timestamp with time zone,integer)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g')) = 0)
-- @live-proof: (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_population(uuid,timestamp with time zone,integer)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') ~ '''horses'',\s+v_horses')
-- @live-proof: (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_live_eligible(uuid,timestamp with time zone,integer)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') ~ 'ts.user_id IS NOT NULL\s+AND coalesce\(ts.is_sitting_out, false\) = false\s+AND coalesce\(ts.leave_pending, false\) = false\s+AND coalesce\(ts.stack, 0\) > 0')
-- @live-proof: (SELECT (SELECT count(*) FROM regexp_matches(regexp_replace(pg_get_functiondef('public.fn_cash_cluster_population(uuid,timestamp with time zone,integer)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g'), E'tb.status IN \\(''waiting'', ''running'', ''active''\\) AND tb.lifecycle <> ''closed''', 'g')) = 5)
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.cash_games g, LATERAL (SELECT public.fn_cash_cluster_population(g.id) AS p) x WHERE GREATEST(0, (x.p -> 'counted' ->> 'seated_eligible')::integer + (x.p -> 'counted' ->> 'lightning_eligible')::integer - (x.p -> 'counted' ->> 'seated_and_pooled')::integer - (x.p -> 'counted' ->> 'disconnected')::integer) IS DISTINCT FROM (x.p ->> 'live_eligible')::integer))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.cash_games g, LATERAL (SELECT public.fn_cash_cluster_population(g.id, clock_timestamp(), GREATEST(0, public.fn_cash_cluster_live_eligible(g.id) - 1)) AS p) x WHERE GREATEST(0, (x.p -> 'counted' ->> 'seated_eligible')::integer + (x.p -> 'counted' ->> 'lightning_eligible')::integer - (x.p -> 'counted' ->> 'seated_and_pooled')::integer - (x.p -> 'counted' ->> 'disconnected')::integer) IS DISTINCT FROM (x.p ->> 'live_eligible')::integer))
-- @live-proof: (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_live_eligible(uuid,timestamp with time zone,integer)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') ~ 'UNION' AND regexp_replace(pg_get_functiondef('public.fn_cash_cluster_live_eligible(uuid,timestamp with time zone,integer)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') !~ 'UNION ALL' AND regexp_replace(pg_get_functiondef('public.fn_cash_cluster_live_eligible(uuid,timestamp with time zone,integer)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') ~ 'count\(DISTINCT u.player_id\)')
-- @live-proof: (SELECT (public.fn_cash_cluster_population(g.id) ->> 'confidence') = 'partial' AND jsonb_array_length(public.fn_cash_cluster_population(g.id) -> 'unknown') = 4 FROM public.cash_games g LIMIT 1)
-- @live-proof: (SELECT (public.fn_cash_cluster_population(g.id, clock_timestamp(), 0) ->> 'confidence') = 'engine' AND jsonb_array_length(public.fn_cash_cluster_population(g.id, clock_timestamp(), 0) -> 'unknown') = 2 FROM public.cash_games g LIMIT 1)
-- @live-proof: (SELECT position('fn_cash_cluster_live_eligible' in pg_get_functiondef('public.fn_cash_cluster_lightning_state(uuid)'::regprocedure)) > 0 AND position('thresholds' in pg_get_functiondef('public.fn_cash_cluster_lightning_state(uuid)'::regprocedure)) > 0)
-- @live-proof: (SELECT position('fn_cash_cluster_population' in regexp_replace(pg_get_functiondef('public.fn_cash_cluster_lightning_state(uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g')) = 0)
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.cash_games g WHERE (public.fn_cash_cluster_lightning_state(g.id) -> 'verdict' ->> 'would_turn_on')::boolean IS NULL OR (public.fn_cash_cluster_lightning_state(g.id) -> 'verdict' ->> 'to_on')::integer IS DISTINCT FROM GREATEST(0, (public.fn_cash_cluster_lightning_thresholds(g.id) ->> 'on')::integer - public.fn_cash_cluster_live_eligible(g.id))))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM information_schema.role_routine_grants WHERE routine_schema = 'public' AND routine_name IN ('fn_cash_cluster_population','fn_cash_cluster_live_eligible','fn_cash_cluster_lightning_thresholds','fn_cash_cluster_pool_health','fn_cash_cluster_lightning_state') AND grantee IN ('anon','authenticated','PUBLIC')))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.cash_games g WHERE g.cluster_mode <> 'must_move'))

BEGIN;

SET LOCAL lock_timeout = '8s';

-- ===========================================================================
-- 1. THE THRESHOLDS, IN ONE PLACE
-- ===========================================================================
-- Configuration first, mandated defaults second, and the hysteresis rule
-- enforced rather than assumed. `source` says which of the two answered, so a
-- reader can tell a deliberate setting from a default it inherited.

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_lightning_thresholds(p_game_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  g        record;
  v_cfg    jsonb;
  v_on     integer;
  v_off    integer;
  v_source text := 'default';
BEGIN
  SELECT id, handedness, ruleset_snapshot INTO g FROM public.cash_games WHERE id = p_game_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- THE MANDATED DEFAULTS, AND THE ONLY PLACE THEY ARE WRITTEN.
  -- Specification: 6-max ON 18 / OFF 12; 9-max and full ring ON 27 / OFF 18.
  -- handedness is the seats at one table, so 6 and below is the 6-max band.
  IF coalesce(g.handedness, 9) <= 6 THEN
    v_on := 18; v_off := 12;
  ELSE
    v_on := 27; v_off := 18;
  END IF;

  v_cfg := g.ruleset_snapshot -> 'lightning';
  IF jsonb_typeof(v_cfg) = 'object' THEN
    IF jsonb_typeof(v_cfg -> 'on_threshold') = 'number' THEN
      v_on := (v_cfg ->> 'on_threshold')::integer; v_source := 'ruleset';
    END IF;
    IF jsonb_typeof(v_cfg -> 'off_threshold') = 'number' THEN
      v_off := (v_cfg ->> 'off_threshold')::integer; v_source := 'ruleset';
    END IF;
  END IF;

  -- HYSTERESIS IS A RULE, NOT A CONVENTION. "The OFF threshold provides
  -- hysteresis and prevents rapid ON/OFF oscillation." An OFF at or above the
  -- ON would convert a Cluster every tick, forever, in both directions. A
  -- configuration that says so is refused and the defaults answer instead,
  -- because a threshold reader that raises takes the tick down with it.
  IF v_on IS NULL OR v_off IS NULL OR v_on <= v_off OR v_off < 2 THEN
    IF coalesce(g.handedness, 9) <= 6 THEN v_on := 18; v_off := 12; ELSE v_on := 27; v_off := 18; END IF;
    v_source := 'default_after_invalid_config';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'game_id', g.id,
    'handedness', g.handedness,
    'band', CASE WHEN coalesce(g.handedness, 9) <= 6 THEN 'six_max' ELSE 'full_ring' END,
    'on', v_on,
    'off', v_off,
    'source', v_source);
END;
$fn$;

-- service_role only, like every other reader in this family. RLS is on for
-- every relation these functions read, so an INVOKER function run by a browser
-- role would return a SMALLER count rather than an error - a threshold input
-- that is quietly wrong is worse than one that refuses.
REVOKE ALL ON FUNCTION public.fn_cash_cluster_lightning_thresholds(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_lightning_thresholds(uuid) TO service_role;

COMMENT ON FUNCTION public.fn_cash_cluster_lightning_thresholds(uuid) IS
  'The ON and OFF population thresholds for one Cluster: cash_games.ruleset_snapshot -> lightning when it names them, otherwise the mandated defaults keyed off handedness (6-max 18/12, full ring 27/18). The only place those four numbers are written. An inverted or nonsensical configuration is refused in favour of the defaults rather than raised, because this is read on the path a tick takes and a reader that raises takes the tick with it; source says which answered.';

-- ===========================================================================
-- 2. ONE LIVE ELIGIBLE POPULATION - THE NUMBER
-- ===========================================================================
-- Two readers, ONE predicate. This is the predicate: a scalar, two queries,
-- and it is what every other reader in this migration asks for the number.
--
-- WHY IT IS SEPARATE FROM THE BREAKDOWN. fn_cash_cluster_lightning_state is
-- embedded in fn_cash_game_lobby (20260920234647), so anything it calls runs
-- on every lobby open. The breakdown below is nine statements; this is two.
-- Putting the number in its own function keeps the browser path at two extra
-- statements instead of nine, and keeps "one authoritative predicate" literal
-- rather than approximate: the breakdown does not recompute the number, it
-- calls this.
--
-- The table predicate is fn_cash_cluster_census's, byte for byte, so the
-- population and the board can never disagree about which tables belong to the
-- Cluster. Only the seat predicate is narrower, and every narrowing is named
-- in the header above.
--
-- count(DISTINCT user_id), not count(*). The unique index
-- one_committed_seat_per_game_player makes these equal for a cluster table
-- today, so this costs nothing - and the number is documented as a count of
-- PLAYERS, so it is counted as one. The Lightning half was already distinct.

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_live_eligible(
  p_game_id      uuid,
  p_now          timestamptz DEFAULT clock_timestamp(),
  p_disconnected integer DEFAULT NULL)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  -- ONE count(DISTINCT) OVER THE UNION OF BOTH HALVES, not the sum of two
  -- counts. The halves are disjoint while a Cluster is cleanly in one regime,
  -- and they are NOT disjoint in the window a Phase 5 conversion opens - a
  -- player seated with chips whose pool session has already been created is in
  -- both relations at once, and that window is precisely when the threshold is
  -- being read. The guard is doubled on purpose: UNION deduplicates the rows
  -- and count(DISTINCT) deduplicates the count, and mutation testing showed
  -- that either alone still answers correctly on every board this estate can
  -- build. Neither is load-bearing by itself; together they make the double
  -- count unreachable by any single edit.
  --
  -- p_now takes part in nothing here: neither half has a time predicate, and
  -- the parameter exists because the specification names the function
  -- getLiveEligiblePopulation(cluster, now) and a later category may need it.
  -- fn_cash_cluster_population DOES honour it, for the hold expiry.
  SELECT GREATEST(0,
      (SELECT count(DISTINCT u.player_id)::integer
         FROM (
           SELECT ts.user_id AS player_id
             FROM public.table_seats ts
             JOIN public.tables tb ON tb.id = ts.table_id
            WHERE tb.cluster_id = g.id AND coalesce(tb.is_deleted, false) = false
              AND tb.status IN ('waiting', 'running', 'active') AND tb.lifecycle <> 'closed'
              AND ts.left_at IS NULL
              AND ts.user_id IS NOT NULL
              AND coalesce(ts.is_sitting_out, false) = false
              AND coalesce(ts.leave_pending, false) = false
              AND coalesce(ts.stack, 0) > 0
           UNION
           SELECT s.player_id
             FROM public.lightning_pool_session s
            WHERE s.cluster_id = g.id AND s.cluster_epoch = g.cluster_epoch
              AND s.exited_at IS NULL AND s.state = 'active'
         ) u)
    - GREATEST(0, coalesce(p_disconnected, 0)))
    FROM public.cash_games g
   WHERE g.id = p_game_id;
$fn$;

REVOKE ALL ON FUNCTION public.fn_cash_cluster_live_eligible(uuid, timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_live_eligible(uuid, timestamptz, integer) TO service_role;

COMMENT ON FUNCTION public.fn_cash_cluster_live_eligible(uuid, timestamptz, integer) IS
  'The one live eligible population predicate: how many PLAYERS Lightning could deal to in this Cluster right now. Not the board count - that question is "how many players are in this game", it counts a sitting-out, busted or leaving player because all three are in the game, and tests/one-definition-of-a-games-players.law.test.ts pins it across three readers. The table predicate here is fn_cash_cluster_census''s byte for byte; only the seat predicate is narrower. A horse counts exactly like a human (Law 10.5). Two statements, because fn_cash_game_lobby reaches this through fn_cash_cluster_lightning_state on every open; fn_cash_cluster_population adds the breakdown around this number rather than recomputing it.';

-- ===========================================================================
-- 3. THE SAME NUMBER, WITH ITS BREAKDOWN
-- ===========================================================================
-- Everything here exists to explain live_eligible, and live_eligible comes
-- from the function above rather than from a second copy of the predicate.
--
-- THE BREAKDOWN DOES NOT RECONCILE TO THE NUMBER BY ARITHMETIC, and saying so
-- is part of its job. sit_out, leaving and busted OVERLAP - a seat that is
-- sitting out with no chips is in both - and an empty chair is in none of
-- them. seated_total counts occupied chairs only; empty_chairs counts the
-- rest; seated_main plus seated_feeder can be less than seated_total, because
-- public.tables.role is nullable and its CHECK constrains only non-NULL
-- values, so a role-less cluster table's seats belong to neither. These are
-- categories to read, not terms to add up.

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_population(
  p_game_id      uuid,
  p_now          timestamptz DEFAULT clock_timestamp(),
  p_disconnected integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  g              record;
  v_seated       integer := 0;
  v_empty        integer := 0;
  v_eligible     integer := 0;
  v_main         integer := 0;
  v_feeder       integer := 0;
  v_no_role      integer := 0;
  v_sit_out      integer := 0;
  v_leaving      integer := 0;
  v_busted       integer := 0;
  v_horses       integer := 0;
  v_movers       integer := 0;
  v_reserved     integer := 0;
  v_waitlist     integer := 0;
  v_l_total      integer := 0;
  v_l_eligible   integer := 0;
  v_l_idle       integer := 0;
  v_l_instance   integer := 0;
  v_l_hand       integer := 0;
  v_both         integer := 0;
  v_tables       integer := 0;
  v_capacity     integer := 0;
  v_unknown      jsonb;
  v_confidence   text;
  v_disc         integer;
BEGIN
  SELECT id, handedness, cluster_mode, cluster_epoch, lightning_enabled INTO g
    FROM public.cash_games WHERE id = p_game_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- THE TABLES OF THE GAME. fn_cash_cluster_census's predicate, byte for byte.
  SELECT count(*)::integer, coalesce(sum(coalesce(tb.max_players, 9)), 0)::integer
    INTO v_tables, v_capacity
    FROM public.tables tb
   WHERE tb.cluster_id = g.id AND coalesce(tb.is_deleted, false) = false
     AND tb.status IN ('waiting', 'running', 'active') AND tb.lifecycle <> 'closed';

  SELECT
    count(*) FILTER (WHERE ts.user_id IS NOT NULL)::integer,
    count(*) FILTER (WHERE ts.user_id IS NULL)::integer,
    count(*) FILTER (WHERE tb.role = 'main'   AND ts.user_id IS NOT NULL)::integer,
    count(*) FILTER (WHERE tb.role = 'feeder' AND ts.user_id IS NOT NULL)::integer,
    count(*) FILTER (WHERE tb.role IS NULL    AND ts.user_id IS NOT NULL)::integer,
    count(*) FILTER (WHERE ts.user_id IS NOT NULL AND coalesce(ts.is_sitting_out, false))::integer,
    count(*) FILTER (WHERE ts.user_id IS NOT NULL AND coalesce(ts.leave_pending, false))::integer,
    count(*) FILTER (WHERE ts.user_id IS NOT NULL AND coalesce(ts.stack, 0) = 0)::integer,
    count(*) FILTER (WHERE ts.horse_id IS NOT NULL)::integer
    INTO v_seated, v_empty, v_main, v_feeder, v_no_role, v_sit_out, v_leaving, v_busted, v_horses
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = g.id AND coalesce(tb.is_deleted, false) = false
     AND tb.status IN ('waiting', 'running', 'active') AND tb.lifecycle <> 'closed'
     AND ts.left_at IS NULL;

  -- THE TWO HALVES, AND THE OVERLAP BETWEEN THEM. The scalar takes one
  -- count(DISTINCT) over their union; these are the halves separately. The
  -- identity is
  --
  --   GREATEST(0, seated_eligible + lightning_eligible - seated_and_pooled
  --                 - counted.disconnected)  =  live_eligible
  --
  -- and it holds in the conversion window as well as outside it. The
  -- disconnect term is not decoration: the three counted figures subtract
  -- nothing, while live_eligible does, so an identity written without it is
  -- true only on the p_disconnected IS NULL path - which is every path today
  -- and none of them from spec Phase 14 onward, which is exactly when it
  -- becomes load-bearing.
  SELECT count(DISTINCT ts.user_id)::integer INTO v_eligible
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = g.id AND coalesce(tb.is_deleted, false) = false
     AND tb.status IN ('waiting', 'running', 'active') AND tb.lifecycle <> 'closed'
     AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
     AND coalesce(ts.is_sitting_out, false) = false
     AND coalesce(ts.leave_pending, false) = false
     AND coalesce(ts.stack, 0) > 0;

  SELECT count(DISTINCT s.player_id)::integer INTO v_l_eligible
    FROM public.lightning_pool_session s
   WHERE s.cluster_id = g.id AND s.cluster_epoch = g.cluster_epoch
     AND s.exited_at IS NULL AND s.state = 'active';

  SELECT count(*)::integer INTO v_l_total
    FROM public.lightning_pool_session s
   WHERE s.cluster_id = g.id AND s.cluster_epoch = g.cluster_epoch AND s.exited_at IS NULL;

  SELECT count(DISTINCT s.player_id)::integer INTO v_both
    FROM public.lightning_pool_session s
   WHERE s.cluster_id = g.id AND s.cluster_epoch = g.cluster_epoch
     AND s.exited_at IS NULL AND s.state = 'active'
     AND EXISTS (
       SELECT 1 FROM public.table_seats ts
         JOIN public.tables tb ON tb.id = ts.table_id
        WHERE tb.cluster_id = g.id AND coalesce(tb.is_deleted, false) = false
          AND tb.status IN ('waiting', 'running', 'active') AND tb.lifecycle <> 'closed'
          AND ts.left_at IS NULL AND ts.user_id = s.player_id
          AND coalesce(ts.is_sitting_out, false) = false
          AND coalesce(ts.leave_pending, false) = false
          AND coalesce(ts.stack, 0) > 0);

  -- A move inside a Cluster is not a leave, so a pending mover is live. The
  -- count is reported because an operator watching a threshold wants to know
  -- how much of it is mid-flight.
  SELECT count(*)::integer INTO v_movers
    FROM public.cash_seat_moves m
   WHERE m.game_id = g.id AND m.state = 'pending';

  -- A reserved seat is a HOLD, not a player, and it is never added to the
  -- population. The census's table predicate again, so a stale hold on a
  -- closed or deleted table cannot inflate the figure an operator reads as
  -- "seats held on this game's tables".
  SELECT count(*)::integer INTO v_reserved
    FROM public.table_waitlist w
    JOIN public.tables tb ON tb.id = w.table_id
   WHERE tb.cluster_id = g.id AND coalesce(tb.is_deleted, false) = false
     AND tb.status IN ('waiting', 'running', 'active') AND tb.lifecycle <> 'closed'
     AND w.status = 'notified' AND w.hold_expires_at > p_now;

  -- "Waitlist-only does NOT count." Reported so headroom can be read honestly
  -- - a game three short of 18 with nine waiting is a different situation from
  -- one with none - and never added.
  SELECT count(*)::integer INTO v_waitlist
    FROM public.cash_game_waitlist w
   WHERE w.game_id = g.id AND w.status IN ('waiting', 'notified');

  -- THE LIGHTNING SHAPE. Per-hand state is DERIVED from the hold and the
  -- instance it names, never stored: 20260920235343 settled that, because one
  -- column cannot say that a multi-tabling player is in a hand at one table
  -- and idle at another.
  SELECT count(DISTINCT r.player_id)::integer INTO v_l_instance
    FROM public.lightning_reservation r
    JOIN public.lightning_instance i ON i.id = r.lightning_instance_id
    JOIN public.lightning_pool_session s
      ON s.player_id = r.player_id AND s.cluster_id = r.cluster_id
     AND s.cluster_epoch = r.cluster_epoch AND s.exited_at IS NULL AND s.state = 'active'
   WHERE r.cluster_id = g.id AND r.cluster_epoch = g.cluster_epoch
     AND r.state = 'committed'
     AND i.state IN ('forming', 'reserved', 'dealing', 'settling');

  SELECT count(DISTINCT hp.player_id)::integer INTO v_l_hand
    FROM public.lightning_hand_player hp
    JOIN public.lightning_hand h ON h.hand_id = hp.hand_id
   WHERE h.cluster_id = g.id AND h.cluster_epoch = g.cluster_epoch AND h.settled_at IS NULL;

  -- IDLE IS COUNTED, NOT SUBTRACTED. An earlier cut read
  -- GREATEST(0, eligible - in_instance), which subtracts a count of players
  -- holding a seat anywhere in the epoch from a count of ACTIVE pool sessions
  -- - two different populations - and hid the crossing under the floor. A
  -- player who is eligible and is not in an instance is idle, asked directly.
  SELECT count(DISTINCT s.player_id)::integer INTO v_l_idle
    FROM public.lightning_pool_session s
   WHERE s.cluster_id = g.id AND s.cluster_epoch = g.cluster_epoch
     AND s.exited_at IS NULL AND s.state = 'active'
     AND NOT EXISTS (
       SELECT 1 FROM public.lightning_reservation r
         JOIN public.lightning_instance i ON i.id = r.lightning_instance_id
        WHERE r.cluster_id = s.cluster_id AND r.cluster_epoch = s.cluster_epoch
          AND r.player_id = s.player_id AND r.state = 'committed'
          AND i.state IN ('forming', 'reserved', 'dealing', 'settling'));

  -- WHAT IS NOT KNOWN, NAMED. The engine may supply the disconnect count; when
  -- it does, it is subtracted and the answer says so. When it does not, the
  -- list is four long and confidence reads 'partial' - the honest answer at 18
  -- players with two silent clients is that this may be 18 or may be 16.
  IF p_disconnected IS NULL THEN
    v_disc := 0;
    v_unknown := jsonb_build_array('disconnected', 'expired_disconnect', 'ghost_bb', 'watching');
    v_confidence := 'partial';
  ELSE
    v_disc := GREATEST(0, p_disconnected);
    v_unknown := jsonb_build_array('ghost_bb', 'watching');
    v_confidence := 'engine';
  END IF;

  RETURN jsonb_build_object(
    'ok',             true,
    'game_id',        g.id,
    'handedness',     g.handedness,
    'cluster_mode',   g.cluster_mode,
    'cluster_epoch',  g.cluster_epoch,
    'as_of',          p_now,
    -- THE NUMBER, from the one predicate. Everything else explains it.
    'live_eligible',  public.fn_cash_cluster_live_eligible(g.id, p_now, p_disconnected),
    'counted', jsonb_build_object(
      'seated_total',          v_seated,
      'seated_main',           v_main,
      'seated_feeder',         v_feeder,
      'seated_no_role',        v_no_role,
      'seated_eligible',       v_eligible,
      'lightning_total',       v_l_total,
      'lightning_eligible',    v_l_eligible,
      'lightning_idle',        v_l_idle,
      'lightning_in_instance', v_l_instance,
      'lightning_in_hand',     v_l_hand,
      'seated_and_pooled',     v_both,
      'horses',                v_horses,
      'pending_movers',        v_movers,
      'disconnected',          v_disc),
    'excluded', jsonb_build_object(
      'sit_out',       v_sit_out,
      'leaving',       v_leaving,
      'busted',        v_busted,
      'empty_chairs',  v_empty,
      'reserved_seat', v_reserved,
      'waitlist_only', v_waitlist),
    -- These categories OVERLAP and do not sum to anything. Stated in the
    -- answer so a reader cannot mistake them for terms of an equation.
    'breakdown_is_not_arithmetic', true,
    'tables',     v_tables,
    'capacity',   v_capacity,
    'unknown',    v_unknown,
    'confidence', v_confidence);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_cash_cluster_population(uuid, timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_population(uuid, timestamptz, integer) TO service_role;

COMMENT ON FUNCTION public.fn_cash_cluster_population(uuid, timestamptz, integer) IS
  'The live eligible population of a Cluster with its full breakdown. The NUMBER comes from fn_cash_cluster_live_eligible, which is the one predicate; everything else here exists to explain it. The categories deliberately overlap and do not sum: a seat that is sitting out with no chips is counted under both, an empty chair under neither, and seated_main plus seated_feeder can be short of seated_total because public.tables.role is nullable. Nine statements, which is why the lobby reads the scalar and not this.';

-- ===========================================================================
-- 3b. THE ONE READER CARRIES THE VERDICT
-- ===========================================================================
-- fn_cash_cluster_lightning_state is already the Cluster's Lightning reader -
-- fn_cash_game_lobby embeds it, which is how 20260920234647 answered "a reader
-- nothing reads is a reader nothing constrains". So the number, the thresholds
-- and the comparison between them go THERE rather than into a second reader
-- the lobby would have to learn about. It reads the SCALAR, so a lobby open
-- costs two extra statements and not nine; an operator who wants the breakdown
-- asks fn_cash_cluster_population directly.
--
-- The verdict is descriptive and nothing acts on it. would_turn_on is the
-- specification's trigger for MUST_MOVE -> LIGHTNING, spelled with its own
-- `>=`; would_turn_off is the LIGHTNING -> MUST_MOVE condition, spelled with
-- its own `<=`. The asymmetry is the specification's, and it is what makes 12
-- pending-off on a six-max game while 13 is not.
--
-- would_turn_on is gated on enabled and would_turn_off is not, deliberately: a
-- disabled Cluster must not be allowed INTO Lightning, and must always be
-- allowed to drain OUT of it.

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_lightning_state(p_game_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
           'game_id',               g.id,
           'cluster_mode',          g.cluster_mode,
           'cluster_epoch',         g.cluster_epoch,
           'lightning_enabled',     g.lightning_enabled,
           'must_move',             g.must_move,
           'enabled',               g.enabled,
           'handedness',            g.handedness,
           'open_cluster_sessions', (SELECT count(*)
                                       FROM public.cash_player_session s
                                      WHERE s.cluster_id = g.id
                                        AND s.closed_at IS NULL),
           'thresholds',            t.th,
           'verdict', jsonb_build_object(
             'would_turn_on',
               g.lightning_enabled
               AND g.cluster_mode = 'must_move'
               AND coalesce(g.enabled, false)
               AND n.live >= (t.th ->> 'on')::integer,
             'would_turn_off',
               g.cluster_mode = 'lightning'
               AND n.live <= (t.th ->> 'off')::integer,
             'live_eligible', n.live,
             'to_on',  GREATEST(0, (t.th ->> 'on')::integer - n.live),
             'to_off', GREATEST(0, n.live - (t.th ->> 'off')::integer),
             -- No disconnect count reaches this path, so the number here is
             -- always the partial one. fn_cash_cluster_population says the
             -- same in its own answer; spec Phase 14 is what changes it.
             'confidence', 'partial')
         )
    FROM public.cash_games g
    CROSS JOIN LATERAL (SELECT public.fn_cash_cluster_live_eligible(g.id) AS live) n
    CROSS JOIN LATERAL (SELECT public.fn_cash_cluster_lightning_thresholds(g.id) AS th) t
   WHERE g.id = p_game_id;
$function$;

-- Unchanged from what it already held: service_role only. The browser reaches
-- it through fn_cash_game_lobby, which is SECURITY DEFINER and embeds it.
REVOKE ALL ON FUNCTION public.fn_cash_cluster_lightning_state(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_lightning_state(uuid) TO service_role;

COMMENT ON FUNCTION public.fn_cash_cluster_lightning_state(uuid) IS
  'Everything one Cluster''s Lightning state consists of, in the one reader fn_cash_game_lobby already embeds: mode, epoch, capability, the live eligible population, the thresholds it is judged by, and the verdict that comparison produces. It reads the SCALAR predicate, not the breakdown, because it runs on every lobby open. The verdict is descriptive - nothing here converts anything, and spec Phase 5 is what acts on it. ON is >= and OFF is <=, which is the specification''s own asymmetry and what makes 12 pending-off on a six-max game while 13 is not.';

-- ===========================================================================
-- 4. POOL HEALTH
-- ===========================================================================
-- "Implement pool health metrics." What a pool's health IS depends on whether
-- it has one: during MUST_MOVE it is seats and headroom, during LIGHTNING it
-- is also the wait distribution the slots carry. One function answers both and
-- says which regime it answered for, so a dashboard reads one shape.
--
-- Deliberately NOT a stored series. The fourteen existing poker_cluster_*
-- metrics are written by a collector; this is a read, and adding a writer
-- before anything consumes it would be a series nothing reads.

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_pool_health(
  p_game_id uuid,
  p_now     timestamptz DEFAULT clock_timestamp())
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_pop    jsonb;
  v_th     jsonb;
  v_live   integer;
  v_slots  record;
BEGIN
  v_pop := public.fn_cash_cluster_population(p_game_id, p_now);
  IF coalesce((v_pop ->> 'ok')::boolean, false) = false THEN
    RETURN v_pop;
  END IF;
  v_th   := public.fn_cash_cluster_lightning_thresholds(p_game_id);
  v_live := (v_pop ->> 'live_eligible')::integer;

  SELECT count(*)::integer                                            AS open_slots,
         count(DISTINCT s.player_id)::integer                          AS players,
         coalesce(max(s.p95_wait_ms), 0)::integer                      AS p95_wait_ms,
         coalesce(max(s.p99_wait_ms), 0)::integer                      AS p99_wait_ms,
         coalesce(sum(s.hands), 0)::bigint                             AS hands,
         coalesce(sum(s.fast_folds), 0)::bigint                        AS fast_folds
    INTO v_slots
    FROM public.lightning_pool_slot s
    JOIN public.cash_games g ON g.id = s.cluster_id AND g.cluster_epoch = s.cluster_epoch
   WHERE s.cluster_id = p_game_id AND s.closed_at IS NULL;

  RETURN jsonb_build_object(
    'ok',            true,
    'game_id',       p_game_id,
    'as_of',         p_now,
    'regime',        v_pop ->> 'cluster_mode',
    'live_eligible', v_live,
    'thresholds',    v_th,
    'headroom', jsonb_build_object(
      'to_on',  GREATEST(0, (v_th ->> 'on')::integer  - v_live),
      'to_off', GREATEST(0, v_live - (v_th ->> 'off')::integer)),
    'seats', jsonb_build_object(
      'tables',    (v_pop ->> 'tables')::integer,
      'capacity',  (v_pop ->> 'capacity')::integer,
      'occupied',  (v_pop -> 'counted' ->> 'seated_total')::integer,
      'occupancy', CASE WHEN (v_pop ->> 'capacity')::integer > 0
                        THEN round(100.0 * (v_pop -> 'counted' ->> 'seated_total')::integer
                                         / (v_pop ->> 'capacity')::integer, 1)
                        ELSE NULL END),
    'pool', jsonb_build_object(
      'open_slots',  coalesce(v_slots.open_slots, 0),
      'players',     coalesce(v_slots.players, 0),
      'p95_wait_ms', coalesce(v_slots.p95_wait_ms, 0),
      'p99_wait_ms', coalesce(v_slots.p99_wait_ms, 0),
      'hands',       coalesce(v_slots.hands, 0),
      'fast_folds',  coalesce(v_slots.fast_folds, 0)),
    'population',  v_pop,
    'confidence',  v_pop ->> 'confidence');
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_cash_cluster_pool_health(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_pool_health(uuid, timestamptz) TO service_role;

COMMENT ON FUNCTION public.fn_cash_cluster_pool_health(uuid, timestamptz) IS
  'One Cluster''s liquidity in one shape, whichever regime it is in: the live eligible population, the thresholds, the headroom to each, seat occupancy, and - once there is a pool - the slot wait distribution and fold counters. A read rather than a stored series, because nothing consumes it yet and a series nothing reads is a series nothing constrains.';

-- ===========================================================================
-- 5. POST-APPLY READ-BACK FROM THE CATALOGUE
-- ===========================================================================

DO $assert$
DECLARE
  v_th    jsonb;
  v_pop   jsonb;
  v_state jsonb;
  v_id    uuid;
  v_bad   bigint;
BEGIN
  -- THE DEFAULTS ARE THE MANDATED ONES, both bands, read from a real game of
  -- each shape rather than from the source text.
  SELECT id INTO v_id FROM public.cash_games WHERE handedness <= 6 ORDER BY created_at, id LIMIT 1;
  IF v_id IS NOT NULL THEN
    v_th := public.fn_cash_cluster_lightning_thresholds(v_id);
    IF (v_th ->> 'on')::integer IS DISTINCT FROM 18 OR (v_th ->> 'off')::integer IS DISTINCT FROM 12 THEN
      RAISE EXCEPTION 'a six-max cluster reads % / %, not 18 / 12', v_th ->> 'on', v_th ->> 'off';
    END IF;
  END IF;
  SELECT id INTO v_id FROM public.cash_games WHERE handedness > 6 ORDER BY created_at, id LIMIT 1;
  IF v_id IS NOT NULL THEN
    v_th := public.fn_cash_cluster_lightning_thresholds(v_id);
    IF (v_th ->> 'on')::integer IS DISTINCT FROM 27 OR (v_th ->> 'off')::integer IS DISTINCT FROM 18 THEN
      RAISE EXCEPTION 'a full-ring cluster reads % / %, not 27 / 18', v_th ->> 'on', v_th ->> 'off';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cash_games WHERE handedness <= 6)
     OR NOT EXISTS (SELECT 1 FROM public.cash_games WHERE handedness > 6) THEN
    RAISE EXCEPTION 'one of the two handedness bands has no live cluster, so the check above proved half of what it says';
  END IF;

  -- THE POPULATION IS NEVER LARGER THAN WHAT IT COUNTED, for every cluster.
  SELECT count(*) INTO v_bad
    FROM public.cash_games g
    CROSS JOIN LATERAL (SELECT public.fn_cash_cluster_population(g.id) AS p) x
   WHERE (x.p ->> 'live_eligible')::integer
         > (x.p -> 'counted' ->> 'seated_total')::integer + (x.p -> 'counted' ->> 'lightning_total')::integer;
  IF v_bad IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION '% cluster(s) report a live eligible population larger than the rows it was computed from', v_bad;
  END IF;

  -- AND IT IS NEVER LARGER THAN THE BOARD COUNT, which is the whole point of
  -- the narrower predicate. Same table predicate, strictly fewer seats.
  SELECT count(*) INTO v_bad
    FROM public.cash_games g
    CROSS JOIN LATERAL (SELECT public.fn_cash_cluster_population(g.id) AS p) x
    CROSS JOIN LATERAL (SELECT coalesce(sum(c.seated), 0) AS board
                          FROM unnest(public.fn_cash_cluster_census(g.id)) c) b
   WHERE (x.p -> 'counted' ->> 'seated_eligible')::integer > b.board;
  IF v_bad IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION '% cluster(s) report more eligible seats than the board counts seats at all', v_bad;
  END IF;

  -- THE COMPARISON IS EXERCISED AGAINST ARITHMETIC, NOT AGAINST A BOARD. An
  -- earlier cut asserted `to_on = 18` on whichever six-max Cluster LIMIT 1
  -- returned, which holds only if that Cluster has exactly zero eligible
  -- players - a property of the DATA, unordered, that one seated player would
  -- have turned into a refusal to apply. What must be true of the CODE is the
  -- relationship, and it is asked of every Cluster rather than of one.
  SELECT count(*) INTO v_bad
    FROM public.cash_games g
    CROSS JOIN LATERAL (SELECT public.fn_cash_cluster_lightning_state(g.id) AS st) x
    CROSS JOIN LATERAL (SELECT public.fn_cash_cluster_live_eligible(g.id) AS live,
                               (public.fn_cash_cluster_lightning_thresholds(g.id) ->> 'on')::integer AS on_t,
                               (public.fn_cash_cluster_lightning_thresholds(g.id) ->> 'off')::integer AS off_t) y
   WHERE (x.st -> 'verdict' ->> 'live_eligible')::integer IS DISTINCT FROM y.live
      OR (x.st -> 'verdict' ->> 'to_on')::integer  IS DISTINCT FROM GREATEST(0, y.on_t - y.live)
      OR (x.st -> 'verdict' ->> 'to_off')::integer IS DISTINCT FROM GREATEST(0, y.live - y.off_t)
      OR (x.st -> 'verdict' ->> 'would_turn_on')::boolean
         IS DISTINCT FROM (g.lightning_enabled AND g.cluster_mode = 'must_move'
                           AND coalesce(g.enabled, false) AND y.live >= y.on_t);
  IF v_bad IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'the verdict disagrees with its own inputs on % cluster(s)', v_bad;
  END IF;

  SELECT id INTO v_id FROM public.cash_games WHERE handedness <= 6 ORDER BY created_at, id LIMIT 1;
  v_state := public.fn_cash_cluster_lightning_state(v_id);
  IF (v_state ->> 'thresholds') IS NULL OR (v_state -> 'verdict' ->> 'live_eligible') IS NULL THEN
    RAISE EXCEPTION 'the one reader does not carry the thresholds and the number';
  END IF;
  IF (v_state ->> 'handedness') IS NULL OR (v_state ->> 'open_cluster_sessions') IS NULL
     OR (v_state ->> 'cluster_mode') IS NULL OR (v_state ->> 'cluster_epoch') IS NULL
     OR (v_state ->> 'lightning_enabled') IS NULL OR (v_state ->> 'must_move') IS NULL THEN
    RAISE EXCEPTION 'the re-created reader dropped a field the lobby already reads';
  END IF;

  -- And the breakdown's number is the scalar's number, on every Cluster, on
  -- BOTH disconnect paths. The engine path takes its count from the board -
  -- one fewer than the Cluster's own population - so that the four-term
  -- identity is DISCRIMINATING wherever there is a board to discriminate on,
  -- rather than clamping to zero at both ends and proving nothing.
  SELECT count(*) INTO v_bad
    FROM public.cash_games g
   WHERE (public.fn_cash_cluster_population(g.id) ->> 'live_eligible')::integer
         IS DISTINCT FROM public.fn_cash_cluster_live_eligible(g.id)
      OR (public.fn_cash_cluster_population(g.id, clock_timestamp(),
            GREATEST(0, public.fn_cash_cluster_live_eligible(g.id) - 1)) ->> 'live_eligible')::integer
         IS DISTINCT FROM LEAST(1, public.fn_cash_cluster_live_eligible(g.id));
  IF v_bad IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'the breakdown and the predicate disagree on % cluster(s)', v_bad;
  END IF;

  -- HOW MUCH OF THAT WAS REAL. A Cluster with no eligible player clamps both
  -- sides of the identity to zero and proves nothing about the disconnect
  -- term. The count is reported rather than required, because an estate with
  -- an empty board is a legitimate state and refusing to apply there would be
  -- the same mistake as the headcount guard this file already removed - and
  -- because the board that DOES discriminate is built by
  -- scripts/dev/test-lightning-phase4-population.sh, which is where a board
  -- built for a test belongs.
  SELECT count(*) INTO v_bad
    FROM public.cash_games g WHERE public.fn_cash_cluster_live_eligible(g.id) >= 2;
  RAISE NOTICE 'the four-term identity was discriminating on % of % cluster(s); the rest clamp to zero at both ends',
    v_bad, (SELECT count(*) FROM public.cash_games);

  -- NOTHING CONVERTED. Every cluster is still must_move and still at its epoch.
  SELECT count(*) INTO v_bad FROM public.cash_games WHERE cluster_mode <> 'must_move';
  IF v_bad IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION '% cluster(s) left must_move during a phase that converts nothing', v_bad;
  END IF;

  v_pop := public.fn_cash_cluster_population('00000000-0000-0000-0000-000000000000'::uuid);
  IF coalesce((v_pop ->> 'ok')::boolean, true) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'the population invented an answer for a cluster that does not exist';
  END IF;
END $assert$;

COMMIT;
