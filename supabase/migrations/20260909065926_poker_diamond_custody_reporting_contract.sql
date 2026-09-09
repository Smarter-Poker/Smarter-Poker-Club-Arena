-- A discrepancy report only reads evidence; it never repairs a balance.
-- Keep the former name until the existing worker has adopted the new RPC.
BEGIN;
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_custody_discrepancies()
RETURNS TABLE(custody_id uuid,kind text,difference numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
 WITH posted AS (
 SELECT m.custody_id,sum(CASE WHEN action='reserve' THEN amount ELSE -amount END) amount
 FROM public.poker_diamond_movements m GROUP BY m.custody_id
 )
 SELECT c.id,'custody_vs_movements'::text,(c.balance-COALESCE(p.amount,0))::numeric
 FROM public.poker_diamond_custody c LEFT JOIN posted p ON p.custody_id=c.id
 WHERE c.balance<>COALESCE(p.amount,0)
 UNION ALL
 SELECT m.custody_id,'wallet_journal'::text,m.amount::numeric
 FROM public.poker_diamond_movements m LEFT JOIN (SELECT id,user_id,amount FROM public.diamond_transactions UNION ALL SELECT id,user_id,amount FROM public.ca_diamond_journal_archive) t ON t.id=m.wallet_journal_id
 WHERE t.id IS NULL OR t.user_id IS DISTINCT FROM m.user_id OR
 t.amount IS DISTINCT FROM (CASE WHEN m.action='reserve' THEN -m.amount ELSE m.amount END)
 UNION ALL
 SELECT NULL::uuid,'purchase_reservations'::text,
 (l.arena_reserved-COALESCE(r.amount,0))::numeric
 FROM public.diamond_purchase_lots l LEFT JOIN (
 SELECT lot_id,sum(amount) amount FROM public.poker_diamond_lot_reservations WHERE released_at IS NULL GROUP BY lot_id
 ) r ON r.lot_id=l.id WHERE l.arena_reserved<>COALESCE(r.amount,0);
$fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_custody_discrepancies() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_custody_discrepancies() TO service_role;

REVOKE ALL ON FUNCTION public.fn_ca_arena_diamonds() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_arena_diamonds() TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_register_vs_supply() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_register_vs_supply() TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_trial_balance(timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_trial_balance(timestamptz) TO service_role;
COMMIT;
