-- Phase 2 access rollout. No Diamond custody or gameplay is enabled.
SET lock_timeout = '5s';
SET statement_timeout = '30s';

CREATE POLICY poker_arena_tournament_access ON public.tournaments AS RESTRICTIVE FOR SELECT TO authenticated
USING ((club_id IS NULL AND union_id IS NULL)
  OR public.fn_poker_can_read_games(coalesce(union_id,club_id)));
CREATE POLICY poker_arena_tournament_guest_access ON public.tournaments AS RESTRICTIVE FOR SELECT TO anon
USING (club_id IS NULL AND union_id IS NULL);
CREATE POLICY poker_arena_diamond_tournaments ON public.tournaments FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.clubs c WHERE c.id=tournaments.club_id AND c.asset='diamonds')
  AND public.fn_poker_can_read_games(club_id));
CREATE TRIGGER poker_arena_tournament_guard BEFORE INSERT OR UPDATE ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION public.fn_poker_guard_arena_structure();
