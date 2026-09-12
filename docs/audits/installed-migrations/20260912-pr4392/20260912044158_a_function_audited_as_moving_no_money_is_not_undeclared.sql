CREATE OR REPLACE FUNCTION public.fn_ca_undeclared_money_paths()
 RETURNS TABLE(proname text, tbl text, col text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH watched AS (
    SELECT c.relname::text AS tbl,
           (regexp_matches(pg_get_triggerdef(t.oid), '''([a-z_]+)=([a-z_]+)''', 'g'))[1] AS col
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc  p ON p.oid = t.tgfoid
     WHERE NOT t.tgisinternal AND p.proname = 'fn_ca_autoledger'
  ), fns AS (
    SELECT p.proname::text AS proname, p.prosrc,
           (p.prosrc ILIKE '%fn_ca_declare_ledger%'
            OR p.prosrc ILIKE '%app.ledger_counterparty%') AS declares
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
  )
  SELECT DISTINCT f.proname, w.tbl, w.col
    FROM fns f
    JOIN watched w
      ON f.prosrc ~* ('UPDATE\s+(public\.)?' || w.tbl || '\y')
     AND f.prosrc ~* ('\y' || w.col || '\y')
   WHERE NOT f.declares
     AND f.proname NOT IN ('fn_ca_autoledger', 'fn_ca_autoledger_delete',
                           'fn_ca_declare_ledger', 'fn_ca_undeclared_money_paths')
     -- 2026-09-12: a function AUDITED AS MOVING NO MONEY is not an undeclared
     -- money path. status='system' IS that audit, written into
     -- ca_money_rpc_registry by the ab_ca_money_rpc_registered event trigger
     -- before the function is allowed to exist.
     AND NOT EXISTS (SELECT 1 FROM public.ca_money_rpc_registry g
                      WHERE g.proname = f.proname AND g.status = 'system')
   ORDER BY 1, 2, 3
$function$;

COMMENT ON FUNCTION public.fn_ca_undeclared_money_paths() IS
 'Functions that move a balance fn_ca_autoledger watches without declaring the other side, so their movements land on settlement_suspense. TEXTUAL: it matches an UPDATE of a watched table anywhere in the body and a watched column anywhere in the body, so a function that only NAMES a balance column (an INSERT column list, a guard, a comment) scores without moving anything. A function registered status=''system'' in ca_money_rpc_registry has been audited as moving no money and is excluded. The count must only ever go down.';

DO $assert$
DECLARE v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.fn_ca_undeclared_money_paths();
  IF v_count <> 85 THEN
    RAISE EXCEPTION 'undeclared_money_paths is % after the exemption, expected 85 - the board moved, re-measure before committing', v_count;
  END IF;
END $assert$;