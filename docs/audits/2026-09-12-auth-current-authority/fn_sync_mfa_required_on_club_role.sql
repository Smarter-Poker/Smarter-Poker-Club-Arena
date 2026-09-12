CREATE OR REPLACE FUNCTION public.fn_sync_mfa_required_on_club_role()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF NEW.role IN ('owner', 'co_owner', 'admin', 'manager', 'agent') THEN
        UPDATE public.profiles
           SET mfa_required = TRUE
         WHERE id = NEW.user_id
           AND mfa_required = FALSE;
    END IF;
    RETURN NEW;
END;
$function$
;
