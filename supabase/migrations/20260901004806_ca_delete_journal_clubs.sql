-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").

SET LOCAL lock_timeout = '4s';
DROP TRIGGER IF EXISTS trg_ca_autoledger_delete ON public.clubs;
CREATE TRIGGER trg_ca_autoledger_delete BEFORE DELETE ON public.clubs
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_autoledger_delete(
    'chip_treasury=club_treasury','chip_pool=club_treasury',
    'promo_balance=promo_wallet','insurance_balance=insurance_bank');;
