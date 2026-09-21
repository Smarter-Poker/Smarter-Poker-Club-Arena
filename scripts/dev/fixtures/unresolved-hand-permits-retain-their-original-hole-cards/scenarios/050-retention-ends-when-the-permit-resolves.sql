-- FIXED. (d) Retention is not permanent. The same card is retained while the
-- permit is 'reserved' and deleted by the very next cleanup once the permit
-- reaches a terminal state. On the live body the first cleanup already destroys
-- it, so the retained half of this scenario fails today.
\set ON_ERROR_STOP on
DO $s$
DECLARE t uuid := probe.table_of('resolves');
        before_cnt bigint; held_cnt bigint; after_cnt bigint;
BEGIN
  PERFORM probe.deal(t, 9001, interval '30 hours', 2);
  PERFORM probe.permit(t, 9001, 'reserved');
  before_cnt := probe.cards(t, 9001);

  PERFORM probe.cleanup();                        -- while unresolved
  held_cnt := probe.cards(t, 9001);
  PERFORM probe.census('d_while_reserved', before_cnt, held_cnt);
  PERFORM probe.check(held_cnt = 2,
    'while the permit is reserved the card is retained (was ' || before_cnt
    || ', now ' || held_cnt || ')');

  PERFORM probe.permit(t, 9001, 'aborted_unsettled');  -- the disposition resolves
  PERFORM probe.cleanup();                             -- the next ordinary run
  after_cnt := probe.cards(t, 9001);

  PERFORM probe.census('d_after_terminal', held_cnt, after_cnt);
  PERFORM probe.check(after_cnt = 0,
    'once the permit is terminal the next cleanup DOES delete the card (was '
    || held_cnt || ', now ' || after_cnt || ')');
END $s$;
