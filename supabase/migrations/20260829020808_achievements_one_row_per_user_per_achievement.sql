-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829020808; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

WITH ranked AS (
  SELECT id, user_id, achievement_id,
         row_number() OVER (
           PARTITION BY user_id, achievement_id
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM public.training_user_achievements
),
merged AS (
  SELECT user_id, achievement_id,
         max(progress)     AS progress,
         max(target)       AS target,
         min(unlocked_at)  AS unlocked_at,
         min(created_at)   AS created_at
  FROM public.training_user_achievements
  GROUP BY user_id, achievement_id
)
UPDATE public.training_user_achievements t
   SET progress    = m.progress,
       target      = GREATEST(COALESCE(t.target, 1), COALESCE(m.target, 1)),
       unlocked_at = m.unlocked_at,
       unlocked    = (m.unlocked_at IS NOT NULL),
       created_at  = m.created_at
  FROM ranked r
  JOIN merged m
    ON m.user_id = r.user_id AND m.achievement_id = r.achievement_id
 WHERE t.id = r.id AND r.rn = 1;

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY user_id, achievement_id
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM public.training_user_achievements
)
DELETE FROM public.training_user_achievements t
 USING ranked r
 WHERE t.id = r.id AND r.rn > 1;

DO $$
DECLARE dupes bigint;
BEGIN
  SELECT count(*) INTO dupes FROM (
    SELECT 1 FROM public.training_user_achievements
     GROUP BY user_id, achievement_id HAVING count(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION 'dedupe left % duplicate (user_id, achievement_id) group(s); refusing to add the unique index', dupes;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS training_user_achievements_user_achievement_uidx
  ON public.training_user_achievements (user_id, achievement_id);

UPDATE public.training_user_achievements
   SET unlocked = (unlocked_at IS NOT NULL)
 WHERE unlocked IS DISTINCT FROM (unlocked_at IS NOT NULL);
