-- KEPT. The retention is keyed on the exact (table_id, hand_number), not on
-- the table and not on the tournament. A reserved permit on a neighbouring
-- hand, or on another table, must not save this hand from the prune.
\set ON_ERROR_STOP on
DO $s$
DECLARE t uuid := probe.table_of('elsewhere');
        other uuid := probe.table_of('elsewhere-other');
        doomed uuid; b bigint; a bigint;
BEGIN
  -- the hand under test: no permit of its own
  doomed := probe.hand(t, 12990001, interval '9 days');
  -- a reserved permit on the NEXT hand number of the same table
  PERFORM probe.hand(t, 12990002, interval '9 days');
  PERFORM probe.permit(t, 12990002, 'reserved');
  -- and a reserved permit on a different table at the SAME hand number
  PERFORM probe.hand(other, 12990003, interval '9 days');
  PERFORM probe.permit(other, 12990001, 'reserved');

  b := probe.rows(doomed);
  PERFORM probe.prune();
  a := probe.rows(doomed);

  PERFORM probe.census('e_reserved_elsewhere_all_four_tables', b, a);
  PERFORM probe.check(b = 6, 'the hand under test was written to all four tables');
  PERFORM probe.check(a = 0,
    'a reserved permit on another hand or another table retains nothing here (was '
    || b || ', now ' || a || ')');
END $s$;
