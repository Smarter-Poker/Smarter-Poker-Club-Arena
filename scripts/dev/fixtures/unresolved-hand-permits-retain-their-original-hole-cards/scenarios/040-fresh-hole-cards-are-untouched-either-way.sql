-- KEPT. (c) A hole card inside the 24-hour window is untouched, with a reserved
-- permit and without one. The age boundary itself must not move in either
-- direction: the repair adds a retention, it does not delete anything sooner.
\set ON_ERROR_STOP on
DO $s$
DECLARE t uuid := probe.table_of('fresh');
        before_cnt bigint; after_cnt bigint;
BEGIN
  PERFORM probe.deal(t, 8001, interval '1 hour', 2);   -- fresh, reserved permit
  PERFORM probe.permit(t, 8001, 'reserved');
  PERFORM probe.deal(t, 8002, interval '1 hour', 2);   -- fresh, no permit
  PERFORM probe.deal(t, 8003, interval '23 hours 59 minutes', 2); -- fresh, terminal permit
  PERFORM probe.permit(t, 8003, 'accepted');

  before_cnt := probe.cards(t, 8001) + probe.cards(t, 8002) + probe.cards(t, 8003);
  PERFORM probe.cleanup();
  after_cnt := probe.cards(t, 8001) + probe.cards(t, 8002) + probe.cards(t, 8003);

  PERFORM probe.census('c_fresh_cards', before_cnt, after_cnt);
  PERFORM probe.check(before_cnt = 6, 'six fresh hole cards were dealt');
  PERFORM probe.check(probe.cards(t, 8001) = 2, 'a <24h card with a reserved permit is untouched');
  PERFORM probe.check(probe.cards(t, 8002) = 2, 'a <24h card with no permit is untouched');
  PERFORM probe.check(probe.cards(t, 8003) = 2, 'a <24h card with a terminal permit is untouched');
  PERFORM probe.check(after_cnt = 6,
    'every <24h hole card is untouched (was ' || before_cnt || ', now ' || after_cnt || ')');
END $s$;
