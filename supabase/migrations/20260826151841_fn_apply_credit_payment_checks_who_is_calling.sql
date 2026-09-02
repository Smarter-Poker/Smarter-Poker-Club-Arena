-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826151841; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- fn_apply_credit_payment is SECURITY DEFINER, called from the browser at
-- src/services/CreditService.ts:525, and had NO caller check: any logged-in
-- user could post a payment of any size against any invoice, marking another
-- agent's debt paid and writing a credit_payments row.
--
-- A revoke is not available -- the SPA needs it -- so it gets a predicate.
-- Allowed: the invoice's own agent, a platform admin, or an owner/admin/manager
-- of a club that agent belongs to.
--
-- METHOD: the guard is injected into the function's OWN LIVE DEFINITION at a
-- unique anchor and re-executed. No other line changes. Deliberately not PR
-- #994's approach of hand-writing a replacement body.
--
-- ROLLBACK: delete the guard block the RAISE sits in; nothing else was touched.
DO $do$
DECLARE
  v_def text := pg_get_functiondef('public.fn_apply_credit_payment(uuid,numeric,text)'::regprocedure);
  v_anchor text := '  v_new_paid      := v_inv.amount_paid + p_amount;';
  v_guard text;
BEGIN
  IF position(v_anchor in v_def) = 0 THEN
    RAISE EXCEPTION 'anchor not found, refusing to guess';
  END IF;
  IF v_def ILIKE '%Not authorised to apply a payment%' THEN
    RAISE NOTICE 'guard already present, nothing to do';
    RETURN;
  END IF;

  v_guard :=
    '  -- AUDIT 2026-08-26: added. This function had no caller check at all.' || E'\n' ||
    '  IF auth.uid() IS NOT NULL' || E'\n' ||
    '     AND auth.uid() <> v_inv.agent_id' || E'\n' ||
    '     AND NOT public.is_admin()' || E'\n' ||
    '     AND NOT EXISTS (' || E'\n' ||
    '       SELECT 1 FROM public.club_members me' || E'\n' ||
    '        WHERE me.user_id = auth.uid()' || E'\n' ||
    '          AND me.role IN (''owner'',''admin'',''manager'')' || E'\n' ||
    '          AND me.club_id IN (SELECT club_id FROM public.club_members' || E'\n' ||
    '                              WHERE user_id = v_inv.agent_id))' || E'\n' ||
    '  THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Not authorised to apply a payment to this invoice'';' || E'\n' ||
    '  END IF;' || E'\n' || E'\n';

  EXECUTE replace(v_def, v_anchor, v_guard || v_anchor);
END
$do$;

DO $check$
BEGIN
  IF pg_get_functiondef('public.fn_apply_credit_payment(uuid,numeric,text)'::regprocedure)
       NOT ILIKE '%Not authorised to apply a payment to this invoice%'
  THEN RAISE EXCEPTION 'guard not present after apply'; END IF;

  IF NOT has_function_privilege('authenticated','public.fn_apply_credit_payment(uuid,numeric,text)','EXECUTE')
  THEN RAISE EXCEPTION 'the SPA can no longer reach fn_apply_credit_payment'; END IF;
END
$check$;
