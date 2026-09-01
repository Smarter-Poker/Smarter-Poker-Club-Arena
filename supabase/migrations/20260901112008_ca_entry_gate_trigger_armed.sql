-- Deep Stack event hardening, part 2: arm the entry gate. Separate migration
-- so the brief AccessExclusive lock on tournament_players is its own short
-- transaction (live-traffic DDL rule: one table per migration, 4s lock cap).
SET LOCAL lock_timeout = '4s';
DROP TRIGGER IF EXISTS trg_ca_tournament_entry_gate ON public.tournament_players;
CREATE TRIGGER trg_ca_tournament_entry_gate
  BEFORE INSERT ON public.tournament_players
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_tournament_entry_gate();
