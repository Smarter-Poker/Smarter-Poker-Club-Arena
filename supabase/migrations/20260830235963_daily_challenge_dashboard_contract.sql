-- Daily Missions dashboard truth belongs in one durable server contract.
--
-- The previous page assembled four independent reads and derived career money
-- from today's mutable catalog. It also only exposed unclaimed rewards from
-- the three active periods, so a completed reward disappeared from the vault
-- as soon as its day/week/month rolled over. This migration makes the assigned
-- contract immutable, keeps every completed reward claimable, and returns the
-- complete page in one authenticated receipt.

ALTER TABLE public.user_daily_challenges
  ADD COLUMN IF NOT EXISTS challenge_name_snapshot text,
  ADD COLUMN IF NOT EXISTS challenge_description_snapshot text,
  ADD COLUMN IF NOT EXISTS challenge_type_snapshot text,
  ADD COLUMN IF NOT EXISTS tier_snapshot text,
  ADD COLUMN IF NOT EXISTS requirement_snapshot integer,
  ADD COLUMN IF NOT EXISTS chip_reward_snapshot numeric,
  ADD COLUMN IF NOT EXISTS diamond_reward_snapshot integer;

UPDATE public.user_daily_challenges u
SET challenge_name_snapshot = c.name,
    challenge_description_snapshot = c.description,
    challenge_type_snapshot = c.challenge_type,
    tier_snapshot = c.tier,
    requirement_snapshot = c.requirement,
    chip_reward_snapshot = c.chip_reward,
    diamond_reward_snapshot = c.diamond_reward
FROM public.daily_challenge_catalog c
WHERE c.id = u.challenge_id
  AND (
    u.challenge_name_snapshot IS NULL
    OR u.challenge_description_snapshot IS NULL
    OR u.challenge_type_snapshot IS NULL
    OR u.tier_snapshot IS NULL
    OR u.requirement_snapshot IS NULL
    OR u.chip_reward_snapshot IS NULL
    OR u.diamond_reward_snapshot IS NULL
  );

DO $verify_backfill$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.user_daily_challenges
    WHERE challenge_name_snapshot IS NULL
       OR challenge_description_snapshot IS NULL
       OR challenge_type_snapshot IS NULL
       OR tier_snapshot IS NULL
       OR requirement_snapshot IS NULL
       OR chip_reward_snapshot IS NULL
       OR diamond_reward_snapshot IS NULL
  ) THEN
    RAISE EXCEPTION 'Daily challenge contract backfill left an unknown catalog reference';
  END IF;
END;
$verify_backfill$;

ALTER TABLE public.user_daily_challenges
  ALTER COLUMN challenge_name_snapshot SET NOT NULL,
  ALTER COLUMN challenge_description_snapshot SET NOT NULL,
  ALTER COLUMN challenge_type_snapshot SET NOT NULL,
  ALTER COLUMN tier_snapshot SET NOT NULL,
  ALTER COLUMN requirement_snapshot SET NOT NULL,
  ALTER COLUMN chip_reward_snapshot SET NOT NULL,
  ALTER COLUMN diamond_reward_snapshot SET NOT NULL;

ALTER TABLE public.user_daily_challenges
  DROP CONSTRAINT IF EXISTS user_daily_challenges_requirement_snapshot_positive,
  DROP CONSTRAINT IF EXISTS user_daily_challenges_chip_reward_snapshot_nonnegative,
  DROP CONSTRAINT IF EXISTS user_daily_challenges_diamond_reward_snapshot_nonnegative;

ALTER TABLE public.user_daily_challenges
  ADD CONSTRAINT user_daily_challenges_requirement_snapshot_positive
    CHECK (requirement_snapshot > 0),
  ADD CONSTRAINT user_daily_challenges_chip_reward_snapshot_nonnegative
    CHECK (chip_reward_snapshot >= 0),
  ADD CONSTRAINT user_daily_challenges_diamond_reward_snapshot_nonnegative
    CHECK (diamond_reward_snapshot >= 0);

CREATE OR REPLACE FUNCTION public.fn_snapshot_daily_challenge_contract()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT c.name,
           c.description,
           c.challenge_type,
           c.tier,
           c.requirement,
           c.chip_reward,
           c.diamond_reward
      INTO NEW.challenge_name_snapshot,
           NEW.challenge_description_snapshot,
           NEW.challenge_type_snapshot,
           NEW.tier_snapshot,
           NEW.requirement_snapshot,
           NEW.chip_reward_snapshot,
           NEW.diamond_reward_snapshot
      FROM public.daily_challenge_catalog c
     WHERE c.id = NEW.challenge_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unknown challenge % - cannot snapshot its contract', NEW.challenge_id;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.challenge_name_snapshot IS DISTINCT FROM OLD.challenge_name_snapshot
     OR NEW.challenge_description_snapshot IS DISTINCT FROM OLD.challenge_description_snapshot
     OR NEW.challenge_type_snapshot IS DISTINCT FROM OLD.challenge_type_snapshot
     OR NEW.tier_snapshot IS DISTINCT FROM OLD.tier_snapshot
     OR NEW.requirement_snapshot IS DISTINCT FROM OLD.requirement_snapshot
     OR NEW.chip_reward_snapshot IS DISTINCT FROM OLD.chip_reward_snapshot
     OR NEW.diamond_reward_snapshot IS DISTINCT FROM OLD.diamond_reward_snapshot
  THEN
    RAISE EXCEPTION 'Assigned daily challenge contracts are immutable';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_snapshot_daily_challenge_contract_insert
  ON public.user_daily_challenges;
CREATE TRIGGER trg_snapshot_daily_challenge_contract_insert
BEFORE INSERT ON public.user_daily_challenges
FOR EACH ROW
EXECUTE FUNCTION public.fn_snapshot_daily_challenge_contract();

DROP TRIGGER IF EXISTS trg_snapshot_daily_challenge_contract_update
  ON public.user_daily_challenges;
CREATE TRIGGER trg_snapshot_daily_challenge_contract_update
BEFORE UPDATE OF challenge_name_snapshot,
                 challenge_description_snapshot,
                 challenge_type_snapshot,
                 tier_snapshot,
                 requirement_snapshot,
                 chip_reward_snapshot,
                 diamond_reward_snapshot
ON public.user_daily_challenges
FOR EACH ROW
EXECUTE FUNCTION public.fn_snapshot_daily_challenge_contract();

CREATE INDEX IF NOT EXISTS idx_user_daily_challenges_reward_vault
  ON public.user_daily_challenges (user_id, completed_at DESC, id)
  WHERE completed = true AND claimed = false;

CREATE INDEX IF NOT EXISTS idx_user_daily_challenges_claimed_reward_totals
  ON public.user_daily_challenges (user_id)
  INCLUDE (chip_reward_snapshot, diamond_reward_snapshot)
  WHERE claimed = true;

CREATE INDEX IF NOT EXISTS idx_user_daily_challenges_daily_streak
  ON public.user_daily_challenges (user_id, assigned_date DESC)
  WHERE completed = true AND assigned_date ~ '^\d{4}-\d{2}-\d{2}$';

CREATE TABLE IF NOT EXISTS public.daily_challenge_milestones (
  days integer PRIMARY KEY CHECK (days > 0),
  reward_chips numeric NOT NULL CHECK (reward_chips >= 0),
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.daily_challenge_milestones (days, reward_chips, label)
VALUES
  (7, 500, 'Seven Day Circuit'),
  (14, 1500, 'Two Week Circuit'),
  (30, 5000, 'Thirty Day Circuit'),
  (60, 15000, 'Sixty Day Circuit'),
  (100, 50000, 'Century Circuit')
ON CONFLICT (days) DO UPDATE
SET reward_chips = EXCLUDED.reward_chips,
    label = EXCLUDED.label;

ALTER TABLE public.daily_challenge_milestones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.daily_challenge_milestones FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.daily_challenge_milestones TO service_role;

-- Rebuild streak state with a row lock and without the old 400-day ceiling.
-- `freezes_earned` records every seven-day entitlement, even when inventory is
-- full, so spending a freeze cannot retroactively mint an old skipped reward.
CREATE OR REPLACE FUNCTION public.get_challenge_streak(p_user_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'utc')::date;
  v_state public.challenge_streak_state%ROWTYPE;
  v_days date[];
  v_streak integer := 0;
  v_cursor date;
  v_i integer;
  v_used_freeze boolean := false;
  v_frozen_on date;
  v_entitlements integer;
  v_new_entitlements integer;
  v_inventory_grant integer;
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
      SELECT DISTINCT assigned_date::date AS d
      FROM public.user_daily_challenges
      WHERE user_id = v_uid
        AND completed = true
        AND assigned_date ~ '^\d{4}-\d{2}-\d{2}$'
    ) completed_days;

  IF array_length(v_days, 1) IS NULL THEN
    RETURN jsonb_build_object(
      'streak', 0,
      'freezesAvailable', v_state.freezes_available,
      'usedFreeze', false,
      'frozenDate', NULL,
      'nextFreezeIn', CASE WHEN v_state.freezes_available >= MAX_FREEZES THEN NULL ELSE EARN_EVERY END
    );
  END IF;

  IF v_days[1] = v_today THEN
    v_cursor := v_today;
  ELSIF v_days[1] = v_today - 1 THEN
    v_cursor := v_today - 1;
  ELSE
    RETURN jsonb_build_object(
      'streak', 0,
      'freezesAvailable', v_state.freezes_available,
      'usedFreeze', false,
      'frozenDate', NULL,
      'nextFreezeIn', CASE WHEN v_state.freezes_available >= MAX_FREEZES THEN NULL ELSE EARN_EVERY END
    );
  END IF;

  v_i := 1;
  LOOP
    EXIT WHEN v_i > array_length(v_days, 1);

    IF v_days[v_i] = v_cursor THEN
      v_streak := v_streak + 1;
      v_cursor := v_cursor - 1;
      v_i := v_i + 1;
    ELSIF NOT v_used_freeze
          AND v_streak >= MIN_TO_PROTECT
          AND v_days[v_i] = v_cursor - 1
          AND (v_state.freezes_available > 0 OR v_cursor::text = ANY(v_state.frozen_dates))
    THEN
      IF NOT (v_cursor::text = ANY(v_state.frozen_dates)) THEN
        UPDATE public.challenge_streak_state
        SET freezes_available = freezes_available - 1,
            freezes_used = freezes_used + 1,
            frozen_dates = array_append(frozen_dates, v_cursor::text),
            updated_at = now()
        WHERE user_id = v_uid
        RETURNING * INTO v_state;
      END IF;
      v_used_freeze := true;
      v_frozen_on := v_cursor;
      v_streak := v_streak + 1;
      v_cursor := v_cursor - 1;
    ELSE
      EXIT;
    END IF;
  END LOOP;

  v_entitlements := v_streak / EARN_EVERY;
  v_new_entitlements := GREATEST(v_entitlements - v_state.freezes_earned, 0);
  IF v_new_entitlements > 0 THEN
    v_inventory_grant := LEAST(v_new_entitlements, MAX_FREEZES - v_state.freezes_available);
    UPDATE public.challenge_streak_state
    SET freezes_available = freezes_available + v_inventory_grant,
        freezes_earned = freezes_earned + v_new_entitlements,
        last_earned_at = CASE WHEN v_inventory_grant > 0 THEN now() ELSE last_earned_at END,
        updated_at = now()
    WHERE user_id = v_uid
    RETURNING * INTO v_state;
  END IF;

  RETURN jsonb_build_object(
    'streak', v_streak,
    'freezesAvailable', v_state.freezes_available,
    'usedFreeze', v_used_freeze,
    'frozenDate', v_frozen_on,
    'nextFreezeIn', CASE
      WHEN v_state.freezes_available >= MAX_FREEZES THEN NULL
      ELSE EARN_EVERY - (v_streak % EARN_EVERY)
    END
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_challenge_streak(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_challenge_streak(uuid) TO authenticated, service_role;

-- Keep the legacy one-round-trip mission reader compatible, but render every
-- row from its immutable assignment snapshot rather than the mutable catalog.
DROP FUNCTION IF EXISTS public.get_or_assign_challenges(text, text[], text, text[], text, text[]);
CREATE FUNCTION public.get_or_assign_challenges(
  p_daily_key text,
  p_daily_ids text[],
  p_weekly_key text,
  p_weekly_ids text[],
  p_monthly_key text,
  p_monthly_ids text[]
)
RETURNS TABLE(
  id uuid,
  challenge_id text,
  assigned_date text,
  progress integer,
  completed boolean,
  claimed boolean,
  completed_at timestamptz,
  name text,
  description text,
  challenge_type text,
  requirement integer,
  chip_reward numeric,
  diamond_reward integer,
  tier text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  PERFORM public.assign_user_challenges(p_daily_key, p_daily_ids);
  PERFORM public.assign_user_challenges(p_weekly_key, p_weekly_ids);
  PERFORM public.assign_user_challenges(p_monthly_key, p_monthly_ids);

  RETURN QUERY
  SELECT u.id,
         u.challenge_id,
         u.assigned_date,
         u.progress,
         u.completed,
         u.claimed,
         u.completed_at,
         u.challenge_name_snapshot,
         u.challenge_description_snapshot,
         u.challenge_type_snapshot,
         u.requirement_snapshot,
         u.chip_reward_snapshot,
         u.diamond_reward_snapshot,
         u.tier_snapshot
  FROM public.user_daily_challenges u
  WHERE u.user_id = v_uid
    AND u.assigned_date IN (p_daily_key, p_weekly_key, p_monthly_key)
  ORDER BY CASE u.tier_snapshot WHEN 'daily' THEN 1 WHEN 'weekly' THEN 2 ELSE 3 END,
           u.created_at,
           u.id;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_or_assign_challenges(text, text[], text, text[], text, text[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_or_assign_challenges(text, text[], text, text[], text, text[])
  TO authenticated, service_role;

-- Claims now pay the assignment snapshot. A catalog edit can affect future
-- assignments, never a contract the player already completed.
CREATE OR REPLACE FUNCTION public.claim_daily_challenge(
  p_user_id uuid,
  p_challenge_row_id uuid,
  p_reward_amount numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.user_daily_challenges%ROWTYPE;
  v_new_diamonds integer;
BEGIN
  IF v_uid IS NULL AND public.fn_caller_is_engine() THEN
    v_uid := p_user_id;
  END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_user_id IS NULL OR p_user_id <> v_uid THEN
    RAISE EXCEPTION 'Cannot claim a challenge for another user' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row
  FROM public.user_daily_challenges
  WHERE id = p_challenge_row_id AND user_id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Challenge not found'; END IF;
  IF v_row.claimed THEN
    RETURN jsonb_build_object(
      'claimed', false,
      'alreadyClaimed', true,
      'chips', 0,
      'diamonds', 0,
      'diamondBalance', (SELECT COALESCE(diamonds, 0) FROM public.profiles WHERE id = v_uid)
    );
  END IF;
  IF NOT v_row.completed THEN RAISE EXCEPTION 'Challenge not completed yet'; END IF;
  IF v_row.progress < v_row.requirement_snapshot THEN
    RAISE EXCEPTION 'Challenge progress %/% does not meet the assigned requirement',
      v_row.progress, v_row.requirement_snapshot;
  END IF;
  IF p_reward_amount IS NOT NULL
     AND p_reward_amount IS DISTINCT FROM v_row.chip_reward_snapshot
  THEN
    RAISE EXCEPTION 'Challenge reward changed; refresh and try again';
  END IF;

  UPDATE public.user_daily_challenges
  SET claimed = true, claimed_at = now()
  WHERE id = p_challenge_row_id;

  IF v_row.chip_reward_snapshot > 0 THEN
    IF NOT public.atomic_credit_wallet_and_log(
      v_uid,
      v_row.chip_reward_snapshot,
      'bonus',
      'Challenge reward: ' || v_row.challenge_id,
      NULL,
      NULL,
      NULL,
      'challenge_claim:' || p_challenge_row_id::text
    ) THEN
      RAISE EXCEPTION 'Challenge chip reward credit failed';
    END IF;
  END IF;

  IF v_row.diamond_reward_snapshot > 0 THEN
    UPDATE public.profiles
    SET diamonds = COALESCE(diamonds, 0) + v_row.diamond_reward_snapshot,
        diamond_balance = COALESCE(diamonds, 0) + v_row.diamond_reward_snapshot,
        updated_at = now()
    WHERE id = v_uid
    RETURNING diamonds INTO v_new_diamonds;

    IF v_new_diamonds IS NULL THEN
      RAISE EXCEPTION 'Profile not found for user % - diamond credit failed', v_uid;
    END IF;

    INSERT INTO public.diamond_transactions (
      user_id,
      amount,
      transaction_type,
      type,
      description,
      balance_after,
      metadata,
      reference_id,
      created_at
    ) VALUES (
      v_uid,
      v_row.diamond_reward_snapshot,
      'daily_challenge_claim',
      'daily_challenge_claim',
      'Challenge reward: ' || v_row.challenge_id,
      v_new_diamonds,
      jsonb_build_object(
        'challenge_row_id', p_challenge_row_id,
        'challenge_id', v_row.challenge_id,
        'assigned_chip_reward', v_row.chip_reward_snapshot,
        'assigned_diamond_reward', v_row.diamond_reward_snapshot
      ),
      'challenge_claim:' || p_challenge_row_id::text || ':diamonds',
      now()
    );
  ELSE
    SELECT COALESCE(diamonds, 0) INTO v_new_diamonds
    FROM public.profiles
    WHERE id = v_uid;
  END IF;

  RETURN jsonb_build_object(
    'claimed', true,
    'alreadyClaimed', false,
    'challengeId', v_row.challenge_id,
    'chips', v_row.chip_reward_snapshot,
    'diamonds', v_row.diamond_reward_snapshot,
    'diamondBalance', COALESCE(v_new_diamonds, 0)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_daily_challenge(uuid, uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_daily_challenge(uuid, uuid, numeric)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_daily_challenge_dashboard(
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
  v_missions jsonb := '[]'::jsonb;
  v_streak_receipt jsonb;
  v_streak integer := 0;
  v_total_completed bigint := 0;
  v_total_claimed bigint := 0;
  v_total_chips numeric := 0;
  v_total_diamonds bigint := 0;
  v_vault_count bigint := 0;
  v_vault_chips numeric := 0;
  v_vault_diamonds bigint := 0;
  v_vault_items jsonb := '[]'::jsonb;
  v_diamond_balance integer := 0;
  v_previous_milestone integer := 0;
  v_next_milestone integer;
  v_milestone_reward numeric;
  v_max_milestone integer;
  v_milestone_progress numeric := 0;
  VAULT_PAGE_SIZE constant integer := 100;
  POST_CENTURY_INTERVAL constant integer := 30;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(m)), '[]'::jsonb)
    INTO v_missions
    FROM public.get_or_assign_challenges(
      p_daily_key,
      p_daily_ids,
      p_weekly_key,
      p_weekly_ids,
      p_monthly_key,
      p_monthly_ids
    ) m;

  v_streak_receipt := public.get_challenge_streak(v_uid);
  v_streak := COALESCE((v_streak_receipt->>'streak')::integer, 0);

  SELECT count(*) FILTER (WHERE completed),
         count(*) FILTER (WHERE claimed),
         COALESCE(sum(chip_reward_snapshot) FILTER (WHERE claimed), 0),
         COALESCE(sum(diamond_reward_snapshot) FILTER (WHERE claimed), 0)
    INTO v_total_completed, v_total_claimed, v_total_chips, v_total_diamonds
    FROM public.user_daily_challenges
   WHERE user_id = v_uid;

  SELECT count(*),
         COALESCE(sum(chip_reward_snapshot), 0),
         COALESCE(sum(diamond_reward_snapshot), 0)
    INTO v_vault_count, v_vault_chips, v_vault_diamonds
    FROM public.user_daily_challenges
   WHERE user_id = v_uid
     AND completed = true
     AND claimed = false;

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'id', vault.id,
             'challenge_id', vault.challenge_id,
             'assigned_date', vault.assigned_date,
             'progress', vault.progress,
             'completed', vault.completed,
             'claimed', vault.claimed,
             'completed_at', vault.completed_at,
             'name', vault.challenge_name_snapshot,
             'description', vault.challenge_description_snapshot,
             'challenge_type', vault.challenge_type_snapshot,
             'requirement', vault.requirement_snapshot,
             'chip_reward', vault.chip_reward_snapshot,
             'diamond_reward', vault.diamond_reward_snapshot,
             'tier', vault.tier_snapshot
           )
           ORDER BY vault.completed_at DESC NULLS LAST, vault.id
         ), '[]'::jsonb)
    INTO v_vault_items
    FROM (
      SELECT *
      FROM public.user_daily_challenges
      WHERE user_id = v_uid
        AND completed = true
        AND claimed = false
      ORDER BY completed_at DESC NULLS LAST, created_at DESC, id
      LIMIT VAULT_PAGE_SIZE
    ) vault;

  SELECT COALESCE(diamonds, 0)
    INTO v_diamond_balance
    FROM public.profiles
   WHERE id = v_uid;
  v_diamond_balance := COALESCE(v_diamond_balance, 0);

  SELECT max(days) INTO v_max_milestone
  FROM public.daily_challenge_milestones;

  IF v_streak >= v_max_milestone THEN
    v_previous_milestone := v_max_milestone
      + ((v_streak - v_max_milestone) / POST_CENTURY_INTERVAL) * POST_CENTURY_INTERVAL;
    v_next_milestone := v_previous_milestone + POST_CENTURY_INTERVAL;
    SELECT reward_chips INTO v_milestone_reward
    FROM public.daily_challenge_milestones
    WHERE days = v_max_milestone;
  ELSE
    SELECT COALESCE(max(days), 0)
      INTO v_previous_milestone
      FROM public.daily_challenge_milestones
     WHERE days <= v_streak;

    SELECT days, reward_chips
      INTO v_next_milestone, v_milestone_reward
      FROM public.daily_challenge_milestones
     WHERE days > v_streak
     ORDER BY days
     LIMIT 1;
  END IF;

  IF v_next_milestone > v_previous_milestone THEN
    v_milestone_progress := round(
      ((v_streak - v_previous_milestone)::numeric
        / (v_next_milestone - v_previous_milestone)::numeric) * 100,
      2
    );
  END IF;

  RETURN jsonb_build_object(
    'missions', v_missions,
    'stats', jsonb_build_object(
      'totalCompleted', v_total_completed,
      'totalClaimed', v_total_claimed,
      'currentStreak', v_streak,
      'totalChipsEarned', v_total_chips,
      'totalDiamondsEarned', v_total_diamonds,
      'milestoneStart', v_previous_milestone,
      'nextMilestone', v_next_milestone,
      'milestoneReward', v_milestone_reward,
      'milestoneProgressPercent', v_milestone_progress,
      'daysToMilestone', GREATEST(v_next_milestone - v_streak, 0)
    ),
    'streak', v_streak_receipt,
    'diamondBalance', v_diamond_balance,
    'vault', jsonb_build_object(
      'count', v_vault_count,
      'chips', v_vault_chips,
      'diamonds', v_vault_diamonds,
      'items', v_vault_items,
      'pageSize', VAULT_PAGE_SIZE,
      'hasMore', v_vault_count > VAULT_PAGE_SIZE
    ),
    'syncedAt', to_char(clock_timestamp() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_daily_challenge_dashboard(text, text[], text, text[], text, text[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_daily_challenge_dashboard(text, text[], text, text[], text, text[])
  TO authenticated, service_role;

COMMENT ON FUNCTION public.get_daily_challenge_dashboard(text, text[], text, text[], text, text[])
IS 'One authenticated Daily Missions receipt: active assignments, immutable career totals, streak, spendable diamonds, and persistent unclaimed Reward Vault.';

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'get_daily_challenge_dashboard'
      AND p.proargtypes = '25 1009 25 1009 25 1009'::oidvector
  ) THEN
    RAISE EXCEPTION 'get_daily_challenge_dashboard signature was not created';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.user_daily_challenges
    WHERE requirement_snapshot IS NULL
       OR chip_reward_snapshot IS NULL
       OR diamond_reward_snapshot IS NULL
  ) THEN
    RAISE EXCEPTION 'Daily challenge snapshots are incomplete';
  END IF;
END;
$verify$;

NOTIFY pgrst, 'reload schema';
