-- KEPT. (b) part one. A hand past the boundary with no F06 permit at all is
-- resolved by definition, so all four tables are pruned exactly as before.
-- This is the direction that must never regress into unbounded retention.
\set ON_ERROR_STOP on
DO $s$
DECLARE t uuid := probe.table_of('no-permit-old');
        h uuid; b bigint; a bigint;
BEGIN
  h := probe.hand(t, 12950001, interval '9 days');
  b := probe.rows(h);
  PERFORM probe.prune();
  a := probe.rows(h);
  PERFORM probe.census('b_no_permit_all_four_tables', b, a);
  PERFORM probe.check(b = 6, 'the hand was written to all four tables (1+1+2+2)');
  PERFORM probe.check(probe.hh(h) = 0, 'its hand_history row is still DELETED');
  PERFORM probe.check(probe.hac(h) = 0, 'its hand_atomic_commits row is still DELETED');
  PERFORM probe.check(probe.rake(h) = 0, 'its rake_attributions rows are still DELETED');
  PERFORM probe.check(probe.idx(h) = 0, 'its ca_hand_player_idx rows are still DELETED');
  PERFORM probe.check(a = 0, 'nothing of a permitless old hand survived');
END $s$;
