CREATE OR REPLACE FUNCTION public.fn_effective_rake_config(p_table_id uuid)
 RETURNS TABLE(table_id uuid, club_name text, source text, effective_percent numeric, effective_cap_bb numeric, note text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT t.id,
         c.name,
         CASE
           WHEN t.rake_percent IS NOT NULL AND t.rake_percent >= 0 THEN 'table override'
           WHEN c.default_rake_percent IS NOT NULL AND c.default_rake_percent >= 0 THEN 'club default'
           ELSE 'engine schedule (RakeConfig.ts)'
         END,
         CASE
           WHEN t.rake_percent IS NOT NULL AND t.rake_percent >= 0 THEN t.rake_percent
           WHEN c.default_rake_percent IS NOT NULL AND c.default_rake_percent >= 0 THEN c.default_rake_percent
           ELSE 10::numeric   -- RAKE_SCHEDULE is 10% at every stake
         END,
         CASE
           WHEN t.rake_cap_bb IS NOT NULL AND t.rake_cap_bb >= 0 THEN t.rake_cap_bb
           WHEN c.rake_cap IS NOT NULL AND c.rake_cap >= 0 THEN c.rake_cap
           ELSE NULL          -- schedule cap is per-stake, in dollars, not BB
         END,
         CASE
           WHEN (t.rake_percent IS NULL OR t.rake_percent < 0)
            AND (c.default_rake_percent IS NULL OR c.default_rake_percent < 0)
           THEN 'Falling through to the hardcoded 10% schedule. clubs.rake_percent='
                || coalesce(c.rake_percent::text,'null')
                || ' is a LEGACY column and is NOT what is being charged.'
           ELSE 'Configured.'
         END
  FROM public.tables t
  LEFT JOIN public.clubs c ON c.id = t.club_id
  WHERE t.id = p_table_id;
$function$
