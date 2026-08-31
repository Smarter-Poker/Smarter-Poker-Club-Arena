DROP TRIGGER IF EXISTS trg_daily_missions_tournament_registered ON public.tournament_players;
CREATE TRIGGER trg_daily_missions_tournament_registered
AFTER INSERT OR UPDATE OF status ON public.tournament_players
FOR EACH ROW EXECUTE FUNCTION public.fn_daily_missions_tournament_registered();
