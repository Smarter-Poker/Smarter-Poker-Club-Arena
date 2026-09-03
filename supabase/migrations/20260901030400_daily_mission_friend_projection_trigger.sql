DROP TRIGGER IF EXISTS trg_daily_missions_friend_accepted ON public.friendships;
CREATE TRIGGER trg_daily_missions_friend_accepted
AFTER INSERT OR UPDATE OF status ON public.friendships
FOR EACH ROW EXECUTE FUNCTION public.fn_daily_missions_friend_accepted();
