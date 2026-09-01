-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826050534; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ============================================================================
--  The compactor has to REMEMBER where it stopped
-- ============================================================================
--
-- Measured immediately after 20260826020000 went in, on production:
--
--   select sp_compact_hand_history(20, 300, 4000);
--   -> {"rows_moved": 41, "relpages": 1113604, "target_pages": 343345,
--       "lowest_page_worked": 937604, "stopped": "budget_spent"}
--
-- Two things in that one result:
--
--   1. The tail really is nearly empty -- 41 live rows in the 176,000 pages
--      between 937,604 and 1,113,604. Those few stragglers are exactly why
--      VACUUM cannot truncate: truncation needs a contiguous empty run at the
--      very end, so one live row high up pins every page beneath it. A plain
--      VACUUM (SKIP_LOCKED true, TRUNCATE true) run by hand right after this
--      moved relpages not at all: 1,113,604 before and after.
--
--   2. The function as first written starts at relpages EVERY call. So the
--      next run would re-scan the same 176,000 pages, spend the same budget,
--      and never reach any further down. It would have looked like it was
--      working forever while making no progress at all.
--
-- The fix is a watermark. Each run resumes from the page the last run stopped
-- at, so the scans tile the table instead of repeating its top. When a run
-- finally reaches the target the watermark clears, and the next run starts
-- from the (by then truncated, and much smaller) relpages.
--
-- ROLLBACK
--   ALTER TABLE public.hand_history_compaction_policy DROP COLUMN resume_page;
--   -- and re-apply the sp_compact_hand_history body from
--   -- 20260826020000_hand_history_compact_the_empty_pages.sql
-- ============================================================================

ALTER TABLE public.hand_history_compaction_policy
  ADD COLUMN IF NOT EXISTS resume_page bigint;

COMMENT ON COLUMN public.hand_history_compaction_policy.resume_page IS
  'Lowest page the compactor has already swept. NULL means start again from the tail.';

CREATE OR REPLACE FUNCTION public.sp_compact_hand_history(
  p_budget_seconds integer DEFAULT 15,
  p_batch          integer DEFAULT 300,
  p_window_pages   integer DEFAULT 4000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_enabled   boolean;
  v_headroom  numeric;
  v_resume    bigint;
  v_deadline  timestamptz;
  v_relpages  bigint;
  v_live      bigint;
  v_per_page  numeric;
  v_target    bigint;
  v_hi        bigint;
  v_lo        bigint;
  v_ctids     tid[];
  v_moved     bigint := 0;
  v_round     integer;
  v_stop      text := 'budget_spent';
BEGIN
  -- GUARD 1: the kill switch.
  SELECT enabled, COALESCE(headroom_factor, 1.25), resume_page
    INTO v_enabled, v_headroom, v_resume
    FROM public.hand_history_compaction_policy
   LIMIT 1;

  IF NOT COALESCE(v_enabled, false) THEN
    RETURN jsonb_build_object('compacted', false, 'reason', 'disabled');
  END IF;

  -- GUARD 2: an UPDATE here is only invisible while every trigger on
  -- hand_history is INSERT-only. If one ever fires on UPDATE, moving a row
  -- would re-run the club stats trigger and double-count somebody's profit.
  IF EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.hand_history'::regclass
       AND NOT t.tgisinternal
       AND (t.tgtype & 16) <> 0
  ) THEN
    RETURN jsonb_build_object('compacted', false, 'reason', 'update_trigger_present');
  END IF;

  -- GUARD 3: an UPDATE on a replicated table is a broadcast.
  IF EXISTS (
    SELECT 1 FROM pg_publication_rel pr
      JOIN pg_publication p ON p.oid = pr.prpubid
     WHERE pr.prrelid = 'public.hand_history'::regclass AND p.pubupdate
  ) OR EXISTS (SELECT 1 FROM pg_publication WHERE puballtables AND pubupdate) THEN
    RETURN jsonb_build_object('compacted', false, 'reason', 'table_is_published');
  END IF;

  v_deadline := clock_timestamp() + make_interval(secs => GREATEST(p_budget_seconds, 1));

  SELECT relpages::bigint, GREATEST(reltuples, 0)::bigint
    INTO v_relpages, v_live
    FROM pg_class WHERE oid = 'public.hand_history'::regclass;

  SELECT COALESCE(NULLIF(avg(cnt), 0), 5)::numeric
    INTO v_per_page
    FROM (
      SELECT count(*) AS cnt
        FROM public.hand_history TABLESAMPLE SYSTEM (0.05)
       GROUP BY (ctid::text::point)[0]::bigint
    ) s;

  v_target := ceil((v_live / GREATEST(v_per_page, 1)) * GREATEST(v_headroom, 1.05))::bigint;

  -- GUARD 4: already packed -- never churn for no space.
  IF v_relpages <= v_target THEN
    UPDATE public.hand_history_compaction_policy
       SET resume_page = NULL, updated_at = now();
    RETURN jsonb_build_object('compacted', false, 'reason', 'already_compact',
                              'relpages', v_relpages, 'target_pages', v_target);
  END IF;

  -- Resume where the last run stopped. Never above the current relpages (the
  -- file may have been truncated since), never at or below the target (that
  -- means a full sweep finished and the next one starts from the tail).
  v_hi := LEAST(COALESCE(v_resume, v_relpages), v_relpages);
  IF v_hi <= v_target THEN
    v_hi := v_relpages;
  END IF;

  <<work>>
  LOOP
    v_ctids := NULL;

    WHILE v_hi > v_target AND v_ctids IS NULL LOOP
      v_lo := GREATEST(v_target, v_hi - GREATEST(p_window_pages, 1));

      SELECT array_agg(ctid)
        INTO v_ctids
        FROM (
          SELECT ctid
            FROM public.hand_history
           WHERE ctid >= ('(' || v_lo || ',0)')::tid
             AND ctid <  ('(' || v_hi || ',0)')::tid
           LIMIT GREATEST(p_batch, 1)
        ) s;

      IF v_ctids IS NULL THEN
        v_hi := v_lo;
      END IF;

      IF clock_timestamp() >= v_deadline THEN
        EXIT work;
      END IF;
    END LOOP;

    IF v_ctids IS NULL THEN
      v_stop := 'tail_reached_target';
      EXIT work;
    END IF;

    -- The no-op: every column keeps its value. The row is rewritten only so
    -- the free space map can place it in one of the empty low pages.
    UPDATE public.hand_history
       SET reported = reported
     WHERE ctid = ANY (v_ctids);

    GET DIAGNOSTICS v_round = ROW_COUNT;
    v_moved := v_moved + v_round;

    -- GUARD 5: a batch that moves nothing means we are spinning.
    IF v_round = 0 THEN
      v_stop := 'no_progress';
      EXIT work;
    END IF;

    EXIT work WHEN clock_timestamp() >= v_deadline;
  END LOOP work;

  UPDATE public.hand_history_compaction_policy
     SET resume_page = CASE WHEN v_hi <= v_target THEN NULL ELSE v_hi END,
         updated_at  = now();

  RETURN jsonb_build_object(
    'compacted',    true,
    'rows_moved',   v_moved,
    'relpages',     v_relpages,
    'target_pages', v_target,
    'resumed_from', LEAST(COALESCE(v_resume, v_relpages), v_relpages),
    'lowest_page_worked', v_hi,
    'stopped',      v_stop
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.sp_compact_hand_history(integer,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sp_compact_hand_history(integer,integer,integer) TO service_role;

-- -- Post-apply assertions ---------------------------------------------------
DO $verify$
DECLARE a jsonb; b jsonb;
BEGIN
  -- The kill switch still holds.
  UPDATE public.hand_history_compaction_policy SET enabled = false;
  a := public.sp_compact_hand_history(1, 1, 100);
  IF (a ->> 'reason') IS DISTINCT FROM 'disabled' THEN
    RAISE EXCEPTION 'kill switch did not hold: %', a;
  END IF;

  -- The second run must pick up exactly where the first one stopped. Without
  -- the watermark both runs start at relpages, re-sweep the same pages and
  -- the compaction can never advance past its first window.
  UPDATE public.hand_history_compaction_policy SET enabled = true, resume_page = NULL;
  a := public.sp_compact_hand_history(2, 50, 2000);
  b := public.sp_compact_hand_history(2, 50, 2000);

  IF (a ->> 'compacted') = 'true'
     AND (a ->> 'stopped') <> 'tail_reached_target'
     AND (b ->> 'resumed_from') IS DISTINCT FROM (a ->> 'lowest_page_worked') THEN
    RAISE EXCEPTION 'watermark did not carry: first stopped at %, second resumed from %',
                    a ->> 'lowest_page_worked', b ->> 'resumed_from';
  END IF;
END
$verify$;
