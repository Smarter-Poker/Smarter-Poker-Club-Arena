-- KEPT. (b) part two. Every terminal state of f06_hand_permits_state_check -
-- 'accepted', 'never_started', 'aborted_unsettled' - means the owning
-- disposition has been decided, so those hands are deleted on age as before.
-- If any of these were treated as unresolved the retention would never end.
\set ON_ERROR_STOP on
DO $s$
DECLARE t uuid := probe.table_of('terminal-old');
        s_state text; hand bigint := 7000;
        before_cnt bigint; after_cnt bigint;
BEGIN
  FOREACH s_state IN ARRAY ARRAY['accepted','never_started','aborted_unsettled'] LOOP
    hand := hand + 1;
    PERFORM probe.deal(t, hand, interval '25 hours', 2);
    PERFORM probe.permit(t, hand, s_state);
  END LOOP;

  hand := 7000;
  before_cnt := 0;
  FOREACH s_state IN ARRAY ARRAY['accepted','never_started','aborted_unsettled'] LOOP
    hand := hand + 1;
    before_cnt := before_cnt + probe.cards(t, hand);
  END LOOP;

  PERFORM probe.cleanup();

  hand := 7000;
  after_cnt := 0;
  FOREACH s_state IN ARRAY ARRAY['accepted','never_started','aborted_unsettled'] LOOP
    hand := hand + 1;
    after_cnt := after_cnt + probe.cards(t, hand);
    PERFORM probe.check(probe.cards(t, hand) = 0,
      'a >24h hole card whose permit is terminal (' || s_state || ') is still DELETED');
  END LOOP;

  PERFORM probe.census('b_terminal_permit_old_card', before_cnt, after_cnt);
  PERFORM probe.check(before_cnt = 6, 'six hole cards across the three terminal states');
  PERFORM probe.check(after_cnt = 0, 'no terminal-state hole card survived');
END $s$;
