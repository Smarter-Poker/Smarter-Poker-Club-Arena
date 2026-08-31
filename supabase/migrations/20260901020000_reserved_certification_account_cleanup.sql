-- Reserved browser-certification identities deliberately traverse production
-- account triggers and foreign keys. The generic Auth Admin endpoint inherits
-- the short API statement timeout, which can expire while PostgreSQL validates
-- the full account graph even after every feature row has been removed.
--
-- This RPC is intentionally narrow: only service_role may call it, the email
-- must carry the non-deliverable certification marker, and the function proves
-- all three identity surfaces are gone before it reports success.

CREATE OR REPLACE FUNCTION public.cleanup_reserved_certification_account(
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET statement_timeout = '10min'
AS $function$
DECLARE
  v_email text;
BEGIN
  SELECT u.email
    INTO v_email
    FROM auth.users AS u
   WHERE u.id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id)
       OR EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id) THEN
      RAISE EXCEPTION 'cannot verify certification marker for residual identity %', p_user_id
        USING ERRCODE = '42501';
    END IF;
    RETURN jsonb_build_object('success', true, 'already_removed', true);
  END IF;

  IF v_email NOT LIKE 'ca-customization-cert-%@example.invalid' THEN
    RAISE EXCEPTION 'refusing to remove non-certification identity %', p_user_id
      USING ERRCODE = '42501';
  END IF;

  -- profiles.id cascades from auth.users.id. public.users is an intentionally
  -- separate legacy mirror, so remove only its exact reserved identifier too.
  DELETE FROM public.users WHERE id = p_user_id;
  DELETE FROM auth.users WHERE id = p_user_id;

  IF EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id)
     OR EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id)
     OR EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'reserved certification identity % was not fully removed', p_user_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'already_removed', false,
    'user_id', p_user_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.cleanup_reserved_certification_account(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_reserved_certification_account(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.cleanup_reserved_certification_account(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_reserved_certification_account(uuid) TO service_role;

COMMENT ON FUNCTION public.cleanup_reserved_certification_account(uuid) IS
  'Hard-deletes only ca-customization-cert-* reserved E2E identities with a bounded extended FK-validation window.';

-- Rollback:
-- DROP FUNCTION IF EXISTS public.cleanup_reserved_certification_account(uuid);
