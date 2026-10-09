-- 20261008050208_the_union_s_own_square_up_period_settles_with_its_week.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE UNION'S OWN SQUARE-UP PERIOD SETTLES WITH ITS WEEK (2026-10-08)
--
-- Midway Union's settlement period cc6c056b (the union's own club row,
-- clubs.id = union id, week 2026-09-28 07:00 to 2026-10-05 07:00 UTC) has
-- read 'processing' since the week closed. fn_union_governance_check reports
-- it as settlement_period_overdue_open (the only offender, read 2026-10-08)
-- and fn_ca_conservation_sweep pages on it hourly.
--
-- The week itself closed: union_accounting_runs for the union and that week
-- is 'complete' (finished 2026-10-07 21:42:19 UTC, job 272's 21:35 tick, one
-- attempt of 7m20s under its own 50-minute budget), and the union-level row and
-- both member clubs' rows were settled at 21:35:00.236. cc6c056b was CREATED
-- in that same transaction (created_at 21:35:00.236), as 'processing', by
-- fn_union_issue_weekly_invoices: the round 4 square-up opens a period for
-- every club it bills when none exists, the union's own club row included.
--
-- THE CAUSE is order inside fn_union_settlement_cascade:
--   PERFORM public.fn_mark_scope_accounting_settled('union', ...);  -- settles
--   ...                                                              -- eco
--   v_inv := public.fn_union_issue_weekly_invoices(...);             -- OPENS
-- 20261003024413 (the books close) taught the settler to settle every period
-- the week opened, including the union's own row. That works only for a row
-- that already exists when the settler runs. Last week's row (747205e9) did,
-- because an earlier attempt had opened it; this week's did not, so the
-- square-up opened it after the settler had finished, and nothing settles a
-- week the scheduler already records as complete. It will recur every week
-- whose own-club period is first opened by the closing attempt.
--
-- NOT THE CAUSE: the weekly_scope_time_budget_exhausted failure of 21:20 UTC
-- (financial_alerts c5acb650, incident ec9e9f1b). Its receipt carries budget
-- '1 minute'; job 272 only ever sets 9 or 50 minutes, and job 272's 21:15 and
-- 21:20 ticks each finished in under 30 ms (cron.job_run_details), so that
-- attempt was an out-of-band call made with a one-minute budget. The
-- scheduler's own next real attempt closed the week in 7m20s, under both its
-- 9-minute and its 50-minute budgets. No budget is changed here.
--
-- THE FIX, in fn_union_settlement_cascade: once the square-up has run and
-- every invoice is proved delivered, the settler runs once more (it is
-- idempotent: settled and closed rows are left alone), and the cascade then
-- refuses to report success while any period of the union's week is neither
-- 'settled' nor 'closed' (union_week_period_left_unsettled, which rolls the
-- close back like every other refusal). The first call stays where it is:
-- the member clubs' statements read their periods as settled.
--
-- THE ONE WEEK ALREADY STRANDED (section 2) is closed by its own path, as
-- 20261003024413 did for 747205e9: only if cc6c056b is still exactly the
-- 'processing' row read on 2026-10-08 and the union's run for that week is
-- 'complete', fn_mark_scope_accounting_settled is called for the week and
-- must leave it 'settled'. No chip moves; no other row changes state (the
-- union-level and member rows are already settled and the settler skips them).
--
-- HOW: the pinned-preimage exact-substitution helper of 20261007212545. The
-- live text must hash to today's measured md5 (818ec0b8...), the anchor must
-- occur exactly once (measured read-only on production 2026-10-08: 1), and the
-- result must hash to the derived postimage (1f19fa0b..., computed read-only
-- on production with replace() over the same bytes); owner, SECURITY DEFINER,
-- proconfig and grants must not move. A second run refuses on the pinned
-- preimage.
--
-- Regression: scripts/ci/test-union-own-period-settles.py (native PostgreSQL;
-- runs the exact live cascade and settler, and fails on the live text), run by
-- .github/workflows/union-own-period-settles.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_union_settlement_cascade(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) = '1f19fa0bf96efa7dfe07ca9bbd831f0b' AND (SELECT status FROM public.settlement_periods WHERE id = 'cc6c056b-5814-4e44-84c4-9aa841b8f246') IN ('settled','closed'))

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. The settler runs again after the square-up, and the week is proved settled
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.ca_cascade_subst(p_sig text, p_before text, p_after text,
                                         p_old text[], p_new text[])
RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text; v_new text; v_n integer; i integer;
  v_acl text; v_owner text; v_secdef boolean; v_cfg text[];
BEGIN
  v_def := pg_get_functiondef(p_sig::regprocedure);
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION '% is not the pinned text (md5 %)', p_sig, md5(v_def);
  END IF;
  IF array_length(p_old, 1) IS DISTINCT FROM array_length(p_new, 1) THEN
    RAISE EXCEPTION '%: anchors and replacements do not pair', p_sig;
  END IF;
  v_new := v_def;
  FOR i IN 1 .. array_length(p_old, 1) LOOP
    v_n := (length(v_new) - length(replace(v_new, p_old[i], ''))) / length(p_old[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: anchor % occurs % times, expected exactly 1', p_sig, i, v_n;
    END IF;
    v_new := replace(v_new, p_old[i], p_new[i]);
  END LOOP;
  IF md5(v_new) <> p_after THEN
    RAISE EXCEPTION '%: substituted text is not the derived postimage (md5 %)', p_sig, md5(v_new);
  END IF;

  SELECT p.proacl::text, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
    INTO v_acl, v_owner, v_secdef, v_cfg
    FROM pg_proc p WHERE p.oid = p_sig::regprocedure;

  EXECUTE v_new;

  IF md5(pg_get_functiondef(p_sig::regprocedure)) <> p_after THEN
    RAISE EXCEPTION '%: the replaced function does not read back as the postimage', p_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = p_sig::regprocedure
                    AND p.proacl::text IS NOT DISTINCT FROM v_acl
                    AND pg_get_userbyid(p.proowner) = v_owner
                    AND p.prosecdef = v_secdef
                    AND p.proconfig IS NOT DISTINCT FROM v_cfg) THEN
    RAISE EXCEPTION '%: owner, security, settings or grants moved', p_sig;
  END IF;
END $h$;

SELECT pg_temp.ca_cascade_subst(
  'public.fn_union_settlement_cascade(uuid,timestamp with time zone,timestamp with time zone)',
  '818ec0b8e917e4da8d0d876664dd3114', '1f19fa0bf96efa7dfe07ca9bbd831f0b',
  ARRAY[$co1$    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='union_invoice_delivery_incomplete';
  END IF;
$co1$],
  ARRAY[$cn1$    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='union_invoice_delivery_incomplete';
  END IF;

  -- THE SQUARE-UP'S OWN PERIOD SETTLES WITH ITS WEEK (2026-10-08). The
  -- settler above ran before round 4, and the square-up then opened the
  -- union's own club row (clubs.id = union id) as 'processing', so that one
  -- period never settled (cc6c056b, week of 2026-09-28). Settle every period
  -- this week opened once more, now that the last opener has run, and prove it.
  PERFORM public.fn_mark_scope_accounting_settled('union',p_union_id,v_from,v_to);
  IF EXISTS (SELECT 1 FROM public.settlement_periods sp
              WHERE sp.union_id=p_union_id AND sp.start_at=v_from AND sp.end_at=v_to
                AND sp.status NOT IN ('settled','closed')) THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='union_week_period_left_unsettled';
  END IF;
$cn1$]
);

-- ---------------------------------------------------------------------------
-- 2. The one week the old order stranded, closed by its own path
-- ---------------------------------------------------------------------------
DO $close$
BEGIN
  IF (SELECT status FROM public.settlement_periods
       WHERE id = 'cc6c056b-5814-4e44-84c4-9aa841b8f246'
         AND club_id = 'fade0000-0000-0000-0000-000000000001'
         AND union_id = 'fade0000-0000-0000-0000-000000000001'
         AND start_at = '2026-09-28 07:00:00+00' AND end_at = '2026-10-05 07:00:00+00')
     IS DISTINCT FROM 'processing' THEN
    RAISE EXCEPTION 'close: the union''s own period for 2026-09-28 is no longer the one read on 2026-10-08';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.union_accounting_runs
                  WHERE scope_kind = 'union' AND scope_id = 'fade0000-0000-0000-0000-000000000001'
                    AND period_start = '2026-09-28 07:00:00+00' AND period_end = '2026-10-05 07:00:00+00'
                    AND status = 'complete') THEN
    RAISE EXCEPTION 'close: the week of 2026-09-28 is not complete; nothing to close';
  END IF;

  PERFORM public.fn_mark_scope_accounting_settled('union', 'fade0000-0000-0000-0000-000000000001',
    '2026-09-28 07:00:00+00', '2026-10-05 07:00:00+00');

  IF (SELECT status FROM public.settlement_periods WHERE id = 'cc6c056b-5814-4e44-84c4-9aa841b8f246')
     IS DISTINCT FROM 'settled' THEN
    RAISE EXCEPTION 'close: the period did not settle';
  END IF;
END
$close$;

COMMIT;
