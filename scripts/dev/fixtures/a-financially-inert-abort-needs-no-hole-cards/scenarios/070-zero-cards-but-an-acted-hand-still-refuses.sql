-- KEPT. (g) Condition 4 fails: actionHistory is not empty, so the hand was
-- acted on and this is not an un-acted preflop. Refuses at the EXISTING
-- snapshot assertion, upstream of the card test; the gate is asked directly.
\set ON_ERROR_STOP on
BEGIN;
UPDATE public.hand_state_snapshots
   SET state_json = jsonb_set(state_json,'{actionHistory}','[{"action":"raise","seat":1}]'::jsonb)
 WHERE id IN ('aaaa0004-0000-4000-8000-000000000001','bbbb0004-0000-4000-8000-000000000001');
SELECT probe.expect_inert_both(false, 'condition 4 fails: actionHistory is not empty');
SELECT probe.expect_both('REFUSED', 'zero cards but a non-empty actionHistory');
COMMIT;
