-- Bank-first cashier writers can own the bank before waiting for a wallet.
-- A status transition must never own that wallet and then wait for their bank.
-- Acquire both source banks and wallets NOWAIT before the existing return hooks.
-- This is an event-owned lock refinement; no balances or receipts are rewritten.
-- @live-proof: EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.fn_deleted_account_custody_settled()'::regprocedure AND md5(prosrc)='1053e01a49d88103f2ae097cde93223f')
BEGIN;
SET LOCAL lock_timeout='500ms';
SET LOCAL statement_timeout='10s';
DO $guard$
DECLARE v_definition text;
BEGIN
  IF md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_deleted_account_custody_settled()'::regprocedure))
    <> '373851405487e05342351040bcc990ea' THEN
    RAISE EXCEPTION 'account_custody_lock_preimage_changed';
  END IF;
  v_definition := pg_get_functiondef('public.fn_deleted_account_custody_settled()'::regprocedure);
  EXECUTE replace(v_definition,$before$  PERFORM 1 FROM public.agents a WHERE a.user_id = OLD.id$before$,$after$  -- Own the banks before wallets, without waiting behind a bank-first cashier.
  -- Wallet-first credits likewise cause the later NOWAIT wallet lock to refuse.
  PERFORM 1 FROM public.clubs c WHERE c.asset='chips' AND c.lifecycle_status='active'
    AND EXISTS (SELECT 1 FROM public.club_members m WHERE m.club_id=c.id AND m.user_id=OLD.id)
    ORDER BY c.id FOR UPDATE NOWAIT;
  PERFORM 1 FROM public.agents a WHERE a.user_id = OLD.id$after$);
  IF md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_deleted_account_custody_settled()'::regprocedure))
    <> '1053e01a49d88103f2ae097cde93223f' THEN
    RAISE EXCEPTION 'account_custody_lock_postimage_changed';
  END IF;
END;
$guard$;
COMMIT;
