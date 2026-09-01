-- THE EM DASH BAN HOLDS THE LINE
--
-- 20260831202752 rewrote 120 public functions and left
-- fn_ca_banned_copy_characters() behind to watch for regressions. Within the
-- hour it caught four, landed by migrations applied after it:
--
--   fn_ca_burnin_gate_tick             "...zero blocked attempts - the engine exit path is confirmed fixed."
--   fn_ca_incident_notify              "More financial activity - see dashboard"   (a push notification body)
--   fn_ca_incident_recipient_ids       a comment
--   fn_ca_settlement_correctness_check "...after adoption - the engine has regressed..."
--
-- That is the gate working, not the gate failing: a cleanup nothing watches is
-- a cleanup that gets undone, and this is the proof it would have been. Same
-- translate, same safety checks, idempotent.
--
-- NOTE for whoever reads this next: fn_ca_incident_notify's body also carries
-- an EMOJI, which design-guidelines.md rule 1 bans outright and which
-- scripts/ci/check-no-emoji.mjs enforces on source it can see. It cannot see
-- this. That is the same blind spot in a second costume and it is recorded,
-- not fixed here, because removing it changes the copy rather than a character.

SET LOCAL statement_timeout = '600s';
SET LOCAL lock_timeout = '15s';

DO $rewrite$
DECLARE
  r record; v_def text; v_new text; v_ok int := 0; v_fail int := 0; v_errs text := ''; v_left int;
BEGIN
  SELECT count(*) INTO v_left
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
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
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.prosrc ~ '[‒–—―]'
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

DO $verify$
DECLARE v_left int;
BEGIN
  SELECT count(*) INTO v_left FROM public.fn_ca_banned_copy_characters();
  IF v_left > 0 THEN
    RAISE EXCEPTION 'em dash ban: % line(s) survived the rewrite', v_left;
  END IF;
END
$verify$;