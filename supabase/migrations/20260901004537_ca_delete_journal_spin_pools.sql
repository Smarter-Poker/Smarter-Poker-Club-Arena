-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").

SET LOCAL lock_timeout = '4s';
DROP TRIGGER IF EXISTS trg_ca_autoledger_delete ON public.spin_bonus_pools;
CREATE TRIGGER trg_ca_autoledger_delete BEFORE DELETE ON public.spin_bonus_pools
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_autoledger_delete('balance=spin_reserve');;
