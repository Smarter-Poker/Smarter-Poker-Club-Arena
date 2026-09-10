-- Retire unbound rakeback payout RPCs. No balances or historical rows change.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '10s';
DO $preflight$
DECLARE r record; v_oid oid;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.atomic_pay_player_rakeback(uuid,numeric)', 'f208633d1947dd8513dd0e85dbc20edc'),
    ('public.atomic_pay_player_rakeback(uuid,uuid,numeric,uuid,text)', '095b6ffaa3b0d0fa0683d4674796b305'),
    ('public.credit_player_rakeback(uuid,numeric,text,text)', 'c8954025415debb1957b3f1fb1ddbc1c')
  ) AS expected(signature,body_md5)
  LOOP
    v_oid := to_regprocedure(r.signature);
    IF v_oid IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_proc WHERE oid=v_oid AND md5(prosrc)=r.body_md5
        AND proowner='postgres'::regrole AND NOT prosecdef
    ) THEN
      RAISE EXCEPTION 'Rakeback retirement requires re-review of %',r.signature;
    END IF;
    IF NOT has_function_privilege('service_role',v_oid,'EXECUTE')
      OR EXISTS (SELECT 1 FROM pg_proc p,
        LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE p.oid=v_oid AND a.privilege_type='EXECUTE'
          AND a.grantee NOT IN ('postgres'::regrole,'service_role'::regrole))
    THEN
      RAISE EXCEPTION 'Rakeback retirement grants changed: %',r.signature;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_depend WHERE refclassid='pg_proc'::regclass
       AND refobjid=v_oid) THEN
      RAISE EXCEPTION 'Rakeback retirement gained stored dependencies: %',r.signature;
    END IF;
  END LOOP;
  -- These three matches are catalog/guard name inventories, not callers.
  -- Pin their bodies so a newly introduced nested call cannot be overlooked.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE p.prosrc ~ '(atomic_pay_player_rakeback|credit_player_rakeback)'
       AND NOT (n.nspname='public' AND p.proname IN
         ('atomic_pay_player_rakeback','credit_player_rakeback'))
       AND NOT (n.nspname='public' AND (p.oid::regprocedure::text,md5(p.prosrc)) IN (
         ('fn_club_arena_global_wallet_check()','5a76e0de18ddcb3247adde1c2995263a'),
         ('fn_union_money_path_check()','231d1d6614932614455ce320b261f349'),
         ('guard_wallet_balance_write()','5fa8a504757adfba1ad3939722dd0064')))
  ) THEN
    RAISE EXCEPTION 'Rakeback retirement has a new or changed nested reference';
  END IF;
END $preflight$;
REVOKE ALL ON FUNCTION
  public.atomic_pay_player_rakeback(uuid,numeric),
  public.atomic_pay_player_rakeback(uuid,uuid,numeric,uuid,text),
  public.credit_player_rakeback(uuid,numeric,text,text)
FROM PUBLIC,anon,authenticated,service_role;
DO $postflight$
DECLARE v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.atomic_pay_player_rakeback(uuid,numeric)',
    'public.atomic_pay_player_rakeback(uuid,uuid,numeric,uuid,text)',
    'public.credit_player_rakeback(uuid,numeric,text,text)'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN
      ('anon','authenticated','service_role')
      AND has_function_privilege(r.oid,to_regprocedure(v_sig),'EXECUTE'))
    THEN RAISE EXCEPTION 'Rakeback retirement remains executable: %',v_sig; END IF;
  END LOOP;
END $postflight$;
COMMIT;
