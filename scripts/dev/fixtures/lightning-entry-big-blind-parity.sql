-- 13 ENTRY BIG BLIND (20261025050528 + 20261025050534), on the real chain.
--
-- Run by scripts/dev/test-lightning-matcher-parity.sh after the current-policy
-- section, on the same rig (pp, lc, harness), with the engine's header set on
-- the session (request.headers x-smarter-lightning-entry-bb: 1, as
-- LightningSupervisor sends it) and the widened blind_role constraint
-- installed, so the entry big blind gate in the plan and the barrier is open. Every hand
-- here is formed by the real fn_lightning_match_and_form and the real barrier,
-- voided by the real abandon door and dealt and settled by the real
-- terminal path; the writes made directly are fixture boundaries, each named:
-- arrivals, and time travel on last_bb_at / idle_since.
--
-- Each pool's plan is captured with its snapshot (pp.out), so the TypeScript
-- port is compared with it, entry_bb included. Horses sit beside humans
-- (every second arrival); nothing here reads a horse marker (CLAUDE.md 10.5).

-- THE PRODUCTION GATES THE BARRIER CALLS (fixture boundary). The preimage
-- fn_lightning_form_hand refuses any Cluster these two do not admit, and this
-- chain predates them (20261016232120, 20261020005222). Their production
-- definitions, read 2026-10-25, verbatim.
CREATE OR REPLACE FUNCTION public.fn_lightning_table_size_allowed(p_handedness integer)
 RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path TO 'pg_catalog'
AS $function$ SELECT coalesce(p_handedness = 6, false) $function$;
CREATE OR REPLACE FUNCTION public.fn_lightning_template_allowed(p_template text, p_rules jsonb)
 RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path TO 'pg_catalog'
AS $function$ SELECT coalesce(p_template IN ('action','madness') AND p_rules->>'template'=p_template,false) $function$;

CREATE FUNCTION pp.entry_pool(p_k text, p_regulars integer, p_newcomers integer) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v_g uuid; i integer;
BEGIN
  -- A converted Cluster thinned to the regulars, who have each been the big
  -- blind (TIME TRAVEL: last_bb_at, staggered, so P2 is strict).
  v_g := lc.build('parity', p_k, 6, p_regulars, 1, 'nlh', '{}'::jsonb);
  INSERT INTO pp.cl (k, game) VALUES (p_k, v_g);
  -- The Lightning template production deals (fixture boundary).
  UPDATE public.cash_games SET template_name = 'action',
         ruleset_snapshot = coalesce(ruleset_snapshot, '{}'::jsonb) || '{"template": "action"}'::jsonb
   WHERE id = v_g;
  UPDATE public.lightning_pool_slot sl
     SET last_bb_at = clock_timestamp() - interval '10 minutes' + (r.rk * interval '1 second'), hands_since_bb = 3
    FROM (SELECT id, row_number() OVER (ORDER BY player_id) AS rk FROM public.lightning_pool_slot
           WHERE cluster_id = v_g AND closed_at IS NULL) r
   WHERE sl.id = r.id;
  -- ARRIVALS (fixture boundary): the newcomers, every second a horse.
  SET CONSTRAINTS ALL DEFERRED;
  FOR i IN 1 .. p_newcomers LOOP PERFORM lc.arrive(v_g, i % 2 = 0); END LOOP;
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM public.fx9_pool(v_g);
  -- TIME TRAVEL: every arrival has waited out the formation deadline.
  UPDATE public.lightning_pool_slot SET opened_at = LEAST(opened_at, clock_timestamp() - interval '4 seconds'),
         idle_since = clock_timestamp() - interval '3 seconds'
   WHERE cluster_id = v_g AND closed_at IS NULL;
  IF (SELECT count(*) FROM public.lightning_pool_slot WHERE cluster_id = v_g AND closed_at IS NULL AND last_bb_at IS NULL) <> p_newcomers
     OR (SELECT count(*) FROM public.lightning_pool_slot WHERE cluster_id = v_g AND closed_at IS NULL) <> p_regulars + p_newcomers THEN
    RAISE EXCEPTION 'FIXTURE %: the pool is not % regulars and % newcomers', p_k, p_regulars, p_newcomers;
  END IF;
  RETURN v_g;
END $f$;

-- The snapshot and the plan (pp.capture), then the plan as the engine's A/A
-- path reads it (fn_lightning_match, with its own snapshot) at the same now.
CREATE FUNCTION pp.capture_entry(p_name text, p_game uuid) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v_plan jsonb; v_match jsonb; v_doc jsonb;
BEGIN
  v_plan := pp.capture(p_name, p_game);
  SELECT doc INTO v_doc FROM pp.out WHERE name = p_name;
  v_match := public.fn_lightning_match(p_game, to_timestamp((v_doc ->> 'now_us')::numeric / 1000000), NULL, NULL, NULL);
  IF (v_match -> 'groups') IS DISTINCT FROM (v_plan -> 'groups') OR (v_match -> 'entry_big_blind') IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'FIXTURE %: the A/A read disagrees with the plan or its gate is closed: % / %', p_name, v_match, v_plan;
  END IF;
  UPDATE pp.out SET doc = jsonb_set(jsonb_set(doc, '{config}', public.fn_lightning_config(p_game)), '{plan}', v_match)
   WHERE name = p_name;
  PERFORM pp.refresh_newcomer((SELECT n FROM pp.out WHERE name = p_name));
  RETURN v_match;
END $f$;

-- Every newcomer a plan seats is its group's big blind or one of its entry
-- big blinds, and an entry poster is never the big blind.
CREATE FUNCTION pp.newcomers_ok(p_game uuid, p jsonb) RETURNS boolean LANGUAGE sql STABLE AS $f$
  SELECT NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p -> 'groups') g, jsonb_array_elements_text(g -> 'players') m(pid)
      JOIN public.lightning_pool_slot sl ON sl.player_id = m.pid::uuid AND sl.cluster_id = p_game AND sl.closed_at IS NULL
     WHERE sl.last_bb_at IS NULL
       AND m.pid <> g ->> 'bb'
       AND NOT (g -> 'entry_bb') ? m.pid)
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p -> 'groups') g WHERE (g -> 'entry_bb') ? (g ->> 'bb'));
$f$;

-- 13A: two newcomers and three regulars. Before this change the second
-- newcomer was dealt the small blind; now they post a live entry big blind
-- and a regular holds the small blind.
DO $$
DECLARE v_g uuid; p jsonb; off jsonb; r jsonb; h jsonb; v_hand uuid; v_inst uuid; v_entry uuid; v_bb uuid;
        v_formed timestamptz; v_ledger integer;
BEGIN
  v_g := pp.entry_pool('ENTRY 2+3', 3, 2);
  -- THE GATE CLOSED (no engine header): exactly the plan before this change.
  PERFORM set_config('request.headers', '', true);
  off := public.fn_lightning_match_plan(v_g, clock_timestamp(), NULL, NULL, NULL, NULL);
  PERFORM set_config('request.headers', '{"x-smarter-lightning-entry-bb":"1"}', true);
  IF (off -> 'entry_big_blind') IS DISTINCT FROM 'false'::jsonb OR pp.ngroups(off) <> 1
     OR (off -> 'groups' -> 0 -> 'entry_bb') IS DISTINCT FROM '[]'::jsonb
     OR NOT EXISTS (SELECT 1 FROM public.lightning_pool_slot sl
                     WHERE sl.cluster_id = v_g AND sl.closed_at IS NULL AND sl.last_bb_at IS NULL
                       AND sl.player_id = (off -> 'groups' -> 0 -> 'keys' -> 'p2' ->> 'sb')::uuid) THEN
    RAISE EXCEPTION 'FAIL 13A: with the gate closed the plan is not the old plan (a newcomer on the small blind): %', off;
  END IF;
  p := pp.capture_entry('entry big blind: two newcomers and three regulars (6-max, 5)', v_g);
  IF pp.ngroups(p) <> 1 OR jsonb_array_length(p -> 'groups' -> 0 -> 'entry_bb') <> 1 OR NOT pp.newcomers_ok(v_g, p)
     OR EXISTS (SELECT 1 FROM public.lightning_pool_slot sl WHERE sl.cluster_id = v_g AND sl.last_bb_at IS NULL
                   AND sl.player_id = (p -> 'groups' -> 0 -> 'keys' -> 'p2' ->> 'sb')::uuid) THEN
    RAISE EXCEPTION 'FAIL 13A: the plan does not seat the second newcomer as an entry big blind beside a regular small blind: %', p;
  END IF;
  v_entry := (p -> 'groups' -> 0 -> 'entry_bb' ->> 0)::uuid;
  v_bb := (p -> 'groups' -> 0 ->> 'bb')::uuid;

  -- THE REAL PASS AND BARRIER.
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(v_g), true);
  r := public.fn_lightning_match_and_form(v_g, clock_timestamp(), NULL, NULL, gen_random_uuid());
  IF coalesce((r ->> 'formed')::integer, 0) <> 1 THEN RAISE EXCEPTION 'FAIL 13A: the pass formed %', r; END IF;
  h := r -> 'hands' -> 0;
  v_hand := (h ->> 'hand_id')::uuid; v_inst := (h ->> 'instance_id')::uuid;
  SELECT formed_at INTO v_formed FROM public.lightning_hand WHERE hand_id = v_hand;
  IF (SELECT blind_role FROM public.lightning_hand_player WHERE hand_id = v_hand AND player_id = v_entry) IS DISTINCT FROM 'entry_bb'
     OR (SELECT player_id FROM public.lightning_hand_player WHERE hand_id = v_hand AND blind_role = 'bb') IS DISTINCT FROM v_bb
     OR (SELECT count(*) FROM public.lightning_hand_player WHERE hand_id = v_hand AND blind_role = 'sb') <> 1
     OR (SELECT seat FROM public.lightning_hand_player WHERE hand_id = v_hand AND blind_role = 'entry_bb') < 3 THEN
    RAISE EXCEPTION 'FAIL 13A: the barrier''s roles: %', (SELECT jsonb_agg(to_jsonb(hp) ORDER BY seat) FROM public.lightning_hand_player hp WHERE hand_id = v_hand);
  END IF;
  -- Stamped like the big blind: no longer a newcomer, the ledger counts it.
  IF (SELECT last_bb_at FROM public.lightning_pool_slot WHERE cluster_id = v_g AND closed_at IS NULL AND player_id = v_entry) IS DISTINCT FROM v_formed
     OR (SELECT hands_since_bb FROM public.lightning_pool_slot WHERE cluster_id = v_g AND closed_at IS NULL AND player_id = v_entry) <> 0
     OR (SELECT last_sb_at FROM public.lightning_pool_slot WHERE cluster_id = v_g AND closed_at IS NULL AND player_id = v_entry) IS NOT NULL
     OR (SELECT bb_count FROM public.lightning_blind_ledger WHERE cluster_id = v_g AND player_id = v_entry) <> 1 THEN
    RAISE EXCEPTION 'FAIL 13A: the entry poster is not stamped like the big blind';
  END IF;

  -- VOIDED BEFORE DEALING: the stamps and the ledger credit come back, so
  -- both are newcomers again (20261024231549, extended to entry_bb).
  PERFORM public.fn_lightning_instance_abandon(v_inst, 'fixture_void_before_deal', clock_timestamp());
  IF (SELECT count(*) FROM public.lightning_pool_slot WHERE cluster_id = v_g AND closed_at IS NULL AND last_bb_at IS NULL) <> 2
     OR (SELECT bb_count FROM public.lightning_blind_ledger WHERE cluster_id = v_g AND player_id = v_entry) <> 0 THEN
    RAISE EXCEPTION 'FAIL 13A: a voided entry post kept its stamp or its ledger credit';
  END IF;

  -- AGAIN, DEALT AND SETTLED by the real terminal path.
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(v_g), true);
  r := public.fn_lightning_match_and_form(v_g, clock_timestamp(), NULL, NULL, gen_random_uuid());
  h := r -> 'hands' -> 0;
  IF (SELECT blind_role FROM public.lightning_hand_player WHERE hand_id = (h ->> 'hand_id')::uuid AND player_id = v_entry) IS DISTINCT FROM 'entry_bb' THEN
    RAISE EXCEPTION 'FAIL 13A: the re-formed hand lost its entry big blind: %', r;
  END IF;
  PERFORM pp.finish(v_g, (h ->> 'instance_id')::uuid, (h ->> 'hand_id')::uuid);
  IF EXISTS (SELECT 1 FROM public.lightning_pool_slot WHERE cluster_id = v_g AND closed_at IS NULL AND last_bb_at IS NULL) THEN
    RAISE EXCEPTION 'FAIL 13A: a dealt entry poster is still a newcomer';
  END IF;
END $$;
\echo '  ok  13A ENTRY BIG BLIND  two newcomers and three regulars: the second newcomer posts a live entry big blind beside a regular small blind (gate closed: the old plan); stamped like the big blind; a void gives the stamp and the ledger credit back; dealt and settled'

-- 13B: a pool of only newcomers. One big blind; everyone else, the small
-- blind seat included, posts an entry big blind, and the small blind is dead.
DO $$
DECLARE v_g uuid; p jsonb; r jsonb; h jsonb; v_hand uuid; v_req uuid := gen_random_uuid(); v_seat1 uuid; replay jsonb;
BEGIN
  v_g := pp.entry_pool('ENTRY 0+6', 0, 6);
  p := pp.capture_entry('entry big blind: a pool of only newcomers (6-max, 6)', v_g);
  IF pp.ngroups(p) <> 1 OR jsonb_array_length(p -> 'groups' -> 0 -> 'entry_bb') <> 5 OR NOT pp.newcomers_ok(v_g, p) THEN
    RAISE EXCEPTION 'FAIL 13B: %', p;
  END IF;
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(v_g), true);
  r := public.fn_lightning_match_and_form(v_g, clock_timestamp(), NULL, NULL, v_req);
  h := r -> 'hands' -> 0;
  v_hand := (h ->> 'hand_id')::uuid;
  SELECT player_id INTO v_seat1 FROM public.lightning_hand_player WHERE hand_id = v_hand AND seat = 1;
  IF (SELECT count(*) FROM public.lightning_hand_player WHERE hand_id = v_hand AND blind_role = 'entry_bb') <> 5
     OR (SELECT count(*) FROM public.lightning_hand_player WHERE hand_id = v_hand AND blind_role = 'sb') <> 0
     OR (SELECT blind_role FROM public.lightning_hand_player WHERE hand_id = v_hand AND seat = 1) IS DISTINCT FROM 'entry_bb'
     OR (SELECT "position" FROM public.lightning_hand_player WHERE hand_id = v_hand AND seat = 1) IS DISTINCT FROM 'sb'
     OR (h ->> 'sb')::uuid IS DISTINCT FROM v_seat1 THEN
    RAISE EXCEPTION 'FAIL 13B: the barrier''s roles: %', (SELECT jsonb_agg(to_jsonb(hp) ORDER BY seat) FROM public.lightning_hand_player hp WHERE hand_id = v_hand);
  END IF;
  -- A replayed formation names seat 1 as the small blind seat.
  replay := public.fn_lightning_form_hand(v_g, ARRAY(SELECT jsonb_array_elements_text(h -> 'players')::uuid),
              p_matcher_version => 'm1', p_request_id => md5(v_req::text || '/matcher_group/1')::uuid);
  IF (replay ->> 'replayed')::boolean IS DISTINCT FROM true OR (replay ->> 'sb')::uuid IS DISTINCT FROM v_seat1 THEN
    RAISE EXCEPTION 'FAIL 13B: the replay does not name seat 1 as the small blind: %', replay;
  END IF;
  -- Nobody's small blind was stamped: none was posted.
  IF EXISTS (SELECT 1 FROM public.lightning_pool_slot WHERE cluster_id = v_g AND closed_at IS NULL AND last_sb_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.lightning_pool_slot WHERE cluster_id = v_g AND closed_at IS NULL AND last_bb_at IS NULL) THEN
    RAISE EXCEPTION 'FAIL 13B: the stamps of a dead small blind hand';
  END IF;
  PERFORM pp.finish(v_g, (h ->> 'instance_id')::uuid, v_hand);
END $$;
\echo '  ok  13B ENTRY BIG BLIND  a pool of only newcomers deals: one big blind, five entry big blinds, the small blind dead in seat 1 (replay names it), nobody stamped for a small blind they did not post; dealt and settled'

-- 13C: the second pass after four newcomers and eight regulars. The first
-- pass deals one hand (the first newcomer the big blind, three newcomers
-- held); the second pass's pool cannot hold them both and keep a hand, so
-- the next newcomer is the big blind and the other two post entry big blinds.
DO $$
DECLARE v_g uuid; p1 jsonb; p2 jsonb; r jsonb;
BEGIN
  v_g := pp.entry_pool('ENTRY 4+8', 8, 4);
  p1 := pp.capture_entry('entry big blind: four newcomers and eight regulars, first pass (6-max, 12)', v_g);
  IF pp.ngroups(p1) <> 1 OR (p1 -> 'groups' -> 0 -> 'entry_bb') <> '[]'::jsonb OR NOT pp.newcomers_ok(v_g, p1)
     OR (SELECT count(*) FROM jsonb_array_elements(p1 -> 'diagnosis') d WHERE d ->> 'reason_code' = 'FIRST_ENTRY_WAITS_FOR_BB') <> 3 THEN
    RAISE EXCEPTION 'FAIL 13C first pass: %', p1;
  END IF;
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(v_g), true);
  r := public.fn_lightning_match_and_form(v_g, clock_timestamp(), NULL, NULL, gen_random_uuid());
  IF coalesce((r ->> 'formed')::integer, 0) <> 1 THEN RAISE EXCEPTION 'FAIL 13C: the first pass formed %', r; END IF;
  p2 := pp.capture_entry('entry big blind: four newcomers and eight regulars, second pass (6-max, 6 free)', v_g);
  IF pp.ngroups(p2) <> 1 OR jsonb_array_length(p2 -> 'groups' -> 0 -> 'entry_bb') <> 2 OR NOT pp.newcomers_ok(v_g, p2) THEN
    RAISE EXCEPTION 'FAIL 13C second pass: %', p2;
  END IF;
  r := public.fn_lightning_match_and_form(v_g, clock_timestamp(), NULL, NULL, gen_random_uuid());
  IF coalesce((r ->> 'formed')::integer, 0) <> 1
     OR (SELECT count(*) FROM public.lightning_hand_player WHERE hand_id = (r -> 'hands' -> 0 ->> 'hand_id')::uuid AND blind_role = 'entry_bb') <> 2 THEN
    RAISE EXCEPTION 'FAIL 13C: the second pass''s barrier: %', r;
  END IF;
END $$;
\echo '  ok  13C ENTRY BIG BLIND  the second pass after four newcomers and eight regulars: the next newcomer is the big blind, the other two post entry big blinds'

-- 13D: a conversion seat with no prior big blind is not a newcomer.
-- Reset only the regulars' blind history (fixture boundary), preserving the
-- actual cash-session / epoch timestamps created by the real conversion.
DO $$
DECLARE v_g uuid; p jsonb; r jsonb; h jsonb; v_new uuid[]; v_conversion uuid[];
BEGIN
  v_g := pp.entry_pool('ENTRY CONVERSION 2+3', 3, 2);
  SELECT array_agg(sl.player_id) FILTER (WHERE cs.opened_at < ep.started_at),
         array_agg(sl.player_id) FILTER (WHERE cs.opened_at >= ep.started_at)
    INTO v_conversion, v_new
    FROM public.lightning_pool_slot sl
    JOIN public.lightning_pool_session ps ON ps.id = sl.pool_session_id
    JOIN public.cash_player_session cs ON cs.id = ps.cash_player_session_id
    JOIN public.cash_cluster_epoch ep ON ep.cluster_id = sl.cluster_id AND ep.epoch = sl.cluster_epoch
   WHERE sl.cluster_id = v_g AND sl.closed_at IS NULL;
  IF cardinality(v_conversion) IS DISTINCT FROM 3 OR cardinality(v_new) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL 13D: expected three actual conversion sessions and two later buy-ins';
  END IF;
  UPDATE public.lightning_pool_slot SET last_bb_at = NULL, hands_since_bb = 0
   WHERE cluster_id = v_g AND closed_at IS NULL AND player_id = ANY(v_conversion);
  p := pp.capture_entry('entry big blind: three unposted conversion seats and two newcomers (6-max, 5)', v_g);
  IF pp.ngroups(p) <> 1 OR jsonb_array_length(p -> 'groups' -> 0 -> 'players') <> 5
     OR jsonb_array_length(p -> 'groups' -> 0 -> 'entry_bb') <> 1
     OR NOT ((p -> 'groups' -> 0 ->> 'bb')::uuid = ANY(v_new))
     OR NOT ((p -> 'groups' -> 0 -> 'entry_bb' ->> 0)::uuid = ANY(v_new))
     OR NOT ((p -> 'groups' -> 0 -> 'keys' -> 'p2' ->> 'sb')::uuid = ANY(v_conversion)) THEN
    RAISE EXCEPTION 'FAIL 13D: the plan charged or held a conversion seat: %', p;
  END IF;
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(v_g), true);
  r := public.fn_lightning_match_and_form(v_g, clock_timestamp(), NULL, NULL, gen_random_uuid());
  IF coalesce((r ->> 'formed')::integer, 0) <> 1 THEN RAISE EXCEPTION 'FAIL 13D: formation %', r; END IF;
  h := r -> 'hands' -> 0;
  IF (SELECT count(*) FROM public.lightning_hand_player WHERE hand_id = (h ->> 'hand_id')::uuid AND blind_role = 'entry_bb') <> 1
     OR EXISTS (SELECT 1 FROM public.lightning_hand_player WHERE hand_id = (h ->> 'hand_id')::uuid
                  AND player_id = ANY(v_conversion) AND blind_role = 'entry_bb') THEN
    RAISE EXCEPTION 'FAIL 13D: the locked barrier charged a conversion seat an entry post';
  END IF;
  PERFORM pp.finish(v_g, (h ->> 'instance_id')::uuid, (h ->> 'hand_id')::uuid);
END $$;
\echo '  ok  13D ENTRY BIG BLIND  three conversion seats without a previous big blind are dealt without entry posts; the two genuine newcomers supply the big blind and one live entry post; real barrier and settlement'
