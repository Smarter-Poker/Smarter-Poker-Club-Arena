-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").

SET LOCAL lock_timeout = '4s';
DROP TRIGGER IF EXISTS trg_ca_autoledger_delete ON public.bbj_pools;
CREATE TRIGGER trg_ca_autoledger_delete BEFORE DELETE ON public.bbj_pools
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_autoledger_delete(
    'main_balance=bbj_pool','backup_balance=bbj_pool','promo_balance=bbj_pool');;
