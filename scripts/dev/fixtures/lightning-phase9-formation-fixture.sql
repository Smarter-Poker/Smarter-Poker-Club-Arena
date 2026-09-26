-- scripts/dev/fixtures/lightning-phase9-formation-fixture.sql
--
-- THE WRITERS scripts/dev/test-lightning-phase9-formation.sh BUILDS ITS ESTATE
-- WITH. They are real bodies and not stubs: fx9_convert does not fake a
-- Lightning Cluster by setting cluster_mode, it drives the REAL
-- fn_cash_cluster_begin_pending_on and the REAL fn_cash_cluster_commit_lightning
-- installed by 20260921151618 and 20260925204249 and RAISES unless the Cluster
-- actually converted - so every hand this harness forms is formed inside an
-- epoch a real conversion opened, over pool sessions a real conversion wrote,
-- against starting_stack values a real conversion copied out of table_seats.
--
-- A Cluster is built through these rather than through fn_cash_cluster_open_table
-- for the reason the Phase 5 harness gives: this contract needs shapes the one
-- cluster writer correctly refuses to make.
--
-- LAW 10.5 IS BUILT IN. fx9_seat takes p_horse, and a horse is seated by
-- setting table_seats.horse_id - the only place in this estate that records
-- one. Nothing downstream of it, in the fixture or in Phase 9, ever reads that
-- column: a horse is a player.

CREATE FUNCTION public.fx9_table(p_game uuid, p_name text, p_role text,
                                 p_main integer, p_cap integer DEFAULT 40)
RETURNS uuid LANGUAGE plpgsql AS $fx$
DECLARE v_tb uuid;
BEGIN
  INSERT INTO public.tables
    (club_id, union_id, name, game_variant, small_blind, big_blind, max_players,
     status, created_by, cluster_id, role, main_index, lifecycle, is_deleted,
     opened_at, live_at, created_at)
  VALUES
    ('cb000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-0000000000f1',
     'P9 ' || p_name, 'nlh', 1.00, 2.00, p_cap, 'waiting',
     '00000000-0000-0000-0000-0000000000aa', p_game, p_role, p_main, 'live', false,
     clock_timestamp(), clock_timestamp(), clock_timestamp())
  RETURNING id INTO v_tb;
  RETURN v_tb;
END $fx$;

CREATE FUNCTION public.fx9_cluster(p_key text, p_handed integer DEFAULT 6,
                                   p_cap integer DEFAULT 40,
                                   p_lightning boolean DEFAULT true)
RETURNS uuid LANGUAGE plpgsql AS $fx$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.cash_games
    (club_id, union_id, name, template_name, variant, sb, bb, handedness,
     ruleset_snapshot, created_by, must_move, lightning_enabled, enabled,
     cluster_mode, cluster_epoch, created_at)
  VALUES
    ('cb000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-0000000000f1',
     'P9 ' || p_key, 'classic', 'nlh', 1.00, 2.00, p_handed, '{"seats": 9}'::jsonb,
     '00000000-0000-0000-0000-0000000000aa', true, p_lightning, true,
     -- BORN must_move AND MOVED LATER. trg_cash_games_epoch_follows_its_game
     -- was written for that order and the conversion sequence uses it.
     'must_move', 0, clock_timestamp())
  RETURNING id INTO v_id;
  PERFORM public.fx9_table(v_id, p_key || ' main1', 'main', 1, p_cap);
  RETURN v_id;
END $fx$;

-- SEATS p_n PLAYERS with an open cluster-scoped cash_player_session each,
-- because the conversion's subordination rule is that a pool session points at
-- a session the player ALREADY had. Every stack is different, so no chip
-- assertion can pass by coincidence of arithmetic.
CREATE FUNCTION public.fx9_seat(p_game uuid, p_n integer, p_from integer DEFAULT 1,
                                p_horse boolean DEFAULT false)
RETURNS uuid[] LANGUAGE plpgsql AS $fx$
DECLARE v_tb uuid; i integer; v_u uuid; v_out uuid[] := ARRAY[]::uuid[];
BEGIN
  SELECT tb.id INTO v_tb FROM public.tables tb
   WHERE tb.cluster_id = p_game AND coalesce(tb.is_deleted, false) = false
     AND coalesce(tb.lifecycle, '') <> 'closed'
   ORDER BY tb.created_at, tb.id LIMIT 1;
  IF v_tb IS NULL THEN RAISE EXCEPTION 'FIXTURE: cluster % has no board to seat on', p_game; END IF;
  FOR i IN p_from .. p_from + p_n - 1 LOOP
    v_u := gen_random_uuid();
    INSERT INTO public.table_seats
      (table_id, user_id, seat_number, stack, is_sitting_out, leave_pending, joined_at, horse_id)
    VALUES (v_tb, v_u, i, 100.00 + i, false, false, clock_timestamp(),
            CASE WHEN p_horse THEN gen_random_uuid() ELSE NULL END);
    INSERT INTO public.cash_player_session
      (player_id, club_id, scope_type, scope_id, table_id, variant, sb, bb, baseline,
       cluster_id, opened_at)
    VALUES (v_u, 'cb000000-0000-0000-0000-000000000001', 'cluster', p_game, v_tb,
            'nlh', 1.00, 2.00, 100.00 + i, p_game, clock_timestamp());
    v_out := v_out || v_u;
  END LOOP;
  RETURN v_out;
END $fx$;

-- THE REAL CONVERSION, END TO END, and a RAISE rather than a return value if it
-- did not happen: a harness that silently ran its whole contract against a
-- must_move Cluster would report green having tested nothing.
CREATE FUNCTION public.fx9_convert(p_game uuid)
RETURNS integer LANGUAGE plpgsql AS $fx$
DECLARE v_req uuid := gen_random_uuid(); v_r jsonb; v_mode text; v_epoch integer;
BEGIN
  v_r := public.fn_cash_cluster_begin_pending_on(p_game, v_req);
  IF coalesce((v_r ->> 'ok')::boolean, false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FIXTURE: begin_pending_on refused cluster %: %', p_game, v_r;
  END IF;
  v_r := public.fn_cash_cluster_commit_lightning(p_game, v_req);
  IF coalesce((v_r ->> 'converted')::boolean, false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FIXTURE: commit_lightning refused cluster %: %', p_game, v_r;
  END IF;
  SELECT cluster_mode, cluster_epoch INTO v_mode, v_epoch FROM public.cash_games WHERE id = p_game;
  IF v_mode IS DISTINCT FROM 'lightning' THEN
    RAISE EXCEPTION 'FIXTURE: cluster % is in % after a conversion that said it converted', p_game, v_mode;
  END IF;
  RETURN v_epoch;
END $fx$;

-- THE POOL, THROUGH PHASE 9'S OWN DOOR. Nothing here inserts a
-- lightning_pool_slot directly; the slots come from fn_lightning_pool_slots_sync,
-- which is the writer under test.
CREATE FUNCTION public.fx9_pool(p_game uuid)
RETURNS jsonb LANGUAGE plpgsql AS $fx$
DECLARE v_r jsonb;
BEGIN
  v_r := public.fn_lightning_pool_slots_sync(p_game);
  IF coalesce((v_r ->> 'ok')::boolean, false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FIXTURE: slots_sync refused cluster %: %', p_game, v_r;
  END IF;
  RETURN v_r;
END $fx$;

-- The open pool of a Cluster, in a deterministic order, as a candidate array.
-- It skips anybody already holding an active reservation, because that is what
-- a matcher looking for somebody to deal in would do - and because a helper
-- that kept offering the same six people would make "the pool keeps dealing"
-- impossible to state. It is deliberately NOT the barrier's legality list: it
-- does not look at the pool session state, the stack or the epoch of the
-- session, so the barrier is still the thing deciding who may play.
CREATE FUNCTION public.fx9_candidates(p_game uuid, p_n integer DEFAULT NULL)
RETURNS uuid[] LANGUAGE sql STABLE AS $fx$
  SELECT coalesce(array_agg(x.player_id ORDER BY x.ord), ARRAY[]::uuid[])
    FROM (SELECT sl.player_id, row_number() OVER (ORDER BY sl.opened_at, sl.player_id) AS ord
            FROM public.lightning_pool_slot sl
            JOIN public.cash_games g ON g.id = sl.cluster_id
           WHERE sl.cluster_id = p_game AND sl.cluster_epoch = g.cluster_epoch
             AND sl.closed_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM public.lightning_reservation r
                              WHERE r.cluster_id = sl.cluster_id AND r.player_id = sl.player_id
                                AND r.state IN ('pending', 'committed'))) x
   WHERE p_n IS NULL OR x.ord <= p_n;
$fx$;

-- A CATCHER THAT IS PROVED TO CATCH. Every "this is refused" assertion in the
-- harness runs through fx9_try, so a fx9_try that silently swallowed nothing
-- would make all of them vacuous; section 00 makes it catch a real division by
-- zero before anything else in the file runs.
CREATE FUNCTION public.fx9_try(p_sql text)
RETURNS text LANGUAGE plpgsql AS $fx$
BEGIN
  EXECUTE p_sql;
  RETURN 'no error';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END $fx$;

CREATE FUNCTION public.fx9_boom() RETURNS text LANGUAGE sql AS $fx$
  SELECT public.fx9_try('SELECT 1/0');
$fx$;

-- A MAINTENANCE BREAK THAT MAKES fn_platform_frozen() ANSWER TRUE, built out of
-- the real engine_maintenance_break row shape rather than by replacing the
-- function, so the freeze the harness tests is the freeze the estate has.
CREATE FUNCTION public.fx9_freeze() RETURNS void LANGUAGE plpgsql AS $fx$
BEGIN
  INSERT INTO public.engine_maintenance_break
    (announced_at, phase, enforce_freeze, break_started_at, break_ends_at)
  VALUES (clock_timestamp() - interval '5 minutes', 'counting_down', true,
          clock_timestamp() - interval '1 minute', clock_timestamp() + interval '5 minutes');
  IF NOT public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'FIXTURE: the break row did not freeze the platform, so every freeze assertion below would be vacuous';
  END IF;
END $fx$;

CREATE FUNCTION public.fx9_thaw() RETURNS void LANGUAGE plpgsql AS $fx$
BEGIN
  DELETE FROM public.engine_maintenance_break WHERE enforce_freeze;
  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'FIXTURE: the platform is still frozen after the break was removed';
  END IF;
END $fx$;

-- EVERY MONEY-BEARING COLUMN OF EVERY ROW A FORMATION COULD PLAUSIBLY TOUCH,
-- ordered, as one md5. A sum is satisfied by a stack that moved and came back,
-- and by two stacks that swapped; this is not.
CREATE FUNCTION public.fx9_money_rows(p_game uuid) RETURNS SETOF text LANGUAGE sql STABLE AS $fx$
  SELECT x.row FROM (
      SELECT 'ts:' || ts.id || ':' || ts.user_id || ':' || coalesce(ts.stack::text, 'null')
             || ':' || coalesce(ts.left_at::text, 'null') AS row
        FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
       WHERE tb.cluster_id = p_game
      UNION ALL
      SELECT 'cps:' || s.id || ':' || s.player_id || ':' || coalesce(s.baseline::text, 'null')
             || ':' || coalesce(s.closed_at::text, 'null')
        FROM public.cash_player_session s WHERE s.cluster_id = p_game
      UNION ALL
      SELECT 'lps:' || ps.id || ':' || ps.player_id || ':' || coalesce(ps.starting_stack::text, 'null')
             || ':' || coalesce(ps.net_result::text, 'null') || ':' || coalesce(ps.ending_stack::text, 'null')
        FROM public.lightning_pool_session ps WHERE ps.cluster_id = p_game
      UNION ALL
      -- THE DEBT COLUMNS AS TOTALS RATHER THAN PER ROW, deliberately. The
      -- barrier CREATES a blind-ledger row for a player who has never had one,
      -- which is role bookkeeping and not money; what must not move is what is
      -- OWED, and a sum over the Cluster catches any write to any of the four
      -- while ignoring a row arriving at nought.
      -- EXPLICITLY CAST, because sum() over an empty set coalesces to an
      -- integer literal and sum() over rows returns numeric(14,2): 'bl:0:0:0:0'
      -- and 'bl:0:0:0.00:0.00' are the same money and different text, and a
      -- measure that changes when nothing moved is a false alarm nobody will
      -- believe the second time.
      SELECT 'bl:' || coalesce(sum(bl.missed_bb_debt), 0)::integer || ':' || coalesce(sum(bl.missed_sb_debt), 0)::integer
             || ':' || coalesce(sum(bl.bb_owed), 0)::numeric(14,2) || ':' || coalesce(sum(bl.sb_owed), 0)::numeric(14,2)
        FROM public.lightning_blind_ledger bl WHERE bl.cluster_id = p_game
    ) x;
$fx$;

CREATE FUNCTION public.fx9_money_md5(p_game uuid) RETURNS text LANGUAGE sql STABLE AS $fx$
  SELECT md5(coalesce(string_agg(r, '|' ORDER BY r), '')) FROM public.fx9_money_rows(p_game) r;
$fx$;

-- The whole lightning row census of a Cluster, as one string, so that "nothing
-- was left behind" is a comparison of every table at once rather than four
-- counts somebody has to remember to add a fifth to.
CREATE FUNCTION public.fx9_residue(p_game uuid) RETURNS text LANGUAGE sql STABLE AS $fx$
  SELECT (SELECT count(*) FROM public.lightning_instance WHERE cluster_id = p_game) || '/'
      || (SELECT count(*) FROM public.lightning_reservation WHERE cluster_id = p_game) || '/'
      || (SELECT count(*) FROM public.lightning_hand WHERE cluster_id = p_game) || '/'
      || (SELECT count(*) FROM public.lightning_hand_player WHERE cluster_id = p_game) || '/'
      || (SELECT md5(coalesce(string_agg(sl.id || ':' || sl.player_id || ':' || sl.slot
           || ':' || coalesce(sl.closed_at::text, 'open') || ':' || coalesce(sl.last_bb_at::text, 'null')
           || ':' || coalesce(sl.last_sb_at::text, 'null') || ':' || sl.hands_since_bb
           || ':' || sl.hands_since_sb, '|' ORDER BY sl.id), ''))
           FROM public.lightning_pool_slot sl WHERE sl.cluster_id = p_game);
$fx$;

-- THE CHIP-MOVER. Section 09 hangs this on lightning_hand_player for exactly
-- one call, to prove the barrier's own LIGHTNING_FORMATION_MOVED_MONEY guard
-- bites. A guard nobody has ever made fire is a guard nobody knows works.
CREATE FUNCTION public.fx9_move_money() RETURNS trigger LANGUAGE plpgsql AS $fx$
BEGIN
  UPDATE public.lightning_pool_session ps
     SET net_result = ps.net_result + 1
   WHERE ps.id = (SELECT sl.pool_session_id FROM public.lightning_pool_slot sl WHERE sl.id = NEW.pool_slot_id);
  RETURN NEW;
END $fx$;
