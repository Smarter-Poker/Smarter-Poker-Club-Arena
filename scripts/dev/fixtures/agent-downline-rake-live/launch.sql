-- Captured production helper definitions,2026-10-30; synthetic boundary table.
CREATE TABLE public.ca_launch_accounting_boundaries(scope_kind text,scope_id uuid,cutoff_at timestamptz,undone_at timestamptz);
CREATE OR REPLACE FUNCTION public.fn_ca_launch_accounting_cutoff(p_kind text, p_id uuid)
 RETURNS timestamp with time zone LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
 SELECT cutoff_at FROM public.ca_launch_accounting_boundaries WHERE scope_kind=p_kind AND scope_id=p_id AND undone_at IS NULL
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_launch_accounting_accepts(p_club_id uuid, p_earned_at timestamp with time zone)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
 SELECT CASE WHEN b.cutoff IS NULL THEN true ELSE p_earned_at IS NOT NULL AND isfinite(p_earned_at) AND p_earned_at>=b.cutoff END
 FROM (SELECT public.fn_ca_launch_accounting_cutoff('club',p_club_id) cutoff)b
$function$;
INSERT INTO public.ca_launch_accounting_boundaries VALUES('club','00000000-0000-4000-8000-000000000001','2026-09-08 00:00Z',NULL);
