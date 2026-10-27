-- @live-proof: (SELECT position('WITH scanned AS MATERIALIZED' IN pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure))>0 AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='smarter_private' AND table_name='hand_history_prune_cursor' AND column_name='resume_id'))
-- Lease phase 4: the first candidate query after hourly cursor reset still
-- times out at 120s in natural runs (16:12 and 17:14-17:22 UTC, October 26).
-- LIMIT 250 eligible rows does not bound the retained prefix: the isolated
-- unchanged installed query evaluates 1,250 guards to choose 250 eligible rows.
-- Materialize at most 250 raw rows before unchanged guards, and advance to
-- the last scanned (timestamp,uuid), including guard-retained pages. An empty
-- eligible page is not end-of-scan. Equal timestamps resume without omission.
-- No retention/financial policy, disposal, schedule, timeout or work budget
-- changes. A released guard is revisited by the existing hourly pass. No FK
-- or index is added to a hot table. A cancelled transaction rolls back cursor
-- and disposals together. Exact preimage and metadata refuse source drift.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
ALTER TABLE smarter_private.hand_history_prune_cursor ADD COLUMN resume_id uuid;
DO $install$
DECLARE metadata jsonb;
BEGIN
 IF md5(pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure)) IS DISTINCT FROM '60bf472a763ad182ffd53c3b2bb3e14c' THEN
  RAISE EXCEPTION 'PRUNER_BOUNDED_SCAN_PREIMAGE_CHANGED' USING ERRCODE='55000';
 END IF;
 SELECT jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'config',proconfig,'volatility',provolatile) INTO metadata
 FROM pg_proc WHERE oid='public.sp_prune_hand_history(integer)'::regprocedure;
 EXECUTE $replacement$
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
  -- THE SCAN RESUMES WHERE IT LEFT OFF (2026-10-26, migration 20261026133101).
  -- v_resume_after is the newest created_at this pass has examined; the
  -- Bounded raw pages advance even when every guard retains their rows.
  -- The uuid tie-breaker prevents equal timestamps from skipping later rows.
  v_pass_length constant interval := interval '60 minutes';
  v_resume_after timestamptz;
  v_pass_started timestamptz;
  v_reached timestamptz;
  v_resume_id uuid;
  v_reached_id uuid;
BEGIN
  -- Retention never holds the maintenance lane while the platform is frozen.
  IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RETURN 0; END IF;
  -- Preserve the original maintenance/settlement owner before any ledger read.
  IF pg_catalog.pg_try_advisory_xact_lock_shared(530090,1) IS NOT TRUE THEN RETURN 0; END IF;
  -- Recheck after admission before the policy and accounting reads.
  IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RETURN 0; END IF;
  SELECT greatest(coalesce(horse_retention_days,8),1)
    INTO v_days FROM public.hand_history_retention_policy LIMIT 1;
  IF v_days IS NULL THEN v_days := 8; END IF;
  v_window := make_interval(days=>v_days);
  INSERT INTO smarter_private.hand_history_prune_cursor(singleton) VALUES(true) ON CONFLICT DO NOTHING;
  SELECT c.resume_after,c.pass_started_at,c.resume_id INTO v_resume_after,v_pass_started,v_resume_id
    FROM smarter_private.hand_history_prune_cursor c WHERE c.singleton FOR UPDATE;
  IF v_pass_started IS NULL OR v_pass_started<clock_timestamp()-v_pass_length THEN
    v_resume_after := NULL;
    v_resume_id := NULL;
    v_pass_started := clock_timestamp();
  END IF;

  LOOP
    v_doomed := NULL;
    v_keepers := NULL;
    -- Bound the scan BEFORE accounting/F06 guards: LIMIT on eligible rows
    -- cannot bound the retained prefix. MATERIALIZED prevents guard pushdown.
    WITH scanned AS MATERIALIZED (
      SELECT hh.id,hh.created_at FROM public.hand_history hh
       WHERE hh.created_at<now()-v_window
         AND hh.created_at>=COALESCE(v_resume_after,'-infinity'::timestamptz)
         AND (v_resume_id IS NULL OR (hh.created_at,hh.id)>(v_resume_after,v_resume_id))
       ORDER BY hh.created_at,hh.id
       LIMIT LEAST(GREATEST(p_batch,1),250)
    ), candidates AS (
      SELECT hh.id,hh.players,hh.created_at,
             (hh.table_id IS NULL AND hh.tournament_id IS NULL
              AND hh.players = '[]'::jsonb) AS unattached
        FROM scanned scan CROSS JOIN LATERAL (
          -- Keep every guard downstream of a bounded point read even when
          -- the planner chooses hash joins. Lock only this page; refuse a
          -- concurrently held row through the existing SKIP LOCKED rule.
          SELECT locked.* FROM public.hand_history locked
           WHERE locked.id=scan.id FOR UPDATE SKIP LOCKED
        ) hh
       WHERE hh.has_human IS FALSE
         AND NOT EXISTS (SELECT 1 FROM smarter_private.hand_submissions original
           WHERE original.table_id=hh.table_id AND original.hand_number=hh.hand_number
             AND (original.request#>'{p_hand_row,has_human}') IS DISTINCT FROM 'false'::jsonb)
         AND NOT EXISTS (SELECT 1 FROM public.poker_diamond_jackpot_hits dj
           WHERE dj.table_id=hh.table_id AND dj.hand_number=hh.hand_number AND dj.paid)
         AND hh.reported IS NOT true
         AND smarter_private.horse_cash_retention_accounting_ready(hh.table_id,hh.hand_number)
         AND (hh.table_id IS NULL OR EXISTS (SELECT 1 FROM public.hand_atomic_commits a WHERE a.hand_id=hh.id AND a.table_id=hh.table_id AND a.hand_number=hh.hand_number AND isfinite(a.post_commit_completed_at) AND a.post_commit_completed_at<now()-v_window AND a.post_commit_result->>'ok'='true'))
         AND hh.created_at<now()-v_window
         -- A SEALED RESTORATION CASE KEEPS THE HANDS IT CITES (2026-10-14). The
         -- finite witness re-reads the atomic commit of every cited hand; a pruned
         -- hand voids the case and halts the weekly union accounting for ever.
         AND NOT EXISTS (SELECT 1 FROM smarter_private.original_inventory_restoration_cases rc,
                               jsonb_array_elements(rc.source_refs) sr
                         WHERE sr->>'kind' IN ('atomic_economics','signed_economics')
                           AND sr->>'id'=hh.id::text)
         AND NOT EXISTS (
           SELECT 1 FROM public.bbj_payouts bp
            WHERE bp.table_id=hh.table_id AND bp.hand_number=hh.hand_number)
         AND NOT EXISTS (
           SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id=hh.id)
         AND NOT EXISTS (
           SELECT 1 FROM public.tournament_knockout_candidates c
            WHERE c.hand_id=hh.id AND c.state='pending')
         -- AN UNSETTLED TOURNAMENT KEEPS ITS HANDS (2026-10-02). A tournament
         -- hand is evidence until its event's money is settled: the event is
         -- COMPLETED or CANCELLED, its bounty pool is fully paid, and its
         -- escrow, when it has one, is closed. PKO 3f19bd70 lost the only record
         -- of who knocked out whom while 2,310.00 of its bounty pool was unpaid.
         -- Cash rake records are never deleted here (20260925143224), so a cash
         -- week keeps its per-player rakeback basis settled or not.
         -- Migration 20261002082452.
         AND (hh.tournament_id IS NULL OR NOT EXISTS (
           SELECT 1 FROM public.tournaments ut
            WHERE ut.id=hh.tournament_id
              AND (upper(COALESCE(ut.status::text,'')) NOT IN ('COMPLETED','CANCELLED','CANCELED')
                   OR COALESCE(ut.bounty_pool,0)>COALESCE(ut.bounty_pool_paid,0)
                   OR EXISTS (SELECT 1 FROM public.tournament_escrow ue
                               WHERE ue.tournament_id=ut.id AND ue.closed_at IS NULL))))
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
         -- AN UNATTACHED ROW IS NOT A HAND ANYBODY PLAYED (2026-10-05). A row
         -- with no table, no tournament and nobody dealt in is the settled-hand
         -- fixture tests/e2e/production-daily-missions.spec.ts inserts and
         -- deletes; a run killed before its finally block leaves it behind.
         -- The engine never writes one. tb.id=hh.table_id is never true for a
         -- NULL table_id, so the EXISTS below excluded such a row from every
         -- run, and even admitted, an empty player list classifies as human
         -- below and would be kept for ever. Every guard above still governs
         -- it (both f06 helpers read false for a NULL table_id, measured on
         -- all eight such rows). Migration 20261005111120.
         AND ((hh.table_id IS NULL AND hh.tournament_id IS NULL
               AND hh.players = '[]'::jsonb) OR EXISTS (
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
         ))
       ORDER BY hh.created_at
       LIMIT LEAST(GREATEST(p_batch,1),250)
    ), classified AS (
      SELECT c.id,c.created_at,
        CASE
          WHEN c.unattached THEN false
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
           array_agg(id) FILTER (WHERE is_human IS DISTINCT FROM false),
           (SELECT created_at FROM scanned ORDER BY created_at DESC,id DESC LIMIT 1),
           (SELECT id FROM scanned ORDER BY created_at DESC,id DESC LIMIT 1)
      INTO v_doomed,v_keepers,v_reached,v_reached_id FROM classified;

    IF v_reached IS NULL THEN
      v_resume_after := now()-v_window;
      v_resume_id := NULL;
      EXIT;
    END IF;
    v_resume_after := v_reached;
    v_resume_id := v_reached_id;
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
      -- RETENTION CLOSES THE SETTLEMENT REQUEST IT PRUNES (2026-09-28).
      -- The commit row below is how fn_ca_resume_hand_submission knows a
      -- hand finished. Deleting it without closing the request leaves the
      -- table looking mid-hand for ever, and the next successor refuses to
      -- start it (HAND_SUBMISSION_HANDOFF_STATE_CHANGED). Receipted here,
      -- in the same transaction, while table_id and hand_number are still
      -- readable from the rows about to go.
      PERFORM smarter_private.hand_submission_retention_disposal(v_doomed,
        'Retention pruned this settled hand under the horse hand-history policy; its durable record (atomic commit and history) has aged out, so the retained settlement request is closed here and must never be applied again. Zero credit: the hand settled when it was played.');
      PERFORM smarter_private.compact_horse_settlement_keys(v_doomed);
      PERFORM smarter_private.compact_horse_cash_play_contents(v_doomed);
      PERFORM smarter_private.archive_pruned_hand_index(v_doomed);
      DELETE FROM public.hand_atomic_commits WHERE hand_id=ANY(v_doomed);
      DELETE FROM public.hand_history WHERE id=ANY(v_doomed);
      GET DIAGNOSTICS v_round=ROW_COUNT;
      v_deleted := v_deleted+v_round;
    END IF;
    EXIT WHEN clock_timestamp()>=v_deadline;
  END LOOP;
  UPDATE smarter_private.hand_history_prune_cursor
     SET resume_after=v_resume_after,resume_id=v_resume_id,pass_started_at=v_pass_started,updated_at=clock_timestamp()
   WHERE singleton;
  RETURN v_deleted;
END;
$function$;
$replacement$;
 IF metadata IS DISTINCT FROM (SELECT jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'config',proconfig,'volatility',provolatile) FROM pg_proc WHERE oid='public.sp_prune_hand_history(integer)'::regprocedure) THEN
  RAISE EXCEPTION 'PRUNER_BOUNDED_SCAN_METADATA_CHANGED';
 END IF;
END $install$;
-- Start a complete pass once, including any equal-timestamp rows omitted by
-- the old timestamp-only cursor. No history or money row is changed here.
UPDATE smarter_private.hand_history_prune_cursor SET resume_after=NULL,resume_id=NULL,pass_started_at=NULL WHERE singleton;
COMMIT;
