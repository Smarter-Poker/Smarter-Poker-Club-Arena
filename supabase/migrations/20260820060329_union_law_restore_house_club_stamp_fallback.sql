-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820060329 "union_law_restore_house_club_stamp_fallback"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 bdb47f961fc5b67d16173f11ad570632 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- UNION LAW — RESTORE HOUSE-CLUB STAMP FALLBACK (2026-08-20)
--
-- REGRESSION FOUND IN PASS 2: the ownership triggers were rewritten and lost
-- the clubs.union_id fallback. They now resolve the union ONLY via union_clubs
-- — which by design does NOT contain the union's own house club (Midway). So a
-- game created directly under the house club (the normal case now that all
-- union games live there) received union_id = NULL.
--
-- Impact: such a game is invisible in every club lobby, because both the club
-- lobby and TableService select union games by union_id. The engine masked
-- this because horse-launch now passes union_id explicitly, but any game
-- created without an explicit stamp (e.g. by the union owner in the UI) came
-- out invisible. Reproduced directly: INSERT under the house club -> union_id
-- NULL.
--
-- Fix: restore the fallback, keeping the newer improvement that repoints
-- club_id at the union container. Also add a self-test invariant so this exact
-- regression can never return silently.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_stamp_table_union_ownership()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_union uuid;
BEGIN
  IF COALESCE(NEW.is_private, false) THEN
    NEW.union_id := NULL;               -- private games are never union-visible
    RETURN NEW;
  END IF;

  IF NEW.union_id IS NULL AND NEW.club_id IS NOT NULL THEN
    SELECT uc.union_id INTO v_union FROM union_clubs uc WHERE uc.club_id = NEW.club_id LIMIT 1;
    IF v_union IS NULL THEN
      -- The union's OWN house club is not a union_clubs member; it carries the
      -- union on its clubs row. Without this, house-club games are unstamped
      -- and therefore invisible in every club lobby.
      SELECT c.union_id INTO v_union FROM clubs c WHERE c.id = NEW.club_id;
    END IF;
    IF v_union IS NOT NULL THEN NEW.union_id := v_union; END IF;
  END IF;

  -- A union game belongs to the UNION, not to whichever member club happened to
  -- create it. Point club_id at the union's own container row so every surface
  -- agrees on who runs the game.
  IF NEW.union_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM clubs c WHERE c.id = NEW.union_id) THEN
    NEW.club_id := NEW.union_id;
  END IF;

  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_stamp_tournament_union_ownership()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_union uuid;
BEGIN
  IF COALESCE(NEW.is_private, false) THEN
    NEW.union_id := NULL;
    RETURN NEW;
  END IF;

  IF NEW.union_id IS NULL AND NEW.club_id IS NOT NULL THEN
    SELECT uc.union_id INTO v_union FROM union_clubs uc WHERE uc.club_id = NEW.club_id LIMIT 1;
    IF v_union IS NULL THEN
      SELECT c.union_id INTO v_union FROM clubs c WHERE c.id = NEW.club_id;
    END IF;
    IF v_union IS NOT NULL THEN NEW.union_id := v_union; END IF;
  END IF;

  IF NEW.union_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM clubs c WHERE c.id = NEW.union_id) THEN
    NEW.club_id := NEW.union_id;
  END IF;

  RETURN NEW;
END $function$;

-- Heal anything already created unstamped under a union house club -----------
UPDATE public.tables t
   SET union_id = c.union_id
  FROM public.clubs c
 WHERE c.id = t.club_id
   AND COALESCE(c.is_union, false)
   AND c.union_id IS NOT NULL
   AND t.union_id IS NULL
   AND COALESCE(t.is_private, false) = false;

UPDATE public.tournaments tr
   SET union_id = c.union_id
  FROM public.clubs c
 WHERE c.id = tr.club_id
   AND COALESCE(c.is_union, false)
   AND c.union_id IS NOT NULL
   AND tr.union_id IS NULL
   AND COALESCE(tr.is_private, false) = false;

-- Invariant so the regression cannot return unnoticed ------------------------
CREATE OR REPLACE FUNCTION public.fn_union_house_club_stamp_check()
 RETURNS bigint
 LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT count(*)
    FROM (
      SELECT t.id FROM tables t JOIN clubs c ON c.id = t.club_id
       WHERE COALESCE(c.is_union,false) AND c.union_id IS NOT NULL
         AND t.union_id IS NULL AND COALESCE(t.is_private,false) = false
         AND COALESCE(t.is_deleted,false) = false
         AND t.status NOT IN ('closed','deleted')
      UNION ALL
      SELECT tr.id FROM tournaments tr JOIN clubs c ON c.id = tr.club_id
       WHERE COALESCE(c.is_union,false) AND c.union_id IS NOT NULL
         AND tr.union_id IS NULL AND COALESCE(tr.is_private,false) = false
         AND tr.status IN ('ANNOUNCED','SCHEDULED','REGISTERING','LATE_REG','RUNNING')
    ) x;
$function$;

