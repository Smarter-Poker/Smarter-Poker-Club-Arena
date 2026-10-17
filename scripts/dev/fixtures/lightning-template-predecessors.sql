-- Immutable catalog preimages read from production 2026-10-16; tested against
-- migration's measured MD5 guards. This fixture does not replace production source.
CREATE OR REPLACE FUNCTION public.fn_lightning_operator_control(p_cluster_id uuid, p_action text, p_reason text, p_args jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_actions constant text[] := ARRAY['pause', 'resume', 'disable_joins', 'enable_joins', 'drain', 'freeze',
                                     'unfreeze', 'enable_lightning', 'disable_lightning', 'set_matcher_version',
                                     'disable_matcher_version', 'enable_matcher_version', 'rollback_matcher_version',
                                     'set_flag', 'set_worker_mode', 'set_shadow_window', 'set_integrity_telemetry'];
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
                                                 'mode', v_args -> 'mode', 'shadow_window_ms', v_args -> 'shadow_window_ms', 'actor_id', v_args -> 'actor_id'));

  -- Global operation identity precedes every Cluster lock and side effect.
  -- Contention is a bounded, explicit pending outcome, never a saved refusal.
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('lightning_operator_request:' || v_req::text, 0)) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'REQUEST_IN_PROGRESS',
      'reason', 'request_id_in_progress_retry_same_id', 'request_id', v_req,
      'cluster_id', p_cluster_id, 'action', v_action);
  END IF;

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

    ELSIF v_op = 'set_shadow_window' THEN
      -- Configure only a dark, drained Cluster: do not mix comparison windows.
      IF jsonb_typeof(v_args -> 'shadow_window_ms') IS DISTINCT FROM 'number' THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'shadow_window_ms_must_be_integer_60000_to_3600000'); EXIT act;
      END IF;
      IF (v_args ->> 'shadow_window_ms')::numeric < 60000
         OR (v_args ->> 'shadow_window_ms')::numeric > 3600000
         OR trunc((v_args ->> 'shadow_window_ms')::numeric) <> (v_args ->> 'shadow_window_ms')::numeric THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'shadow_window_ms_must_be_integer_60000_to_3600000'); EXIT act;
      END IF;
      IF g.cluster_mode <> 'must_move' OR v_drain.id IS NOT NULL
         OR v_cfg ->> 'worker_mode' <> 'off' THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'CLUSTER_BUSY', 'reason', 'drain_and_stop_worker_before_shadow_window'); EXIT act;
      END IF;
      v_wait := (v_args ->> 'shadow_window_ms')::integer;
      IF (v_cfg ->> 'shadow_window_ms')::integer = v_wait THEN
        v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
      END IF;
      v_patch := jsonb_build_object('shadow_window_ms', v_wait);
      v_detail := jsonb_build_object('shadow_window_ms', v_wait, 'was', v_cfg -> 'shadow_window_ms');

    ELSIF v_op = 'set_integrity_telemetry' THEN
      IF jsonb_typeof(v_args -> 'value') IS DISTINCT FROM 'boolean' THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'value_must_be_boolean'); EXIT act;
      END IF;
      IF g.cluster_mode <> 'must_move' OR v_drain.id IS NOT NULL
         OR v_cfg ->> 'worker_mode' <> 'off' THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'CLUSTER_BUSY', 'reason', 'drain_and_stop_worker_before_integrity_telemetry'); EXIT act;
      END IF;
      v_value := (v_args ->> 'value')::boolean;
      IF (v_cfg ->> 'integrity_telemetry')::boolean IS NOT DISTINCT FROM v_value THEN
        v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
      END IF;
      v_patch := jsonb_build_object('integrity_telemetry', v_value);
      v_detail := jsonb_build_object('integrity_telemetry', v_value, 'was', v_cfg -> 'integrity_telemetry');

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
  VALUES (v_req, g.id, v_action, v_actor, v_kind, v_reason, v_safe, v_answer);
  RETURN v_answer;
END
$function$;
CREATE OR REPLACE FUNCTION public.fn_lightning_rollout_readiness(p_cluster_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- EVERY LIGHTNING MIGRATION, in order (a later Lightning file adds itself).
  c_versions constant text[] := ARRAY[
    '20260920172736', '20260920234647', '20260920235343', '20260921025504', '20260921025523',
    '20260921044045', '20260921064717', '20260921142954', '20260921151618', '20260925204249',
    '20260925215731', '20260926023047', '20260926072527', '20260926072551', '20260926072615',
    '20260926072638', '20260926080332', '20261001154813', '20261001201216', '20261001222856',
    '20261007212735', '20261007222717', '20261008043021', '20261008050805', '20261008111425',
    '20261008142857', '20261008161509', '20261009143757', '20261009144343', '20261009151825',
    '20261009181945', '20261009235505'];
  v_now      timestamptz := now();
  g          record;
  v_club     record;
  v_row      jsonb;
  v_cfg      jsonb;
  v_reasons  jsonb := '[]'::jsonb;
  v_missing  text[];
  v_seven    boolean;
  v_anti     boolean;
  v_law      boolean;
  v_doors    boolean;
  v_sr       jsonb;
  v_scope    text;
  v_aa       jsonb;
  v_cand     jsonb;
  v_live_v   text;
  v_over     jsonb := '[]'::jsonb;
  v_leg      text;
  v_reg      jsonb;
  v_lat_to   timestamptz;
  v_horse    text := 'is_' || 'horse|horse_' || 'id';
  v_verdict  text;
  v_strip    text := '--[^' || chr(10) || ']*';
BEGIN
  SELECT cg.id, cg.club_id, cg.enabled, cg.must_move, cg.lightning_enabled, cg.cluster_mode,
         coalesce(((cg.ruleset_snapshot -> 'options') ->> 'is_private')::boolean, false) AS is_private
    INTO g FROM public.cash_games cg WHERE cg.id = p_cluster_id;
  IF NOT public.fn_lightning_operator_may(g.club_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_AUTHORIZED', 'reason', 'NOT_AUTHORIZED');
  END IF;
  IF g.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'reason', 'NOT_FOUND');
  END IF;
  SELECT (to_jsonb(cl) ->> 'is_public')::boolean AS is_public INTO v_club FROM public.clubs cl WHERE cl.id = g.club_id;
  v_row := public.fn_lightning_operator_cluster_row(g.id, v_now);
  v_cfg := public.fn_lightning_config(g.id);
  v_live_v := v_cfg ->> 'matcher_version';

  -- EVERY LIGHTNING MIGRATION IS RECORDED.
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'MIGRATION_LEDGER_UNREADABLE', 'severity', 'blocking',
                                                 'detail', 'supabase_migrations.schema_migrations is not readable');
  ELSE
    EXECUTE 'SELECT coalesce(array_agg(v ORDER BY v), ARRAY[]::text[]) FROM unnest($1) v
              WHERE NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations m WHERE m.version = v)'
       INTO v_missing USING c_versions;
    IF cardinality(v_missing) > 0 THEN
      v_reasons := v_reasons || jsonb_build_object('code', 'MIGRATIONS_MISSING', 'severity', 'blocking',
                                                   'detail', to_jsonb(v_missing));
    END IF;
  END IF;

  -- THE STRUCTURAL INVARIANTS THE LIVE PROOFS PIN, re-derived here.
  v_seven := (SELECT count(*) = 7 FROM information_schema.role_table_grants
               WHERE table_schema = 'public' AND table_name LIKE 'lightning\_%'
                 AND grantee = 'service_role' AND privilege_type = 'SELECT')
             AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                              WHERE table_schema = 'public' AND table_name LIKE 'lightning\_%'
                                AND grantee IN ('anon', 'authenticated', 'PUBLIC'));
  v_anti := (SELECT coalesce(bool_and(regexp_replace(pg_get_functiondef(p.oid), v_strip, '', 'g')
                                      !~ 'integrity|shadow_comparison|quality_|latency|lightning_alert|fn_lightning_operator_'), false)
                    AND count(*) = 6
               FROM pg_proc p
              WHERE p.oid IN ('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)'::regprocedure,
                              'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)'::regprocedure,
                              'public.fn_lightning_match(uuid,timestamp with time zone,uuid[],text,jsonb)'::regprocedure,
                              'public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer,jsonb)'::regprocedure,
                              'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)'::regprocedure,
                              'public.fn_cash_clusters_tick_all(jsonb)'::regprocedure));
  v_law := NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname LIKE 'fn\_lightning\_%'
                          AND regexp_replace(pg_get_functiondef(p.oid), v_strip, '', 'g') ~ v_horse);
  v_doors := NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                          WHERE n.nspname = 'public' AND p.proname LIKE 'fn\_lightning\_%'
                            AND has_function_privilege('anon', p.oid, 'EXECUTE'));
  IF NOT (v_seven AND v_anti AND v_law AND v_doors) THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'INVARIANT_FAILED', 'severity', 'blocking',
      'detail', jsonb_build_object('seven_tables', v_seven, 'anti_manipulation', v_anti,
                                   'law_10_5', v_law, 'no_anon_door', v_doors));
  END IF;

  -- THE CLUSTER.
  IF g.cluster_mode = 'frozen' THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'CLUSTER_FROZEN', 'severity', 'blocking', 'detail', v_row -> 'frozen');
  ELSIF g.cluster_mode IN ('pending_on', 'pending_off', 'draining', 'paused') OR jsonb_typeof(v_row -> 'drain') = 'object' THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'CLUSTER_BUSY', 'severity', 'blocking',
                                                 'detail', jsonb_build_object('cluster_mode', g.cluster_mode, 'drain', v_row -> 'drain'));
  ELSIF g.cluster_mode NOT IN ('must_move', 'lightning') THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'CLUSTER_NOT_READY', 'severity', 'blocking', 'detail', g.cluster_mode);
  END IF;
  IF g.enabled IS DISTINCT FROM true THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'GAME_DISABLED', 'severity', 'blocking', 'detail', NULL);
  END IF;
  IF NOT coalesce(g.must_move, false) THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'NOT_A_MUST_MOVE_GAME', 'severity', 'blocking', 'detail', NULL);
  END IF;
  IF coalesce((v_row ->> 'open_alerts')::integer, 0) > 0 THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'OPEN_ALERTS', 'severity', 'blocking',
                                                 'detail', (v_row ->> 'open_alerts')::integer);
  END IF;
  IF coalesce((v_row ->> 'integrity_open_high')::integer, 0) > 0 THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'INTEGRITY_HIGH_SIGNALS_OPEN', 'severity', 'blocking',
                                                 'detail', (v_row ->> 'integrity_open_high')::integer);
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(v_cfg -> 'invalid', '[]'::jsonb)) x(v)
              WHERE x.v ->> 'key' = 'matcher_version') THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'MATCHER_VERSION_INVALID', 'severity', 'blocking',
      'detail', (SELECT jsonb_agg(x.v) FROM jsonb_array_elements(v_cfg -> 'invalid') x(v) WHERE x.v ->> 'key' = 'matcher_version'));
  END IF;
  IF (v_cfg ->> 'worker_mode') = 'off' THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'WORKER_OFF', 'severity', 'blocking',
      'detail', 'worker_mode off: a converted pool would form no hands (set_worker_mode form)');
  ELSIF (v_cfg ->> 'worker_mode') = 'shadow' THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'WORKER_SHADOW_ONLY', 'severity', 'evidence',
      'detail', 'worker_mode shadow plans and compares and forms no hands');
  END IF;

  -- THE SHADOW: the A/A calibration of the live matcher against its port,
  -- and the candidate, from this Cluster's comparisons or else the estate's.
  v_sr := public.fn_lightning_shadow_report(g.id, v_now - interval '7 days', v_now);
  v_scope := 'cluster';
  IF jsonb_array_length(coalesce(v_sr -> 'version_pairs', '[]'::jsonb)) = 0 THEN
    v_sr := public.fn_lightning_shadow_report(NULL, v_now - interval '7 days', v_now);
    v_scope := CASE WHEN jsonb_array_length(coalesce(v_sr -> 'version_pairs', '[]'::jsonb)) = 0 THEN NULL ELSE 'estate' END;
  END IF;
  SELECT p.v INTO v_aa FROM jsonb_array_elements(coalesce(v_sr -> 'version_pairs', '[]'::jsonb)) p(v)
   WHERE p.v ->> 'live_matcher_version' = v_live_v AND coalesce((p.v ->> 'aa_calibration')::boolean, false)
   LIMIT 1;
  SELECT p.v INTO v_cand FROM jsonb_array_elements(coalesce(v_sr -> 'version_pairs', '[]'::jsonb)) p(v)
   WHERE p.v ->> 'live_matcher_version' = v_live_v AND p.v ->> 'shadow_matcher_version' = v_cfg ->> 'shadow_matcher_version'
     AND NOT coalesce((p.v ->> 'aa_calibration')::boolean, false)
   LIMIT 1;
  IF v_aa ->> 'verdict' = 'calibration_bias' THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'AA_CALIBRATION_BIAS', 'severity', 'blocking', 'detail', v_aa);
  ELSIF v_aa IS NULL OR v_aa ->> 'verdict' IS DISTINCT FROM 'calibrated' THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'NO_AA_CALIBRATION', 'severity', 'evidence',
                                                 'detail', coalesce(v_aa -> 'verdict', 'null'::jsonb));
  END IF;

  -- THE LATENCY: no leg above its ceiling over the configured windows.
  FOR v_leg IN SELECT x.k FROM jsonb_object_keys(coalesce(v_cfg -> 'alert_latency_p95_ms', '{}'::jsonb)) x(k) ORDER BY x.k LOOP
    v_reg := public.fn_lightning_latency_regression(g.id, v_leg, v_cfg, v_now);
    IF v_reg IS NOT NULL THEN
      v_over := v_over || jsonb_build_object('leg', v_leg, 'ceiling_ms', v_cfg -> 'alert_latency_p95_ms' -> v_leg,
                                             'windows', v_reg);
    END IF;
  END LOOP;
  IF jsonb_array_length(v_over) > 0 THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'LATENCY_ABOVE_CEILING', 'severity', 'blocking', 'detail', v_over);
  END IF;
  v_lat_to := (v_row -> 'latency' ->> 'window_to')::timestamptz;
  IF v_lat_to IS NULL OR v_lat_to < v_now - interval '24 hours' THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'NO_LATENCY_EVIDENCE', 'severity', 'evidence',
                                                 'detail', to_jsonb(v_lat_to));
  END IF;

  v_verdict := CASE
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_reasons) r(v) WHERE r.v ->> 'severity' = 'blocking') THEN 'no_go'
    WHEN jsonb_array_length(v_reasons) > 0 THEN 'insufficient_evidence'
    ELSE 'go' END;

  RETURN public.fn_lightning_operator_redact(jsonb_build_object(
    'ok', true,
    'cluster_id', g.id,
    'as_of', v_now,
    'verdict', v_verdict,
    'reasons', v_reasons,
    'evidence', jsonb_build_object(
      'migrations', jsonb_build_object('expected', cardinality(c_versions),
                                       'applied', cardinality(c_versions) - coalesce(cardinality(v_missing), cardinality(c_versions)),
                                       'missing', to_jsonb(v_missing)),
      'invariants', jsonb_build_object('seven_tables', v_seven, 'anti_manipulation', v_anti, 'law_10_5', v_law,
                                       'no_anon_door', v_doors, 'proofs_evaluated_in_sql', false),
      'cluster', jsonb_build_object(
        'cluster_mode', g.cluster_mode, 'lightning_enabled', coalesce(g.lightning_enabled, false),
        'game_enabled', g.enabled, 'must_move', g.must_move,
        'frozen', g.cluster_mode = 'frozen', 'paused', g.cluster_mode = 'paused',
        'drain_open', jsonb_typeof(v_row -> 'drain') = 'object',
        'worker_mode', v_cfg ->> 'worker_mode',
        'live_eligible', v_row -> 'live_eligible', 'on_threshold', v_row -> 'on_threshold',
        'off_threshold', v_row -> 'off_threshold',
        'would_turn_on', coalesce((v_row ->> 'live_eligible')::integer, 0) >= coalesce((v_row ->> 'on_threshold')::integer, 0),
        'club_is_public', v_club.is_public, 'game_is_private', g.is_private),
      'alerts', jsonb_build_object('open', v_row -> 'open_alerts'),
      'integrity', jsonb_build_object('open', v_row -> 'integrity_open_signals', 'open_high', v_row -> 'integrity_open_high'),
      'shadow', jsonb_build_object('scope', v_scope, 'aa_calibration', v_aa, 'candidate', v_cand),
      'latency', jsonb_build_object('latest_window_to', v_lat_to, 'over', v_over),
      'matcher', v_row -> 'matcher')));
END
$function$;
CREATE OR REPLACE FUNCTION public.fn_lightning_form_hand(p_cluster_id uuid, p_players uuid[], p_target_size smallint DEFAULT NULL::smallint, p_max_size smallint DEFAULT NULL::smallint, p_bb_player uuid DEFAULT NULL::uuid, p_reservation_ttl interval DEFAULT '00:00:20'::interval, p_form_window interval DEFAULT '00:00:45'::interval, p_now timestamp with time zone DEFAULT clock_timestamp(), p_matcher_version text DEFAULT NULL::text, p_request_id uuid DEFAULT NULL::uuid, p_player_platforms jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  g           record;
  v_epoch     integer;
  v_cand      uuid[];
  v_legal     uuid[];
  v_pool      jsonb;
  v_seats     jsonb;
  v_n         integer;
  v_target    smallint;
  v_max       smallint;
  v_bb        uuid;
  v_sb        uuid;
  v_btn       uuid;
  v_ok        boolean;
  v_instance  uuid;
  v_hand      uuid;
  v_before    numeric;
  v_after     numeric;
  v_sqlstate  text;
  v_msg       text;
  -- 2026-09-26: the participants' money under the FOR SHARE lock, and the
  -- versions the hand is stamped with at step 7.
  v_money_before      text;
  v_money_after       text;
  v_rules_version     text;
  v_rake_version      text;
  v_blind_version     text;
  v_lightning_version text;
  -- 2026-09-26: the replayed hand, the constraint a refusal names, and
  -- nothing else.
  v_replay    record;
  v_constraint text;
  v_alert_id  uuid;
  v_alert_error text;
  -- 20261008043021: the cross-Cluster multi-table recount.
  v_mtl       jsonb;
  v_mtl_pid   uuid;
  v_mtl_row   record;
  v_ttl       interval := GREATEST(coalesce(p_reservation_ttl, interval '20 seconds'), interval '5 seconds');
  v_window    interval := GREATEST(coalesce(p_form_window, interval '45 seconds'), interval '5 seconds');
BEGIN
  IF p_cluster_id IS NULL OR p_players IS NULL OR coalesce(array_length(p_players, 1), 0) < 2 THEN
    RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false,
                              'reason', 'no_candidate_set');
  END IF;

  -- SPECIFICATION 2139 (2026-09-26). Every hand records its matcher_version,
  -- and the matcher is the one component the database cannot see, so only the
  -- caller can say which one it is. Refused before anything is locked, read or
  -- written.
  IF p_matcher_version IS NULL OR length(btrim(p_matcher_version)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false,
                              'reason', 'matcher_version_required');
  END IF;

  -- A RETRY IS ANSWERED WITH THE HAND IT ALREADY FORMED (2026-09-26). A
  -- matcher that lost the answer to a formation - a timeout, a dropped
  -- connection - retries with the same p_request_id and is told what happened
  -- instead of forming a second hand out of the same players. Answered before
  -- the freeze, because reading what already happened is not forming a hand;
  -- two racing calls with one request id are decided by
  -- lightning_hand_one_per_request, whose violation is a retry, and the retry
  -- lands here.
  IF p_request_id IS NOT NULL THEN
    SELECT lh.hand_id, lh.cluster_id, lh.cluster_epoch, lh.lightning_instance_id, lh.player_count
      INTO v_replay FROM public.lightning_hand lh WHERE lh.request_id = p_request_id;
    IF FOUND THEN
      IF v_replay.cluster_id IS DISTINCT FROM p_cluster_id THEN
        RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false,
                                  'reason', 'request_id_belongs_to_another_cluster',
                                  'request_id', p_request_id);
      END IF;
      RETURN jsonb_build_object('ok', true, 'formed', true, 'retry', false, 'replayed', true,
        'hand_id', v_replay.hand_id, 'instance_id', v_replay.lightning_instance_id,
        'cluster_id', v_replay.cluster_id, 'cluster_epoch', v_replay.cluster_epoch,
        'players', v_replay.player_count,
        'bb', (SELECT hp.player_id FROM public.lightning_hand_player hp
                WHERE hp.hand_id = v_replay.hand_id AND hp.blind_role = 'bb'),
        'sb', (SELECT hp.player_id FROM public.lightning_hand_player hp
                WHERE hp.hand_id = v_replay.hand_id AND hp.blind_role = 'sb'),
        'btn', (SELECT hp.player_id FROM public.lightning_hand_player hp
                 WHERE hp.hand_id = v_replay.hand_id AND hp."position" = 'btn'),
        'seats', (SELECT jsonb_agg(jsonb_build_object(
                           'player_id', hp.player_id, 'pool_slot_id', hp.pool_slot_id,
                           'pool_session_id', sl.pool_session_id, 'stack_before', hp.stack_before,
                           'seat', hp.seat, 'position', hp."position", 'blind_role', hp.blind_role)
                         ORDER BY hp.seat)
                    FROM public.lightning_hand_player hp
                    JOIN public.lightning_pool_slot sl ON sl.id = hp.pool_slot_id
                   WHERE hp.hand_id = v_replay.hand_id),
        'state', (SELECT li.state FROM public.lightning_instance li
                   WHERE li.id = v_replay.lightning_instance_id),
        'request_id', p_request_id);
    END IF;
  END IF;

  -- theFreezeIsTotal. Forming a hand during the maintenance break is exactly
  -- what the freeze forbids; releasing one is not, which is why
  -- fn_lightning_reap_formations and fn_lightning_instance_abandon are not
  -- gated and this is.
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', true,
                              'reason', 'platform_frozen');
  END IF;

  -- CONTENTION IS A RETRY, NOT A CRASH (2026-09-26). From here to the end of
  -- the function the barrier waits on locks - the Cluster row, the slots, the
  -- participants' pool sessions, the reap - and the estate sets lock_timeout.
  -- This sub-block catches lock_not_available, deadlock_detected and
  -- serialization_failure, and only those, rolls the whole formation back and
  -- answers formation_contended with a matcher_retry. It does NOT catch
  -- query_canceled: a cancel belongs to whoever asked for it, and the header of
  -- 20260926023047 says why.
  BEGIN

  -- THE CLUSTER ROW IS TAKEN FOR UPDATE BEFORE THE EPOCH IS READ, which
  -- serialises formation against fn_cash_cluster_commit_lightning's own
  -- FOR UPDATE on the same row. Without it "the epoch I bound is the epoch the
  -- Cluster is in" is likely rather than true, and a conversion landing
  -- between the read and the INSERT would bind a hand to an epoch that no
  -- longer exists.
  SELECT id, cluster_mode, lightning_enabled, cluster_epoch, handedness
    INTO g FROM public.cash_games WHERE id = p_cluster_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false, 'reason', 'not_found');
  END IF;
  IF g.cluster_mode IS DISTINCT FROM 'lightning'
     OR coalesce(g.lightning_enabled, false) = false THEN
    RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false,
                              'reason', 'cluster_is_not_lightning',
                              'cluster_mode', g.cluster_mode,
                              'lightning_enabled', coalesce(g.lightning_enabled, false));
  END IF;
  v_epoch := g.cluster_epoch;
  IF NOT EXISTS (SELECT 1 FROM public.cash_cluster_epoch e
                  WHERE e.cluster_id = g.id AND e.epoch = v_epoch AND e.ended_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false,
                              'reason', 'epoch_is_not_open', 'cluster_epoch', v_epoch);
  END IF;

  -- THE NEXT FORMATION BURIES THE LAST ONE'S CORPSE (2026-09-26). DECISION 2 of
  -- 20260925215731 said this and put it in fn_lightning_instance_open, which no
  -- formation path calls. It is here now, under the Cluster row lock and before
  -- the INSERT below, so a player it hands back is a legal candidate in this
  -- same call. The reaper clamps its clock to clock_timestamp().
  PERFORM public.fn_lightning_reap_formations(p_now, 200, g.id);

  -- SPECIFICATION 2137-2143: THE VERSIONS THIS HAND IS FORMED UNDER, read now,
  -- under the same Cluster row lock that binds its epoch. The header of
  -- 20260926023047 says why each comes from where it does.
  SELECT 'ruleset:' || md5(coalesce(cg.ruleset_snapshot, '{}'::jsonb)::text),
         'rake:' || md5(coalesce(cg.ruleset_snapshot -> 'rake', 'null'::jsonb)::text)
    INTO v_rules_version, v_rake_version
    FROM public.cash_games cg WHERE cg.id = g.id;
  SELECT 'fn_lightning_blind_order:' || md5(p.prosrc) INTO v_blind_version
    FROM pg_catalog.pg_proc p
   WHERE p.oid = 'public.fn_lightning_blind_order(uuid,integer,uuid[])'::regprocedure;
  SELECT 'fn_lightning_form_hand:' || md5(p.prosrc) INTO v_lightning_version
    FROM pg_catalog.pg_proc p
   WHERE p.oid = 'public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)'::regprocedure;

  -- THE MONEY GUARD NO LONGER MEASURES THE WHOLE POOL (2026-09-26). It read
  -- every pool session of the Cluster in two READ COMMITTED statements under no
  -- lock, so any commit anywhere in the Cluster between them looked like this
  -- formation moving money. It measures the participants now, under the
  -- FOR SHARE lock step 1 takes; see v_money_before below.

  -- The caller's order is the matcher's order and is preserved exactly;
  -- duplicates are collapsed to their first mention rather than silently
  -- seating somebody twice.
  v_cand := ARRAY(SELECT x.pid FROM (
              SELECT u.pid, min(u.ord) AS ord
                FROM unnest(p_players) WITH ORDINALITY AS u(pid, ord)
               WHERE u.pid IS NOT NULL
               GROUP BY u.pid) x ORDER BY x.ord);

  -- THE ANCHOR SEATS, FOR SHARE, FIRST (2026-09-26). The seat is the economic
  -- anchor and fn_lightning_pool_stack reads it, so from here to commit
  -- nothing may change a candidate's seat stack, departure or occupant - and
  -- they are taken BEFORE the slots and the pool sessions, because the
  -- deferred table_seats trigger that exits a departing anchor holds that seat
  -- and then writes its session and slot: a formation that already held those
  -- and waited on the seat would close the cycle. In seat id order, so two
  -- matchers queue rather than deadlock.
  PERFORM 1 FROM public.table_seats ts
   WHERE ts.id IN (SELECT ps.anchor_seat_id
                     FROM public.lightning_pool_slot sl
                     JOIN public.lightning_pool_session ps ON ps.id = sl.pool_session_id
                    WHERE sl.cluster_id = g.id AND sl.cluster_epoch = v_epoch
                      AND sl.closed_at IS NULL AND sl.player_id = ANY (v_cand))
   ORDER BY ts.id
   FOR SHARE;

  -- BARRIER STEP 1, AND THE LOCK THAT MAKES IT MEAN SOMETHING. The slots are
  -- taken FOR UPDATE in player_id order - a fixed order, so two matchers
  -- racing for an overlapping candidate set queue rather than deadlock.
  PERFORM 1 FROM public.lightning_pool_slot sl
   WHERE sl.cluster_id = g.id AND sl.cluster_epoch = v_epoch
     AND sl.closed_at IS NULL AND sl.player_id = ANY (v_cand)
   ORDER BY sl.player_id
   FOR UPDATE;

  -- AND THEIR POOL SESSIONS, FOR SHARE (2026-09-26), in pool session id order
  -- and BEFORE a single stack is read. From here to commit no other
  -- transaction can change a candidate's starting_stack, net_result,
  -- ending_stack or exited_at, so the stack_before snapshotted below is the
  -- stack that is still there when the hand commits, and the money guard at the
  -- end measures what THIS transaction did and nothing else. A settlement
  -- writing to one of these players waits for the formation, which is
  -- milliseconds.
  PERFORM 1 FROM public.lightning_pool_session ps
   WHERE ps.id IN (SELECT sl.pool_session_id FROM public.lightning_pool_slot sl
                    WHERE sl.cluster_id = g.id AND sl.cluster_epoch = v_epoch
                      AND sl.closed_at IS NULL AND sl.player_id = ANY (v_cand))
   ORDER BY ps.id
   FOR SHARE;

  -- P0 LEGALITY, and there is no is_horse in it. Law 10.5: a horse is a
  -- player. A candidate is legal when they hold an open pool slot at THIS
  -- Cluster and THIS epoch, an open and active pool session, a strictly
  -- positive stack - a player who cannot post is not a legal candidate - and
  -- no reservation anybody else is already holding.
  SELECT coalesce(array_agg(q.pid), ARRAY[]::uuid[]) INTO v_legal FROM (
    SELECT sl.player_id AS pid
      FROM public.lightning_pool_slot sl
      JOIN public.lightning_pool_session ps ON ps.id = sl.pool_session_id
     WHERE sl.cluster_id = g.id AND sl.cluster_epoch = v_epoch AND sl.closed_at IS NULL
       AND sl.player_id = ANY (v_cand)
       AND ps.cluster_id = g.id AND ps.cluster_epoch = v_epoch
       AND ps.exited_at IS NULL AND ps.state = 'active'
       AND public.fn_lightning_pool_stack(ps.id) > 0
       -- THE SAME QUESTION THE POPULATION ASKS (2026-09-26): the anchor seat is
       -- live eligible - not left, not sitting out, not leaving, chips on it,
       -- at a live table of this Cluster, held by this player - and the cash
       -- session the pool session is subordinate to is still open.
       AND public.fn_lightning_anchor_is_live_eligible(ps.anchor_seat_id, g.id, ps.player_id)
       AND EXISTS (SELECT 1 FROM public.cash_player_session cps
                    WHERE cps.id = ps.cash_player_session_id AND cps.closed_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM public.lightning_reservation r
                        WHERE r.cluster_id = sl.cluster_id AND r.player_id = sl.player_id
                          AND r.state IN ('pending', 'committed'))
  ) q;

  -- AND THE P2 ORDER COMES FROM THE ONE FUNCTION THAT OWNS THE KEY. An earlier
  -- cut of this file wrote the ordering out a second time here, and the two
  -- copies were then two places for the key to drift - which a mutation run
  -- caught by changing one of them and watching nothing go red, because the
  -- other was the one that mattered. fn_lightning_blind_order is now the only
  -- expression of specification 601-608 in the database, and this is its
  -- caller.
  SELECT jsonb_agg(jsonb_build_object(
           'player_id',       bo.player_id,
           'pool_slot_id',    bo.pool_slot_id,
           'pool_session_id', sl.pool_session_id,
           'stack',           public.fn_lightning_pool_stack(sl.pool_session_id),
           'bb_unresolved',   bo.bb_unresolved,
           'last_bb_at',      bo.last_bb_at,
           'debt_age',        bo.debt_age,
           'entered_pool',    bo.entered_pool,
           'caller_rank',     o.ord)
         ORDER BY bo.p2_rank)
    INTO v_pool
    FROM public.fn_lightning_blind_order(g.id, v_epoch, v_legal) bo
    JOIN public.lightning_pool_slot sl ON sl.id = bo.pool_slot_id
    JOIN unnest(v_cand) WITH ORDINALITY AS o(pid, ord) ON o.pid = bo.player_id;

  v_n      := coalesce(jsonb_array_length(v_pool), 0);
  v_target := coalesce(p_target_size, GREATEST(2, LEAST(6, coalesce(g.handedness, 6)))::smallint);
  v_max    := coalesce(p_max_size, GREATEST(v_target, LEAST(9, coalesce(g.handedness, 6))::smallint));
  IF v_max < v_target THEN v_max := v_target; END IF;
  IF v_target < 2 THEN v_target := 2; END IF;
  IF v_max > 9 THEN v_max := 9; END IF;

  IF v_n < v_target THEN
    -- SPECIFICATION 733. Nothing was taken, so there is nothing to release -
    -- but the retry still has to be VISIBLE, or a matcher spinning on a pool
    -- that can never fill leaves no trace anywhere.
    INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
    VALUES (g.id, 'lightning_matcher_retry', jsonb_build_object(
      'reason', 'insufficient_legal_candidates', 'offered', array_length(v_cand, 1),
      'legal', v_n, 'target_size', v_target, 'at', p_now), v_epoch, p_request_id);
    RETURN jsonb_build_object('ok', true, 'formed', false, 'retry', true,
                              'reason', 'insufficient_legal_candidates',
                              'offered', array_length(v_cand, 1), 'legal', v_n,
                              'target_size', v_target);
  END IF;

  -- OVER-SUPPLY IS TRIMMED ALONG THE P2 KEY, not along the caller's order, so
  -- the player most owed a big blind is never the one dropped.
  IF v_n > v_max THEN
    SELECT jsonb_agg(z.e ORDER BY z.ord) INTO v_pool
      FROM (SELECT e, ord FROM jsonb_array_elements(v_pool) WITH ORDINALITY t(e, ord)) z
     WHERE z.ord <= v_max;
    v_n := v_max;
  END IF;

  -- BARRIER STEP 5, FIRST HALF, AND THE ONE P2 RULE THAT HAS TO LIVE DOWN
  -- HERE. The barrier's own choice is the P2-maximal candidate. A matcher may
  -- override it, and may not override it with somebody P2 could never have
  -- chosen: p_bb_player is accepted only if it ties on the WHOLE key -
  -- unresolved obligation, last_bb_at, blind-debt age - with the candidate the
  -- barrier would have taken.
  v_bb := (v_pool -> 0 ->> 'player_id')::uuid;
  IF p_bb_player IS NOT NULL AND p_bb_player IS DISTINCT FROM v_bb THEN
    -- AND POOL ENTRY (2026-09-26), P2 tie-break 3. Without it a matcher could
    -- name a player who loses on pool entry. The only freedom left is among
    -- players P2 cannot tell apart except by id, and the id is a tie-break for
    -- determinism, not a fairness rule.
    SELECT ((e -> 'bb_unresolved'), (e -> 'last_bb_at'), (e -> 'debt_age'), (e -> 'entered_pool'))
           IS NOT DISTINCT FROM
           ((v_pool -> 0 -> 'bb_unresolved'), (v_pool -> 0 -> 'last_bb_at'), (v_pool -> 0 -> 'debt_age'),
            (v_pool -> 0 -> 'entered_pool'))
      INTO v_ok
      FROM jsonb_array_elements(v_pool) e
     WHERE (e ->> 'player_id')::uuid = p_bb_player;
    IF NOT coalesce(v_ok, false) THEN
      RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false,
                                'reason', 'bb_choice_is_not_p2_legal',
                                'asked_for', p_bb_player, 'p2_would_choose', v_bb);
    END IF;
    v_bb := p_bb_player;
  END IF;

  SELECT (t.e ->> 'player_id')::uuid INTO v_sb
    FROM jsonb_array_elements(v_pool) WITH ORDINALITY t(e, ord)
   WHERE (t.e ->> 'player_id')::uuid IS DISTINCT FROM v_bb
   ORDER BY t.ord LIMIT 1;

  -- BARRIER STEPS 3, 4, 5 AND 6 AS ONE MAP. Seat 1 is the small blind, seat 2
  -- the big blind, and seats 3..n are filled IN THE ORDER THE CALLER GAVE
  -- THEM: P3 position fairness is advisory and the matcher's, and a barrier
  -- that re-sorted those seats would be quietly overruling it. Heads-up, seat
  -- 1 is the button and posts the small blind, which is why blind_role and
  -- position are separate columns.
  SELECT jsonb_agg(jsonb_build_object(
           'player_id',       s.pid,
           'pool_slot_id',    (s.e ->> 'pool_slot_id')::uuid,
           'pool_session_id', (s.e ->> 'pool_session_id')::uuid,
           'stack_before',    (s.e ->> 'stack')::numeric,
           'seat',            s.seat,
           'position', CASE WHEN v_n = 2 AND s.seat = 1 THEN 'btn'
                            WHEN v_n = 2                THEN 'bb'
                            WHEN s.seat = 1             THEN 'sb'
                            WHEN s.seat = 2             THEN 'bb'
                            WHEN s.seat = v_n           THEN 'btn'
                            WHEN s.seat = v_n - 1       THEN 'co'
                            WHEN s.seat = v_n - 2       THEN 'hj'
                            -- SEVEN, EIGHT AND NINE HANDED (2026-09-26). Every
                            -- seat below the hijack used to be utg, so an
                            -- eight-handed hand had three players under the
                            -- gun and three utg_counts moved. Exactly one now.
                            WHEN s.seat = 3             THEN 'utg'
                            WHEN s.seat = v_n - 3       THEN 'lj'
                            WHEN s.seat = 4             THEN 'utg1'
                            ELSE 'utg2' END,
           'blind_role', CASE WHEN s.seat = 1 THEN 'sb'
                              WHEN s.seat = 2 THEN 'bb'
                              ELSE 'none' END)
         ORDER BY s.seat)
    INTO v_seats
    FROM (
      SELECT r.e, r.pid,
             (CASE WHEN r.pid = v_bb THEN 2
                   WHEN r.pid = v_sb THEN 1
                   ELSE 2 + row_number() OVER (PARTITION BY (r.pid IN (v_bb, v_sb))
                                               ORDER BY r.crank) END)::smallint AS seat
        FROM (SELECT t.e, (t.e ->> 'player_id')::uuid AS pid, (t.e ->> 'caller_rank')::integer AS crank
                FROM jsonb_array_elements(v_pool) t(e)) r
    ) s;

  SELECT (x ->> 'player_id')::uuid INTO v_btn
    FROM jsonb_array_elements(v_seats) x WHERE x ->> 'position' = 'btn';

  -- F12'S SHAPE, MEASURED OVER THE PARTICIPANTS (2026-09-26). Every money
  -- column of every participant's pool session, ordered, as text - not a sum,
  -- so two stacks that swapped are a difference too. These rows are held
  -- FOR SHARE since step 1, so nothing but this transaction can change them
  -- before the comparison at the end.
  SELECT string_agg(ps.id || ':' || coalesce(ps.starting_stack::text, 'null')
                    || ':' || coalesce(ps.net_result::text, 'null')
                    || ':' || coalesce(ps.ending_stack::text, 'null')
                    || ':' || coalesce(ps.exited_at::text, 'open')
                    || ':' || coalesce((SELECT ts.stack::text || '@' || coalesce(ts.left_at::text, 'seated')
                                          || '@' || coalesce(ts.user_id::text, 'empty')
                                          FROM public.table_seats ts WHERE ts.id = ps.anchor_seat_id), 'no_anchor'),
                    '|' ORDER BY ps.id)
    INTO v_money_before
    FROM public.lightning_pool_session ps
   WHERE ps.id IN (SELECT (x ->> 'pool_session_id')::uuid FROM jsonb_array_elements(v_seats) x);

  v_hand := gen_random_uuid();

  -- =========================================================================
  -- THE ATOMIC BLOCK. Everything below either all happens or none of it does.
  -- An exception here rolls back to this block's implicit savepoint, and the
  -- instance, the reservations, the hand and the participants cease to have
  -- ever existed - which is a stronger form of specification 728-731 than
  -- releasing them would be, because there is nothing left to release, nothing
  -- to reap, and the players' pool state is restored by never having changed.
  -- The exception list is CLOSED: anything that is not one of these eight
  -- classes propagates and aborts the caller, because a barrier that swallows
  -- every error is a pool that silently stops dealing with no row saying why.
  -- =========================================================================
  BEGIN
    INSERT INTO public.lightning_instance
      (cluster_id, cluster_epoch, state, target_size, max_size, created_at, deadline_at)
    VALUES (g.id, v_epoch, 'forming', v_target, v_max, p_now, p_now + v_window)
    RETURNING id INTO v_instance;

    -- STEPS 2 AND 3: the player reservation and the seat reservation are one
    -- row, because they are one claim. lightning_reservation_one_active_per_-
    -- player is what refuses a second matcher holding the same person;
    -- lightning_reservation_one_seat_per_instance is what refuses two people
    -- holding the same seat. Both are indexes, so both are decided by the
    -- database at INSERT time rather than by a read anybody can lose a race to.
    INSERT INTO public.lightning_reservation
      (cluster_id, cluster_epoch, player_id, pool_slot_id, lightning_instance_id,
       seat_number, state, created_at, expires_at)
    SELECT g.id, v_epoch, (x ->> 'player_id')::uuid, (x ->> 'pool_slot_id')::uuid,
           v_instance, (x ->> 'seat')::smallint, 'pending', p_now, p_now + v_ttl
      FROM jsonb_array_elements(v_seats) x;

    -- STEP 7: the immutable hand id, and STEPS 8 AND 9: the instance and the
    -- epoch it is bound to. The hand is born UNLOCKED - the latch goes on
    -- after the participants are in, which is what makes step 10 a step.
    INSERT INTO public.lightning_hand
      (hand_id, cluster_id, cluster_epoch, lightning_instance_id, formed_at,
       rules_version, matcher_version, blind_algorithm_version, lightning_version, rake_version,
       request_id)
    VALUES (v_hand, g.id, v_epoch, v_instance, p_now,
            v_rules_version, btrim(p_matcher_version), v_blind_version, v_lightning_version, v_rake_version,
            p_request_id);

    -- STEPS 4, 5 AND 6: positions, blind roles and the stack snapshot.
    INSERT INTO public.lightning_hand_player
      (hand_id, player_id, pool_slot_id, seat, "position", blind_role, stack_before,
       fold_type, cluster_id, cluster_epoch)
    SELECT v_hand, (x ->> 'player_id')::uuid, (x ->> 'pool_slot_id')::uuid,
           (x ->> 'seat')::smallint, (x ->> 'position'), (x ->> 'blind_role'),
           (x ->> 'stack_before')::numeric, 'none', g.id, v_epoch
      FROM jsonb_array_elements(v_seats) x;

    -- STEP 10. The latch and its count move in one statement, and
    -- trg_lightning_hand_is_immutable refuses the statement unless the count
    -- matches the rows that are actually there.
    UPDATE public.lightning_hand h
       SET participants_locked_at = p_now, player_count = v_n::smallint
     WHERE h.hand_id = v_hand;

    UPDATE public.lightning_reservation r
       SET state = 'committed', resolved_at = p_now
     WHERE r.lightning_instance_id = v_instance AND r.state = 'pending';

    -- 20261008043021: THE MULTI-TABLE LIMIT HOLDS ACROSS CLUSTERS AT THE
    -- MOMENT IT MATTERS. P0 (fn_lightning_player_legality) counts a player's
    -- live committed reservations, but each Cluster's pass serialises only on
    -- its own Cluster, so k Clusters forming in the same instant could each
    -- admit the same player and a mobile limit of 2 could end with 4 live
    -- hands. The barrier therefore takes one transaction advisory lock per
    -- participant, in sorted player-id order, AFTER the committed
    -- reservations above are written, and recounts each participant's live
    -- committed reservations across every Cluster against that participant's
    -- platform limit (p_player_platforms as the matcher passes it; an
    -- unreported platform is the NARROWEST limit, mobile, exactly as P0 now
    -- defaults it). Two barriers racing for one player queue on the player's
    -- lock, and the one that waited counts the winner's committed rows in a
    -- fresh statement snapshot, so exactly one wins.
    --
    -- LOCK ORDER, AND WHY THIS CANNOT DEADLOCK AGAINST THE ANCHOR-SEAT
    -- LOCKING. These advisory locks are taken AFTER every row lock this
    -- function holds, always in sorted player-id order. Two formations in the
    -- SAME Cluster are serialised by the cash_games row taken FOR UPDATE
    -- before any seat, slot or session lock, so they never hold these locks
    -- concurrently. Two formations in DIFFERENT Clusters share no row lock at
    -- all - the Cluster row, the anchor seats, the slots, the pool sessions,
    -- the instance and the events they touch are rows of their own Cluster -
    -- so the only resource two of them can both want is this one advisory
    -- lock class, and a fixed sorted order within one lock class cannot
    -- cycle.
    FOR v_mtl_pid IN
      SELECT DISTINCT (x ->> 'player_id')::uuid FROM jsonb_array_elements(v_seats) x ORDER BY 1
    LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended('lightning_player:' || v_mtl_pid::text, 0));
    END LOOP;
    v_mtl := public.fn_lightning_config(g.id) -> 'multi_table_limit';
    SELECT q.pid, q.live, q.platform, q.limit_n INTO v_mtl_row FROM (
      SELECT p.pid,
             (SELECT count(DISTINCT r.cluster_id)
                FROM public.lightning_reservation r
                JOIN public.lightning_instance i ON i.id = r.lightning_instance_id
               WHERE r.player_id = p.pid AND r.state = 'committed'
                 AND i.state IN ('forming', 'reserved', 'dealing', 'settling')) AS live,
             p.platform,
             coalesce((v_mtl ->> p.platform)::integer, 2) AS limit_n
        FROM (SELECT DISTINCT (x ->> 'player_id')::uuid AS pid,
                     CASE WHEN (p_player_platforms ->> (x ->> 'player_id')) IN ('desktop', 'tablet', 'mobile')
                          THEN p_player_platforms ->> (x ->> 'player_id') ELSE 'mobile' END AS platform
                FROM jsonb_array_elements(v_seats) x) p) q
     WHERE q.live > q.limit_n
     ORDER BY q.pid LIMIT 1;
    IF FOUND THEN
      -- A NORMAL RETRYABLE REFUSAL: 40001 is in this block's retry class, so
      -- the whole formation rolls back - the instance, the hand and every
      -- reservation it wrote cease to exist, which is how its reservations
      -- are released - and the matcher replans, where P0 now sees the winning
      -- Cluster's committed reservation and refuses the player as
      -- MULTI_TABLE_LIMIT.
      RAISE EXCEPTION 'LIGHTNING_MULTI_TABLE_LIMIT: player % would hold % live Lightning hands against a % limit of %',
        v_mtl_row.pid, v_mtl_row.live, v_mtl_row.platform, v_mtl_row.limit_n
        USING ERRCODE = '40001';
    END IF;

    UPDATE public.lightning_instance li
       SET hand_id = v_hand, state = 'reserved', deadline_at = p_now + v_window
     WHERE li.id = v_instance;

    -- P2 BOOKKEEPING, AND NOT ONE COLUMN OF IT IS MONEY. last_bb_at is what
    -- makes the next formation pick somebody else; without this stamp the same
    -- player is the big blind of every hand for ever. missed_bb_debt, bb_owed
    -- and sb_owed are obligations created when a blind is DUE and discharged
    -- when it is POSTED, and posting is barrier step 12, which is the engine's.
    UPDATE public.lightning_pool_slot sl
       SET last_bb_at     = CASE WHEN sl.player_id = v_bb  THEN p_now ELSE sl.last_bb_at END,
           last_sb_at     = CASE WHEN sl.player_id = v_sb  THEN p_now ELSE sl.last_sb_at END,
           last_button_at = CASE WHEN sl.player_id = v_btn THEN p_now ELSE sl.last_button_at END,
           hands_since_bb = CASE WHEN sl.player_id = v_bb  THEN 0 ELSE sl.hands_since_bb + 1 END,
           hands_since_sb = CASE WHEN sl.player_id = v_sb  THEN 0 ELSE sl.hands_since_sb + 1 END,
           updated_at     = p_now
     WHERE sl.id IN (SELECT hp.pool_slot_id FROM public.lightning_hand_player hp
                      WHERE hp.hand_id = v_hand);

    INSERT INTO public.lightning_blind_ledger
      (cluster_id, player_id, bb_count, sb_count, btn_count, utg_count, hj_count, co_count,
       first_seen_at, updated_at)
    SELECT g.id, hp.player_id,
           (coalesce(hp.blind_role, 'none') = 'bb')::integer,
           (coalesce(hp.blind_role, 'none') = 'sb')::integer,
           (coalesce(hp."position", '') = 'btn')::integer,
           (coalesce(hp."position", '') = 'utg')::integer,
           (coalesce(hp."position", '') = 'hj')::integer,
           (coalesce(hp."position", '') = 'co')::integer,
           p_now, p_now
      FROM public.lightning_hand_player hp WHERE hp.hand_id = v_hand
    ON CONFLICT (cluster_id, player_id) DO UPDATE SET
      bb_count   = public.lightning_blind_ledger.bb_count   + EXCLUDED.bb_count,
      sb_count   = public.lightning_blind_ledger.sb_count   + EXCLUDED.sb_count,
      btn_count  = public.lightning_blind_ledger.btn_count  + EXCLUDED.btn_count,
      utg_count  = public.lightning_blind_ledger.utg_count  + EXCLUDED.utg_count,
      hj_count   = public.lightning_blind_ledger.hj_count   + EXCLUDED.hj_count,
      co_count   = public.lightning_blind_ledger.co_count   + EXCLUDED.co_count,
      updated_at = EXCLUDED.updated_at;

    -- THE BARRIER'S OWN PRE-COMMIT RE-CHECKS. Each is a state the locks above
    -- make impossible, so each raises PLT02, LIGHTNING_FORMATION_INVARIANT
    -- (2026-09-26), which the handler below does NOT retry: it rolls the block
    -- back, freezes the Cluster and writes the evidence.
    IF (SELECT count(*) FROM public.lightning_hand_player hp WHERE hp.hand_id = v_hand) <> v_n THEN
      RAISE EXCEPTION 'LIGHTNING_FORMATION_SET_IS_WRONG: hand % was formed for % players and holds %',
        v_hand, v_n, (SELECT count(*) FROM public.lightning_hand_player hp WHERE hp.hand_id = v_hand)
        USING ERRCODE = 'PLT02';
    END IF;
    IF (SELECT count(*) FROM public.lightning_reservation r
         WHERE r.lightning_instance_id = v_instance AND r.state = 'committed') <> v_n THEN
      RAISE EXCEPTION 'LIGHTNING_FORMATION_SET_IS_WRONG: hand % has % committed reservations for % seats',
        v_hand, (SELECT count(*) FROM public.lightning_reservation r
                  WHERE r.lightning_instance_id = v_instance AND r.state = 'committed'), v_n
        USING ERRCODE = 'PLT02';
    END IF;
    IF (SELECT count(*) FROM public.lightning_hand_player hp
         WHERE hp.hand_id = v_hand AND hp.blind_role = 'bb') <> 1
       OR (SELECT count(*) FROM public.lightning_hand_player hp
            WHERE hp.hand_id = v_hand AND hp.blind_role = 'sb') <> 1
       OR (SELECT count(*) FROM public.lightning_hand_player hp
            WHERE hp.hand_id = v_hand AND hp."position" = 'btn') <> 1 THEN
      RAISE EXCEPTION 'LIGHTNING_FORMATION_SET_IS_WRONG: hand % does not have exactly one big blind, one small blind and one button',
        v_hand USING ERRCODE = 'PLT02';
    END IF;
    IF EXISTS (SELECT 1 FROM public.lightning_hand_player hp
                WHERE hp.hand_id = v_hand
                  AND (hp.stack_before IS NULL OR hp.stack_before <= 0)) THEN
      RAISE EXCEPTION 'LIGHTNING_FORMATION_SET_IS_WRONG: hand % seated a player with no stack to post from',
        v_hand USING ERRCODE = 'PLT02';
    END IF;

    -- F12'S SHAPE, ONE PHASE ON (moved inside the block 2026-09-26). Every
    -- money column of every participant's pool session AND its anchor seat,
    -- which are held FOR SHARE, compared with the snapshot taken before the
    -- first write.
    SELECT string_agg(ps.id || ':' || coalesce(ps.starting_stack::text, 'null')
                      || ':' || coalesce(ps.net_result::text, 'null')
                      || ':' || coalesce(ps.ending_stack::text, 'null')
                      || ':' || coalesce(ps.exited_at::text, 'open')
                      || ':' || coalesce((SELECT ts.stack::text || '@' || coalesce(ts.left_at::text, 'seated')
                                            || '@' || coalesce(ts.user_id::text, 'empty')
                                            FROM public.table_seats ts WHERE ts.id = ps.anchor_seat_id), 'no_anchor'),
                      '|' ORDER BY ps.id)
      INTO v_money_after
      FROM public.lightning_pool_session ps
     WHERE ps.id IN (SELECT (x ->> 'pool_session_id')::uuid FROM jsonb_array_elements(v_seats) x);
    IF v_money_after IS DISTINCT FROM v_money_before THEN
      RAISE EXCEPTION 'LIGHTNING_FORMATION_MOVED_MONEY: the pool sessions or anchor seats of the % participants of hand % in Cluster % were rewritten while it was formed (% became %), and forming a hand is a seating transition, not an economic transaction',
        v_n, v_hand, g.id, v_money_before, v_money_after USING ERRCODE = 'PLT02';
    END IF;

  EXCEPTION
    WHEN unique_violation OR check_violation OR foreign_key_violation OR not_null_violation OR SQLSTATE 'PLT02'
      OR exclusion_violation
      -- THE RETRYABLE CLASSES (2026-09-26). A lock wait past lock_timeout, a
      -- deadlock victim and a serialization failure are exactly what
      -- specification 732-733 means by "retry where safe": this block is
      -- rolled back whole and the caller retries in a fresh transaction.
      OR lock_not_available OR deadlock_detected OR serialization_failure THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT,
                              v_constraint = CONSTRAINT_NAME;
      -- ONLY A RACE IS RETRIED (2026-09-26). A lock timeout, a deadlock victim,
      -- a serialization failure, and a unique violation on one of the indexes
      -- two matchers can genuinely race for, are what specification 732-733
      -- means by "retry where safe". Everything else that lands here - the
      -- barrier's own PLT02 re-checks, the immutability and discipline
      -- triggers, a CHECK, a foreign key, a unique index nobody races for - is
      -- a state the locks this function holds make impossible. Retrying it
      -- would form the same wrong hand again, so it is not retried: the block
      -- is already rolled back, the Cluster is frozen through its own
      -- cluster_mode (the row is held FOR UPDATE since the start, and every
      -- formation, opening and deal refuses a Cluster that is not lightning),
      -- and the evidence is written in the two events an operator will look
      -- for.
      IF NOT (v_sqlstate IN ('55P03', '40P01', '40001')
              OR (v_sqlstate = '23505' AND v_constraint IN (
                    'lightning_reservation_one_active_per_player',
                    'lightning_reservation_one_pending_per_slot',
                    'lightning_reservation_one_seat_per_instance',
                    'lightning_reservation_one_seat_per_player_instance',
                    'lightning_pool_slot_one_open',
                    'lightning_pool_slot_one_open_per_player',
                    'lightning_hand_one_per_request'))) THEN
        UPDATE public.cash_games cg
           SET cluster_mode = 'frozen', updated_at = now()
         WHERE cg.id = g.id AND cg.cluster_mode = 'lightning';
        -- THE PAGE. The estate's operator alert path: a critical
        -- financial_alerts row, which the incident trigger turns into an
        -- incident, deduplicated per Cluster. In its own sub-block, so that an
        -- alert that cannot be written costs the page and never the freeze;
        -- its failure is recorded in the freeze's own evidence instead.
        BEGIN
          v_alert_id := public.fn_raise_server_financial_alert(
            'critical', 'lightning_formation',
            format('LIGHTNING_CLUSTER_FROZEN: Cluster %s froze at epoch %s on %s: %s', g.id, v_epoch, v_sqlstate, v_msg),
            jsonb_build_object('cluster_id', g.id, 'cluster_epoch', v_epoch, 'hand_id', v_hand,
                               'sqlstate', v_sqlstate, 'constraint', v_constraint,
                               'recovery', 'fn_cash_cluster_unfreeze(cluster_id, operator, reason)'),
            'lightning_cluster_frozen:' || g.id, g.id::text);
        EXCEPTION WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS v_alert_error = MESSAGE_TEXT;
        END;
        INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
        VALUES
          (g.id, 'stack_invariant_failed', jsonb_build_object(
             'cluster_id', g.id, 'cluster_epoch', v_epoch,
             'hand_id', v_hand, 'instance_id', v_instance,
             'sqlstate', v_sqlstate, 'message', v_msg, 'constraint', v_constraint,
             'players', (SELECT jsonb_agg(x -> 'player_id' ORDER BY (x ->> 'seat')::integer)
                           FROM jsonb_array_elements(v_seats) x),
             'seats', v_seats, 'money_before', v_money_before, 'money_after', v_money_after,
             'matcher_version', btrim(p_matcher_version), 'at', p_now), v_epoch, p_request_id),
          (g.id, 'cluster_frozen', jsonb_build_object(
             'cluster_id', g.id, 'cluster_epoch', v_epoch, 'from_mode', 'lightning', 'to_mode', 'frozen',
             'reason', 'stack_invariant_failed', 'sqlstate', v_sqlstate, 'message', v_msg,
             'hand_id', v_hand, 'instance_id', v_instance, 'alert_id', v_alert_id, 'alert_error', v_alert_error,
             'at', clock_timestamp()), v_epoch, p_request_id);
        RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false, 'frozen', true,
                                  'reason', 'formation_invariant_failed',
                                  'sqlstate', v_sqlstate, 'message', v_msg, 'constraint', v_constraint,
                                  'cluster_id', g.id, 'cluster_epoch', v_epoch,
                                  'alerted', v_alert_id IS NOT NULL);
      END IF;
      -- Everything above is now rolled back. This INSERT is in the OUTER
      -- block, after the rollback, and is the only thing that survives it:
      -- specification 733's matcher_retry, carrying what refused and why.
      INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
      VALUES (g.id, 'lightning_matcher_retry', jsonb_build_object(
        'reason', 'formation_refused', 'sqlstate', v_sqlstate, 'message', v_msg,
        'players', v_n, 'target_size', v_target, 'at', p_now), v_epoch, p_request_id);
      RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', true,
                                'reason', 'formation_refused',
                                'sqlstate', v_sqlstate, 'message', v_msg);
  END;

  -- F12'S SHAPE, ONE PHASE ON, is measured INSIDE the atomic block since
  -- 2026-09-26, so that money moving during a formation is caught as the
  -- impossible state it is: rolled back, the Cluster frozen and the evidence
  -- written, rather than an uncaught error that leaves no row saying why.

  -- THE EVENTS OF A FORMED HAND (2026-09-26): the instance that was created,
  -- ONE reservation event carrying every player it holds, and the hand with
  -- every participant's seat, position and blind role. hand_created replaces
  -- the kind 20260925215731 wrote here, which nothing outside the Phase 9
  -- harness read.
  INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
  VALUES
    (g.id, 'instance_created', jsonb_build_object(
       'cluster_id', g.id, 'cluster_epoch', v_epoch, 'instance_id', v_instance, 'hand_id', v_hand,
       'target_size', v_target, 'max_size', v_max, 'via', 'fn_lightning_form_hand', 'at', p_now),
     v_epoch, p_request_id),
    (g.id, 'pool_player_reserved', jsonb_build_object(
       'cluster_id', g.id, 'cluster_epoch', v_epoch, 'instance_id', v_instance, 'hand_id', v_hand,
       'players', (SELECT jsonb_agg(x -> 'player_id' ORDER BY (x ->> 'seat')::integer)
                     FROM jsonb_array_elements(v_seats) x),
       'at', p_now), v_epoch, p_request_id),
    (g.id, 'hand_created', jsonb_build_object(
       'cluster_id', g.id, 'cluster_epoch', v_epoch, 'hand_id', v_hand, 'instance_id', v_instance,
       'players', v_n, 'target_size', v_target, 'max_size', v_max,
       'bb', v_bb, 'sb', v_sb, 'btn', v_btn,
       'participants', (SELECT jsonb_agg(jsonb_build_object(
                                 'player_id', x -> 'player_id', 'seat', x -> 'seat',
                                 'position', x -> 'position', 'blind_role', x -> 'blind_role',
                                 'stack_before', x -> 'stack_before')
                               ORDER BY (x ->> 'seat')::integer)
                          FROM jsonb_array_elements(v_seats) x),
       'matcher_version', btrim(p_matcher_version), 'at', p_now), v_epoch, p_request_id);

  RETURN jsonb_build_object('ok', true, 'formed', true, 'retry', false,
                            'hand_id', v_hand, 'instance_id', v_instance,
                            'cluster_id', g.id, 'cluster_epoch', v_epoch,
                            'players', v_n, 'bb', v_bb, 'sb', v_sb, 'btn', v_btn,
                            'seats', v_seats, 'state', 'reserved', 'request_id', p_request_id);

  EXCEPTION
    WHEN lock_not_available OR deadlock_detected OR serialization_failure THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      -- Everything since the sub-block opened is rolled back: the reap, the
      -- formation, every lock taken after the Cluster row. The evidence is
      -- written here, after the rollback, and is the one thing that survives
      -- it. cluster_epoch 0 lets trg_cash_cluster_events_take_the_clusters_epoch
      -- fill in the Cluster's epoch when the lock that failed was the one
      -- taken before the epoch was read.
      INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
      VALUES (p_cluster_id, 'lightning_matcher_retry', jsonb_build_object(
        'reason', 'formation_contended', 'sqlstate', v_sqlstate, 'message', v_msg,
        'at', p_now), coalesce(v_epoch, 0), p_request_id);
      RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', true,
                                'reason', 'formation_contended',
                                'sqlstate', v_sqlstate, 'message', v_msg);
  END;
END
$function$;
-- Production's actual audience, read independently from pg_proc on 2026-10-16.
REVOKE ALL ON FUNCTION fn_lightning_operator_control(uuid,text,text,jsonb),fn_lightning_rollout_readiness(uuid),fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamptz,text,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION fn_lightning_operator_control(uuid,text,text,jsonb),fn_lightning_rollout_readiness(uuid) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamptz,text,uuid,jsonb) TO service_role;
