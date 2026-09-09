-- 20260909163809_seal_diamond_custody_retry_doors_before_retirement.sql
--
-- The first Diamond Poker Arena cutover left a retry obligation, a recovery
-- sweep and a reconciliation scan behind an otherwise atomic custody transfer.
-- Poker Arena gameplay is still disabled and production has never created a
-- custody, movement or obligation row. Seal every service door first. The
-- follow-up migration is applied only after this revocation has drained, then
-- replaces release with one all-or-nothing transaction and removes the retry
-- table and both sweep functions.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

SELECT pg_advisory_xact_lock(
  hashtextextended('poker_diamond_custody_cutover', 0)
);

DO $preflight$
DECLARE
  v_signature text;
  v_expected text;
  v_proc regprocedure;
  v_actual text;
BEGIN
  FOR v_signature, v_expected IN
    SELECT * FROM (VALUES
      ('public.fn_poker_diamond_reserve(uuid,text,uuid,text,numeric,uuid)',
       'b5fe0c538e319f4d5a940b59fe951ec0'),
      ('public.fn_poker_diamond_release(uuid,uuid)',
       '5f2ea58fdd2e61febd5a6edc63a7f014'),
      ('public.fn_poker_diamond_reconcile()',
       '40a8a29faf7379412668f0c7fde720b2'),
      ('public.fn_poker_diamond_recover_releases()',
       '1b36bba2b05bc625c4979428bd57ebd8')
    ) AS expected(signature, definition_md5)
  LOOP
    v_proc := to_regprocedure(v_signature);
    IF v_proc IS NULL THEN
      RAISE EXCEPTION '% is missing; refuse an unaudited custody cutover',
        v_signature;
    END IF;
    SELECT md5(pg_get_functiondef(v_proc)) INTO v_actual;
    IF v_actual IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION '% drifted before the custody cutover (md5=%)',
        v_signature, v_actual;
    END IF;
  END LOOP;

  IF to_regclass('public.poker_diamond_custody') IS NULL
     OR to_regclass('public.poker_diamond_movements') IS NULL
     OR to_regclass('public.poker_diamond_lot_reservations') IS NULL
     OR to_regclass('public.poker_diamond_obligations') IS NULL THEN
    RAISE EXCEPTION 'Diamond custody schema is incomplete';
  END IF;

  IF EXISTS (SELECT 1 FROM public.poker_diamond_custody)
     OR EXISTS (SELECT 1 FROM public.poker_diamond_movements)
     OR EXISTS (SELECT 1 FROM public.poker_diamond_lot_reservations)
     OR EXISTS (SELECT 1 FROM public.poker_diamond_obligations) THEN
    RAISE EXCEPTION
      'Diamond custody was used after its verified zero-row production inventory; stop and audit every row';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM cron.job
     WHERE lower(COALESCE(jobname, '')) LIKE '%poker%diamond%'
        OR lower(COALESCE(command, '')) LIKE '%fn_poker_diamond%'
  ) THEN
    RAISE EXCEPTION
      'A PostgreSQL Diamond custody scheduler exists; retire it before sealing the RPCs';
  END IF;
END;
$preflight$;

-- Revocation is its own committed drain boundary. It prevents a new service
-- request from entering any custody path while an already-parsed request is
-- allowed to finish or fail before the second migration takes the table locks.
REVOKE ALL ON FUNCTION
  public.fn_poker_diamond_reserve(uuid,text,uuid,text,numeric,uuid),
  public.fn_poker_diamond_release(uuid,uuid),
  public.fn_poker_diamond_reconcile(),
  public.fn_poker_diamond_recover_releases()
FROM PUBLIC, anon, authenticated, service_role;

DO $postcondition$
DECLARE
  v_proc regprocedure;
BEGIN
  FOREACH v_proc IN ARRAY ARRAY[
    'public.fn_poker_diamond_reserve(uuid,text,uuid,text,numeric,uuid)'::regprocedure,
    'public.fn_poker_diamond_release(uuid,uuid)'::regprocedure,
    'public.fn_poker_diamond_reconcile()'::regprocedure,
    'public.fn_poker_diamond_recover_releases()'::regprocedure
  ] LOOP
    IF has_function_privilege('service_role', v_proc, 'EXECUTE')
       OR has_function_privilege('authenticated', v_proc, 'EXECUTE')
       OR has_function_privilege('anon', v_proc, 'EXECUTE') THEN
      RAISE EXCEPTION '% remained executable after the custody seal', v_proc;
    END IF;
  END LOOP;
END;
$postcondition$;

COMMIT;
