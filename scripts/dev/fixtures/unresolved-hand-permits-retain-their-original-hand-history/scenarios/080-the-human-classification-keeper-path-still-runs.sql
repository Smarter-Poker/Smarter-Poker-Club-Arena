-- KEPT. The prune's other job: a hand past the boundary that turns out to seat
-- a non-horse player is not deleted but FLAGGED has_human=true, so it is never
-- reconsidered. Excluding unresolved hands from the candidate set must not
-- disturb that path for everybody else.
\set ON_ERROR_STOP on
DO $s$
DECLARE t uuid := probe.table_of('keepers');
        h uuid; flag text;
BEGIN
  h := probe.hand(t, 13010001, interval '9 days', true);  -- one human seat
  PERFORM probe.check(probe.human_flag(h) <> 'true', 'the hand starts unflagged');
  PERFORM probe.prune();
  flag := probe.human_flag(h);
  PERFORM probe.census('f_keeper_path_rows', 6, probe.rows(h));
  PERFORM probe.check(probe.rows(h) = 6, 'a human hand is retained, not deleted');
  PERFORM probe.check(flag = 'true',
    'a human hand is still flagged has_human=true by the keeper path (it is ' || flag || ')');
END $s$;
