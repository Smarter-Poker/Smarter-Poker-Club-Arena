-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831105543; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Part A1 of 20260831235997. Split per table: club_members is published to
-- realtime, and DDL on it deadlocked twice against realtime.subscription, so
-- each table now gets its own transaction and never holds two table locks.
BEGIN;
SET LOCAL lock_timeout = '8s';

CREATE OR REPLACE FUNCTION public.fn_agents_staff_earn_no_rakeback()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.club_members cm
     WHERE cm.club_id = NEW.club_id AND cm.user_id = NEW.user_id
       AND cm.role IN ('co_owner', 'admin')
  ) THEN
    -- The row survives: it is also the agent wallet. Only the rate goes to zero.
    NEW.commission_rate      := 0;
    NEW.player_rakeback_rate := 0;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agents_staff_earn_no_rakeback ON public.agents;
CREATE TRIGGER trg_agents_staff_earn_no_rakeback
  BEFORE INSERT OR UPDATE OF role, commission_rate, player_rakeback_rate
  ON public.agents
  FOR EACH ROW
  WHEN (COALESCE(NEW.commission_rate, 0) <> 0
     OR COALESCE(NEW.player_rakeback_rate, 0) <> 0)
  EXECUTE FUNCTION public.fn_agents_staff_earn_no_rakeback();

UPDATE public.agents a
   SET commission_rate = 0, player_rakeback_rate = 0, updated_at = now()
  FROM public.club_members cm
 WHERE cm.club_id = a.club_id AND cm.user_id = a.user_id
   AND cm.role IN ('co_owner', 'admin')
   AND (COALESCE(a.commission_rate, 0) <> 0 OR COALESCE(a.player_rakeback_rate, 0) <> 0);

DO $verify$
DECLARE v_n int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'agents' AND t.tgname = 'trg_agents_staff_earn_no_rakeback') THEN
    RAISE EXCEPTION 'trg_agents_staff_earn_no_rakeback was not created';
  END IF;
  SELECT count(*) INTO v_n FROM agents a JOIN club_members cm
       ON cm.club_id = a.club_id AND cm.user_id = a.user_id
   WHERE cm.role IN ('co_owner','admin')
     AND (COALESCE(a.commission_rate,0) <> 0 OR COALESCE(a.player_rakeback_rate,0) <> 0);
  IF v_n > 0 THEN RAISE EXCEPTION '% staff agent row(s) still carry a rate', v_n; END IF;
END
$verify$;

COMMIT;
