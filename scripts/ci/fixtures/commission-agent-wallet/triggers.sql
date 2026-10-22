-- The live deferred receipt guard on every rakeback payout leg.
CREATE CONSTRAINT TRIGGER zz_ca_rakeback_payout_leg_is_documented AFTER INSERT ON public.chip_ledger DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW WHEN (NEW.status='posted' AND NEW.category='rakeback' AND NEW.to_type='player_wallet')
 EXECUTE FUNCTION public.fn_ca_rakeback_payout_leg_is_documented();
