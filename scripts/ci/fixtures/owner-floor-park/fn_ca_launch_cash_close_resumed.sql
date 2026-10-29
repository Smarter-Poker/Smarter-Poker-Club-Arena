CREATE OR REPLACE FUNCTION public.fn_ca_launch_cash_close_resumed(p_table uuid, p_close uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT EXISTS(SELECT 1 FROM public.ca_launch_floor_resume_receipts r
 JOIN public.ca_operator_table_closes c ON c.table_id=r.table_id AND c.operation_id=r.close_operation_id AND c.actor_id=r.actor_id AND c.status='closed'
 JOIN public.ca_engine_operator_commands done ON done.id=r.resume_operation_id AND done.actor_id=r.actor_id AND done.domain='floor' AND done.action='resume'
 JOIN public.ca_launch_operator_scopes park ON park.operation_id=r.park_operation_id AND park.actor_id=r.actor_id
 JOIN public.ca_launch_operator_scopes resume ON resume.operation_id=r.resume_operation_id AND resume.actor_id=r.actor_id AND resume.club_ids=park.club_ids
 JOIN public.tables t ON t.id=r.table_id AND t.tournament_id IS NULL AND (t.club_id=ANY(park.club_ids) OR t.union_id=ANY(park.club_ids))
 WHERE r.table_id=p_table AND r.close_operation_id=p_close);
$function$
