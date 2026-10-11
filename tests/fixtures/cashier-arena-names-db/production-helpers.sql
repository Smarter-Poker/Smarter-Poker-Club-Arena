-- Production's own text (pg_get_functiondef, read 2026-10-09) for the three
-- helpers fn_club_trade_ledger and fn_agent_wallet_reversible call, so
-- scripts/ci/test-cashier-arena-names-db-postgres.py runs them unchanged:
--   fn_arena_name                 md5 2b7a84c23987cb7c923dde302f9ea998
--   fn_club_bank_role             md5 36d48c9e935b77e4410075a482194dab
--   fn_club_active_cashier_edges  md5 886a0ff43829825eae68d08cfbb43a9a
CREATE OR REPLACE FUNCTION public.fn_arena_name(p_alias text, p_username text, p_display_name text, p_first_name text, p_last_name text, p_full_name text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH real_name AS (
    SELECT COALESCE(
             NULLIF(btrim(p_full_name), ''),
             NULLIF(btrim(concat_ws(' ',
               NULLIF(btrim(p_first_name), ''),
               NULLIF(btrim(p_last_name),  ''))), '')
           ) AS rn
  )
  SELECT COALESCE(
           NULLIF(btrim(p_alias), ''),
           NULLIF(btrim(p_username), ''),
           CASE
             WHEN NULLIF(btrim(p_display_name), '') IS NOT NULL
              AND (SELECT rn FROM real_name) IS NOT NULL
              AND lower(btrim(p_display_name)) = lower((SELECT rn FROM real_name))
             THEN NULL
             ELSE NULLIF(btrim(p_display_name), '')
           END,
           'Player')
$function$;

CREATE OR REPLACE FUNCTION public.fn_club_bank_role(p_club_id uuid, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN p_club_id IS NULL THEN NULL
    WHEN EXISTS (
      SELECT 1 FROM public.clubs c
       WHERE c.id = p_club_id
         AND c.owner_id = coalesce(p_user_id, auth.uid())
    ) THEN 'owner'
    ELSE (
      SELECT m.role
        FROM public.club_members m
       WHERE m.club_id = p_club_id
         AND m.user_id = coalesce(p_user_id, auth.uid())
         AND public.fn_cashier_member_is_active(m.club_id, m.user_id)
       LIMIT 1
    )
  END
$function$;

CREATE OR REPLACE FUNCTION public.fn_club_active_cashier_edges(p_club uuid)
 RETURNS TABLE(child uuid, parent uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT m.user_id, m.agent_id
    FROM public.club_members m
   WHERE m.club_id = p_club
     AND m.agent_id IS NOT NULL
     AND m.agent_id <> m.user_id
     AND public.fn_cashier_member_is_active(m.club_id, m.user_id)
$function$;
