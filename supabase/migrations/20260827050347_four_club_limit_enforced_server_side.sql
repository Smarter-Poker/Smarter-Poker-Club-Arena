-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827050347; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- FOUR-CLUB LIMIT, ENFORCED WHERE IT CANNOT BE SKIPPED (2026-08-27)
-- See supabase/migrations/20260827_four_club_limit_enforced_server_side.sql
-- in the club-arena repo for the full rationale. Horses exempt (fleet seats
-- them everywhere); only transitions INTO active/approved are gated.

CREATE OR REPLACE FUNCTION public.fn_enforce_four_club_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_count int;
BEGIN
  IF NEW.status NOT IN ('active', 'approved') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status IN ('active', 'approved') THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM profiles WHERE id = NEW.user_id AND COALESCE(is_horse, false)
  ) THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_count
    FROM club_members
   WHERE user_id = NEW.user_id
     AND status IN ('active', 'approved')
     AND club_id <> NEW.club_id;

  IF v_count >= 4 THEN
    RAISE EXCEPTION
      'You can only be a member of up to 4 clubs. Leave a club to join a new one.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_four_club_limit_ins ON public.club_members;
CREATE TRIGGER trg_four_club_limit_ins
  BEFORE INSERT ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_four_club_limit();

DROP TRIGGER IF EXISTS trg_four_club_limit_upd ON public.club_members;
CREATE TRIGGER trg_four_club_limit_upd
  BEFORE UPDATE OF status ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_four_club_limit();

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relname = 'club_members'
         AND t.tgname IN ('trg_four_club_limit_ins', 'trg_four_club_limit_upd')) <> 2 THEN
    RAISE EXCEPTION 'four-club-limit triggers did not install';
  END IF;

  IF EXISTS (
    SELECT cm.user_id
      FROM club_members cm
      LEFT JOIN profiles p ON p.id = cm.user_id
     WHERE cm.status IN ('active', 'approved')
       AND NOT COALESCE(p.is_horse, false)
     GROUP BY cm.user_id
    HAVING count(*) > 4
  ) THEN
    RAISE EXCEPTION 'a non-horse user already exceeds 4 memberships - investigate before enforcing';
  END IF;
END;
$$;
