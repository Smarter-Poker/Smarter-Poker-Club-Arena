-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").

-- Dan's ruling (2026-09-01): the incident system locks in the flow for the
-- MIDWAY UNION ONLY; fixes land platform-wide. The scope filter implementing
-- that ruling had one over-reach: a raise carrying NO entity dimension at all
-- (the supply-conservation snapshot, suspense watch, guard integrity, cron
-- failure watch, diamond audit, push-deliverability - the platform-substrate
-- alarms the Midway burn-in gate itself consumes) returned false and was
-- silently dropped. A platform alarm IS a Midway alarm: Midway's chips live
-- on that substrate. Club- or union-specific incidents for other clubs stay
-- filtered exactly as ruled.
CREATE OR REPLACE FUNCTION public.fn_ca_is_midway_scope(p_union_id uuid DEFAULT NULL::uuid, p_club_id uuid DEFAULT NULL::uuid, p_table_id uuid DEFAULT NULL::uuid, p_tournament_id uuid DEFAULT NULL::uuid, p_metadata jsonb DEFAULT '{}'::jsonb)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE((
    -- platform-substrate incidents: no entity dimension anywhere = global
    -- checks (supply, suspense, guards, crons, diamonds) that protect every
    -- union including Midway. These always file.
    (p_union_id IS NULL AND p_club_id IS NULL AND p_table_id IS NULL
     AND p_tournament_id IS NULL
     AND COALESCE(p_metadata->>'union_id','') = ''
     AND COALESCE(p_metadata->>'club_id','') = '')
    OR p_union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
    OR p_club_id = 'fade0000-0000-0000-0000-000000000001'::uuid
    OR EXISTS (
      SELECT 1 FROM public.clubs c
       WHERE c.id = p_club_id
         AND c.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
    )
    OR EXISTS (
      SELECT 1 FROM public.union_clubs uc
       WHERE uc.club_id = p_club_id
         AND uc.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
    )
    OR EXISTS (
      SELECT 1 FROM public.tables t
      JOIN public.clubs c ON c.id = t.club_id
       WHERE t.id = p_table_id
         AND (
           c.id = 'fade0000-0000-0000-0000-000000000001'::uuid
           OR c.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
           OR EXISTS (
             SELECT 1 FROM public.union_clubs uc
              WHERE uc.club_id = c.id
                AND uc.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
           )
         )
    )
    OR EXISTS (
      SELECT 1 FROM public.tournaments t
      JOIN public.clubs c ON c.id = t.club_id
       WHERE t.id = p_tournament_id
         AND (
           c.id = 'fade0000-0000-0000-0000-000000000001'::uuid
           OR c.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
           OR EXISTS (
             SELECT 1 FROM public.union_clubs uc
              WHERE uc.club_id = c.id
                AND uc.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
           )
         )
    )
    OR COALESCE(p_metadata->>'union_id', '') = 'fade0000-0000-0000-0000-000000000001'
    OR EXISTS (
      SELECT 1 FROM public.clubs c
       WHERE c.id::text = COALESCE(p_metadata->>'club_id', '')
         AND (
           c.id = 'fade0000-0000-0000-0000-000000000001'::uuid
           OR c.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
           OR EXISTS (
             SELECT 1 FROM public.union_clubs uc
              WHERE uc.club_id = c.id
                AND uc.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
           )
         )
    )), false);
$function$;;

-- Self-contained definer closure (applied in prod as
-- 20260901005515_ca_midway_scope_is_not_anon_callable):
REVOKE ALL ON FUNCTION public.fn_ca_is_midway_scope(uuid, uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_is_midway_scope(uuid, uuid, uuid, uuid, jsonb) TO service_role;
