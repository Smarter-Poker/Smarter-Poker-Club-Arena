-- Daily Missions certification repairs.
--
-- 1. Derive active period keys inside PostgreSQL so a skewed browser clock or
--    an in-flight UTC rollover cannot make the entire dashboard unavailable.
-- 2. Rotate through the complete Daily catalog. The previous five reward
--    buckets permanently excluded 29 of 39 valid contracts.
-- 3. Restore the deleted-profile guard that a later Broadcast migration
--    accidentally replaced, then emit a dedicated private completion signal
--    for the app-wide completion toast.
-- 4. Keep retired catalog rows available to name earned historical contracts
--    without ever dealing them into a new assignment or paid reroll.
-- 5. Reassert the server-only assignment/progress authority in the migration
--    chain, matching the already-secure production ACL on a fresh rebuild.

BEGIN;

SET LOCAL lock_timeout = '4s';

-- Production already has this authority boundary, but its original repair was
-- not recorded in the repository. Reassert it so a fresh database cannot
-- recreate the legacy self-assignment and self-completion policies.
DROP POLICY IF EXISTS "Users can insert own challenges"
  ON public.user_daily_challenges;
DROP POLICY IF EXISTS "Users can update own challenges"
  ON public.user_daily_challenges;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON TABLE public.user_daily_challenges
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.user_daily_challenges TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_daily_challenges TO service_role;

ALTER TABLE public.daily_challenge_catalog ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON TABLE public.daily_challenge_catalog
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.daily_challenge_catalog TO service_role;

-- A handful of generic rows must remain because completed historical
-- assignments still reference them. Make deal eligibility explicit instead of
-- confusing "present in the audit catalog" with "available for a new deal."
ALTER TABLE public.daily_challenge_catalog
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT false;

UPDATE public.daily_challenge_catalog
SET is_active = (id = ANY (ARRAY[
  'hp_10', 'hp_25', 'hp_50', 'hp_100', 'hp_200',
  'hw_3', 'hw_8', 'hw_15', 'hw_30',
  'sd_3', 'sd_10', 'sd_20',
  'sdw_2', 'sdw_5', 'sdw_10',
  'nsw_3', 'nsw_7', 'nsw_12',
  'bp_500_1', 'bp_500_3', 'bp_1000_1', 'bp_1000_3', 'bp_2500_1', 'bp_5000_1',
  'sh_str_1', 'sh_str_3', 'sh_fl_1', 'sh_fl_2', 'sh_fh_1', 'sh_quad_1',
  'cw_2500', 'cw_10000', 'cw_25000', 'cw_100000',
  'tp_1', 'tp_3', 'tp_5', 'fa_1', 'fa_3',
  'wk_hands_500', 'wk_wins_100', 'wk_sdw_40', 'wk_nsw_50',
  'wk_bp_1000_15', 'wk_sh_fl_10', 'wk_chips_250k', 'wk_tourneys_10',
  'mo_hands_2500', 'mo_wins_500', 'mo_bp_2500_25', 'mo_sh_fh_25',
  'mo_chips_1m', 'mo_tourneys_40'
]::text[]));

COMMENT ON COLUMN public.daily_challenge_catalog.is_active IS
'True only for contracts eligible for a new assignment or reroll. Retired rows remain to preserve historical contract identity.';

CREATE OR REPLACE FUNCTION public.fn_assign_current_challenge_period(
  p_user_id uuid,
  p_tier text,
  p_period_key text,
  p_count integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_day_index integer;
  v_existing integer;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'A player is required';
  END IF;
  IF p_tier IS NULL OR p_period_key IS NULL OR p_count IS NULL
     OR (p_tier = 'daily' AND (p_count <> 5 OR p_period_key !~ '^\d{4}-\d{2}-\d{2}$'))
     OR (p_tier = 'weekly' AND (p_count <> 3 OR p_period_key !~ '^W\d{4}-\d{2}-\d{2}$'))
     OR (p_tier = 'monthly' AND (p_count <> 2 OR p_period_key !~ '^M\d{4}-\d{2}$'))
     OR p_tier NOT IN ('daily', 'weekly', 'monthly') THEN
    RAISE EXCEPTION 'Invalid canonical Daily Missions period contract';
  END IF;

  SELECT count(*) INTO v_existing
  FROM public.user_daily_challenges
  WHERE user_id = p_user_id AND assigned_date = p_period_key;

  IF v_existing > p_count OR EXISTS (
    SELECT 1
    FROM public.user_daily_challenges
    WHERE user_id = p_user_id
      AND assigned_date = p_period_key
      AND tier_snapshot IS DISTINCT FROM p_tier
  ) THEN
    RAISE EXCEPTION 'Existing % period is not a canonical Daily Missions contract set', p_tier;
  END IF;
  IF v_existing = p_count THEN
    RETURN;
  END IF;

  IF p_tier = 'daily' THEN
    v_day_index := abs(p_period_key::date - date '1970-01-01');

    -- Five distinct challenge types move through a circular type wheel. Each
    -- selected type advances through its own complete catalog list. This
    -- guarantees bounded exposure for every active Daily contract without
    -- coupling selection eligibility to its reward amount.
    INSERT INTO public.user_daily_challenges (
      user_id, challenge_id, assigned_date, progress, completed
    )
    WITH challenge_types AS (
      SELECT challenge_type,
             row_number() OVER (ORDER BY challenge_type) - 1 AS type_ordinal,
             count(*) OVER () AS type_count
      FROM (
        SELECT DISTINCT challenge_type
        FROM public.daily_challenge_catalog
        WHERE tier = 'daily' AND is_active
      ) types
    ), ranked AS (
      SELECT c.id,
             row_number() OVER (PARTITION BY c.challenge_type ORDER BY c.id) - 1 AS item_ordinal,
             count(*) OVER (PARTITION BY c.challenge_type) AS item_count,
             t.type_ordinal,
             t.type_count,
             mod(
               t.type_ordinal - mod(v_day_index::bigint, t.type_count) + t.type_count,
               t.type_count
             ) AS type_distance
      FROM public.daily_challenge_catalog c
      JOIN challenge_types t USING (challenge_type)
      WHERE c.tier = 'daily' AND c.is_active
    ), selected AS (
      SELECT id, type_ordinal, type_distance
      FROM ranked
      WHERE type_distance < p_count
        AND item_ordinal = mod(
          (v_day_index::bigint / type_count) + type_distance,
          item_count
        )
    )
    SELECT p_user_id, selected.id, p_period_key, 0, false
    FROM selected
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.user_daily_challenges existing
      WHERE existing.user_id = p_user_id
        AND existing.assigned_date = p_period_key
        AND existing.challenge_id = selected.id
    )
    ORDER BY selected.type_distance, selected.type_ordinal, selected.id
    LIMIT (p_count - v_existing)
    ON CONFLICT (user_id, challenge_id, assigned_date) DO NOTHING;
  ELSE
    INSERT INTO public.user_daily_challenges (
      user_id, challenge_id, assigned_date, progress, completed
    )
    WITH one_per_type AS (
      SELECT DISTINCT ON (c.challenge_type)
             c.id,
             c.challenge_type,
             md5(p_period_key || '|' || c.id) AS draw
      FROM public.daily_challenge_catalog c
      WHERE c.tier = p_tier AND c.is_active
      ORDER BY c.challenge_type, md5(p_period_key || '|' || c.id), c.id
    )
    SELECT p_user_id, one_per_type.id, p_period_key, 0, false
    FROM one_per_type
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.user_daily_challenges existing
      WHERE existing.user_id = p_user_id
        AND existing.assigned_date = p_period_key
        AND existing.challenge_id = one_per_type.id
    )
    ORDER BY draw, id
    LIMIT (p_count - v_existing)
    ON CONFLICT (user_id, challenge_id, assigned_date) DO NOTHING;
  END IF;

  IF (
    SELECT count(*)
    FROM public.user_daily_challenges
    WHERE user_id = p_user_id AND assigned_date = p_period_key
  ) <> p_count THEN
    RAISE EXCEPTION 'Catalog cannot supply the canonical % % contracts', p_count, p_tier;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_assign_current_challenge_period(uuid, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_assign_current_challenge_period(uuid, text, text, integer)
  TO service_role;

-- Assign before taking the per-player revision lock. The previous ordering
-- could deadlock a first dashboard load against an authoritative gameplay
-- event: each transaction waited on a row lock held by the other. The public
-- compatibility signature remains unchanged and assign_user_challenges keeps
-- validating that all three requested periods are the current UTC periods.
CREATE OR REPLACE FUNCTION public.get_daily_challenge_dashboard_v2(
  p_daily_key text,
  p_daily_ids text[],
  p_weekly_key text,
  p_weekly_ids text[],
  p_monthly_key text,
  p_monthly_ids text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_dashboard jsonb;
  v_revision bigint;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  PERFORM public.assign_user_challenges(p_daily_key, p_daily_ids);
  PERFORM public.assign_user_challenges(p_weekly_key, p_weekly_ids);
  PERFORM public.assign_user_challenges(p_monthly_key, p_monthly_ids);

  INSERT INTO public.daily_challenge_dashboard_revisions (user_id, revision, updated_at)
  VALUES (v_uid, 1, clock_timestamp())
  ON CONFLICT (user_id) DO NOTHING;

  PERFORM 1
  FROM public.daily_challenge_dashboard_revisions
  WHERE user_id = v_uid
  FOR UPDATE;

  v_dashboard := public.get_daily_challenge_dashboard(
    p_daily_key,
    p_daily_ids,
    p_weekly_key,
    p_weekly_ids,
    p_monthly_key,
    p_monthly_ids
  );

  SELECT revision
    INTO v_revision
    FROM public.daily_challenge_dashboard_revisions
   WHERE user_id = v_uid;

  RETURN v_dashboard || jsonb_build_object('revision', COALESCE(v_revision, 1));
END;
$function$;

REVOKE ALL ON FUNCTION public.get_daily_challenge_dashboard_v2(
  text, text[], text, text[], text, text[]
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_daily_challenge_dashboard_v2(
  text, text[], text, text[], text, text[]
) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_daily_challenge_dashboard_v3()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- Match every nested assignment/streak contract, all of which uses now(). A
  -- stable transaction clock prevents an in-flight UTC rollover from giving
  -- the wrapper tomorrow's key while the nested function still validates today.
  v_now timestamp := transaction_timestamp() AT TIME ZONE 'utc';
  v_daily_key text;
  v_weekly_key text;
  v_monthly_key text;
  v_dashboard jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  v_daily_key := to_char(v_now::date, 'YYYY-MM-DD');
  v_weekly_key := 'W' || to_char(date_trunc('week', v_now)::date, 'YYYY-MM-DD');
  v_monthly_key := 'M' || to_char(v_now, 'YYYY-MM');

  v_dashboard := public.get_daily_challenge_dashboard_v2(
    v_daily_key,
    ARRAY[]::text[],
    v_weekly_key,
    ARRAY[]::text[],
    v_monthly_key,
    ARRAY[]::text[]
  );

  RETURN v_dashboard || jsonb_build_object(
    'periodKeys', jsonb_build_object(
      'daily', v_daily_key,
      'weekly', v_weekly_key,
      'monthly', v_monthly_key
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_daily_challenge_dashboard_v3()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_daily_challenge_dashboard_v3()
  TO authenticated, service_role;

-- Paid rerolls use the same active-catalog boundary as fresh assignment. The
-- complete function is restated because PostgreSQL cannot patch one query in a
-- stored function body, and preserving its replay-safe receipt is essential.
CREATE OR REPLACE FUNCTION public.reroll_daily_challenge(
  p_user_id uuid,
  p_challenge_row_id uuid,
  p_expected_challenge_id text,
  p_cost integer DEFAULT 10
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  REROLL_COST constant integer := 10;
  v_uid uuid := auth.uid();
  v_row public.user_daily_challenges%ROWTYPE;
  v_replacement text;
  v_deduct jsonb;
  v_balance integer;
BEGIN
  IF v_uid IS NULL AND public.fn_caller_is_engine() THEN
    v_uid := p_user_id;
  END IF;
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authenticated');
  END IF;
  IF p_user_id IS NULL OR p_user_id <> v_uid THEN
    RETURN jsonb_build_object('success', false, 'error', 'cannot reroll another player''s challenge');
  END IF;
  IF p_cost IS DISTINCT FROM REROLL_COST THEN
    RETURN jsonb_build_object('success', false, 'error', 'reroll price changed; refresh and try again');
  END IF;

  SELECT * INTO v_row
    FROM public.user_daily_challenges
   WHERE id = p_challenge_row_id
     AND user_id = v_uid
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'challenge not found');
  END IF;

  IF v_row.challenge_id IS DISTINCT FROM p_expected_challenge_id THEN
    SELECT COALESCE(diamonds, 0)::integer INTO v_balance
      FROM public.profiles WHERE id = v_uid;
    RETURN jsonb_build_object(
      'success', true,
      'alreadyRerolled', true,
      'challengeId', v_row.challenge_id,
      'diamondBalance', COALESCE(v_balance, 0),
      'challenge', jsonb_build_object(
        'id', v_row.id,
        'challenge_id', v_row.challenge_id,
        'assigned_date', v_row.assigned_date,
        'progress', v_row.progress,
        'completed', v_row.completed,
        'claimed', v_row.claimed,
        'completed_at', v_row.completed_at,
        'name', v_row.challenge_name_snapshot,
        'description', v_row.challenge_description_snapshot,
        'challenge_type', v_row.challenge_type_snapshot,
        'requirement', v_row.requirement_snapshot,
        'chip_reward', 0,
        'diamond_reward', v_row.diamond_reward_snapshot,
        'tier', v_row.tier_snapshot
      )
    );
  END IF;

  IF v_row.completed OR v_row.claimed THEN
    RETURN jsonb_build_object('success', false, 'error', 'completed challenges cannot be rerolled');
  END IF;

  SELECT c.id INTO v_replacement
    FROM public.daily_challenge_catalog c
   WHERE c.tier = v_row.tier_snapshot
     AND c.is_active
     AND c.id <> v_row.challenge_id
     AND NOT EXISTS (
       SELECT 1
         FROM public.user_daily_challenges active
        WHERE active.user_id = v_uid
          AND active.assigned_date = v_row.assigned_date
          AND active.challenge_id = c.id
     )
   ORDER BY random()
   LIMIT 1;

  IF v_replacement IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no replacement challenge is available');
  END IF;

  v_deduct := public.deduct_diamonds(
    p_user_id          := v_uid,
    p_amount           := REROLL_COST,
    p_description      := 'Daily challenge reroll',
    p_transaction_type := 'challenge_reroll',
    p_source           := 'daily_challenge_reroll',
    p_metadata         := jsonb_build_object(
                            'challenge_row_id', v_row.id,
                            'from_challenge_id', v_row.challenge_id,
                            'to_challenge_id', v_replacement,
                            'tier', v_row.tier_snapshot),
    p_reference_id     := 'challenge_reroll:' || v_row.id::text || ':' || v_row.challenge_id
  );

  IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', COALESCE(v_deduct->>'error', 'not enough diamonds'));
  END IF;

  PERFORM set_config('app.daily_challenge_reroll', '1', true);
  UPDATE public.user_daily_challenges
     SET challenge_id = v_replacement,
         progress = 0,
         completed = false,
         claimed = false,
         completed_at = NULL,
         claimed_at = NULL
   WHERE id = v_row.id
     AND user_id = v_uid
  RETURNING * INTO v_row;

  SELECT COALESCE(diamonds, 0)::integer INTO v_balance
    FROM public.profiles WHERE id = v_uid;

  RETURN jsonb_build_object(
    'success', true,
    'alreadyRerolled', false,
    'challengeId', v_row.challenge_id,
    'diamondBalance', COALESCE(v_balance, 0),
    'diamondsSpent', REROLL_COST,
    'challenge', jsonb_build_object(
      'id', v_row.id,
      'challenge_id', v_row.challenge_id,
      'assigned_date', v_row.assigned_date,
      'progress', v_row.progress,
      'completed', v_row.completed,
      'claimed', v_row.claimed,
      'completed_at', v_row.completed_at,
      'name', v_row.challenge_name_snapshot,
      'description', v_row.challenge_description_snapshot,
      'challenge_type', v_row.challenge_type_snapshot,
      'requirement', v_row.requirement_snapshot,
      'chip_reward', 0,
      'diamond_reward', v_row.diamond_reward_snapshot,
      'tier', v_row.tier_snapshot
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer)
  TO authenticated, service_role;

DROP POLICY IF EXISTS "users receive own daily mission completion broadcasts"
  ON realtime.messages;
CREATE POLICY "users receive own daily mission completion broadcasts"
  ON realtime.messages
  FOR SELECT TO authenticated
  USING (
    realtime.messages.extension = 'broadcast'
    AND (SELECT realtime.topic()) =
      'daily-mission-completion:' || (SELECT auth.uid())::text
  );

CREATE OR REPLACE FUNCTION public.bump_daily_challenge_dashboard_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_user_id uuid;
  v_revision bigint;
BEGIN
  IF TG_TABLE_NAME = 'profiles' THEN
    v_user_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    v_user_id := OLD.user_id;
  ELSE
    v_user_id := NEW.user_id;
  END IF;

  -- Cascading account deletion removes the profile before child triggers run.
  -- A cursor for a deleted user is unusable and would violate the cursor FK.
  IF v_user_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_user_id) THEN
    INSERT INTO public.daily_challenge_dashboard_revisions (user_id, revision, updated_at)
    VALUES (v_user_id, 1, clock_timestamp())
    ON CONFLICT (user_id) DO UPDATE
      SET revision = public.daily_challenge_dashboard_revisions.revision + 1,
          updated_at = EXCLUDED.updated_at
    RETURNING revision INTO v_revision;

    BEGIN
      PERFORM realtime.send(
        jsonb_build_object('revision', v_revision),
        'daily_mission_revision_changed',
        'daily-mission-revision:' || v_user_id::text,
        true
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Daily Mission revision broadcast failed: %', SQLERRM;
    END;

    IF TG_TABLE_NAME = 'user_daily_challenges' THEN
      IF TG_OP = 'UPDATE'
         AND OLD.completed IS NOT TRUE
         AND NEW.completed IS TRUE THEN
        BEGIN
          PERFORM realtime.send(
            jsonb_build_object(
              'id', NEW.id,
              'challengeId', NEW.challenge_id,
              'name', NEW.challenge_name_snapshot,
              'diamondReward', NEW.diamond_reward_snapshot
            ),
            'daily_mission_completed',
            'daily-mission-completion:' || v_user_id::text,
            true
          );
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING 'Daily Mission completion broadcast failed: %', SQLERRM;
        END;
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.bump_daily_challenge_dashboard_revision()
  FROM PUBLIC, anon;

DO $verify$
DECLARE
  v_assign_source text;
  v_dashboard_v2_source text;
  v_reroll_source text;
  v_revision_source text;
BEGIN
  IF has_table_privilege('authenticated', 'public.user_daily_challenges', 'INSERT')
     OR has_table_privilege('authenticated', 'public.user_daily_challenges', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.user_daily_challenges', 'DELETE')
     OR has_table_privilege('anon', 'public.user_daily_challenges', 'INSERT')
     OR has_table_privilege('anon', 'public.user_daily_challenges', 'UPDATE') THEN
    RAISE EXCEPTION 'Browser roles retain Daily Mission mutation authority';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.user_daily_challenges', 'SELECT') THEN
    RAISE EXCEPTION 'Authenticated players cannot read their RLS-scoped Daily Missions';
  END IF;
  IF has_table_privilege('authenticated', 'public.daily_challenge_catalog', 'INSERT')
     OR has_table_privilege('authenticated', 'public.daily_challenge_catalog', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.daily_challenge_catalog', 'DELETE')
     OR has_table_privilege('anon', 'public.daily_challenge_catalog', 'INSERT')
     OR has_table_privilege('anon', 'public.daily_challenge_catalog', 'UPDATE')
     OR has_table_privilege('anon', 'public.daily_challenge_catalog', 'DELETE') THEN
    RAISE EXCEPTION 'Browser roles retain Daily Mission catalog mutation authority';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_daily_challenges'
      AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
      AND roles && ARRAY['authenticated', 'public']::name[]
  ) THEN
    RAISE EXCEPTION 'A browser-writable Daily Mission policy remains active';
  END IF;

  IF (SELECT count(*) FROM public.daily_challenge_catalog WHERE is_active AND tier = 'daily') <> 39
     OR (SELECT count(*) FROM public.daily_challenge_catalog WHERE is_active AND tier = 'weekly') <> 8
     OR (SELECT count(*) FROM public.daily_challenge_catalog WHERE is_active AND tier = 'monthly') <> 6 THEN
    RAISE EXCEPTION 'Active Daily Mission catalog does not match the canonical 39/8/6 contract set';
  END IF;
  IF (
    SELECT count(DISTINCT challenge_type)
    FROM public.daily_challenge_catalog
    WHERE tier = 'daily' AND is_active
  ) <> 10 THEN
    RAISE EXCEPTION 'Active Daily Mission catalog does not cover all ten event types';
  END IF;
  IF (
    SELECT count(DISTINCT challenge_type)
    FROM public.daily_challenge_catalog
    WHERE tier = 'daily' AND is_active
  ) < 5 THEN
    RAISE EXCEPTION 'Daily catalog cannot provide five type-diverse contracts';
  END IF;

  SELECT pg_get_functiondef(
    'public.fn_assign_current_challenge_period(uuid,text,text,integer)'::regprocedure
  ) INTO v_assign_source;
  IF v_assign_source LIKE '%buckets(reward, ordinal)%'
     OR v_assign_source LIKE '%c.diamond_reward = b.reward%'
     OR v_assign_source NOT LIKE '%c.is_active%'
     OR v_assign_source NOT LIKE '%p_tier IS NULL%'
     OR v_assign_source NOT LIKE '%p_period_key IS NULL%'
     OR v_assign_source NOT LIKE '%p_count IS NULL%' THEN
    RAISE EXCEPTION 'Reward-bucket Daily selection is still active';
  END IF;

  SELECT pg_get_functiondef(
    'public.get_daily_challenge_dashboard_v2(text,text[],text,text[],text,text[])'::regprocedure
  ) INTO v_dashboard_v2_source;
  IF position('PERFORM public.assign_user_challenges' IN v_dashboard_v2_source) = 0
     OR position('PERFORM public.assign_user_challenges' IN v_dashboard_v2_source)
        > position('FOR UPDATE' IN v_dashboard_v2_source) THEN
    RAISE EXCEPTION 'Dashboard revision lock is still taken before first-load assignment';
  END IF;

  SELECT pg_get_functiondef(
    'public.reroll_daily_challenge(uuid,uuid,text,integer)'::regprocedure
  ) INTO v_reroll_source;
  IF v_reroll_source NOT LIKE '%c.is_active%' THEN
    RAISE EXCEPTION 'Paid rerolls can still select a retired Daily Mission';
  END IF;

  IF to_regprocedure('public.get_daily_challenge_dashboard_v3()') IS NULL THEN
    RAISE EXCEPTION 'Server-clock Daily Missions dashboard is missing';
  END IF;
  IF has_function_privilege(
    'anon',
    'public.get_daily_challenge_dashboard_v3()',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Anonymous callers can execute the Daily Missions dashboard';
  END IF;

  SELECT pg_get_functiondef(
    'public.bump_daily_challenge_dashboard_revision()'::regprocedure
  ) INTO v_revision_source;
  IF v_revision_source NOT LIKE '%EXISTS (SELECT 1 FROM public.profiles%'
     OR v_revision_source NOT LIKE '%daily_mission_completed%'
     OR v_revision_source NOT LIKE '%daily-mission-completion:%' THEN
    RAISE EXCEPTION 'Daily Mission revision and completion Broadcast contract is incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'realtime'
      AND tablename = 'messages'
      AND policyname = 'users receive own daily mission completion broadcasts'
      AND cmd = 'SELECT'
      AND roles = ARRAY['authenticated']::name[]
  ) THEN
    RAISE EXCEPTION 'Daily Mission completion Broadcast policy is missing';
  END IF;
END;
$verify$;

COMMENT ON FUNCTION public.get_daily_challenge_dashboard_v3() IS
'Atomic Daily Missions dashboard using server-authoritative UTC period keys.';

NOTIFY pgrst, 'reload schema';

COMMIT;
