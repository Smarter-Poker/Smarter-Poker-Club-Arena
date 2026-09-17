BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
DO $guard$
BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_daily_bonus_open_day(uuid,date)'::regprocedure)) <> '99368881e41829478f592456f453a10e' THEN
    RAISE EXCEPTION 'Daily Bonus private helper changed; re-review before applying its ACL';
  END IF;
END
$guard$;
-- CREATE OR REPLACE preserves the inherited private ACL. State it explicitly
-- alongside the new Daily Bonus release so a clean migration replay closes
-- the helper regardless of public-schema default privileges.
REVOKE ALL ON FUNCTION public.fn_ca_daily_bonus_open_day(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_daily_bonus_open_day(uuid, date) TO service_role;
DO $verify$
BEGIN
  IF has_function_privilege('anon','public.fn_ca_daily_bonus_open_day(uuid,date)','EXECUTE')
     OR has_function_privilege('authenticated','public.fn_ca_daily_bonus_open_day(uuid,date)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.fn_ca_daily_bonus_open_day(uuid,date)','EXECUTE') THEN
    RAISE EXCEPTION 'Daily Bonus private helper ACL verification failed';
  END IF;
END
$verify$;
COMMIT;
