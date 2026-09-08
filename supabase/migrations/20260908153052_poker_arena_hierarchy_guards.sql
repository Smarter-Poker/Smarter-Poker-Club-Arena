-- Phase 2 access rollout. No Diamond custody or gameplay is enabled.
SET lock_timeout = '5s';
SET statement_timeout = '30s';

CREATE TRIGGER poker_arena_union_guard BEFORE INSERT OR UPDATE ON public.union_clubs
FOR EACH ROW EXECUTE FUNCTION public.fn_poker_guard_arena_structure();
DO $hierarchy$
DECLARE v_table text;
BEGIN
  FOR v_table IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname IN (
      'agents','club_agents','sub_agents','player_agent_assignments','agent_commissions',
      'agent_commission_settlements','ca_club_commission_daily','rakeback_daily_state',
      'rakeback_daily_user','rakeback_distributions','rakeback_period_payouts','rakeback_periods')
  LOOP
    EXECUTE format('CREATE TRIGGER poker_arena_no_hierarchy BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fn_poker_reject_diamond_hierarchy()',v_table);
  END LOOP;
END $hierarchy$;

