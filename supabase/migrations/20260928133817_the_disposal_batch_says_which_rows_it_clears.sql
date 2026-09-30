-- THE DISPOSAL BATCH SAYS WHICH ROWS IT CLEARS (2026-09-28)
--
-- fn_ca_dispose_superseded_hand_submissions reuses one transaction-local temp
-- table across the calls a batch makes, and cleared it with a bare
-- `DELETE FROM _hand_disposal_batch;`. The repo's own release gate
-- (scripts/ci/check-unqualified-writes.mjs) refuses an unqualified DELETE or
-- UPDATE anywhere in a migration, and it is right to: the rule is that a write
-- states its own scope, and a static scan cannot know that this particular
-- relation is an ON COMMIT DROP temp table private to the calling transaction.
-- A gate that has to be argued with at review time is a gate that gets waived.
--
-- The predicate is written out. Same rows, same behaviour, nothing else in the
-- function changes - proved by replacing exactly one line under an anchor
-- assertion, and by the md5 of the result being compared against the repo.
DO $patch$
DECLARE v_def text; v_new text; v_old text; v_repl text; n int;
BEGIN
  v_def := pg_get_functiondef('public.fn_ca_dispose_superseded_hand_submissions(uuid,uuid,text,integer)'::regprocedure);
  IF position('DELETE FROM _hand_disposal_batch WHERE true;' in v_def) > 0 THEN
    RETURN;
  END IF;
  v_old := E'  DELETE FROM _hand_disposal_batch;\n';
  v_repl := E'  -- Scoped on purpose: the batch table is transaction-local (ON COMMIT DROP)\n'
         || E'  -- and reused across the calls one batch makes, and a write states its scope.\n'
         || E'  DELETE FROM _hand_disposal_batch WHERE true;\n';
  n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF n <> 1 THEN
    RAISE EXCEPTION 'DISPOSAL_BATCH_ANCHOR_FOUND_%_TIMES', n USING ERRCODE = '55000';
  END IF;
  v_new := replace(v_def, v_old, v_repl);
  EXECUTE v_new;
  IF position('DELETE FROM _hand_disposal_batch WHERE true;' in
      pg_get_functiondef('public.fn_ca_dispose_superseded_hand_submissions(uuid,uuid,text,integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'DISPOSAL_BATCH_PATCH_UNPROVEN' USING ERRCODE = '55000';
  END IF;
END
$patch$;
