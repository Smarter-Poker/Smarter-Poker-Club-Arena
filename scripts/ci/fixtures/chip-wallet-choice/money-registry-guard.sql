-- Captured from production 2026-10-16 after installer 38848842683 refused
-- an unregistered new writer. Load after the original function fixtures.
CREATE TABLE public.ca_money_rpc_registry(proname text PRIMARY KEY,status text NOT NULL DEFAULT 'approved',notes text,added_at timestamptz NOT NULL DEFAULT now());
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
('fn_agent_wallet_claim_back_phase2_core_20260831','approved','grandfathered at phase-1 baseline (2026-08-31 audit)'),
('fn_agent_wallet_send_core_20260830','approved','grandfathered at phase-1 baseline (2026-08-31 audit)'),
('fn_club_bank_send','approved','grandfathered at phase-1 baseline (2026-08-31 audit)'),
('fn_club_bank_send_core_20261004','approved','private retained Club Bank send core behind exact-intent wrapper'),
('fn_promo_wallet_send_core_20261004','approved','private retained agent promo core behind exact-intent wrapper'),
('fn_club_promo_send_core_20261004','approved','private retained club promo core behind exact-intent wrapper');
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
$function$
;
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
$function$
;
CREATE OR REPLACE FUNCTION public.fn_ca_money_rpc_registry_guard()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  obj record;
  v_name text;
  v_src  text;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
  LOOP
    IF obj.object_type <> 'function' OR obj.schema_name IS DISTINCT FROM 'public' THEN
      CONTINUE;
    END IF;

    SELECT p.proname, p.prosrc INTO v_name, v_src
      FROM pg_proc p WHERE p.oid = obj.objid AND p.prokind = 'f';
    IF v_name IS NULL THEN
      CONTINUE;
    END IF;

    IF NOT public.fn_ca_money_rpc_writes_balances(v_src) THEN
      CONTINUE;
    END IF;

    IF EXISTS (SELECT 1 FROM public.ca_money_rpc_registry g WHERE g.proname = v_name) THEN
      CONTINUE;
    END IF;

    RAISE EXCEPTION
      'REFUSED: % writes balance columns and is not in ca_money_rpc_registry', v_name
      USING ERRCODE = '42501',
            DETAIL  = 'A function that can move money is registered before it exists, not after. '
                   || 'This is the guard for the seven drift incidents of 2026-09-11.',
            HINT    = 'Put the registry row ABOVE the CREATE FUNCTION in this same migration: '
                   || 'INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES ('
                   || quote_literal(v_name)
                   || ', ''approved'', ''what it moves, what gates it, how it is journaled'');  '
                   || 'Use status ''system'' if it moves no money and only reads or locks.';
  END LOOP;
END;
$function$
;
CREATE EVENT TRIGGER ab_ca_money_rpc_registered ON ddl_command_end WHEN TAG IN ('CREATE FUNCTION') EXECUTE FUNCTION public.fn_ca_money_rpc_registry_guard();

