CREATE OR REPLACE FUNCTION public.fn_is_union_overseer(p_union_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_user_id IS NOT NULL
     AND (public.fn_caller_is_engine() OR auth.uid() IS NOT DISTINCT FROM p_user_id)
     AND public.fn_union_overseer_of_record(p_union_id, p_user_id);
$function$
