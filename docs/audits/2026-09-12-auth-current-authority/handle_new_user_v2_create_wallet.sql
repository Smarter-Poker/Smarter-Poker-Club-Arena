CREATE OR REPLACE FUNCTION public.handle_new_user_v2_create_wallet()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.wallets (user_id, wallet_type, balance, locked_balance)
  VALUES (NEW.id, 'PLAYER', 0, 0)
  ON CONFLICT (user_id, wallet_type) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  BEGIN
    INSERT INTO public.signup_errors (user_id, email, trigger_name, error_code, error_msg)
    VALUES (NEW.id, NEW.email, 'handle_new_user_v2_create_wallet', SQLSTATE, SQLERRM);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END;
$function$
;
