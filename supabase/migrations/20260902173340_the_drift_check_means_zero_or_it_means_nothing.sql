-- Applied to production 2026-09-02 17:33 UTC.
--
-- A check that permanently reports 139 known-benign rows is a check people
-- learn to ignore, and this repo has already paid for that lesson.
--
-- fn_spin_ladder_drift_check returned 139 after the back-pay. Every one was a
-- CANCELLED Spin from 2026-07-24 to 2026-08-19 carrying the overwritten
-- winner-take-all ladder. Cancelled games refund the buy-in and pay no prize -
-- verified: zero of the 139 had a single non-zero prize on any seat - so there
-- was no money in this and nothing to back-pay.
--
-- They are corrected anyway, so that "drift is zero" is a statement someone can
-- rely on. A signal with a standing exception is not a signal.
DO $fix$
DECLARE
  v_fixed int := 0;
  v_paid  int := 0;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- Refuse to touch anything that actually paid a prize: that would be a
  -- money-bearing row and it does not belong in a cosmetic correction.
  SELECT count(*) INTO v_paid
    FROM public.tournaments t
   WHERE upper(COALESCE(t.tournament_type,'')) = 'SPIN'
     AND upper(COALESCE(t.status,'')) IN ('CANCELLED','CANCELED')
     AND EXISTS (SELECT 1 FROM public.tournament_players tp
                  WHERE tp.tournament_id = t.id AND COALESCE(tp.prize,0) > 0);

  IF v_paid > 0 THEN
    RAISE EXCEPTION 'ABORT: % cancelled Spin(s) have a non-zero prize; this is not cosmetic.', v_paid;
  END IF;

  WITH upd AS (
    UPDATE public.tournaments t
       SET payout_structure = l.structure::text
      FROM public.spin_payout_ladder l
     WHERE l.multiplier = t.spin_multiplier
       AND upper(COALESCE(t.tournament_type,'')) = 'SPIN'
       AND upper(COALESCE(t.status,'')) IN ('CANCELLED','CANCELED')
       AND NULLIF(btrim(COALESCE(t.payout_structure,'')),'')::jsonb IS DISTINCT FROM l.structure
    RETURNING t.id )
  SELECT count(*) INTO v_fixed FROM upd;

  RAISE NOTICE 'Cancelled-Spin ladders corrected: %', v_fixed;
END
$fix$;
