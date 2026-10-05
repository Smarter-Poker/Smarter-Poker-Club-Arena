-- Reserved by scripts/new-migration.mjs. Launch audit, October 5.
-- The wallet screen reads club_members and agent_wallets, but this RPC still
-- moved the retired public.wallets pool. Existing tabs must refuse too.
-- No balance, ledger, or historical record is changed. Signature stays stable.
-- @live-proof: position('WALLET_POOL_RETIRED' in pg_get_functiondef('public.fn_wallet_type_transfer(uuid,text,text,numeric,text)'::regprocedure)) > 0
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
DO $preimage$
BEGIN
  IF md5(pg_get_functiondef('public.fn_wallet_type_transfer(uuid,text,text,numeric,text)'::regprocedure))
     <> 'b54ab7050103eecf3b456969e5a71bbd' THEN
    RAISE EXCEPTION 'Retired wallet transfer preimage changed; inspect before installation';
  END IF;
END;
$preimage$;
CREATE OR REPLACE FUNCTION public.fn_wallet_type_transfer(
  p_user_id uuid, p_from_wallet text, p_to_wallet text,
  p_amount numeric, p_note text DEFAULT ''::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION 'WALLET_POOL_RETIRED: Open The Club Cashier To Manage Club Chips'
    USING ERRCODE = '55000',
          HINT = 'Club balances cannot be transferred through the retired global wallet pool.';
END;
$function$;
COMMENT ON FUNCTION public.fn_wallet_type_transfer(uuid,text,text,numeric,text) IS
  'Retired global-wallet transfer. Refuses without moving balances; use the club cashier and its scoped supported operations.';
COMMIT;
