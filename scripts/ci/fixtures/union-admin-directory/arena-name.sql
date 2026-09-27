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
$function$
