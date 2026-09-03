-- Daily Missions server authority, immutable progress contracts, and real
-- event wiring. This closes the authenticated unlimited-reward mint exposed by
-- the legacy assignment/progress RPCs.

ALTER TABLE public.user_daily_challenges
  ADD COLUMN IF NOT EXISTS threshold_snapshot integer;

UPDATE public.user_daily_challenges u
SET threshold_snapshot = c.threshold
FROM public.daily_challenge_catalog c
WHERE c.id = u.challenge_id
  AND u.threshold_snapshot IS DISTINCT FROM c.threshold;

CREATE OR REPLACE FUNCTION public.fn_snapshot_daily_challenge_contract()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_replacement_tier text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT c.name, c.description, c.challenge_type, c.tier, c.requirement,
           c.threshold, c.chip_reward, c.diamond_reward
      INTO NEW.challenge_name_snapshot, NEW.challenge_description_snapshot,
           NEW.challenge_type_snapshot, NEW.tier_snapshot, NEW.requirement_snapshot,
           NEW.threshold_snapshot, NEW.chip_reward_snapshot, NEW.diamond_reward_snapshot
      FROM public.daily_challenge_catalog c
     WHERE c.id = NEW.challenge_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unknown challenge % - cannot snapshot its contract', NEW.challenge_id;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.challenge_id IS DISTINCT FROM OLD.challenge_id THEN
    IF current_setting('app.daily_challenge_reroll', true) IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'Assigned daily challenges can only be replaced by the reroll contract';
    END IF;
    IF OLD.completed OR OLD.claimed THEN
      RAISE EXCEPTION 'Completed daily challenge contracts cannot be replaced';
    END IF;
    IF NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.assigned_date IS DISTINCT FROM OLD.assigned_date
       OR NEW.id IS DISTINCT FROM OLD.id
    THEN
      RAISE EXCEPTION 'A reroll cannot move a daily challenge contract';
    END IF;

    SELECT c.name, c.description, c.challenge_type, c.tier, c.requirement,
           c.threshold, c.chip_reward, c.diamond_reward
      INTO NEW.challenge_name_snapshot, NEW.challenge_description_snapshot,
           NEW.challenge_type_snapshot, v_replacement_tier, NEW.requirement_snapshot,
           NEW.threshold_snapshot, NEW.chip_reward_snapshot, NEW.diamond_reward_snapshot
      FROM public.daily_challenge_catalog c
     WHERE c.id = NEW.challenge_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Unknown replacement challenge %', NEW.challenge_id; END IF;
    IF v_replacement_tier IS DISTINCT FROM OLD.tier_snapshot THEN
      RAISE EXCEPTION 'A reroll cannot change mission cycle';
    END IF;
    NEW.tier_snapshot := v_replacement_tier;
    RETURN NEW;
  END IF;

  IF NEW.challenge_name_snapshot IS DISTINCT FROM OLD.challenge_name_snapshot
     OR NEW.challenge_description_snapshot IS DISTINCT FROM OLD.challenge_description_snapshot
     OR NEW.challenge_type_snapshot IS DISTINCT FROM OLD.challenge_type_snapshot
     OR NEW.tier_snapshot IS DISTINCT FROM OLD.tier_snapshot
     OR NEW.requirement_snapshot IS DISTINCT FROM OLD.requirement_snapshot
     OR NEW.threshold_snapshot IS DISTINCT FROM OLD.threshold_snapshot
     OR NEW.chip_reward_snapshot IS DISTINCT FROM OLD.chip_reward_snapshot
     OR NEW.diamond_reward_snapshot IS DISTINCT FROM OLD.diamond_reward_snapshot
  THEN
    RAISE EXCEPTION 'Assigned daily challenge contracts are immutable';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_snapshot_daily_challenge_contract_update
  ON public.user_daily_challenges;
CREATE TRIGGER trg_snapshot_daily_challenge_contract_update
BEFORE UPDATE OF challenge_id, challenge_name_snapshot, challenge_description_snapshot,
                 challenge_type_snapshot, tier_snapshot, requirement_snapshot,
                 threshold_snapshot, chip_reward_snapshot, diamond_reward_snapshot
ON public.user_daily_challenges
FOR EACH ROW EXECUTE FUNCTION public.fn_snapshot_daily_challenge_contract();

ALTER TABLE public.daily_challenge_progress_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.daily_challenge_progress_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.daily_challenge_progress_events TO service_role;
CREATE INDEX IF NOT EXISTS idx_daily_challenge_progress_events_created_at
  ON public.daily_challenge_progress_events (created_at);

-- Internal only. The dashboard and trusted event recorder run as the function
-- owner; browsers receive no EXECUTE grant.
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
  v_cycle integer;
  v_existing integer;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'A player is required'; END IF;
  IF (p_tier = 'daily' AND (p_count <> 5 OR p_period_key !~ '^\d{4}-\d{2}-\d{2}$'))
     OR (p_tier = 'weekly' AND (p_count <> 3 OR p_period_key !~ '^W\d{4}-\d{2}-\d{2}$'))
     OR (p_tier = 'monthly' AND (p_count <> 2 OR p_period_key !~ '^M\d{4}-\d{2}$'))
     OR p_tier NOT IN ('daily', 'weekly', 'monthly') THEN
    RAISE EXCEPTION 'Invalid canonical Daily Missions period contract';
  END IF;
  v_cycle := CASE WHEN p_tier = 'daily'
    THEN abs(p_period_key::date - date '1970-01-01') % 15 ELSE 0 END;

  SELECT count(*) INTO v_existing
  FROM public.user_daily_challenges
  WHERE user_id = p_user_id AND assigned_date = p_period_key;

  IF v_existing > p_count OR EXISTS (
    SELECT 1 FROM public.user_daily_challenges
    WHERE user_id = p_user_id AND assigned_date = p_period_key
      AND tier_snapshot IS DISTINCT FROM p_tier
  ) THEN
    RAISE EXCEPTION 'Existing % period is not a canonical Daily Missions contract set', p_tier;
  END IF;
  IF v_existing = p_count THEN RETURN; END IF;

  IF p_tier = 'daily' THEN
    INSERT INTO public.user_daily_challenges (
      user_id, challenge_id, assigned_date, progress, completed
    )
    WITH buckets(reward, ordinal) AS (
      VALUES (10, 1), (12, 2), (15, 3), (20, 4), (25, 5)
    ), candidates AS (
      SELECT b.ordinal, c.id,
             row_number() OVER (PARTITION BY b.ordinal ORDER BY c.id) - 1 AS rn,
             count(*) OVER (PARTITION BY b.ordinal) AS n
      FROM buckets b
      JOIN public.daily_challenge_catalog c
        ON c.tier = 'daily' AND c.diamond_reward = b.reward
    )
    SELECT p_user_id, candidates.id, p_period_key, 0, false
    FROM candidates
    WHERE rn = v_cycle % n
      AND NOT EXISTS (
        SELECT 1 FROM public.user_daily_challenges existing
        WHERE existing.user_id = p_user_id
          AND existing.assigned_date = p_period_key
          AND existing.challenge_id = candidates.id
      )
    ORDER BY ordinal
    LIMIT (p_count - v_existing)
    ON CONFLICT (user_id, challenge_id, assigned_date) DO NOTHING;
  ELSE
    INSERT INTO public.user_daily_challenges (
      user_id, challenge_id, assigned_date, progress, completed
    )
    WITH one_per_type AS (
      SELECT DISTINCT ON (c.challenge_type)
             c.id, c.challenge_type, md5(p_period_key || '|' || c.id) AS draw
      FROM public.daily_challenge_catalog c
      WHERE c.tier = p_tier
      ORDER BY c.challenge_type, md5(p_period_key || '|' || c.id), c.id
    )
    SELECT p_user_id, one_per_type.id, p_period_key, 0, false
    FROM one_per_type
    WHERE NOT EXISTS (
      SELECT 1 FROM public.user_daily_challenges existing
      WHERE existing.user_id = p_user_id
        AND existing.assigned_date = p_period_key
        AND existing.challenge_id = one_per_type.id
    )
    ORDER BY draw, id
    LIMIT (p_count - v_existing)
    ON CONFLICT (user_id, challenge_id, assigned_date) DO NOTHING;
  END IF;

  IF (SELECT count(*) FROM public.user_daily_challenges
      WHERE user_id = p_user_id AND assigned_date = p_period_key) <> p_count THEN
    RAISE EXCEPTION 'Catalog cannot supply the canonical % % contracts', p_count, p_tier;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_assign_current_challenge_period(uuid, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_assign_current_challenge_period(uuid, text, text, integer)
  TO service_role;

CREATE OR REPLACE FUNCTION public.assign_user_challenges(
  p_assigned_date text,
  p_challenge_ids text[]
)
RETURNS SETOF public.user_daily_challenges
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_today text := to_char((now() AT TIME ZONE 'utc')::date, 'YYYY-MM-DD');
  v_week text := 'W' || to_char(date_trunc('week', now() AT TIME ZONE 'utc')::date, 'YYYY-MM-DD');
  v_month text := 'M' || to_char(now() AT TIME ZONE 'utc', 'YYYY-MM');
  v_tier text;
  v_count integer;
BEGIN
  IF v_uid IS NULL AND public.fn_caller_is_engine() THEN v_uid := NULLIF(current_setting('app.challenge_user_id', true), '')::uuid; END IF;
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;

  IF p_assigned_date = v_today THEN v_tier := 'daily'; v_count := 5;
  ELSIF p_assigned_date = v_week THEN v_tier := 'weekly'; v_count := 3;
  ELSIF p_assigned_date = v_month THEN v_tier := 'monthly'; v_count := 2;
  ELSE RAISE EXCEPTION 'Only the current UTC Daily Missions period may be assigned';
  END IF;

  -- p_challenge_ids remains in the signature for deployed-client compatibility,
  -- but the server owns the draw and never reads caller-selected IDs.
  PERFORM public.fn_assign_current_challenge_period(v_uid, v_tier, p_assigned_date, v_count);
  RETURN QUERY SELECT * FROM public.user_daily_challenges
    WHERE user_id = v_uid AND assigned_date = p_assigned_date
    ORDER BY created_at, id;
END;
$function$;

REVOKE ALL ON FUNCTION public.assign_user_challenges(text, text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_user_challenges(text, text[]) TO service_role;

CREATE OR REPLACE FUNCTION public.record_daily_challenge_event(
  p_user_id uuid,
  p_event_key text,
  p_amounts jsonb,
  p_magnitudes jsonb DEFAULT '{}'::jsonb,
  p_occurred_at timestamptz DEFAULT now()
)
RETURNS TABLE(
  id uuid,
  challenge_id text,
  progress integer,
  requirement integer,
  chip_reward numeric,
  diamond_reward integer,
  newly_completed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inserted integer;
  v_daily_key text;
  v_weekly_key text;
  v_monthly_key text;
BEGIN
  IF p_user_id IS NULL OR p_event_key IS NULL OR length(p_event_key) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'A player and stable event key are required';
  END IF;
  IF p_amounts IS NULL OR jsonb_typeof(p_amounts) <> 'object'
     OR p_magnitudes IS NULL OR jsonb_typeof(p_magnitudes) <> 'object' THEN
    RAISE EXCEPTION 'Challenge event amounts must be JSON objects';
  END IF;
  IF p_occurred_at < now() - interval '35 days' OR p_occurred_at > now() + interval '1 minute' THEN
    RAISE EXCEPTION 'Daily Missions events must be recorded at their authoritative occurrence time';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_amounts) key
    WHERE key NOT IN ('hands_played','hands_won','showdowns','showdowns_won',
                      'hands_won_no_showdown','big_pots','strong_hands',
                      'chips_won','tournaments_played','friends_added')
  ) THEN
    RAISE EXCEPTION 'Unknown Daily Missions event type';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_each_text(p_amounts) item
    WHERE CASE WHEN item.value ~ '^\d+$' THEN
      item.value::numeric < 0
      OR (item.key = 'chips_won' AND item.value::numeric > 1000000000)
      OR (item.key <> 'chips_won' AND item.value::numeric > 2500)
    ELSE true END
  ) OR EXISTS (
    SELECT 1 FROM jsonb_each_text(p_magnitudes) item
    WHERE CASE WHEN item.value ~ '^\d+$' THEN
      item.value::numeric < 0 OR item.value::numeric > 1000000000
    ELSE true END
  ) THEN
    RAISE EXCEPTION 'Daily Missions event values are outside their server contract';
  END IF;

  v_daily_key := to_char((p_occurred_at AT TIME ZONE 'utc')::date, 'YYYY-MM-DD');
  v_weekly_key := 'W' || to_char(date_trunc('week', p_occurred_at AT TIME ZONE 'utc')::date, 'YYYY-MM-DD');
  v_monthly_key := 'M' || to_char(p_occurred_at AT TIME ZONE 'utc', 'YYYY-MM');

  INSERT INTO public.daily_challenge_progress_events (
    user_id, event_key, amounts, magnitudes, occurred_at
  ) VALUES (p_user_id, p_event_key, p_amounts, p_magnitudes, p_occurred_at)
  ON CONFLICT (user_id, event_key) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN RETURN; END IF;

  PERFORM public.fn_assign_current_challenge_period(p_user_id, 'daily', v_daily_key, 5);
  PERFORM public.fn_assign_current_challenge_period(p_user_id, 'weekly', v_weekly_key, 3);
  PERFORM public.fn_assign_current_challenge_period(p_user_id, 'monthly', v_monthly_key, 2);

  RETURN QUERY
  WITH bumps AS (
    SELECT key AS ctype,
           GREATEST(COALESCE((value #>> '{}')::integer, 0), 0) AS amount
    FROM jsonb_each(p_amounts)
  ), updated AS (
    UPDATE public.user_daily_challenges u
       SET progress = LEAST(u.progress + b.amount, u.requirement_snapshot),
           completed = (u.progress + b.amount) >= u.requirement_snapshot,
           completed_at = CASE
             WHEN (u.progress + b.amount) >= u.requirement_snapshot
                  AND u.completed_at IS NULL THEN now()
             ELSE u.completed_at
           END
      FROM bumps b
     WHERE u.user_id = p_user_id
       AND u.challenge_type_snapshot = b.ctype
       AND b.amount > 0
       AND u.completed = false
       AND u.assigned_date IN (v_daily_key, v_weekly_key, v_monthly_key)
       AND (
         u.threshold_snapshot IS NULL
         OR COALESCE((p_magnitudes -> b.ctype) #>> '{}', '0')::numeric >= u.threshold_snapshot
       )
    RETURNING u.id, u.challenge_id, u.progress, u.requirement_snapshot,
              u.chip_reward_snapshot, u.diamond_reward_snapshot, u.completed
  )
  SELECT updated.id, updated.challenge_id, updated.progress,
         updated.requirement_snapshot, updated.chip_reward_snapshot,
         updated.diamond_reward_snapshot, updated.completed
  FROM updated;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_daily_challenge_event(uuid, text, jsonb, jsonb, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_daily_challenge_event(uuid, text, jsonb, jsonb, timestamptz)
  TO service_role;

ALTER TABLE public.daily_challenge_event_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.daily_challenge_event_outbox FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.daily_challenge_event_outbox TO service_role;
CREATE INDEX IF NOT EXISTS idx_daily_challenge_event_outbox_due
  ON public.daily_challenge_event_outbox (next_attempt_at, created_at);

CREATE OR REPLACE FUNCTION public.enqueue_daily_challenge_event(
  p_user_id uuid,
  p_event_key text,
  p_amounts jsonb,
  p_magnitudes jsonb,
  p_occurred_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO public.daily_challenge_event_outbox (
    user_id, event_key, amounts, magnitudes, occurred_at
  ) VALUES (p_user_id, p_event_key, p_amounts, p_magnitudes, p_occurred_at)
  ON CONFLICT (user_id, event_key) DO NOTHING;

  BEGIN
    PERFORM public.record_daily_challenge_event(
      p_user_id, p_event_key, p_amounts, p_magnitudes, p_occurred_at
    );
    DELETE FROM public.daily_challenge_event_outbox
    WHERE user_id = p_user_id AND event_key = p_event_key;
    RETURN true;
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.daily_challenge_event_outbox
       SET attempts = attempts + 1,
           last_error = left(SQLERRM, 1000),
           next_attempt_at = now() + interval '1 minute'
     WHERE user_id = p_user_id AND event_key = p_event_key;
    RETURN false;
  END;
END;
$function$;

REVOKE ALL ON FUNCTION public.enqueue_daily_challenge_event(uuid, text, jsonb, jsonb, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_daily_challenge_event(uuid, text, jsonb, jsonb, timestamptz)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fn_drain_daily_challenge_event_outbox(p_limit integer DEFAULT 500)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record;
  v_done integer := 0;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'Invalid outbox batch size'; END IF;
  UPDATE public.daily_challenge_event_outbox
     SET dead_lettered_at = now(),
         last_error = left(COALESCE(last_error || '; ', '') ||
           'Authoritative event exceeded 35-day replay horizon', 1000)
   WHERE dead_lettered_at IS NULL
     AND occurred_at < now() - interval '35 days';
  FOR r IN
    SELECT * FROM public.daily_challenge_event_outbox
    WHERE next_attempt_at <= now() AND dead_lettered_at IS NULL
    ORDER BY created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    IF public.enqueue_daily_challenge_event(
      r.user_id, r.event_key, r.amounts, r.magnitudes, r.occurred_at
    ) THEN
      v_done := v_done + 1;
    END IF;
  END LOOP;
  RETURN v_done;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_drain_daily_challenge_event_outbox(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_drain_daily_challenge_event_outbox(integer) TO service_role;

CREATE OR REPLACE VIEW public.v_daily_challenge_event_outbox_health
WITH (security_invoker = true) AS
SELECT
  count(*) FILTER (WHERE dead_lettered_at IS NULL) AS pending_count,
  min(created_at) FILTER (WHERE dead_lettered_at IS NULL) AS oldest_pending_at,
  count(*) FILTER (WHERE attempts >= 5 AND dead_lettered_at IS NULL) AS high_attempt_count,
  count(*) FILTER (WHERE dead_lettered_at IS NOT NULL) AS dead_letter_count
FROM public.daily_challenge_event_outbox;
REVOKE ALL ON public.v_daily_challenge_event_outbox_health FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_daily_challenge_event_outbox_health TO service_role;

CREATE OR REPLACE FUNCTION public.fn_enqueue_hand_daily_missions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE event jsonb;
BEGIN
  IF jsonb_typeof(NEW.daily_mission_events) <> 'array' THEN RETURN NEW; END IF;
  FOR event IN SELECT value FROM jsonb_array_elements(NEW.daily_mission_events)
  LOOP
    BEGIN
      PERFORM public.enqueue_daily_challenge_event(
        (event->>'user_id')::uuid,
        'hand:' || NEW.id::text,
        event->'amounts',
        COALESCE(event->'magnitudes', '{}'::jsonb),
        COALESCE(NEW.ended_at, NEW.created_at, now())
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Daily Missions hand event % could not be queued: %', NEW.id, SQLERRM;
    END;
  END LOOP;
  RETURN NEW;
END;
$function$;

-- Legacy raw writers remain temporarily for deployed-server compatibility, but
-- browsers can no longer execute either one. Both now use immutable snapshots.
CREATE OR REPLACE FUNCTION public.increment_challenge_progress(
  p_user_id uuid,
  p_challenge_row_id uuid,
  p_amount integer,
  p_requirement integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_progress integer;
  v_completed boolean;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RETURN jsonb_build_object('updated', false, 'error', 'server event required');
  END IF;
  UPDATE public.user_daily_challenges
     SET progress = LEAST(progress + GREATEST(COALESCE(p_amount, 0), 0), requirement_snapshot),
         completed = progress + GREATEST(COALESCE(p_amount, 0), 0) >= requirement_snapshot,
         completed_at = CASE
           WHEN progress + GREATEST(COALESCE(p_amount, 0), 0) >= requirement_snapshot
                AND completed_at IS NULL THEN now()
           ELSE completed_at
         END
   WHERE id = p_challenge_row_id AND user_id = p_user_id AND completed = false
   RETURNING progress, completed INTO v_progress, v_completed;
  IF NOT FOUND THEN RETURN jsonb_build_object('updated', false); END IF;
  RETURN jsonb_build_object('updated', true, 'progress', v_progress, 'completed', v_completed);
END;
$function$;

REVOKE ALL ON FUNCTION public.increment_challenge_progress(uuid, uuid, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.bump_challenge_progress(
  p_user_id uuid,
  p_amounts jsonb,
  p_magnitudes jsonb,
  p_daily_key text,
  p_weekly_key text,
  p_monthly_key text
)
RETURNS TABLE(id uuid, challenge_id text, progress integer, requirement integer,
              chip_reward numeric, newly_completed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'Daily Missions progress requires a trusted server event'
      USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT event.id, event.challenge_id, event.progress, event.requirement,
         event.chip_reward, event.newly_completed
  FROM public.record_daily_challenge_event(
    p_user_id,
    'legacy:' || gen_random_uuid()::text,
    p_amounts,
    COALESCE(p_magnitudes, '{}'::jsonb),
    now()
  ) event;
END;
$function$;

REVOKE ALL ON FUNCTION public.bump_challenge_progress(uuid, jsonb, jsonb, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- A request can only be created as pending by its sender. Acceptance is a
-- recipient-only RPC, so a sender cannot forge fn_are_friends() authorization.
DO $drop_friendship_insert_policies$
DECLARE r record;
BEGIN
  FOR r IN SELECT policyname FROM pg_policies
           WHERE schemaname = 'public' AND tablename = 'friendships'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.friendships', r.policyname);
  END LOOP;
END;
$drop_friendship_insert_policies$;

DROP POLICY IF EXISTS friendships_select_participant ON public.friendships;
CREATE POLICY friendships_select_participant
  ON public.friendships FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) IN (user_id, friend_id));

DROP POLICY IF EXISTS friendships_delete_participant ON public.friendships;
CREATE POLICY friendships_delete_participant
  ON public.friendships FOR DELETE TO authenticated
  USING ((SELECT auth.uid()) IN (user_id, friend_id));

CREATE POLICY friendships_insert_pending_self
  ON public.friendships FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT auth.uid()) = user_id
    AND friend_id <> user_id
    AND status = 'pending'
  );

REVOKE ALL ON TABLE public.friendships FROM anon;
REVOKE UPDATE ON TABLE public.friendships FROM authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.friendships TO authenticated;

CREATE OR REPLACE FUNCTION public.get_mutual_friends(p_other_user_id uuid)
RETURNS TABLE(id uuid, username text, avatar_url text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH mine AS (
    SELECT CASE WHEN user_id = auth.uid() THEN friend_id ELSE user_id END AS friend_id
    FROM public.friendships
    WHERE status = 'accepted' AND auth.uid() IN (user_id, friend_id)
  ), theirs AS (
    SELECT CASE WHEN user_id = p_other_user_id THEN friend_id ELSE user_id END AS friend_id
    FROM public.friendships
    WHERE status = 'accepted' AND p_other_user_id IN (user_id, friend_id)
  )
  SELECT p.id, p.username, p.avatar_url
  FROM mine JOIN theirs USING (friend_id)
  JOIN public.profiles p ON p.id = mine.friend_id
  WHERE auth.uid() IS NOT NULL AND p_other_user_id IS NOT NULL
  ORDER BY p.username, p.id
  LIMIT 100
$function$;

REVOKE ALL ON FUNCTION public.get_mutual_friends(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_mutual_friends(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.accept_friendship(p_friendship_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.friendships%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  SELECT * INTO v_row FROM public.friendships
   WHERE id = p_friendship_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Friend request not found'); END IF;
  IF v_row.friend_id <> v_uid THEN
    RAISE EXCEPTION 'Only the recipient can accept this friend request' USING ERRCODE = '42501';
  END IF;
  IF v_row.status = 'accepted' THEN
    RETURN jsonb_build_object('success', true, 'alreadyAccepted', true);
  END IF;
  IF v_row.status <> 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Friend request is no longer pending');
  END IF;
  UPDATE public.friendships SET status = 'accepted' WHERE id = p_friendship_id;
  RETURN jsonb_build_object('success', true, 'alreadyAccepted', false);
END;
$function$;

REVOKE ALL ON FUNCTION public.accept_friendship(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_friendship(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_daily_missions_friend_accepted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.status = 'accepted'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'accepted') THEN
    BEGIN
      PERFORM public.enqueue_daily_challenge_event(
        NEW.user_id, 'friendship:' || NEW.id::text, '{"friends_added":1}'::jsonb, '{}'::jsonb, now()
      );
      PERFORM public.enqueue_daily_challenge_event(
        NEW.friend_id, 'friendship:' || NEW.id::text, '{"friends_added":1}'::jsonb, '{}'::jsonb, now()
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Daily Missions friendship event % could not be queued: %', NEW.id, SQLERRM;
    END;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_daily_missions_tournament_registered()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.status NOT IN ('playing', 'eliminated', 'finished', 'winner')
     OR (TG_OP = 'UPDATE' AND OLD.status IN ('playing', 'eliminated', 'finished', 'winner')) THEN
    RETURN NEW;
  END IF;
  BEGIN
    PERFORM public.enqueue_daily_challenge_event(
      NEW.user_id,
      'tournament:' || NEW.tournament_id::text,
      '{"tournaments_played":1}'::jsonb,
      '{}'::jsonb,
      now()
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Daily Missions tournament event % could not be queued: %',
      NEW.tournament_id, SQLERRM;
  END;
  RETURN NEW;
END;
$function$;

ALTER TABLE public.daily_challenge_milestone_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.daily_challenge_milestone_claims FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.daily_challenge_milestone_claims TO service_role;

CREATE OR REPLACE FUNCTION public.fn_award_daily_mission_milestones(p_user_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_streak integer := COALESCE((public.get_challenge_streak(p_user_id)->>'streak')::integer, 0);
  v_started date;
  v_reward numeric := 0;
  v_max integer;
  v_max_reward numeric;
  v_reference text;
BEGIN
  IF v_streak <= 0 THEN RETURN 0; END IF;
  v_started := (now() AT TIME ZONE 'utc')::date - (v_streak - 1);
  SELECT max(days) INTO v_max FROM public.daily_challenge_milestones;
  SELECT reward_chips INTO v_max_reward FROM public.daily_challenge_milestones WHERE days = v_max;

  WITH due AS (
    SELECT days, reward_chips FROM public.daily_challenge_milestones WHERE days <= v_streak
    UNION ALL
    SELECT day, v_max_reward
    FROM generate_series(
      v_max + 30,
      v_max + ((v_streak - v_max) / 30) * 30,
      30
    ) day
  ), inserted AS (
    INSERT INTO public.daily_challenge_milestone_claims (
      user_id, streak_started_on, milestone_days, reward_chips
    )
    SELECT p_user_id, v_started, days, reward_chips FROM due
    ON CONFLICT DO NOTHING
    RETURNING reward_chips, milestone_days
  )
  SELECT COALESCE(sum(reward_chips), 0),
         'daily_mission_milestones:' || p_user_id::text || ':' || v_started::text || ':' || max(milestone_days)
    INTO v_reward, v_reference
  FROM inserted;

  IF v_reward > 0 AND NOT public.atomic_credit_wallet_and_log(
    p_user_id, v_reward, 'bonus', 'Daily Missions streak milestone',
    NULL, NULL, NULL, v_reference
  ) THEN
    RAISE EXCEPTION 'Daily Missions streak milestone could not be credited';
  END IF;
  RETURN v_reward;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_award_daily_mission_milestones(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_award_daily_mission_milestones(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_daily_missions_claimed_milestone()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.claimed AND NOT OLD.claimed AND NEW.tier_snapshot = 'daily' THEN
    PERFORM public.fn_award_daily_mission_milestones(NEW.user_id);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_daily_missions_claimed_milestone ON public.user_daily_challenges;
CREATE TRIGGER trg_daily_missions_claimed_milestone
AFTER UPDATE OF claimed ON public.user_daily_challenges
FOR EACH ROW EXECUTE FUNCTION public.fn_daily_missions_claimed_milestone();

CREATE OR REPLACE FUNCTION public.fn_prune_daily_mission_operations(p_keep_days integer DEFAULT 30)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_total bigint := 0;
  v_rows bigint;
BEGIN
  IF p_keep_days < 7 OR p_keep_days > 180 THEN
    RAISE EXCEPTION 'p_keep_days must be between 7 and 180';
  END IF;
  DELETE FROM public.daily_mission_operations
   WHERE created_at < now() - make_interval(days => p_keep_days);
  GET DIAGNOSTICS v_rows = ROW_COUNT; v_total := v_total + v_rows;
  -- Receipts outlive the 35-day accepted event horizon, so a delayed replay
  -- can never become payable again after its immutable dedupe row is pruned.
  DELETE FROM public.daily_challenge_progress_events
   WHERE created_at < now() - make_interval(days => GREATEST(p_keep_days, 45));
  GET DIAGNOSTICS v_rows = ROW_COUNT; v_total := v_total + v_rows;
  DELETE FROM public.daily_challenge_claim_batches
   WHERE created_at < now() - make_interval(days => p_keep_days);
  GET DIAGNOSTICS v_rows = ROW_COUNT; v_total := v_total + v_rows;
  DELETE FROM public.daily_challenge_event_outbox
   WHERE dead_lettered_at < now() - interval '180 days';
  GET DIAGNOSTICS v_rows = ROW_COUNT; v_total := v_total + v_rows;
  RETURN v_total;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_prune_daily_mission_operations(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_prune_daily_mission_operations(integer) TO service_role;

DROP POLICY IF EXISTS daily_mission_operations_insert_own ON public.daily_mission_operations;
REVOKE INSERT ON public.daily_mission_operations FROM authenticated;
REVOKE USAGE, SELECT ON SEQUENCE public.daily_mission_operations_id_seq FROM authenticated;

CREATE OR REPLACE FUNCTION public.record_daily_mission_operation(
  p_event text,
  p_tier text DEFAULT NULL,
  p_duration_ms integer DEFAULT NULL,
  p_item_count integer DEFAULT NULL,
  p_reason_code text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_weight smallint;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  IF p_event NOT IN (
    'dashboard_loaded','dashboard_failed','claim_succeeded','claim_failed',
    'claim_all_succeeded','claim_all_failed','reroll_succeeded','reroll_failed',
    'freeze_succeeded','freeze_failed','realtime_degraded','realtime_recovered',
    'alerts_enabled','alerts_disabled','alerts_failed','mission_cta_opened'
  ) OR (p_tier IS NOT NULL AND p_tier NOT IN ('daily','weekly','monthly'))
     OR (p_reason_code IS NOT NULL AND p_reason_code !~ '^[a-z0-9:_-]{1,64}$') THEN
    RAISE EXCEPTION 'Invalid Daily Missions telemetry contract';
  END IF;
  IF (SELECT count(*) FROM public.daily_mission_operations
      WHERE user_id = v_uid AND created_at >= now() - interval '1 minute') >= 60 THEN
    RETURN false;
  END IF;
  v_weight := CASE WHEN p_event IN ('dashboard_loaded','mission_cta_opened') THEN 5 ELSE 1 END;
  INSERT INTO public.daily_mission_operations (
    user_id, event, tier, duration_ms, item_count, reason_code, sample_weight
  ) VALUES (
    v_uid, p_event, p_tier,
    CASE WHEN p_duration_ms IS NULL THEN NULL ELSE LEAST(GREATEST(p_duration_ms, 0), 300000) END,
    CASE WHEN p_item_count IS NULL THEN NULL ELSE LEAST(GREATEST(p_item_count, 0), 10000) END,
    p_reason_code, v_weight
  );
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.record_daily_mission_operation(text,text,integer,integer,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_daily_mission_operation(text,text,integer,integer,text)
  TO authenticated, service_role;

DO $schedule_prune$
DECLARE v_jobid bigint;
BEGIN
  IF to_regnamespace('cron') IS NULL THEN RETURN; END IF;
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'daily-missions-retention-daily';
  IF v_jobid IS NOT NULL THEN PERFORM cron.unschedule(v_jobid); END IF;
  PERFORM cron.schedule(
    'daily-missions-retention-daily',
    '23 5 * * *',
    $cron$SELECT public.fn_prune_daily_mission_operations(30);$cron$
  );
END;
$schedule_prune$;

DO $schedule_outbox$
DECLARE v_jobid bigint;
BEGIN
  IF to_regnamespace('cron') IS NULL THEN RETURN; END IF;
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'daily-missions-outbox-minute';
  IF v_jobid IS NOT NULL THEN PERFORM cron.unschedule(v_jobid); END IF;
  PERFORM cron.schedule(
    'daily-missions-outbox-minute',
    '* * * * *',
    $cron$SELECT public.fn_drain_daily_challenge_event_outbox(500);$cron$
  );
END;
$schedule_outbox$;

DO $verify_daily_missions_authority$
BEGIN
  IF has_function_privilege('authenticated',
       'public.bump_challenge_progress(uuid,jsonb,jsonb,text,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.increment_challenge_progress(uuid,uuid,integer,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.assign_user_challenges(text,text[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'Authenticated still holds a raw Daily Missions writer';
  END IF;
  IF to_regclass('public.daily_challenge_progress_events') IS NULL
     OR to_regclass('public.daily_challenge_milestone_claims') IS NULL
     OR to_regclass('public.daily_challenge_event_outbox') IS NULL THEN
    RAISE EXCEPTION 'Daily Missions authority ledgers were not created';
  END IF;
  IF has_table_privilege('anon', 'public.friendships', 'SELECT') THEN
    RAISE EXCEPTION 'Anonymous users can still read friendship edges';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'friendships'
      AND cmd IN ('INSERT', 'ALL')
      AND policyname <> 'friendships_insert_pending_self'
  ) THEN
    RAISE EXCEPTION 'A broad friendship insert policy still bypasses pending-only requests';
  END IF;
END;
$verify_daily_missions_authority$;
