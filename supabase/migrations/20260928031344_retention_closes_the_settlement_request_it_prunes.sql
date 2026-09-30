-- RETENTION CLOSES THE SETTLEMENT REQUEST IT PRUNES (2026-09-28)
--
-- What was wrong
-- --------------
-- sp_prune_hand_history is the 10-minute retention sweep: for a horse hand
-- older than hand_history_retention_policy.horse_retention_days (8), it deletes
-- public.hand_atomic_commits and public.hand_history. It has never touched
-- smarter_private.hand_submissions, which is append-only and never pruned.
--
-- fn_ca_resume_hand_submission decides whether a table has unfinished business
-- by looking for a submission whose atomic commit is missing or incomplete. A
-- pruned hand looks exactly like a hand that never settled. So every retention
-- run manufactures "unfinished" hands on tables that finished them days ago,
-- and the next time such a table starts - an engine restart, a watchdog rebuild
-- - the successor picks up an eight-day-old request whose seats and stacks are
-- long gone, refuses it (HAND_SUBMISSION_HANDOFF_STATE_CHANGED), and the table
-- can never deal again.
--
-- Measured 2026-09-28: cash table 0065ba44 had 1,972 such requests, was
-- unstartable for nine days, and re-wedged within four hours of being cleared
-- because retention had advanced past 270 more of its hands in the meantime.
-- Its oldest surviving commit is hand 13,274,055; its newest stranded request
-- is hand 13,274,014 - the pruning boundary itself. Fleet-wide the loop was the
-- single loudest error: 1,474 refusals every two minutes across 85 live tables.
-- This is not a one-off from the 2026-09-18 incident: it recurs every ten
-- minutes, for ever, on any table whose engine restarts after its hands age out.
--
-- What changes
-- ------------
-- Retention now closes the request in the same transaction that prunes its
-- hand. Before the DELETEs, smarter_private.hand_submission_retention_disposal
-- writes an append-only disposal receipt (kind 'retention_pruned_settled_hand')
-- for every hand_submissions row belonging to a doomed hand, so the successor
-- knows the hand settled and its durable record aged out - and never tries to
-- apply the request again. A hand still in the air is unaffected: the sweep
-- only ever doomed hands that have a hand_history row, and the F06 guards
-- already hold back anything unresolved.
--
-- The disposal witness may now be the hand itself (retention), not only a later
-- commit (supersession); the constraint moves from > to >=. Nothing else in the
-- retention sweep changes: same candidate set, same budget, same batch, same
-- keepers, same money ledger untouched.

ALTER TABLE smarter_private.hand_submission_disposals
  DROP CONSTRAINT IF EXISTS hand_submission_disposals_witness_is_later;
ALTER TABLE smarter_private.hand_submission_disposals
  ADD CONSTRAINT hand_submission_disposals_witness_is_not_earlier
  CHECK (witness_hand_number >= hand_number);

CREATE OR REPLACE FUNCTION smarter_private.hand_submission_retention_disposal(
  p_hand_ids uuid[],
  p_reason text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE v_rows integer := 0;
BEGIN
  IF p_hand_ids IS NULL OR cardinality(p_hand_ids) = 0 THEN RETURN 0; END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 40 THEN
    RAISE EXCEPTION 'HAND_DISPOSAL_IDENTITY_REQUIRED' USING ERRCODE = '22023';
  END IF;

  INSERT INTO smarter_private.hand_submission_disposals
    (table_id, hand_number, submission_id, receipt_id, witness_hand_number, reason, expected)
  SELECT s.table_id, s.hand_number, s.submission_id,
         md5('hand:disposal:retention:' || s.submission_id::text)::uuid,
         s.hand_number, p_reason,
         jsonb_build_object(
           'kind', 'retention_pruned_settled_hand',
           'table_id', s.table_id, 'hand_number', s.hand_number,
           'submission_id', s.submission_id, 'retained_at', s.retained_at,
           'dealer_generation', s.lease_generation, 'request_hash', s.request_hash,
           'pruned_hand_id', hh.id, 'hand_created_at', hh.created_at,
           'settled', EXISTS (SELECT 1 FROM public.hand_atomic_commits a
                               WHERE a.table_id = s.table_id AND a.hand_number = s.hand_number),
           'disposed_at', clock_timestamp())
    FROM public.hand_history hh
    JOIN smarter_private.hand_submissions s
      ON s.table_id = hh.table_id AND s.hand_number = hh.hand_number
   WHERE hh.id = ANY (p_hand_ids)
     AND NOT EXISTS (SELECT 1 FROM smarter_private.hand_submission_disposals dd
                      WHERE dd.table_id = s.table_id AND dd.hand_number = s.hand_number)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END
$function$;

REVOKE ALL ON FUNCTION smarter_private.hand_submission_retention_disposal(uuid[], text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION smarter_private.hand_submission_retention_disposal(uuid[], text)
  TO service_role;

COMMENT ON FUNCTION smarter_private.hand_submission_retention_disposal(uuid[], text) IS
  'Closes the retained settlement requests of hands the retention sweep is about to prune, so a successor never mistakes an aged-out hand for an unfinished one. 2026-09-28.';

-- The retention sweep gains exactly one call, immediately before its DELETEs,
-- under an exact-anchor assertion rather than a retyped body: this function is
-- 120 lines of carefully argued retention exclusions (F06 boundaries, Spin
-- terminal receipts, rake attribution) and none of them may drift here.
DO $patch$
DECLARE v_def text; v_new text; v_old text; v_repl text; n int;
BEGIN
  v_def := pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure);
  IF position('hand_submission_retention_disposal' in v_def) > 0 THEN
    RETURN;
  END IF;
  v_old := E'      DELETE FROM public.ca_hand_player_idx WHERE hand_id=ANY(v_doomed);\n';
  v_repl := E'      -- RETENTION CLOSES THE SETTLEMENT REQUEST IT PRUNES (2026-09-28).\n'
         || E'      -- The commit row below is how fn_ca_resume_hand_submission knows a\n'
         || E'      -- hand finished. Deleting it without closing the request leaves the\n'
         || E'      -- table looking mid-hand for ever, and the next successor refuses to\n'
         || E'      -- start it (HAND_SUBMISSION_HANDOFF_STATE_CHANGED). Receipted here,\n'
         || E'      -- in the same transaction, while table_id and hand_number are still\n'
         || E'      -- readable from the rows about to go.\n'
         || E'      PERFORM smarter_private.hand_submission_retention_disposal(v_doomed,\n'
         || E'        ''Retention pruned this settled hand under the horse hand-history policy; its durable record (atomic commit and history) has aged out, so the retained settlement request is closed here and must never be applied again. Zero credit: the hand settled when it was played.'');\n'
         || E'      DELETE FROM public.ca_hand_player_idx WHERE hand_id=ANY(v_doomed);\n';
  n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF n <> 1 THEN
    RAISE EXCEPTION 'RETENTION_DISPOSAL_ANCHOR_FOUND_%_TIMES', n USING ERRCODE = '55000';
  END IF;
  v_new := replace(v_def, v_old, v_repl);
  EXECUTE v_new;
  IF position('hand_submission_retention_disposal' in
      pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'RETENTION_DISPOSAL_PATCH_UNPROVEN' USING ERRCODE = '55000';
  END IF;
END
$patch$;
