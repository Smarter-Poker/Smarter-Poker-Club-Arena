-- THE EM DASH BAN REACHES THE DATABASE
-- Dan 2026-08-20: "forbid the use of em bars anywhere."
-- "em bars" means EM DASHES, the punctuation mark: a rule about the
-- characters in copy, NOT about artwork or icons. Misread as a ban on
-- horizontal bars twice (#2321, #2429); it cost the hamburger menu.
-- Dan 2026-08-31: "remove any and all m bars as they are banned from use."
--
-- Two gates already enforce this and BOTH of them read SOURCE:
-- scripts/ci/check-ui-text.mjs walks src/, public/, index.html and server/src,
-- and houseCopyRulesReachEveryPage.test.ts runs it against fixtures. Neither
-- can see a single character of the copy this DATABASE serves. A function that
-- RAISEs a message, or builds a jsonb {'message': ...}, hands that text
-- straight to the client, which toasts it verbatim. So both gates reported OK
-- while production said, to a player's face: "Username must be 3-20
-- characters" (en dash), "Your profile row is missing - refresh and try
-- again.", "No live seat for this % - refusing to charge", "Cashout cancelled
-- - chips returned", "Referral reward - new player joined with your code",
-- and 115 more. Same shape as the Phase 3 insurance finding: every gate green,
-- and the thing the gate exists to prevent live in production, because the
-- gate was pointed at the source and the product was reading the database.
--
-- Rewrites every public function carrying one of the four dash characters via
-- its own pg_get_functiondef, translating them to a plain hyphen. Same
-- signature, same body, same OID: CREATE OR REPLACE, so every trigger, grant
-- and dependency survives. A dash inside a regex character class WOULD change
-- meaning - [--] is a valid meaningless range, which is how a --fix run once
-- disabled check-ui-text's own stripper - so that case is checked first and
-- the migration refuses to run if any exists. It found none. The whole rewrite
-- was then run inside a transaction and ROLLED BACK first: 120 rewritten, 0
-- failed, 0 left. Idempotent.
--
-- NOT DONE HERE, DELIBERATELY: these messages are also not Title Cased. Title
-- casing changes WORDS, and several carry identifiers (atomic_table_buyin,
-- splitBuyIn) and format placeholders a blind transform would mangle.
-- check-title-case.mjs is AST-aware for exactly that reason; the database copy
-- needs the same care and gets its own pass.

SET LOCAL statement_timeout = '600s';
SET LOCAL lock_timeout = '15s';

DO $rewrite$
DECLARE
  r      record;
  v_def  text;
  v_new  text;
  v_ok   int  := 0;
  v_fail int  := 0;
  v_errs text := '';
  v_left int;
BEGIN
  SELECT count(*) INTO v_left
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname <> 'fn_ca_banned_copy_characters'
    AND p.prosrc ~ '\[[^]]*[‒–—―][^]]*\]';
  IF v_left > 0 THEN
    RAISE EXCEPTION
      'refusing to translate: % function(s) hold a dash inside a bracket expression; rewrite those by hand first',
      v_left;
  END IF;

  FOR r IN
    SELECT p.oid, p.oid::regprocedure::text AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND p.prosrc ~ '[‒–—―]'
      -- The checker created below HOLDS these characters on purpose. On a
      -- re-run the loop would translate its character class into a valid,
      -- meaningless range and silently disable the gate.
      AND p.proname <> 'fn_ca_banned_copy_characters'
    ORDER BY p.proname
  LOOP
    BEGIN
      v_def := pg_get_functiondef(r.oid);
      v_new := translate(v_def, '‒–—―', '----');
      CONTINUE WHEN v_new = v_def;
      EXECUTE v_new;
      v_ok := v_ok + 1;
    EXCEPTION WHEN others THEN
      v_fail := v_fail + 1;
      v_errs := v_errs || E'\n  ' || r.sig || ' :: ' || sqlerrm;
    END;
  END LOOP;

  RAISE NOTICE 'em dash ban: % function(s) rewritten, % failed', v_ok, v_fail;
  IF v_fail > 0 THEN
    RAISE EXCEPTION 'em dash ban: % function(s) could not be rewritten:%', v_fail, v_errs;
  END IF;
END
$rewrite$;

-- The database's own copy of check-ui-text: it answers for the surface the
-- source gates cannot reach. scripts/ci/check-db-copy.mjs fails CI on anything
-- it returns.
CREATE OR REPLACE FUNCTION public.fn_ca_banned_copy_characters()
RETURNS TABLE (
  kind        text,
  object_name text,
  detail      text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
  SELECT
    'function'::text,
    p.oid::regprocedure::text,
    left(trim(l), 200)
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN LATERAL unnest(string_to_array(p.prosrc, E'\n')) AS l
  WHERE n.nspname = 'public'
    AND p.prokind = 'f'
    AND l ~ '[‒–—―]'
    -- The checker is allowed to hold the characters it checks for. Same
    -- exemption check-ui-text.mjs keeps for titleCase.ts and popupStyle.ts,
    -- and for the same reason: without this line the function reports ITSELF
    -- forever and the gate can never pass.
    AND p.proname <> 'fn_ca_banned_copy_characters'
  ORDER BY 2, 3;
$fn$;

COMMENT ON FUNCTION public.fn_ca_banned_copy_characters() IS
  'Every line of every public function that still carries a dash character Dan banned on 2026-08-20. Empty is the only passing result. Read by scripts/ci/check-db-copy.mjs.';

REVOKE ALL ON FUNCTION public.fn_ca_banned_copy_characters() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_banned_copy_characters() TO service_role;

DO $verify$
DECLARE v_left int;
BEGIN
  SELECT count(*) INTO v_left FROM public.fn_ca_banned_copy_characters();
  IF v_left > 0 THEN
    RAISE EXCEPTION 'em dash ban: % line(s) survived the rewrite', v_left;
  END IF;
END
$verify$;