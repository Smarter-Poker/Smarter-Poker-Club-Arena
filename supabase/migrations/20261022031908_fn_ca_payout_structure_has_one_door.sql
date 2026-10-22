-- fn_ca_payout_structure has one door: (integer, numeric) from 20261022014607 replaces (integer, integer).
BEGIN;
SET LOCAL lock_timeout = '2s';
DO $drop$
DECLARE v_old regprocedure := to_regprocedure('public.fn_ca_payout_structure(integer,integer)');
BEGIN
  IF v_old IS NULL THEN RETURN; END IF;
  IF md5(pg_get_functiondef(v_old)) <> '320527cd5203efab28b465d2b56ca567' THEN
    RAISE EXCEPTION 'fn_ca_payout_structure(integer,integer) is not the pinned text (md5 %)', md5(pg_get_functiondef(v_old));
  END IF;
  IF to_regprocedure('public.fn_ca_payout_structure(integer,numeric)') IS NULL THEN
    RAISE EXCEPTION 'the (integer,numeric) door is missing; refusing to drop the only generator';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname <> 'fn_ca_payout_structure'
                AND p.prosrc ~* 'fn_ca_payout_structure\s*\(\s*[^,()]+\)') THEN
    RAISE EXCEPTION 'a caller still relies on the one-argument default of the old door';
  END IF;
  DROP FUNCTION public.fn_ca_payout_structure(integer, integer);
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'fn_ca_payout_structure') <> 1 THEN
    RAISE EXCEPTION 'fn_ca_payout_structure post-image has % overloads, expected exactly one',
      (SELECT count(*) FROM pg_proc WHERE proname = 'fn_ca_payout_structure');
  END IF;
END $drop$;
COMMIT;