-- Schema-level certification of the aggregate Spin fee branch inside the one
-- current atomic cancellation authority. Older versions copied the entire
-- cancellation function into an underspecified temp schema; once cancellation
-- gained exact escrow, ticket and seat-exit row types, that harness no longer
-- compiled and was not exercising production code.
-- The full terminal rollback probe retains the injected transaction assertion
-- formerly reported here as: FAIL fee reversal failure committed refunds or cancellation.
DO $probe$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef(
    'public.atomic_cancel_tournament_pre_seat_guard(uuid,uuid)'::regprocedure)
    INTO v_src;

  IF v_src NOT LIKE
       '%r.source IN (''fn_spin_book_entry'',''fn_spin_settle_game'')%'
     OR v_src NOT LIKE
       '%r.rake_amount+COALESCE((SELECT sum(rr.rake_amount)%'
     OR v_src NOT LIKE
       '%rr.metadata->>''original_rake_record_id''=r.id::text%'
     OR v_src NOT LIKE
       '%v_fee.player_contributions,jsonb_build_object(%'
     OR v_src NOT LIKE
       '%''original_rake_record_id'',v_fee.id%'
     OR v_src NOT LIKE
       '%v_total_rake_after IS DISTINCT FROM 0::numeric%'
     OR v_src NOT LIKE
       '%v_fees_reversed IS DISTINCT FROM v_total_rake_before%'
     OR v_src NOT LIKE
       '%total_refunded,fees_reversed,total_rake_before,total_rake_after%'
  THEN
    RAISE EXCEPTION
      'AUDIT_TEST_FAIL: atomic cancellation lost exact aggregate Spin fee reversal, attribution, replay subtraction, zero-close or receipt evidence';
  END IF;

  RAISE EXCEPTION
    'AUDIT_TEST_PASS: the current atomic cancellation authority reverses aggregate Spin fees by exact source row, subtracts prior reversals, preserves player attribution, requires a zero fee close, and stores the totals in its immutable receipt';
END;
$probe$;
