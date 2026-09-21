-- KEPT. (b) part one. A hole card past the boundary whose hand has NO permit at
-- all is ordinary resolved evidence and must still be deleted. This is the
-- privacy/retention control the repair must not widen.
\set ON_ERROR_STOP on
DO $s$
DECLARE t uuid := probe.table_of('nopermit-old');
        before_cnt bigint; after_cnt bigint;
BEGIN
  PERFORM probe.deal(t, 5001, interval '25 hours', 3);
  before_cnt := probe.cards(t, 5001);
  PERFORM probe.cleanup();
  after_cnt := probe.cards(t, 5001);
  PERFORM probe.census('b_no_permit_old_card', before_cnt, after_cnt);
  PERFORM probe.check(before_cnt = 3, 'three hole cards were dealt');
  PERFORM probe.check(after_cnt = 0,
    'a >24h hole card with no permit is still DELETED (was ' || before_cnt
    || ', now ' || after_cnt || ')');
END $s$;
