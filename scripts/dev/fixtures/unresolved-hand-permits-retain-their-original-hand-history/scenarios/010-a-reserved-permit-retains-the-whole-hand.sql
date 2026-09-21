-- FIXED. (a) A hand past the 8-day prune boundary whose F06 permit is still
-- 'reserved' must survive job 117, in EVERY table the prune deletes from:
-- hand_history, hand_atomic_commits, rake_attributions and ca_hand_player_idx.
-- On the live body it does not - the candidate set is chosen on age and the
-- four DELETEs follow - so the originals
-- smarter_private.f06_retired_origin_snapshot and
-- smarter_private.f06_retained_mtt_abort_snapshot read are destroyed. This is
-- the same class of loss cleanup_old_hole_cards inflicted on Noon hand 12942021.
\set ON_ERROR_STOP on
DO $s$
DECLARE t uuid := probe.table_of('reserved-old');
        h uuid; sibling uuid;
        b_hh bigint; b_hac bigint; b_rake bigint; b_idx bigint;
        a_hh bigint; a_hac bigint; a_rake bigint; a_idx bigint;
BEGIN
  h := probe.hand(t, 12942021, interval '9 days');
  PERFORM probe.permit(t, 12942021, 'reserved');
  -- the same table, the same age, no permit: this one must still go, in the
  -- same call, so the retention is proven precise and not table-wide.
  sibling := probe.hand(t, 12942022, interval '9 days');

  b_hh := probe.hh(h); b_hac := probe.hac(h); b_rake := probe.rake(h); b_idx := probe.idx(h);
  PERFORM probe.prune();
  a_hh := probe.hh(h); a_hac := probe.hac(h); a_rake := probe.rake(h); a_idx := probe.idx(h);

  PERFORM probe.census('a_reserved_hand_history',   b_hh,   a_hh);
  PERFORM probe.census('a_reserved_atomic_commits', b_hac,  a_hac);
  PERFORM probe.census('a_reserved_rake_attrib',    b_rake, a_rake);
  PERFORM probe.census('a_reserved_player_idx',     b_idx,  a_idx);

  PERFORM probe.check(b_hh = 1 AND b_hac = 1 AND b_rake = 2 AND b_idx = 2,
    'the unresolved hand was written to all four tables');
  PERFORM probe.check(a_hh = 1,
    'a >8d hand_history row whose hand has a reserved permit is RETAINED (was '
    || b_hh || ', now ' || a_hh || ')');
  PERFORM probe.check(a_hac = 1,
    'its hand_atomic_commits row is RETAINED (was ' || b_hac || ', now ' || a_hac || ')');
  PERFORM probe.check(a_rake = 2,
    'its rake_attributions rows are RETAINED (was ' || b_rake || ', now ' || a_rake || ')');
  PERFORM probe.check(a_idx = 2,
    'its ca_hand_player_idx rows are RETAINED (was ' || b_idx || ', now ' || a_idx || ')');
  PERFORM probe.check(probe.rows(sibling) = 0,
    'the same-table same-age hand with no permit is DELETED by the same call');
END $s$;
