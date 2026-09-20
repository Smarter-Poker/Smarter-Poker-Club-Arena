-- Rows that exist only so the migration's own executable proof is not vacuous
-- when the probe applies it: one permit in every state f06_hand_permits_state_check
-- admits, and hole cards on both sides of the 24-hour boundary for each. The
-- scenarios never read these hands, and the probe asserts that the migration
-- reported having seen all four states.
\set ON_ERROR_STOP on
DO $seed$
DECLARE t uuid := probe.table_of('proof-seed');
        s text;
        hand bigint := 600000;
BEGIN
  FOREACH s IN ARRAY ARRAY['reserved','accepted','never_started','aborted_unsettled'] LOOP
    hand := hand + 1;
    PERFORM probe.deal(t, hand, interval '25 hours', 1);
    PERFORM probe.permit(t, hand, s);
    hand := hand + 1;
    PERFORM probe.deal(t, hand, interval '2 hours', 1);
    PERFORM probe.permit(t, hand, s);
  END LOOP;
  -- and one hand with no permit at all, on each side of the boundary
  PERFORM probe.deal(t, 699001, interval '25 hours', 1);
  PERFORM probe.deal(t, 699002, interval '2 hours', 1);
END $seed$;
