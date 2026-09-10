\set ON_ERROR_STOP on

SELECT :'scenario'='eligible' AS eligible \gset

\if :eligible
DO $eligible_pending_zero_cutover$
DECLARE
  v_before integer[];
  v_after integer[];
BEGIN
  IF (SELECT count(*)
        FROM public.tournament_pending_zero_seat_cutover_receipts)<>2
     OR (SELECT current_players
           FROM public.tables
          WHERE id='20000000-0000-4000-8000-000000000001')<>1
     OR (SELECT count(*) FROM public.table_seats WHERE left_at IS NULL)<>1
     OR (SELECT count(*) FROM public.table_seats
          WHERE id IN (
            '40000000-0000-4000-8000-000000000001',
            '40000000-0000-4000-8000-000000000002')
            AND stack=0 AND left_at IS NOT NULL AND status='left'
            AND leave_pending IS FALSE AND is_sitting_out IS FALSE
            AND is_away IS FALSE AND sit_out_at IS NULL
            AND scheduled_leave_hands IS NULL)<>2
     OR (SELECT count(*) FROM public.tournament_players
          WHERE id IN (
            '50000000-0000-4000-8000-000000000001',
            '50000000-0000-4000-8000-000000000002')
            AND status='playing' AND chips=0)<>2
     OR (SELECT count(*) FROM public.tournament_knockout_candidates
          WHERE id IN (
            '60000000-0000-4000-8000-000000000001',
            '60000000-0000-4000-8000-000000000002')
            AND state='pending' AND resolved_at IS NULL AND stack_after=0)<>2
     OR EXISTS (
       SELECT 1
         FROM public.tournament_players tp
         JOIN public.tables tb ON tb.tournament_id=tp.tournament_id
         JOIN public.table_seats s
           ON s.table_id=tb.id AND s.user_id=tp.user_id AND s.left_at IS NULL
        WHERE tp.status='playing' AND tp.chips=0) THEN
    RAISE EXCEPTION 'eligible pending-zero cutover did not converge exactly';
  END IF;

  SELECT array_agg(table_live_seats_before ORDER BY zero_committed_at),
         array_agg(table_live_seats_after ORDER BY zero_committed_at)
    INTO v_before,v_after
    FROM public.tournament_pending_zero_seat_cutover_receipts;
  IF v_before IS DISTINCT FROM ARRAY[3,2]
     OR v_after IS DISTINCT FROM ARRAY[2,1]
     OR EXISTS (
       SELECT 1
         FROM public.tournament_pending_zero_seat_cutover_receipts r
        WHERE r.table_current_players_before IS DISTINCT FROM
                r.table_live_seats_before
           OR r.table_current_players_after IS DISTINCT FROM
                r.table_live_seats_after
           OR r.vacated_at<=r.vacated_joined_at)
     OR (SELECT array_agg(seat_stack_before ORDER BY candidate_id)
           FROM public.tournament_pending_zero_seat_cutover_receipts)
          IS DISTINCT FROM ARRAY[115000,12000]::numeric[] THEN
    RAISE EXCEPTION 'pending-zero receipts lost exact two-seat count chronology';
  END IF;
END;
$eligible_pending_zero_cutover$;

SELECT 'M6_PENDING_ZERO_ELIGIBLE_TWO_SEAT_PASS';
\else
DO $refused_pending_zero_cutover$
BEGIN
  IF to_regclass(
       'public.tournament_pending_zero_seat_cutover_receipts') IS NOT NULL
     OR (SELECT current_players
           FROM public.tables
          WHERE id='20000000-0000-4000-8000-000000000001')<>2
     OR NOT EXISTS (
       SELECT 1
         FROM public.table_seats
        WHERE id='40000000-0000-4000-8000-000000000001'
          AND stack=115000 AND left_at IS NULL AND status='active')
     OR NOT EXISTS (
       SELECT 1
         FROM public.tournament_players
        WHERE id='50000000-0000-4000-8000-000000000001'
          AND status='playing' AND chips=0)
     OR NOT EXISTS (
       SELECT 1
         FROM public.tournament_knockout_candidates
        WHERE id='60000000-0000-4000-8000-000000000001'
          AND state='pending' AND resolved_at IS NULL AND stack_after=0) THEN
    RAISE EXCEPTION 'refused pending-zero cutover did not roll back whole';
  END IF;
END;
$refused_pending_zero_cutover$;

SELECT CASE :'scenario'
  WHEN 'funding' THEN 'M6_PENDING_ZERO_FUNDING_REFUSAL_ROLLBACK_PASS'
  WHEN 'later' THEN 'M6_PENDING_ZERO_LATER_HAND_REFUSAL_ROLLBACK_PASS'
  ELSE 'M6_PENDING_ZERO_UNKNOWN_SCENARIO'
END;
\endif
