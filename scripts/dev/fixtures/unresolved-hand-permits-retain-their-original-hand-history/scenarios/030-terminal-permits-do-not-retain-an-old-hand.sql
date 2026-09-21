-- KEPT. (b) part two. Every terminal state of f06_hand_permits_state_check -
-- 'accepted', 'never_started', 'aborted_unsettled' - means the owning
-- disposition has been decided, so those hands prune on age as before. If any
-- of these were treated as unresolved the retention would never end.
\set ON_ERROR_STOP on
DO $s$
DECLARE t uuid := probe.table_of('terminal-old');
        s_state text; hand bigint := 12960000; h uuid;
        b bigint := 0; a bigint := 0;
        ids uuid[] := '{}';
BEGIN
  FOREACH s_state IN ARRAY ARRAY['accepted','never_started','aborted_unsettled'] LOOP
    hand := hand + 1;
    h := probe.hand(t, hand, interval '9 days');
    PERFORM probe.permit(t, hand, s_state);
    ids := ids || h;
    b := b + probe.rows(h);
  END LOOP;

  PERFORM probe.prune();

  FOR i IN 1..array_length(ids, 1) LOOP
    a := a + probe.rows(ids[i]);
    PERFORM probe.check(probe.rows(ids[i]) = 0,
      'a >8d hand whose permit is terminal is still DELETED from all four tables');
  END LOOP;

  PERFORM probe.census('b_terminal_permit_all_four_tables', b, a);
  PERFORM probe.check(b = 18, 'three terminal-state hands across four tables (3 x 6)');
  PERFORM probe.check(a = 0, 'no terminal-state hand survived');
END $s$;
