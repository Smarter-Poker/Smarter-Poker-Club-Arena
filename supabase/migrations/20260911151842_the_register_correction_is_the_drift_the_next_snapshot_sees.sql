-- 20260911151842_the_register_correction_is_the_drift_the_next_snapshot_sees.sql
--
-- THE SECOND INCIDENT IS THE FIRST ONE'S FIX, SEEN BY A DELTA DETECTOR.
--
-- fn_ca_diamond_snapshot measures, hour by hour, how far player balances moved
-- against how far the Mint register moved. Migration 20260911150027 put one
-- compensating row into the register - a mint of 100 to smarterpoker, reversing
-- a retirement that never happened - and that row moves the register without
-- moving anybody's balance. So the very next measurement reads it as 100 of
-- drift the other way, and it did, exactly as predicted before it was run:
--
--   last snapshot 15:10:00Z, then:
--     basis moved                +58   (ordinary play)
--     register moved            +158   (that same 58, plus the 100 correction)
--     unexplained               -100
--
--   ca_drift_incidents 647c1dc6-99b1-4a21-9d77-2d733106f4e3, warning,
--   dedupe diamond-unexplained:2026-09-11-15
--
-- This is not a second defect and there is no second writer. It is arithmetic:
-- ANY correction to a register that a delta detector watches is visible once,
-- in the window it lands in. The snapshot was run deliberately, immediately
-- after the correction, so the figure would appear while somebody was looking
-- at it rather than at 16:10 in front of whoever was on next.
--
-- WHAT WAS NOT DONE. The detector was not taught to ignore rows with
-- origin 'operator', and its 50-diamond threshold was not raised. A detector
-- that cannot see the house's own corrections is a detector with a hole in it
-- shaped exactly like the next mistake. The correction is a real movement of
-- the register, it is measured like one, and it is explained here instead.

BEGIN;

DO $resolve_the_echo$
DECLARE v_amount numeric;
BEGIN
  SELECT discrepancy_amount INTO v_amount FROM public.ca_drift_incidents
   WHERE id = '647c1dc6-99b1-4a21-9d77-2d733106f4e3';
  IF v_amount IS NULL THEN
    RAISE EXCEPTION 'the follow-on drift incident is not there; do not resolve an incident you cannot read';
  END IF;
  IF v_amount <> -100 THEN
    RAISE EXCEPTION 'the follow-on incident is % , not the -100 the correction accounts for; read it before closing it', v_amount;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ca_mint_ledger
                  WHERE op_id = 'register-correction:wheel:84aba5a7-32e0-4aec-a1c2-d7fbdc32466b'
                    AND action = 'mint' AND amount = 100) THEN
    RAISE EXCEPTION 'the correction row this blames is not in the register; something else moved the 100';
  END IF;
END
$resolve_the_echo$;

UPDATE public.ca_drift_incidents
   SET status = 'resolved',
       root_cause = 'Not a writer. This is migration 20260911150027''s own correction row, ca_mint_ledger op_id register-correction:wheel:84aba5a7-32e0-4aec-a1c2-d7fbdc32466b, a mint of 100 to smarterpoker that reverses a retirement the Mint never performed. It moves the register and no balance, so a delta detector reads it as 100 of drift in the opposite direction exactly once, in the window it lands in.',
       correction_ref = 'migration 20260911150027; this incident is its echo, see ca_drift_incidents 1610f514-d6cc-40ca-b543-6daac6cb159c',
       resolution = 'Accepted as the arithmetic of correcting a register a delta detector watches. The snapshot was taken deliberately, minutes after the correction, so the figure appeared while it was being watched rather than at the next scheduled run. Nothing was excluded from the measurement and the 50-diamond threshold is unchanged: a detector that cannot see the house correcting its own books has a hole in it shaped like the next mistake. Player balances are untouched by both migrations. The window after this one should read zero, and if it does not, that is a new defect and not this.',
       resolved_at = now()
 WHERE id = '647c1dc6-99b1-4a21-9d77-2d733106f4e3'
   AND status <> 'resolved';

DO $assert_resolved$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_drift_incidents
              WHERE id IN ('1610f514-d6cc-40ca-b543-6daac6cb159c',
                           '647c1dc6-99b1-4a21-9d77-2d733106f4e3')
                AND status <> 'resolved') THEN
    RAISE EXCEPTION 'a diamond drift incident from this pair is still open';
  END IF;
END
$assert_resolved$;

COMMIT;
