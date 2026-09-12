-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260909180615; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260909180615   (the stamp IS the apply time, UTC: 2026-09-09 18:06:15)
--   name        maintenance_ownership_fits_process_lifetime
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 68108 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260909180615 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_save_engine_maintenance_break, public.fn_thaw_reconnect_states, public.fn_active_maintenance_release_boundary, public.fn_platform_frozen, public.fn_entry_purchases_frozen, public.fn_maintenance_break_state, public.fn_snapshot_maintenance_thaw_targets, public.fn_credit_maintenance_thaw_targets
--     TABLE          public.engine_maintenance_thaw_targets
--     RLS-ENABLE     
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- A maintenance ownership mutation must finish before the process that owns it
-- can be replaced. The engine hard-exits at 40s and its lease becomes stale at
-- 30s; the old 45s database / 50s HTTP pair could therefore commit after a new
-- owner had already observed no row. Keep each serialized database operation
-- below the transport's 8s ceiling. The :53 caller retries failed declarations
-- until the fixed :55 boundary, so shortening one attempt does not drop an hour.
BEGIN;

CREATE OR REPLACE FUNCTION public.fn_save_engine_maintenance_break(
  p_phase text,
  p_announced_at timestamptz,
  p_break_started_at timestamptz,
  p_break_ends_at timestamptz,
  p_reason text,
  p_declared_by text,
  p_ownership_token uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '6s'
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_rows integer;
  v_now timestamptz;
BEGIN
  IF p_ownership_token IS NULL THEN
    RAISE EXCEPTION 'MAINTENANCE_OWNERSHIP_TOKEN_REQUIRED'
      USING ERRCODE = '22004';
  END IF;

  -- This is also the serialization point for admission. Sample time only after
  -- acquiring it, so a request queued behind an admitted purchase cannot commit
  -- a last-hand row after the fixed boundary and surface a break nobody honors.
  PERFORM pg_advisory_xact_lock(530090, 1);
  v_now := clock_timestamp();

  IF p_phase = 'last_hand' AND (
    p_break_started_at IS NOT NULL
    OR p_break_ends_at IS NOT NULL
    OR p_announced_at > v_now + INTERVAL '5 seconds'
    OR v_now >= p_announced_at + INTERVAL '2 minutes'
  ) THEN
    RAISE EXCEPTION 'MAINTENANCE_LAST_HAND_BOUNDARY_EXPIRED'
      USING ERRCODE = '57014';
  END IF;

  IF p_phase = 'counting_down' AND (
    p_break_started_at IS NULL
    OR p_break_ends_at IS NULL
    OR v_now >= p_break_ends_at
  ) THEN
    RAISE EXCEPTION 'MAINTENANCE_COUNTDOWN_BOUNDARY_EXPIRED'
      USING ERRCODE = '57014';
  END IF;

  INSERT INTO public.engine_maintenance_break (
    id, phase, announced_at, break_started_at, enforce_freeze,
    break_ends_at, reason, declared_by, ownership_token, updated_at
  ) VALUES (
    true, p_phase, p_announced_at, p_break_started_at, true,
    p_break_ends_at, p_reason, p_declared_by, p_ownership_token, v_now
  )
  ON CONFLICT (id) DO UPDATE SET
    phase = EXCLUDED.phase,
    announced_at = EXCLUDED.announced_at,
    break_started_at = EXCLUDED.break_started_at,
    enforce_freeze = EXCLUDED.enforce_freeze,
    break_ends_at = EXCLUDED.break_ends_at,
    reason = EXCLUDED.reason,
    declared_by = EXCLUDED.declared_by,
    ownership_token = EXCLUDED.ownership_token,
    updated_at = EXCLUDED.updated_at
  WHERE public.engine_maintenance_break.ownership_token = EXCLUDED.ownership_token;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'MAINTENANCE_OWNERSHIP_LOST: save refused'
      USING ERRCODE = '40001';
  END IF;
END;
$function$;

ALTER FUNCTION public.fn_claim_engine_maintenance_break(uuid, uuid, text)
  SET statement_timeout = '6s';
ALTER FUNCTION public.fn_claim_engine_maintenance_break(uuid, uuid, text)
  SET lock_timeout = '5s';
ALTER FUNCTION public.fn_clear_engine_maintenance_break(
  text, timestamptz, timestamptz, timestamptz, text, uuid
) SET statement_timeout = '6s';
ALTER FUNCTION public.fn_clear_engine_maintenance_break(
  text, timestamptz, timestamptz, timestamptz, text, uuid
) SET lock_timeout = '5s';

REVOKE ALL ON FUNCTION public.fn_save_engine_maintenance_break(
  text, timestamptz, timestamptz, timestamptz, text, text, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_save_engine_maintenance_break(
  text, timestamptz, timestamptz, timestamptz, text, text, uuid
) TO service_role;

-- Add the release-certificate fields before declaring the public predicates:
-- a completed thaw can commit before its future release boundary, and these
-- fields keep admission frozen until that exact credited instant.
ALTER TABLE public.engine_maintenance_thaws
  ADD COLUMN IF NOT EXISTS announced_at timestamptz,
  ADD COLUMN IF NOT EXISTS ownership_token uuid,
  ADD COLUMN IF NOT EXISTS contract_version integer,
  ADD COLUMN IF NOT EXISTS release_target_at timestamptz,
  ADD COLUMN IF NOT EXISTS release_generation integer NOT NULL DEFAULT 0;

-- This table predates the hardened thaw contract. Supabase's public-schema
-- defaults granted its owner-created table privileges to browser roles even
-- though RLS had no policies. RLS currently prevents row access, but keeping
-- the underlying grants would make a future policy change expose process
-- ownership and per-step settlement metadata. Remove that latent authority at
-- the source; browser callers get only the narrow release-boundary accessor.
REVOKE ALL ON TABLE public.engine_maintenance_thaws
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.engine_maintenance_thaws TO service_role;

-- The former helper rejected any interval longer than fifteen minutes. That
-- was reasonable only while a stale owner was abandoned after fifteen
-- minutes; v3 deliberately recovers the exact persisted interval no matter
-- how long the process was unavailable. The service-only, ownership-fenced
-- thaw is now the authority for the interval, so the helper must apply that
-- exact suffix instead of silently leaving reconnect clocks uncredited.
CREATE OR REPLACE FUNCTION public.fn_thaw_reconnect_states(
  p_states jsonb,
  p_start_ms numeric,
  p_end_ms numeric
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
  v_grant numeric;
  v_shift numeric;
BEGIN
  IF jsonb_typeof(p_states) IS DISTINCT FROM 'object'
     OR p_start_ms IS NULL
     OR p_end_ms IS NULL
     OR p_end_ms <= p_start_ms THEN
    RETURN p_states;
  END IF;

  FOR v_key, v_entry IN SELECT key, value FROM jsonb_each(p_states) LOOP
    IF jsonb_typeof(v_entry) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;
    IF jsonb_typeof(v_entry->'reconnectThawedAtMs') = 'number'
       AND (v_entry->>'reconnectThawedAtMs')::numeric >= p_start_ms THEN
      CONTINUE;
    END IF;

    v_deadline := NULL;
    IF jsonb_typeof(v_entry->'reconnectDeadlineMs') = 'number' THEN
      v_deadline := (v_entry->>'reconnectDeadlineMs')::numeric;
    ELSIF v_entry->>'state' IN ('MISSING', 'DISCONNECTED')
          AND jsonb_typeof(v_entry->'graceDeadlineMs') = 'number' THEN
      v_deadline := (v_entry->>'graceDeadlineMs')::numeric;
    END IF;
    IF v_deadline IS NULL OR v_deadline <= p_start_ms THEN
      CONTINUE;
    END IF;

    v_grant := p_start_ms;
    IF jsonb_typeof(v_entry->'reconnectGrantedAtMs') = 'number' THEN
      v_grant := (v_entry->>'reconnectGrantedAtMs')::numeric;
    END IF;
    v_shift := greatest(0, p_end_ms - greatest(p_start_ms, v_grant));
    v_entry := v_entry || jsonb_build_object(
      'reconnectDeadlineMs', v_deadline + v_shift,
      'reconnectThawedAtMs', p_end_ms
    );
    IF jsonb_typeof(v_entry->'graceDeadlineMs') = 'number' THEN
      v_entry := v_entry || jsonb_build_object(
        'graceDeadlineMs', v_deadline + v_shift
      );
    END IF;
    v_result := jsonb_set(v_result, ARRAY[v_key], v_entry);
  END LOOP;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_thaw_reconnect_states(jsonb, numeric, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_thaw_reconnect_states(jsonb, numeric, numeric)
  TO service_role;

-- The thaw ledger is engine-private: it includes process ownership, per-step
-- counts, and recovery metadata that no browser should be able to enumerate.
-- Public freeze/state functions need one fact from it after the exact break
-- row is cleared, so expose only the active certified boundary through this
-- deliberately tiny, caller-aware SECURITY DEFINER accessor.  A missing or
-- unrecognised request identity fails closed; trusted direct database workers
-- are admitted only when the session itself is a known backend/superuser.
CREATE OR REPLACE FUNCTION public.fn_active_maintenance_release_boundary()
RETURNS timestamptz
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
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
  SELECT session_user IN ('postgres', 'supabase_admin', 'service_role')
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

  SELECT max(t.release_target_at) INTO v_release_target
    FROM public.engine_maintenance_thaws t
   WHERE t.contract_version = 3
     AND t.release_target_at > clock_timestamp()
     AND COALESCE((t.shifted->>'complete')::boolean, false)
     AND t.shifted ?& c_required_steps;
  RETURN v_release_target;
END;
$function$;

COMMENT ON FUNCTION public.fn_active_maintenance_release_boundary() IS
  'Returns only the public future endpoint of a complete v3 maintenance release certificate. It never exposes the private thaw ledger, ownership, target identities, amounts, or step counts.';

REVOKE ALL ON FUNCTION public.fn_active_maintenance_release_boundary()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_active_maintenance_release_boundary()
  TO anon, authenticated, service_role;

-- The visible countdown ends at :00, but the durable transition is not over
-- until every thaw installment has committed and the exact break row is
-- cleared. Keep all mutation/admission guards closed between installments.
-- There is deliberately no clock-based fail-open here: the final thaw
-- transaction exact-clears the row under the same exclusive boundary used by
-- every admission door.  A completed v3 ledger then owns the final, future
-- release instant, so commit and network time cannot burn a player clock.
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

COMMENT ON FUNCTION public.fn_platform_frozen() IS
  'True from the fixed :55 boundary through every thaw installment, then through the exact future endpoint certified by the complete v3 per-row credit ledger.';

REVOKE ALL ON FUNCTION public.fn_platform_frozen() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_platform_frozen()
  TO anon, authenticated, service_role;

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

COMMENT ON FUNCTION public.fn_entry_purchases_frozen() IS
  'True from the last-hand announcement through every thaw installment and the complete v3 ledger endpoint. Unlike fn_platform_frozen, last_hand immediately closes new entry while the current hand may finish.';

REVOKE ALL ON FUNCTION public.fn_entry_purchases_frozen() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_entry_purchases_frozen()
  TO anon, authenticated, service_role;

-- A browser loaded after the visible :00 deadline must still see why entry and
-- play remain closed while an adopted process completes the mandatory thaw.
CREATE OR REPLACE FUNCTION public.fn_maintenance_break_state()
RETURNS TABLE (
  phase text,
  break_ends_at timestamptz,
  remaining_ms integer,
  reason text
)
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
  WITH release_certificate AS MATERIALIZED (
    SELECT public.fn_active_maintenance_release_boundary() AS effective_end
  ), candidate AS (
    SELECT b.phase,
           CASE
             WHEN b.phase = 'last_hand' THEN b.announced_at + INTERVAL '7 minutes'
             ELSE b.break_ends_at
           END AS effective_end,
           b.reason,
           1 AS priority
      FROM public.engine_maintenance_break b
     WHERE b.enforce_freeze
       AND b.announced_at < clock_timestamp() + INTERVAL '30 seconds'
    UNION ALL
    SELECT 'recovering'::text,
           certificate.effective_end,
           'Restoring every frozen table clock'::text,
           2
      FROM release_certificate certificate
     WHERE certificate.effective_end IS NOT NULL
  )
  SELECT CASE
           WHEN c.effective_end IS NOT NULL AND c.effective_end <= clock_timestamp()
             THEN 'recovering'::text
           ELSE c.phase
         END,
         CASE
           WHEN c.effective_end IS NOT NULL AND c.effective_end > clock_timestamp()
             THEN c.effective_end
           ELSE NULL::timestamptz
         END,
         CASE
           WHEN c.effective_end IS NOT NULL AND c.effective_end > clock_timestamp()
             THEN GREATEST(
               0,
               LEAST(
                 2147483647,
                 EXTRACT(EPOCH FROM (c.effective_end - clock_timestamp())) * 1000
               )
             )::integer
           ELSE 0
         END,
         c.reason
    FROM candidate c
   ORDER BY c.priority
   LIMIT 1;
$function$;

COMMENT ON FUNCTION public.fn_maintenance_break_state() IS
  'Public maintenance state, including a recovering phase after the promised countdown while the exact thaw-and-release transaction is pending.';

REVOKE ALL ON FUNCTION public.fn_maintenance_break_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_maintenance_break_state()
  TO anon, authenticated, service_role;

-- Every entry RPC takes the shared half of this boundary before it asks the
-- predicates above. Put each thaw installment on the exclusive half. The row
-- keeps predicates true between calls; the lock closes the check/write race
-- inside each call. Rename the already checkpointed implementation rather than
-- copying hundreds of lines and risking drift in one of its target predicates.
DO $block$
BEGIN
  IF to_regprocedure(
    'public.fn_thaw_platform_checkpointed(timestamptz,numeric,text)'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'maintenance thaw checkpoint implementation already renamed';
  END IF;
  ALTER FUNCTION public.fn_thaw_platform(timestamptz, numeric, text)
    RENAME TO fn_thaw_platform_checkpointed;
END;
$block$;

REVOKE ALL ON FUNCTION public.fn_thaw_platform_checkpointed(
  timestamptz, numeric, text
) FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.engine_maintenance_thaws
  ADD COLUMN IF NOT EXISTS announced_at timestamptz,
  ADD COLUMN IF NOT EXISTS ownership_token uuid,
  ADD COLUMN IF NOT EXISTS contract_version integer,
  ADD COLUMN IF NOT EXISTS release_target_at timestamptz,
  ADD COLUMN IF NOT EXISTS release_generation integer NOT NULL DEFAULT 0;

DO $quiescent_cutover$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.engine_maintenance_break b
      JOIN public.engine_maintenance_thaws t
        ON t.freeze_started_at=COALESCE(
          b.break_started_at,b.announced_at+INTERVAL '2 minutes'
        )
     WHERE b.id=true AND COALESCE(t.contract_version,0) < 3
  ) THEN
    RAISE EXCEPTION
      'MAINTENANCE_THAW_CUTOVER_NOT_QUIESCENT: finish the exact legacy thaw before applying v3';
  END IF;
END;
$quiescent_cutover$;

-- Counts alone cannot prove that an installment was shifted by the duration
-- eventually released.  Keep an exact, per-row credit receipt.  A row update
-- and its receipt advance in the same transaction; a timeout rolls back both.
CREATE TABLE IF NOT EXISTS public.engine_maintenance_thaw_targets (
  freeze_started_at timestamptz NOT NULL
    REFERENCES public.engine_maintenance_thaws(freeze_started_at) ON DELETE CASCADE,
  step text NOT NULL,
  target_id uuid NOT NULL,
  credited_seconds numeric NOT NULL DEFAULT 0 CHECK (credited_seconds >= 0),
  PRIMARY KEY (freeze_started_at, step, target_id)
);

ALTER TABLE public.engine_maintenance_thaw_targets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.engine_maintenance_thaw_targets
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.engine_maintenance_thaw_targets TO service_role;

-- The snapshot is made once, before the legacy installment worker can mutate
-- any deadline.  The engine is parked and every admission door is closed by
-- the exact break row while this function runs.
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

REVOKE ALL ON FUNCTION public.fn_snapshot_maintenance_thaw_targets(
  timestamptz, numeric
) FROM PUBLIC, anon, authenticated, service_role;

-- A target may be credited again when the certified release boundary moves
-- forward.  The durable marker is the last endpoint already applied, so a
-- retried transaction adds only the uncovered suffix.
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

REVOKE ALL ON FUNCTION public.fn_thaw_reconnect_states(jsonb, numeric, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_thaw_reconnect_states(jsonb, numeric, numeric)
  TO service_role;

-- Advance every snapshotted target from its own durable receipt to one common
-- release endpoint.  A batch's physical update and receipt update share this
-- transaction, so lost responses and statement rollbacks are safe to retry.
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

REVOKE ALL ON FUNCTION public.fn_credit_maintenance_thaw_targets(timestamptz, numeric)
  FROM PUBLIC, anon, authenticated, service_role;

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

COMMENT ON FUNCTION public.fn_thaw_platform(
  timestamptz, timestamptz, numeric, uuid, text
) IS
  'Serialized service-only checkpointed thaw. Exact per-row receipts advance only an uncredited suffix; a complete ledger keeps admission frozen through a future endpoint after the exact break row is cleared.';

REVOKE ALL ON FUNCTION public.fn_thaw_platform(
  timestamptz, timestamptz, numeric, uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_thaw_platform(
  timestamptz, timestamptz, numeric, uuid, text
) TO service_role;

-- Rolling-upgrade bridge. The process that is already running when this
-- migration lands still calls the historical three-argument RPC. Removing
-- that signature before replacing the process would strand the :00 thaw if a
-- staged image failed to start. Preserve exactly the prior checkpoint worker
-- behind the same exclusive admission boundary until every engine speaks v3.
--
-- This is compatibility, not a bypass into the v3 contract: it cannot mint a
-- v3 ownership receipt because the old caller does not possess the announced
-- instant/token. A later v3 call for the same freeze therefore still refuses
-- a legacy partial checkpoint rather than inventing per-target receipts.
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

COMMENT ON FUNCTION public.fn_thaw_platform(timestamptz, numeric, text) IS
  'Rolling-upgrade compatibility for the already-running legacy engine. It preserves the prior checkpointed thaw under the exclusive admission boundary and cannot create v3 ownership receipts.';

REVOKE ALL ON FUNCTION public.fn_thaw_platform(timestamptz, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_thaw_platform(timestamptz, numeric, text)
  TO service_role;

DO $assert$
DECLARE
  v_platform text := pg_get_functiondef('public.fn_platform_frozen()'::regprocedure);
  v_entry text := pg_get_functiondef('public.fn_entry_purchases_frozen()'::regprocedure);
  v_state text := pg_get_functiondef('public.fn_maintenance_break_state()'::regprocedure);
  v_release text := pg_get_functiondef(
    'public.fn_active_maintenance_release_boundary()'::regprocedure
  );
  v_save text := pg_get_functiondef(
    'public.fn_save_engine_maintenance_break(text,timestamptz,timestamptz,timestamptz,text,text,uuid)'::regprocedure
  );
  v_thaw text := pg_get_functiondef(
    'public.fn_thaw_platform(timestamptz,timestamptz,numeric,uuid,text)'::regprocedure
  );
  v_legacy_thaw text := pg_get_functiondef(
    'public.fn_thaw_platform(timestamptz,numeric,text)'::regprocedure
  );
  v_credit text := pg_get_functiondef(
    'public.fn_credit_maintenance_thaw_targets(timestamptz,numeric)'::regprocedure
  );
  v_reconnect text := pg_get_functiondef(
    'public.fn_thaw_reconnect_states(jsonb,numeric,numeric)'::regprocedure
  );
BEGIN
  IF v_platform NOT LIKE '%phase = ''last_hand''%'
     OR v_platform NOT LIKE '%clock_timestamp()%'
     OR v_entry NOT LIKE '%clock_timestamp()%'
     OR v_platform NOT LIKE '%fn_active_maintenance_release_boundary()%'
     OR v_entry NOT LIKE '%fn_active_maintenance_release_boundary()%'
     OR v_state NOT LIKE '%fn_active_maintenance_release_boundary()%'
     OR v_platform LIKE '%engine_maintenance_thaws%'
     OR v_entry LIKE '%engine_maintenance_thaws%'
     OR v_state LIKE '%engine_maintenance_thaws%' THEN
    RAISE EXCEPTION 'maintenance predicates do not hold the durable recovery interval';
  END IF;
  IF v_release NOT LIKE '%SECURITY DEFINER%'
     OR v_release NOT LIKE '%auth.role()%'
     OR v_release NOT LIKE '%engine_maintenance_thaws%'
     OR v_release NOT LIKE '%release_target_at%'
     OR v_release LIKE '%target_id%'
     OR v_release LIKE '%credited_seconds%' THEN
    RAISE EXCEPTION 'maintenance release certificate accessor is not narrow and caller-aware';
  END IF;
  IF v_thaw NOT LIKE '%pg_advisory_xact_lock(530090, 1)%'
     OR v_thaw NOT LIKE '%fn_thaw_platform_checkpointed%'
     OR v_thaw NOT LIKE '%fn_credit_maintenance_thaw_targets%'
     OR v_thaw NOT LIKE '%maintenance_ownership_changed%'
     OR v_thaw NOT LIKE '%retry_after_ms%'
     OR v_thaw NOT LIKE '%DELETE FROM public.engine_maintenance_break%' THEN
    RAISE EXCEPTION 'maintenance thaw is not exact, serialized, and atomic with release';
  END IF;
  IF v_thaw LIKE '%recovery_window_expired%'
     OR v_save LIKE '%INTERVAL ''8 minutes''%'
     OR v_thaw NOT LIKE '%LEAST(v_existing.frozen_seconds, 900::numeric)%'
     OR v_credit NOT LIKE '%credited_seconds%'
     OR v_credit NOT LIKE '%MAINTENANCE_THAW_TARGET_CHANGED%'
     OR v_reconnect LIKE '%900000%' THEN
    RAISE EXCEPTION 'maintenance recovery can abandon or double-credit a durable interval';
  END IF;
  IF v_legacy_thaw NOT LIKE '%pg_advisory_xact_lock(530090, 1)%'
     OR v_legacy_thaw NOT LIKE '%fn_thaw_platform_checkpointed%'
     OR v_legacy_thaw LIKE '%fn_credit_maintenance_thaw_targets%'
     OR v_legacy_thaw NOT LIKE '%maintenance_identity_mismatch%' THEN
    RAISE EXCEPTION 'legacy rolling-upgrade thaw is not exact and isolated from v3 receipts';
  END IF;
  IF EXISTS (
    SELECT 1
     FROM information_schema.routine_privileges
     WHERE routine_schema = 'public'
       AND routine_name IN (
         'fn_thaw_platform', 'fn_thaw_platform_checkpointed',
         'fn_snapshot_maintenance_thaw_targets',
         'fn_credit_maintenance_thaw_targets'
       )
       AND grantee IN ('PUBLIC', 'anon', 'authenticated')
  ) THEN
    RAISE EXCEPTION 'maintenance thaw is executable by a browser role';
  END IF;
  IF has_table_privilege('anon', 'public.engine_maintenance_thaws', 'SELECT')
     OR has_table_privilege('authenticated', 'public.engine_maintenance_thaws', 'SELECT')
     OR has_table_privilege('anon', 'public.engine_maintenance_thaw_targets', 'SELECT')
     OR has_table_privilege('authenticated', 'public.engine_maintenance_thaw_targets', 'SELECT')
     OR EXISTS (
       SELECT 1
         FROM information_schema.routine_privileges
        WHERE routine_schema = 'public'
          AND routine_name = 'fn_active_maintenance_release_boundary'
          AND grantee = 'PUBLIC'
          AND privilege_type = 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'anon', 'public.fn_active_maintenance_release_boundary()', 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated', 'public.fn_active_maintenance_release_boundary()', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'maintenance release certificate ACL exposes private thaw state';
  END IF;
END;
$assert$;

COMMIT;
