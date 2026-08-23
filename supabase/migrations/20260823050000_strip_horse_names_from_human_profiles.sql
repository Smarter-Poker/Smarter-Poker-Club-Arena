-- ═══════════════════════════════════════════════════════════════════════════
-- A HORSE'S NAME MUST NEVER SIT ON A PERSON'S PROFILE
--
-- Dan 2026-08-23: "FIX IT, MARCUS CHEN IS A HORSE. IM DAN BEKAVAC ON SOCIAL
-- AND KINGFISH IN THE CLUB ARENA. NOTHING ELSE."
--
-- "Marcus Chen" is a row in ai_horses. It was also sitting in the display_name
-- of a real, email-verified human account, so every surface that reached for
-- display_name greeted that person as one of the AI players.
--
-- SCOPE, MEASURED BEFORE WRITING ANYTHING:
--   74 profiles carried an ai_horses name in display_name
--   73 of them ARE horses (is_horse = true) - correct, left alone
--    1 was a human - the whole contamination, and the bug being fixed
--
-- The fix NULLs the borrowed name rather than inventing a replacement. The
-- application resolves a name from alias / username / full_name by context
-- (src/utils/playerDisplayName.ts); display_name is the one column with no
-- clear owner, and an empty one lets that resolver do its job.
--
-- APPLIED TO PRODUCTION 2026-08-23 via Supabase apply_migration. This file is
-- the auditable copy required by CLAUDE.md RULE 2.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE n_horses int;
BEGIN
  SELECT count(*) INTO n_horses FROM public.ai_horses WHERE name IS NOT NULL;
  IF n_horses = 0 THEN
    RAISE EXCEPTION 'ai_horses has no named rows; refusing to run a no-op cleanup';
  END IF;
END $$;

UPDATE public.profiles p
   SET display_name = NULL
 WHERE COALESCE(p.is_horse, false) = false
   AND p.display_name IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM public.ai_horses h
      WHERE trim(h.name) ILIKE trim(p.display_name)
   );

DO $$
DECLARE leaked int;
BEGIN
  SELECT count(*) INTO leaked
    FROM public.profiles p
    JOIN public.ai_horses h ON trim(h.name) ILIKE trim(p.display_name)
   WHERE COALESCE(p.is_horse, false) = false AND p.display_name IS NOT NULL;
  IF leaked > 0 THEN
    RAISE EXCEPTION 'still % human profile(s) carrying a horse name', leaked;
  END IF;
END $$;

-- ── The guard ────────────────────────────────────────────────────────────
-- Cleaning the row is not enough: whatever wrote it can write it again.
CREATE OR REPLACE FUNCTION public.fn_reject_horse_name_on_human()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(NEW.is_horse, false) = false
     AND NEW.display_name IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.ai_horses h
        WHERE trim(h.name) ILIKE trim(NEW.display_name)
     )
  THEN
    -- Drop the borrowed name instead of failing the whole write: this fires on
    -- ordinary profile saves, and a hard error would block a player editing
    -- something unrelated. The name is the only thing rejected.
    NEW.display_name := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_reject_horse_name_on_human ON public.profiles;
CREATE TRIGGER trg_reject_horse_name_on_human
  BEFORE INSERT OR UPDATE OF display_name, is_horse ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.fn_reject_horse_name_on_human();

COMMIT;

-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_reject_horse_name_on_human ON public.profiles;
--   DROP FUNCTION IF EXISTS public.fn_reject_horse_name_on_human();
