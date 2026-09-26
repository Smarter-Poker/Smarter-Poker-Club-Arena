-- 20260921142954_lightning_phase_4_remediation_a_threshold_reader_that_never_.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- LIGHTNING 2.0 - PHASE 4 REMEDIATION. An adversarial audit of the merged
-- 20260921064717, run against the live catalogue after it applied, found one
-- blocker and two majors. That file stays as it was applied; this repairs it.
--
-- BLOCKER: THE THRESHOLD READER RAISES, ON THE ONE PATH IT PROMISED NOT TO.
--
-- 20260921064717 guards its configuration read with jsonb_typeof(...) =
-- 'number' and then casts with ::integer. Those two admit different sets. The
-- guard admits EVERY JSON number; the cast accepts only int4. Everything in
-- between raises, and it was measured raising on a throwaway backend carrying
-- the live body:
--
--   {"on_threshold": 18.5}        22P02  invalid input syntax for integer
--   {"on_threshold": 18.0}        22P02  invalid input syntax for integer
--   {"on_threshold": 2147483648}  22003  out of range for type integer
--   {"on_threshold": 1e300}       22003  out of range for type integer
--
-- 18.0 is the one that matters. jsonb preserves the trailing zero - the error
-- text is literally "18.0" - and 18.0 is what to_jsonb(numeric) produces, what
-- a scaled or derived threshold produces, and what any serializer that does
-- not special-case whole floats produces.
--
-- IT DOES NOT STOP AT THE READER. fn_cash_cluster_lightning_state calls it and
-- fn_cash_game_lobby embeds that, and the lobby is SECURITY DEFINER, granted
-- to authenticated, and polled every five seconds while the modal is open. The
-- propagation was traced end to end:
--
--   ERROR:  invalid input syntax for type integer: "18.0"
--   CONTEXT:  PL/pgSQL function fn_cash_cluster_lightning_thresholds(uuid) line 21
--             SQL function "fn_cash_cluster_lightning_state" statement 1
--             PL/pgSQL function fn_cash_game_lobby(uuid) line 2
--
-- One badly-typed configuration value would 500 every lobby open for that
-- Cluster, for every player, until someone edited jsonb by hand. And the
-- function's own COMMENT, installed in production, says the opposite: "refused
-- in favour of the defaults rather than raised, because this is read on the
-- path a tick takes and a reader that raises takes the tick with it".
--
-- Armed, not detonated: 0 of 166 Clusters carry ruleset_snapshot -> 'lightning'
-- today. It arms the moment anyone uses the configuration mechanism, which is
-- the feature's whole purpose.
--
-- The repair is not a wider cast. It is to make the GUARD and the CAST admit
-- the same set: a whole-valued JSON number of at most nine digits. 18.0 is
-- accepted AS 18, because refusing an operator's obviously-correct intent is
-- its own defect; 18.5, 1e300 and 2147483648 fall back to the mandated
-- defaults, which is what the file always said it did.
--
-- MAJOR: THE VERDICT IS BLIND IN THE TWO STATES THAT RE-ASK THE QUESTION.
--
-- would_turn_on required cluster_mode = 'must_move' and would_turn_off
-- required 'lightning'. Both are right for the FIRST time the question is
-- asked and wrong for the second. The specification's own conversion sequence
-- asks it twice:
--
--   ON  step 5  state = PENDING_ON        ON  step 10-11 recalculate; if below
--                                                        the threshold, abort
--   OFF step 2  "LIGHTNING or PENDING_OFF"    step   "if population > OFF
--                                                     threshold, cancel
--                                                     PENDING_OFF"
--
-- So Phase 5 drives a Cluster to pending_on, waits for a conversion-safe hand
-- boundary, and re-reads the verdict - and gets false unconditionally, because
-- the mode is no longer must_move. Every conversion would abort at step 11.
-- The mirror holds for pending_off, where the spec explicitly wants the
-- question re-asked so a recovered population can CANCEL the drain.
--
-- Undetectable today and undetectable by the proof set: all 166 Clusters are
-- must_move, and that file's own last proof asserts it, so nothing in it can
-- discriminate. The harness never built a Cluster in either pending state.
--
-- MAJOR: THE READER COST 3.6 ms OF PURE CALL OVERHEAD, MEASURED.
--
-- 20260921064717 argued its shape was cheap because the lobby "pays two extra
-- statements, not nine". True about statement count and not a cost claim, and
-- nothing measured it. Measured now, warm, per call, on the busiest live
-- Cluster (30 eligible players):
--
--   fn_cash_cluster_live_eligible          0.126 ms
--   fn_cash_cluster_lightning_thresholds   0.025 ms
--   fn_cash_cluster_lightning_state        3.746 ms   <- the two above, nested
--   fn_cash_game_lobby (whole)            15.603 ms
--
-- The children cost 0.15 ms together and their caller costs 3.75 ms, so 3.6 ms
-- is the CROSS JOIN LATERAL into two SQL functions that carry SET search_path
-- and therefore cannot be inlined - a fresh plan per call, per level. That was
-- 24% of every lobby open, for an object nothing reads yet.
--
-- The repair keeps one definition and drops one level of planning:
-- LANGUAGE plpgsql, which caches its statement plans per session, calling each
-- child exactly once into a local. The measurement is repeated in section 4
-- and reported, so the claim is a number and not an argument.
--
-- THE AUDIT WAS WRONG ABOUT ONE THING, AND IT IS WORTH WRITING DOWN.
--
-- It reported that the Lightning harnesses sit in a job that gates nothing,
-- because "Accounting transactions (PostgreSQL 17)" is not itself a required
-- check. It is not - and it does gate one. In .github/workflows/ci.yml the
-- `server` job is `needs: [changes, server_shards, accounting_postgres]`,
-- `if: always()`, named "Server Engine (typecheck + tests)" which IS required,
-- and it exits 1 unless ACCOUNTING_RESULT is success or a skip it can explain.
-- All six Lightning harnesses gate merge today. Line numbers are deliberately
-- not quoted here: wiring this file's own harness moved that job by four lines
-- between writing the paragraph and merging it, which is exactly how a header
-- rots. tests/lightning-phase-4-remediation.ts asserts the FACT instead, by
-- reading the workflow's real `needs` list.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
--
-- @live-proof: (SELECT position('^-?[0-9]{1,9}(\.0+)?$' in regexp_replace(pg_get_functiondef('public.fn_cash_cluster_lightning_thresholds_probe(jsonb,integer)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g')) > 0)
-- @live-proof: (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_lightning_thresholds(uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') ~ 'fn_cash_cluster_lightning_thresholds_probe')
-- @live-proof: (SELECT position('RAISE' in regexp_replace(pg_get_functiondef('public.fn_cash_cluster_lightning_thresholds_probe(jsonb,integer)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g')) = 0)
-- @live-proof: (SELECT (public.fn_cash_cluster_lightning_thresholds_probe('{"on_threshold": 18.0}'::jsonb, 6) ->> 'on')::integer = 18)
-- @live-proof: (SELECT (public.fn_cash_cluster_lightning_thresholds_probe('{"on_threshold": 18.5}'::jsonb, 6) ->> 'on')::integer = 18 AND (public.fn_cash_cluster_lightning_thresholds_probe('{"on_threshold": 18.5}'::jsonb, 6) ->> 'source') = 'default')
-- @live-proof: (SELECT (public.fn_cash_cluster_lightning_thresholds_probe('{"on_threshold": 2147483648}'::jsonb, 6) ->> 'on')::integer = 18)
-- @live-proof: (SELECT (public.fn_cash_cluster_lightning_thresholds_probe('{"on_threshold": 1e300}'::jsonb, 6) ->> 'on')::integer = 18)
-- @live-proof: (SELECT (public.fn_cash_cluster_lightning_thresholds_probe('{"on_threshold": 24, "off_threshold": 16}'::jsonb, 6) ->> 'on')::integer = 24)
-- @live-proof: (SELECT (public.fn_cash_cluster_lightning_thresholds_probe('{"on_threshold": 30, "off_threshold": "12"}'::jsonb, 6) ->> 'source') = 'ruleset_partial')
-- @live-proof: (SELECT (public.fn_cash_cluster_lightning_thresholds_probe('{"on_threshold": 5, "off_threshold": 9}'::jsonb, 6) ->> 'source') = 'default_after_invalid_config')
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.cash_games g WHERE (public.fn_cash_cluster_lightning_thresholds(g.id) ->> 'on')::integer <= (public.fn_cash_cluster_lightning_thresholds(g.id) ->> 'off')::integer))
-- @live-proof: (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_lightning_state(uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') ~ 'cluster_mode IN \(''must_move'', ''pending_on''\)')
-- @live-proof: (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_lightning_state(uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') ~ 'cluster_mode IN \(''lightning'', ''pending_off''\)')
-- @live-proof: (SELECT p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_cash_cluster_lightning_state')
-- @live-proof: (SELECT count(*) = 10 FROM jsonb_object_keys(public.fn_cash_cluster_lightning_state((SELECT id FROM public.cash_games ORDER BY created_at, id LIMIT 1))))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.cash_games g WHERE (public.fn_cash_cluster_lightning_state(g.id) -> 'verdict' ->> 'live_eligible')::integer IS DISTINCT FROM public.fn_cash_cluster_live_eligible(g.id)))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.cash_games g CROSS JOIN LATERAL (SELECT public.fn_cash_cluster_lightning_state(g.id) AS st) x WHERE ((x.st -> 'verdict' ->> 'would_turn_on')::boolean) IS DISTINCT FROM (g.lightning_enabled AND g.cluster_mode IN ('must_move', 'pending_on') AND g.enabled AND public.fn_cash_cluster_live_eligible(g.id) >= (x.st -> 'thresholds' ->> 'on')::integer)))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.cash_games g CROSS JOIN LATERAL (SELECT public.fn_cash_cluster_lightning_state(g.id) AS st) x WHERE ((x.st -> 'verdict' ->> 'would_turn_off')::boolean) IS DISTINCT FROM (g.cluster_mode IN ('lightning', 'pending_off') AND public.fn_cash_cluster_live_eligible(g.id) <= (x.st -> 'thresholds' ->> 'off')::integer)))
-- @live-proof: (SELECT (public.fn_cash_cluster_lightning_thresholds_probe('{"on_threshold": 18.5, "off_threshold": 4}'::jsonb, 6) -> 'rejected') = '["on_threshold"]'::jsonb)
-- @live-proof: (SELECT (public.fn_cash_cluster_lightning_thresholds_probe('{"on_threshold": 24, "off_threshold": 16}'::jsonb, 6) -> 'rejected') = '[]'::jsonb)
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM information_schema.role_routine_grants WHERE routine_schema = 'public' AND routine_name IN ('fn_cash_cluster_lightning_thresholds','fn_cash_cluster_lightning_state','fn_cash_cluster_lightning_thresholds_probe') AND grantee IN ('anon','authenticated','PUBLIC')))

BEGIN;

SET LOCAL lock_timeout = '8s';

-- ===========================================================================
-- 1. THE THRESHOLD RULE BECOMES A PURE FUNCTION
-- ===========================================================================
-- The rule was buried inside a function that needs a Cluster to exist, which
-- is why it was fuzzed with seventeen cases that all missed the one class that
-- raises: a JSON number the guard admits and the cast refuses. A rule that
-- takes a config and a handedness and returns the pair can be fuzzed with any
-- shape at all, from a @live-proof, against production, writing nothing.
--
-- v_int_re is the whole repair. jsonb_typeof(...) = 'number' admits every JSON
-- number; ::integer accepts only int4; the gap between them is where 18.0,
-- 18.5, 1e300 and 2147483648 lived. One regex over the TEXT form makes the
-- guard and the cast admit the same set:
--
--   ^-?[0-9]{1,9}(\.0+)?$
--
-- At most nine digits, so int4 cannot overflow. An optional run of trailing
-- zeros after a point, so 18.0 is accepted AS 18 - because jsonb keeps the
-- zero, to_jsonb(numeric) produces it, and refusing an operator's obviously
-- correct intent is its own defect. 18.5 and 1e300 do not match and fall back
-- to the mandated defaults, which is what the file always claimed it did.

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_lightning_thresholds_probe(
  p_cfg        jsonb,
  p_handedness integer)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_int_re constant text := '^-?[0-9]{1,9}(\.0+)?$';
  v_on      integer;
  v_off     integer;
  v_got_on  boolean := false;
  v_got_off boolean := false;
  v_source  text;
  -- WHICH CONFIGURED VALUES WERE THROWN AWAY, AND THEREFORE WHY THE ANSWER IS
  -- A DEFAULT. Without this a typo is indistinguishable from an empty config:
  -- {"on_threshold": 18.5} answers 18 and reports source 'default', which is
  -- true and useless, because it is also what {} answers. An operator who
  -- fat-fingers a threshold gets no signal at all that it was discarded. A
  -- hysteresis failure already had its own source value; a type failure did
  -- not. This is additive - it takes nothing away from the four sources - and
  -- it is the difference between a silent discard and a reportable one.
  v_rejected jsonb := '[]'::jsonb;
BEGIN
  -- THE MANDATED DEFAULTS, AND THE ONLY PLACE THEY ARE WRITTEN.
  -- Specification: 6-max ON 18 / OFF 12; 9-max and full ring ON 27 / OFF 18.
  -- handedness is the seats at one table. A handedness at or below zero is not
  -- a six-max game, it is a missing value, so it takes the full-ring default
  -- rather than silently landing in the smaller band.
  IF p_handedness IS NULL OR p_handedness <= 0 OR p_handedness > 6 THEN
    v_on := 27; v_off := 18;
  ELSE
    v_on := 18; v_off := 12;
  END IF;

  IF jsonb_typeof(p_cfg) = 'object' THEN
    IF jsonb_typeof(p_cfg -> 'on_threshold') = 'number'
       AND (p_cfg ->> 'on_threshold') ~ v_int_re THEN
      v_on := floor((p_cfg ->> 'on_threshold')::numeric)::integer; v_got_on := true;
    -- Present and unusable is reported. A JSON null is ABSENT, not a typo:
    -- "unset it" is a legitimate thing for a config writer to mean, and
    -- listing it as rejected would cry wolf on every deliberate clear.
    ELSIF p_cfg ? 'on_threshold' AND jsonb_typeof(p_cfg -> 'on_threshold') <> 'null' THEN
      v_rejected := v_rejected || to_jsonb('on_threshold'::text);
    END IF;
    IF jsonb_typeof(p_cfg -> 'off_threshold') = 'number'
       AND (p_cfg ->> 'off_threshold') ~ v_int_re THEN
      v_off := floor((p_cfg ->> 'off_threshold')::numeric)::integer; v_got_off := true;
    ELSIF p_cfg ? 'off_threshold' AND jsonb_typeof(p_cfg -> 'off_threshold') <> 'null' THEN
      v_rejected := v_rejected || to_jsonb('off_threshold'::text);
    END IF;
  END IF;

  -- source IS PER-FIELD NOW. The first cut reported 'ruleset' whenever either
  -- half came from configuration, so an operator who wrote {"on_threshold":
  -- "30", "off_threshold": 5} - a string and a number - was told 'ruleset' for
  -- a pair of 18 and 5, where the 18 was the band default and only the 5 was
  -- theirs. That pair passes the validity guard, so nothing else flagged it.
  v_source := CASE
    WHEN v_got_on AND v_got_off THEN 'ruleset'
    WHEN v_got_on OR  v_got_off THEN 'ruleset_partial'
    ELSE 'default' END;

  -- HYSTERESIS IS A RULE, NOT A CONVENTION. "The OFF threshold provides
  -- hysteresis and prevents rapid ON/OFF oscillation." An OFF at or above the
  -- ON would convert a Cluster every tick, forever, in both directions. A
  -- configuration that says so is refused and the defaults answer instead.
  -- The first cut also tested v_on IS NULL here; both are unconditionally
  -- assigned above and no branch can unset them, so that half was dead, and
  -- reading dead cover as live cover is part of how the blocker survived.
  IF v_on <= v_off OR v_off < 2 THEN
    IF p_handedness IS NULL OR p_handedness <= 0 OR p_handedness > 6 THEN
      v_on := 27; v_off := 18;
    ELSE
      v_on := 18; v_off := 12;
    END IF;
    v_source := 'default_after_invalid_config';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'handedness', p_handedness,
    'band', CASE WHEN p_handedness IS NOT NULL AND p_handedness > 0 AND p_handedness <= 6
                 THEN 'six_max' ELSE 'full_ring' END,
    'on', v_on,
    'off', v_off,
    'source', v_source,
    'rejected', v_rejected);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_cash_cluster_lightning_thresholds_probe(jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_lightning_thresholds_probe(jsonb, integer) TO service_role;

COMMENT ON FUNCTION public.fn_cash_cluster_lightning_thresholds_probe(jsonb, integer) IS
  'The ON/OFF threshold rule as a pure function of a configuration and a handedness, so it can be fuzzed with any shape at all without a Cluster to hang it on. It NEVER raises: the guard and the cast admit the same set, a whole-valued JSON number of at most nine digits, so 18.0 is accepted as 18 while 18.5, 1e300 and 2147483648 fall back to the mandated defaults. The first cut guarded with jsonb_typeof = number and cast with ::integer, which admit different sets, and the gap raised 22P02 all the way up through fn_cash_game_lobby - SECURITY DEFINER, granted to authenticated, polled every five seconds.';

-- The Cluster-shaped reader is now only a row read and a delegation, so there
-- is exactly one copy of the rule and exactly one place the four mandated
-- numbers are written.
CREATE OR REPLACE FUNCTION public.fn_cash_cluster_lightning_thresholds(p_game_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE g record;
BEGIN
  SELECT id, handedness, ruleset_snapshot INTO g FROM public.cash_games WHERE id = p_game_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  RETURN public.fn_cash_cluster_lightning_thresholds_probe(g.ruleset_snapshot -> 'lightning', g.handedness)
         || jsonb_build_object('game_id', g.id);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_cash_cluster_lightning_thresholds(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_lightning_thresholds(uuid) TO service_role;

COMMENT ON FUNCTION public.fn_cash_cluster_lightning_thresholds(uuid) IS
  'The ON and OFF population thresholds for one Cluster. A row read and a delegation to fn_cash_cluster_lightning_thresholds_probe, which carries the whole rule and the only copy of the four mandated numbers. It cannot raise on a badly typed configuration value; the first cut could, all the way up through fn_cash_game_lobby.';

-- ===========================================================================
-- 2. THE VERDICT CAN SEE THE PENDING STATES, AND COSTS ONE PLAN INSTEAD OF THREE
-- ===========================================================================
-- Two repairs in one re-create, because they touch the same body.
--
-- THE STATES. The specification asks the same question twice on the way into
-- Lightning and twice on the way out, and the second asking happens in a
-- PENDING state by construction:
--
--   ON  step  5  state = PENDING_ON
--   ON  step 10  recalculate population
--   ON  step 11  if below the ON threshold, abort and return to MUST_MOVE
--   OFF step  2  verify current state = LIGHTNING or PENDING_OFF
--   OFF          if population rises above the OFF threshold, cancel PENDING_OFF
--
-- A verdict that only answers in must_move and lightning answers false at
-- every one of the second askings, so spec Phase 5 would abort every
-- conversion it ever started. Both filters widen by exactly one state.
--
-- THE COST. LANGUAGE plpgsql rather than sql, calling each child once into a
-- local. Both children carry SET search_path, which disables SQL-function
-- inlining, so the previous shape planned three non-inlinable levels on every
-- call. Measured warm, per call, on the busiest live Cluster before this
-- migration: the two children cost 0.126 ms and 0.025 ms and their caller cost
-- 3.746 ms, so 3.6 ms of a 15.6 ms lobby open was planning overhead alone, for
-- an object nothing reads yet. plpgsql caches its statement plans per session.
-- Section 4 measures it again and reports the number rather than arguing it.
--
-- EVERY FIELD THE PREVIOUS BODY CARRIED IS CARRIED HERE. The lobby embeds this
-- and a re-create that silently dropped one would be invisible until a client
-- read it. Ten keys, asserted by a proof that counts them.

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_lightning_state(p_game_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  g        record;
  v_live   integer;
  v_th     jsonb;
  v_open   integer;
  v_on     integer;
  v_off    integer;
BEGIN
  SELECT id, cluster_mode, cluster_epoch, lightning_enabled, must_move, enabled, handedness
    INTO g FROM public.cash_games WHERE id = p_game_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_live := public.fn_cash_cluster_live_eligible(g.id);
  v_th   := public.fn_cash_cluster_lightning_thresholds(g.id);
  v_on   := (v_th ->> 'on')::integer;
  v_off  := (v_th ->> 'off')::integer;

  SELECT count(*)::integer INTO v_open
    FROM public.cash_player_session s
   WHERE s.cluster_id = g.id AND s.closed_at IS NULL;

  RETURN jsonb_build_object(
    'game_id',               g.id,
    'cluster_mode',          g.cluster_mode,
    'cluster_epoch',         g.cluster_epoch,
    'lightning_enabled',     g.lightning_enabled,
    'must_move',             g.must_move,
    'enabled',               g.enabled,
    'handedness',            g.handedness,
    'open_cluster_sessions', v_open,
    'thresholds',            v_th,
    'verdict', jsonb_build_object(
      -- Trigger, MUST-MOVE -> LIGHTNING. pending_on is admitted because the
      -- specification re-asks this question there, at the conversion-safe hand
      -- boundary, to decide whether to commit or abort.
      'would_turn_on',
        g.lightning_enabled
        AND g.cluster_mode IN ('must_move', 'pending_on')
        -- g.enabled, not coalesce(g.enabled, false): cash_games.enabled is NOT
        -- NULL DEFAULT true, so the coalesce was dead cover, and this file's own
        -- header criticises the first cut for exactly that.
        AND g.enabled
        AND v_live >= v_on,
      -- Trigger, LIGHTNING -> MUST-MOVE. pending_off is admitted for the
      -- mirror reason: a population that recovers during the drain CANCELS it,
      -- and a verdict that cannot answer in pending_off cannot say so.
      --
      -- Not gated on enabled, deliberately and unlike the ON side: a disabled
      -- Cluster must not be allowed INTO Lightning and must always be allowed
      -- to drain OUT of it.
      'would_turn_off',
        g.cluster_mode IN ('lightning', 'pending_off')
        AND v_live <= v_off,
      'live_eligible', v_live,
      'to_on',  GREATEST(0, v_on - v_live),
      'to_off', GREATEST(0, v_live - v_off),
      -- No disconnect count reaches this path, so the number here is always
      -- the partial one. fn_cash_cluster_population says the same in its own
      -- answer; spec Phase 14 is what changes it.
      'confidence', 'partial'));
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_cash_cluster_lightning_state(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_lightning_state(uuid) TO service_role;

COMMENT ON FUNCTION public.fn_cash_cluster_lightning_state(uuid) IS
  'Everything one Cluster''s Lightning state consists of, in the one reader fn_cash_game_lobby already embeds. The verdict is descriptive - nothing here converts anything - and it answers in the PENDING states as well as the settled ones, because the specification re-asks both questions there and a verdict that could not answer would abort every conversion at its own safety re-check. plpgsql rather than sql: both children carry SET search_path and cannot be inlined, and the previous shape planned three levels on every call, which measured 3.6 ms of pure overhead on every lobby open.';

-- ===========================================================================
-- 3. POST-APPLY READ-BACK FROM THE CATALOGUE
-- ===========================================================================

DO $assert$
DECLARE
  v_th  text := regexp_replace(pg_get_functiondef('public.fn_cash_cluster_lightning_thresholds_probe(jsonb,integer)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g');
  v_st  text := regexp_replace(pg_get_functiondef('public.fn_cash_cluster_lightning_state(uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g');
  v_r   jsonb;
  v_bad bigint;
  v_cfg jsonb;
BEGIN
  IF position('^-?[0-9]{1,9}(\.0+)?$' in v_th) = 0 THEN
    RAISE EXCEPTION 'the live threshold rule does not carry the integer pattern that makes its guard and its cast agree';
  END IF;
  IF position('RAISE' in v_th) > 0 THEN
    RAISE EXCEPTION 'the live threshold rule can raise, and it is read on the path a tick takes';
  END IF;

  -- THE BLOCKER, EXERCISED. Each of these raised 22P02 or 22003 against the
  -- previous body; each must now answer the mandated default or the operator's
  -- own whole number, and none may raise.
  FOR v_cfg IN SELECT * FROM unnest(ARRAY[
      '{"on_threshold": 18.0}', '{"on_threshold": 18.5}', '{"on_threshold": 2147483648}',
      '{"on_threshold": -2147483649}', '{"on_threshold": 1e300}', '{"off_threshold": 20.5}',
      '{"on_threshold": 99999999999}', '{"on_threshold": null}', '{"on_threshold": "20"}',
      '{"on_threshold": true}', '{"on_threshold": {"n": 20}}', '{"on_threshold": [20]}',
      'null', '[]', '"x"', '{}'
    ]::jsonb[]) LOOP
    v_r := public.fn_cash_cluster_lightning_thresholds_probe(v_cfg, 6);
    IF (v_r ->> 'on')::integer <= (v_r ->> 'off')::integer THEN
      RAISE EXCEPTION 'the threshold rule returned a non-hysteretic pair for %', v_cfg;
    END IF;
  END LOOP;

  -- 18.0 is ACCEPTED as 18, not refused. It is the shape that matters.
  IF (public.fn_cash_cluster_lightning_thresholds_probe('{"on_threshold": 24.0, "off_threshold": 16.000}'::jsonb, 6) ->> 'on')::integer IS DISTINCT FROM 24
     OR (public.fn_cash_cluster_lightning_thresholds_probe('{"on_threshold": 24.0, "off_threshold": 16.000}'::jsonb, 6) ->> 'off')::integer IS DISTINCT FROM 16
     OR (public.fn_cash_cluster_lightning_thresholds_probe('{"on_threshold": 24.0, "off_threshold": 16.000}'::jsonb, 6) ->> 'source') IS DISTINCT FROM 'ruleset' THEN
    RAISE EXCEPTION 'a whole-valued configuration written with a decimal point was not honoured';
  END IF;
  -- A DISCARDED VALUE IS NAMED. The reason this key exists: 'default' alone
  -- cannot tell an operator apart from an empty configuration.
  IF public.fn_cash_cluster_lightning_thresholds_probe('{"on_threshold": 18.5, "off_threshold": 4}'::jsonb, 6) -> 'rejected'
     IS DISTINCT FROM '["on_threshold"]'::jsonb
     OR public.fn_cash_cluster_lightning_thresholds_probe('{"on_threshold": 24, "off_threshold": 16}'::jsonb, 6) -> 'rejected'
     IS DISTINCT FROM '[]'::jsonb
     OR public.fn_cash_cluster_lightning_thresholds_probe('{"on_threshold": null}'::jsonb, 6) -> 'rejected'
     IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'a discarded configuration value is not being named';
  END IF;
  -- And a half-applied configuration says so rather than claiming 'ruleset'.
  IF (public.fn_cash_cluster_lightning_thresholds_probe('{"on_threshold": 30, "off_threshold": "12"}'::jsonb, 6) ->> 'source') IS DISTINCT FROM 'ruleset_partial' THEN
    RAISE EXCEPTION 'a half-applied configuration still reports itself as fully configured';
  END IF;
  -- Both bands, from the rule itself rather than from a Cluster.
  IF (public.fn_cash_cluster_lightning_thresholds_probe(NULL, 6) ->> 'on')::integer IS DISTINCT FROM 18
     OR (public.fn_cash_cluster_lightning_thresholds_probe(NULL, 9) ->> 'on')::integer IS DISTINCT FROM 27
     OR (public.fn_cash_cluster_lightning_thresholds_probe(NULL, 0) ->> 'on')::integer IS DISTINCT FROM 27 THEN
    RAISE EXCEPTION 'the mandated defaults moved';
  END IF;

  IF v_st !~ 'cluster_mode IN \(''must_move'', ''pending_on''\)'
     OR v_st !~ 'cluster_mode IN \(''lightning'', ''pending_off''\)' THEN
    RAISE EXCEPTION 'the live verdict still cannot answer in the pending states';
  END IF;

  -- EVERY FIELD SURVIVED. Ten keys, and the eight the lobby had before.
  SELECT count(*) INTO v_bad
    FROM public.cash_games g
   WHERE NOT (public.fn_cash_cluster_lightning_state(g.id) ?& ARRAY[
     'game_id','cluster_mode','cluster_epoch','lightning_enabled','must_move',
     'enabled','handedness','open_cluster_sessions','thresholds','verdict']);
  IF v_bad IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'the re-created reader dropped a field on % cluster(s)', v_bad;
  END IF;

  -- AND THE NUMBER DID NOT MOVE, on every Cluster, against the one predicate.
  SELECT count(*) INTO v_bad
    FROM public.cash_games g
   WHERE (public.fn_cash_cluster_lightning_state(g.id) -> 'verdict' ->> 'live_eligible')::integer
         IS DISTINCT FROM public.fn_cash_cluster_live_eligible(g.id)
      OR (public.fn_cash_cluster_lightning_state(g.id) -> 'verdict' ->> 'to_on')::integer
         IS DISTINCT FROM GREATEST(0, (public.fn_cash_cluster_lightning_thresholds(g.id) ->> 'on')::integer
                                      - public.fn_cash_cluster_live_eligible(g.id));
  IF v_bad IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'the re-created verdict disagrees with its own inputs on % cluster(s)', v_bad;
  END IF;

  -- NOTHING CONVERTED.
  SELECT count(*) INTO v_bad FROM public.cash_games WHERE cluster_mode <> 'must_move';
  IF v_bad IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION '% cluster(s) left must_move during a phase that converts nothing', v_bad;
  END IF;
END $assert$;

-- ===========================================================================
-- 4. THE COST, MEASURED RATHER THAN ARGUED
-- ===========================================================================
-- Warm, per call, on whichever live Cluster carries the most players. Reported
-- as a NOTICE rather than asserted, because a timing threshold in a migration
-- is a flake waiting for a busy afternoon - but a cost claim with no number in
-- it is how the previous cut shipped 3.6 ms of planning overhead.

DO $timing$
DECLARE
  gid uuid; i integer; x jsonb; n integer; t0 timestamptz; t1 timestamptz;
  v_state numeric; v_children numeric;
BEGIN
  SELECT g.id INTO gid FROM public.cash_games g
   ORDER BY public.fn_cash_cluster_live_eligible(g.id) DESC, g.id LIMIT 1;
  FOR i IN 1..3 LOOP x := public.fn_cash_cluster_lightning_state(gid); END LOOP;

  t0 := clock_timestamp();
  FOR i IN 1..20 LOOP x := public.fn_cash_cluster_lightning_state(gid); END LOOP;
  t1 := clock_timestamp();
  v_state := round(extract(epoch FROM (t1 - t0)) * 1000 / 20, 3);

  t0 := clock_timestamp();
  FOR i IN 1..20 LOOP
    n := public.fn_cash_cluster_live_eligible(gid);
    x := public.fn_cash_cluster_lightning_thresholds(gid);
  END LOOP;
  t1 := clock_timestamp();
  v_children := round(extract(epoch FROM (t1 - t0)) * 1000 / 20, 3);

  RAISE NOTICE 'lightning state: % ms/call warm, of which its two children are % ms; the previous shape measured 3.746 ms against children of 0.151 ms',
    v_state, v_children;
END $timing$;

COMMIT;
