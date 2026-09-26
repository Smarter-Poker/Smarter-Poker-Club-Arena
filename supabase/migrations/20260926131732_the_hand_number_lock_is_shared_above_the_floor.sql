-- 20260926131732_the_hand_number_lock_is_shared_above_the_floor
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-26 13:17:32 UTC.
--
-- ===========================================================================
--  THE HAND-NUMBER LOCK IS SHARED ABOVE THE FLOOR
-- ===========================================================================
--
-- What was wrong
-- --------------
-- Every hand start in the fleet (fn_f06_allocate_hand_number, and the legacy
-- fn_next_hand_number) allocates its number through
-- smarter_private.f06_allocate_number_above(floor), which began with
--
--   PERFORM pg_advisory_xact_lock(hashtextextended('f06:global-hand-number-allocation',0));
--
-- EXCLUSIVE and transaction-scoped: held until the caller COMMITs. The
-- allocation is the last statement of fn_f06_allocate_hand_number, so the
-- lock is held through that transaction's commit flush, and during a WAL
-- flush stall one holder keeps every other hand start in the fleet waiting.
-- The function carries lock_timeout=2s, so every waiter past two seconds is a
-- refused hand start.
--
-- Measured from postgres_logs (log_lock_waits, deadlock_timeout 1 s), key
-- [5,4157936768,3423481551,1] = hashtextextended('f06:global-hand-number-
-- allocation',0), per five minutes on 2026-09-26:
--   07:25  496 waits > 1 s     07:45  798     09:15  546     09:25  860
--   with 93 / 75 / 147 / 408 lock timeouts in those same buckets.
-- Since the 09:33 fleet contraction (tournament managers quarantined, hands
-- per hour 27k -> 8-14k) the lock logged 0 waits in every bucket to 13:15:
-- it is not the cause of a brownout, it is what turns a commit stall into a
-- platform-wide refusal of hand starts.
--
-- Why the lock exists, and why it only needs to be exclusive around setval
-- -----------------------------------------------------------------------
-- nextval alone is atomic, never returns a value twice, and (CACHE 1, no
-- CYCLE - both preimage-guarded) only moves forward. The one operation that
-- can move public.global_hand_number_seq BACKWARD is setval: a caller whose
-- nextval came back below its floor sets the sequence to the floor. If other
-- callers' nextvals ran between that caller's nextval and its setval and
-- passed the floor, setval would rewind the sequence below numbers already
-- issued, and those numbers would be issued again. The lock exists to stop
-- exactly that interleaving.
--
-- Nothing else touches the sequence: this function is the only routine whose
-- source names it, no column default names it, and the sequence ACL gives
-- USAGE (nextval/setval) to postgres alone (service_role, anon and
-- authenticated hold SELECT only). Read 2026-09-26 13:14 UTC; the preimage
-- block below refuses to install if any of that has changed.
--
-- What this changes
-- -----------------
-- The function reads last_value first.
--   * last_value >= floor: nextval can only return above the floor, because
--     the sequence never moves backward (proof below). The lock is taken
--     SHARED. Shared holders never wait on one another; the shared lock only
--     excludes a concurrent setval. Should nextval nevertheless return below
--     the floor, the function refuses F06_HAND_NUMBER_UNSAFE: a hand start is
--     refused rather than a number reused.
--   * last_value < floor: the original path, unchanged, under the EXCLUSIVE
--     lock (ALTER SEQUENCE CACHE 1 barrier, nextval, setval to the floor).
-- The range checks, SECURITY DEFINER, owner, ACL, search_path and
-- lock_timeout are unchanged.
--
-- The invariant, proved
-- ---------------------
-- (1) setval runs only on the exclusive path, only with n < floor, and sets
--     the sequence to floor > n. The exclusive lock conflicts with every
--     shared and exclusive holder, so between that caller's nextval (n) and
--     its setval no other nextval runs: the sequence stands at n, and setval
--     moves it forward. The sequence is therefore monotonic.
-- (2) Numbers are unique: every issued number is either a nextval result
--     (never repeated by nextval, never rewound by setval by (1)) or the
--     setval target floor, after which the sequence stands at floor and the
--     next nextval returns floor+1.
-- (3) A table is never issued a number at or below one it dealt: its caller
--     passes floor = GREATEST(1000000, used_hand_number_max + 1), and both
--     paths return n >= floor (shared: by (1) and the explicit refusal;
--     exclusive: by setval).
-- (4) The unlocked read of last_value cannot mislead the shared path: by (1)
--     last_value only grows, so a value read before the lock is a lower
--     bound of the value nextval starts from.
-- Exercised with real concurrency on a disposable PostgreSQL 17 cluster by
-- scripts/ci/probes/hand-number-lock/concurrency.sh, with a planted
-- regression that the same harness catches: see the changelog.
--
-- Law: tests/the-hand-number-lock-is-shared-above-the-floor.law.test.ts.
-- Changelog: docs/changelog/2026-09-26-the-hand-number-lock-is-shared-above-the-floor.md.
--
-- @live-proof: (SELECT md5(prosrc)='a9e82dcab00d2771c88e630dc9f98ae5' AND proacl::text='{postgres=X/postgres}' AND prosecdef AND proconfig::text='{"search_path=pg_catalog, public",lock_timeout=2s}' FROM pg_proc WHERE oid='smarter_private.f06_allocate_number_above(bigint)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $pre$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'smarter_private.f06_allocate_number_above(bigint)'::regprocedure
       AND md5(p.prosrc) = '9d178ff0e10bcfa19b50c6ef1921aec4'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig::text = '{"search_path=pg_catalog, public",lock_timeout=2s}'
       AND p.prosecdef) THEN
    RAISE EXCEPTION 'PREIMAGE: f06_allocate_number_above is not the definition this migration was measured against';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_sequence s
     WHERE s.seqrelid = 'public.global_hand_number_seq'::regclass
       AND s.seqcache = 1 AND s.seqincrement = 1 AND NOT s.seqcycle) THEN
    RAISE EXCEPTION 'PREIMAGE: global_hand_number_seq is not CACHE 1, INCREMENT 1, NO CYCLE';
  END IF;
  -- The proof rests on this function being the sequence's only caller.
  IF EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.prosrc ILIKE '%global_hand_number_seq%'
       AND p.oid <> 'smarter_private.f06_allocate_number_above(bigint)'::regprocedure) THEN
    RAISE EXCEPTION 'PREIMAGE: another routine names global_hand_number_seq';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_attrdef d
     WHERE pg_get_expr(d.adbin, d.adrelid) ILIKE '%global_hand_number_seq%') THEN
    RAISE EXCEPTION 'PREIMAGE: a column default names global_hand_number_seq';
  END IF;
  IF (SELECT relacl::text FROM pg_class WHERE oid = 'public.global_hand_number_seq'::regclass)
     IS DISTINCT FROM '{postgres=rwU/postgres,anon=r/postgres,authenticated=r/postgres,service_role=r/postgres}' THEN
    RAISE EXCEPTION 'PREIMAGE: global_hand_number_seq grants USAGE beyond postgres';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION smarter_private.f06_allocate_number_above(floor_number bigint)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
 SET lock_timeout TO '2s'
AS $function$
DECLARE n bigint; prior bigint; called boolean;
BEGIN
 IF floor_number IS NULL OR floor_number<1000000 OR floor_number>9007199254740991 THEN
 RAISE EXCEPTION 'F06_HAND_NUMBER_UNSAFE' USING ERRCODE='22003'; END IF;
 SELECT last_value,is_called INTO prior,called FROM public.global_hand_number_seq;
 IF prior>=floor_number THEN
   -- Above the floor nextval cannot return below it: setval runs only under
   -- the exclusive lock below and only moves the sequence forward. Shared
   -- holders never wait on one another; the shared lock only excludes setval.
   PERFORM pg_advisory_xact_lock_shared(hashtextextended('f06:global-hand-number-allocation',0));
   IF prior>9007199254740991 OR (prior=9007199254740991 AND called) THEN
   RAISE EXCEPTION 'F06_HAND_NUMBER_UNSAFE' USING ERRCODE='22003'; END IF;
   n:=nextval('public.global_hand_number_seq');
   IF n>9007199254740991 OR n<floor_number THEN
   RAISE EXCEPTION 'F06_HAND_NUMBER_UNSAFE' USING ERRCODE='22003'; END IF;
   RETURN n;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('f06:global-hand-number-allocation',0));
 SELECT last_value,is_called INTO prior,called FROM public.global_hand_number_seq;
 IF prior<floor_number THEN
   -- Real sequence relation barrier also serializes pre-upgrade no-advisory callers.
   -- CACHE 1 is already preimage-guarded; this changes no sequence policy.
   ALTER SEQUENCE public.global_hand_number_seq CACHE 1;
   SELECT last_value,is_called INTO prior,called FROM public.global_hand_number_seq;
 END IF;
 IF prior>9007199254740991 OR (prior=9007199254740991 AND called) THEN
 RAISE EXCEPTION 'F06_HAND_NUMBER_UNSAFE' USING ERRCODE='22003'; END IF;
 n:=nextval('public.global_hand_number_seq');
 IF n>9007199254740991 THEN RAISE EXCEPTION 'F06_HAND_NUMBER_UNSAFE' USING ERRCODE='22003'; END IF;
 IF n<floor_number THEN n:=setval('public.global_hand_number_seq',floor_number,true); END IF;
 RETURN n;
END $function$;

DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'smarter_private.f06_allocate_number_above(bigint)'::regprocedure
       AND md5(p.prosrc) = 'a9e82dcab00d2771c88e630dc9f98ae5'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig::text = '{"search_path=pg_catalog, public",lock_timeout=2s}'
       AND p.prosecdef) THEN
    RAISE EXCEPTION 'POSTIMAGE: f06_allocate_number_above is not the definition this migration installs';
  END IF;
END
$post$;

COMMIT;
