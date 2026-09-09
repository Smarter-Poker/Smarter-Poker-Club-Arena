\set ON_ERROR_STOP on

\if :{?BOOTSTRAP}

CREATE EXTENSION IF NOT EXISTS dblink;

ALTER TABLE public.hand_projection_outbox
  ADD COLUMN table_id uuid;
ALTER TABLE public.hand_projection_outbox
  ALTER COLUMN table_id SET NOT NULL;

CREATE TABLE public.hand_history (
  id uuid PRIMARY KEY,
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY
);

CREATE TABLE public.player_stats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  club_id uuid NOT NULL,
  hands_dealt integer NOT NULL DEFAULT 0,
  sum_big_blind numeric NOT NULL DEFAULT 0,
  total_winnings numeric NOT NULL DEFAULT 0,
  total_rake numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (user_id, club_id)
);

INSERT INTO public.clubs(id, union_id)
VALUES ('cccccccc-0000-4000-8000-000000000001', NULL);
INSERT INTO public.tables(id, club_id, tournament_id, status)
VALUES (
  'aaaaaaaa-0000-4000-8000-000000000001',
  'cccccccc-0000-4000-8000-000000000001',
  NULL,
  'running'
);
INSERT INTO public.engine_table_leases(
  table_id, instance_id, lease_generation, protocol_version, heartbeat_at
) VALUES (
  'aaaaaaaa-0000-4000-8000-000000000001',
  'lock-order-probe',
  'dddddddd-0000-4000-8000-000000000001',
  2,
  clock_timestamp()
);
INSERT INTO public.profiles(id)
VALUES ('11111111-0000-4000-8000-000000000001');
INSERT INTO public.table_seats(
  table_id, user_id, seat_number, stack,
  time_bank_uses_remaining, time_bank_remaining
) VALUES (
  'aaaaaaaa-0000-4000-8000-000000000001',
  '11111111-0000-4000-8000-000000000001',
  1,
  100,
  1,
  20
);
INSERT INTO public.player_stats(user_id, club_id)
VALUES (
  '11111111-0000-4000-8000-000000000001',
  'cccccccc-0000-4000-8000-000000000001'
);

/* Exact pre-migration projector shape: claim outbox, take projection, touch
   player_stats, then DELETE through the post-commit trigger. */
CREATE OR REPLACE FUNCTION public.fn_project_hand_side_effects(p_hand_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_table_id uuid;
  v_hand_number bigint;
BEGIN
  SELECT o.table_id, o.hand_number
    INTO v_table_id, v_hand_number
    FROM public.hand_projection_outbox o
   WHERE o.hand_id = p_hand_id
   FOR UPDATE OF o;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_pending');
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('hand-projection:' || v_table_id::text, 0)
  );
  IF EXISTS (
    SELECT 1
      FROM public.hand_projection_outbox earlier
     WHERE earlier.table_id = v_table_id
       AND earlier.hand_number < v_hand_number
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'predecessor_pending');
  END IF;

  INSERT INTO public.player_stats(
    user_id, club_id, hands_dealt, sum_big_blind, total_winnings
  ) VALUES (
    '11111111-0000-4000-8000-000000000001',
    'cccccccc-0000-4000-8000-000000000001',
    1,
    2,
    0
  )
  ON CONFLICT (user_id, club_id) DO UPDATE SET
    hands_dealt = player_stats.hands_dealt + 1,
    sum_big_blind = player_stats.sum_big_blind + 2,
    updated_at = clock_timestamp();

  DELETE FROM public.hand_projection_outbox o
   WHERE o.hand_id = p_hand_id;
  RETURN jsonb_build_object('ok', true, 'hand_id', p_hand_id);
END;
$function$;
ALTER FUNCTION public.fn_project_hand_side_effects(uuid) OWNER TO postgres;

/* The old exact-generation settlement fixture now also writes the immutable
   history scope and the full outbox identity consumed by the new wrapper. */
CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement(
  p_table_id uuid,
  p_hand_number bigint,
  p_stacks jsonb,
  p_rake numeric,
  p_bbj numeric,
  p_ref text,
  p_inflow numeric,
  p_hand_row jsonb,
  p_units jsonb,
  p_instance_id text,
  p_lease_generation uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_hand_id uuid;
BEGIN
  SELECT c.hand_id INTO v_hand_id
    FROM public.hand_atomic_commits c
   WHERE c.table_id = p_table_id
     AND c.hand_number = p_hand_number;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'atomic_hand_commit', true,
      'history_id', v_hand_id,
      'replay', true
    );
  END IF;

  v_hand_id := gen_random_uuid();
  INSERT INTO public.hand_atomic_commits(table_id, hand_number, hand_id)
  VALUES (p_table_id, p_hand_number, v_hand_id);
  INSERT INTO public.hand_history(id, table_id, hand_number)
  VALUES (v_hand_id, p_table_id, p_hand_number);
  INSERT INTO public.hand_projection_outbox(hand_id, table_id, hand_number)
  VALUES (v_hand_id, p_table_id, p_hand_number);

  RETURN jsonb_build_object(
    'success', true,
    'atomic_hand_commit', true,
    'history_id', v_hand_id,
    'replay', false
  );
END;
$function$;
ALTER FUNCTION public.fn_ca_commit_hand_settlement(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb, text, uuid
) OWNER TO postgres;

/* The rake leg pauses after owning hand-post-commit but before taking the same
   player_stats row used by the projector. This makes the production wait
   graph deterministic without adding behavior to the migration under test. */
CREATE OR REPLACE FUNCTION public.atomic_distribute_rake(
  p_table_id uuid,
  p_club_id uuid,
  p_hand_id uuid,
  p_hand_number integer,
  p_rake numeric,
  p_bbj numeric DEFAULT 0,
  p_pot numeric DEFAULT NULL,
  p_num_players integer DEFAULT NULL,
  p_contributions jsonb DEFAULT NULL,
  p_tournament_id uuid DEFAULT NULL,
  p_returned_uncalled jsonb DEFAULT NULL,
  p_rake_method text DEFAULT 'DEALT_EQUAL'
) RETURNS TABLE(applied boolean, already_processed boolean, rake_record_id uuid)
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF current_setting('probe.rake_gate', true) = 'on' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('probe-player-stats-gate', 0)
    );
  END IF;

  INSERT INTO public.probe_rake_receipts(hand_id, amount)
  VALUES (p_hand_id, p_rake)
  ON CONFLICT (hand_id) DO NOTHING;
  IF FOUND THEN
    INSERT INTO public.player_stats(user_id, club_id, total_rake)
    VALUES (
      '11111111-0000-4000-8000-000000000001',
      'cccccccc-0000-4000-8000-000000000001',
      p_rake
    )
    ON CONFLICT (user_id, club_id) DO UPDATE SET
      total_rake = player_stats.total_rake + EXCLUDED.total_rake,
      updated_at = clock_timestamp();
    RETURN QUERY SELECT true, false, p_hand_id;
  ELSE
    RETURN QUERY SELECT false, true, p_hand_id;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.probe_commit_lock_order(p_hand_number bigint)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_user constant text := '11111111-0000-4000-8000-000000000001';
  v_club constant text := 'cccccccc-0000-4000-8000-000000000001';
  v_result jsonb;
BEGIN
  v_result := public.fn_ca_commit_hand_settlement(
    'aaaaaaaa-0000-4000-8000-000000000001',
    p_hand_number,
    jsonb_build_array(jsonb_build_object(
      'user_id', v_user,
      'stack', 100,
      'stack_before', 100
    )),
    1,
    0,
    'lock-order:' || p_hand_number::text,
    0,
    jsonb_build_object(
      'pot_size', 10,
      'big_blind', 2,
      '_accepted_post_commit_facts', jsonb_build_object(
        'contributions', jsonb_build_object(v_user, 10),
        'returned_uncalled', '{}'::jsonb,
        'insurance', '[]'::jsonb
      )
    ),
    '[]'::jsonb,
    'lock-order-probe',
    'dddddddd-0000-4000-8000-000000000001',
    jsonb_build_object(
      'version', 1,
      'time_banks', jsonb_build_array(jsonb_build_object(
        'user_id', v_user,
        'uses_remaining', 1,
        'seconds_remaining', 20
      )),
      'rake', jsonb_build_object(
        'club_id', v_club,
        'amount', 1,
        'bbj', 0,
        'pot', 10,
        'num_players', 1,
        'contributions', jsonb_build_object(v_user, 10),
        'returned_uncalled', '{}'::jsonb,
        'tournament_id', NULL,
        'method', 'WEIGHTED_CONTRIBUTED'
      ),
      'bbj_contribution', 'null'::jsonb,
      'promo_playthrough', jsonb_build_array(jsonb_build_object(
        'club_id', v_club,
        'user_id', v_user,
        'wagered', 10
      )),
      'insurance', '[]'::jsonb,
      'pending_addons', jsonb_build_object(
        'enabled', true,
        'max_buy_in', 200
      )
    )
  );
  IF COALESCE((v_result->>'success')::boolean, false) IS NOT TRUE
     OR COALESCE((v_result->>'post_commit_obligations')::boolean, false)
          IS NOT TRUE THEN
    RAISE EXCEPTION 'probe hand did not commit: %', v_result;
  END IF;
  RETURN (v_result->>'history_id')::uuid;
END;
$function$;

CREATE OR REPLACE FUNCTION public.probe_process_with_gate(p_hand_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM set_config('probe.rake_gate', 'on', true);
  RETURN public.fn_ca_process_hand_post_commit_obligations(p_hand_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.probe_wait_for_advisory(
  p_pid integer,
  p_context text
) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_attempt integer;
BEGIN
  FOR v_attempt IN 1..500 LOOP
    IF EXISTS (
      SELECT 1
        FROM pg_stat_activity a
       WHERE a.pid = p_pid
         AND a.wait_event_type = 'Lock'
         AND a.wait_event = 'advisory'
    ) THEN
      RETURN;
    END IF;
    PERFORM pg_sleep(0.01);
  END LOOP;
  RAISE EXCEPTION '% did not reach its advisory wait', p_context;
END;
$function$;

\elif :{?ORIGINAL}

CREATE TEMP TABLE probe_session_pids(label text PRIMARY KEY, pid integer NOT NULL);
CREATE TEMP TABLE probe_hand(id uuid PRIMARY KEY);
INSERT INTO probe_hand SELECT public.probe_commit_lock_order(1000001);

SELECT dblink_connect(
  'post_original',
  format(
    'host=%s port=%s dbname=%s user=postgres',
    current_setting('unix_socket_directories'),
    current_setting('port'),
    current_database()
  )
);
SELECT dblink_connect(
  'project_original',
  format(
    'host=%s port=%s dbname=%s user=postgres',
    current_setting('unix_socket_directories'),
    current_setting('port'),
    current_database()
  )
);
INSERT INTO probe_session_pids
SELECT 'post', pid
  FROM dblink('post_original', 'SELECT pg_backend_pid()') AS x(pid integer);
INSERT INTO probe_session_pids
SELECT 'project', pid
  FROM dblink('project_original', 'SELECT pg_backend_pid()') AS x(pid integer);

SELECT pg_advisory_lock(hashtextextended('probe-player-stats-gate', 0));
SELECT dblink_send_query(
  'post_original',
  format(
    'SELECT public.probe_process_with_gate(%L::uuid)',
    (SELECT id FROM probe_hand)
  )
);
SELECT public.probe_wait_for_advisory(
  (SELECT pid FROM probe_session_pids WHERE label = 'post'),
  'original post-commit session'
);
SELECT dblink_send_query(
  'project_original',
  format(
    'SELECT public.fn_project_hand_side_effects(%L::uuid)',
    (SELECT id FROM probe_hand)
  )
);
SELECT public.probe_wait_for_advisory(
  (SELECT pid FROM probe_session_pids WHERE label = 'project'),
  'original projector session'
);

DO $original_claim_precedes_post_commit$
DECLARE
  v_claimed boolean := false;
BEGIN
  BEGIN
    PERFORM 1
      FROM public.hand_projection_outbox
     WHERE hand_id = (SELECT id FROM probe_hand)
     FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    v_claimed := true;
  END;
  IF NOT v_claimed THEN
    RAISE EXCEPTION 'original projector did not claim the outbox before post-commit';
  END IF;
END;
$original_claim_precedes_post_commit$;

SELECT pg_advisory_unlock(hashtextextended('probe-player-stats-gate', 0));

DO $original_cycle_is_reproduced$
DECLARE
  v_attempt integer;
  v_deadlocks integer := 0;
  v_result jsonb;
BEGIN
  FOR v_attempt IN 1..500 LOOP
    EXIT WHEN dblink_is_busy('post_original') = 0
          AND dblink_is_busy('project_original') = 0;
    PERFORM pg_sleep(0.01);
  END LOOP;
  IF dblink_is_busy('post_original') <> 0
     OR dblink_is_busy('project_original') <> 0 THEN
    RAISE EXCEPTION 'original lock cycle did not resolve';
  END IF;

  BEGIN
    SELECT result INTO v_result
      FROM dblink_get_result('post_original') AS x(result jsonb);
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = '40P01' OR SQLERRM ILIKE '%deadlock detected%' THEN
      v_deadlocks := v_deadlocks + 1;
    ELSE
      RAISE;
    END IF;
  END;
  BEGIN
    SELECT result INTO v_result
      FROM dblink_get_result('project_original') AS x(result jsonb);
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = '40P01' OR SQLERRM ILIKE '%deadlock detected%' THEN
      v_deadlocks := v_deadlocks + 1;
    ELSE
      RAISE;
    END IF;
  END;

  IF v_deadlocks <> 1 THEN
    RAISE EXCEPTION 'expected one original deadlock victim, observed %', v_deadlocks;
  END IF;
END;
$original_cycle_is_reproduced$;

SELECT dblink_disconnect('post_original');
SELECT dblink_disconnect('project_original');

DO $original_hand_is_drained_after_reproduction$
DECLARE
  v_hand_id uuid := (SELECT id FROM probe_hand);
BEGIN
  PERFORM public.fn_ca_process_hand_post_commit_obligations(v_hand_id);
  PERFORM public.fn_project_hand_side_effects(v_hand_id);
  IF EXISTS (
       SELECT 1 FROM public.hand_projection_outbox WHERE hand_id = v_hand_id
     ) OR NOT EXISTS (
       SELECT 1
         FROM public.hand_atomic_commits
        WHERE hand_id = v_hand_id
          AND post_commit_completed_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'original reproduction cleanup did not drain the hand';
  END IF;
END;
$original_hand_is_drained_after_reproduction$;

SELECT 'Original projector/post-commit player_stats deadlock reproduced.' AS result;

\elif :{?FIXED}

CREATE TEMP TABLE probe_session_pids(label text PRIMARY KEY, pid integer NOT NULL);
CREATE TEMP TABLE probe_hand(id uuid PRIMARY KEY);
INSERT INTO probe_hand SELECT public.probe_commit_lock_order(1000002);

SELECT dblink_connect(
  'post_fixed',
  format(
    'host=%s port=%s dbname=%s user=postgres',
    current_setting('unix_socket_directories'),
    current_setting('port'),
    current_database()
  )
);
SELECT dblink_connect(
  'project_fixed',
  format(
    'host=%s port=%s dbname=%s user=postgres',
    current_setting('unix_socket_directories'),
    current_setting('port'),
    current_database()
  )
);
INSERT INTO probe_session_pids
SELECT 'post', pid
  FROM dblink('post_fixed', 'SELECT pg_backend_pid()') AS x(pid integer);
INSERT INTO probe_session_pids
SELECT 'project', pid
  FROM dblink('project_fixed', 'SELECT pg_backend_pid()') AS x(pid integer);

SELECT pg_advisory_lock(hashtextextended('probe-player-stats-gate', 0));
SELECT dblink_send_query(
  'post_fixed',
  format(
    'SELECT public.probe_process_with_gate(%L::uuid)',
    (SELECT id FROM probe_hand)
  )
);
SELECT public.probe_wait_for_advisory(
  (SELECT pid FROM probe_session_pids WHERE label = 'post'),
  'fixed post-commit session'
);
SELECT dblink_send_query(
  'project_fixed',
  format(
    'SELECT public.fn_project_hand_side_effects(%L::uuid)',
    (SELECT id FROM probe_hand)
  )
);
SELECT public.probe_wait_for_advisory(
  (SELECT pid FROM probe_session_pids WHERE label = 'project'),
  'fixed projector session'
);

/* Waiting at hand-post-commit must occur before the exact outbox claim. */
DO $fixed_wait_does_not_claim_outbox$
BEGIN
  PERFORM 1
    FROM public.hand_projection_outbox
   WHERE hand_id = (SELECT id FROM probe_hand)
   FOR UPDATE NOWAIT;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'fixed projector claimed outbox before post-commit completed';
END;
$fixed_wait_does_not_claim_outbox$;

SELECT pg_advisory_unlock(hashtextextended('probe-player-stats-gate', 0));

DO $fixed_schedule_serializes_without_deadlock$
DECLARE
  v_attempt integer;
  v_post jsonb;
  v_project jsonb;
BEGIN
  FOR v_attempt IN 1..500 LOOP
    EXIT WHEN dblink_is_busy('post_fixed') = 0
          AND dblink_is_busy('project_fixed') = 0;
    PERFORM pg_sleep(0.01);
  END LOOP;
  IF dblink_is_busy('post_fixed') <> 0
     OR dblink_is_busy('project_fixed') <> 0 THEN
    RAISE EXCEPTION 'fixed lock schedule did not finish';
  END IF;

  SELECT result INTO STRICT v_post
    FROM dblink_get_result('post_fixed') AS x(result jsonb);
  SELECT result INTO STRICT v_project
    FROM dblink_get_result('project_fixed') AS x(result jsonb);
  IF COALESCE((v_post->>'ok')::boolean, false) IS NOT TRUE
     OR COALESCE((v_project->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'fixed concurrent calls did not both complete: %, %',
      v_post, v_project;
  END IF;
END;
$fixed_schedule_serializes_without_deadlock$;

SELECT dblink_disconnect('post_fixed');
SELECT dblink_disconnect('project_fixed');

DO $fixed_receipts_guards_and_acl_are_exact$
DECLARE
  v_hand_id uuid := (SELECT id FROM probe_hand);
  v_wrapper text := pg_get_functiondef(
    'public.fn_project_hand_side_effects(uuid)'::regprocedure
  );
  v_core text := pg_get_functiondef(
    'public.fn_project_hand_side_effects_after_post_commit_20260908(uuid)'::regprocedure
  );
BEGIN
  IF EXISTS (
       SELECT 1 FROM public.hand_projection_outbox WHERE hand_id = v_hand_id
     ) OR NOT EXISTS (
       SELECT 1
         FROM public.hand_atomic_commits
        WHERE hand_id = v_hand_id
          AND post_commit_completed_at IS NOT NULL
     ) OR (SELECT count(*) FROM public.probe_rake_receipts) <> 2
       OR (SELECT hands_dealt FROM public.player_stats
            WHERE user_id = '11111111-0000-4000-8000-000000000001'
              AND club_id = 'cccccccc-0000-4000-8000-000000000001') <> 2
       OR (SELECT total_rake FROM public.player_stats
            WHERE user_id = '11111111-0000-4000-8000-000000000001'
              AND club_id = 'cccccccc-0000-4000-8000-000000000001') <> 2
       OR position('hand-post-commit:' IN v_wrapper) = 0
       OR position('hand-projection:' IN v_wrapper)
            <= position('hand-post-commit:' IN v_wrapper)
       OR position('FOR UPDATE OF o' IN v_core) = 0
       OR position('predecessor_pending' IN v_core) = 0
       OR position('DELETE FROM public.hand_projection_outbox' IN v_core) = 0
       OR NOT EXISTS (
         SELECT 1
           FROM pg_trigger t
          WHERE t.tgrelid = 'public.hand_projection_outbox'::regclass
            AND t.tgname = 'a0_finish_hand_post_commit_obligations'
            AND NOT t.tgisinternal
       ) OR has_function_privilege(
         'service_role',
         'public.fn_project_hand_side_effects_after_post_commit_20260908(uuid)',
         'EXECUTE'
       ) OR NOT has_function_privilege(
         'service_role',
         'public.fn_project_hand_side_effects(uuid)',
         'EXECUTE'
       ) THEN
    RAISE EXCEPTION 'fixed hand-projection lock-order contract is incomplete';
  END IF;
END;
$fixed_receipts_guards_and_acl_are_exact$;

SELECT 'PostgreSQL 17 hand-projection lock-order regression passed.' AS result;

\else
\echo 'Set exactly one of BOOTSTRAP, ORIGINAL, or FIXED.'
\quit 2
\endif
