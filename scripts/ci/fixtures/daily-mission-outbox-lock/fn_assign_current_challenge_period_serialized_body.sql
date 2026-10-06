CREATE OR REPLACE FUNCTION public.fn_assign_current_challenge_period_serialized_body(p_user_id uuid, p_tier text, p_period_key text, p_count integer)
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
$function$
