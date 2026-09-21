-- Rows that exist only so the migration's own executable proof is not vacuous
-- when the probe applies it: one permit in every state
-- f06_hand_permits_state_check admits, and a hand on both sides of the prune
-- boundary for each. The scenarios never read these hands, and the probe
-- asserts that the migration reported having seen all four states.
\set ON_ERROR_STOP on
DO $seed$
DECLARE t uuid := probe.table_of('proof-seed');
        s text;
        hand bigint := 9600000;
BEGIN
  FOREACH s IN ARRAY ARRAY['reserved','accepted','never_started','aborted_unsettled'] LOOP
    hand := hand + 1;
    PERFORM probe.hand(t, hand, interval '9 days');
    PERFORM probe.permit(t, hand, s);
    hand := hand + 1;
    PERFORM probe.hand(t, hand, interval '2 hours');
    PERFORM probe.permit(t, hand, s);
  END LOOP;
  -- and one hand with no permit at all, on each side of the boundary
  PERFORM probe.hand(t, 9699001, interval '9 days');
  PERFORM probe.hand(t, 9699002, interval '2 hours');
END $seed$;
