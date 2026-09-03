-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901110057; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- HorseFleetManager.ts:682 states the rule the whole fleet relies on:
--   .neq('horse_status', 'disabled')  // 'disabled' is the only status that prevents playing
--
-- GameServer.cleanupStaleData() breaks it on every engine boot:
--   update profiles set horse_status='available' where is_horse and horse_status<>'available'
-- That sweep does not exclude 'disabled', so a bench order survives only until the
-- next restart. Measured: 416 horses benched at 10:20, 372 of them back on the
-- floor by 10:57 without anyone asking for it.
--
-- The engine fix ships separately. This is the latch underneath it, so the hold
-- does not depend on which build happens to be running: once a horse is
-- disabled, nothing lifts it except a caller that says so on purpose by setting
-- app.horse_release = 'on' for its transaction. The trigger never raises -- it
-- silently keeps the column -- because the boot sweep is a blind bulk UPDATE and
-- an exception there would take the engine down with it.

CREATE OR REPLACE FUNCTION public.fn_a_benched_horse_stays_benched()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.horse_status = 'disabled'
     AND NEW.horse_status IS DISTINCT FROM 'disabled'
     AND COALESCE(current_setting('app.horse_release', true), '') <> 'on'
  THEN
    NEW.horse_status := 'disabled';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_a_benched_horse_stays_benched ON public.profiles;
CREATE TRIGGER trg_a_benched_horse_stays_benched
  BEFORE UPDATE OF horse_status ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_a_benched_horse_stays_benched();
