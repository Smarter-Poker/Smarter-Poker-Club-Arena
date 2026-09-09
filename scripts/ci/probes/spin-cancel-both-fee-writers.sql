-- Both historical aggregate Spin fee writers must remain inside the one
-- durable cancellation body. This is a schema certification probe; rollback
-- behavior is covered by the full terminal-cancellation transaction probe.
-- This replaces the stale temp-body branch formerly reported as:
-- FAIL alternate Spin fee writer was not reversed.
DO $probe$
DECLARE
  v_src text;
  v_writer_clause_count integer;
BEGIN
  SELECT pg_get_functiondef(
    'public.atomic_cancel_tournament_pre_seat_guard(uuid,uuid)'::regprocedure)
    INTO v_src;

  SELECT count(*) INTO v_writer_clause_count
    FROM regexp_matches(
      v_src,
      $re$r\.source IN \('fn_spin_book_entry','fn_spin_settle_game'\)$re$,
      'g');

  IF v_writer_clause_count <> 1
     OR v_src NOT LIKE '%''original_source'',v_fee.source%'
     OR v_src NOT LIKE '%''original_rake_record_id'',v_fee.id%'
     OR v_src NOT LIKE '%v_fee.player_contributions%'
     OR v_src NOT LIKE '%v_fee_reversal_ids:=array_append(%'
  THEN
    RAISE EXCEPTION
      'AUDIT_TEST_FAIL: one or both aggregate Spin fee writers are outside the exact attributed cancellation receipt';
  END IF;

  RAISE EXCEPTION
    'AUDIT_TEST_PASS: fn_spin_book_entry and fn_spin_settle_game share one exact attributed reversal branch and every reversal id is retained by the cancellation receipt';
END;
$probe$;
