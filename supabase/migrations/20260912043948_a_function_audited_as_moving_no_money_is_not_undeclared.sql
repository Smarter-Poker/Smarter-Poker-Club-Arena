-- A function audited as moving no money is not an undeclared money path.
--
-- The undeclared_money_paths ratchet went 85 -> 88 at 14:35 on 2026-09-11 and
-- stayed up for fourteen hourly readings (drift incident
-- 0b22f8b8-f820-41bf-a2a0-d7e682ff630d, "A new money path was added that does
-- not declare its ledger counterparty"). No money path was added. Nothing
-- moved. The detector counts TEXT: a body containing an UPDATE of a watched
-- table ANYWHERE, and a watched column name ANYWHERE. It never checks that the
-- column is what the UPDATE actually sets.
--
-- fn_bbj_set_club_mini_enabled is a club on/off switch for the mini bad beat
-- jackpot. Its UPDATE sets mini_enabled and updated_at. Its INSERT names
-- main_balance, backup_balance and promo_balance in the column list and writes
-- a literal zero to each. Three watched columns named, one UPDATE present,
-- three rows scored, and the function cannot move a chip:
--
--   * the UPDATE branch never reaches the journal - fn_ca_autoledger is bound
--     AFTER INSERT OR UPDATE **OF** those three columns, and this UPDATE sets
--     none of them;
--   * the INSERT branch does reach it and writes nothing - fn_ca_autoledger
--     computes d := round(newv - oldv, 2) and does CONTINUE WHEN d = 0;
--   * the INSERT branch has never run at all - every bbj_pools row predates the
--     function (newest created_at 2026-08-31 23:03:34, function 2026-09-11
--     14:07:13);
--   * no settlement_suspense leg exists since it shipped, which is the exact
--     failure this ratchet is here to catch.
--
-- Its twin fn_bbj_set_union_mini_enabled has identical money semantics and
-- scores zero, purely because it has no INSERT branch naming those columns.
-- That is the tell: the metric was reading prose, not payments.
--
-- An agent audited this function on 2026-09-11 at 16:08 and registered it
-- status='system' in ca_money_rpc_registry - "Moves no money". The ratchet was
-- never wired to that registry, so the platform carried two disagreeing
-- definitions of "money path" and the incident could not clear: every hourly
-- run re-raised a finding that had already been answered, and no amount of
-- auditing would ever have closed it. This teaches the detector to read the
-- audit that already exists.
--
-- The baseline is NOT re-pointed. 85 still means 85: the three rows removed
-- were audited as non-movers, so this is the same basis, not a new one.
-- Measured read-only against production before writing: 88 rows now, 85 with
-- this exemption, and fn_bbj_set_club_mini_enabled is the ONLY status='system'
-- row among the 88 - the other registered ones are 'approved' or 'closed',
-- which are genuine movers and stay counted.

BEGIN;

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

COMMIT;
