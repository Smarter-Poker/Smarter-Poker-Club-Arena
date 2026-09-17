\set ON_ERROR_STOP on
-- UNRUN. Apply load.sql in a fresh protected unit database first.
BEGIN;
SET LOCAL test.clock='2026-09-14T08:30:00Z';
INSERT INTO union_accounting_runs(union_id,period_start,period_end,scheduled_at,status,attempts,result)
 VALUES(u(1001),'2026-08-31 07:00Z','2026-09-07 07:00Z','2026-09-07 09:00Z','failed',1,'{"success":false}');
INSERT INTO union_accounting_runs(standalone_club_id,period_start,period_end,scheduled_at,status,attempts,result)
 VALUES(u(12),'2026-08-31 07:00Z','2026-09-07 07:00Z','2026-09-07 09:00Z','failed',1,'{"success":false}');
CREATE TEMP TABLE overdue_mixed AS SELECT fn_process_weekly_accounting(NULL) AS r;
SELECT assert_true((SELECT r->>'success'='true' AND r->>'checked'='2' AND r->>'failed'='0'
 AND r->>'visited_scopes'='2' AND jsonb_array_length(r->'detail')=2
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'detail')d
  WHERE (d->>'period_start')::timestamptz IS DISTINCT FROM '2026-08-31 07:00Z') FROM overdue_mixed),
 'before the new Monday due time, both old union and standalone books use their own past due week');
SELECT assert_true((SELECT count(*)=2 AND bool_and(status='complete') FROM union_accounting_runs)
 AND NOT EXISTS(SELECT 1 FROM union_accounting_runs WHERE period_start='2026-09-07 07:00Z'),
 'old obligations complete without creating or settling the newly closed not-yet-due week');
-- Exercise the due gate while the independent minute cutoff still admits
-- this invocation. A later minute-59 call must report maintenance instead.
SET LOCAL test.clock='2026-09-14T08:44:00Z';
CREATE TEMP TABLE before_not_due AS SELECT test_scheduler_timing_snapshot() AS value;
CREATE TEMP TABLE before_cutoff_not_due AS SELECT fn_process_weekly_accounting(NULL) AS r;
SELECT assert_true((SELECT r->'success'='true'::jsonb AND r->'checked'='0'::jsonb
 AND r->'failed'='0'::jsonb AND r->'detail'='[]'::jsonb AND NOT(r ? 'skipped') FROM before_cutoff_not_due)
 AND test_scheduler_timing_snapshot()=(SELECT value FROM before_not_due),
 'before minute 45 the due gate leaves the newly closed mixed books untouched, apart from scheduler visitation');
SET LOCAL test.clock='2026-09-14T08:59:59.999999Z';
CREATE TEMP TABLE before_maintenance AS SELECT test_scheduler_timing_snapshot(true) AS value;
CREATE TEMP TABLE just_before_due AS SELECT fn_process_weekly_accounting(NULL) AS r;
SELECT assert_true((SELECT r='{"success":true,"skipped":true,"reason":"maintenance_window"}'::jsonb FROM just_before_due)
 AND test_scheduler_timing_snapshot(true)=(SELECT value FROM before_maintenance),
 'one microsecond before Chicago four returns the exact maintenance skip and preserves every captured field');
SET LOCAL test.clock='2026-09-14T09:00:00Z';
CREATE TEMP TABLE at_due AS SELECT fn_process_weekly_accounting(NULL) AS r;
SELECT assert_true((SELECT r->>'checked'='2' AND r->>'failed'='0'
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'detail')d
  WHERE (d->>'period_start')::timestamptz IS DISTINCT FROM '2026-09-07 07:00Z') FROM at_due)
 AND (SELECT count(*)=4 AND bool_and(status='complete') FROM union_accounting_runs),
 'exact Chicago four admits the new week for both scopes through the same coordinator');
CREATE TEMP TABLE replay_snapshot AS SELECT test_scheduler_timing_snapshot() AS value;
CREATE TEMP TABLE same_instant_replay AS SELECT fn_process_weekly_accounting(NULL) AS r;
SELECT assert_true((SELECT r->'success'='true'::jsonb AND r->'checked'='0'::jsonb
 AND r->'failed'='0'::jsonb AND r->'detail'='[]'::jsonb FROM same_instant_replay)
 AND test_scheduler_timing_snapshot()=(SELECT value FROM replay_snapshot),
 'same-instant replay preserves exact mixed-scope runs, periods, rounds, closes, wallets and inherited financial artifacts except scheduler visitation');
ROLLBACK;

BEGIN;
SET LOCAL test.clock='2026-09-14T08:30:00Z';
INSERT INTO union_accounting_runs(standalone_club_id,period_start,period_end,scheduled_at,status,attempts,result)
 VALUES(u(12),'2026-08-31 07:00Z','2026-09-07 07:00Z','2026-09-07 09:00Z','failed',1,'{"success":false}');
CREATE TEMP TABLE exact_old_club AS SELECT fn_process_weekly_accounting_scope(NULL,u(12)) AS r;
SELECT assert_true((SELECT r->>'checked'='1' AND r->>'failed'='0'
 AND r->'detail'->0->>'club_id'=u(12)::text
 AND (r->'detail'->0->>'period_start')::timestamptz='2026-08-31 07:00Z' FROM exact_old_club)
 AND (SELECT count(*)=1 AND bool_and(standalone_club_id=u(12) AND status='complete') FROM union_accounting_runs),
 'exact standalone entry also retries its old due week before newest Monday four without widening scope');
ROLLBACK;

BEGIN;
SET LOCAL test.clock='2026-09-14T08:30:00Z';
INSERT INTO union_accounting_runs(standalone_club_id,period_start,period_end,scheduled_at,status,attempts,result)
 VALUES(u(12),'2026-09-07 07:00Z','2026-09-14 07:00Z','2026-09-14 09:00Z','failed',1,'{"success":false,"preserved":true}');
CREATE TEMP TABLE not_due_original AS SELECT to_jsonb(q) AS value FROM union_accounting_runs q;
CREATE TEMP TABLE exact_not_due AS SELECT fn_process_weekly_accounting_scope(NULL,u(12)) AS r;
SELECT assert_true((SELECT r->>'checked'='0' FROM exact_not_due)
 AND (SELECT to_jsonb(q)=(SELECT value FROM not_due_original) FROM union_accounting_runs q),
 'removing the outer due gate preserves the inner per-week gate and original not-yet-due attempt');
ROLLBACK;

BEGIN;
SET LOCAL test.clock='2026-09-14T08:30:00Z';
SET LOCAL test.preparation_blocked='true';
INSERT INTO union_accounting_runs(standalone_club_id,period_start,period_end,scheduled_at,status,attempts,result)
 VALUES(u(12),'2026-08-31 07:00Z','2026-09-07 07:00Z','2026-09-07 09:00Z','failed',1,'{"success":false}');
CREATE TEMP TABLE old_still_blocked AS SELECT fn_process_weekly_accounting(NULL) AS r;
SELECT assert_true((SELECT r->>'checked'='1' AND r->>'failed'='1' FROM old_still_blocked)
 AND (SELECT count(*)=1 AND bool_and(status='failed') FROM union_accounting_runs)
 AND NOT EXISTS(SELECT 1 FROM accounting_routed_settlement_runs WHERE scope_kind='club' AND scope_id=u(12)),
 'older standalone eligibility never turns an unverified calculation into a paid or complete book');
ROLLBACK;

-- Pure calendar checks qualify the actual time helpers, not historical money.
-- Full funded DST books remain a separate required integrated fixture.
DO $calendar$DECLARE v_zone text;v_from timestamptz;v_to timestamptz;v_due timestamptz;v_hours int;BEGIN
 FOREACH v_zone IN ARRAY ARRAY['UTC','America/Chicago','America/Los_Angeles'] LOOP
  PERFORM set_config('TimeZone',v_zone,true);
  FOR v_from,v_to,v_due,v_hours IN SELECT * FROM (VALUES
   ('2026-03-02 08:00Z'::timestamptz,'2026-03-09 07:00Z'::timestamptz,'2026-03-09 09:00Z'::timestamptz,167),
   ('2026-10-26 07:00Z'::timestamptz,'2026-11-02 08:00Z'::timestamptz,'2026-11-02 10:00Z'::timestamptz,169))d(f,t,d,h) LOOP
   PERFORM assert_true(fn_union_week_start(v_from+interval '8 days')=v_to
    AND fn_union_accounting_run_at(v_to)=v_due AND extract(epoch FROM v_to-v_from)/3600=v_hours,
    'actual calendar preserves DST earning interval and Chicago due instant in '||v_zone);
  END LOOP;
 END LOOP;
END $calendar$;
SET timezone='UTC';
