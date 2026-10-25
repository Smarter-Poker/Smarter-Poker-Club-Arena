-- Version reserved by scripts/reserve-migration-version.sh.
-- @install-window: daily-maintenance
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_horse_exploit_accept_hand()'::regprocedure))='9b948340bb49f657bf369178211140e9') AND (SELECT md5(pg_get_functiondef('public.fn_horse_exploit_mark_hand()'::regprocedure))='c62b42e94bf74e7dafc01ef5735c5050') AND (SELECT md5(pg_get_functiondef('public.fn_horse_exploit_profiles_read(text[],text,text,text)'::regprocedure))='d40ca7e4d52c9c606506e8033966990c') AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.horse_exploit_profiles'::regclass AND conname='horse_exploit_profiles_variant_check' AND convalidated AND pg_get_constraintdef(oid)='CHECK ((variant = ANY (ARRAY[''nlh''::text, ''plo4''::text, ''plo5''::text, ''plo6''::text, ''plo8''::text, ''flh''::text, ''flo8''::text, ''short_deck''::text])))')
-- Exact distinct saved reads for Fixed Limit Hold'em, FLO8 and Short Deck.
-- horse_exploit_profiles is updated by every accepted hand. Replacing its
-- CHECK needs ACCESS EXCLUSIVE, so only the existing daily installer may run
-- this file during certified maintenance. No data backfill, history scan,
-- financial write, new index or background job is introduced.
-- Old engine callers remain compatible; new contexts activate after install.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';

DO $variant_scope$
DECLARE
  old_list constant text := '(''nlh'',''plo4'',''plo5'',''plo6'',''plo8'')';
  new_list constant text := '(''nlh'',''plo4'',''plo5'',''plo6'',''plo8'',''flh'',''flo8'',''short_deck'')';
  item record;
  signature regprocedure;
  before_text text;
  after_text text;
  security_before jsonb;
  actual_constraint text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO actual_constraint
  FROM pg_constraint WHERE conrelid='public.horse_exploit_profiles'::regclass
    AND conname='horse_exploit_profiles_variant_check' AND contype='c' AND convalidated;
  IF actual_constraint IS DISTINCT FROM
    'CHECK ((variant = ANY (ARRAY[''nlh''::text, ''plo4''::text, ''plo5''::text, ''plo6''::text, ''plo8''::text])))' THEN
    RAISE EXCEPTION 'horse opponent variant constraint preimage differs';
  END IF;
  FOR item IN SELECT * FROM (VALUES
    ('public.fn_horse_exploit_accept_hand()', '5172fbcea1784bd7a1e15250fa44e66b', '9b948340bb49f657bf369178211140e9'),
    ('public.fn_horse_exploit_mark_hand()', '90d184a64a626116b4ab23fc7e76dbd4', 'c62b42e94bf74e7dafc01ef5735c5050'),
    ('public.fn_horse_exploit_profiles_read(text[],text,text,text)', '679dac03a786407d5a613692dd5b9eca', 'd40ca7e4d52c9c606506e8033966990c')
  ) expected(name,preimage,postimage) LOOP
    signature := item.name::regprocedure;
    before_text := pg_get_functiondef(signature);
    IF md5(before_text) IS DISTINCT FROM item.preimage
       OR (length(before_text)-length(replace(before_text,old_list,'')))/length(old_list) <> 1 THEN
      RAISE EXCEPTION 'horse opponent variant function preimage differs: %',item.name;
    END IF;
    SELECT jsonb_build_array(proowner,prosecdef,provolatile,proconfig,proacl)
    INTO security_before FROM pg_proc WHERE oid=signature;
    after_text := replace(before_text,old_list,new_list);
    IF md5(after_text) IS DISTINCT FROM item.postimage THEN
      RAISE EXCEPTION 'horse opponent variant derived postimage differs: %',item.name;
    END IF;
    EXECUTE after_text;
    IF md5(pg_get_functiondef(signature)) IS DISTINCT FROM item.postimage
      OR (SELECT jsonb_build_array(proowner,prosecdef,provolatile,proconfig,proacl)
          FROM pg_proc WHERE oid=signature) IS DISTINCT FROM security_before THEN
      RAISE EXCEPTION 'horse opponent variant postimage or security differs: %',item.name;
    END IF;
  END LOOP;
END $variant_scope$;

ALTER TABLE public.horse_exploit_profiles
  DROP CONSTRAINT horse_exploit_profiles_variant_check,
  ADD CONSTRAINT horse_exploit_profiles_variant_check
    CHECK (variant IN ('nlh','plo4','plo5','plo6','plo8','flh','flo8','short_deck'));

COMMIT;
