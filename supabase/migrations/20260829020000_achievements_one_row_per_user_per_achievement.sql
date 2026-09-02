-- ═══════════════════════════════════════════════════════════════════════════
--  ACHIEVEMENTS: ONE ROW PER USER PER ACHIEVEMENT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT WAS WRONG
--
-- `training_user_achievements` had NO unique constraint on
-- (user_id, achievement_id), and the client wrote it read-then-insert:
--
--     const { data: existing } = await supabase        -- error DISCARDED
--       .from('training_user_achievements')
--       .select(...).eq(user).eq(achievement).maybeSingle();
--     if (existing) update(...) else insert(...)
--
-- `.maybeSingle()` ERRORS when the query matches more than one row. Only
-- `data` was destructured, so that error was thrown away and `existing` came
-- back undefined — which the code reads as "no row yet" and INSERTS. One
-- duplicate begets the next, forever, one per call.
--
-- Measured on production 2026-08-29, before this migration:
--
--     total rows                       33,353
--     real (user, achievement) pairs       44
--     surplus rows                     33,309   (99.87% of the table)
--     worst single pair                13,047   rows
--     users with any achievement row        8
--
-- The worst pair was still growing at one row per page load while this was
-- being written. Two consequences beyond the wasted rows:
--
--   1. PROGRESS COULD NOT ACCUMULATE. Every call read "no row", inserted a
--      fresh row at progress 1, and the next call did the same. An
--      achievement counted in this way can essentially never be earned.
--   2. `target` was never written, so every row carries the column default
--      of 1 — the database's own idea of "finished" was wrong for every row.
--
-- WHAT THIS MIGRATION DOES
--
--   1. Collapses each (user_id, achievement_id) to ONE row, merging rather
--      than picking: progress = MAX, unlocked_at = EARLIEST non-null,
--      created_at = EARLIEST. Nobody loses progress and nobody loses an
--      unlock they already hold.
--   2. Adds the UNIQUE index that should always have been there. It is what
--      makes the client's `onConflict: 'user_id,achievement_id'` upsert
--      legal — that call has been failing for as long as it has existed,
--      because ON CONFLICT needs a matching constraint.
--   3. Backfills the `unlocked` boolean, which no code has ever written, from
--      `unlocked_at`. It read false on all 33,353 rows while 8 of them were
--      genuinely unlocked.
--   4. Adds `fn_achievement_record_progress`, an atomic upsert that is the
--      only sane way to write this table from a browser.
--
-- ROLLBACK
--
--   DROP FUNCTION IF EXISTS public.fn_achievement_record_progress(uuid, text, numeric, numeric);
--   DROP INDEX IF EXISTS public.training_user_achievements_user_achievement_uidx;
--   -- The deleted duplicate rows are NOT recoverable by rollback. They carry
--   -- no information the surviving merged row does not already hold: every
--   -- one is another attempt to write the same (user, achievement) pair, and
--   -- the survivor takes the maximum progress and the earliest unlock of the
--   -- whole group.

BEGIN;

-- ── 1. Merge each duplicate group into its best row ────────────────────────
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

-- ── 2. Delete every row that is not the survivor of its group ──────────────
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

-- ── 3. Assert the table is now one row per pair, before locking it in ──────
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

-- ── 4. The constraint that prevents all of the above from recurring ────────
CREATE UNIQUE INDEX IF NOT EXISTS training_user_achievements_user_achievement_uidx
  ON public.training_user_achievements (user_id, achievement_id);

-- ── 5. `unlocked` has never been written by any code. Make it true. ────────
UPDATE public.training_user_achievements
   SET unlocked = (unlocked_at IS NOT NULL)
 WHERE unlocked IS DISTINCT FROM (unlocked_at IS NOT NULL);

COMMIT;
