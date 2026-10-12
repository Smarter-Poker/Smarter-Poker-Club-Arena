-- 20261003155132_the_first_close_of_a_long_week_waits_for_a_quiet_hour.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE FIRST CLOSE OF A LONG WEEK WAITS FOR A QUIET HOUR
--
-- Any transaction running more than ~9 minutes during play bloats the
-- tournament lease rows and expires leases (lease agent, 2026-10-03), and the
-- coordinator capped every close transaction at 5 minutes. The week
-- 2026-09-28 07:00 -> 2026-10-05 07:00 UTC is ~3.2x the volume of the week of
-- 2026-09-21, and not every close step is split yet (round 3 and its payout
-- loop, the inventory seal, Deep Stack's preparation and the P&L flows still
-- run longer than 5 minutes in one transaction). Decision (coordinator,
-- 2026-10-03, "bounded A with a B fallback"): that week's first close attempt
-- does not start at 2026-10-05 09:40 UTC (the first 40-minute tick after its
-- 09:00 UTC due time); it waits, at the latest, until 2026-10-06 13:00 UTC,
-- the start of the quietest hour band measured (13:00-17:00 UTC), and runs
-- then as deployed, whatever is split by that time. It may be released
-- earlier only by a later migration, once every split step is proved equal on
-- the week of 2026-09-21, applied and merged.
--
-- WHAT CHANGES:
--  1. public.accounting_close_gates holds one row per (scope, week) whose
--     FIRST close attempt waits, with the time it waits until (gate_until; a
--     CHECK keeps it within 30 hours of the week's end, so no gate can hold a
--     week past the Tuesday 13:00 UTC after it). Seeded with exactly two
--     rows: Midway Union and Deep Stack Society, week 2026-09-28 -> 2026-10-05,
--     gate_until 2026-10-06 13:00 UTC.
--  2. fn_process_weekly_accounting_scope asks
--     fn_accounting_close_gate_holds(scope, week) right after the week is due
--     and before anything else of that week (barrier, locks, run row,
--     preparation, money): while the gate holds and the scope has no run row
--     for that week yet, the scope's visit ends with nothing checked and
--     nothing failed. The first held visit files ONE financial_alerts row,
--     severity 'warning' (never 'critical': fn_ca_financial_alert_to_incident
--     acts on critical rows only), saying until when the close waits; the gate
--     row counts the held visits. Once a run row exists (any attempt started),
--     after gate_until, for any other scope and for any other week, the gate
--     answers false and nothing differs from before.
--  3. The original inventory seal of the gated week's boundary (2026-10-05
--     07:00; ~534 s for 478k rows last week, one transaction at the 07:40
--     tick) waits with it (fn_accounting_close_seal_held): it is the first step
--     of that week's close and seals rows of the closed week only, so the same
--     checkpoint is sealed after the lift.
--  4. Job 272 (union-weekly-rakeback-close): a tick does not take the large
--     budget for a seal that is held, and the first tick at or after a gate's
--     gate_until whose scope has not started that week
--     (fn_accounting_close_gate_lifted_unstarted) calls the close, so it runs
--     at 13:00 UTC, not at the next 40-minute tick.
-- Money safety is unchanged: no money path, receipt or refusal changes; a
-- held visit writes only the gate row and the one warning.
--
-- @live-proof: to_regprocedure('public.fn_accounting_close_gate_holds(text,uuid,timestamptz,timestamptz)') IS NOT NULL
-- @live-proof: position('fn_accounting_close_gate_holds(''union''' in pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure)) > 0
-- @live-proof: (SELECT count(*)=2 AND max(gate_until)<='2026-10-06 13:00:00+00' FROM public.accounting_close_gates WHERE period_end='2026-10-05 07:00:00+00')
-- @live-proof: (SELECT position('fn_accounting_close_gate_lifted_unstarted' in command)>0 FROM cron.job WHERE jobname='union-weekly-rakeback-close')
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '90s';

CREATE TABLE public.accounting_close_gates (
  scope_kind text NOT NULL CHECK (scope_kind IN ('union','club')),
  scope_id uuid NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  gate_until timestamptz NOT NULL,
  reason text NOT NULL,
  held_visits integer NOT NULL DEFAULT 0,
  first_held_at timestamptz,
  last_held_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (scope_kind, scope_id, period_start, period_end),
  CHECK (period_end > period_start),
  CHECK (gate_until > period_end AND gate_until <= period_end + interval '30 hours')
);
ALTER TABLE public.accounting_close_gates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_close_gates FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.accounting_close_gates IS
  'A weekly close whose FIRST attempt waits for a quiet hour (20261003): while clock_timestamp() < gate_until and the scope has no union_accounting_runs row for the week, the scheduler holds that scope''s week and files one warning. Retries, other scopes and other weeks are not gated. gate_until is at most 30 hours after the week''s end.';

INSERT INTO public.accounting_close_gates (scope_kind, scope_id, period_start, period_end, gate_until, reason)
SELECT g.k, g.id, '2026-09-28 07:00:00+00', '2026-10-05 07:00:00+00', '2026-10-06 13:00:00+00',
  'Close transactions over 5 minutes expire tournament leases during play; not every step of this ~3.2x week is split yet. The close runs at the quiet hour (coordinator decision 2026-10-03, bounded A with a B fallback).'
FROM (VALUES ('union','fade0000-0000-0000-0000-000000000001'::uuid), ('club','2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid)) g(k, id);

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
REVOKE ALL ON FUNCTION public.fn_accounting_close_gate_holds(text,uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.fn_accounting_close_gate_holds(text,uuid,timestamptz,timestamptz) IS
  'Weekly close gate (20261003): true while the scope''s week waits for its first close attempt (gate row, before gate_until, no run row); records the held visit and, on the first, one warning in financial_alerts.';

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
REVOKE ALL ON FUNCTION public.fn_accounting_close_seal_held(timestamptz) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.fn_accounting_close_seal_held(timestamptz) IS
  'Weekly close gate (20261003): true while a gated week ending at p_boundary waits; the boundary''s original inventory seal waits with it.';

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
REVOKE ALL ON FUNCTION public.fn_accounting_close_gate_lifted_unstarted() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.fn_accounting_close_gate_lifted_unstarted() IS
  'Weekly close gate (20261003): true from gate_until (for one day) while a gated scope has not started its week; job 272 then calls the close on every tick until it starts.';

DO $mig$
DECLARE s regprocedure; d text; a text; r text; j bigint; c text;
BEGIN
 IF (SELECT count(*) FROM public.unions WHERE id='fade0000-0000-0000-0000-000000000001')<>1
  OR (SELECT count(*) FROM public.clubs WHERE id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3' AND is_union IS NOT TRUE)<>1 THEN
  RAISE EXCEPTION 'gated scopes missing' USING ERRCODE='55000'; END IF;
 -- scheduler
 s:='public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'afc109b27abc4646c1c6878368579211' THEN RAISE EXCEPTION 'scheduler preimage %',md5(d); END IF;
 a:=$a$    IF v_tick_budget_large AND to_regprocedure('public.fn_union_pnl_inventory_checkpoint_due()') IS NOT NULL THEN
$a$;
 r:=$r$    IF v_tick_budget_large AND to_regprocedure('public.fn_union_pnl_inventory_checkpoint_due()') IS NOT NULL
      -- A gated week's seal waits with its close (20261003).
      AND NOT public.fn_accounting_close_seal_held(public.fn_union_week_start(v_now)) THEN
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'scheduler anchor 1 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$      IF v_now < v_due THEN EXIT; END IF;
$a$;
 r:=$r$      IF v_now < v_due THEN EXIT; END IF;
      -- A LONG WEEK'S FIRST CLOSE WAITS FOR A QUIET HOUR (20261003): while
      -- this book's week has a gate and no attempt yet, nothing of it runs
      -- (fn_accounting_close_gate_holds files one warning, never a critical).
      IF public.fn_accounting_close_gate_holds('union',v_union.id,v_from,v_end) THEN EXIT; END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'scheduler anchor 2 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$        IF v_now<v_due THEN EXIT;END IF;
$a$;
 r:=$r$        IF v_now<v_due THEN EXIT;END IF;
        -- A LONG WEEK'S FIRST CLOSE WAITS FOR A QUIET HOUR (20261003): as for a union book.
        IF public.fn_accounting_close_gate_holds('club',v_club.id,v_from,v_end) THEN EXIT;END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'scheduler anchor 3 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'scheduler postimage differs from the substituted text'; END IF;
 -- job 272
 SELECT jobid,command INTO j,c FROM cron.job WHERE jobname='union-weekly-rakeback-close';
 IF j IS NULL THEN RAISE EXCEPTION 'cron job union-weekly-rakeback-close missing' USING ERRCODE='55000'; END IF;
 IF md5(c)<>'18926d48bccb3663097ce2ebea48ab5c' THEN RAISE EXCEPTION 'job 272 command preimage %',md5(c) USING ERRCODE='55000'; END IF;
 a:=$a$FROM (SELECT NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_checkpoints c WHERE c.boundary=public.fn_union_week_start(now())) OR $a$;
 r:=$r$FROM (SELECT (NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_checkpoints c WHERE c.boundary=public.fn_union_week_start(now())) AND NOT public.fn_accounting_close_seal_held(public.fn_union_week_start(now()))) OR $r$;
 IF (length(c)-length(replace(c,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'job 272 anchor 1 count'; END IF;
 c:=replace(c,a,r);
 a:=$a$ THEN public.fn_union_settlement_cascade_due() END;$a$;
 r:=$r$ OR public.fn_accounting_close_gate_lifted_unstarted() THEN public.fn_union_settlement_cascade_due() END;$r$;
 IF (length(c)-length(replace(c,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'job 272 anchor 2 count'; END IF;
 c:=replace(c,a,r);
 PERFORM cron.alter_job(j, schedule:='*/5 * * * *', command:=c, active:=true);
 IF (SELECT command FROM cron.job WHERE jobid=j)<>c THEN RAISE EXCEPTION 'job 272 postimage differs'; END IF;
END
$mig$;

COMMIT;
