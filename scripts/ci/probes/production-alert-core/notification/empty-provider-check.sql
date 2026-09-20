-- Source-only provider contamination check; no financial functions are called.
BEGIN READ ONLY;
SET LOCAL statement_timeout='8s';
DO $$
DECLARE r record; occupied boolean;
BEGIN
  IF current_user<>'fixture_bootstrap' OR current_database()!~'^qual_owner_notify_[0-9a-f]{32}$'
    OR (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname IN('auth','public') AND c.relkind IN('r','p'))>300
  THEN RAISE EXCEPTION 'bounded empty provider boundary rejected'; END IF;
  FOR r IN SELECT c.oid::regclass name FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN('auth','public') AND c.relkind IN('r','p')
      AND c.oid NOT IN('auth.users'::regclass,'public.profiles'::regclass)
    ORDER BY c.oid
  LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %s LIMIT 1)',r.name) INTO occupied;
    IF occupied THEN RAISE EXCEPTION 'unexpected provider row in %',r.name; END IF;
  END LOOP;
  IF (SELECT count(*) FROM auth.users)<>2 OR (SELECT count(*) FROM public.profiles)<>2
    OR EXISTS(SELECT 1 FROM public.profiles WHERE diamonds IS DISTINCT FROM 0
      OR diamond_balance IS DISTINCT FROM 0 OR is_horse IS DISTINCT FROM false
      OR role IS DISTINCT FROM 'user')
  THEN RAISE EXCEPTION 'synthetic zero principal proof failed'; END IF;
END $$;
COMMIT;
