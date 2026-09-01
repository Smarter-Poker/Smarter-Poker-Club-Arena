-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").

SET LOCAL lock_timeout = '4s';
DROP TRIGGER IF EXISTS trg_ca_autoledger_delete ON public.agents;
CREATE TRIGGER trg_ca_autoledger_delete BEFORE DELETE ON public.agents
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_autoledger_delete(
    'agent_wallet_balance=agent_wallet','promo_wallet_balance=promo_wallet');;
