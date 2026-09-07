-- get_challenge_streak used `usedFreeze` and `frozenDate` as transient output:
-- they were populated only on the one call that spent inventory. The protected
-- date remained in challenge_streak_state.frozen_dates, but the next dashboard
-- reload returned false/null and made the receipt disappear.
--
-- Preserve compatibility while making the contract truthful across reads:
--   usedFreeze / frozenDate  active-streak state (persistent)
--   lastFrozenDate           explicit persistent name for frozenDate
--   honoredFrozenDates       protected dates in the active streak
--   consumedFreeze           whether this invocation spent inventory
--   consumedFrozenDate       date spent by this invocation, if any

BEGIN;

SET LOCAL lock_timeout = '4s';

-- The calculator refreshes updated_at even when every authoritative streak
-- field is unchanged. The old catch-all UPDATE trigger treated that timestamp
-- write as new dashboard data, so two open tabs could answer each other's
-- reload forever. Preserve INSERT/DELETE coverage, but bump an UPDATE revision
-- only when a field the player can actually see or spend changes.
DROP TRIGGER IF EXISTS trg_daily_challenge_revision_from_streak_lifecycle
  ON public.challenge_streak_state;
DROP TRIGGER IF EXISTS trg_daily_challenge_revision_from_streak
  ON public.challenge_streak_state;

CREATE TRIGGER trg_daily_challenge_revision_from_streak
AFTER UPDATE OF
  freezes_available,
  freezes_used,
  freezes_earned,
  frozen_dates,
  last_earned_at,
  current_streak_run_id,
  current_streak_started_on,
  current_streak_ended_on,
  current_streak_length
ON public.challenge_streak_state
FOR EACH ROW
WHEN (
  ROW(
    OLD.freezes_available,
    OLD.freezes_used,
    OLD.freezes_earned,
    OLD.frozen_dates,
    OLD.last_earned_at,
    OLD.current_streak_run_id,
    OLD.current_streak_started_on,
    OLD.current_streak_ended_on,
    OLD.current_streak_length
  ) IS DISTINCT FROM ROW(
    NEW.freezes_available,
    NEW.freezes_used,
    NEW.freezes_earned,
    NEW.frozen_dates,
    NEW.last_earned_at,
    NEW.current_streak_run_id,
    NEW.current_streak_started_on,
    NEW.current_streak_ended_on,
    NEW.current_streak_length
  )
)
EXECUTE FUNCTION public.bump_daily_challenge_dashboard_revision();

CREATE TRIGGER trg_daily_challenge_revision_from_streak_lifecycle
AFTER INSERT OR DELETE ON public.challenge_streak_state
FOR EACH ROW
EXECUTE FUNCTION public.bump_daily_challenge_dashboard_revision();

ALTER FUNCTION public.get_challenge_streak(uuid)
  RENAME TO get_challenge_streak_calculate_body;

-- Keep the serialized calculator's proven behavior, but do not create a new
-- row version merely to refresh updated_at when its authoritative current-run
-- projection is already exact. v_state already contains the locked row (and
-- any freeze-consumption update), so skipping the UPDATE preserves the same
-- state subsequently used for entitlement inventory and the return receipt.
CREATE OR REPLACE FUNCTION public.get_challenge_streak_calculate_body(
  p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (transaction_timestamp() AT TIME ZONE 'utc')::date;
  v_state public.challenge_streak_state%ROWTYPE;
  v_days date[];
  v_day_count integer := 0;
  v_streak integer := 0;
  v_cursor date;
  v_i integer := 1;
  v_used_new_freeze boolean := false;
  v_frozen_on date;
  v_honored_frozen_dates integer := 0;
  v_started_on date;
  v_ended_on date;
  v_run_id uuid;
  v_historical_run_id uuid;
  v_entitlement_day integer;
  v_new_entitlements integer := 0;
  v_inventory_grant integer := 0;
  v_inserted integer;
  v_probe date;
  v_older_length integer;
  MAX_FREEZES constant integer := 3;
  EARN_EVERY constant integer := 7;
  MIN_TO_PROTECT constant integer := 3;
BEGIN
  IF v_uid IS NULL AND public.fn_caller_is_engine() THEN
    v_uid := p_user_id;
  END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_user_id IS NOT NULL AND p_user_id <> v_uid THEN
    RAISE EXCEPTION 'Cannot read another player''s challenge streak' USING ERRCODE = '42501';
  END IF;

  PERFORM public.fn_lock_daily_mission_user(v_uid);

  INSERT INTO public.challenge_streak_state (user_id)
  VALUES (v_uid)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT * INTO v_state
  FROM public.challenge_streak_state
  WHERE user_id = v_uid
  FOR UPDATE;

  SELECT COALESCE(array_agg(d ORDER BY d DESC), ARRAY[]::date[])
  INTO v_days
  FROM (
    SELECT DISTINCT parsed.completed_on AS d
    FROM public.user_daily_challenges challenge
    CROSS JOIN LATERAL (
      SELECT public.fn_parse_daily_mission_date(challenge.assigned_date) AS completed_on
    ) parsed
    WHERE challenge.user_id = v_uid
      AND challenge.completed
      AND parsed.completed_on IS NOT NULL
      AND parsed.completed_on <= v_today
  ) completed_days;

  v_day_count := COALESCE(array_length(v_days, 1), 0);
  IF v_day_count = 0 OR v_days[1] NOT IN (v_today, v_today - 1) THEN
    RETURN jsonb_build_object(
      'streak', 0,
      'streakRunId', NULL,
      'streakStartedOn', NULL,
      'streakEndedOn', NULL,
      'freezesAvailable', v_state.freezes_available,
      'usedFreeze', false,
      'frozenDate', NULL,
      'honoredFrozenDates', 0,
      'nextFreezeIn', CASE
        WHEN v_state.freezes_available >= MAX_FREEZES THEN NULL
        ELSE EARN_EVERY
      END
    );
  END IF;

  v_ended_on := v_days[1];
  v_cursor := v_ended_on;

  LOOP
    EXIT WHEN v_i > v_day_count;

    IF v_days[v_i] = v_cursor THEN
      v_streak := v_streak + 1;
      v_started_on := v_cursor;
      v_cursor := v_cursor - 1;
      v_i := v_i + 1;
    ELSIF v_cursor::text = ANY(v_state.frozen_dates)
          AND EXISTS (
            SELECT 1 FROM unnest(v_days) completed_day WHERE completed_day < v_cursor
          )
    THEN
      v_honored_frozen_dates := v_honored_frozen_dates + 1;
      v_streak := v_streak + 1;
      v_started_on := v_cursor;
      v_cursor := v_cursor - 1;
    ELSIF NOT v_used_new_freeze
          AND v_state.freezes_available > 0
          AND v_days[v_i] = v_cursor - 1
    THEN
      -- Qualify against either side of the gap. This protects an established
      -- run when the missed date is yesterday, not only gaps encountered after
      -- three newer rows while scanning backwards.
      v_probe := v_cursor - 1;
      v_older_length := 0;
      WHILE v_probe = ANY(v_days)
         OR v_probe::text = ANY(v_state.frozen_dates)
      LOOP
        v_older_length := v_older_length + 1;
        v_probe := v_probe - 1;
      END LOOP;

      IF GREATEST(v_streak, v_older_length) < MIN_TO_PROTECT THEN
        EXIT;
      END IF;

      UPDATE public.challenge_streak_state
      SET freezes_available = freezes_available - 1,
          freezes_used = freezes_used + 1,
          frozen_dates = CASE
            WHEN v_cursor::text = ANY(frozen_dates) THEN frozen_dates
            ELSE array_append(frozen_dates, v_cursor::text)
          END,
          updated_at = now()
      WHERE user_id = v_uid
      RETURNING * INTO v_state;

      v_used_new_freeze := true;
      v_frozen_on := v_cursor;
      v_streak := v_streak + 1;
      v_started_on := v_cursor;
      v_cursor := v_cursor - 1;
    ELSE
      EXIT;
    END IF;
  END LOOP;

  -- When a recorded/new frozen gap reconnects an older rewarded run, prefer
  -- its historical identity. Otherwise retain the current identity whenever
  -- the calculated windows overlap or touch, and mint a UUID only for a truly
  -- disconnected run.
  SELECT historical.streak_run_id
  INTO v_historical_run_id
  FROM (
    SELECT e.streak_run_id, e.created_at
    FROM public.daily_challenge_freeze_entitlements e
    WHERE e.user_id = v_uid
      AND e.streak_started_on = v_started_on
    UNION ALL
    SELECT m.streak_run_id, m.claimed_at
    FROM public.daily_challenge_milestone_claims m
    WHERE m.user_id = v_uid
      AND m.streak_started_on = v_started_on
  ) historical
  ORDER BY historical.created_at
  LIMIT 1;

  IF v_historical_run_id IS NOT NULL THEN
    v_run_id := v_historical_run_id;
  ELSIF v_state.current_streak_run_id IS NOT NULL
        AND v_state.current_streak_started_on <= v_ended_on + 1
        AND v_state.current_streak_ended_on >= v_started_on - 1
  THEN
    v_run_id := v_state.current_streak_run_id;
  ELSE
    v_run_id := gen_random_uuid();
  END IF;

  -- A newly honored frozen gap can extend the authoritative start backwards.
  -- Keep descriptive dates aligned without changing the run's stable identity.
  UPDATE public.daily_challenge_freeze_entitlements
  SET streak_started_on = v_started_on
  WHERE user_id = v_uid
    AND streak_run_id = v_run_id
    AND streak_started_on IS DISTINCT FROM v_started_on;

  UPDATE public.daily_challenge_milestone_claims
  SET streak_started_on = v_started_on
  WHERE user_id = v_uid
    AND streak_run_id = v_run_id
    AND streak_started_on IS DISTINCT FROM v_started_on;

  IF ROW(
    v_state.current_streak_run_id,
    v_state.current_streak_started_on,
    v_state.current_streak_ended_on,
    v_state.current_streak_length
  ) IS DISTINCT FROM ROW(
    v_run_id,
    v_started_on,
    v_ended_on,
    v_streak
  ) THEN
    UPDATE public.challenge_streak_state
    SET current_streak_run_id = v_run_id,
        current_streak_started_on = v_started_on,
        current_streak_ended_on = v_ended_on,
        current_streak_length = v_streak,
        updated_at = now()
    WHERE user_id = v_uid
    RETURNING * INTO v_state;
  END IF;

  -- Insert each threshold once for this run. A threshold reached while the
  -- three-slot inventory is full is still recorded as processed, so spending
  -- later cannot retroactively mint a skipped reward.
  FOR v_entitlement_day IN
    SELECT generate_series(EARN_EVERY, v_streak, EARN_EVERY)
  LOOP
    INSERT INTO public.daily_challenge_freeze_entitlements (
      user_id,
      streak_run_id,
      entitlement_day,
      streak_started_on,
      inventory_granted,
      legacy_accounted
    ) VALUES (
      v_uid,
      v_run_id,
      v_entitlement_day,
      v_started_on,
      false,
      false
    )
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    IF v_inserted = 1 THEN
      v_new_entitlements := v_new_entitlements + 1;
      IF v_state.freezes_available + v_inventory_grant < MAX_FREEZES THEN
        UPDATE public.daily_challenge_freeze_entitlements
        SET inventory_granted = true
        WHERE user_id = v_uid
          AND streak_run_id = v_run_id
          AND entitlement_day = v_entitlement_day;
        v_inventory_grant := v_inventory_grant + 1;
      END IF;
    END IF;
  END LOOP;

  IF v_new_entitlements > 0 THEN
    UPDATE public.challenge_streak_state
    SET freezes_available = freezes_available + v_inventory_grant,
        -- Compatibility/audit total only. Entitlement decisions no longer read
        -- this lifetime counter; the per-run ledger above is authoritative.
        freezes_earned = freezes_earned + v_new_entitlements,
        last_earned_at = CASE
          WHEN v_inventory_grant > 0 THEN now()
          ELSE last_earned_at
        END,
        updated_at = now()
    WHERE user_id = v_uid
    RETURNING * INTO v_state;
  END IF;

  RETURN jsonb_build_object(
    'streak', v_streak,
    'streakRunId', v_run_id,
    'streakStartedOn', v_started_on,
    'streakEndedOn', v_ended_on,
    'freezesAvailable', v_state.freezes_available,
    'usedFreeze', v_used_new_freeze,
    'frozenDate', v_frozen_on,
    'honoredFrozenDates', v_honored_frozen_dates,
    'nextFreezeIn', CASE
      WHEN v_state.freezes_available >= MAX_FREEZES THEN NULL
      ELSE EARN_EVERY - (v_streak % EARN_EVERY)
    END
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_challenge_streak_calculate_body(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.get_challenge_streak(p_user_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_result jsonb;
  v_started_on date;
  v_ended_on date;
  v_frozen_dates text[] := ARRAY[]::text[];
  v_last_frozen_on date;
  v_honored_frozen_dates integer := 0;
  v_consumed_freeze boolean := false;
  v_consumed_frozen_on date;
BEGIN
  IF v_uid IS NULL AND public.fn_caller_is_engine() THEN
    v_uid := p_user_id;
  END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_user_id IS NOT NULL AND p_user_id <> v_uid THEN
    RAISE EXCEPTION 'Cannot read another player''s challenge streak' USING ERRCODE = '42501';
  END IF;

  -- The private body retains the proven calculation, lock, entitlement, and
  -- one-new-freeze-per-call rules. Its old fields are captured below as the
  -- transient consumption event before compatibility fields are overwritten.
  v_result := public.get_challenge_streak_calculate_body(p_user_id);
  v_started_on := public.fn_parse_daily_mission_date(v_result ->> 'streakStartedOn');
  v_ended_on := public.fn_parse_daily_mission_date(v_result ->> 'streakEndedOn');
  v_consumed_freeze := COALESCE((v_result ->> 'usedFreeze')::boolean, false);
  v_consumed_frozen_on := public.fn_parse_daily_mission_date(v_result ->> 'frozenDate');

  IF v_consumed_freeze IS DISTINCT FROM (v_consumed_frozen_on IS NOT NULL) THEN
    RAISE EXCEPTION 'Daily Missions freeze calculation returned an incomplete consumption receipt';
  END IF;

  SELECT state.frozen_dates
  INTO v_frozen_dates
  FROM public.challenge_streak_state state
  WHERE state.user_id = v_uid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Daily Missions streak state was not persisted';
  END IF;

  IF v_started_on IS NOT NULL AND v_ended_on IS NOT NULL THEN
    SELECT max(parsed.frozen_on), count(DISTINCT parsed.frozen_on)::integer
    INTO v_last_frozen_on, v_honored_frozen_dates
    FROM unnest(v_frozen_dates) frozen(frozen_text)
    CROSS JOIN LATERAL (
      SELECT public.fn_parse_daily_mission_date(frozen.frozen_text) AS frozen_on
    ) parsed
    WHERE parsed.frozen_on BETWEEN v_started_on AND v_ended_on
      -- A historical malformed state could contain a day that was later also
      -- completed. The streak calculation treats that as a completed day, not
      -- a spent freeze, so the persistent receipt must make the same choice.
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_daily_challenges challenge
        WHERE challenge.user_id = v_uid
          AND challenge.completed
          AND public.fn_parse_daily_mission_date(challenge.assigned_date) = parsed.frozen_on
      );
  END IF;

  IF v_consumed_freeze AND NOT (v_consumed_frozen_on::text = ANY(v_frozen_dates)) THEN
    RAISE EXCEPTION 'Daily Missions consumed freeze was not preserved in streak history';
  END IF;

  RETURN v_result || jsonb_build_object(
    'usedFreeze', v_last_frozen_on IS NOT NULL,
    'frozenDate', v_last_frozen_on,
    'lastFrozenDate', v_last_frozen_on,
    'honoredFrozenDates', v_honored_frozen_dates,
    'consumedFreeze', v_consumed_freeze,
    'consumedFrozenDate', v_consumed_frozen_on,
    'freezeReceiptVersion', 2
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_challenge_streak(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_challenge_streak(uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.get_challenge_streak(uuid) IS
'Returns the authoritative streak and persistent freeze history. usedFreeze/frozenDate describe protection in the active run; consumedFreeze/consumedFrozenDate describe only inventory spent by this invocation.';

COMMENT ON FUNCTION public.get_challenge_streak_calculate_body(uuid) IS
'Private serialized streak calculator. Public callers use get_challenge_streak, which separates persistent freeze history from one-call inventory consumption.';

DO $verify$
DECLARE
  v_definition text;
  v_calculator_definition text;
  v_calculator_guard text;
  v_update_trigger text;
BEGIN
  SELECT pg_get_functiondef(
    'public.get_challenge_streak(uuid)'::regprocedure
  ) INTO v_definition;
  SELECT pg_get_functiondef(
    'public.get_challenge_streak_calculate_body(uuid)'::regprocedure
  ) INTO v_calculator_definition;
  SELECT pg_get_triggerdef(oid)
  INTO v_update_trigger
  FROM pg_catalog.pg_trigger
  WHERE tgrelid = 'public.challenge_streak_state'::regclass
    AND tgname = 'trg_daily_challenge_revision_from_streak'
    AND NOT tgisinternal;

  IF position('IF ROW(' IN v_calculator_definition) > 0 THEN
    -- Only inspect through the first matching guard terminator. This prevents
    -- a dead guard followed by the old unconditional UPDATE from satisfying
    -- the deployment certification merely because all tokens still exist.
    v_calculator_guard := split_part(
      substring(
        v_calculator_definition
        FROM position('IF ROW(' IN v_calculator_definition)
      ),
      'END IF;',
      1
    );
  END IF;

  IF v_definition NOT LIKE '%lastFrozenDate%'
     OR v_definition NOT LIKE '%honoredFrozenDates%'
     OR v_definition NOT LIKE '%consumedFreeze%'
     OR v_definition NOT LIKE '%consumedFrozenDate%'
     OR v_definition NOT LIKE '%get_challenge_streak_calculate_body%'
  THEN
    RAISE EXCEPTION 'Daily Missions persistent freeze receipt v2 is not installed';
  END IF;

  IF COALESCE(v_calculator_guard, '') NOT LIKE
       '%v_state.current_streak_length%IS DISTINCT FROM ROW(%'
     OR COALESCE(v_calculator_guard, '') NOT LIKE
       '%v_run_id,%v_started_on,%v_ended_on,%v_streak%) THEN%'
     OR COALESCE(v_calculator_guard, '') NOT LIKE
       '%UPDATE public.challenge_streak_state%SET current_streak_run_id = v_run_id%RETURNING * INTO v_state;%'
  THEN
    RAISE EXCEPTION 'Daily Missions streak calculator still writes timestamp-only warm reads';
  END IF;

  IF v_update_trigger IS NULL
     OR v_update_trigger NOT LIKE '%UPDATE OF freezes_available%'
     OR v_update_trigger NOT LIKE '%IS DISTINCT FROM%'
     OR v_update_trigger LIKE '%updated_at%'
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger
       WHERE tgrelid = 'public.challenge_streak_state'::regclass
         AND tgname = 'trg_daily_challenge_revision_from_streak_lifecycle'
         AND NOT tgisinternal
         AND tgenabled <> 'D'
     )
  THEN
    RAISE EXCEPTION 'Daily Missions streak revision trigger still broadcasts no-op reads';
  END IF;

  IF has_function_privilege(
    'authenticated',
    'public.get_challenge_streak_calculate_body(uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Private Daily Missions streak calculator is browser executable';
  END IF;
END;
$verify$;

COMMIT;
