-- KEPT. (f) Condition 5 fails: the durable balance no longer equals that
-- player's pre-hand total, so the pot is NOT purely inside state_json and the
-- abort would not be inert. Seat and roster are moved together, because the
-- function's own roster assertion requires table_seats.stack = chips; that
-- makes this refuse at the EXISTING snapshot assertion, upstream of the card
-- test, so the gate is asked directly as well.
\set ON_ERROR_STOP on
BEGIN;
UPDATE public.tournament_players SET chips=41000
 WHERE user_id='aaaa1111-0000-4000-8000-000000000001';
UPDATE public.table_seats SET stack=41000
 WHERE id='aaaa0003-0000-4000-8000-000000000001';
UPDATE public.tournament_players SET chips=41000
 WHERE user_id='bbbb2222-0000-4000-8000-000000000001';
UPDATE public.table_seats SET stack=41000
 WHERE id='bbbb0003-0000-4000-8000-000000000001';
SELECT probe.expect_inert_both(false, 'condition 5 fails: durable chips 41000 <> stack 0 + totalInvested 40000');
SELECT probe.expect_both('REFUSED', 'zero cards but a durable chip mismatch');
COMMIT;
