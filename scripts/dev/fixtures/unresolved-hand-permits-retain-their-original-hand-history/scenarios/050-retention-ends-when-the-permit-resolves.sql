-- FIXED. (d) The retention is bounded, and bounded by the permit alone. While
-- the permit is 'reserved' the hand is retained AND its has_human flag is left
-- exactly as it was - the repair excludes the hand from the candidate set, so
-- it lands in neither v_doomed nor v_keepers. The moment the permit reaches a
-- terminal state the very next prune deletes it from all four tables. If the
-- repair had instead flagged has_human=true, this second prune would keep the
-- hand forever and the retention control would have been silently widened.
\set ON_ERROR_STOP on
DO $s$
DECLARE t uuid := probe.table_of('resolves');
        h uuid; b bigint; mid bigint; a bigint; flag text;
BEGIN
  h := probe.hand(t, 12980001, interval '9 days');
  PERFORM probe.permit(t, 12980001, 'reserved');

  b := probe.rows(h);
  PERFORM probe.prune();
  mid := probe.rows(h);
  flag := probe.human_flag(h);
  PERFORM probe.check(mid = 6,
    'while reserved the whole hand is retained (was ' || b || ', now ' || mid || ')');
  -- has_human has no default on production, so an untouched hand reads NULL.
  -- What matters is only that the prune did not promote it to true.
  PERFORM probe.check(flag <> 'true',
    'while retained, has_human is NOT rewritten to true (it is ' || flag || ')');

  -- The owning transition resolves; the hand is now ordinary history.
  PERFORM probe.permit(t, 12980001, 'accepted');
  PERFORM probe.prune();
  a := probe.rows(h);

  PERFORM probe.census('d_retention_ends_all_four_tables', mid, a);
  PERFORM probe.check(a = 0,
    'once the permit is terminal the next prune DELETES the hand from all four '
    || 'tables (was ' || mid || ', now ' || a || ')');
END $s$;
