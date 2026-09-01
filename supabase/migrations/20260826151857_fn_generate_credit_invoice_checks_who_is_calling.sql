-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826151857; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Same shape as fn_apply_credit_payment: SECURITY DEFINER, called from the
-- browser at src/services/CreditService.ts:374, no caller check. The comment at
-- that call site reads "Service-role RPC - credit_invoices is
-- service-role-write-only under RLS". The RLS half is true; the function is
-- SECURITY DEFINER, so it bypassed that RLS for whoever called it, and it was
-- called from a browser.
--
-- Allowed: the agent themselves, a platform admin, or an owner/admin/manager
-- sharing a club with them. fn_generate_all_credit_invoices calls this in a
-- loop -- auth.uid() survives a SECURITY DEFINER call, so an admin running the
-- sweep satisfies this for every agent.
--
-- ROLLBACK: delete the guard block the RAISE sits in.
DO $do$
DECLARE
  v_def text := pg_get_functiondef(
    'public.fn_generate_credit_invoice(uuid,timestamptz,timestamptz,numeric,timestamptz)'::regprocedure);
  v_anchor text := '  IF p_agent_id IS NULL OR p_debt_owed IS NULL OR p_debt_owed <= 0 THEN';
  v_guard text;
BEGIN
  IF position(v_anchor in v_def) = 0 THEN
    RAISE EXCEPTION 'anchor not found, refusing to guess';
  END IF;
  IF v_def ILIKE '%Not authorised to generate an invoice%' THEN
    RAISE NOTICE 'guard already present, nothing to do';
    RETURN;
  END IF;

  v_guard :=
    '  -- AUDIT 2026-08-26: added. This function had no caller check at all.' || E'\n' ||
    '  IF auth.uid() IS NOT NULL' || E'\n' ||
    '     AND auth.uid() <> p_agent_id' || E'\n' ||
    '     AND NOT public.is_admin()' || E'\n' ||
    '     AND NOT EXISTS (' || E'\n' ||
    '       SELECT 1 FROM public.club_members me' || E'\n' ||
    '        WHERE me.user_id = auth.uid()' || E'\n' ||
    '          AND me.role IN (''owner'',''admin'',''manager'')' || E'\n' ||
    '          AND me.club_id IN (SELECT club_id FROM public.club_members' || E'\n' ||
    '                              WHERE user_id = p_agent_id))' || E'\n' ||
    '  THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Not authorised to generate an invoice for this agent'';' || E'\n' ||
    '  END IF;' || E'\n' || E'\n';

  EXECUTE replace(v_def, v_anchor, v_guard || v_anchor);
END
$do$;

DO $check$
BEGIN
  IF pg_get_functiondef('public.fn_generate_credit_invoice(uuid,timestamptz,timestamptz,numeric,timestamptz)'::regprocedure)
       NOT ILIKE '%Not authorised to generate an invoice for this agent%'
  THEN RAISE EXCEPTION 'guard not present after apply'; END IF;
END
$check$;
