-- public.fn_seat_late_registrant exactly as installed on production
-- (kuklfnapbkmacvwxktbh), read with pg_get_functiondef on 2026-09-26 02:25 UTC.
-- md5(prosrc) = 28b68b7f0fac74c76d6fc11bdac3f972. This is the re-declaration
-- (added SET statement_timeout, unchanged body) that refused the first install
-- of 20260925205909. It is the function that migration CALLS, so the preimage
-- guard is qualified against these exact catalog facts: its argument NAMES are
-- part of pg_get_function_identity_arguments and its argument TYPES are not.
CREATE OR REPLACE FUNCTION public.fn_seat_late_registrant(p_tournament_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_gate jsonb;
BEGIN
  v_gate:=public.fn_ca_lock_tournament_seat_acquisition(
    p_tournament_id,NULL,p_user_id);
  IF COALESCE((v_gate->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_gate;
  END IF;
  RETURN public.fn_seat_late_registrant_before_terminal_seat_gate(
    p_tournament_id,p_user_id);
END;
$function$;
