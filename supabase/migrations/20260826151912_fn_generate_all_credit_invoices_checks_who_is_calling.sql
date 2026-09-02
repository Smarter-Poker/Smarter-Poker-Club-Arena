-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826151912; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- The last of the 17. SECURITY DEFINER, called from the browser at
-- src/services/FinancialCronService.ts:218 on a 6h cadence, and it ran the
-- whole platform's invoice generation for any logged-in caller.
--
-- Allowed: a platform admin, or anyone holding owner/admin/manager in any club.
-- That is who has the portal open when the cadence fires, so weekly generation
-- keeps working; an ordinary player can no longer trigger it.
--
-- ROLLBACK: delete the guard block the RAISE sits in.
DO $do$
DECLARE
  v_def text := pg_get_functiondef('public.fn_generate_all_credit_invoices(timestamptz)'::regprocedure);
  v_anchor text := '  FOR v_agent IN';
  v_guard text;
BEGIN
  IF position(v_anchor in v_def) = 0 THEN
    RAISE EXCEPTION 'anchor not found, refusing to guess';
  END IF;
  IF v_def ILIKE '%Not authorised to generate credit invoices%' THEN
    RAISE NOTICE 'guard already present, nothing to do';
    RETURN;
  END IF;

  v_guard :=
    '  -- AUDIT 2026-08-26: added. Any logged-in caller could run this.' || E'\n' ||
    '  IF auth.uid() IS NOT NULL' || E'\n' ||
    '     AND NOT public.is_admin()' || E'\n' ||
    '     AND NOT EXISTS (SELECT 1 FROM public.club_members me' || E'\n' ||
    '                      WHERE me.user_id = auth.uid()' || E'\n' ||
    '                        AND me.role IN (''owner'',''admin'',''manager''))' || E'\n' ||
    '  THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Not authorised to generate credit invoices'';' || E'\n' ||
    '  END IF;' || E'\n' || E'\n';

  EXECUTE replace(v_def, v_anchor, v_guard || v_anchor);
END
$do$;

DO $check$
DECLARE v_def text;
BEGIN
  v_def := pg_get_functiondef('public.fn_generate_all_credit_invoices(timestamptz)'::regprocedure);
  IF v_def NOT ILIKE '%Not authorised to generate credit invoices%'
  THEN RAISE EXCEPTION 'guard not present after apply'; END IF;
  -- the loop it protects must still be there
  IF v_def NOT ILIKE '%FOR v_agent IN%'
  THEN RAISE EXCEPTION 'the agent loop was lost'; END IF;
END
$check$;
