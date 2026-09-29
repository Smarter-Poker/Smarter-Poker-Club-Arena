-- Generated profile referral codes must be unique under their existing exact
-- lookup semantics. Preserve all existing codes and caller-supplied values.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
LOCK TABLE public.profiles IN SHARE ROW EXCLUSIVE MODE;
DO $preflight$
BEGIN
 IF md5(pg_get_functiondef('public.generate_referral_code()'::regprocedure))
    NOT IN ('0abb45b7a66bbb9b944e83ace1babae9','3ac2d5529de95863764ddca919ddfda3')
 OR NOT EXISTS (
  SELECT 1 FROM pg_proc WHERE oid='public.generate_referral_code()'::regprocedure
   AND pg_get_userbyid(proowner)='postgres' AND NOT prosecdef
   AND proconfig=ARRAY['search_path=public']
   AND proacl::text='{postgres=X/postgres,service_role=X/postgres}'
 ) OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal
       AND tgfoid='public.generate_referral_code()'::regprocedure) <> 1
 OR NOT EXISTS (
  SELECT 1 FROM pg_trigger WHERE tgrelid='public.profiles'::regclass
   AND tgname='tr_generate_referral_code' AND tgenabled='O'
   AND tgfoid='public.generate_referral_code()'::regprocedure
   AND tgtype=7 AND tgnargs=0 AND tgqual IS NULL
 ) THEN
  RAISE EXCEPTION 'Profile referral generator predecessor, authority or binding changed';
 END IF;
 IF EXISTS (SELECT referral_code FROM public.profiles WHERE referral_code IS NOT NULL
            GROUP BY referral_code HAVING count(*)>1) THEN
  RAISE EXCEPTION 'Existing duplicate profile referral codes require individual investigation';
 END IF;
 IF pg_get_indexdef('public.idx_profiles_referral_code'::regclass) NOT IN (
  'CREATE INDEX idx_profiles_referral_code ON public.profiles USING btree (referral_code) WHERE (referral_code IS NOT NULL)',
  'CREATE UNIQUE INDEX idx_profiles_referral_code ON public.profiles USING btree (referral_code) WHERE (referral_code IS NOT NULL)'
 ) THEN
  RAISE EXCEPTION 'Profile referral code index changed';
 END IF;
END $preflight$;
CREATE OR REPLACE FUNCTION public.generate_referral_code()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
    new_code VARCHAR(20);
    attempt integer;
BEGIN
    IF NEW.referral_code IS NOT NULL THEN
        RETURN NEW;
    END IF;
    FOR attempt IN 1..128 LOOP
        -- Compare the same representation that is stored and looked up by clients.
        new_code := UPPER('SP-' || SUBSTRING(MD5(RANDOM()::TEXT), 1, 6));
        IF EXISTS (SELECT 1 FROM public.profiles WHERE referral_code = new_code) THEN
            CONTINUE;
        END IF;
        -- An uncommitted generator owns this candidate. Skip it without waiting
        -- or accumulating a lock-order dependency between multi-row inserts.
        IF NOT pg_catalog.pg_try_advisory_xact_lock(
            pg_catalog.hashtextextended('profiles:referral-code:v1:' || new_code, 0)
        ) THEN
            CONTINUE;
        END IF;
        -- A previous owner may have committed between the first read and our lock.
        IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE referral_code = new_code) THEN
            NEW.referral_code := new_code;
            RETURN NEW;
        END IF;
    END LOOP;
    RAISE EXCEPTION USING ERRCODE = '54000',
        MESSAGE = 'Referral code generation exhausted its collision budget';
END;
$function$;

-- Covers explicit inserts and updates as well as generated codes. Conflicts
-- abort their transaction; this migration never rewrites an existing profile.
DROP INDEX public.idx_profiles_referral_code;
CREATE UNIQUE INDEX idx_profiles_referral_code ON public.profiles(referral_code)
 WHERE referral_code IS NOT NULL;
DO $postflight$
BEGIN
 IF md5(pg_get_functiondef('public.generate_referral_code()'::regprocedure)) <> '3ac2d5529de95863764ddca919ddfda3'
 OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.generate_referral_code()'::regprocedure
  AND pg_get_userbyid(proowner)='postgres' AND NOT prosecdef
  AND proconfig=ARRAY['search_path=public']
  AND proacl::text='{postgres=X/postgres,service_role=X/postgres}')
 OR NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid='public.idx_profiles_referral_code'::regclass
                AND indisunique AND indisvalid AND indisready) THEN
  RAISE EXCEPTION 'Profile referral generator postimage or index mismatch';
 END IF;
END $postflight$;
COMMIT;
