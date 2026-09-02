-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828033029; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- A SPIN NEVER TAKES THE :55 BREAK, AND A DRAWN BUTTON SURVIVES A RESTART
-- 2026-08-27. Full note in
-- supabase/migrations/20260827_spin_never_breaks_and_drawn_button_survives_restart.sql

ALTER TABLE public.tournaments
  ALTER COLUMN synchronized_breaks SET DEFAULT true;

COMMENT ON COLUMN public.tournaments.synchronized_breaks IS
  'Does this tournament take the platform-wide :55 synchronized break? FORCED false for SPIN and SNG by tournaments_short_formats_never_break - a 3-handed hyper whose levels are three minutes cannot survive a five-minute stop. MTT/XMTT default true and may opt out (2026-08-22 parity).';

CREATE OR REPLACE FUNCTION public.fn_short_formats_never_break()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF upper(COALESCE(NEW.tournament_type, '')) IN ('SPIN', 'SNG')
     OR lower(COALESCE(NEW.variant, '')) IN ('spin', 'sng')
  THEN
    NEW.synchronized_breaks := false;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS tournaments_short_formats_never_break ON public.tournaments;
CREATE TRIGGER tournaments_short_formats_never_break
  BEFORE INSERT OR UPDATE OF tournament_type, variant, synchronized_breaks
  ON public.tournaments
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_short_formats_never_break();

ALTER TABLE public.tables
  ADD COLUMN IF NOT EXISTS first_button_seat integer;

COMMENT ON COLUMN public.tables.first_button_seat IS
  'Seat number of a button DRAWN before the first hand (Spin reveal, beat 3). Read back by TournamentManagerBase.restoreDrawnFirstButtons on engine restart and re-applied ONLY while the table has zero hand_history rows - past the first hand a forced seat beats the live rotation and would throw the button backwards. Cleared once the table has dealt.';
