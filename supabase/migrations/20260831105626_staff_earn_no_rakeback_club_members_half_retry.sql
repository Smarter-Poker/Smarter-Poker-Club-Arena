-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831105626; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Part A2 of 20260831235997, retry. club_members is a hot, realtime-published
-- table; the first two attempts deadlocked against realtime.subscription and
-- the third timed out waiting. One table, one lock, longer patience.
BEGIN;
SET LOCAL lock_timeout = '25s';

CREATE OR REPLACE FUNCTION public.fn_club_members_staff_earn_no_rakeback()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $$
BEGIN
  -- Dan 2026-08-31: "CO-OWNERS AND ADMINS GET NO RAKE BACK."
  -- player_rakeback_pct is the first branch of fn_player_rakeback_rate, so a
  -- non-zero value here is money. owner is deliberately not covered.
  NEW.player_rakeback_pct := 0;
  NEW.rakeback_rate       := 0;
  NEW.commission_rate     := 0;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_club_members_staff_earn_no_rakeback ON public.club_members;
CREATE TRIGGER trg_club_members_staff_earn_no_rakeback
  BEFORE INSERT OR UPDATE ON public.club_members
  FOR EACH ROW
  WHEN (NEW.role IN ('co_owner', 'admin')
        AND (COALESCE(NEW.player_rakeback_pct, 0) <> 0
          OR COALESCE(NEW.rakeback_rate, 0)       <> 0
          OR COALESCE(NEW.commission_rate, 0)     <> 0))
  EXECUTE FUNCTION public.fn_club_members_staff_earn_no_rakeback();

UPDATE public.club_members
   SET player_rakeback_pct = 0, rakeback_rate = 0, commission_rate = 0
 WHERE role IN ('co_owner', 'admin')
   AND (COALESCE(player_rakeback_pct, 0) <> 0
     OR COALESCE(rakeback_rate, 0)       <> 0
     OR COALESCE(commission_rate, 0)     <> 0);

DO $verify$
DECLARE v_n int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'club_members' AND t.tgname = 'trg_club_members_role_guard') THEN
    RAISE EXCEPTION 'the pre-existing role guard trigger has gone missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'club_members' AND t.tgname = 'trg_club_members_staff_earn_no_rakeback') THEN
    RAISE EXCEPTION 'trg_club_members_staff_earn_no_rakeback was not created';
  END IF;
  SELECT count(*) INTO v_n FROM club_members
   WHERE role IN ('co_owner','admin')
     AND (COALESCE(player_rakeback_pct,0) <> 0 OR COALESCE(rakeback_rate,0) <> 0
          OR COALESCE(commission_rate,0) <> 0);
  IF v_n > 0 THEN RAISE EXCEPTION '% staff member(s) still carry a rakeback rate', v_n; END IF;
END
$verify$;

COMMIT;
