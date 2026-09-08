-- Phase 2 access rollout. No Diamond custody or gameplay is enabled.
SET lock_timeout = '5s';
SET statement_timeout = '30s';

CREATE TRIGGER poker_arena_chip_seat_guard BEFORE INSERT OR UPDATE OF table_id ON public.table_seats
FOR EACH ROW EXECUTE FUNCTION public.fn_poker_guard_chip_seat();
