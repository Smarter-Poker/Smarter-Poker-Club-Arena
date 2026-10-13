CREATE OR REPLACE FUNCTION public.fn_ca_money_rpc_balance_columns()
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT array_agg(DISTINCT c)
    FROM (
      SELECT (regexp_matches(pg_get_triggerdef(t.oid), '''([a-z_]+)=([a-z_]+)''', 'g'))[1] AS c
        FROM pg_trigger t
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE NOT t.tgisinternal AND p.proname IN ('fn_ca_autoledger','fn_ca_autoledger_delete')
      UNION
      SELECT unnest(ARRAY['chip_balance','held_chips','locked_chips','credit_used',
                          'stack','balance','chips','prize','bounty_winnings'])
    ) s;
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_money_rpc_writes_balances(p_src text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(
    p_src ~* 'UPDATE\s+(public\.)?(club_members|club_wallets|union_wallets|unions|table_seats|bbj_pools|clubs|agents|wallets|spin_bonus_pools|tournament_players)\y'
    OR p_src ~* 'INSERT\s+INTO\s+(public\.)?(club_members|club_wallets|union_wallets|unions|bbj_pools|clubs|agents|wallets|spin_bonus_pools)\y', false)
  AND COALESCE(p_src ~* ('\y(' || array_to_string(public.fn_ca_money_rpc_balance_columns(), '|') || ')\y'), false);
$function$;
DO $w$ BEGIN IF NOT EXISTS(SELECT FROM pg_event_trigger WHERE evtname='ab_ca_money_rpc_registered') THEN CREATE EVENT TRIGGER ab_ca_money_rpc_registered ON ddl_command_end WHEN TAG IN ('CREATE FUNCTION') EXECUTE FUNCTION public.fn_ca_money_rpc_registry_guard();END IF;IF NOT EXISTS(SELECT FROM pg_event_trigger WHERE evtname='ab_ca_money_rpc_registered' AND evtfoid='public.fn_ca_money_rpc_registry_guard()'::regprocedure AND evtevent='ddl_command_end' AND evtenabled='O' AND evttags=ARRAY['CREATE FUNCTION']) THEN RAISE EXCEPTION 'ACTUAL_NATIVE_MONEY_CREATION_WIRING_MISMATCH';END IF;END $w$;
