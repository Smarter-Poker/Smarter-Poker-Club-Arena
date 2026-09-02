-- The checkout grant primitive and refund writer are server implementation
-- details. The fulfillment migration revoked the helper but did not explicitly
-- grant service_role, and CREATE OR REPLACE retained the refund function's
-- legacy authenticated ACL. Close both direct browser paths in production.

REVOKE ALL ON FUNCTION public.sp_grant_shop_item(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sp_grant_shop_item(uuid, uuid, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.fn_refund_shop_purchase(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_refund_shop_purchase(uuid, uuid, uuid, text)
  TO service_role;

DO $$
BEGIN
  IF has_function_privilege(
       'anon',
       'public.sp_grant_shop_item(uuid,uuid,text)',
       'EXECUTE'
     ) OR has_function_privilege(
       'authenticated',
       'public.sp_grant_shop_item(uuid,uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'shop grant helper is still browser-callable';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.fn_refund_shop_purchase(uuid,uuid,uuid,text)',
       'EXECUTE'
     ) OR has_function_privilege(
       'authenticated',
       'public.fn_refund_shop_purchase(uuid,uuid,uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'shop refund writer is still browser-callable';
  END IF;

  IF NOT has_function_privilege(
       'service_role',
       'public.sp_grant_shop_item(uuid,uuid,text)',
       'EXECUTE'
     ) OR NOT has_function_privilege(
       'service_role',
       'public.fn_refund_shop_purchase(uuid,uuid,uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'service_role lost a required shop fulfillment privilege';
  END IF;
END
$$;
