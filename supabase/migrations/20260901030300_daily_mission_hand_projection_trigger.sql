-- One busy relation per migration keeps live DDL lock ordering acyclic.
ALTER TABLE public.hand_history ADD COLUMN IF NOT EXISTS daily_mission_events jsonb;

DROP TRIGGER IF EXISTS trg_enqueue_hand_daily_missions ON public.hand_history;
CREATE TRIGGER trg_enqueue_hand_daily_missions
AFTER INSERT ON public.hand_history
FOR EACH ROW EXECUTE FUNCTION public.fn_enqueue_hand_daily_missions();
