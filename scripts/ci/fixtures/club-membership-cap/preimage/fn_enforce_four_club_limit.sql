CREATE OR REPLACE FUNCTION public.fn_enforce_four_club_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count int;
BEGIN
  IF NEW.status NOT IN ('active', 'approved') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status IN ('active', 'approved') THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM profiles WHERE id = NEW.user_id AND COALESCE(is_horse, false)
  ) THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_count
    FROM club_members
   WHERE user_id = NEW.user_id
     AND status IN ('active', 'approved')
     AND club_id <> NEW.club_id;

  IF v_count >= 10 THEN
    RAISE EXCEPTION
      'You can only be a member of up to 10 clubs. Leave a club to join a new one.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$
