CREATE OR REPLACE FUNCTION public.fn_club_owner_has_a_player_wallet()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_previous text := COALESCE(current_setting('app.club_membership_source', true), '');
BEGIN
  -- THE ARENA BELONGS TO THE SYSTEM (2026-09-30): only a chip club gives its
  -- owner a player wallet. Diamond participation is automatic and holds no
  -- wallet (the arena's membership guard refuses any other row), so for the
  -- Diamond Arena this trigger would refuse every change of owner at commit.
  IF NEW.owner_id IS NULL OR COALESCE(NEW.is_union, false) OR NEW.asset IS DISTINCT FROM 'chips' THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND OLD.owner_id IS NOT DISTINCT FROM NEW.owner_id THEN
    RETURN NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM public.club_members cm
              WHERE cm.club_id = NEW.id AND cm.user_id = NEW.owner_id) THEN
    UPDATE public.club_members
       SET status = CASE WHEN COALESCE(status, 'active') IN ('active', 'approved') THEN status ELSE 'active' END,
           role   = CASE WHEN role IN ('owner', 'co_owner') THEN role ELSE 'owner' END,
           updated_at = now()
     WHERE club_id = NEW.id AND user_id = NEW.owner_id
       AND (COALESCE(status, 'active') NOT IN ('active', 'approved') OR role NOT IN ('owner', 'co_owner'));
    RETURN NULL;
  END IF;

  PERFORM set_config('app.club_membership_source', 'club_owner_create', true);
  PERFORM set_config('app.club_role_change', 'on', true);
  BEGIN
    INSERT INTO public.club_members (club_id, user_id, role, status, chip_balance)
    VALUES (NEW.id, NEW.owner_id, 'owner', 'active', 0)
    ON CONFLICT (club_id, user_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.club_membership_source', v_previous, true);
    RAISE;
  END;
  PERFORM set_config('app.club_membership_source', v_previous, true);
  RETURN NULL;
END;
$function$
;
