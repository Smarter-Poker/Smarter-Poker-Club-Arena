-- KEPT. (c) Inside the 8-day boundary nothing is deleted, with or without a
-- permit. The age boundary itself is not what this repair changes.
\set ON_ERROR_STOP on
DO $s$
DECLARE t uuid := probe.table_of('recent');
        h_none uuid; h_res uuid; h_acc uuid; b bigint; a bigint;
BEGIN
  h_none := probe.hand(t, 12970001, interval '2 hours');
  h_res  := probe.hand(t, 12970002, interval '2 hours');
  PERFORM probe.permit(t, 12970002, 'reserved');
  h_acc  := probe.hand(t, 12970003, interval '2 hours');
  PERFORM probe.permit(t, 12970003, 'accepted');

  b := probe.rows(h_none) + probe.rows(h_res) + probe.rows(h_acc);
  PERFORM probe.prune();
  a := probe.rows(h_none) + probe.rows(h_res) + probe.rows(h_acc);

  PERFORM probe.census('c_recent_hands_all_four_tables', b, a);
  PERFORM probe.check(b = 18, 'three recent hands across four tables (3 x 6)');
  PERFORM probe.check(a = 18, 'every recent hand is untouched (was ' || b || ', now ' || a || ')');
END $s$;
