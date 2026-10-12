-- 20261007212545_the_stats_gap_reads_count_a_pending_projection_as_pending
--
-- Reserved by scripts/new-migration.mjs on 2026-10-07 21:25:45 UTC.
-- Replaces the 2026-09-27 draft of PR #5743 (20260927144416), which restated
-- both functions wholesale from their 2026-09-27 text and would have reverted
-- three later fixes to ca_stats_witness_audit (the dead-button rule of
-- 20261003082051, the hand_id index read of 20261003025434 and the hourly EV
-- coverage of 20261004003115). This edits today's live text in place instead.
--
-- THE STATS GAP READS COUNT A PENDING PROJECTION AS PENDING (2026-10-07)
--
-- ClubArenaStatsTriggerGap, StatsLiveTriggerMissingHands,
-- ClubArenaStatsWitnessDisagree and StatsWitnessAuditDisagrees still fire in
-- short episodes (1,344 open alert rows on 2026-10-07; the latest episodes
-- carry hands_without_stat 1 to 15 with button_disagree 0, so the dead-button
-- half of #5743 is already fixed live and is dropped here). An accepted atomic
-- hand gets its stat and index rows from the projector
-- (fn_project_hand_side_effects_after_post_commit_20260908), which writes them
-- and deletes the hand's hand_projection_outbox row in ONE transaction,
-- minutes behind the hand. Both reads still count every hand without a stat
-- row as missing, so ordinary projection lag pages as a stats defect.
--
-- The fix, in both reads: a hand that still has its outbox row is PENDING, not
-- missing; only a hand with neither a stat row nor an outbox row is a writer
-- that finished without writing. ca_stats_health() also reports the pending
-- count beside it (recentHandsPendingProjection) so lag stays visible;
-- projection lag keeps its own HandProjectionOutboxBacklog alerts.
--
-- HOW: the pinned-preimage exact-substitution helper of 20261003082051. The
-- live text must hash to today's measured md5 (audit 962ed3ca..., health
-- d04a19c6...), each of the four anchors must occur exactly once (measured
-- read-only on production 2026-10-07: 1,1 and 1,1), and the result must hash
-- to the derived postimage (computed read-only on production the same way);
-- owner, SECURITY DEFINER, proconfig and grants must not move.
--
-- Regression: scripts/ci/test-stats-witness-real-gaps.py (native PostgreSQL),
-- run by .github/workflows/stats-witness-real-gaps.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.ca_stats_witness_audit(integer,integer)'::regprocedure)) = 'f2b2f73202c042c5189151c62fcbcdc4' AND md5(pg_get_functiondef('public.ca_stats_health()'::regprocedure)) = '93f1d1746cc8e74bc27d368cc1c95b23')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_audit_subst(p_sig text, p_before text, p_after text,
                                       p_old text[], p_new text[])
RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text; v_new text; v_n integer; i integer;
  v_acl text; v_owner text; v_secdef boolean; v_cfg text[];
BEGIN
  v_def := pg_get_functiondef(p_sig::regprocedure);
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION '% is not the pinned text (md5 %)', p_sig, md5(v_def);
  END IF;
  IF array_length(p_old, 1) IS DISTINCT FROM array_length(p_new, 1) THEN
    RAISE EXCEPTION '%: anchors and replacements do not pair', p_sig;
  END IF;
  v_new := v_def;
  FOR i IN 1 .. array_length(p_old, 1) LOOP
    v_n := (length(v_new) - length(replace(v_new, p_old[i], ''))) / length(p_old[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: anchor % occurs % times, expected exactly 1', p_sig, i, v_n;
    END IF;
    v_new := replace(v_new, p_old[i], p_new[i]);
  END LOOP;
  IF md5(v_new) <> p_after THEN
    RAISE EXCEPTION '%: substituted text is not the derived postimage (md5 %)', p_sig, md5(v_new);
  END IF;

  SELECT p.proacl::text, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
    INTO v_acl, v_owner, v_secdef, v_cfg
    FROM pg_proc p WHERE p.oid = p_sig::regprocedure;

  EXECUTE v_new;

  IF md5(pg_get_functiondef(p_sig::regprocedure)) <> p_after THEN
    RAISE EXCEPTION '%: the replaced function does not read back as the postimage', p_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = p_sig::regprocedure
                    AND p.proacl::text IS NOT DISTINCT FROM v_acl
                    AND pg_get_userbyid(p.proowner) = v_owner
                    AND p.prosecdef = v_secdef
                    AND p.proconfig IS NOT DISTINCT FROM v_cfg) THEN
    RAISE EXCEPTION '%: owner, security, settings or grants moved', p_sig;
  END IF;
END $h$;

SELECT pg_temp.ca_audit_subst(
  'public.ca_stats_witness_audit(integer,integer)',
  '962ed3ca1dd6346e25d7a1c6edd7246e', 'f2b2f73202c042c5189151c62fcbcdc4',
  ARRAY[$ao1$  WHERE h.created_at >= v_from AND h.created_at < v_to
    AND NOT EXISTS (SELECT 1 FROM public.ca_hand_player_stat s WHERE s.hand_id = h.id);$ao1$,
        $ao2$      AND (pl->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ), have AS MATERIALIZED ($ao2$],
  ARRAY[$an1$  WHERE h.created_at >= v_from AND h.created_at < v_to
    AND NOT EXISTS (SELECT 1 FROM public.ca_hand_player_stat s WHERE s.hand_id = h.id)
    -- A HAND STILL IN hand_projection_outbox IS PENDING, NOT MISSING
    -- (2026-10-07). An accepted atomic hand gets its stat and index rows from
    -- the projector, which writes them and deletes the outbox row in one
    -- transaction, minutes behind the hand. Only a hand with neither a stat
    -- row nor an outbox row is a writer that finished without writing.
    AND NOT EXISTS (SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id = h.id);$an1$,
        $an2$      AND (pl->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      -- Pending projection owns this hand's index rows too (see 2c).
      AND NOT EXISTS (SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id = h.id)
  ), have AS MATERIALIZED ($an2$]
);

SELECT pg_temp.ca_audit_subst(
  'public.ca_stats_health()',
  'd04a19c66ebd132a89fa305cc8b5ed52', '93f1d1746cc8e74bc27d368cc1c95b23',
  ARRAY[$ho1$  -- The last three minutes of hands, less a 90 s grace for the write itself:
  -- every one must already carry a stat row, because the trigger writes it in
  -- the same transaction as the hand.
  recent AS (
    SELECT count(*)::int AS hands,
           count(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM public.ca_hand_player_stat s WHERE s.hand_id = h.id
           ))::int AS without_stat
$ho1$,
        $ho2$    'recentHandsWithoutStat', (SELECT without_stat FROM recent),
$ho2$],
  ARRAY[$hn1$  -- The last three minutes of hands, less a 90 s grace for the write itself.
  -- A hand with no stat row is either PENDING (its hand_projection_outbox row
  -- is still there: the projector writes the stat rows and deletes the outbox
  -- row in one transaction) or MISSING (no outbox row and no stat row: a
  -- writer that finished without writing). Only MISSING is
  -- recentHandsWithoutStat; pending is reported beside it so lag stays
  -- visible, and lag has its own HandProjectionOutboxBacklog alerts.
  recent AS (
    SELECT count(*)::int AS hands,
           count(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM public.ca_hand_player_stat s WHERE s.hand_id = h.id
           ) AND NOT EXISTS (
             SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id = h.id
           ))::int AS without_stat,
           count(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM public.ca_hand_player_stat s WHERE s.hand_id = h.id
           ) AND EXISTS (
             SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id = h.id
           ))::int AS pending_projection
$hn1$,
        $hn2$    'recentHandsWithoutStat', (SELECT without_stat FROM recent),
    'recentHandsPendingProjection', (SELECT pending_projection FROM recent),
$hn2$]
);

COMMIT;
