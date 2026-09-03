-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").

SET LOCAL lock_timeout = '4s';
DROP TRIGGER IF EXISTS trg_ca_autoledger_delete ON public.union_wallets;
CREATE TRIGGER trg_ca_autoledger_delete BEFORE DELETE ON public.union_wallets
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_autoledger_delete(
    'chip_balance=union_bank','rake_wallet=union_wallet','bbj_wallet=union_wallet',
    'promo_wallet=union_wallet','insurance_wallet=union_wallet','spin_reserve_wallet=union_wallet');;
