-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826050116; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ============================================================================
--  hand_history: reclaim the empty pages, without ever locking the table
-- ============================================================================
--
-- WHAT WAS MEASURED (2026-08-26, production)
--
--   pg_total_relation_size   9982 MB    heap 8700 MB, indexes 1179 MB, toast 101 MB
--   reltuples             1,493,194
--   relpages              1,113,604     -> 1.341 live tuples per page
--
--   400 randomly probed pages:  302 of them (75.5%) held ZERO live tuples,
--   average 1.338 live tuples/page -- which matches reltuples/relpages
--   (1.341) and so is the whole table, not a sampling artefact.
--
--   Pages that DO hold rows are 94% full: 5.53 tuples/page, 1394 bytes each,
--   7713 of 8192 bytes live. So the rows are packed fine; there are simply
--   ~843,000 completely empty pages, about 6.6 GB, that the file is still
--   holding on to.
--
-- WHY IT HAPPENS, AND WHY IT NEVER RECOVERS ON ITS OWN
--
--   sp_prune_hand_history deletes horse-only hands older than the retention
--   window (7 days) and it KEEPS UP: at the time of writing only ~2,200 rows
--   were past retention and the oldest surviving row was exactly 7 days old.
--   So the row count is bounded and this is NOT a growth problem.
--
--   It is a high-water-mark problem. Deletes land at the old end of the file,
--   VACUUM marks those pages reusable, but VACUUM can only give space back to
--   the operating system by truncating EMPTY PAGES AT THE TAIL. Empty pages in
--   the middle are reused forever and never returned. The file therefore stays
--   at whatever size it once needed -- ~9 GB -- while holding ~2.1 GB of rows.
--
-- WHAT THIS MIGRATION DOES INSTEAD OF VACUUM FULL
--
--   VACUUM FULL / CLUSTER would fix it in one pass and take ACCESS EXCLUSIVE
--   for the whole rewrite. On a live table taking ~310 inserts/minute that
--   stalls the engine outright, so it is not available to us.
--
--   Instead: repeatedly issue a NO-OP UPDATE against rows living in the
--   highest-numbered pages. Every column keeps its own value, so no consumer
--   can observe a change and no hand can be lost -- the update exists only to
--   write the row as a NEW tuple, which the free space map places in one of
--   the many empty low pages. The tail empties, and an ordinary VACUUM (which
--   takes only a brief, self-yielding lock to truncate) hands the tail back.
--
--   It is incremental, resumable, interruptible, and bounded by a time budget.
--   Nothing here deletes a row.
--
-- ROLLBACK
--   UPDATE public.hand_history_compaction_policy SET enabled = false;
--   SELECT cron.unschedule('hand-history-compact');
--   SELECT cron.unschedule('hand-history-compact-vacuum');
--   DROP FUNCTION IF EXISTS public.sp_compact_hand_history(integer,integer,integer);
--   DROP FUNCTION IF EXISTS public.fn_hand_history_bloat();
--   DROP TABLE IF EXISTS public.hand_history_compaction_policy;
--   -- Nothing else to undo: no row was created, deleted or altered in value.
-- ============================================================================

-- -- Pre-flight ------------------------------------------------------------
DO $preflight$
BEGIN
  IF to_regclass('public.hand_history') IS NULL THEN
    RAISE EXCEPTION 'hand_history does not exist; refusing to install a compactor for it';
  END IF;
END
$preflight$;

-- -- The kill switch --------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.hand_history_compaction_policy (
  id              boolean     PRIMARY KEY DEFAULT true CHECK (id),
  enabled         boolean     NOT NULL DEFAULT false,
  -- How much slack to leave above the space the live rows actually need.
  -- 1.25 = stop once the file is within 25% of its packed size, so ordinary
  -- churn never has to extend the file and we never fight the FSM for the
  -- last few pages.
  headroom_factor numeric     NOT NULL DEFAULT 1.25 CHECK (headroom_factor >= 1.05),
  note            text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.hand_history_compaction_policy (id, enabled, headroom_factor, note)
VALUES (true, true, 1.25,
        'Enabled 2026-08-26. Set enabled=false to stop the compactor immediately; '
        || 'the next scheduled run becomes a no-op and nothing needs to be unwound.')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.hand_history_compaction_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hand_history_compaction_policy FROM anon, authenticated;

-- -- Observability: what is actually in the file -----------------------------
CREATE OR REPLACE FUNCTION public.fn_hand_history_bloat()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  WITH c AS (
    SELECT relpages::bigint AS relpages, GREATEST(reltuples, 0)::bigint AS reltuples
      FROM pg_class WHERE oid = 'public.hand_history'::regclass
  ),
  d AS (
    SELECT COALESCE(NULLIF(avg(cnt), 0), 5)::numeric AS per_full_page
      FROM (
        SELECT count(*) AS cnt
          FROM public.hand_history TABLESAMPLE SYSTEM (0.05)
         GROUP BY (ctid::text::point)[0]::bigint
      ) s
  )
  SELECT jsonb_build_object(
    'relpages',            c.relpages,
    'reltuples',           c.reltuples,
    'tuples_per_page_avg', round(c.reltuples::numeric / NULLIF(c.relpages, 0), 3),
    'tuples_per_full_page', round(d.per_full_page, 2),
    'packed_pages_needed', ceil(c.reltuples / GREATEST(d.per_full_page, 1))::bigint,
    'empty_pages_est',     GREATEST(c.relpages - ceil(c.reltuples / GREATEST(d.per_full_page, 1))::bigint, 0),
    'pct_empty_est',       round(100 * GREATEST(c.relpages - ceil(c.reltuples / GREATEST(d.per_full_page, 1)), 0)
                                 / NULLIF(c.relpages, 0), 1),
    'heap',                pg_size_pretty(pg_relation_size('public.hand_history')),
    'indexes',             pg_size_pretty(pg_indexes_size('public.hand_history')),
    'total',               pg_size_pretty(pg_total_relation_size('public.hand_history'))
  )
  FROM c, d;
$fn$;

-- -- The compactor -----------------------------------------------------------
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
  SELECT enabled, COALESCE(headroom_factor, 1.25)
    INTO v_enabled, v_headroom
    FROM public.hand_history_compaction_policy
   LIMIT 1;

  IF NOT COALESCE(v_enabled, false) THEN
    RETURN jsonb_build_object('compacted', false, 'reason', 'disabled');
  END IF;

  -- GUARD 2: the whole safety argument is that an UPDATE on this table is
  -- invisible. That holds only while every trigger on it is INSERT-only
  -- (today: hand_history_club_member_stats, hand_history_fold_stats and
  -- hand_history_position_stats are all AFTER INSERT). If anyone ever adds an
  -- UPDATE trigger, moving a row would re-run club stats and double-count
  -- somebody's profit, so refuse rather than corrupt.
  IF EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.hand_history'::regclass
       AND NOT t.tgisinternal
       AND (t.tgtype & 16) <> 0
  ) THEN
    RETURN jsonb_build_object('compacted', false, 'reason', 'update_trigger_present');
  END IF;

  -- GUARD 3: an UPDATE on a replicated table is a broadcast. hand_history is
  -- in no publication today; if that changes, stop rather than flood clients.
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

  -- GUARD 4: already packed. Never churn a table that has nothing to give
  -- back -- that would be pure WAL and index bloat for no space.
  IF v_relpages <= v_target THEN
    RETURN jsonb_build_object('compacted', false, 'reason', 'already_compact',
                              'relpages', v_relpages, 'target_pages', v_target);
  END IF;

  -- Work the TAIL downwards. Emptying the tail is what lets VACUUM truncate;
  -- emptying the middle would reclaim nothing at all.
  v_hi := v_relpages;

  <<work>>
  LOOP
    v_ctids := NULL;

    -- Step down through page windows until one yields live rows. Most windows
    -- are empty (75% of pages are), so this walk is the normal case, and each
    -- probe is a bounded TID range scan rather than a table scan.
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

    -- The no-op. reported keeps its own value; the row is rewritten, nothing
    -- about it changes, and the free space map decides where it lands.
    UPDATE public.hand_history
       SET reported = reported
     WHERE ctid = ANY (v_ctids);

    GET DIAGNOSTICS v_round = ROW_COUNT;
    v_moved := v_moved + v_round;

    -- GUARD 5: if a batch moves nothing we are spinning. Stop.
    IF v_round = 0 THEN
      v_stop := 'no_progress';
      EXIT work;
    END IF;

    EXIT work WHEN clock_timestamp() >= v_deadline;
  END LOOP work;

  RETURN jsonb_build_object(
    'compacted',    true,
    'rows_moved',   v_moved,
    'relpages',     v_relpages,
    'target_pages', v_target,
    'lowest_page_worked', v_hi,
    'stopped',      v_stop
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.sp_compact_hand_history(integer,integer,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_hand_history_bloat() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_hand_history_bloat() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sp_compact_hand_history(integer,integer,integer) TO service_role;

-- -- Schedule ----------------------------------------------------------------
SELECT cron.unschedule('hand-history-compact')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'hand-history-compact');

SELECT cron.schedule('hand-history-compact', '0,5,10,15,20,25,30,35,40,45,50,55 * * * *', $cron$
select case
         when pg_try_advisory_lock(hashtext('hand-history-compact'))
           then (select set_config('statement_timeout','60s',true) is not null
                  and (public.sp_compact_hand_history(15, 300, 4000) ->> 'compacted') is not null)::text
         else 'skipped'
       end;
$cron$);

SELECT cron.unschedule('hand-history-compact-vacuum')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'hand-history-compact-vacuum');

SELECT cron.schedule('hand-history-compact-vacuum', '2,12,22,32,42,52 * * * *',
                     'VACUUM (SKIP_LOCKED true, TRUNCATE true) public.hand_history');

-- -- Post-apply assertions ---------------------------------------------------
DO $verify$
DECLARE v jsonb;
BEGIN
  IF to_regclass('public.hand_history_compaction_policy') IS NULL THEN
    RAISE EXCEPTION 'policy table missing after apply';
  END IF;

  UPDATE public.hand_history_compaction_policy SET enabled = false;
  v := public.sp_compact_hand_history(1, 1, 100);
  IF (v ->> 'reason') IS DISTINCT FROM 'disabled' THEN
    RAISE EXCEPTION 'kill switch did not hold: %', v;
  END IF;
  UPDATE public.hand_history_compaction_policy SET enabled = true;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'hand-history-compact') THEN
    RAISE EXCEPTION 'compaction job was not scheduled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'hand-history-compact-vacuum') THEN
    RAISE EXCEPTION 'vacuum job was not scheduled';
  END IF;
END
$verify$;
