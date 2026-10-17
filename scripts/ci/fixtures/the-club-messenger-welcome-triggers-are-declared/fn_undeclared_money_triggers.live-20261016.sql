CREATE OR REPLACE FUNCTION public.fn_undeclared_money_triggers()
 RETURNS TABLE(table_name text, trigger_name text, function_name text, trigger_def text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT c.relname::text,
         t.tgname::text,
         p.proname::text,
         pg_get_triggerdef(t.oid)
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_proc  p ON p.oid = t.tgfoid
  WHERE NOT t.tgisinternal
    AND c.relnamespace = 'public'::regnamespace
    AND c.relname IN ('table_seats','club_members','club_wallets','union_wallets',
                      'wallets','chip_ledger','tournaments','tournament_players',
                      'ca_settlements')
    AND NOT EXISTS (
      SELECT 1 FROM public.ca_declared_money_triggers d
      WHERE d.table_name = c.relname::text
        AND d.trigger_name = t.tgname::text
    )
  ORDER BY 1, 2
$function$
