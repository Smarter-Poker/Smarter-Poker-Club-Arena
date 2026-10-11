-- Version reserved by scripts/new-migration.mjs; existing Phase13 remains immutable.
-- A worker-off control must follow the asserted drain and return to MUST MOVE.
-- Before/after receipts include worker_mode so the operator can see the result.
-- cash_cluster_events joins the existing server-side Realtime publication.
-- No grants or RLS change: only the engine receives raw records; its club event
-- contains identifiers and event kind only, never raw payloads or cards.
-- @live-proof: (SELECT position('lightning_drain_deadline_at' in prosrc)>0 FROM pg_proc WHERE oid='public.fn_snapshot_maintenance_thaw_targets(timestamp with time zone,numeric)'::regprocedure)
-- @live-proof: (SELECT position('lightning_drain_deadline_at' in prosrc)>0 FROM pg_proc WHERE oid='public.fn_credit_maintenance_thaw_targets(timestamp with time zone,numeric)'::regprocedure)
-- @live-proof: (SELECT position('lightning_drain_deadline_at' in prosrc)>0 FROM pg_proc WHERE oid='public.fn_thaw_platform_checkpointed(timestamp with time zone,numeric,text)'::regprocedure)
-- @live-proof: (SELECT position('drain_before_worker_off' in prosrc) > 0 FROM pg_proc WHERE oid = 'public.fn_lightning_operator_control(uuid,text,text,jsonb)'::regprocedure)
-- @live-proof: public.fn_lightning_operator_state((SELECT id FROM public.cash_games ORDER BY created_at,id LIMIT 1)) ? 'worker_mode'
-- @live-proof: EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'cash_cluster_events')
BEGIN;
SET LOCAL lock_timeout = '2s';
DO $quiescent$
BEGIN
 IF public.fn_platform_frozen() OR EXISTS (SELECT 1 FROM public.engine_maintenance_thaws WHERE contract_version=3 AND NOT coalesce((shifted->>'complete')::boolean,false)) THEN
  RAISE EXCEPTION 'Lightning deadline installation requires a quiescent thaw';
 END IF;
END $quiescent$;
DO $guard$
DECLARE p regprocedure := 'public.fn_lightning_operator_control(uuid,text,text,jsonb)'::regprocedure; actual text;
BEGIN
  SELECT md5(prosrc) INTO actual FROM pg_proc WHERE oid = p;
  IF NOT (SELECT prosecdef = true AND proconfig = ARRAY['search_path=public, pg_temp'] AND pg_get_userbyid(proowner) = 'postgres' AND proacl @> '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'::aclitem[] AND proacl <@ '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'::aclitem[] FROM pg_proc WHERE oid = p) THEN
    RAISE EXCEPTION 'Unexpected fn_lightning_operator_control security configuration';
  END IF;
  IF actual = '71d863c9348ce7e9aa47eac3a36815ab' THEN RETURN; END IF;
  IF actual <> '9e38324baa58701fbcabb0e94dca4749' THEN RAISE EXCEPTION 'Unexpected fn_lightning_operator_control preimage: %', actual; END IF;
  EXECUTE $definition$CREATE OR REPLACE FUNCTION public.fn_lightning_operator_control(
  p_cluster_id uuid, p_action text, p_reason text, p_args jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  c_actions constant text[] := ARRAY['pause', 'resume', 'disable_joins', 'enable_joins', 'drain', 'freeze',
                                     'unfreeze', 'enable_lightning', 'disable_lightning', 'set_matcher_version',
                                     'disable_matcher_version', 'enable_matcher_version', 'rollback_matcher_version',
                                     'set_flag', 'set_worker_mode'];
  c_flags   constant text[] := ARRAY['lightning_v1', 'lightning_fast_fold', 'lightning_fold_watch',
                                     'lightning_multi_table', 'lightning_pool_health', 'lightning_repeat_suppression',
                                     'lightning_session_stats', 'lightning_shadow_matcher', 'lightning_auto_rebuy',
                                     'lightning_adaptive_liquidity'];
  c_known   constant text[] := ARRAY['m1', 'm1-port', 'm2'];
  c_sql     constant text[] := ARRAY['m1'];
  c_uuid    constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_uid      uuid := auth.uid();
  v_service  boolean := coalesce(auth.role(), '') = 'service_role';
  v_action   text := lower(btrim(coalesce(p_action, '')));
  v_reason   text := btrim(coalesce(p_reason, ''));
  v_args     jsonb := CASE WHEN jsonb_typeof(p_args) = 'object' THEN p_args ELSE '{}'::jsonb END;
  v_club     uuid;
  v_actor    uuid;
  v_kind     text;
  v_req      uuid;
  v_prior    record;
  g          record;
  v_op       text;
  v_before   jsonb;
  v_after    jsonb;
  v_cfg      jsonb;
  v_raw      jsonb;
  v_patch    jsonb := '{}'::jsonb;
  v_remove   text[] := ARRAY[]::text[];
  v_detail   jsonb := '{}'::jsonb;
  v_steps    jsonb := '[]'::jsonb;
  v_answer   jsonb;
  v_event    jsonb;
  v_drain    record;
  v_ctl      record;
  v_from     text;
  v_version  text;
  v_role     text;
  v_flag     text;
  v_value    boolean;
  v_live_v   text;
  v_prev     text;
  v_off      text[];
  v_n        integer;
  v_wait     integer;
  v_live     integer;
  v_open     integer;
  v_chips    numeric;
  v_conv     uuid;
  v_id       uuid;
  v_alert    uuid;
  v_alert_err text;
  v_res      jsonb;
  v_safe     jsonb;
  v_timeout  integer;
  i          record;
  st         jsonb;
BEGIN
  -- WHO. Nothing about the Cluster is answered before the gate, not even
  -- whether it exists.
  SELECT cg.club_id INTO v_club FROM public.cash_games cg WHERE cg.id = p_cluster_id;
  IF NOT public.fn_lightning_operator_may_control(v_club) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_AUTHORIZED', 'reason', 'NOT_AUTHORIZED');
  END IF;
  IF NOT (v_action = ANY (c_actions)) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ACTION', 'reason', 'INVALID_ACTION',
                              'actions', to_jsonb(c_actions));
  END IF;
  IF length(v_reason) < 3 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED', 'reason', 'REASON_REQUIRED');
  END IF;
  IF length(v_reason) > 2000 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'reason_too_long');
  END IF;
  IF jsonb_typeof(v_args -> 'request_id') IS DISTINCT FROM 'string' OR NOT ((v_args ->> 'request_id') ~ c_uuid) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'request_id_required');
  END IF;
  v_req := (v_args ->> 'request_id')::uuid;
  -- THE UNFREEZE IS THE PLATFORM'S: a frozen Cluster is evidence.
  IF v_action = 'unfreeze' AND NOT (v_service OR coalesce(public.fn_is_platform_admin(), false)) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_AUTHORIZED', 'reason', 'NOT_AUTHORIZED');
  END IF;
  v_actor := CASE WHEN v_uid IS NOT NULL THEN v_uid
                  WHEN v_service AND jsonb_typeof(v_args -> 'actor_id') = 'string' AND (v_args ->> 'actor_id') ~ c_uuid
                  THEN (v_args ->> 'actor_id')::uuid END;
  v_kind := CASE WHEN v_service THEN 'service'
                 WHEN coalesce(public.fn_is_platform_admin(), false) THEN 'platform_admin'
                 ELSE 'club_control' END;
  v_safe := jsonb_strip_nulls(jsonb_build_object('version', v_args -> 'version', 'role', v_args -> 'role',
                                                 'flag', v_args -> 'flag', 'value', v_args -> 'value',
                                                 'mode', v_args -> 'mode', 'actor_id', v_args -> 'actor_id'));

  -- A REPEATED REQUEST IS ANSWERED, NOT DONE AGAIN.
  SELECT r.cluster_id, r.action, r.answer INTO v_prior
    FROM public.lightning_operator_request r WHERE r.request_id = v_req;
  IF FOUND THEN
    IF v_prior.cluster_id IS DISTINCT FROM p_cluster_id OR v_prior.action IS DISTINCT FROM v_action THEN
      RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'request_id_belongs_to_another_request');
    END IF;
    RETURN v_prior.answer || jsonb_build_object('idempotent', true, 'replayed', true);
  END IF;
  IF v_club IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CLUSTER_NOT_FOUND', 'reason', 'CLUSTER_NOT_FOUND');
  END IF;

  -- THE CLUSTER ROW, the lock every formation, conversion, drain and tick
  -- takes first.
  SELECT * INTO g FROM public.cash_games cg WHERE cg.id = p_cluster_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CLUSTER_NOT_FOUND', 'reason', 'CLUSTER_NOT_FOUND');
  END IF;
  SELECT r.cluster_id, r.action, r.answer INTO v_prior
    FROM public.lightning_operator_request r WHERE r.request_id = v_req;
  IF FOUND THEN
    IF v_prior.cluster_id IS DISTINCT FROM p_cluster_id OR v_prior.action IS DISTINCT FROM v_action THEN
      RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'request_id_belongs_to_another_request');
    END IF;
    RETURN v_prior.answer || jsonb_build_object('idempotent', true, 'replayed', true);
  END IF;

  v_before := public.fn_lightning_operator_state(g.id);
  v_cfg := public.fn_lightning_config(g.id);
  v_raw := CASE WHEN jsonb_typeof(g.ruleset_snapshot -> 'lightning') = 'object'
                THEN g.ruleset_snapshot -> 'lightning' ELSE '{}'::jsonb END;
  SELECT * INTO v_drain FROM public.lightning_cluster_drain x WHERE x.cluster_id = g.id AND x.completed_at IS NULL;
  SELECT * INTO v_ctl FROM public.lightning_cluster_control x WHERE x.cluster_id = g.id;
  v_off := ARRAY(SELECT jsonb_array_elements_text(coalesce(v_cfg -> 'matcher_versions_disabled', '[]'::jsonb)));
  -- THE MODE A PAUSED CLUSTER STANDS FOR: the one it was paused from (a
  -- pause recorded nowhere stands for lightning only if its pool is open).
  v_from := CASE WHEN g.cluster_mode = 'paused' THEN
                   coalesce(v_ctl.paused_from,
                            CASE WHEN EXISTS (SELECT 1 FROM public.lightning_pool_session ps
                                               WHERE ps.cluster_id = g.id AND ps.cluster_epoch = g.cluster_epoch
                                                 AND ps.exited_at IS NULL)
                                 THEN 'lightning' ELSE 'must_move' END)
                 ELSE g.cluster_mode END;
  v_op := v_action;

  <<act>>
  BEGIN
    IF g.cluster_mode = 'frozen' AND v_action NOT IN ('freeze', 'unfreeze') THEN
      v_answer := jsonb_build_object('ok', false, 'code', 'CLUSTER_FROZEN', 'reason', 'CLUSTER_FROZEN',
                                     'recovery', 'unfreeze (a platform admin)');
      EXIT act;
    END IF;
    IF g.cluster_mode = 'dead' THEN
      v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ACTION', 'reason', 'cluster_dead');
      EXIT act;
    END IF;

    IF v_action = 'set_flag' THEN
      v_flag := CASE WHEN jsonb_typeof(v_args -> 'flag') = 'string' THEN v_args ->> 'flag' END;
      IF v_flag IS NULL OR NOT (v_flag = ANY (c_flags)) THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'unknown_flag',
                                       'flags', to_jsonb(c_flags));
        EXIT act;
      END IF;
      IF jsonb_typeof(v_args -> 'value') IS DISTINCT FROM 'boolean' THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'value_must_be_boolean');
        EXIT act;
      END IF;
      v_value := (v_args ->> 'value')::boolean;
      IF v_flag IN ('lightning_pool_health', 'lightning_session_stats') THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'FLAG_NOT_SUPPORTED', 'reason', 'FLAG_NOT_SUPPORTED',
          'flag', v_flag, 'why', 'a read-only player display from the one population and statistics readers; always on, with nothing to protect by a switch');
        EXIT act;
      END IF;
      IF v_flag IN ('lightning_repeat_suppression', 'lightning_adaptive_liquidity') THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'FLAG_NOT_SUPPORTED', 'reason', 'FLAG_NOT_SUPPORTED',
          'flag', v_flag, 'why', 'part of the live matcher (P5 diversity and its population bands); a matcher change goes through a matcher version with shadow evidence first, never a flag');
        EXIT act;
      END IF;
      v_detail := jsonb_build_object('flag', v_flag, 'value', v_value);
      IF v_flag = 'lightning_v1' THEN
        v_op := CASE WHEN v_value THEN 'enable_lightning' ELSE 'disable_lightning' END;
        v_detail := v_detail || jsonb_build_object('performed', v_op);
      END IF;
    END IF;

    IF v_op = 'pause' THEN
      IF g.cluster_mode = 'paused' THEN
        v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
      END IF;
      IF v_drain.id IS NOT NULL OR g.cluster_mode IN ('pending_on', 'pending_off', 'draining') THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'CLUSTER_BUSY', 'reason', 'CLUSTER_BUSY',
                                       'cluster_mode', g.cluster_mode, 'drain_id', v_drain.id);
        EXIT act;
      END IF;
      IF g.cluster_mode NOT IN ('lightning', 'must_move') THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ACTION', 'reason', 'not_pausable_from_' || g.cluster_mode);
        EXIT act;
      END IF;
      v_n := 0;
      IF g.cluster_mode = 'lightning' THEN
        -- HOLD NEW HANDS AT THE BOUNDARY: a formation not yet dealt is void
        -- (nothing was dealt, no chip moves); a hand already dealing plays
        -- out and settles.
        FOR i IN
          SELECT li.id FROM public.lightning_instance li
           WHERE li.cluster_id = g.id AND li.state IN ('forming', 'reserved')
           ORDER BY li.id
           FOR UPDATE
        LOOP
          PERFORM public.fn_lightning_instance_abandon(i.id,
            'lightning paused by an operator: a hand not yet dealt is void; nothing was dealt and no chip moved',
            clock_timestamp());
          v_n := v_n + 1;
        END LOOP;
      END IF;
      UPDATE public.cash_games SET cluster_mode = 'paused', updated_at = now() WHERE id = g.id;
      INSERT INTO public.lightning_cluster_control AS c
             (cluster_id, paused_from, paused_at, paused_by, paused_reason, paused_request_id, updated_at)
      VALUES (g.id, g.cluster_mode, clock_timestamp(), v_actor, v_reason, v_req, clock_timestamp())
      ON CONFLICT (cluster_id) DO UPDATE
         SET paused_from = EXCLUDED.paused_from, paused_at = EXCLUDED.paused_at, paused_by = EXCLUDED.paused_by,
             paused_reason = EXCLUDED.paused_reason, paused_request_id = EXCLUDED.paused_request_id,
             updated_at = EXCLUDED.updated_at;
      v_detail := jsonb_build_object('paused_from', g.cluster_mode, 'instances_voided', v_n,
        'hands_in_flight', (SELECT count(*) FROM public.lightning_instance li
                             WHERE li.cluster_id = g.id AND li.state IN ('dealing', 'settling')));

    ELSIF v_op = 'resume' THEN
      IF g.cluster_mode IS DISTINCT FROM 'paused' THEN
        v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
      END IF;
      UPDATE public.cash_games SET cluster_mode = v_from, updated_at = now() WHERE id = g.id;
      UPDATE public.lightning_cluster_control
         SET paused_from = NULL, paused_at = NULL, paused_by = NULL, paused_reason = NULL,
             paused_request_id = NULL, updated_at = clock_timestamp()
       WHERE cluster_id = g.id;
      v_n := 0;
      IF v_from = 'lightning' THEN
        v_n := public.fn_lightning_pool_enter_seated(g.id);
      END IF;
      v_detail := jsonb_build_object('resumed_to', v_from, 'pool_sessions_entered', v_n);

    ELSIF v_op = 'disable_joins' THEN
      IF NOT coalesce((v_cfg ->> 'lightning_joins_enabled')::boolean, true) THEN
        v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
      END IF;
      v_patch := jsonb_build_object('lightning_joins_enabled', false,
                                    'lightning_joins_disabled_at', to_jsonb(clock_timestamp()));
      v_detail := jsonb_build_object('joins_disabled_at', clock_timestamp());

    ELSIF v_op = 'enable_joins' THEN
      IF coalesce((v_cfg ->> 'lightning_joins_enabled')::boolean, true) THEN
        v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
      END IF;
      v_patch := jsonb_build_object('lightning_joins_enabled', true);
      v_remove := ARRAY['lightning_joins_disabled_at'];

    ELSIF v_op IN ('drain', 'disable_lightning') THEN
      IF v_drain.id IS NOT NULL OR g.cluster_mode = 'draining' THEN
        v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
      END IF;
      IF v_from IN ('must_move', 'created', 'opening') THEN
        -- NOTHING IN LIGHTNING TO DRAIN: the flag is cleared, and a drain
        -- of a must-move pause resumes it, so the Cluster ends in must_move.
        IF NOT coalesce(g.lightning_enabled, false) AND NOT (v_op = 'drain' AND g.cluster_mode = 'paused') THEN
          v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
        END IF;
        UPDATE public.cash_games
           SET lightning_enabled = false, lightning_off_condition_since = NULL,
               cluster_mode = CASE WHEN v_op = 'drain' AND cluster_mode = 'paused' THEN 'must_move' ELSE cluster_mode END,
               updated_at = now()
         WHERE id = g.id;
        IF v_op = 'drain' AND g.cluster_mode = 'paused' THEN
          UPDATE public.lightning_cluster_control
             SET paused_from = NULL, paused_at = NULL, paused_by = NULL, paused_reason = NULL,
                 paused_request_id = NULL, updated_at = clock_timestamp()
           WHERE cluster_id = g.id;
        END IF;
        v_detail := v_detail || jsonb_build_object('nothing_to_drain', true, 'drain', NULL);
        EXIT act;
      END IF;

      -- THE EMERGENCY DRAIN. Steps 1 and 2 take effect in this statement
      -- (joins and formation stop: the pool door, the barrier and
      -- begin_dealing all refuse every mode but lightning, and lightning is
      -- disabled so nothing converts back), step 3 is recorded, and the
      -- drive does the rest.
      v_timeout := coalesce((v_cfg ->> 'drain_timeout_ms')::integer, 120000);
      SELECT count(*) FILTER (WHERE li.state IN ('forming', 'reserved'))::integer,
             count(*) FILTER (WHERE li.state IN ('dealing', 'settling'))::integer
        INTO v_wait, v_live
        FROM public.lightning_instance li
       WHERE li.cluster_id = g.id AND li.state IN ('forming', 'reserved', 'dealing', 'settling');
      SELECT count(*)::integer INTO v_open FROM public.lightning_pool_session ps
       WHERE ps.cluster_id = g.id AND ps.exited_at IS NULL;
      SELECT coalesce(sum(ts.stack), 0) INTO v_chips
        FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
       WHERE tb.cluster_id = g.id AND ts.left_at IS NULL;
      SELECT cc.id INTO v_conv FROM public.cash_cluster_conversion cc
       WHERE cc.cluster_id = g.id AND cc.status = 'pending';
      UPDATE public.cash_games
         SET lightning_enabled = false, lightning_off_condition_since = NULL,
             cluster_mode = CASE WHEN g.cluster_mode IN ('lightning', 'paused') THEN 'draining' ELSE cluster_mode END,
             updated_at = now()
       WHERE id = g.id;
      IF g.cluster_mode = 'paused' THEN
        UPDATE public.lightning_cluster_control
           SET paused_from = NULL, paused_at = NULL, paused_by = NULL, paused_reason = NULL,
               paused_request_id = NULL, updated_at = clock_timestamp()
         WHERE cluster_id = g.id;
      END IF;
      INSERT INTO public.lightning_cluster_drain
             (cluster_id, request_id, requested_by, actor_kind, reason, from_mode, epoch_at_request, deadline_at,
              phase, conversion_id, counts)
      VALUES (g.id, v_req, v_actor, v_kind, v_reason, g.cluster_mode, g.cluster_epoch,
              clock_timestamp() + make_interval(secs => v_timeout / 1000.0),
              CASE WHEN g.cluster_mode IN ('lightning', 'paused') THEN 'finishing' ELSE 'reverting' END,
              v_conv,
              jsonb_build_object('chips_at_request', v_chips, 'pool_sessions_at_request', v_open,
                                 'hands_in_flight_at_request', v_live, 'instances_awaiting_deal_at_request', v_wait,
                                 'drain_timeout_ms', v_timeout))
      RETURNING id INTO v_id;
      v_steps := jsonb_build_array(
        jsonb_build_object('step', 1, 'name', 'stop_new_joins', 'joins_closed', true,
                           'lightning_enabled', false, 'pool_sessions_open', v_open),
        jsonb_build_object('step', 2, 'name', 'stop_new_formation', 'formation_stopped', true,
                           'instances_awaiting_deal', v_wait),
        jsonb_build_object('step', 3, 'name', 'let_active_hands_finish', 'hands_in_flight', v_live,
                           'deadline_at', clock_timestamp() + make_interval(secs => v_timeout / 1000.0),
                           'drain_timeout_ms', v_timeout));
      UPDATE public.lightning_cluster_drain SET steps = ARRAY[1, 2, 3] WHERE id = v_id;
      v_detail := v_detail || jsonb_build_object('drain_id', v_id, 'from_mode', g.cluster_mode,
        'phase', CASE WHEN g.cluster_mode IN ('lightning', 'paused') THEN 'finishing' ELSE 'reverting' END,
        'deadline_at', clock_timestamp() + make_interval(secs => v_timeout / 1000.0),
        'hands_in_flight', v_live, 'instances_awaiting_deal', v_wait, 'pool_sessions_open', v_open,
        'conversion_id', v_conv);

    ELSIF v_op = 'enable_lightning' THEN
      IF coalesce(g.lightning_enabled, false) THEN
        v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
      END IF;
      IF v_drain.id IS NOT NULL OR g.cluster_mode IN ('draining', 'pending_off') THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'CLUSTER_BUSY', 'reason', 'CLUSTER_BUSY',
                                       'cluster_mode', g.cluster_mode, 'drain_id', v_drain.id);
        EXIT act;
      END IF;
      IF NOT coalesce(g.must_move, false) THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ACTION', 'reason', 'not_a_must_move_game');
        EXIT act;
      END IF;
      UPDATE public.cash_games SET lightning_enabled = true, updated_at = now() WHERE id = g.id;
      v_detail := v_detail || jsonb_build_object('game_enabled', g.enabled, 'cluster_mode', g.cluster_mode);

    ELSIF v_op = 'freeze' THEN
      IF g.cluster_mode = 'frozen' THEN
        v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
      END IF;
      IF NOT (g.cluster_mode IN ('pending_on', 'lightning', 'pending_off', 'draining')
              OR (g.cluster_mode = 'paused' AND v_from = 'lightning')) THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ACTION', 'reason', 'NOT_IN_A_LIGHTNING_MODE',
                                       'cluster_mode', g.cluster_mode);
        EXIT act;
      END IF;
      -- THE FREEZE PATH: the same transition, the same page and the same
      -- event an automatic freeze writes. Recovery: fn_cash_cluster_unfreeze.
      UPDATE public.cash_games SET cluster_mode = 'frozen', updated_at = now()
       WHERE id = g.id AND cluster_mode NOT IN ('frozen', 'dead');
      BEGIN
        v_alert := public.fn_raise_server_financial_alert(
          'critical', 'lightning_alerts',
          format('LIGHTNING_CLUSTER_FROZEN: Cluster %s frozen by an operator from %s at epoch %s: %s',
                 g.id, g.cluster_mode, g.cluster_epoch, v_reason),
          jsonb_build_object('check', 'frozen', 'cluster_id', g.id, 'cluster_epoch', g.cluster_epoch,
                             'invariant', 'operator_freeze', 'from_mode', g.cluster_mode, 'operator', v_actor,
                             'request_id', v_req, 'recovery', 'fn_cash_cluster_unfreeze(cluster_id, operator, reason)'),
          'lightning_cluster_frozen:' || g.id, g.id::text);
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_alert_err = MESSAGE_TEXT;
      END;
      INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
      VALUES (g.id, 'cluster_frozen', jsonb_build_object(
        'cluster_id', g.id, 'cluster_epoch', g.cluster_epoch, 'from_mode', g.cluster_mode, 'to_mode', 'frozen',
        'reason', 'operator_freeze', 'invariant', 'operator_freeze', 'operator', v_actor, 'note', v_reason,
        'alert_id', v_alert, 'alert_error', v_alert_err, 'at', clock_timestamp()), g.cluster_epoch, v_req);
      IF v_drain.id IS NOT NULL THEN
        INSERT INTO public.cash_cluster_events (game_id, kind, payload, request_id)
        VALUES (g.id, 'lightning_drain_ended', jsonb_build_object(
          'drain_id', v_drain.id, 'request_id', v_drain.request_id, 'outcome', 'ended_by_frozen',
          'cluster_mode', 'frozen', 'steps_recorded', to_jsonb(v_drain.steps), 'at', clock_timestamp()), v_drain.request_id);
        UPDATE public.lightning_cluster_drain
           SET phase = 'complete', completed_at = clock_timestamp(), outcome = 'ended_by_frozen'
         WHERE id = v_drain.id;
      END IF;
      IF g.cluster_mode = 'paused' THEN
        UPDATE public.lightning_cluster_control
           SET paused_from = NULL, paused_at = NULL, paused_by = NULL, paused_reason = NULL,
               paused_request_id = NULL, updated_at = clock_timestamp()
         WHERE cluster_id = g.id;
      END IF;
      v_detail := jsonb_build_object('from_mode', g.cluster_mode, 'alert_id', v_alert, 'alert_error', v_alert_err,
                                     'drain_ended', v_drain.id);

    ELSIF v_op = 'unfreeze' THEN
      IF g.cluster_mode IS DISTINCT FROM 'frozen' THEN
        v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
      END IF;
      IF v_actor IS NULL THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'operator_required');
        EXIT act;
      END IF;
      v_res := public.fn_cash_cluster_unfreeze(g.id, v_actor, v_reason);
      IF coalesce((v_res ->> 'ok')::boolean, false) IS NOT TRUE THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', coalesce(v_res ->> 'reason', 'unfreeze_refused'),
                                       'unfreeze', v_res);
        EXIT act;
      END IF;
      UPDATE public.lightning_cluster_control
         SET paused_from = NULL, paused_at = NULL, paused_by = NULL, paused_reason = NULL,
             paused_request_id = NULL, updated_at = clock_timestamp()
       WHERE cluster_id = g.id;
      v_detail := jsonb_build_object('unfreeze', v_res);

    ELSIF v_op IN ('set_matcher_version', 'disable_matcher_version', 'enable_matcher_version') THEN
      v_version := CASE WHEN jsonb_typeof(v_args -> 'version') = 'string' THEN v_args ->> 'version' END;
      IF v_version IS NULL THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'version_required'); EXIT act;
      END IF;
      IF NOT (v_version = ANY (c_known)) THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'UNKNOWN_VERSION', 'reason', 'UNKNOWN_VERSION',
                                       'version', v_version, 'known', to_jsonb(c_known));
        EXIT act;
      END IF;
      v_live_v := coalesce(CASE WHEN jsonb_typeof(v_raw -> 'matcher_version') = 'string' THEN v_raw ->> 'matcher_version' END, 'm1');
      IF v_op = 'set_matcher_version' THEN
        IF v_version = ANY (v_off) THEN
          v_answer := jsonb_build_object('ok', false, 'code', 'VERSION_DISABLED', 'reason', 'VERSION_DISABLED',
                                         'version', v_version);
          EXIT act;
        END IF;
        v_role := coalesce(CASE WHEN jsonb_typeof(v_args -> 'role') = 'string' THEN v_args ->> 'role' END, 'live');
        IF v_role NOT IN ('live', 'shadow') THEN
          v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'role_must_be_live_or_shadow'); EXIT act;
        END IF;
        IF v_role = 'live' THEN
          IF NOT (v_version = ANY (c_sql)) THEN
            v_answer := jsonb_build_object('ok', false, 'code', 'NOT_SQL_MATCHER', 'reason', 'NOT_SQL_MATCHER',
                                           'version', v_version, 'sql_matcher_versions', to_jsonb(c_sql));
            EXIT act;
          END IF;
          IF v_live_v = v_version THEN
            v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
          END IF;
          v_patch := jsonb_build_object('matcher_version', v_version,
                                        'matcher_version_previous', CASE WHEN v_live_v = ANY (c_known) THEN v_live_v ELSE 'm1' END);
        ELSE
          IF (v_cfg ->> 'shadow_matcher_version') = v_version THEN
            v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
          END IF;
          IF (v_cfg ->> 'matcher_version') = v_version THEN
            v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'shadow_equals_live'); EXIT act;
          END IF;
          v_patch := jsonb_build_object('shadow_matcher_version', v_version);
        END IF;
        v_detail := jsonb_build_object('version', v_version, 'role', v_role);
      ELSIF v_op = 'disable_matcher_version' THEN
        IF v_version = ANY (v_off) THEN
          v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
        END IF;
        IF v_version = ANY (c_sql)
           AND NOT EXISTS (SELECT 1 FROM unnest(c_sql) x(v) WHERE x.v <> v_version AND NOT (x.v = ANY (v_off))) THEN
          v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ARGS',
                                         'reason', 'the_only_sql_matcher_cannot_be_disabled', 'version', v_version);
          EXIT act;
        END IF;
        v_patch := jsonb_build_object('matcher_versions_disabled',
                     to_jsonb(ARRAY(SELECT DISTINCT u.x FROM unnest(v_off || v_version) u(x) ORDER BY u.x)));
        v_detail := jsonb_build_object('version', v_version);
        -- DISABLING THE LIVE VERSION ROLLS BACK to the previous enabled one.
        IF v_live_v = v_version THEN
          v_prev := v_cfg ->> 'matcher_version_previous';
          IF v_prev IS NULL OR v_prev = v_version OR v_prev = ANY (v_off) OR NOT (v_prev = ANY (c_sql)) THEN
            v_prev := 'm1';
          END IF;
          v_patch := v_patch || jsonb_build_object('matcher_version', v_prev, 'matcher_version_previous', v_version);
          v_detail := v_detail || jsonb_build_object('forced_rollback', jsonb_build_object('from', v_version, 'to', v_prev));
        END IF;
        IF (v_cfg ->> 'shadow_matcher_version') = v_version THEN
          v_detail := v_detail || jsonb_build_object('shadow_stops', true);
        END IF;
      ELSE
        IF NOT (v_version = ANY (v_off)) THEN
          v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
        END IF;
        v_patch := jsonb_build_object('matcher_versions_disabled',
                     to_jsonb(ARRAY(SELECT u.x FROM unnest(v_off) u(x) WHERE u.x <> v_version ORDER BY u.x)));
        v_detail := jsonb_build_object('version', v_version);
      END IF;

    ELSIF v_op = 'rollback_matcher_version' THEN
      v_live_v := coalesce(CASE WHEN jsonb_typeof(v_raw -> 'matcher_version') = 'string' THEN v_raw ->> 'matcher_version' END, 'm1');
      v_prev := coalesce(v_cfg ->> 'matcher_version_previous', 'm1');
      IF v_prev = v_live_v THEN
        v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
      END IF;
      IF v_prev = ANY (v_off) THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'VERSION_DISABLED', 'reason', 'VERSION_DISABLED', 'version', v_prev);
        EXIT act;
      END IF;
      IF NOT (v_prev = ANY (c_sql)) THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'NOT_SQL_MATCHER', 'reason', 'NOT_SQL_MATCHER', 'version', v_prev);
        EXIT act;
      END IF;
      v_patch := jsonb_build_object('matcher_version', v_prev,
                                    'matcher_version_previous', CASE WHEN v_live_v = ANY (c_known) THEN v_live_v ELSE 'm1' END);
      v_detail := jsonb_build_object('from', v_live_v, 'to', v_prev);

    ELSIF v_op = 'set_worker_mode' THEN
      -- THE ENGINE WORKER: off (nothing), shadow (plans and compares, forms
      -- nothing) or form. A rollout stage, not a specification flag.
      v_role := CASE WHEN jsonb_typeof(v_args -> 'mode') = 'string' THEN v_args ->> 'mode' END;
      IF v_role IS NULL OR v_role NOT IN ('off', 'shadow', 'form') THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'mode_must_be_off_shadow_or_form');
        EXIT act;
      END IF;
      -- Stopping a live worker can abandon unsettled hands and strand the pool.
      -- The audited drain must finish before the worker is switched off.
      IF v_role = 'off' AND g.cluster_mode <> 'must_move' THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'CLUSTER_BUSY',
                                       'reason', 'drain_before_worker_off');
        EXIT act;
      END IF;
      IF (v_cfg ->> 'worker_mode') = v_role THEN
        v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
      END IF;
      v_patch := jsonb_build_object('worker_mode', v_role);
      v_detail := jsonb_build_object('worker_mode', v_role, 'was', v_cfg ->> 'worker_mode');

    ELSIF v_op = 'set_flag' THEN
      IF (public.fn_lightning_spec_flags(g.lightning_enabled, v_cfg) ->> v_flag)::boolean IS NOT DISTINCT FROM v_value THEN
        v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
      END IF;
      IF v_flag = 'lightning_shadow_matcher' THEN
        v_patch := jsonb_build_object('lightning_shadow_matcher', v_value);
      ELSIF v_flag = 'lightning_auto_rebuy' THEN
        v_patch := jsonb_build_object('auto_rebuy_enabled', v_value);
      ELSIF v_flag = 'lightning_fast_fold' THEN
        v_patch := jsonb_build_object('lightning_fast_fold', v_value);
      ELSIF v_flag = 'lightning_fold_watch' THEN
        v_patch := jsonb_build_object('lightning_fold_watch', v_value);
      ELSIF v_flag = 'lightning_multi_table' THEN
        IF v_value THEN
          v_remove := ARRAY['multi_table_limit'];
        ELSE
          v_patch := jsonb_build_object('multi_table_limit', 1);
        END IF;
      END IF;
    END IF;
  END act;

  IF v_answer IS NOT NULL AND coalesce((v_answer ->> 'already')::boolean, false) THEN
    v_answer := jsonb_build_object('ok', true, 'idempotent', true, 'already', true, 'code', 'ALREADY',
                                   'action', v_action, 'cluster_id', g.id, 'request_id', v_req,
                                   'before', v_before, 'after', v_before, 'event_id', NULL, 'detail', v_detail);
  ELSIF v_answer IS NULL THEN
    -- THE CONFIGURATION CHANGE, if the action is one: the Cluster's own
    -- lightning object, every other key left exactly as it was.
    IF v_patch <> '{}'::jsonb OR cardinality(v_remove) > 0 THEN
      UPDATE public.cash_games cg
         SET ruleset_snapshot = jsonb_set(coalesce(cg.ruleset_snapshot, '{}'::jsonb), '{lightning}',
               (CASE WHEN jsonb_typeof(cg.ruleset_snapshot -> 'lightning') = 'object'
                     THEN cg.ruleset_snapshot -> 'lightning' ELSE '{}'::jsonb END - v_remove) || v_patch, true),
             updated_at = now()
       WHERE cg.id = g.id;
      v_detail := v_detail || jsonb_build_object('config_set', v_patch, 'config_removed', to_jsonb(v_remove));
    END IF;
    IF v_op = 'enable_joins' AND g.cluster_mode = 'lightning' THEN
      -- WHOEVER SAT DOWN WHILE JOINS WERE CLOSED IS IN THE POOL NOW.
      v_detail := v_detail || jsonb_build_object('pool_sessions_entered', public.fn_lightning_pool_enter_seated(g.id));
    END IF;
    v_after := public.fn_lightning_operator_state(g.id);
    INSERT INTO public.cash_cluster_events (game_id, kind, payload, request_id)
    VALUES (g.id, 'operator_' || v_action, jsonb_build_object(
      'action', v_action, 'actor', v_actor, 'actor_kind', v_kind, 'reason', v_reason,
      'request_id', v_req, 'args', v_safe, 'before', v_before, 'after', v_after, 'detail', v_detail,
      'at', clock_timestamp()), v_req)
    RETURNING to_jsonb(id) INTO v_event;
    FOR st IN SELECT x.v FROM jsonb_array_elements(v_steps) x(v) LOOP
      INSERT INTO public.cash_cluster_events (game_id, kind, payload, request_id)
      VALUES (g.id, 'lightning_drain_step', st || jsonb_build_object(
        'drain_id', v_detail -> 'drain_id', 'request_id', v_req, 'operator_event_id', v_event,
        'at', clock_timestamp()), v_req);
    END LOOP;
    v_answer := jsonb_build_object('ok', true, 'idempotent', false, 'action', v_action, 'cluster_id', g.id,
                                   'request_id', v_req, 'before', v_before, 'after', v_after,
                                   'event_id', v_event, 'detail', v_detail);
  ELSE
    v_answer := v_answer || jsonb_build_object('action', v_action, 'cluster_id', g.id, 'request_id', v_req);
  END IF;

  INSERT INTO public.lightning_operator_request (request_id, cluster_id, action, actor, actor_kind, reason, args, answer)
  VALUES (v_req, g.id, v_action, v_actor, v_kind, v_reason, v_safe, v_answer)
  ON CONFLICT (request_id) DO NOTHING;
  RETURN v_answer;
END
$fn$;$definition$;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = p) <> '71d863c9348ce7e9aa47eac3a36815ab' THEN
    RAISE EXCEPTION 'Unexpected fn_lightning_operator_control postimage';
  END IF;
END $guard$;

DO $guard$
DECLARE p regprocedure := 'public.fn_lightning_operator_state(uuid)'::regprocedure; actual text;
BEGIN
  SELECT md5(prosrc) INTO actual FROM pg_proc WHERE oid = p;
  IF NOT (SELECT prosecdef = false AND proconfig = ARRAY['search_path=public, pg_temp'] AND pg_get_userbyid(proowner) = 'postgres' AND proacl @> '{postgres=X/postgres,service_role=X/postgres}'::aclitem[] AND proacl <@ '{postgres=X/postgres,service_role=X/postgres}'::aclitem[] FROM pg_proc WHERE oid = p) THEN
    RAISE EXCEPTION 'Unexpected fn_lightning_operator_state security configuration';
  END IF;
  IF actual = '6958384c35470086fc804ec6b41abad3' THEN RETURN; END IF;
  IF actual <> 'ef6e8ad2ef710ea5d2a890dac0f12d90' THEN RAISE EXCEPTION 'Unexpected fn_lightning_operator_state preimage: %', actual; END IF;
  EXECUTE $definition$CREATE OR REPLACE FUNCTION public.fn_lightning_operator_state(p_cluster_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  g     record;
  v_cfg jsonb;
  d     record;
  v_ctl record;
BEGIN
  SELECT cg.id, cg.cluster_mode, cg.cluster_epoch, cg.lightning_enabled INTO g
    FROM public.cash_games cg WHERE cg.id = p_cluster_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v_cfg := public.fn_lightning_config(g.id);
  SELECT x.id, x.phase, x.from_mode, x.requested_at, x.deadline_at INTO d
    FROM public.lightning_cluster_drain x WHERE x.cluster_id = g.id AND x.completed_at IS NULL;
  SELECT x.* INTO v_ctl FROM public.lightning_cluster_control x WHERE x.cluster_id = g.id;
  RETURN jsonb_build_object(
    'cluster_mode', g.cluster_mode,
    'cluster_epoch', g.cluster_epoch,
    'lightning_enabled', coalesce(g.lightning_enabled, false),
    'paused', g.cluster_mode = 'paused',
    'paused_from', CASE WHEN g.cluster_mode = 'paused' THEN v_ctl.paused_from END,
    'joins_enabled', coalesce((v_cfg ->> 'lightning_joins_enabled')::boolean, true),
    'drain', CASE WHEN d.id IS NULL THEN NULL ELSE jsonb_build_object(
               'drain_id', d.id, 'phase', d.phase, 'from_mode', d.from_mode,
               'requested_at', d.requested_at, 'deadline_at', d.deadline_at) END,
    'matcher', jsonb_build_object(
      'version', v_cfg -> 'matcher_version',
      'previous', v_cfg -> 'matcher_version_previous',
      'disabled', coalesce(v_cfg -> 'matcher_versions_disabled', '[]'::jsonb),
      'shadow_version', v_cfg -> 'shadow_matcher_version',
      'shadow_disabled', coalesce((v_cfg ->> 'shadow_matcher_disabled')::boolean, false)),
    'worker_mode', v_cfg -> 'worker_mode',
    'flags', public.fn_lightning_spec_flags(g.lightning_enabled, v_cfg));
END
$fn$;$definition$;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = p) <> '6958384c35470086fc804ec6b41abad3' THEN
    RAISE EXCEPTION 'Unexpected fn_lightning_operator_state postimage';
  END IF;
END $guard$;

DO $guard$
DECLARE p regprocedure := 'public.fn_thaw_platform_checkpointed(timestamp with time zone,numeric,text)'::regprocedure; actual text;
BEGIN
  SELECT md5(prosrc) INTO actual FROM pg_proc WHERE oid=p;
  IF NOT (SELECT prosecdef AND proconfig = ARRAY['search_path=public, pg_temp'] AND pg_get_userbyid(proowner)='postgres' AND proacl = '{postgres=X/postgres}'::aclitem[] FROM pg_proc WHERE oid=p) THEN RAISE EXCEPTION 'Unexpected checkpointed thaw security configuration'; END IF;
  IF actual='05801f790fe39cb04a02dc55ee35f1f3' THEN RETURN; END IF;
  IF actual <> '8390ea3b5e92685cc29c806c494a680a' THEN RAISE EXCEPTION 'Unexpected checkpointed thaw preimage: %',actual; END IF;
  EXECUTE $definition$CREATE OR REPLACE FUNCTION public.fn_thaw_platform_checkpointed(p_freeze_started timestamp with time zone, p_frozen_seconds numeric, p_thawed_by text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- Stop starting new steps once this much of our own wall clock is spent.
  -- PostgREST's service_role statement_timeout is 8s; the remainder is head
  -- room for the step in flight and for the FOR UPDATE wait.
  c_budget      CONSTANT INTERVAL := interval '4 seconds';
  -- tournaments.level_started_at rows per call (~20ms each through triggers).
  c_level_batch CONSTANT INTEGER  := 40;

  v_started  TIMESTAMPTZ := clock_timestamp();
  v_row      public.engine_maintenance_thaws%ROWTYPE;
  v_shift    INTERVAL;
  v_counts   JSONB;
  v_n        INTEGER;
  v_done     TEXT[] := '{}';
  v_cursor   UUID;
  v_last     UUID;
  v_batch_n  INTEGER;
  v_total    INTEGER;
BEGIN
  -- Sanity: a thaw claiming more than fifteen frozen minutes is a bug or a
  -- clock skew, and shifting every deadline on the platform by a wrong number
  -- is strictly worse than shifting by nothing.
  IF p_frozen_seconds IS NULL OR p_frozen_seconds <= 0 OR p_frozen_seconds > 900 THEN
    RETURN jsonb_build_object('ok', false, 'complete', false, 'reason', 'implausible_frozen_seconds');
  END IF;

  -- Claim this freeze (or find it already claimed). The ledger row is the
  -- checkpoint file for every call that follows.
  INSERT INTO public.engine_maintenance_thaws (freeze_started_at, frozen_seconds, shifted, thawed_by)
  VALUES (p_freeze_started, p_frozen_seconds, '{}'::jsonb, p_thawed_by)
  ON CONFLICT (freeze_started_at) DO NOTHING;

  SELECT * INTO v_row
    FROM public.engine_maintenance_thaws
   WHERE freeze_started_at = p_freeze_started
     FOR UPDATE;

  v_counts := COALESCE(v_row.shifted, '{}'::jsonb);
  IF COALESCE((v_counts->>'complete')::boolean, false) THEN
    RETURN jsonb_build_object('ok', true, 'complete', true, 'reason', 'already_thawed', 'shifted', v_counts);
  END IF;

  -- One shift for the whole platform: the number the claim recorded.
  v_shift := make_interval(secs => v_row.frozen_seconds);

  -- The thaw's own writes must pass the freeze guard even if it is called a
  -- moment before break_ends_at, and trg_stamp_sit_out_at lets the sit-out
  -- shift through only under this GUC. LOCAL: dies with this transaction.
  PERFORM set_config('app.freeze_bypass', 'on', TRUE);

  -- ── Step: sit-out clocks on live seats ─────────────────────────────────
  -- The whole reason a player can sit out at :53 and still own their seat
  -- at :00. Cheap (index on status; a handful of rows).
  IF NOT (v_counts ? 'sit_out_at') THEN
    UPDATE public.table_seats
       SET sit_out_at = sit_out_at + v_shift
     WHERE left_at IS NULL AND sit_out_at IS NOT NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('sit_out_at', v_n);
    v_done := array_append(v_done, 'sit_out_at');
  END IF;

  -- ── Step: waitlist seat holds ──────────────────────────────────────────
  -- Holds alive when the freeze began (including any that "expired" during
  -- it - the shift resurrects exactly the time they were owed and no more).
  IF NOT (v_counts ? 'hold_expires_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.table_waitlist
       SET hold_expires_at = hold_expires_at + v_shift
     WHERE hold_expires_at > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('hold_expires_at', v_n);
    v_done := array_append(v_done, 'hold_expires_at');
  END IF;

  -- ── Step: tournament add-on windows ────────────────────────────────────
  IF NOT (v_counts ? 'addon_period_ends_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.tournaments
       SET addon_period_ends_at = addon_period_ends_at + v_shift
     WHERE addon_period_ends_at > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('addon_period_ends_at', v_n);
    v_done := array_append(v_done, 'addon_period_ends_at');
  END IF;

  -- ── Step: the cashier claim-back window (10 minutes; a freeze would eat half)
  IF NOT (v_counts ? 'reversible_until') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.chip_transactions
       SET reversible_until = reversible_until + v_shift
     WHERE reversible_until > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('reversible_until', v_n);
    v_done := array_append(v_done, 'reversible_until');
  END IF;

  -- ── Step: mystery bounty reveal windows ────────────────────────────────
  IF NOT (v_counts ? 'reveal_deadline_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.tournament_bounty_awards
       SET reveal_deadline_at = reveal_deadline_at + v_shift
     WHERE reveal_deadline_at > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('reveal_deadline_at', v_n);
    v_done := array_append(v_done, 'reveal_deadline_at');
  END IF;

  -- ── Step: bust-rebuy prompts ───────────────────────────────────────────
  IF NOT (v_counts ? 'rebuy_prompt_until') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.tournament_players
       SET rebuy_prompt_until = rebuy_prompt_until + v_shift
     WHERE rebuy_prompt_until > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('rebuy_prompt_until', v_n);
    v_done := array_append(v_done, 'rebuy_prompt_until');
  END IF;

  -- ── Step: timed bomb pots ──────────────────────────────────────────────
  -- Due exactly as far after the thaw as they were before the freeze.
  IF NOT (v_counts ? 'bomb_pot_next_due_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.tables
       SET bomb_pot_next_due_at = bomb_pot_next_due_at + v_shift
     WHERE bomb_pot_next_due_at IS NOT NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('bomb_pot_next_due_at', v_n);
    v_done := array_append(v_done, 'bomb_pot_next_due_at');
  END IF;

  -- ── Step: CHIP CONTINUITY stay clocks (2026-09-04) ─────────────────────
  -- A running stay clock is `remaining as of last_tick`; shifting last_tick
  -- forward by the frozen minutes is exactly "the freeze did not count".
  -- Only ticks stamped before the thaw: a row the engine has already
  -- re-settled after the break carries no frozen time to give back.
  IF NOT (v_counts ? 'cash_stay_last_tick_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.cash_player_session
       SET stay_last_tick_at = stay_last_tick_at + v_shift
     WHERE closed_at IS NULL AND stay_running AND stay_last_tick_at <= p_freeze_started + v_shift;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('cash_stay_last_tick_at', v_n);
    v_done := array_append(v_done, 'cash_stay_last_tick_at');
  END IF;

  -- ── Step: CHIP CONTINUITY rejoin floors (2026-09-04) ───────────────────
  IF NOT (v_counts ? 'cash_rejoin_expires_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.cash_rejoin_constraints
       SET expires_at = expires_at + v_shift
     WHERE expires_at > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('cash_rejoin_expires_at', v_n);
    v_done := array_append(v_done, 'cash_rejoin_expires_at');
  END IF;

  -- ── Step: CLUSTER CONTROLLER deadlines (Slice 2, 2026-09-05) ────────────
  -- break_eligible_since is the break hysteresis clock: five frozen minutes
  -- must not count as five quiet minutes. A pending seat move expires 60 s
  -- after it was planned; a frozen engine could not execute it in time.
  IF NOT (v_counts ? 'cluster_break_eligible_since') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.tables
       SET break_eligible_since = break_eligible_since + v_shift
     WHERE break_eligible_since IS NOT NULL AND break_eligible_since <= p_freeze_started + v_shift
       AND cluster_id IS NOT NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('cluster_break_eligible_since', v_n);
    v_done := array_append(v_done, 'cluster_break_eligible_since');
  END IF;
  IF NOT (v_counts ? 'cluster_move_expires_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.cash_seat_moves
       SET expires_at = expires_at + v_shift
     WHERE state = 'pending' AND expires_at > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('cluster_move_expires_at', v_n);
    v_done := array_append(v_done, 'cluster_move_expires_at');
  END IF;

  -- ── Step (chunked): blind level clocks ─────────────────────────────────
  -- ONLY for running events NOT on the synchronized break. An MTT on the :55
  -- break has its level clock suspended by pauseForBreak and restored by
  -- resumeFromBreak; shifting it here would give that event the five minutes
  -- twice. Short formats (Spins, Heads-Up) never take the synchronized break,
  -- so their wall-time level clock ran straight through the park - this is
  -- what gives it back (the 2026-08-27 incident class where Spins lost whole
  -- levels to a stop they never asked for).
  --
  -- This is the expensive one (~20ms/row through the table's UPDATE
  -- triggers), so it walks the primary key c_level_batch rows at a time and
  -- checkpoints the cursor after every batch. The shift is additive, so the
  -- cursor is what makes re-entry safe: a row below the cursor is done.
  -- The batch ordering by id is stable because no row's id changes and the
  -- set of RUNNING events cannot grow while the engine is parked.
  WHILE NOT (v_counts ? 'level_started_at') AND clock_timestamp() - v_started <= c_budget LOOP
    v_cursor := NULLIF(v_counts->>'level_started_at_cursor', '')::uuid;
    v_total  := COALESCE((v_counts->>'level_started_at_so_far')::integer, 0);

    WITH batch AS (
      SELECT id
        FROM public.tournaments
       WHERE status = 'RUNNING'
         AND COALESCE(on_break, FALSE) = FALSE
         AND level_started_at IS NOT NULL
         AND (v_cursor IS NULL OR id > v_cursor)
       ORDER BY id
       LIMIT c_level_batch
    ),
    shifted AS (
      UPDATE public.tournaments t
         SET level_started_at = t.level_started_at + v_shift
        FROM batch b
       WHERE t.id = b.id
      RETURNING t.id
    )
    -- (no max(uuid) in Postgres; uuid order is bytewise, identical to its hex text order)
    SELECT count(*), max(id::text)::uuid INTO v_batch_n, v_last FROM shifted;

    v_total := v_total + COALESCE(v_batch_n, 0);

    IF COALESCE(v_batch_n, 0) < c_level_batch THEN
      -- The last batch. Record the final count and drop the cursor keys.
      v_counts := (v_counts - 'level_started_at_cursor' - 'level_started_at_so_far')
                  || jsonb_build_object('level_started_at', v_total);
      v_done := array_append(v_done, 'level_started_at');
    ELSE
      v_counts := v_counts || jsonb_build_object(
        'level_started_at_cursor', v_last::text,
        'level_started_at_so_far', v_total
      );
    END IF;
  END LOOP;


  -- A reconnect allowance must survive both a normal parked restart and a
  -- crash snapshot restored on the other side of the thaw. The per-entry
  -- marker also prevents double credit when memory already shifted it.
  IF NOT (v_counts ? 'reconnect_presence') AND clock_timestamp() - v_started < c_budget THEN
    UPDATE public.engine_presence_parked
       SET disconnect_states = public.fn_thaw_reconnect_states(disconnect_states,
         extract(epoch FROM p_freeze_started) * 1000,
         extract(epoch FROM p_freeze_started + v_shift) * 1000)
     WHERE parked_at >= p_freeze_started - interval '20 minutes'
       AND parked_at <= p_freeze_started + v_shift;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('reconnect_presence', v_n);
    v_done := array_append(v_done, 'reconnect_presence');
  END IF;
  IF NOT (v_counts ? 'reconnect_snapshots') AND clock_timestamp() - v_started < c_budget THEN
    UPDATE public.hand_state_snapshots
       SET disconnect_states = public.fn_thaw_reconnect_states(disconnect_states,
         extract(epoch FROM p_freeze_started) * 1000,
         extract(epoch FROM p_freeze_started + v_shift) * 1000)
     WHERE is_complete = false
       AND updated_at >= p_freeze_started - interval '20 minutes'
       AND updated_at <= p_freeze_started + v_shift;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('reconnect_snapshots', v_n);
    v_done := array_append(v_done, 'reconnect_snapshots');
  END IF;

  -- Lightning drains retain the time their undealt reservations were owed.
  -- Use the same ledger lock/checkpoint as every existing thaw step.
  IF NOT (v_counts ? 'lightning_drain_deadline_at') AND clock_timestamp() - v_started <= c_budget THEN
    WITH shifted AS (
      UPDATE public.lightning_cluster_drain d
         SET deadline_at = d.deadline_at + v_shift
       WHERE d.completed_at IS NULL AND d.deadline_at > p_freeze_started
      RETURNING d.cluster_id, d.id, d.request_id, d.deadline_at
    ), emitted AS (
      INSERT INTO public.cash_cluster_events (game_id, kind, payload, request_id)
      SELECT cluster_id, 'lightning_drain_deadline_thawed',
             jsonb_build_object('drain_id', id, 'deadline_at', deadline_at,
                               'freeze_started_at', p_freeze_started), request_id
        FROM shifted
      RETURNING id
    ) SELECT count(*)::integer INTO v_n FROM emitted;
    v_counts := v_counts || jsonb_build_object('lightning_drain_deadline_at', v_n);
    v_done := array_append(v_done, 'lightning_drain_deadline_at');
  END IF;

  -- NOT shifted, deliberately:
  --   * tournaments.break_ends_at - the synchronized break owns it and the
  --     engine's resumeFromBreak restores it;
  --   * late_reg (started_at + late_reg_mins) - registration is frozen during
  --     the break, and the hourly tournament break has consumed those same
  --     five minutes of late-reg wall time since it was built. Shifting
  --     started_at would falsify history; parity with the existing break is
  --     the honest behaviour;
  --   * ban/mute/promotion expiries - a punishment or a promotion elapsing
  --     during a break is time genuinely passing, not play being taken away.

  -- Complete when every step has its key.
  IF v_counts ?& ARRAY['sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until',
                       'reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at',
                       'cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at',
                       'cluster_break_eligible_since','cluster_move_expires_at',
                       'reconnect_presence','reconnect_snapshots','lightning_drain_deadline_at'] THEN
    v_counts := v_counts || jsonb_build_object('complete', true);
  END IF;

  -- Checkpoint. This commit is what a later call resumes from.
  UPDATE public.engine_maintenance_thaws
     SET shifted   = v_counts,
         thawed_at = now()
   WHERE freeze_started_at = p_freeze_started;

  RETURN jsonb_build_object(
    'ok', true,
    'complete', COALESCE((v_counts->>'complete')::boolean, false),
    'steps_this_call', to_jsonb(v_done),
    'elapsed_ms', round(extract(epoch from clock_timestamp() - v_started) * 1000),
    'shifted', v_counts
  );
END;
$function$
;$definition$;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=p) <> '05801f790fe39cb04a02dc55ee35f1f3' THEN RAISE EXCEPTION 'Unexpected checkpointed thaw postimage'; END IF;
END $guard$;

DO $guard$
DECLARE p regprocedure := 'public.fn_snapshot_maintenance_thaw_targets(timestamp with time zone,numeric)'::regprocedure; actual text;
BEGIN
 SELECT md5(prosrc) INTO actual FROM pg_proc WHERE oid=p;
 IF NOT (SELECT prosecdef AND proconfig=ARRAY['search_path=public, pg_temp'] AND pg_get_userbyid(proowner)='postgres' AND proacl='{postgres=X/postgres}'::aclitem[] FROM pg_proc WHERE oid=p) THEN RAISE EXCEPTION 'Unexpected fn_snapshot_maintenance_thaw_targets security configuration'; END IF;
 IF actual='492ccb7dd2eab1034a73d4e1f997041f' THEN RETURN; END IF;
 IF actual <> '43455b0ff86f51f524b6190fc6bf7dd2' THEN RAISE EXCEPTION 'Unexpected fn_snapshot_maintenance_thaw_targets preimage: %',actual; END IF;
 EXECUTE $definition$CREATE OR REPLACE FUNCTION public.fn_snapshot_maintenance_thaw_targets(
  p_freeze_started timestamptz,
  p_initial_seconds numeric
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_counts jsonb := '{}'::jsonb;
  v_n integer;
BEGIN
  INSERT INTO public.engine_maintenance_thaw_targets(freeze_started_at, step, target_id)
  SELECT p_freeze_started, 'sit_out_at', s.id
    FROM public.table_seats s
   WHERE s.left_at IS NULL AND s.sit_out_at IS NOT NULL
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('sit_out_at', v_n);

  INSERT INTO public.engine_maintenance_thaw_targets(freeze_started_at, step, target_id)
  SELECT p_freeze_started, 'hold_expires_at', w.id
    FROM public.table_waitlist w
   WHERE w.hold_expires_at > p_freeze_started
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('hold_expires_at', v_n);

  INSERT INTO public.engine_maintenance_thaw_targets(freeze_started_at, step, target_id)
  SELECT p_freeze_started, 'addon_period_ends_at', t.id
    FROM public.tournaments t
   WHERE t.addon_period_ends_at > p_freeze_started
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('addon_period_ends_at', v_n);

  INSERT INTO public.engine_maintenance_thaw_targets(freeze_started_at, step, target_id)
  SELECT p_freeze_started, 'reversible_until', c.id
    FROM public.chip_transactions c
   WHERE c.reversible_until > p_freeze_started
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('reversible_until', v_n);

  INSERT INTO public.engine_maintenance_thaw_targets(freeze_started_at, step, target_id)
  SELECT p_freeze_started, 'reveal_deadline_at', a.id
    FROM public.tournament_bounty_awards a
   WHERE a.reveal_deadline_at > p_freeze_started
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('reveal_deadline_at', v_n);

  INSERT INTO public.engine_maintenance_thaw_targets(freeze_started_at, step, target_id)
  SELECT p_freeze_started, 'rebuy_prompt_until', p.id
    FROM public.tournament_players p
   WHERE p.rebuy_prompt_until > p_freeze_started
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('rebuy_prompt_until', v_n);

  INSERT INTO public.engine_maintenance_thaw_targets(freeze_started_at, step, target_id)
  SELECT p_freeze_started, 'bomb_pot_next_due_at', t.id
    FROM public.tables t
   WHERE t.bomb_pot_next_due_at IS NOT NULL
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('bomb_pot_next_due_at', v_n);

  INSERT INTO public.engine_maintenance_thaw_targets(freeze_started_at, step, target_id)
  SELECT p_freeze_started, 'cash_stay_last_tick_at', s.id
    FROM public.cash_player_session s
   WHERE s.closed_at IS NULL
     AND s.stay_running
     AND s.stay_last_tick_at <= p_freeze_started + make_interval(secs => p_initial_seconds)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('cash_stay_last_tick_at', v_n);

  INSERT INTO public.engine_maintenance_thaw_targets(freeze_started_at, step, target_id)
  SELECT p_freeze_started, 'cash_rejoin_expires_at', r.id
    FROM public.cash_rejoin_constraints r
   WHERE r.expires_at > p_freeze_started
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('cash_rejoin_expires_at', v_n);

  INSERT INTO public.engine_maintenance_thaw_targets(freeze_started_at, step, target_id)
  SELECT p_freeze_started, 'cluster_break_eligible_since', t.id
    FROM public.tables t
   WHERE t.break_eligible_since IS NOT NULL
     AND t.break_eligible_since <= p_freeze_started + make_interval(secs => p_initial_seconds)
     AND t.cluster_id IS NOT NULL
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('cluster_break_eligible_since', v_n);

  INSERT INTO public.engine_maintenance_thaw_targets(freeze_started_at, step, target_id)
  SELECT p_freeze_started, 'cluster_move_expires_at', m.id
    FROM public.cash_seat_moves m
   WHERE m.state = 'pending' AND m.expires_at > p_freeze_started
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('cluster_move_expires_at', v_n);

  INSERT INTO public.engine_maintenance_thaw_targets(freeze_started_at, step, target_id)
  SELECT p_freeze_started, 'level_started_at', t.id
    FROM public.tournaments t
   WHERE t.status = 'RUNNING'
     AND COALESCE(t.on_break, false) = false
     AND t.level_started_at IS NOT NULL
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('level_started_at', v_n);

  INSERT INTO public.engine_maintenance_thaw_targets(freeze_started_at, step, target_id)
  SELECT p_freeze_started, 'reconnect_presence', p.table_id
    FROM public.engine_presence_parked p
   WHERE p.parked_at >= p_freeze_started - INTERVAL '20 minutes'
     AND p.parked_at <= p_freeze_started + make_interval(secs => p_initial_seconds)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('reconnect_presence', v_n);

  INSERT INTO public.engine_maintenance_thaw_targets(freeze_started_at, step, target_id)
  SELECT p_freeze_started, 'reconnect_snapshots', s.id
    FROM public.hand_state_snapshots s
   WHERE s.is_complete = false
     AND s.updated_at >= p_freeze_started - INTERVAL '20 minutes'
     AND s.updated_at <= p_freeze_started + make_interval(secs => p_initial_seconds)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('reconnect_snapshots', v_n);

  INSERT INTO public.engine_maintenance_thaw_targets(freeze_started_at, step, target_id)
  SELECT p_freeze_started, 'lightning_drain_deadline_at', d.id
    FROM public.lightning_cluster_drain d
   WHERE d.completed_at IS NULL AND d.deadline_at > p_freeze_started
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('lightning_drain_deadline_at', v_n);

  UPDATE public.engine_maintenance_thaws t
     SET shifted = t.shifted || jsonb_build_object(
       '_targets_snapshotted', true,
       '_target_counts', v_counts
     )
   WHERE t.freeze_started_at = p_freeze_started;
  RETURN v_counts;
END;
$function$;$definition$;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=p) <> '492ccb7dd2eab1034a73d4e1f997041f' THEN RAISE EXCEPTION 'Unexpected fn_snapshot_maintenance_thaw_targets postimage'; END IF;
END $guard$;

DO $guard$
DECLARE p regprocedure := 'public.fn_credit_maintenance_thaw_targets(timestamp with time zone,numeric)'::regprocedure; actual text;
BEGIN
 SELECT md5(prosrc) INTO actual FROM pg_proc WHERE oid=p;
 IF NOT (SELECT prosecdef AND proconfig=ARRAY['search_path=public, pg_temp'] AND pg_get_userbyid(proowner)='postgres' AND proacl='{postgres=X/postgres}'::aclitem[] FROM pg_proc WHERE oid=p) THEN RAISE EXCEPTION 'Unexpected fn_credit_maintenance_thaw_targets security configuration'; END IF;
 IF actual='e64eadabf4292dbf6298c04dd7b1d5d5' THEN RETURN; END IF;
 IF actual <> 'c12308b00489adce1376ba1c1e4ea9d5' THEN RAISE EXCEPTION 'Unexpected fn_credit_maintenance_thaw_targets preimage: %',actual; END IF;
 EXECUTE $definition$CREATE OR REPLACE FUNCTION public.fn_credit_maintenance_thaw_targets(
  p_freeze_started timestamptz,
  p_target_seconds numeric
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  c_budget CONSTANT interval := INTERVAL '4 seconds';
  c_steps CONSTANT text[] := ARRAY[
    'sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until',
    'reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at',
    'cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at',
    'cluster_break_eligible_since','cluster_move_expires_at',
    'reconnect_presence','reconnect_snapshots','lightning_drain_deadline_at'
  ];
  v_started timestamptz := clock_timestamp();
  v_counts jsonb;
  v_step text;
  v_batch integer;
  v_moved integer;
  v_marked integer;
  v_done text[] := '{}';
  v_complete boolean;
BEGIN
  IF p_target_seconds IS NULL OR p_target_seconds <= 0 THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'reason', 'invalid_credit_target'
    );
  END IF;

  SELECT COALESCE(t.shifted, '{}'::jsonb) INTO v_counts
    FROM public.engine_maintenance_thaws t
   WHERE t.freeze_started_at = p_freeze_started
   FOR UPDATE;
  IF NOT FOUND OR COALESCE((v_counts->>'_targets_snapshotted')::boolean, false) = false THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'reason', 'thaw_targets_not_snapshotted'
    );
  END IF;

  PERFORM set_config('app.freeze_bypass', 'on', true);

  FOREACH v_step IN ARRAY c_steps LOOP
    EXIT WHEN clock_timestamp() - v_started > c_budget;
    v_batch := CASE WHEN v_step = 'level_started_at' THEN 40 ELSE 200 END;
    v_moved := 0;
    v_marked := 0;

    IF v_step = 'sit_out_at' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id, x.credited_seconds
          FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at = p_freeze_started AND x.step = v_step
           AND x.credited_seconds < p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.table_seats r
           SET sit_out_at = r.sit_out_at
             + make_interval(secs => p_target_seconds - d.credited_seconds)
          FROM due d WHERE r.id = d.target_id AND r.sit_out_at IS NOT NULL
        RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x
           SET credited_seconds = p_target_seconds
          FROM due d
         WHERE x.freeze_started_at = p_freeze_started AND x.step = v_step
           AND x.target_id = d.target_id
        RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved), (SELECT count(*) FROM marked)
          INTO v_moved, v_marked;
    ELSIF v_step = 'hold_expires_at' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id, x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.table_waitlist r SET hold_expires_at=r.hold_expires_at
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE r.id=d.target_id AND r.hold_expires_at IS NOT NULL RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'addon_period_ends_at' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.tournaments r SET addon_period_ends_at=r.addon_period_ends_at
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE r.id=d.target_id AND r.addon_period_ends_at IS NOT NULL RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'reversible_until' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.chip_transactions r SET reversible_until=r.reversible_until
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE r.id=d.target_id AND r.reversible_until IS NOT NULL RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'reveal_deadline_at' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.tournament_bounty_awards r SET reveal_deadline_at=r.reveal_deadline_at
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE r.id=d.target_id AND r.reveal_deadline_at IS NOT NULL RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'rebuy_prompt_until' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.tournament_players r SET rebuy_prompt_until=r.rebuy_prompt_until
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE r.id=d.target_id AND r.rebuy_prompt_until IS NOT NULL RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'bomb_pot_next_due_at' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.tables r SET bomb_pot_next_due_at=r.bomb_pot_next_due_at
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE r.id=d.target_id AND r.bomb_pot_next_due_at IS NOT NULL RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'cash_stay_last_tick_at' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.cash_player_session r SET stay_last_tick_at=r.stay_last_tick_at
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE r.id=d.target_id RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'cash_rejoin_expires_at' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.cash_rejoin_constraints r SET expires_at=r.expires_at
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE r.id=d.target_id RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'level_started_at' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.tournaments r SET level_started_at=r.level_started_at
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE r.id=d.target_id AND r.level_started_at IS NOT NULL RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'cluster_break_eligible_since' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.tables r SET break_eligible_since=r.break_eligible_since
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE r.id=d.target_id AND r.break_eligible_since IS NOT NULL RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'cluster_move_expires_at' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.cash_seat_moves r SET expires_at=r.expires_at
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE r.id=d.target_id RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'lightning_drain_deadline_at' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.lightning_cluster_drain r
           SET deadline_at=r.deadline_at
             + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE r.id=d.target_id AND r.completed_at IS NULL
        RETURNING r.id,r.cluster_id,r.request_id,r.deadline_at
      ), emitted AS (
        INSERT INTO public.cash_cluster_events(game_id,kind,payload,request_id)
        SELECT cluster_id,'lightning_drain_deadline_thawed',
               jsonb_build_object('drain_id',id,'deadline_at',deadline_at,
                                  'freeze_started_at',p_freeze_started),request_id FROM moved
        RETURNING id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM emitted),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'reconnect_presence' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.engine_presence_parked r
           SET disconnect_states=public.fn_thaw_reconnect_states(
             r.disconnect_states, EXTRACT(EPOCH FROM p_freeze_started)*1000,
             EXTRACT(EPOCH FROM p_freeze_started+make_interval(secs=>p_target_seconds))*1000)
          FROM due d WHERE r.table_id=d.target_id RETURNING r.table_id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'reconnect_snapshots' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.hand_state_snapshots r
           SET disconnect_states=public.fn_thaw_reconnect_states(
             r.disconnect_states, EXTRACT(EPOCH FROM p_freeze_started)*1000,
             EXTRACT(EPOCH FROM p_freeze_started+make_interval(secs=>p_target_seconds))*1000)
          FROM due d WHERE r.id=d.target_id RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    END IF;

    IF v_moved <> v_marked THEN
      RAISE EXCEPTION 'MAINTENANCE_THAW_TARGET_CHANGED: % moved %, receipted %',
        v_step, v_moved, v_marked
        USING ERRCODE = '40001';
    END IF;
    IF v_marked > 0 THEN
      v_done := array_append(v_done, v_step || ':' || v_marked::text);
    END IF;
  END LOOP;

  SELECT NOT EXISTS (
    SELECT 1 FROM public.engine_maintenance_thaw_targets x
     WHERE x.freeze_started_at=p_freeze_started
       AND x.credited_seconds<p_target_seconds
  ) INTO v_complete;
  IF v_complete THEN
    v_counts := (v_counts - 'level_started_at_cursor' - 'level_started_at_so_far')
      || COALESCE(v_counts->'_target_counts', '{}'::jsonb)
      || jsonb_build_object('complete', true);
  ELSE
    v_counts := v_counts - 'complete';
  END IF;
  UPDATE public.engine_maintenance_thaws t
     SET shifted=v_counts, thawed_at=clock_timestamp()
   WHERE t.freeze_started_at=p_freeze_started;
  RETURN jsonb_build_object(
    'ok', true, 'complete', v_complete, 'steps_this_call', to_jsonb(v_done),
    'elapsed_ms', round(EXTRACT(EPOCH FROM clock_timestamp()-v_started)*1000),
    'shifted', v_counts
  );
END;
$function$;$definition$;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=p) <> 'e64eadabf4292dbf6298c04dd7b1d5d5' THEN RAISE EXCEPTION 'Unexpected fn_credit_maintenance_thaw_targets postimage'; END IF;
END $guard$;

DO $publication$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime'
                     AND schemaname = 'public' AND tablename = 'cash_cluster_events') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.cash_cluster_events;
  END IF;
END $publication$;
COMMIT;
