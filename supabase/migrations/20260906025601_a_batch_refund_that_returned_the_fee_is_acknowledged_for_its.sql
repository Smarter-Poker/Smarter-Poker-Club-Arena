-- A BATCH REFUND THAT RETURNED THE FEE IS ACKNOWLEDGED FOR ITS RAKE.
--
-- The 02:00 conservation run - the first after the overlay fix - filed three
-- new warnings, and they are the whole remaining class. Sunday Deep Stack
-- Satellite $10 at -1.00, Sunday Deep Stack Satellite $5 at -0.50, Turbo
-- Tuesday Graveyard at -0.30. Read against the rows the pattern is exact: in
-- each case the delta is the buy-in FEE of a single entry, and in each case
-- there is one refund crediting buy-in AND fee.
--
--   $10 satellite   250.00 in, 25.00 rake, 216.00 prizes, 10.00 refunded  -1.00
--   $5 satellite    125.00 in, 12.50 rake, 108.00 prizes,  5.00 refunded  -0.50
--   Turbo Tuesday    75.00 in,  7.50 rake,  64.80 prizes,  3.00 refunded  -0.30
--
-- All three refunds carry the same timestamp - 2026-08-30 20:10:35.354738 - and
-- the description "[club wallet]". They are one batch repair, not three
-- unregistrations. The LIVE unregister path is not at fault and needs no
-- change: fn_unregister_from_tournament already writes the offsetting row
--
--   INSERT INTO rake_records (..., rake_amount, is_tournament, tournament_id,
--     source) VALUES (..., -v_split.rake, true, p_tournament_id,
--     'fn_unregister_from_tournament', ...)
--
-- so an ordinary unregistration reverses the fee's rake with the refund. The
-- batch returned the fee and left the rake standing. The house therefore holds
-- 1.80 chips of rake on three entries whose fee it gave back.
--
-- WHY ACKNOWLEDGED AND NOT REVERSED. Reversing means writing three negative
-- rake rows a week after the fact, and rake_records carries eight triggers -
-- VIP points, club daily rake, the reporting rollups and the tournament escrow
-- among them. A negative fee row against a COMPLETED event's closed escrow is
-- the exact shape that produced two escrow_short refusals during Phase 5.3.
-- 1.80 chips is not worth reaching into settled attribution and a closed
-- escrow, and 10.9 is clear that a settled record is corrected forward rather
-- than edited quiet. Nothing is taken back from the three players either; they
-- keep the fee they were refunded.
--
-- So the 1.80 is recorded the same way the 39,685.56 of pre-trigger guarantees
-- was recorded an hour ago: named, measured, and visible as data.

BEGIN;

DO $ack$
DECLARE
  v_total numeric;
  v_left  int;
BEGIN
  CREATE TEMP TABLE zz_fee_pop ON COMMIT DROP AS
  SELECT t.id AS tournament_id,
         round(-public.fn_tournament_conservation_delta(t.id), 2) AS shortfall
    FROM public.tournaments t
   WHERE t.id IN ('5e28ae4e-0016-4a26-bde3-7c828caa093c',
                  '5fedc8d4-e462-4dc7-a0a6-be05554cc952',
                  '8a686151-f1a8-4a0b-822d-03a3a1c852b0');

  SELECT round(sum(shortfall), 2) INTO v_total FROM zz_fee_pop;
  IF v_total <> 1.80 THEN
    RAISE EXCEPTION 'the three events are % chips short, not the measured 1.80', v_total;
  END IF;

  -- Each one must be exactly one entry's fee, or this is not the case I read.
  IF EXISTS (
    SELECT 1 FROM zz_fee_pop p JOIN public.tournaments t ON t.id = p.tournament_id
     WHERE p.shortfall <> round(t.buy_in_fee, 2))
  THEN
    RAISE EXCEPTION 'a shortfall is not one entry fee - the reading is wrong';
  END IF;

  INSERT INTO public.tournament_conservation_baseline (tournament_id, amount, reason, recorded_at)
  SELECT p.tournament_id, p.shortfall,
         'the batch unregister refund of 2026-08-30 20:10:35 returned buy-in AND fee but did '
         || 'not write the offsetting rake row the live unregister path writes; the house holds '
         || 'one entry fee of rake it refunded. Acknowledged 2026-09-06 (3 events, 1.80 chips). '
         || 'Not reversed: a negative fee row against a completed event''s closed escrow is the '
         || 'shape that refused twice in Phase 5.3, and 1.80 chips does not justify reaching '
         || 'into settled rake attribution. The players keep the fee.',
         now()
    FROM zz_fee_pop p
  ON CONFLICT (tournament_id) DO UPDATE
     SET amount = public.tournament_conservation_baseline.amount + EXCLUDED.amount,
         reason = public.tournament_conservation_baseline.reason || ' | ' || EXCLUDED.reason,
         recorded_at = now();

  SELECT count(*) INTO v_left FROM zz_fee_pop p
   WHERE abs(COALESCE(public.fn_tournament_conservation_delta(p.tournament_id), 999)) > 0.05;
  IF v_left > 0 THEN
    RAISE EXCEPTION '% of the three still do not read flat', v_left;
  END IF;

  UPDATE public.financial_alerts fa
     SET resolved = true, resolved_at = now(),
         resolution = 'verified: the shortfall is one entry fee per event, refunded by the batch '
                   || 'repair of 2026-08-30 without the offsetting rake row. Acknowledged in '
                   || 'tournament_conservation_baseline by migration 20260906025601; the live '
                   || 'unregister path already writes that row and needs no change.'
   WHERE fa.source = 'fn_tournament_money_conservation'
     AND fa.resolved IS NOT TRUE
     AND (fa.context->>'tournament_id')::uuid IN (SELECT tournament_id FROM zz_fee_pop);

  RAISE NOTICE 'FEE_REFUND_BACKLOG_ACKNOWLEDGED: 3 events, % chips', v_total;
END $ack$;

COMMIT;
