CREATE OR REPLACE FUNCTION public.fn_ca_deleted_wallet_credit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_club uuid;
BEGIN
 IF TG_TABLE_NAME='profiles' THEN
  -- Only clubs where the person holds free chips have anything to return.
  FOR v_club IN
   SELECT s.club_id FROM (
    SELECT m.club_id FROM public.club_members m WHERE m.user_id=NEW.id
      AND coalesce(m.chip_balance,0)-coalesce(m.held_chips,0)-coalesce(m.locked_chips,0) > 0
    UNION
    SELECT a.club_id FROM public.agents a WHERE a.user_id=NEW.id
      AND coalesce(a.agent_wallet_balance,0) > 0
   ) s ORDER BY s.club_id
  LOOP
   PERFORM public.fn_ca_deleted_wallet_bank_return(v_club,NEW.id,'wallets');
  END LOOP;
  RETURN NEW;
 END IF;
 IF EXISTS (SELECT 1 FROM public.profiles WHERE id=NEW.user_id AND status='deleted') THEN
  PERFORM public.fn_ca_deleted_wallet_bank_return(NEW.club_id,NEW.user_id,CASE WHEN TG_TABLE_NAME='agents' THEN 'agent_wallet' ELSE 'player_wallet' END);
 END IF;
 RETURN NEW;
END;
$function$
