-- 20261014231901_the_hand_pruner_keeps_hands_that_a_sealed_restoration_case_c.sql
--
-- ROOT CAUSE (read from production rows 2026-10-14):
-- The Midway Union weekly accounting scope fails every visit with
-- original_restoration_cash_flow_source_refused. original_restoration_cash_returns
-- asks smarter_private.original_inventory_finite_witness for each sealed
-- returned_cash case; 19 of 33 return NULL. The witness is NULL because the
-- sealed source refs of kind atomic_economics / signed_economics re-read
-- public.hand_atomic_commits, and sp_prune_hand_history (8 day retention) deleted
-- those commit rows on 2026-10-14 15:33 for hands played 2026-10-06. The pruner
-- never looked at smarter_private.original_inventory_restoration_cases, so it
-- destroys the very evidence the 2026-10-12 boundary seals. 25 of the 176 cited
-- atomic commits are already gone; the other 151 age out between now and
-- 2026-10-15 04:07 UTC. Nothing here changes retention (still eight days, Dan's
-- storage ruling): a hand that a sealed case cites is simply not a prunable hand
-- yet, the same way an unsettled tournament hand or an unresolved F06 hand is not.
--
-- WHAT THIS CHANGES: one added candidate exclusion in sp_prune_hand_history.
-- Excluding at the candidate set keeps the hand's history, commit, disposal and
-- index rows together. No money table is written; no job is added.
--
-- RECORD NOTE: production ran this migration at 2026-10-14 23:21 UTC without the
-- retention-days precondition below. The retention window is read from
-- public.hand_history_retention_policy (a config row, CLAUDE.md 10.5), and the
-- law test a-retention-pass-never-deletes-a-recorded-earning-source requires every
-- pruner redefinition to say so in code, so the precondition was added to this
-- file afterwards. It cannot change the result: the pruner body being patched
-- already reads horse_retention_days itself.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $install$
DECLARE src text; anchor constant text := E'         AND hh.created_at<now()-v_window\n';
BEGIN
 IF md5(pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure))
    IS DISTINCT FROM 'd899ca6bd7ded6ca33850c6d6e59ffed' THEN
  RAISE EXCEPTION 'PRUNER_PREIMAGE_CHANGED' USING ERRCODE='55000';
 END IF;
 IF (SELECT horse_retention_days FROM public.hand_history_retention_policy LIMIT 1) IS DISTINCT FROM 8 THEN
  RAISE EXCEPTION 'PRUNER_RETENTION_POLICY_CHANGED' USING ERRCODE='55000';
 END IF;
 src:=pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure);
 IF (length(src)-length(replace(src,anchor,'')))/length(anchor) IS DISTINCT FROM 1 THEN
  RAISE EXCEPTION 'PRUNER_ANCHOR_NOT_UNIQUE' USING ERRCODE='55000';
 END IF;
 src:=replace(src,anchor,anchor ||
  E'         -- A SEALED RESTORATION CASE KEEPS THE HANDS IT CITES (2026-10-14). The\n' ||
  E'         -- finite witness re-reads the atomic commit of every cited hand; a pruned\n' ||
  E'         -- hand voids the case and halts the weekly union accounting for ever.\n' ||
  E'         AND NOT EXISTS (SELECT 1 FROM smarter_private.original_inventory_restoration_cases rc,\n' ||
  E'                               jsonb_array_elements(rc.source_refs) sr\n' ||
  E'                         WHERE sr->>''kind'' IN (''atomic_economics'',''signed_economics'')\n' ||
  E'                           AND sr->>''id''=hh.id::text)\n');
 EXECUTE src;
 IF pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure)
    NOT LIKE '%original_inventory_restoration_cases%' THEN
  RAISE EXCEPTION 'PRUNER_GUARD_NOT_INSTALLED' USING ERRCODE='55000';
 END IF;
END $install$;
COMMIT;
