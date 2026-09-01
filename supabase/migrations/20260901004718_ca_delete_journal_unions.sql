-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").

SET LOCAL lock_timeout = '4s';
DROP TRIGGER IF EXISTS trg_ca_autoledger_delete ON public.unions;
CREATE TRIGGER trg_ca_autoledger_delete BEFORE DELETE ON public.unions
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_autoledger_delete(
    'chip_balance=union_bank','rake_wallet=union_wallet','main_bbj_balance=bbj_pool',
    'backup_bbj_balance=bbj_pool','promo_fund_balance=promo_wallet','insurance_balance=insurance_bank');;
