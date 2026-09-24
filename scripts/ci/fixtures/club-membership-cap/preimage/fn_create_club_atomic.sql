CREATE OR REPLACE FUNCTION public.fn_create_club_atomic(p_request_id uuid, p_name text, p_description text DEFAULT NULL::text, p_color_theme text DEFAULT 'royal-blue'::text, p_is_public boolean DEFAULT true, p_requires_approval boolean DEFAULT false, p_logo_url text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_result jsonb; v_previous text := COALESCE(current_setting('app.club_membership_source', true), '');
BEGIN
  PERFORM set_config('app.club_membership_source', 'club_owner_create', true);
  BEGIN
    v_result := public.fn_create_club_atomic_membership_impl(
      p_request_id, p_name, p_description, p_color_theme,
      p_is_public, p_requires_approval, p_logo_url
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.club_membership_source', v_previous, true);
    RAISE;
  END;
  PERFORM set_config('app.club_membership_source', v_previous, true);
  RETURN v_result;
END;
$function$
