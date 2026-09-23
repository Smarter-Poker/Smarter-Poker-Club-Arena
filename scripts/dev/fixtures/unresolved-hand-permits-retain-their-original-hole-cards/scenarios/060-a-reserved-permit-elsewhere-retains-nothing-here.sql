-- FIXED. The exemption is per exact (table_id, hand_number). A reserved permit
-- on another hand, or on the same hand number at another table, retains nothing
-- here: that is what keeps the retention from widening into "any table with an
-- unresolved hand keeps all of its cards". The doomed hand is deleted on both
-- bodies, but the two sibling claims are retention claims, so this scenario
-- cannot pass before the repair and is labelled FIXED for what it is.
\set ON_ERROR_STOP on
DO $s$
DECLARE t1 uuid := probe.table_of('elsewhere-a');
        t2 uuid := probe.table_of('elsewhere-b');
        before_cnt bigint; after_cnt bigint;
BEGIN
  PERFORM probe.deal(t1, 1101, interval '25 hours', 2);   -- doomed hand
  PERFORM probe.deal(t1, 1102, interval '25 hours', 2);   -- sibling hand, reserved
  PERFORM probe.permit(t1, 1102, 'reserved');
  PERFORM probe.deal(t2, 1101, interval '25 hours', 2);   -- same hand number, other table
  PERFORM probe.permit(t2, 1101, 'reserved');

  before_cnt := probe.cards(t1, 1101);
  PERFORM probe.cleanup();
  after_cnt := probe.cards(t1, 1101);

  PERFORM probe.census('precision_other_hand', before_cnt, after_cnt);
  PERFORM probe.check(after_cnt = 0,
    'a reserved permit on a sibling hand or another table retains nothing here (was '
    || before_cnt || ', now ' || after_cnt || ')');
  PERFORM probe.check(probe.cards(t1, 1102) = 2, 'the sibling hand with its own reserved permit is retained');
  PERFORM probe.check(probe.cards(t2, 1101) = 2, 'the other table''s reserved hand is retained');
END $s$;
