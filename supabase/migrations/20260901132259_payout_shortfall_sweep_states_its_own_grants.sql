-- CREATE OR REPLACE does not reset an ACL, and production already holds
-- exactly this grant, so these two statements change nothing there. They are
-- here because check-definer-authorization reads the migration, not the
-- database, and it is right to: a migration that declares a SECURITY DEFINER
-- function which moves money should say on its face who may call it. Nobody in
-- a browser calls a sweep.
REVOKE ALL ON FUNCTION public.fn_pay_backed_payout_shortfalls(boolean, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_pay_backed_payout_shortfalls(boolean, integer) TO service_role;

DO $$
DECLARE v_acls text[]; v_entry text;
BEGIN
  SELECT array_agg(a::text) INTO v_acls
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL unnest(p.proacl) AS a
   WHERE n.nspname='public' AND p.proname='fn_pay_backed_payout_shortfalls';
  FOREACH v_entry IN ARRAY COALESCE(v_acls, ARRAY[]::text[]) LOOP
    IF v_entry LIKE '=%' OR v_entry LIKE 'anon=%' OR v_entry LIKE 'authenticated=%' THEN
      RAISE EXCEPTION 'fn_pay_backed_payout_shortfalls is reachable from a browser role: %', v_entry;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM unnest(COALESCE(v_acls, ARRAY[]::text[])) e WHERE e LIKE 'service_role=X%') THEN
    RAISE EXCEPTION 'fn_pay_backed_payout_shortfalls lost its service_role grant: %', v_acls;
  END IF;
END $$;
