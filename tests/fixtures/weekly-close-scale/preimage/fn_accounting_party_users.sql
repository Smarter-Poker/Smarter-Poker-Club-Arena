CREATE OR REPLACE FUNCTION public.fn_accounting_party_users(p_kind text, p_id uuid)
 RETURNS TABLE(user_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 WITH party AS (
  SELECT DISTINCT p.id FROM public.profiles p WHERE p.id IN (
   SELECT p_id WHERE p_kind IN('agent','player')
   UNION SELECT c.owner_id FROM public.clubs c WHERE p_kind='club' AND c.id=p_id
   UNION SELECT m.user_id FROM public.club_members m WHERE p_kind='club' AND m.club_id=p_id
    AND m.role IN('owner','co_owner','admin') AND COALESCE(m.status,'active') IN('active','approved')
   UNION SELECT u.owner_id FROM public.unions u WHERE p_kind='union' AND u.id=p_id
   UNION SELECT a.user_id FROM public.union_admins a WHERE p_kind='union' AND a.union_id=p_id
    AND public.fn_union_overseer_of_record(p_id,a.user_id)
  )
 )
 SELECT party.id FROM party
 WHERE public.fn_caller_is_engine()
    OR EXISTS(SELECT 1 FROM party self WHERE self.id = auth.uid());
$function$
