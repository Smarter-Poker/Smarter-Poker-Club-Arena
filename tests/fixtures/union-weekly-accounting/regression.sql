\set ON_ERROR_STOP on
SET timezone='UTC';
CREATE FUNCTION public.test_clock() RETURNS timestamptz LANGUAGE sql AS $$SELECT current_setting('test.clock')::timestamptz$$;
DO $$ DECLARE d text; BEGIN
  SELECT pg_get_functiondef('fn_union_settlement_cascade_due()'::regprocedure) INTO d;
  EXECUTE replace(d,'clock_timestamp()','public.test_clock()');
END $$;
SET test.clock='2026-09-14T09:20:00Z';
DO $tests$
DECLARE
  u uuid:='10000000-0000-0000-0000-000000000001';
  c uuid:='20000000-0000-0000-0000-000000000001';
  f timestamptz:='2026-09-07T07:00:00Z'; t timestamptz:='2026-09-14T07:00:00Z';
  j jsonb; old jsonb; i integer; cases integer:=0;
BEGIN
  INSERT INTO unions VALUES(u);
  INSERT INTO union_settlement_floor VALUES(u,'2026-09-07T00:00Z');
  INSERT INTO union_clubs VALUES(u,c);
  INSERT INTO settlement_invoices VALUES(c,'union_weekly_squareup',jsonb_build_object('union_id',u,'period_start',f,'period_end',t),true,'generated');

  FOR i IN 1..4 LOOP
    SELECT result INTO old FROM fixture WHERE stage=i;
    UPDATE fixture SET result=result||'{"success":false,"error":"injected_failure"}' WHERE stage=i;
    BEGIN
      PERFORM fn_union_settlement_cascade(u,f,t);
      RAISE EXCEPTION 'TEST FAIL: stage % failure committed',i;
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM<>'union_settlement_incomplete' THEN RAISE; END IF;
    END;
    IF EXISTS(SELECT 1 FROM effects) OR EXISTS(SELECT 1 FROM union_settlement_rounds) THEN
      RAISE EXCEPTION 'TEST FAIL: stage % left effects behind',i;
    END IF;
    UPDATE fixture SET result=old WHERE stage=i;
    cases:=cases+1;
  END LOOP;
  FOR i IN 2..3 LOOP
    UPDATE fixture SET result=jsonb_set(result,'{shortfalls}','1') WHERE stage=i;
    BEGIN
      PERFORM fn_union_settlement_cascade(u,f,t);
      RAISE EXCEPTION 'TEST FAIL: shortfall committed';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM<>'union_settlement_incomplete' THEN RAISE; END IF;
    END;
    IF EXISTS(SELECT 1 FROM effects) THEN RAISE EXCEPTION 'TEST FAIL: shortfall kept transfers'; END IF;
    UPDATE fixture SET result=jsonb_set(result,'{shortfalls}','0') WHERE stage=i;
    cases:=cases+1;
  END LOOP;
  UPDATE settlement_invoices SET message_sent=false;
  BEGIN
    PERFORM fn_union_settlement_cascade(u,f,t);
    RAISE EXCEPTION 'TEST FAIL: undelivered invoice committed';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'union_invoice_delivery_incomplete' THEN RAISE; END IF; END;
  IF EXISTS(SELECT 1 FROM effects) THEN RAISE EXCEPTION 'TEST FAIL: delivery failure kept transfers'; END IF;
  UPDATE settlement_invoices SET message_sent=true;
  cases:=cases+1;

  INSERT INTO rakeback_periods VALUES(u,'2026-09-07','2026-09-13','pending',117188.36);
  j:=fn_union_settlement_cascade_due();
  IF j->>'success'<>'false' OR NOT EXISTS(SELECT 1 FROM union_accounting_runs WHERE status='failed')
    OR EXISTS(SELECT 1 FROM effects) THEN RAISE EXCEPTION 'TEST FAIL: orphan accounting %',j; END IF;
  IF (SELECT count(*) FROM financial_alerts)<>1 THEN RAISE EXCEPTION 'TEST FAIL: missing durable failure'; END IF;
  j:=fn_union_settlement_cascade_due();
  IF (SELECT count(*) FROM financial_alerts)<>1 OR (SELECT attempts FROM union_accounting_runs)<>2 THEN
    RAISE EXCEPTION 'TEST FAIL: retry dedupe'; END IF;
  cases:=cases+2;
  DELETE FROM rakeback_periods;
  PERFORM set_config('test.clock','2026-09-14T08:59:59Z',true);
  j:=fn_union_settlement_cascade_due();
  IF (j->>'checked')::int<>0 OR EXISTS(SELECT 1 FROM effects) THEN RAISE EXCEPTION 'TEST FAIL: early run'; END IF;
  cases:=cases+1;
  -- A missed Monday still heals Friday; there is no three-day discard.
  PERFORM set_config('test.clock','2026-09-18T14:20:00Z',true);
  j:=fn_union_settlement_cascade_due();
  IF j->>'success'<>'true' OR (SELECT count(*) FROM effects)<>5
    OR (SELECT status FROM union_accounting_runs)<>'complete' THEN RAISE EXCEPTION 'TEST FAIL: Friday recovery %',j; END IF;
  j:=fn_union_settlement_cascade_due();
  IF (SELECT count(*) FROM effects)<>5 OR (j->>'checked')::int<>0 THEN RAISE EXCEPTION 'TEST FAIL: duplicate posting'; END IF;
  cases:=cases+2;
  -- Missing a full week recovers oldest first before the next week.
  DELETE FROM union_settlement_rounds;
  DELETE FROM union_accounting_runs;
  DELETE FROM effects;
  UPDATE fixture SET result='{"success":false,"error":"blocked_prior_week"}' WHERE stage=1;
  PERFORM set_config('test.clock','2026-09-21T09:20:00Z',true);
  j:=fn_union_settlement_cascade_due();
  IF (SELECT count(*) FROM union_accounting_runs)<>1 OR
    NOT EXISTS(SELECT 1 FROM union_accounting_runs WHERE period_start=f AND status='failed') THEN
    RAISE EXCEPTION 'TEST FAIL: old week skipped or newer period posted first'; END IF;
  cases:=cases+1;
  IF fn_union_accounting_run_at('2026-09-14T07:00Z')<>'2026-09-14T09:00Z'::timestamptz
    OR fn_union_accounting_run_at('2026-11-02T08:00Z')<>'2026-11-02T10:00Z'::timestamptz
    OR fn_union_accounting_run_at('2026-03-09T07:00Z')<>'2026-03-09T09:00Z'::timestamptz THEN
    RAISE EXCEPTION 'TEST FAIL: DST 4am'; END IF;
  cases:=cases+3;
  PERFORM set_config('test.is_engine','false',true);
  BEGIN PERFORM fn_union_settlement_cascade_due(); RAISE EXCEPTION 'TEST FAIL: unauthorized runner';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  cases:=cases+1;
  RAISE NOTICE 'PASS: % actual-body PostgreSQL assertions (round helpers stubbed; rollback, orphan detection, retry evidence, schedule, backlog, DST and authorization executed)',cases;
END $tests$;
