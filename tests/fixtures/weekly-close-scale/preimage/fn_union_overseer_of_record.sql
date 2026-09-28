CREATE OR REPLACE FUNCTION public.fn_union_overseer_of_record(p_union_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_union_id IS NOT NULL AND p_user_id IS NOT NULL AND (
       EXISTS (SELECT 1 FROM public.unions u WHERE u.id = p_union_id AND u.owner_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.union_admins a WHERE a.union_id = p_union_id AND a.user_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.clubs c
                WHERE c.id = p_union_id AND COALESCE(c.is_union, false) AND c.owner_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.club_members m
                WHERE m.club_id = p_union_id AND m.user_id = p_user_id
                  AND m.role IN ('owner','co_owner','admin')
                  AND m.status IN ('active','approved'))
  );
$function$
