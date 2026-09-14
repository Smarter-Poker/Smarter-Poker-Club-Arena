CREATE OR REPLACE FUNCTION public.fn_sync_mfa_required_on_role_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF (NEW.role = 'admin' OR NEW.is_vip = TRUE) AND NOT NEW.mfa_required THEN
        -- Only force the login challenge if the user can actually pass it.
        IF EXISTS (
            SELECT 1 FROM public.user_mfa_factors
            WHERE user_id = NEW.id AND enabled = TRUE
        ) THEN
            NEW.mfa_required := TRUE;
        END IF;
    END IF;
    RETURN NEW;
END;
$function$
;
