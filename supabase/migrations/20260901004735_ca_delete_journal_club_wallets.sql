-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").

SET LOCAL lock_timeout = '4s';
DROP TRIGGER IF EXISTS trg_ca_autoledger_delete ON public.club_wallets;
CREATE TRIGGER trg_ca_autoledger_delete BEFORE DELETE ON public.club_wallets
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_autoledger_delete(
    'chip_balance=club_wallet','insurance_balance=insurance_bank');;
