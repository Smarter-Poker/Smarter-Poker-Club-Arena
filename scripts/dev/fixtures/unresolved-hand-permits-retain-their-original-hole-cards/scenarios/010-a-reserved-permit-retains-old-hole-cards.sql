-- FIXED. (a) A hole card past the 24-hour boundary whose hand still holds a
-- 'reserved' F06 permit must survive the cleanup. On the live body it does not:
-- the DELETE is unconditional, so the only original witness for an unresolved
-- hand is destroyed. This is the Noon table 2c621856 hand 12942021 loss.
\set ON_ERROR_STOP on
DO $s$
DECLARE t uuid := probe.table_of('reserved-old');
        before_cnt bigint; after_cnt bigint;
BEGIN
  PERFORM probe.deal(t, 12942021, interval '25 hours', 2);
  PERFORM probe.permit(t, 12942021, 'reserved');
  before_cnt := probe.cards(t, 12942021);
  PERFORM probe.cleanup();
  after_cnt := probe.cards(t, 12942021);
  PERFORM probe.census('a_reserved_permit_old_card', before_cnt, after_cnt);
  PERFORM probe.check(before_cnt = 2, 'the unresolved hand was dealt two hole cards');
  PERFORM probe.check(after_cnt = 2,
    'a >24h hole card whose hand has a reserved permit is RETAINED (was ' || before_cnt
    || ', now ' || after_cnt || ')');
END $s$;
