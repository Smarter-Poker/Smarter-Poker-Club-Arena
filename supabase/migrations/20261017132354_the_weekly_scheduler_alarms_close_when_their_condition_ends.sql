-- 20261017132354_the_weekly_scheduler_alarms_close_when_their_condition_ends
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-17 13:23:54 UTC.
--
-- THE WEEKLY SCHEDULER ALARMS CLOSE WHEN THEIR CONDITION ENDS (2026-10-17)
--
-- fn_process_weekly_accounting_scope raises two union_accounting_scheduler
-- alarms and nothing ever closes either. Read on production 13:20 UTC:
--   * 41 critical "A weekly accounting scope did not finish its scheduler
--     visit" (2026-10-15 01:20 to 10-17 10:15) for the Midway union and club
--     2a1132b9. The latest visit to both scopes finished ('visited',
--     13:22), so every one of them describes a condition already over.
--   * 7 "Weekly union accounting is incomplete" (2 critical, 5 warning) for
--     the Midway week 2026-10-05 to 10-12, which is still running (rounds 1
--     and 2 paid; 3 and 4 to come). These are true until that week completes.
--
-- THE FIX, at the two places those conditions end (no sweep, no repair):
--   1. Where a visit's outcome is recorded: a visit that finished closes its
--      own scope's unfinished-visit alarms.
--   2. Where a union week is recorded complete: that week's incomplete-week
--      alarms close.
-- No money, run, receipt, certificate, budget, ordering or ACL changes. An
-- alarm whose condition still holds is never touched: an unfinished visit
-- raises a new one, and an incomplete week stays alarmed until it completes.
--
-- Stacks on 20261017131056 (preimage 9d5ede8a..., postimage 06063824..., derived
-- from scripts/ci/fixtures/weekly-in-progress-tick/scope-after.sql with both
-- substitutions applied, and checked against production once 131056 is
-- installed). Each anchor must occur exactly once. Owner, SECURITY DEFINER,
-- configuration and ACL are proven unchanged; the readback must be exact. No
-- scheduler lock, for the reason given in 20261017131056.
-- @live-proof: md5(pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure)) = '06063824fc433b0df397bfde072e390b'

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $pre$
DECLARE v_reason text;
BEGIN
  v_reason := public.fn_ca_break_window_refuses_migrations(now());
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'SCHEDULER_ALARMS_REFUSED: %', v_reason USING ERRCODE = '55000';
  END IF;
END
$pre$;

DO $install$
DECLARE
  c_sig constant text := 'public.fn_process_weekly_accounting_scope(uuid,uuid)';
  c_old3 constant text := $o3$          last_error=excluded.last_error,unfinished_visits=CASE WHEN excluded.last_outcome='visited' THEN 0 ELSE s.unfinished_visits+1 END;
        IF v_scope_outcome<>'visited' AND v_prior_outcome IS DISTINCT FROM v_scope_outcome
$o3$;
  c_new3 constant text := $n3$          last_error=excluded.last_error,unfinished_visits=CASE WHEN excluded.last_outcome='visited' THEN 0 ELSE s.unfinished_visits+1 END;
        -- A VISIT THAT FINISHED ENDS ITS SCOPE'S UNFINISHED-VISIT ALARMS
        -- (2026-10-17). Each says a visit to this scope did not finish; this
        -- one did, so that condition is over. Nothing else ever closed them:
        -- 41 stood open for one union and one club, every one already over.
        IF v_scope_outcome='visited' THEN
          UPDATE public.financial_alerts a
             SET resolved=true,resolved_at=clock_timestamp(),
                 resolution='verified: a later scheduler visit to this '||v_scope.kind||' scope finished at '||clock_timestamp()::text||'.',
                 context=COALESCE(a.context,'{}'::jsonb)||jsonb_build_object('resolved_by_fn','fn_process_weekly_accounting_scope')
           WHERE a.source='union_accounting_scheduler' AND NOT COALESCE(a.resolved,false)
             AND a.message='A weekly accounting scope did not finish its scheduler visit'
             AND a.context->>'scope_kind'=v_scope.kind AND a.context->>'scope_id'=v_scope.id::text;
        END IF;
        IF v_scope_outcome<>'visited' AND v_prior_outcome IS DISTINCT FROM v_scope_outcome
$n3$;
  c_old4 constant text := $o4$       WHERE union_id=v_union.id AND period_start=v_from AND period_end=v_end;
      IF v_result->>'success' IS DISTINCT FROM 'true' AND v_result->>'chunk_committed' IS DISTINCT FROM 'true' THEN
$o4$;
  c_new4 constant text := $n4$       WHERE union_id=v_union.id AND period_start=v_from AND period_end=v_end;
      -- A COMPLETED WEEK ENDS ITS INCOMPLETE-WEEK ALARMS (2026-10-17): the
      -- week each one describes has just been recorded complete.
      IF v_result->>'success'='true' THEN
        UPDATE public.financial_alerts a
           SET resolved=true,resolved_at=clock_timestamp(),
               resolution='verified: the union week '||v_from::text||' to '||v_end::text||' was recorded complete at '||clock_timestamp()::text||'.',
               context=COALESCE(a.context,'{}'::jsonb)||jsonb_build_object('resolved_by_fn','fn_process_weekly_accounting_scope')
         WHERE a.source='union_accounting_scheduler' AND NOT COALESCE(a.resolved,false)
           AND a.message='Weekly union accounting is incomplete'
           AND a.context->>'union_id'=v_union.id::text
           AND a.context->>'period_start' IS NOT NULL AND a.context->>'period_end' IS NOT NULL
           AND (a.context->>'period_start')::timestamptz=v_from AND (a.context->>'period_end')::timestamptz=v_end;
      END IF;
      IF v_result->>'success' IS DISTINCT FROM 'true' AND v_result->>'chunk_committed' IS DISTINCT FROM 'true' THEN
$n4$;
  v_oid oid := to_regprocedure(c_sig);
  v_def text; v_new text;
  v_owner oid; v_secdef boolean; v_config text[]; v_acl text;
BEGIN
  IF current_user <> 'postgres' OR v_oid IS NULL THEN
    RAISE EXCEPTION 'scheduler alarms: owner/target mismatch';
  END IF;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) = '06063824fc433b0df397bfde072e390b' THEN
    RETURN;
  END IF;
  IF md5(v_def) <> '9d5ede8aa77afecfb993e305a755175a' THEN
    RAISE EXCEPTION 'scheduler alarms: unexpected live body %', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, c_old3, ''))) / length(c_old3) <> 1
     OR (length(v_def) - length(replace(v_def, c_old4, ''))) / length(c_old4) <> 1 THEN
    RAISE EXCEPTION 'scheduler alarms: an anchor is not exactly once';
  END IF;
  v_new := replace(replace(v_def, c_old3, c_new3), c_old4, c_new4);
  IF md5(v_new) <> '06063824fc433b0df397bfde072e390b' THEN
    RAISE EXCEPTION 'scheduler alarms: computed postimage is %', md5(v_new);
  END IF;
  SELECT p.proowner, p.prosecdef, p.proconfig, p.proacl::text
    INTO v_owner, v_secdef, v_config, v_acl FROM pg_proc p WHERE p.oid = v_oid;
  EXECUTE v_new;
  IF pg_get_functiondef(v_oid) IS DISTINCT FROM v_new THEN
    RAISE EXCEPTION 'scheduler alarms: exact readback failed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_oid
                   AND p.proowner = v_owner AND p.prosecdef = v_secdef
                   AND p.proconfig IS NOT DISTINCT FROM v_config
                   AND p.proacl::text IS NOT DISTINCT FROM v_acl) THEN
    RAISE EXCEPTION 'scheduler alarms: authority drift';
  END IF;
END
$install$;

COMMIT;
