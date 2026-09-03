-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").

SET LOCAL lock_timeout = '4s';
DROP TRIGGER IF EXISTS trg_ca_autoledger_delete ON public.club_members;
CREATE TRIGGER trg_ca_autoledger_delete BEFORE DELETE ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_autoledger_delete(
    'chip_balance=player_wallet','promo_balance=promo_wallet');

INSERT INTO public.ca_guard_inventory (kind, object_a, object_b, note, active)
SELECT 'trigger', 'trg_ca_autoledger_delete', t, 'deleting a row that holds value journals a burn to chip_retirement', true
FROM unnest(ARRAY['clubs','club_members','club_wallets','union_wallets','unions','agents','bbj_pools','spin_bonus_pools']) t
WHERE NOT EXISTS (SELECT 1 FROM public.ca_guard_inventory g
                   WHERE g.object_a='trg_ca_autoledger_delete' AND g.object_b=t);;
