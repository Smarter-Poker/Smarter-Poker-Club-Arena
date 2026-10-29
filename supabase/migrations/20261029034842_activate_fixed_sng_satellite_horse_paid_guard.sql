-- Activate the prepared fixed-SNG paid horse guard under the certified freeze.
-- CREATE TRIGGER needs a writer-blocking lock on the live roster. Preparation
-- is separate so the normal engine production door can see its service RPC;
-- the RPC refuses guard_not_installed until this exact trigger is enabled.
-- @install-window: daily-maintenance
-- @live-proof: EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.tournament_players'::regclass AND tgname='ca_fixed_sng_horse_paid_admission' AND tgenabled='O' AND tgfoid='public.fn_ca_fixed_sng_horse_paid_admission()'::regprocedure AND tgtype=7)
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
CREATE TRIGGER ca_fixed_sng_horse_paid_admission BEFORE INSERT ON public.tournament_players
 FOR EACH ROW EXECUTE FUNCTION public.fn_ca_fixed_sng_horse_paid_admission();
COMMIT;
