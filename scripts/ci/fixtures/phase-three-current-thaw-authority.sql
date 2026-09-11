-- Narrow CA09 native-only source composition. Never a production migration.

-- Exact source: a37145be930ab332fbd50c0ee17546af51cefbca:supabase/migrations/20260909180615_maintenance_ownership_fits_process_lifetime.sql

-- Sources are tracked Git history; no private catalog definition was exported.

ALTER TABLE public.engine_maintenance_thaws
  ADD COLUMN IF NOT EXISTS announced_at timestamptz,
  ADD COLUMN IF NOT EXISTS ownership_token uuid,
  ADD COLUMN IF NOT EXISTS contract_version integer,
  ADD COLUMN IF NOT EXISTS release_target_at timestamptz,
  ADD COLUMN IF NOT EXISTS release_generation integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.engine_maintenance_thaw_targets (
  freeze_started_at timestamptz NOT NULL
    REFERENCES public.engine_maintenance_thaws(freeze_started_at) ON DELETE CASCADE,
  step text NOT NULL,
  target_id uuid NOT NULL,
  credited_seconds numeric NOT NULL DEFAULT 0 CHECK (credited_seconds >= 0),
  PRIMARY KEY (freeze_started_at, step, target_id)
);

ALTER TABLE public.engine_maintenance_thaw_targets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.engine_maintenance_thaw_targets FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.engine_maintenance_thaw_targets TO service_role;

-- Source a37145be930ab332fbd50c0ee17546af51cefbca:supabase/migrations/20260908032311_reconnect_allowance_survives_maintenance.sql:46

CREATE OR REPLACE FUNCTION public.fn_thaw_platform_checkpointed(p_freeze_started timestamp with time zone, p_frozen_seconds numeric, p_thawed_by text DEFAULT NULL::text)
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
                       'reconnect_presence','reconnect_snapshots'] THEN
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
;

ALTER FUNCTION public.fn_thaw_platform_checkpointed(timestamptz,numeric,text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_thaw_platform_checkpointed(timestamptz,numeric,text) FROM PUBLIC, anon, authenticated, service_role;

-- Source a37145be930ab332fbd50c0ee17546af51cefbca:supabase/migrations/20260909180615_maintenance_ownership_fits_process_lifetime.sql:636

CREATE OR REPLACE FUNCTION public.fn_thaw_reconnect_states(
  p_states jsonb, p_start_ms numeric, p_end_ms numeric
) RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_result jsonb := p_states;
  v_key text;
  v_entry jsonb;
  v_deadline numeric;
  v_grace numeric;
  v_grant numeric;
  v_already numeric;
  v_credit_from numeric;
  v_shift numeric;
BEGIN
  IF jsonb_typeof(p_states) IS DISTINCT FROM 'object'
     OR p_start_ms IS NULL OR p_end_ms IS NULL
     OR p_end_ms <= p_start_ms THEN
    RETURN p_states;
  END IF;
  FOR v_key, v_entry IN SELECT key, value FROM jsonb_each(p_states) LOOP
    IF jsonb_typeof(v_entry) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;
    v_deadline := NULL;
    v_grace := NULL;
    IF jsonb_typeof(v_entry->'reconnectDeadlineMs') = 'number' THEN
      v_deadline := (v_entry->>'reconnectDeadlineMs')::numeric;
    ELSIF v_entry->>'state' IN ('MISSING', 'DISCONNECTED')
          AND jsonb_typeof(v_entry->'graceDeadlineMs') = 'number' THEN
      v_deadline := (v_entry->>'graceDeadlineMs')::numeric;
    END IF;
    IF jsonb_typeof(v_entry->'graceDeadlineMs') = 'number' THEN
      v_grace := (v_entry->>'graceDeadlineMs')::numeric;
    END IF;
    IF v_deadline IS NULL THEN
      CONTINUE;
    END IF;
    v_grant := CASE
      WHEN jsonb_typeof(v_entry->'reconnectGrantedAtMs') = 'number'
        THEN (v_entry->>'reconnectGrantedAtMs')::numeric
      ELSE p_start_ms
    END;
    v_already := CASE
      WHEN jsonb_typeof(v_entry->'reconnectThawedAtMs') = 'number'
        THEN GREATEST(p_start_ms, (v_entry->>'reconnectThawedAtMs')::numeric)
      ELSE p_start_ms
    END;
    IF v_already >= p_end_ms THEN
      CONTINUE;
    END IF;
    v_credit_from := GREATEST(p_start_ms, v_grant, v_already);
    -- A grant exhausted before the not-yet-credited suffix is never revived.
    IF v_deadline <= v_credit_from THEN
      CONTINUE;
    END IF;
    v_shift := GREATEST(0, p_end_ms - v_credit_from);
    v_entry := v_entry || jsonb_build_object(
      'reconnectDeadlineMs', v_deadline + v_shift,
      'reconnectThawedAtMs', p_end_ms
    );
    IF v_grace IS NOT NULL THEN
      v_entry := v_entry || jsonb_build_object('graceDeadlineMs', v_grace + v_shift);
    END IF;
    v_result := jsonb_set(v_result, ARRAY[v_key], v_entry);
  END LOOP;
  RETURN v_result;
END;
$function$;

ALTER FUNCTION public.fn_thaw_reconnect_states(jsonb,numeric,numeric) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_thaw_reconnect_states(jsonb,numeric,numeric) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fn_thaw_reconnect_states(jsonb,numeric,numeric) TO service_role;

-- Source a37145be930ab332fbd50c0ee17546af51cefbca:supabase/migrations/20260909180615_maintenance_ownership_fits_process_lifetime.sql:486

CREATE OR REPLACE FUNCTION public.fn_snapshot_maintenance_thaw_targets(
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

  UPDATE public.engine_maintenance_thaws t
     SET shifted = t.shifted || jsonb_build_object(
       '_targets_snapshotted', true,
       '_target_counts', v_counts
     )
   WHERE t.freeze_started_at = p_freeze_started;
  RETURN v_counts;
END;
$function$;

ALTER FUNCTION public.fn_snapshot_maintenance_thaw_targets(timestamptz,numeric) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_snapshot_maintenance_thaw_targets(timestamptz,numeric) FROM PUBLIC, anon, authenticated, service_role;

-- Source a37145be930ab332fbd50c0ee17546af51cefbca:supabase/migrations/20260909180615_maintenance_ownership_fits_process_lifetime.sql:718

CREATE OR REPLACE FUNCTION public.fn_credit_maintenance_thaw_targets(
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
    'reconnect_presence','reconnect_snapshots'
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
$function$;

ALTER FUNCTION public.fn_credit_maintenance_thaw_targets(timestamptz,numeric) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_credit_maintenance_thaw_targets(timestamptz,numeric) FROM PUBLIC, anon, authenticated, service_role;

-- Source a37145be930ab332fbd50c0ee17546af51cefbca:supabase/migrations/20260909180615_maintenance_ownership_fits_process_lifetime.sql:1027

CREATE OR REPLACE FUNCTION public.fn_thaw_platform(
  p_announced_at timestamptz,
  p_freeze_started timestamptz,
  p_frozen_seconds numeric,
  p_ownership_token uuid,
  p_thawed_by text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '6s'
SET lock_timeout = '5s'
AS $function$
DECLARE
  c_contract_version CONSTANT integer := 3;
  c_required_steps CONSTANT text[] := ARRAY[
    'sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until',
    'reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at',
    'cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at',
    'cluster_break_eligible_since','cluster_move_expires_at',
    'reconnect_presence','reconnect_snapshots'
  ];
  v_now timestamptz;
  v_due_at timestamptz;
  v_break public.engine_maintenance_break%ROWTYPE;
  v_expected_start timestamptz;
  v_effective_seconds numeric;
  v_existing public.engine_maintenance_thaws%ROWTYPE;
  v_checkpoint_exists boolean;
  v_result jsonb;
  v_shifted jsonb;
  v_target_count integer;
  v_reserve_seconds numeric;
  v_release_target timestamptz;
  v_retry_after_ms integer;
BEGIN
  IF p_announced_at IS NULL OR p_freeze_started IS NULL OR p_ownership_token IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'retryable', false,
      'reason', 'maintenance_identity_required'
    );
  END IF;

  PERFORM pg_advisory_xact_lock(530090, 1);
  v_now := clock_timestamp();

  SELECT * INTO v_break
    FROM public.engine_maintenance_break b
   WHERE b.id = true
   FOR UPDATE;

  IF NOT FOUND THEN
    SELECT * INTO v_existing
      FROM public.engine_maintenance_thaws t
     WHERE t.freeze_started_at = p_freeze_started
       AND t.announced_at IS NOT DISTINCT FROM p_announced_at
       AND t.ownership_token = p_ownership_token;
    IF FOUND
       AND COALESCE(v_existing.contract_version, 0) = c_contract_version
       AND COALESCE((v_existing.shifted->>'complete')::boolean, false)
       AND v_existing.shifted ?& c_required_steps THEN
      RETURN jsonb_build_object(
        'ok', true, 'complete', true, 'retryable', false,
        'reason', 'release_receipt_recovered', 'released', true,
        'abandoned', false,
        'freeze_started_at', p_freeze_started,
        'credited_through_at', v_existing.release_target_at,
        'effective_frozen_seconds', v_existing.frozen_seconds,
        'ownership_token', p_ownership_token,
        'shifted', v_existing.shifted
      );
    END IF;
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'retryable', false,
      'reason', 'maintenance_row_missing'
    );
  END IF;

  IF v_break.ownership_token <> p_ownership_token THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'retryable', false,
      'reason', 'maintenance_ownership_changed'
    );
  END IF;

  v_expected_start := COALESCE(
    v_break.break_started_at,
    v_break.announced_at + INTERVAL '2 minutes'
  );
  IF v_break.announced_at IS DISTINCT FROM p_announced_at
     OR v_expected_start IS DISTINCT FROM p_freeze_started THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'retryable', false,
      'reason', 'maintenance_identity_mismatch'
    );
  END IF;

  v_due_at := COALESCE(
    v_break.break_ends_at,
    v_break.announced_at + INTERVAL '7 minutes'
  );
  IF v_now < v_due_at THEN
    v_retry_after_ms := GREATEST(
      1,
      CEIL(EXTRACT(EPOCH FROM (v_due_at - v_now)) * 1000)::integer
    );
    RETURN jsonb_build_object(
      'ok', true, 'complete', false, 'retryable', true,
      'reason', 'maintenance_break_not_due', 'released', false,
      'retry_after_ms', v_retry_after_ms,
      'freeze_started_at', p_freeze_started,
      'ownership_token', p_ownership_token
    );
  END IF;

  SELECT * INTO v_existing
    FROM public.engine_maintenance_thaws t
   WHERE t.freeze_started_at = p_freeze_started
   FOR UPDATE;
  v_checkpoint_exists := FOUND;

  IF v_checkpoint_exists
     AND v_existing.announced_at IS DISTINCT FROM p_announced_at THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'retryable', false,
      'reason', 'maintenance_checkpoint_identity_mismatch'
    );
  END IF;

  -- A replacement process adopts the exact break row under this same lock.
  -- Carry that proven ownership into an in-flight v3 checkpoint so recovery
  -- can continue; the retired token fails against the row before reaching it.
  IF v_checkpoint_exists
     AND v_existing.ownership_token IS DISTINCT FROM p_ownership_token
     AND COALESCE(v_existing.contract_version,0)=c_contract_version THEN
    UPDATE public.engine_maintenance_thaws t
       SET ownership_token=p_ownership_token, thawed_by=p_thawed_by
     WHERE t.freeze_started_at=p_freeze_started
       AND t.announced_at IS NOT DISTINCT FROM p_announced_at
       AND t.ownership_token IS NOT DISTINCT FROM v_existing.ownership_token;
    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'ok', false, 'complete', false, 'retryable', false,
        'reason', 'maintenance_checkpoint_identity_mismatch'
      );
    END IF;
    v_existing.ownership_token := p_ownership_token;
  END IF;

  -- A legacy partial checkpoint has aggregate counts but no row identities.
  -- Inventing row receipts for it could double-shift one clock and omit
  -- another.  The migration asserts a quiescent cutover; fail closed if that
  -- precondition was violated rather than guessing.
  IF v_checkpoint_exists
     AND COALESCE(v_existing.contract_version, 0) <> c_contract_version THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'retryable', false,
      'reason', 'legacy_inflight_thaw_requires_quiescent_cutover'
    );
  END IF;

  v_effective_seconds := CASE
    WHEN v_checkpoint_exists THEN v_existing.frozen_seconds
    ELSE EXTRACT(EPOCH FROM (v_now - p_freeze_started))
  END;
  IF v_effective_seconds <= 0 THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'retryable', false,
      'reason', 'implausible_frozen_seconds'
    );
  END IF;

  -- p_frozen_seconds is retained for rolling-call compatibility and logging.
  -- The database clock sampled after the admission boundary is authoritative.
  INSERT INTO public.engine_maintenance_thaws (
    freeze_started_at, frozen_seconds, shifted, thawed_by,
    announced_at, ownership_token, contract_version,
    release_target_at, release_generation
  ) VALUES (
    p_freeze_started, v_effective_seconds, '{}'::jsonb, p_thawed_by,
    p_announced_at, p_ownership_token, c_contract_version, NULL, 0
  )
  ON CONFLICT (freeze_started_at) DO NOTHING;

  SELECT * INTO v_existing
    FROM public.engine_maintenance_thaws t
   WHERE t.freeze_started_at=p_freeze_started
   FOR UPDATE;
  IF v_existing.announced_at IS DISTINCT FROM p_announced_at
     OR v_existing.ownership_token IS DISTINCT FROM p_ownership_token
     OR v_existing.contract_version <> c_contract_version THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'retryable', false,
      'reason', 'maintenance_checkpoint_identity_mismatch'
    );
  END IF;

  -- Stage one keeps the deployed installment worker, but snapshots its exact
  -- UUID targets first.  As each legacy step commits, its row receipts advance
  -- in this same outer transaction to the identical initial duration.
  IF v_existing.release_target_at IS NULL THEN
    IF COALESCE((v_existing.shifted->>'_targets_snapshotted')::boolean, false) = false THEN
      PERFORM public.fn_snapshot_maintenance_thaw_targets(
        p_freeze_started, v_existing.frozen_seconds
      );
    END IF;
    -- The retained checkpoint worker validates its CALL argument against its
    -- historical 900-second ceiling, but reads the authoritative duration from
    -- this v3 ledger row. Pass the largest legacy-valid value; the worker and
    -- the exact per-target suffix both use v_existing.frozen_seconds, so a
    -- long-lived owner is recovered in full without weakening its old public
    -- input guard.
    v_result := public.fn_thaw_platform_checkpointed(
      p_freeze_started,
      LEAST(v_existing.frozen_seconds, 900::numeric),
      p_thawed_by
    );
    IF COALESCE((v_result->>'ok')::boolean, false) = false THEN
      RETURN v_result || jsonb_build_object(
        'complete', false, 'retryable', false, 'released', false,
        'freeze_started_at', p_freeze_started,
        'ownership_token', p_ownership_token
      );
    END IF;
    SELECT t.shifted INTO v_shifted
      FROM public.engine_maintenance_thaws t
     WHERE t.freeze_started_at=p_freeze_started;
    UPDATE public.engine_maintenance_thaw_targets x
       SET credited_seconds=v_existing.frozen_seconds
     WHERE x.freeze_started_at=p_freeze_started
       AND x.credited_seconds<v_existing.frozen_seconds
       AND (
         (x.step <> 'level_started_at' AND v_shifted ? x.step)
         OR (
           x.step='level_started_at'
           AND (
             v_shifted ? 'level_started_at'
             OR (
               v_shifted ? 'level_started_at_cursor'
               AND x.target_id <= (v_shifted->>'level_started_at_cursor')::uuid
             )
           )
         )
       );
    IF NOT COALESCE((v_result->>'complete')::boolean, false)
       OR NOT COALESCE((v_shifted->>'complete')::boolean, false)
       OR NOT (v_shifted ?& c_required_steps) THEN
      RETURN v_result || jsonb_build_object(
        'ok', true, 'complete', false, 'retryable', true,
        'reason', 'thaw_checkpointed', 'released', false, 'abandoned', false,
        'retry_after_ms', 0,
        'freeze_started_at', p_freeze_started,
        'credited_through_at', p_freeze_started
          + make_interval(secs=>v_existing.frozen_seconds),
        'effective_frozen_seconds', v_existing.frozen_seconds,
        'ownership_token', p_ownership_token,
        'shifted', v_shifted
      );
    END IF;

    -- The broad work is known now.  Rebase every exact target to a future
    -- endpoint with enough runway to finish in bounded batches.  If the
    -- estimate is missed a later generation doubles it; no door opens on an
    -- expired estimate.
    SELECT count(*) INTO v_target_count
      FROM public.engine_maintenance_thaw_targets x
     WHERE x.freeze_started_at=p_freeze_started;
    v_reserve_seconds := GREATEST(
      8::numeric,
      4::numeric + CEIL(v_target_count::numeric / 40::numeric) * 4::numeric
    );
    v_release_target := clock_timestamp()
      + make_interval(secs=>v_reserve_seconds);
    v_effective_seconds := EXTRACT(EPOCH FROM (v_release_target-p_freeze_started));
    UPDATE public.engine_maintenance_thaws t
       SET frozen_seconds=v_effective_seconds,
           release_target_at=v_release_target,
           release_generation=1,
           shifted=t.shifted-'complete',
           thawed_at=clock_timestamp()
     WHERE t.freeze_started_at=p_freeze_started;
    RETURN jsonb_build_object(
      'ok', true, 'complete', false, 'retryable', true,
      'reason', 'release_boundary_planned', 'released', false, 'abandoned', false,
      'retry_after_ms', 0,
      'freeze_started_at', p_freeze_started,
      'credited_through_at', v_release_target,
      'effective_frozen_seconds', v_effective_seconds,
      'ownership_token', p_ownership_token,
      'shifted', v_shifted-'complete'
    );
  END IF;

  -- Stage two advances only each target's uncredited suffix.  No completed
  -- step is ever shifted by the full duration twice.
  v_result := public.fn_credit_maintenance_thaw_targets(
    p_freeze_started, v_existing.frozen_seconds
  );
  IF COALESCE((v_result->>'ok')::boolean, false) = false THEN
    RETURN v_result || jsonb_build_object(
      'complete', false, 'retryable', false, 'released', false,
      'freeze_started_at', p_freeze_started,
      'ownership_token', p_ownership_token
    );
  END IF;
  SELECT * INTO v_existing
    FROM public.engine_maintenance_thaws t
   WHERE t.freeze_started_at=p_freeze_started
   FOR UPDATE;
  v_shifted := v_existing.shifted;
  IF NOT COALESCE((v_result->>'complete')::boolean, false) THEN
    RETURN v_result || jsonb_build_object(
      'ok', true, 'complete', false, 'retryable', true,
      'reason', 'thaw_tail_checkpointed', 'released', false, 'abandoned', false,
      'retry_after_ms', 0,
      'freeze_started_at', p_freeze_started,
      'credited_through_at', v_existing.release_target_at,
      'effective_frozen_seconds', v_existing.frozen_seconds,
      'ownership_token', p_ownership_token,
      'shifted', v_shifted
    );
  END IF;

  v_now := clock_timestamp();
  IF v_now >= v_existing.release_target_at THEN
    SELECT count(*) INTO v_target_count
      FROM public.engine_maintenance_thaw_targets x
     WHERE x.freeze_started_at=p_freeze_started;
    v_reserve_seconds := GREATEST(
      8::numeric,
      (4::numeric + CEIL(v_target_count::numeric/40::numeric)*4::numeric)
        * power(2::numeric, LEAST(v_existing.release_generation, 8))
    );
    v_release_target := v_now + make_interval(secs=>v_reserve_seconds);
    v_effective_seconds := EXTRACT(EPOCH FROM (v_release_target-p_freeze_started));
    UPDATE public.engine_maintenance_thaws t
       SET frozen_seconds=v_effective_seconds,
           release_target_at=v_release_target,
           release_generation=t.release_generation+1,
           shifted=t.shifted-'complete',
           thawed_at=clock_timestamp()
     WHERE t.freeze_started_at=p_freeze_started;
    RETURN jsonb_build_object(
      'ok', true, 'complete', false, 'retryable', true,
      'reason', 'release_boundary_rebased', 'released', false, 'abandoned', false,
      'retry_after_ms', 0,
      'freeze_started_at', p_freeze_started,
      'credited_through_at', v_release_target,
      'effective_frozen_seconds', v_effective_seconds,
      'ownership_token', p_ownership_token,
      'shifted', v_shifted-'complete'
    );
  END IF;

  -- Every target is already credited through the future endpoint.  Commit the
  -- exact row clear now; the certified ledger (consulted by both public freeze
  -- predicates) keeps admission closed until that instant.  This removes the
  -- otherwise-uncreditable DELETE/commit/network tail from the frozen interval.
  UPDATE public.engine_maintenance_thaws t
     SET thawed_at=clock_timestamp()
   WHERE t.freeze_started_at=p_freeze_started;
  DELETE FROM public.engine_maintenance_break b
   WHERE b.id=true
     AND b.announced_at IS NOT DISTINCT FROM p_announced_at
     AND COALESCE(b.break_started_at,b.announced_at+INTERVAL '2 minutes')
         IS NOT DISTINCT FROM p_freeze_started
     AND b.ownership_token=p_ownership_token;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'retryable', false,
      'reason', 'maintenance_release_identity_changed'
    );
  END IF;
  RETURN v_result || jsonb_build_object(
    'ok', true, 'complete', true, 'retryable', false,
    'reason', 'thaw_complete_release_scheduled',
    'released', true, 'abandoned', false,
    'freeze_started_at', p_freeze_started,
    'credited_through_at', v_existing.release_target_at,
    'effective_frozen_seconds', v_existing.frozen_seconds,
    'ownership_token', p_ownership_token,
    'shifted', v_shifted
  );
END;
$function$;

ALTER FUNCTION public.fn_thaw_platform(timestamptz,timestamptz,numeric,uuid,text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_thaw_platform(timestamptz,timestamptz,numeric,uuid,text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fn_thaw_platform(timestamptz,timestamptz,numeric,uuid,text) TO service_role;

-- Source a37145be930ab332fbd50c0ee17546af51cefbca:supabase/migrations/20260909180615_maintenance_ownership_fits_process_lifetime.sql:1436

CREATE OR REPLACE FUNCTION public.fn_thaw_platform(
  p_freeze_started timestamptz,
  p_frozen_seconds numeric,
  p_thawed_by text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_break public.engine_maintenance_break%ROWTYPE;
  v_expected_start timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(530090, 1);
  SELECT * INTO v_break
    FROM public.engine_maintenance_break b
   WHERE b.id=true
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false,
      'reason', 'maintenance_row_missing'
    );
  END IF;

  v_expected_start := COALESCE(
    v_break.break_started_at,
    v_break.announced_at + INTERVAL '2 minutes'
  );
  IF v_expected_start IS DISTINCT FROM p_freeze_started THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false,
      'reason', 'maintenance_identity_mismatch'
    );
  END IF;

  RETURN public.fn_thaw_platform_checkpointed(
    p_freeze_started,
    p_frozen_seconds,
    p_thawed_by
  );
END;
$function$;

ALTER FUNCTION public.fn_thaw_platform(timestamptz,numeric,text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_thaw_platform(timestamptz,numeric,text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fn_thaw_platform(timestamptz,numeric,text) TO service_role;

-- Source: 0b785237dbcc59fec3918d0d7c941bfe232d3aea:docs/audits/2026-09-10-k01-production-clock/native-maintenance-supplement.sql:1259

CREATE OR REPLACE FUNCTION public.fn_active_maintenance_release_boundary()
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
DECLARE
  c_required_steps CONSTANT text[] := ARRAY[
    'sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until',
    'reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at',
    'cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at',
    'cluster_break_eligible_since','cluster_move_expires_at',
    'reconnect_presence','reconnect_snapshots'
  ];
  v_request_role text := NULLIF(btrim(COALESCE(auth.role(), '')), '');
  v_trusted_database_actor boolean;
  v_release_target timestamptz;
BEGIN
  -- supabase_auth_admin added 2026-09-10: it is GoTrue's own database role
  -- (the signup triggers run as it), never a browser. Without it every signup
  -- wallet trigger raised 42501 here (signup_errors id 9318).
  SELECT session_user IN ('postgres', 'supabase_admin', 'service_role', 'supabase_auth_admin')
         OR COALESCE(r.rolsuper, false)
    INTO v_trusted_database_actor
    FROM (SELECT session_user AS role_name) s
    LEFT JOIN pg_catalog.pg_roles r ON r.rolname = s.role_name;

  IF v_request_role IS NOT NULL
     AND v_request_role NOT IN ('anon', 'authenticated', 'service_role') THEN
    RAISE EXCEPTION 'MAINTENANCE_RELEASE_CERTIFICATE_CALLER_REFUSED'
      USING ERRCODE = '42501';
  END IF;
  IF v_request_role IS NULL AND NOT COALESCE(v_trusted_database_actor, false) THEN
    RAISE EXCEPTION 'MAINTENANCE_RELEASE_CERTIFICATE_CALLER_REQUIRED'
      USING ERRCODE = '42501';
  END IF;

  -- PERF (2026-09-10, swarm A): OFFSET 0 is an optimisation fence. Without it
  -- the planner evaluated `shifted ?& c_required_steps` first on every row of
  -- engine_maintenance_thaws (167 rows, 0 of them contract_version 3) on every
  -- money write that reaches fn_platform_frozen: 229 us -> 32 us per call.
  -- Same four quals, same max(); the jsonb quals now only see rows that already
  -- passed contract_version = 3 AND release_target_at > clock_timestamp().
  SELECT max(t.release_target_at) INTO v_release_target
    FROM (SELECT t.release_target_at, t.shifted
            FROM public.engine_maintenance_thaws t
           WHERE t.contract_version = 3
             AND t.release_target_at > clock_timestamp()
          OFFSET 0) t
   WHERE COALESCE((t.shifted->>'complete')::boolean, false)
     AND t.shifted ?& c_required_steps;
  RETURN v_release_target;
END;
$function$
;

ALTER FUNCTION public.fn_active_maintenance_release_boundary() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_active_maintenance_release_boundary() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.fn_active_maintenance_release_boundary() TO anon, authenticated, service_role;

-- Source a37145be930ab332fbd50c0ee17546af51cefbca:supabase/migrations/20260909180615_maintenance_ownership_fits_process_lifetime.sql:268

CREATE OR REPLACE FUNCTION public.fn_platform_frozen()
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
  SELECT EXISTS (
           SELECT 1
             FROM public.engine_maintenance_break b
            WHERE b.enforce_freeze
              AND b.announced_at < clock_timestamp() + INTERVAL '30 seconds'
              AND (
                (
                  b.phase = 'last_hand'
                  AND b.break_started_at IS NULL
                  AND b.break_ends_at IS NULL
                  AND b.announced_at + INTERVAL '2 minutes' <= clock_timestamp()
                )
                OR (
                  b.phase = 'counting_down'
                  AND b.break_started_at IS NOT NULL
                  AND b.break_ends_at IS NOT NULL
                  AND b.break_started_at >= b.announced_at
                  AND b.break_ends_at > b.break_started_at
                  AND b.break_ends_at < b.announced_at + INTERVAL '15 minutes'
                )
              )
         )
         OR COALESCE(
           public.fn_active_maintenance_release_boundary() > clock_timestamp(),
           false
         );
$function$;

ALTER FUNCTION public.fn_platform_frozen() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_platform_frozen() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.fn_platform_frozen() TO anon, authenticated, service_role;

-- Source a37145be930ab332fbd50c0ee17546af51cefbca:supabase/migrations/20260909180615_maintenance_ownership_fits_process_lifetime.sql:310

CREATE OR REPLACE FUNCTION public.fn_entry_purchases_frozen()
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
  SELECT EXISTS (
           SELECT 1
             FROM public.engine_maintenance_break b
            WHERE b.enforce_freeze
              AND b.announced_at < clock_timestamp() + INTERVAL '30 seconds'
              AND (
                (
                  b.phase = 'last_hand'
                  AND b.break_started_at IS NULL
                  AND b.break_ends_at IS NULL
                )
                OR (
                  b.phase = 'counting_down'
                  AND b.break_started_at IS NOT NULL
                  AND b.break_ends_at IS NOT NULL
                  AND b.break_started_at >= b.announced_at
                  AND b.break_ends_at > b.break_started_at
                  AND b.break_ends_at < b.announced_at + INTERVAL '15 minutes'
                )
              )
         )
         OR COALESCE(
           public.fn_active_maintenance_release_boundary() > clock_timestamp(),
           false
         );
$function$;

ALTER FUNCTION public.fn_entry_purchases_frozen() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_entry_purchases_frozen() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.fn_entry_purchases_frozen() TO anon, authenticated, service_role;

-- Exact later timeout metadata: supabase/migrations/20260910073818_the_break_writer_outwaits_the_doors_it_serializes.sql

ALTER FUNCTION public.fn_thaw_platform(
  timestamptz, timestamptz, numeric, uuid, text
) SET lock_timeout TO '32s';

ALTER FUNCTION public.fn_thaw_platform(
  timestamptz, timestamptz, numeric, uuid, text
) SET statement_timeout TO '35s';
