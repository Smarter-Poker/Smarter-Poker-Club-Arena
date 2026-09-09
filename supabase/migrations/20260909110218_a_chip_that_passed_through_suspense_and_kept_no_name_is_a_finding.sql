/* THE DETECTOR THAT WOULD HAVE CAUGHT THIS ON THE DAY.
   settlement_suspense is the counterparty a journal trigger uses when nobody
   told it who the other side was. A movement that lands there is a money path
   that did not declare itself. Until today the only thing watching it was a
   daily note on the drift board that measured the flow and nobody acted on,
   and the flow nets to zero the moment a movement passes straight through -
   which is exactly the shape of the bug it was supposed to find.

   This asks the balance question instead, per account: after everything that
   touched suspense in the window, including the corrections that cancel a
   twin, is any account left holding chips that were never given a name? A
   movement that was declared never appears here at all. A twin that has been
   explicitly cancelled nets to zero and does not appear either. What is left
   is only undeclared money, named by the account and the column that wrote it. */
CREATE OR REPLACE FUNCTION public.fn_ca_undeclared_leg_check(p_hours integer DEFAULT 24)
RETURNS TABLE(account text, entity_id uuid, net_chips numeric, legs bigint, detail text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  WITH win AS (
    SELECT from_type, from_entity_id, to_type, to_entity_id, amount, from_label, to_label
      FROM public.chip_ledger
     WHERE created_at >= now() - make_interval(hours => GREATEST(COALESCE(p_hours, 24), 1))
       AND 'settlement_suspense' IN (from_type, to_type)
  ), sides AS (
    SELECT to_type AS account, to_entity_id AS entity_id, amount AS delta,
           COALESCE(from_label, to_label) AS src
      FROM win WHERE to_type <> 'settlement_suspense'
    UNION ALL
    SELECT from_type, from_entity_id, -amount, COALESCE(from_label, to_label)
      FROM win WHERE from_type <> 'settlement_suspense'
  )
  SELECT s.account, s.entity_id,
         round(sum(s.delta), 2) AS net_chips,
         count(*) AS legs,
         'chips reached this account through settlement_suspense and were never given a name: '
           || round(sum(s.delta), 2) || ' over ' || count(*) || ' leg(s)'
           || COALESCE(', written by ' || max(s.src), '')
           || '. A balance write declares its counterparty with fn_ca_declare_ledger, or '
           || 'stands its trigger down with app.ledger_autoskip_<table> when the caller '
           || 'writes the named leg itself.' AS detail
    FROM sides s
   GROUP BY 1, 2
  HAVING round(sum(s.delta), 2) <> 0
   ORDER BY abs(round(sum(s.delta), 2)) DESC
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_undeclared_leg_check(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_ca_undeclared_leg_check(integer) FROM anon;
REVOKE ALL ON FUNCTION public.fn_ca_undeclared_leg_check(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_undeclared_leg_check(integer) TO service_role;

DO $mig$
DECLARE
  v_src text; v_new text; v_open int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_conservation_sweep';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_ca_conservation_sweep is gone';
  END IF;
  IF position($chk$fn_ca_undeclared_leg_check$chk$ IN v_src) <> 0 THEN
    RAISE EXCEPTION 'the sweep already runs the undeclared-leg check';
  END IF;
  IF position($chk$      ('fn_ca_payout_rows_without_money',$chk$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'the sweep roster moved; re-read it before editing';
  END IF;

  v_new := replace(v_src,
$old$      ('fn_ca_payout_rows_without_money',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_payout_rows_without_money(3) limit 20) t',
       'warning')$old$,
$new$      ('fn_ca_payout_rows_without_money',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_payout_rows_without_money(3) limit 20) t',
       'warning'),
      ('fn_ca_undeclared_leg_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_undeclared_leg_check(24) limit 20) t',
       'warning')$new$);

  IF v_new = v_src THEN
    RAISE EXCEPTION 'the sweep roster was not extended';
  END IF;
  EXECUTE v_new;

  -- The check must read clean the moment it is installed, or it is not a
  -- check, it is a standing alarm nobody can silence.
  SELECT count(*) INTO v_open FROM public.fn_ca_undeclared_leg_check(24);
  IF v_open <> 0 THEN
    RAISE EXCEPTION 'the undeclared-leg check reads % open account(s) at install time', v_open;
  END IF;

  IF (SELECT position($chk$fn_ca_undeclared_leg_check$chk$ IN pg_get_functiondef(p.oid))
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='fn_ca_conservation_sweep') = 0 THEN
    RAISE EXCEPTION 'the sweep did not take the new check';
  END IF;
END
$mig$;;
