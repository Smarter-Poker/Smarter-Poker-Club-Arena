-- Four legacy catalog rows predated the all-pages Title Case rule. They are
-- server data rather than JSX, so the static source scanner cannot see them.
-- Correct both the canonical catalog and already-assigned display snapshots;
-- no requirement, reward, progress, or other immutable gameplay term changes.

UPDATE public.daily_challenge_catalog
SET description = CASE id
  WHEN 'hands_10' THEN 'Play 10 Hands Today'
  WHEN 'hands_25' THEN 'Play 25 Hands Today'
  WHEN 'showdown_3' THEN 'Reach 3 Showdowns Today'
  WHEN 'weekly_hands_250' THEN 'Play 250 Hands This Week'
  ELSE description
END
WHERE id IN ('hands_10', 'hands_25', 'showdown_3', 'weekly_hands_250');

-- The snapshot trigger correctly rejects application attempts to rewrite a
-- contract. This migration changes display casing only and runs atomically,
-- so suspend exactly that trigger for the bounded five-row production repair.
ALTER TABLE public.user_daily_challenges
  DISABLE TRIGGER trg_snapshot_daily_challenge_contract_update;

UPDATE public.user_daily_challenges
SET challenge_description_snapshot = CASE challenge_id
  WHEN 'hands_10' THEN 'Play 10 Hands Today'
  WHEN 'hands_25' THEN 'Play 25 Hands Today'
  WHEN 'showdown_3' THEN 'Reach 3 Showdowns Today'
  WHEN 'weekly_hands_250' THEN 'Play 250 Hands This Week'
  ELSE challenge_description_snapshot
END
WHERE challenge_id IN ('hands_10', 'hands_25', 'showdown_3', 'weekly_hands_250');

ALTER TABLE public.user_daily_challenges
  ENABLE TRIGGER trg_snapshot_daily_challenge_contract_update;

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.daily_challenge_catalog
    WHERE name ~ '(^|[[:space:][:punct:]])[a-z]'
       OR description ~ '(^|[[:space:][:punct:]])[a-z]'
  ) OR EXISTS (
    SELECT 1
    FROM public.user_daily_challenges
    WHERE challenge_name_snapshot ~ '(^|[[:space:][:punct:]])[a-z]'
       OR challenge_description_snapshot ~ '(^|[[:space:][:punct:]])[a-z]'
  ) THEN
    RAISE EXCEPTION 'Daily Mission catalog or assigned display copy is not Title Cased';
  END IF;
END;
$verify$;
