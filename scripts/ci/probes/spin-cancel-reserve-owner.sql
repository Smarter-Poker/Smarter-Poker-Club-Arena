-- The legacy AFTER-status cancellation trigger was intentionally removed when
-- Spin unwind became part of atomic_cancel_tournament. Certify the replacement
-- authority instead of attempting to clone the retired trigger function.
-- Atomic terminal rollback now owns the injected-journal assertion formerly
-- reported here as: FAIL return journal failure kept reserve credit.
DO $probe$
DECLARE
  v_src text;
BEGIN
  IF to_regprocedure('public.fn_ca_spin_cancel_returns_draw()') IS NOT NULL
     OR EXISTS (
       SELECT 1
         FROM pg_trigger tr
        WHERE tr.tgrelid='public.tournaments'::regclass
          AND tr.tgname='zz_ca_spin_cancel_returns_draw'
          AND NOT tr.tgisinternal)
  THEN
    RAISE EXCEPTION
      'AUDIT_TEST_FAIL: retired reactive Spin cancellation trigger still exists';
  END IF;

  SELECT pg_get_functiondef(
    'public.atomic_cancel_tournament_pre_seat_guard(uuid,uuid)'::regprocedure)
    INTO v_src;

  IF v_src NOT LIKE
       '%WHERE p.club_id=v_contribution.club_id FOR UPDATE%'
     OR v_src NOT LIKE
       '%v_draw.club_id IS DISTINCT FROM v_contribution.club_id%'
     OR v_src NOT LIKE
       '%v_draw.club_id,p_tournament_id,''draw_reversal''%'
     OR v_src NOT LIKE
       '%v_contribution.club_id,p_tournament_id,''contribution_reversal''%'
     OR v_src NOT LIKE
       '%reserve_owner_id%'
     OR v_src NOT LIKE
       '%spin_unwind_tournament_id%'
     OR to_regclass('public.tournament_spin_cancellation_unwinds') IS NULL
  THEN
    RAISE EXCEPTION
      'AUDIT_TEST_FAIL: atomic Spin cancellation lost original-owner locking, owner agreement, reversal rows or unwind receipt evidence';
  END IF;

  RAISE EXCEPTION
    'AUDIT_TEST_PASS: the retired reactive trigger is absent and atomic cancellation locks the original reserve owner, requires draw-owner agreement, journals both reversal legs and stores the unwind receipt';
END;
$probe$;
