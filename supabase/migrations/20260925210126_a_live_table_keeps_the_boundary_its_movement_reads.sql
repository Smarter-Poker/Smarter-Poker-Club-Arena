-- ===========================================================================
--  A LIVE TABLE KEEPS THE BOUNDARY ITS MOVEMENT READS, AND AN ACCEPTED PERMIT
--  IS ITS OWN WITNESS
-- ===========================================================================
--
-- F06 player movement is proven from two records per hand. Both obligations are
-- PERMANENT. Only one of the two records is.
--
--   1. smarter_private.f06_movement_permits reads EVERY permit the table ever
--      held and, for state='accepted', re-derives the seal from
--      public.hand_atomic_commits: "a.hand_id IS NULL" alone raised
--      F06_MOVEMENT_UNRESOLVED_HAND_CUSTODY.
--   2. smarter_private.f06_movement_prior reads the table's LAST commit (max
--      hand_number) plus its public.hand_history row, and validates the
--      post-commit payload hash, the request hash and the whole stack receipt
--      out of that one row. NOT FOUND raises F06_MOVEMENT_PRIOR_INCOMPLETE.
--
-- public.sp_prune_hand_history deletes BOTH of those tables for horse-only
-- hands at hand_history_retention_policy.horse_retention_days - eight days,
-- Dan's storage decision of 2026-09-17 and the single sanctioned asymmetry in
-- CLAUDE.md 10.5. That decision is NOT changed here and must not be. Its one
-- F06 guard, smarter_private.f06_hand_cards_unresolved(table, hand), retains
-- the hand whose OWN permit is still 'reserved' - the hand that never started
-- and has no history row to retain. The hands the table ALREADY DEALT were not
-- covered at all, so retention reached straight past the guard.
--
-- MEASURED ON PRODUCTION, 2026-09-25 20:34-20:55 UTC. Nothing had been lost:
-- of 1,148,364 'accepted' permits, ZERO were missing their commit row. But 649
-- hand_history rows at EIGHT tables already satisfied every clause of the
-- candidate set, and one of them was max(hand_number) in hand_atomic_commits
-- for its table - the exact row f06_movement_prior reads:
--
--   table 66b1cb1d-5056-41c1-a951-1bd078f8276f, hand 12114088,
--   created 2026-09-17 17:09:34 UTC, tournament "$100 Freeroll - 12:00 PM"
--   RUNNING, table not deleted, ONE PLAYER STILL SEATED, and exactly one
--   NON-TERMINAL f06_operations row - a movement pending since 2026-09-17 that
--   this row is the only surviving proof for.
--
-- The retention job runs at :03,:13,:23,:33,:43,:53 and was measured deleting
-- 10,000 rows per run (queue ahead of that row: 64,048 at 20:52, 54,048 at
-- 20:53). Six runs: that row was due to be deleted at about 21:53 UTC, and
-- from that moment its table could never complete a movement again, for as
-- long as the platform exists. A second, wider crossing followed at 2026-09-26
-- 02:03:20 UTC, when the oldest 'accepted'-permit-backed hand (2026-09-18
-- 02:03:20, the subsystem's first) turned eight days old and began exposing
-- path 1 across 27,522 tables' worth of permits. Nothing had fired yet.
--
-- THE CAUSE: a permanent obligation reading impermanent evidence. Fixed at both
-- places it reads it (CLAUDE.md 10.11; and 10.86 rule 4 - neither half alone
-- lands it, because path 1 bites a healthy long-running table whose custody is
-- resolved, and path 2 bites a stalled table whose permits are all decided).
-- No detector, no sweep, no repair job, no backfill, no change to the clock
-- (10.12).
--
-- FIX 1 - an accepted permit is its own witness. 'accepted' is written in
-- exactly two places and both verify the seal as they write it:
-- smarter_private.f06_accept_hand() only fires when
-- NEW.post_commit_completed_at IS NOT NULL, and public.fn_f06_finish_hand
-- raises F06_HAND_EVIDENCE_REQUIRED unless the commit row exists with
-- hand_id = p_evidence_id AND post_commit_completed_at IS NOT NULL. Both set
-- evidence_id in the same statement, and smarter_private.f06_immutable_identity
-- then refuses every later UPDATE (F06_HAND_IDENTITY_IMMUTABLE, since
-- OLD.state <> 'reserved') and every DELETE (F06_HISTORY_IMMUTABLE), with
-- tests/the-permit-ledger-outlives-the-hand.law.test.ts pinning the ledger as
-- never pruned. So an accepted permit carrying an evidence_id IS a permanent,
-- unforgeable record that this exact seal was verified.
--
-- This is NOT "pass when the evidence is missing" (10.86 rule 1 - "I could not
-- tell" must refuse). It is "read the witness that survives":
--   * commit row PRESENT -> every check applied exactly as before, unchanged;
--   * commit row ABSENT but a DIFFERENT commit occupies (table_id,
--     hand_number) -> identity conflict, refuse (what the old test was really
--     catching, and it is kept);
--   * coordinate EMPTY -> retention took it, and the immutable permit stands.
-- evidence_id IS NULL on an accepted permit is a state the writers cannot
-- produce, so it refuses.
--
-- FIX 2 - a live table keeps the boundary its movement reads. The sealed
-- payload f06_movement_prior validates cannot be reconstructed from anywhere,
-- so fix 1 cannot substitute for it. The guard was measuring the wrong scope -
-- the unresolved HAND instead of the table whose movement is still owed - so it
-- is given the real scope, and the smallest sufficient one: the table's CURRENT
-- last committed boundary, while the table is still one F06 can be asked to
-- move. Cost, measured: 1,020 live tournament tables, 797 holding a committed
-- boundary, 8 of those old enough to have been prunable today. One hand per
-- live table, bounded by the live table count and not by time, and it RELEASES
-- ITSELF twice over - the moment the table deals its next hand the old boundary
-- stops being max(hand_number), and the moment the tournament completes or the
-- table closes the whole table prunes normally. Retention ends when the reason
-- ends, the same shape the existing 'reserved' guard already has. Rejected
-- alternative: retain every hand at every unresolved-custody table (27,704
-- rows / 129 MB measured) - correct, but 35x the data and far more than either
-- function reads.
--
-- Law: tests/a-live-table-keeps-the-boundary-its-movement-reads.law.test.ts
-- Changelog: docs/changelog/2026-09-25-a-live-table-keeps-the-boundary-its-movement-reads.md
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $preimage$
DECLARE v text;
BEGIN
  v := md5(pg_get_functiondef('smarter_private.f06_movement_permits(uuid,uuid,bigint)'::regprocedure));
  IF v <> '117f406525f151913ef8b1643ff2a21f' THEN
    RAISE EXCEPTION 'PREIMAGE: smarter_private.f06_movement_permits changed under me (md5 %)', v;
  END IF;

  v := md5(pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure));
  IF v <> 'ed1de9ee5087af98378c8c3a50f931a9' THEN
    RAISE EXCEPTION 'PREIMAGE: public.sp_prune_hand_history changed under me (md5 %)', v;
  END IF;

  IF (SELECT greatest(coalesce(horse_retention_days, 8), 1)
        FROM public.hand_history_retention_policy LIMIT 1) <> 8 THEN
    RAISE EXCEPTION 'PREIMAGE: horse_retention_days is no longer 8; reread the header';
  END IF;

  IF to_regprocedure('smarter_private.f06_movement_boundary_retained(uuid,bigint)') IS NOT NULL THEN
    RAISE EXCEPTION 'PREIMAGE: smarter_private.f06_movement_boundary_retained already exists';
  END IF;
END
$preimage$;

CREATE OR REPLACE FUNCTION smarter_private.f06_movement_permits(p_tournament uuid, p_table uuid, p_boundary bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE result jsonb;
BEGIN
 -- Every permit this table ever held must be DECIDED before its players move.
 -- accepted: its exact sealed commit, at or below the boundary -- verified
 -- against hand_atomic_commits while that row exists, and afterwards against
 -- the permit itself, which is immutable and is the ONE witness retention
 -- cannot take (20260925210126; before it, an eight-day-old accepted hand
 -- refused its table's movement for ever). never_started and
 -- aborted_unsettled: decided not to count by a receipt, immutable, fenced
 -- from dispatch and history, and still visibly nothing of the hand on this
 -- table. 'reserved' is undecided and refuses; so does any dispatch.
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits h
 LEFT JOIN public.hand_atomic_commits a ON a.hand_id=h.evidence_id AND a.table_id=h.table_id AND a.hand_number=h.hand_number
 WHERE h.table_id=p_table AND (h.tournament_id IS DISTINCT FROM p_tournament
 OR NOT EXISTS(SELECT 1 FROM public.tables t WHERE t.id=p_table AND t.f06_lifecycle=h.lifecycle)
 OR CASE
 WHEN h.state='accepted' THEN
 h.hand_number>p_boundary OR h.evidence_id IS NULL
 OR (a.hand_id IS NOT NULL AND (
 a.post_commit_completed_at IS NULL
 OR NOT isfinite(a.post_commit_completed_at) OR a.post_commit_completed_at<a.committed_at
 OR a.post_commit_result->'ok' IS DISTINCT FROM 'true'::jsonb
 OR a.post_commit_result->>'hand_id' IS DISTINCT FROM a.hand_id::text
 OR (a.post_commit_result->>'hand_number')::bigint IS DISTINCT FROM a.hand_number))
 -- No commit row matched this permit's own evidence. If some OTHER commit
 -- occupies the coordinate the permit claims, that is an identity conflict
 -- and refuses, exactly as before. An EMPTY coordinate is retention, and the
 -- immutable accepted permit is the surviving proof of the seal.
 OR (a.hand_id IS NULL AND EXISTS(SELECT 1 FROM public.hand_atomic_commits c
 WHERE c.table_id=h.table_id AND c.hand_number=h.hand_number))
 WHEN h.state IN ('never_started','aborted_unsettled') THEN
 h.evidence_id IS NULL
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits c WHERE c.table_id=h.table_id AND c.hand_number=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history x WHERE x.table_id=h.table_id AND x.hand_number=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_private_state p WHERE p.table_id=h.table_id AND p.hand_number=h.hand_number)
 ELSE true END))
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch d JOIN smarter_private.f06_hand_permits h USING(permit_id) WHERE h.table_id=p_table) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_UNRESOLVED_HAND_CUSTODY' USING ERRCODE='55000'; END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.hand_number,h.permit_id),'[]'::jsonb) INTO result
 FROM smarter_private.f06_hand_permits h WHERE h.table_id=p_table;
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION smarter_private.f06_movement_boundary_retained(p_table_id uuid, p_hand_number bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.tables tb
      LEFT JOIN public.tournaments t ON t.id = tb.tournament_id
     WHERE tb.id = p_table_id
       AND tb.tournament_id IS NOT NULL
       AND NOT COALESCE(tb.is_deleted, false)
       AND lower(COALESCE(tb.status, '')) <> 'closed'
       AND upper(COALESCE(t.status::text, '')) NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED')
       AND p_hand_number = (
         SELECT max(a.hand_number) FROM public.hand_atomic_commits a
          WHERE a.table_id = p_table_id)
  );
$function$;

COMMENT ON FUNCTION smarter_private.f06_movement_boundary_retained(uuid, bigint) IS
  'True for the last committed hand of a table F06 can still be asked to move. '
  'smarter_private.f06_movement_prior reads exactly that row and validates the '
  'post-commit payload hash, request hash and stack receipt out of it, and none '
  'of that can be reconstructed once it is gone, so public.sp_prune_hand_history '
  'retains it. Releases itself when the table deals its next hand, or when the '
  'tournament completes or the table closes. See migration 20260925210126.';

REVOKE ALL ON FUNCTION smarter_private.f06_movement_boundary_retained(uuid, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION smarter_private.f06_movement_boundary_retained(uuid, bigint) TO service_role;

CREATE OR REPLACE FUNCTION public.sp_prune_hand_history(p_batch integer DEFAULT 2500)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_budget constant interval := interval '20 seconds';
  v_deadline timestamptz := clock_timestamp()+v_budget;
  v_days integer;
  v_window interval;
  v_doomed uuid[];
  v_keepers uuid[];
  v_deleted integer := 0;
  v_round integer;
BEGIN
  SELECT greatest(coalesce(horse_retention_days,8),1)
    INTO v_days FROM public.hand_history_retention_policy LIMIT 1;
  IF v_days IS NULL THEN v_days := 8; END IF;
  v_window := make_interval(days=>v_days);

  LOOP
    v_doomed := NULL;
    v_keepers := NULL;
    WITH candidates AS (
      SELECT hh.id,hh.players
        FROM public.hand_history hh
       WHERE hh.has_human IS DISTINCT FROM true
         AND hh.reported IS NOT true
         AND hh.created_at<now()-v_window
         AND NOT EXISTS (
           SELECT 1 FROM public.bbj_payouts bp
            WHERE bp.table_id=hh.table_id AND bp.hand_number=hh.hand_number)
         AND NOT EXISTS (
           SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id=hh.id)
         AND NOT EXISTS (
           SELECT 1 FROM public.tournament_knockout_candidates c
            WHERE c.hand_id=hh.id AND c.state='pending')
         -- A hand whose F06 permit is still 'reserved' is unresolved, and this
         -- row is original evidence for it:
         -- smarter_private.f06_retired_origin_snapshot and
         -- smarter_private.f06_retained_mtt_abort_snapshot both read
         -- public.hand_history and public.hand_atomic_commits. All four DELETEs
         -- below key off the ids chosen here, so excluding the hand at this one
         -- point retains its history, atomic commit, rake attribution and
         -- player-index rows together. Excluding it from the candidate set
         -- rather than from each DELETE also keeps it out of v_keepers, so no
         -- has_human=true is written that would retain it past its permit, and
         -- it never consumes a p_batch slot. Retention ends when the permit
         -- leaves 'reserved'; every other row prunes on the same boundary as
         -- before. The lookup goes through the SECURITY DEFINER helper added by
         -- migration 20260920232341, because this function is SECURITY INVOKER
         -- and its search_path does not include smarter_private.
         AND NOT smarter_private.f06_hand_cards_unresolved(hh.table_id,hh.hand_number::bigint)
         -- AND the hand that IS the table's current movement boundary, for a
         -- table F06 can still be asked to move. The guard above protects the
         -- unresolved HAND -- which never started and has no row here -- so it
         -- reached straight past the hands the table already dealt, and
         -- smarter_private.f06_movement_prior loads the last of those by
         -- max(hand_number) and validates its post-commit payload hash,
         -- request hash and stack receipt out of it. Delete it and that table
         -- raises F06_MOVEMENT_PRIOR_INCOMPLETE for ever: on 2026-09-25 one
         -- seated player in a RUNNING freeroll was about six retention runs
         -- from exactly that. One hand per live table, and it stops being the
         -- boundary as soon as the table deals another. Migration
         -- 20260925210126.
         AND NOT smarter_private.f06_movement_boundary_retained(hh.table_id,hh.hand_number::bigint)
         -- Missing/blank classification or conflicting ownership stays retained.
         -- A known Spin's history remains evidence until canonical terminal
         -- state commits; do not require a first legacy receipt to exist.
         AND EXISTS (
           SELECT 1 FROM public.tables tb
           LEFT JOIN public.tournaments t ON t.id=tb.tournament_id
            WHERE tb.id=hh.table_id
              AND (hh.tournament_id IS NULL
                   OR hh.tournament_id=tb.tournament_id)
              AND (
                (hh.tournament_id IS NULL AND tb.tournament_id IS NULL)
                OR (
                  t.id IS NOT NULL
                  AND NULLIF(btrim(t.variant::text),'') IS NOT NULL
                  AND NULLIF(btrim(t.tournament_type::text),'') IS NOT NULL
                  AND (
                    (lower(t.variant::text)<>'spin'
                     AND upper(t.tournament_type::text)<>'SPIN')
                    OR (upper(COALESCE(t.status::text,''))='COMPLETED'
                        AND EXISTS (
                          SELECT 1 FROM public.tournament_terminal_settlements terminal
                           WHERE terminal.tournament_id=t.id))
                    OR (upper(COALESCE(t.status::text,'')) IN ('CANCELLED','CANCELED')
                        AND EXISTS (
                          SELECT 1 FROM public.tournament_cancellation_receipts cancellation
                           WHERE cancellation.tournament_id=t.id))
                  )
                )
              )
         )
       ORDER BY hh.created_at
       LIMIT p_batch
       FOR UPDATE SKIP LOCKED
    ), classified AS (
      SELECT c.id,
        CASE
          WHEN jsonb_typeof(c.players) IS DISTINCT FROM 'array' THEN true
          WHEN jsonb_array_length(c.players)=0 THEN true
          ELSE EXISTS (
            SELECT 1
              FROM jsonb_array_elements(c.players) e
              LEFT JOIN public.profiles p ON p.id=(CASE
                WHEN length(e.value->>'userId')=36
                 AND (e.value->>'userId') ~
                   '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                THEN (e.value->>'userId')::uuid END)
             WHERE p.id IS NULL OR p.is_horse IS NOT true)
        END AS is_human
        FROM candidates c
    )
    SELECT array_agg(id) FILTER (WHERE is_human IS false),
           array_agg(id) FILTER (WHERE is_human IS DISTINCT FROM false)
      INTO v_doomed,v_keepers FROM classified;

    EXIT WHEN v_doomed IS NULL AND v_keepers IS NULL;
    IF v_keepers IS NOT NULL AND cardinality(v_keepers)>0 THEN
      UPDATE public.hand_history SET has_human=true WHERE id=ANY(v_keepers);
    END IF;
    IF v_doomed IS NOT NULL AND cardinality(v_doomed)>0 THEN
      -- A RECORDED EARNING SOURCE IS NOT HAND HISTORY (2026-09-25).
      -- This line used to delete the pruned hands rake attributions, and
      -- every run of sp_prune_hand_history_10m raised
      -- recorded_cash_earning_source_is_immutable for it: the trigger
      -- accounting_cash_source_immutable refuses to move an attribution once
      -- accounting_cash_accrual_batches holds a batch for its rake record.
      -- The trigger is right and the DELETE was never required: there is no
      -- foreign key from rake_attributions.hand_id to hand_history.id. It
      -- also fired trg_ca_club_rake_daily_user_del, which would have
      -- decremented the per-club per-user daily rake rollup - the rakeback
      -- basis - for every horse in every pruned hand (CLAUDE.md 10.5).
      -- Retention is a storage decision about hand HISTORY (10.5, eight
      -- days); the money ledger is not pruned, so attributions are kept.
      DELETE FROM public.ca_hand_player_idx WHERE hand_id=ANY(v_doomed);
      DELETE FROM public.hand_atomic_commits WHERE hand_id=ANY(v_doomed);
      DELETE FROM public.hand_history WHERE id=ANY(v_doomed);
      GET DIAGNOSTICS v_round=ROW_COUNT;
      v_deleted := v_deleted+v_round;
    END IF;
    EXIT WHEN clock_timestamp()>=v_deadline;
  END LOOP;
  RETURN v_deleted;
END;
$function$;

DO $postimage$
DECLARE v_present integer;
BEGIN
  IF NOT smarter_private.f06_movement_boundary_retained(
           '66b1cb1d-5056-41c1-a951-1bd078f8276f'::uuid, 12114088::bigint) THEN
    RAISE EXCEPTION
      'POSTIMAGE: table 66b1cb1d-5056-41c1-a951-1bd078f8276f hand 12114088 is no longer this table''s retained movement boundary. Either retention already took it, or the table/tournament has gone terminal since 20:55 UTC. Read the rows before relaxing anything.';
  END IF;

  SELECT count(*) INTO v_present FROM public.hand_history
   WHERE table_id='66b1cb1d-5056-41c1-a951-1bd078f8276f'::uuid AND hand_number=12114088;
  IF v_present <> 1 THEN
    RAISE EXCEPTION 'POSTIMAGE: the hand_history row for the measured boundary is gone (count %)', v_present;
  END IF;

  SELECT count(*) INTO v_present FROM public.hand_atomic_commits
   WHERE table_id='66b1cb1d-5056-41c1-a951-1bd078f8276f'::uuid AND hand_number=12114088;
  IF v_present <> 1 THEN
    RAISE EXCEPTION 'POSTIMAGE: the hand_atomic_commits row for the measured boundary is gone (count %)', v_present;
  END IF;

  IF position('f06_movement_boundary_retained' in
              pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTIMAGE: the installed retention job does not consult the boundary guard';
  END IF;
END
$postimage$;

COMMIT;
