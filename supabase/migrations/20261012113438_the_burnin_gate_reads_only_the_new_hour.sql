-- the_burnin_gate_reads_only_the_new_hour
--
-- THE BURN-IN GATE READS ONLY THE NEW HOUR (2026-10-12). Full account:
-- docs/changelog/2026-10-12-the-burnin-gate-reads-only-the-new-hour.md.
--
-- Measured on production (kuklfnapbkmacvwxktbh) 2026-10-12 11:00-12:00 UTC.
--
-- 20261011200626 replaced the burn-in gate's 24 hour FILTER over
-- ca_settlements with two "index-only" counts (all rows minus final rows in
-- the window). They are index-only in name only. ca_settlements prunes about
-- 1.2 million final rows a day and new rows land on the freed pages, so the
-- pages of the last day are rarely all-visible (61 percent of the table is),
-- and every state transition of a hand settlement (seven, the last never HOT
-- because state is the partial index predicate) leaves a dead entry in
-- idx_ca_settlements_updated_at. One hour of rows (41,571) cost 278,829 heap
-- fetches and 3.9 s; four hours of final rows alone cost 31.8 s cold. The cron
-- ca-burnin-gate-hourly ran in 2 s right after the change and crept back to
-- 47, 74, 60, 55 and 62 s between 06:58 and 10:58 on 2026-10-12, against its
-- 120 s statement timeout (incident 30e42f14).
--
-- 'final' is terminal (fn_ca_settlement_transition_guard refuses any change out
-- of it) and every other transition stamps updated_at := now(). So once a
-- range of updated_at has been read with no transaction still open that could
-- write a row dated inside it, the set of NON-final rows in that range can
-- only shrink. Each run now stores that set as a proof (from, before, open ids;
-- normally no ids) in its ca_gate_runs row, and the next run re-reads only the
-- open ids by primary key plus the rows dated since the last proof: about one
-- hour of rows instead of 24. The proof ends at a horizon: 10 minutes ago, or
-- the start of the oldest open client transaction if that is earlier (a row
-- carries its writer's transaction start time). The tick reads pg_stat_activity
-- before the gate's snapshot is taken, and Postgres holds that reading for the
-- rest of the transaction (measured: two reads 3 s apart in one transaction
-- are identical), so no transaction can commit between the horizon and the
-- snapshot. With no usable proof (the first run, a failed run, an ad hoc
-- window wider than the proof) the run reads the whole window once, as now.
-- The failed and stuck counts keep their exact definitions. No index is built;
-- every other check and the output are unchanged except one new 'proof' key.
--
-- @live-proof: (SELECT position('THE GATE READS ONLY THE NEW HOUR' IN pg_get_functiondef('public.fn_ca_midway_burnin_gate(integer)'::regprocedure)) > 0 AND position('THE ACTIVITY READING COMES FIRST' IN pg_get_functiondef('public.fn_ca_burnin_gate_tick()'::regprocedure)) > 0)

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION pg_temp.ca_swap_once(p_src text, p_anchor text, p_new text, p_what text)
RETURNS text
LANGUAGE plpgsql
AS $swap$
DECLARE
  v_n integer;
BEGIN
  v_n := (length(p_src) - length(replace(p_src, p_anchor, ''))) / NULLIF(length(p_anchor), 0);
  IF v_n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'NEW_HOUR_GATE_ANCHOR_NOT_UNIQUE: % anchor found % time(s)', p_what, v_n;
  END IF;
  RETURN replace(p_src, p_anchor, p_new);
END
$swap$;

DO $mig$
DECLARE
  v_src text;
  v_new text;
BEGIN
  -- 1. fn_ca_midway_burnin_gate
  v_src := pg_get_functiondef('public.fn_ca_midway_burnin_gate(integer)'::regprocedure);
  IF position('THE GATE READS ONLY THE NEW HOUR' IN v_src) > 0 THEN
    RAISE NOTICE 'fn_ca_midway_burnin_gate already carries the change; skipping';
  ELSIF md5(v_src) <> '54cdadc56b6f49d38971ffc11374f90f' THEN
    RAISE EXCEPTION 'NEW_HOUR_GATE_PREIMAGE_CHANGED: fn_ca_midway_burnin_gate md5 %', md5(v_src);
  ELSE
    v_new := pg_temp.ca_swap_once(v_src,
$a$  v_settled_by timestamptz; v_open_before bigint;
$a$,
$w$  v_settled_by timestamptz; v_open_before bigint;
  v_horizon timestamptz; v_before timestamptz; v_prev jsonb; v_proof jsonb;
  v_open uuid[] := '{}';
$w$, 'gate declarations');

    v_new := pg_temp.ca_swap_once(v_new,
$a$  v_settled_by := now() - interval '10 minutes';
  SELECT (SELECT count(*) FROM public.ca_settlements
           WHERE updated_at > v_since AND updated_at <= v_settled_by)
       - (SELECT count(*) FROM public.ca_settlements
           WHERE state = 'final' AND updated_at > v_since AND updated_at <= v_settled_by)
    INTO v_open_before;
  IF v_open_before = 0 THEN
    c_stuck_settlements := 0;
    SELECT count(*) FILTER (WHERE state = 'failed')
      INTO c_failed_settlements
      FROM public.ca_settlements
     WHERE updated_at > GREATEST(v_since, v_settled_by);
  ELSE
    SELECT count(*) FILTER (WHERE state = 'failed'),
           count(*) FILTER (WHERE state NOT IN ('final','failed') AND updated_at < now() - interval '10 minutes')
      INTO c_failed_settlements, c_stuck_settlements
      FROM public.ca_settlements WHERE updated_at > v_since;
  END IF;
$a$,
$w$  /* THE GATE READS ONLY THE NEW HOUR (2026-10-12). The two counts above
     were index-only in name only: the pages of the last day are rarely
     all-visible (pruned pages are refilled) and each settlement transition
     leaves a dead entry in idx_ca_settlements_updated_at, so one hour cost
     278,829 heap fetches and the cron crept back to 74 s of its 120 s.
     'final' is terminal and every other transition stamps updated_at :=
     now(), so the non-final rows of a range read with no writer still open
     inside it can only shrink. Each run stores them as a proof (from,
     before, open ids) in its ca_gate_runs row; the next run re-reads the
     open ids by primary key and only the rows dated since. The proof ends at
     the horizon: 10 minutes ago, or the start of the oldest open client
     transaction if earlier. fn_ca_burnin_gate_tick reads pg_stat_activity
     before this snapshot and the reading is held for the transaction, so
     nothing can commit between the two. No usable proof means the whole
     window is read once. Failed and stuck keep their exact meaning. */
  v_settled_by := now() - interval '10 minutes';
  v_horizon := LEAST(v_settled_by,
                     COALESCE((SELECT min(a.xact_start)
                                 FROM pg_catalog.pg_stat_activity a
                                WHERE a.backend_type = 'client backend'
                                  AND a.pid <> pg_backend_pid()
                                  AND a.xact_start IS NOT NULL),
                              'infinity'::timestamptz));
  SELECT r.result->'checks'->'no_failed_or_stuck_settlements'->'proof'
    INTO v_prev
    FROM public.ca_gate_runs r
   ORDER BY r.run_at DESC
   LIMIT 1;
  v_before := (v_prev->>'before')::timestamptz;
  IF v_prev IS NULL OR jsonb_typeof(v_prev->'open') IS DISTINCT FROM 'array'
     OR (v_prev->>'from')::timestamptz IS NULL
     OR (v_prev->>'from')::timestamptz > v_since
     OR v_before IS NULL OR v_before <= v_since OR v_before > now() THEN
    v_before := v_since;
    v_open := '{}';
  ELSE
    SELECT COALESCE(array_agg(s.id), '{}') INTO v_open
      FROM public.ca_settlements s
     WHERE s.id IN (SELECT o.v::uuid FROM jsonb_array_elements_text(v_prev->'open') AS o(v))
       AND s.state <> 'final'
       AND s.updated_at > v_since AND s.updated_at < v_before;
  END IF;

  IF v_horizon > v_before THEN
    SELECT (SELECT count(*) FROM public.ca_settlements
             WHERE updated_at >= v_before AND updated_at > v_since AND updated_at < v_horizon)
         - (SELECT count(*) FROM public.ca_settlements
             WHERE state = 'final'
               AND updated_at >= v_before AND updated_at > v_since AND updated_at < v_horizon)
      INTO v_open_before;
    IF v_open_before <> 0 THEN
      SELECT v_open || COALESCE(array_agg(s.id), '{}') INTO v_open
        FROM public.ca_settlements s
       WHERE s.updated_at >= v_before AND s.updated_at > v_since AND s.updated_at < v_horizon
         AND s.state <> 'final';
    END IF;
    v_before := v_horizon;
  END IF;

  SELECT count(*) FILTER (WHERE s.state = 'failed'),
         count(*) FILTER (WHERE s.state NOT IN ('final','failed') AND s.updated_at < now() - interval '10 minutes')
    INTO c_failed_settlements, c_stuck_settlements
    FROM public.ca_settlements s
   WHERE s.id = ANY (v_open) AND s.updated_at > v_since AND s.updated_at < v_before;
  SELECT c_failed_settlements + count(*) FILTER (WHERE s.state = 'failed'),
         c_stuck_settlements + count(*) FILTER (WHERE s.state NOT IN ('final','failed') AND s.updated_at < now() - interval '10 minutes')
    INTO c_failed_settlements, c_stuck_settlements
    FROM public.ca_settlements s
   WHERE s.updated_at >= v_before AND s.updated_at > v_since;

  IF cardinality(v_open) <= 1000 THEN
    v_proof := jsonb_build_object('from', v_since, 'before', v_before, 'open', to_jsonb(v_open));
  END IF;
$w$, 'gate settlement check');

    v_new := pg_temp.ca_swap_once(v_new,
$a$'failed', c_failed_settlements, 'stuck', c_stuck_settlements),$a$,
$w$'failed', c_failed_settlements, 'stuck', c_stuck_settlements, 'proof', v_proof),$w$,
      'gate settlement output');

    EXECUTE v_new;
  END IF;

  -- 2. fn_ca_burnin_gate_tick
  v_src := pg_get_functiondef('public.fn_ca_burnin_gate_tick()'::regprocedure);
  IF position('THE ACTIVITY READING COMES FIRST' IN v_src) > 0 THEN
    RAISE NOTICE 'fn_ca_burnin_gate_tick already carries the change; skipping';
  ELSIF md5(v_src) <> '2eae5f518ef55299491fb05303356c6d' THEN
    RAISE EXCEPTION 'NEW_HOUR_GATE_PREIMAGE_CHANGED: fn_ca_burnin_gate_tick md5 %', md5(v_src);
  ELSE
    v_new := pg_temp.ca_swap_once(v_src,
$a$BEGIN
  v_gate := public.fn_ca_midway_burnin_gate(24);
$a$,
$w$BEGIN
  /* THE ACTIVITY READING COMES FIRST (2026-10-12). Postgres reads
     pg_stat_activity once per transaction and holds it. Reading it here,
     before the next statement takes the gate's snapshot, means the gate's
     settlement horizon names every transaction that could still commit a
     row the gate has not seen. */
  PERFORM count(*) FROM pg_catalog.pg_stat_activity;
  v_gate := public.fn_ca_midway_burnin_gate(24);
$w$, 'tick activity reading');

    EXECUTE v_new;
  END IF;
END
$mig$;

DO $prove$
DECLARE
  v_gate text := pg_get_functiondef('public.fn_ca_midway_burnin_gate(integer)'::regprocedure);
  v_tick text := pg_get_functiondef('public.fn_ca_burnin_gate_tick()'::regprocedure);
BEGIN
  IF position('THE GATE READS ONLY THE NEW HOUR' IN v_gate) = 0
     OR position('''proof'', v_proof' IN v_gate) = 0
     OR position('THE GATE COUNTS SETTLEMENTS WITHOUT READING THE TABLE' IN v_gate) = 0
     OR position('FROM public.ca_settlements WHERE updated_at > v_since;' IN v_gate) > 0 THEN
    RAISE EXCEPTION 'NEW_HOUR_GATE_RESULT_CHANGED: fn_ca_midway_burnin_gate';
  END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.fn_ca_midway_burnin_gate(integer)'::regprocedure) <> 's' THEN
    RAISE EXCEPTION 'NEW_HOUR_GATE_RESULT_CHANGED: the gate is no longer STABLE';
  END IF;
  IF position('THE ACTIVITY READING COMES FIRST' IN v_tick) = 0
     OR position('PERFORM count(*) FROM pg_catalog.pg_stat_activity;' IN v_tick)
        > position('v_gate := public.fn_ca_midway_burnin_gate(24);' IN v_tick) THEN
    RAISE EXCEPTION 'NEW_HOUR_GATE_RESULT_CHANGED: fn_ca_burnin_gate_tick';
  END IF;
END
$prove$;

COMMIT;
