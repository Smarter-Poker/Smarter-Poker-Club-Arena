-- Reserved by scripts/new-migration.mjs; exact production preimages read 2026-10-26.
-- Browser run 40345982952 passed its suites but cleanup exhausted five 30s
-- platform-gate attempts. History retention held that gate SHARED for 23-34s
-- every 30s. Trying EXCLUSIVE without a reservation could starve indefinitely.
--
-- Reserve a turn on (530090,2), used ONLY by retention and these four fixtures.
-- Existing retention finishes; a new batch declines without waiting. Purchases
-- never use this key. The original nonqueueing platform gate, maintenance
-- priority, all identity/activity/lease/financial guards and cron stay intact.
-- The reservation is transaction-scoped and bounded at 32s (cron timeout 30s
-- plus admission headroom). No global lock queues, new schedules or retries.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_prepare_unused_welcome_certification_board_leases(uuid)'::regprocedure)) = '52135b92428b122b02b2bb6094758442' AND md5(pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure)) = '6f7acd77614c5c5599ec6d966598f47a')
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION smarter_private.certification_retention_admission()
RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '32s'
AS $admission$
  SELECT pg_catalog.pg_advisory_xact_lock(530090,2);
$admission$;
REVOKE ALL ON FUNCTION smarter_private.certification_retention_admission() FROM PUBLIC, anon, authenticated, service_role;

DO $patch$
DECLARE
  item record;
  signature regprocedure;
  before_text text;
  after_text text;
  prior_acl aclitem[];
  old_fragment text;
  new_fragment text;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('public.fn_ca_prepare_post_reset_welcome_certification_fixture(uuid)','93be153c305e51ffe3070a0ea0cf480d','463ffcd7f4a6cc77ccc648a033a9a618',false),
    ('public.fn_ca_prepare_unused_welcome_certification_board_games(uuid)','ffda181a8ba22495a37681d707d40404','023dad99aeb5671a19cbc83ba622d2d4',false),
    ('public.fn_ca_prepare_unused_welcome_certification_board_leases(uuid)','c0e56e2aafcf8a21aba03edca44a2268','52135b92428b122b02b2bb6094758442',false),
    ('public.fn_ca_prepare_unused_welcome_certification_board_origins(uuid)','adc1f35047877485a1ac35a124dc7e84','7d43b2872d4dad240b67c4c2267c6d50',false),
    ('public.sp_prune_hand_history(integer)','60bf472a763ad182ffd53c3b2bb3e14c','6f7acd77614c5c5599ec6d966598f47a',true)
  ) AS patches(sig,pre_hash,post_hash,is_retention) LOOP
    signature := item.sig::regprocedure;
    before_text := pg_get_functiondef(signature);
    IF md5(before_text) <> item.pre_hash THEN
      RAISE EXCEPTION 'CERTIFICATION_RETENTION_PREIMAGE_CHANGED: %', item.sig;
    END IF;
    SELECT proacl INTO prior_acl FROM pg_proc WHERE oid=signature;
    IF item.is_retention THEN
      old_fragment := $oldprune$  -- Preserve the original maintenance/settlement owner before any ledger read.
$oldprune$;
      new_fragment := $newprune$  -- A waiting fixture reserves its turn on a lane used only by retention.
  IF pg_catalog.pg_try_advisory_xact_lock_shared(530090,2) IS NOT TRUE THEN RETURN 0; END IF;
  -- Preserve the original maintenance/settlement owner before any ledger read.
$newprune$;
    ELSE
      old_fragment := $oldfixture$    WHILE NOT pg_try_advisory_xact_lock(530090,1) LOOP
$oldfixture$;
      new_fragment := $newfixture$    PERFORM smarter_private.certification_retention_admission();
    WHILE NOT pg_try_advisory_xact_lock(530090,1) LOOP
$newfixture$;
    END IF;
    IF (length(before_text)-length(replace(before_text,old_fragment,'')))/length(old_fragment) <> 1 THEN
      RAISE EXCEPTION 'CERTIFICATION_RETENTION_FRAGMENT_CHANGED: %',item.sig;
    END IF;
    EXECUTE replace(before_text,old_fragment,new_fragment);
    after_text := pg_get_functiondef(signature);
    IF md5(after_text) <> item.post_hash
       OR md5(replace(after_text,new_fragment,old_fragment)) <> item.pre_hash
       OR (SELECT proacl FROM pg_proc WHERE oid=signature) IS DISTINCT FROM prior_acl
       OR has_function_privilege('anon',signature,'EXECUTE')
       OR has_function_privilege('authenticated',signature,'EXECUTE') THEN
      RAISE EXCEPTION 'CERTIFICATION_RETENTION_POSTIMAGE_OR_ACL_CHANGED: %',item.sig;
    END IF;
  END LOOP;
END $patch$;
COMMIT;
