-- Existing admission helpers, copied verbatim from their owning migrations.
CREATE OR REPLACE FUNCTION public.fn_union_accounting_run_at(p_period_end timestamptz)
RETURNS timestamptz LANGUAGE sql IMMUTABLE
SET search_path = public
AS $function$
  SELECT (((p_period_end AT TIME ZONE 'America/Chicago')::date + time '04:00')
           AT TIME ZONE 'America/Chicago');
$function$;
CREATE FUNCTION public.fn_accounting_close_gate_holds(p_scope_kind text, p_scope_id uuid, p_period_start timestamptz, p_period_end timestamptz)
 RETURNS boolean
 LANGUAGE plpgsql
 VOLATILE
 SET search_path TO 'public'
AS $f$
-- True while this scope's week waits for its first close attempt: a gate row
-- exists, its time has not come, and no attempt of the week has started.
-- The first held visit files one warning; every held visit is counted.
DECLARE g public.accounting_close_gates%ROWTYPE;
BEGIN
 SELECT * INTO g FROM public.accounting_close_gates x
  WHERE x.scope_kind=p_scope_kind AND x.scope_id=p_scope_id AND x.period_start=p_period_start AND x.period_end=p_period_end
  FOR UPDATE;
 IF NOT FOUND OR clock_timestamp()>=g.gate_until THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.union_accounting_runs q WHERE q.scope_kind=p_scope_kind AND q.scope_id=p_scope_id
   AND q.period_start=p_period_start AND q.period_end=p_period_end) THEN
  RETURN false;
 END IF;
 UPDATE public.accounting_close_gates x SET held_visits=x.held_visits+1,
   first_held_at=COALESCE(x.first_held_at,clock_timestamp()),last_held_at=clock_timestamp()
  WHERE x.scope_kind=p_scope_kind AND x.scope_id=p_scope_id AND x.period_start=p_period_start AND x.period_end=p_period_end;
 IF g.first_held_at IS NULL THEN
  INSERT INTO public.financial_alerts(source,severity,message,context)
  VALUES(CASE WHEN p_scope_kind='union' THEN 'union_accounting_scheduler' ELSE 'weekly_club_accounting' END,'warning',
   'A weekly close waits for a quiet hour; it starts by itself at gate_until',
   jsonb_build_object('scope_kind',p_scope_kind,'scope_id',p_scope_id,'period_start',p_period_start,'period_end',p_period_end,
     'gate_until',g.gate_until,'reason',g.reason,'first_held_at',clock_timestamp()));
 END IF;
 RETURN true;
END $f$;
CREATE FUNCTION public.fn_accounting_close_seal_held(p_boundary timestamptz)
 RETURNS boolean
 LANGUAGE sql
 VOLATILE
 SET search_path TO 'public'
AS $f$
 -- The original inventory seal of a gated week's end waits with the week.
 SELECT EXISTS(SELECT 1 FROM public.accounting_close_gates g
  WHERE g.period_end=p_boundary AND clock_timestamp()<g.gate_until)
$f$;
CREATE FUNCTION public.fn_accounting_close_gate_lifted_unstarted()
 RETURNS boolean
 LANGUAGE sql
 VOLATILE
 SET search_path TO 'public'
AS $f$
 -- A gate's time came within the last day and its scope has not started the
 -- week: job 272 calls the close on this tick instead of the next 40-minute one.
 SELECT EXISTS(SELECT 1 FROM public.accounting_close_gates g
  WHERE g.gate_until<=clock_timestamp() AND g.gate_until>clock_timestamp()-interval '1 day'
   AND NOT EXISTS(SELECT 1 FROM public.union_accounting_runs q WHERE q.scope_kind=g.scope_kind AND q.scope_id=g.scope_id
     AND q.period_start=g.period_start AND q.period_end=g.period_end))
$f$;
CREATE FUNCTION public.fn_union_pnl_inventory_seal_in_progress()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $f$
 -- A split seal of the current week's boundary has started and not finished.
 SELECT EXISTS(SELECT 1 FROM public.union_pnl_inventory_seal_layers l WHERE l.boundary=public.fn_union_week_start(now()))
   AND NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_checkpoints c WHERE c.boundary=public.fn_union_week_start(now()))
$f$;
