/*
 * Closing-position captures are reset evidence, not player APIs.
 *
 * The source migration revoked PUBLIC after creating these SECURITY DEFINER
 * functions, but this project's default function privileges grant EXECUTE to
 * anon and authenticated directly.  Revoking PUBLIC cannot remove an explicit
 * role grant.  Worse, the body tried to distinguish callers with current_user;
 * inside SECURITY DEFINER that is the postgres owner for every caller.
 *
 * Repair both layers.  The explicit role revokes close PostgREST, and the body
 * now accepts only a verified service-role claim or, when there is no request
 * claim at all, a direct postgres/admin session.  A supplied claim takes
 * precedence over session_user so rollback probes cannot accidentally exercise
 * an operator bypass.  The asserted substitution avoids retyping capture logic.
 *
 * This migration sorts after the two closing-position source migrations.  It
 * may land on a branch before those source files do, so an entirely absent pair
 * is a safe replay no-op.  A partial pair is always corruption and aborts.
 */

DO $hardening$
DECLARE
  v_capture regprocedure := to_regprocedure(
    'public.fn_ca_capture_closing_position(text,boolean)'
  );
  v_summary regprocedure := to_regprocedure(
    'public.fn_ca_closing_position_summary(uuid)'
  );
  v_target regprocedure;
  v_definition text;
  v_hits integer;
  v_old_guard constant text :=
    'IF NOT (current_user IN (''postgres'', ''service_role'')) THEN';
  v_new_guard constant text :=
    'IF COALESCE(NULLIF(auth.role(), ''''), session_user) NOT IN (''service_role'', ''postgres'', ''supabase_admin'') THEN';
BEGIN
  IF v_capture IS NULL AND v_summary IS NULL THEN
    RAISE NOTICE
      'closing-position RPCs are not present; ordered replay will harden them after their source migration';
    RETURN;
  END IF;

  IF v_capture IS NULL OR v_summary IS NULL THEN
    RAISE EXCEPTION
      'closing-position RPC set is partial (capture %, summary %); refusing an incomplete authority repair',
      v_capture IS NOT NULL,
      v_summary IS NOT NULL;
  END IF;

  FOREACH v_target IN ARRAY ARRAY[v_capture, v_summary]
  LOOP
    SELECT pg_get_functiondef(v_target::oid) INTO v_definition;

    IF position(v_new_guard IN v_definition) > 0 THEN
      IF position(v_old_guard IN v_definition) > 0 THEN
        RAISE EXCEPTION
          '% contains both the retired and hardened authority guards', v_target;
      END IF;
    ELSE
      v_hits :=
        (length(v_definition) - length(replace(v_definition, v_old_guard, '')))
        / length(v_old_guard);

      IF v_hits <> 1 THEN
        RAISE EXCEPTION
          'expected exactly one insecure current_user guard in %, found %; re-read the live definition before changing it',
          v_target,
          v_hits;
      END IF;

      EXECUTE replace(v_definition, v_old_guard, v_new_guard);
    END IF;
  END LOOP;

  REVOKE ALL ON FUNCTION public.fn_ca_capture_closing_position(text, boolean)
    FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.fn_ca_closing_position_summary(uuid)
    FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.fn_ca_capture_closing_position(text, boolean)
    TO service_role;
  GRANT EXECUTE ON FUNCTION public.fn_ca_closing_position_summary(uuid)
    TO service_role;

  FOREACH v_target IN ARRAY ARRAY[v_capture, v_summary]
  LOOP
    IF has_function_privilege('anon', v_target, 'EXECUTE')
       OR has_function_privilege('authenticated', v_target, 'EXECUTE') THEN
      RAISE EXCEPTION '% remains executable from a browser role', v_target;
    END IF;

    IF NOT has_function_privilege('service_role', v_target, 'EXECUTE') THEN
      RAISE EXCEPTION '% is no longer executable by service_role', v_target;
    END IF;

    SELECT pg_get_functiondef(v_target::oid) INTO v_definition;
    IF position(v_new_guard IN v_definition) = 0
       OR position(v_old_guard IN v_definition) > 0 THEN
      RAISE EXCEPTION '% did not retain the hardened authority guard', v_target;
    END IF;
  END LOOP;
END
$hardening$;
