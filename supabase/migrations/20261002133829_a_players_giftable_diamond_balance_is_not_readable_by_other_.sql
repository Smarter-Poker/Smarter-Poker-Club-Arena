-- 20261002133829_a_players_giftable_diamond_balance_is_not_readable_by_other_.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- public.fn_ca_giftable_balance(p_user_id uuid) is SECURITY DEFINER and reads
-- profiles.diamonds and diamond_purchase_lots for WHATEVER user id it is given.
-- It never asks who is calling, and EXECUTE was held by authenticated, so any
-- signed-in player could read any other player's diamond balance over
-- /rest/v1/rpc/fn_ca_giftable_balance. Reproduced on production 2026-10-02 as
-- an ordinary club player (SET LOCAL ROLE authenticated + request.jwt.claims):
-- the call returned another player's balance, while profiles.diamonds itself
-- is column-revoked from authenticated.
--
-- The only caller is send_stream_gift(uuid,integer,text,text), itself SECURITY
-- DEFINER and owned by postgres, so it keeps calling with the owner's rights.
-- No client, engine or World Hub code calls this RPC. Removing the browser
-- grants is smaller than a guard and cannot be got wrong; service_role keeps it.
-- GRANT/REVOKE fires no PostgREST schema reload.
--
-- @live-proof: (SELECT NOT has_function_privilege('authenticated','public.fn_ca_giftable_balance(uuid)','EXECUTE') AND NOT has_function_privilege('anon','public.fn_ca_giftable_balance(uuid)','EXECUTE') AND has_function_privilege('service_role','public.fn_ca_giftable_balance(uuid)','EXECUTE'))

BEGIN;
SET LOCAL lock_timeout = '5s';

REVOKE EXECUTE ON FUNCTION public.fn_ca_giftable_balance(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_giftable_balance(uuid) TO service_role;

DO $assert$
BEGIN
  IF has_function_privilege('authenticated', 'public.fn_ca_giftable_balance(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_ca_giftable_balance(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_ca_giftable_balance is still callable from a browser role';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_ca_giftable_balance(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_ca_giftable_balance lost its service_role grant';
  END IF;
END $assert$;

COMMIT;
