-- A UNION CLOSE READS NARROW PROJECTIONS, NOT WIDE ROWS (2026-09-29).
--
-- Deep Stack Society's first weekly close succeeded 2026-09-29 02:30 UTC.
-- Midway Union's (fade0000-...-0001) book 2026-09-21 07:00 .. 09-28 07:00 is
-- fully evidence-resolved, but its report cannot finish without starving live
-- play: measured read-only on production 2026-09-29 (disk ~12.5 MB/s, ~2.5 ms
-- a cold random page), its statements fetch wide rows scattered over GBs:
--  * touched registrations: 364,686 tournament_players events of the week,
--    ~one 8 KB heap page each (avg row 727 B, interleaved with table_seats in
--    the 11 GB union_pnl_inventory_events), then every tournaments event of
--    each touched tournament for its Union: 19-25+ minutes, PostgREST 8 s
--    timeouts en masse while it ran.
--  * the award test: the Union filter reads tournament_snapshot, TOASTed on
--    every one of the 75k tournament_accounting_credit_receipts (~1.6 TOAST
--    page reads a row, sampled 12.7 ms a row cold), before the week filter.
--  * the hands: 375k Midway hands of the week read in full (avg 1.1 KB inline
--    evidence plus TOAST, ~0.9 ms a hand cold) by the refusal count (planned
--    through the full-week index, not the partial one) and again by the P&L.
--  * both boundaries (> 45 s each): per open registration the row-typed
--    fn_union_pnl_tournament_entry_club(r) forms a whole-row value, which
--    detoasts all four TOASTed snapshots of the receipt (measured 1.3 extra
--    page reads a receipt) for a test of six inline columns; the same call in
--    the report's entry and award tests.
--
-- The fix is structural. Three narrow, immutable projections, each written by
-- an AFTER INSERT trigger in the statement that inserts its source row (so
-- both commit or roll back together): union_pnl_inventory_touches (the
-- tournament_players and tournaments events' keys, with the frame's
-- observed_at), union_pnl_cash_outcome_touches (Union, week, the refusal shape
-- flag, the rake and each participant's three keys) and
-- union_pnl_credit_touches (the snapshot's Union and the frame's observed_at).
-- A one-time, throttled, resumable, idempotent build over the rows that
-- predate the writers, as CREATE INDEX builds an index over existing rows
-- (fn_union_pnl_projection_build_step: a TID range of at most N source pages
-- in physical order; sp_union_pnl_projection_build: steps with COMMIT and a
-- duty-cycled pause, one runner at a time). It repairs nothing (no outcome
-- was wrong; the projections are new) and schedules nothing. The build
-- covers every row committed before the writers existed: the sources' sizes
-- are read here while the triggers' SHARE ROW EXCLUSIVE locks are held, so nothing committed earlier lies above them. The report reads a
-- projection only once its build is complete; until then it reads the
-- original wide rows through the same statements as before. Either way every
-- value, issue and refusal is identical (native qualification below). The
-- whole-row entry test becomes fn_union_pnl_tournament_entry_club_of (the
-- same CASE, column for column). No projected source, frame or ledger changes;
-- no balance is written; none of the three sources is a declared money table.
--
-- Native qualification: scripts/dev/test-union-pnl-narrow-reads.sh (randomized
-- books, before/after the build and capture-time paths, red controls, IO book).
-- Apply procedure and build throttle: the PR description.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '16dcb8e9165ddd478802f24fbd22cab3' THEN
    RAISE EXCEPTION 'preimage mismatch: fn_union_pnl_evidence_report is not 20260929001003' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_boundary(uuid,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '0e1fb7d6826b5a95ce5e637174017ede' THEN
    RAISE EXCEPTION 'preimage mismatch: fn_union_pnl_boundary is not 20260928222109 (#5552)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_tournament_entry_club(tournament_participant_funding_receipts)'::regprocedure)) IS DISTINCT FROM 'b49d259721d3eb9c1d8ba7061fd28b7e' THEN
    RAISE EXCEPTION 'preimage mismatch: fn_union_pnl_tournament_entry_club is not the live definition' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_inventory_observe()'::regprocedure)) IS DISTINCT FROM '11c7c788d943a11375a15819e78873ba' THEN
    RAISE EXCEPTION 'preimage mismatch: fn_union_pnl_inventory_observe is not the live writer (frame before event)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_receipt_frame()'::regprocedure)) IS DISTINCT FROM 'dd4dbe3a58dc48bd67aab9ac818280d2' THEN
    RAISE EXCEPTION 'preimage mismatch: fn_union_pnl_receipt_frame is not the live receipt framer' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_original_frame()'::regprocedure)) IS DISTINCT FROM '9a6559774cc1ed4ed49b315a3428abdb' THEN
    RAISE EXCEPTION 'preimage mismatch: fn_union_pnl_original_frame is not the live framer' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_inventory_immutable()'::regprocedure)) IS DISTINCT FROM '307d83a1ee3d912bade24c48144aa801' THEN
    RAISE EXCEPTION 'preimage mismatch: fn_union_pnl_inventory_immutable is not the live immutability guard' USING ERRCODE='55000'; END IF;
  IF to_regclass('public.union_pnl_inventory_touches') IS NOT NULL
     OR to_regclass('public.union_pnl_cash_outcome_touches') IS NOT NULL
     OR to_regclass('public.union_pnl_credit_touches') IS NOT NULL
     OR to_regclass('public.union_pnl_projection_build') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_compact_participants(jsonb)') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_cash_outcome_touch_row(uuid,bigint,timestamp with time zone,jsonb,jsonb)') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_inventory_touch()') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_cash_outcome_touch()') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_credit_touch()') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_projection_build_guard()') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_projection_ready(text)') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_projection_build_step(text,integer)') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_projection_build_pending()') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_projection_status()') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_projection_verify(real)') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_touched_registrations(timestamp with time zone,timestamp with time zone,boolean)') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_tournament_in_union(text,uuid,boolean)') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_first_inventory_operation(text,uuid,boolean)') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_week_shaped_hands(uuid,timestamp with time zone,timestamp with time zone,boolean)') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_week_hand_lines(uuid,timestamp with time zone,timestamp with time zone,boolean)') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_week_union_credits(uuid,timestamp with time zone,timestamp with time zone,boolean)') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_tournament_entry_club_of(text,numeric,uuid,uuid,uuid,jsonb)') IS NOT NULL
     OR to_regprocedure('public.sp_union_pnl_projection_build(integer,integer,integer,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'preimage mismatch: projection objects already exist' USING ERRCODE='55000';
  END IF;
  IF to_regclass('public.union_pnl_cash_outcome_link_resolutions') IS NULL OR to_regclass('public.union_pnl_opening_registration_resolutions') IS NULL THEN
    RAISE EXCEPTION 'preimage mismatch: 20260928222109 and 20260929001003 are required' USING ERRCODE='55000';
  END IF;
  -- the projections rely on immutable sources and frames
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgfoid='public.fn_union_pnl_inventory_immutable()'::regprocedure
       AND tgrelid IN ('public.union_pnl_inventory_events'::regclass,'public.union_pnl_cash_outcomes'::regclass,'public.union_pnl_transaction_frames'::regclass))<>3
     OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgrelid='public.tournament_accounting_credit_receipts'::regclass
       AND tgname='original_evidence_immutable')
     OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgrelid='public.tournament_accounting_credit_receipts'::regclass
       AND tgname='original_union_pnl_frame' AND tgfoid='public.fn_union_pnl_receipt_frame()'::regprocedure) THEN
    RAISE EXCEPTION 'preimage mismatch: a projected source is not immutable or not framed' USING ERRCODE='55000';
  END IF;
END $pre$;

-- ── 1. The narrow projections, each written in the same statement as its row ──
-- One row per union_pnl_inventory_events row of the two sources the close
-- reads by week (tournament_players, tournaments): only the keys the report and
-- the boundary use, plus the observed_at of the event's transaction frame
-- (the frame the report joins; frames are immutable and written before any
-- event of their transaction by fn_union_pnl_inventory_observe).
CREATE TABLE public.union_pnl_inventory_touches (
  event_id bigint PRIMARY KEY,
  source_name text NOT NULL CHECK (source_name IN ('tournament_players','tournaments')),
  row_id uuid NOT NULL,
  observed_at timestamptz NOT NULL,
  transaction_id xid8 NOT NULL,
  frame_observed_at timestamptz,
  operation text NOT NULL,
  tournament_id text,
  union_id text
);
CREATE INDEX union_pnl_inventory_touches_week ON public.union_pnl_inventory_touches (source_name, observed_at);
CREATE INDEX union_pnl_inventory_touches_identity ON public.union_pnl_inventory_touches (source_name, row_id, event_id) INCLUDE (operation, union_id);
ALTER TABLE public.union_pnl_inventory_touches ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER original_pnl_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.union_pnl_inventory_touches
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_union_pnl_inventory_immutable();
REVOKE ALL ON TABLE public.union_pnl_inventory_touches FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.union_pnl_inventory_touches TO service_role;

-- One row per union_pnl_cash_outcomes row: the Union and week keys, whether
-- the hand has the shape only a refusal or a resolution can decide (the
-- predicate of union_pnl_cash_outcomes_unaccepted), and the three evidence
-- values the P&L reads (the rake, and each participant's club, player and
-- stack delta, in the evidence's own order and JSON values).
CREATE TABLE public.union_pnl_cash_outcome_touches (
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  recognized_at timestamptz,
  game_union_id text,
  shaped boolean NOT NULL,
  accepted_rake text,
  participants jsonb,
  PRIMARY KEY (table_id, hand_number)
);
CREATE INDEX union_pnl_cash_outcome_touches_week ON public.union_pnl_cash_outcome_touches (game_union_id, recognized_at);
ALTER TABLE public.union_pnl_cash_outcome_touches ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER original_pnl_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.union_pnl_cash_outcome_touches
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_union_pnl_inventory_immutable();
REVOKE ALL ON TABLE public.union_pnl_cash_outcome_touches FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.union_pnl_cash_outcome_touches TO service_role;

-- One row per tournament_accounting_credit_receipts row: the Union its
-- tournament snapshot names (read once here, never again per close; the
-- snapshot is TOASTed on every row) and its transaction frame's observed_at.
CREATE TABLE public.union_pnl_credit_touches (
  id uuid PRIMARY KEY,
  transaction_id xid8,
  frame_observed_at timestamptz,
  union_id text
);
CREATE INDEX union_pnl_credit_touches_week ON public.union_pnl_credit_touches (union_id, frame_observed_at);
ALTER TABLE public.union_pnl_credit_touches ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER original_pnl_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.union_pnl_credit_touches
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_union_pnl_inventory_immutable();
REVOKE ALL ON TABLE public.union_pnl_credit_touches FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.union_pnl_credit_touches TO service_role;

-- The participants the P&L reads, reduced to the three keys it reads. An
-- array keeps its order and each element's JSON values (a missing key is JSON
-- null, which ->> reads as NULL, as the original does); anything else is kept
-- as it is, so the report refuses it exactly as before.
CREATE FUNCTION public.fn_union_pnl_compact_participants(p_participants jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT CASE WHEN jsonb_typeof(p_participants)='array' THEN
   (SELECT COALESCE(jsonb_agg(jsonb_build_object('earning_club_id',e.x->'earning_club_id','user_id',e.x->'user_id',
      'observed_stack_delta',e.x->'observed_stack_delta') ORDER BY e.n),'[]'::jsonb)
    FROM jsonb_array_elements(p_participants) WITH ORDINALITY e(x,n))
  ELSE p_participants END
$function$;

-- The one definition of a cash outcome's projection (writer and backfill).
CREATE FUNCTION public.fn_union_pnl_cash_outcome_touch_row(p_table_id uuid, p_hand_number bigint, p_recognized_at timestamptz,
  p_game_scope jsonb, p_evidence jsonb)
 RETURNS SETOF public.union_pnl_cash_outcome_touches
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT p_table_id,p_hand_number,p_recognized_at,p_game_scope->>'game_union_id',
  (p_evidence->>'status' IS DISTINCT FROM 'ready' OR p_evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
   OR p_evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR p_evidence->'game_scope' IS DISTINCT FROM p_game_scope),
  p_evidence->>'accepted_rake',public.fn_union_pnl_compact_participants(p_evidence->'participants')
$function$;

-- The writers. Each runs AFTER INSERT in the inserting statement, so a source
-- row and its projection commit or roll back together. Nothing here can fail
-- on a row (no casts; the key conflict a backfill could race is absorbed).
CREATE FUNCTION public.fn_union_pnl_inventory_touch()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 INSERT INTO public.union_pnl_inventory_touches(event_id,source_name,row_id,observed_at,transaction_id,frame_observed_at,operation,tournament_id,union_id)
 VALUES(NEW.event_id,NEW.source_name,NEW.row_id,NEW.observed_at,NEW.transaction_id,
  (SELECT b.observed_at FROM public.union_pnl_transaction_frames b WHERE b.transaction_id=NEW.transaction_id),NEW.operation,
  COALESCE(NEW.after_row,NEW.before_row)->>'tournament_id',COALESCE(NEW.after_row,NEW.before_row)->>'union_id')
 ON CONFLICT (event_id) DO NOTHING;
 RETURN NULL;
END $function$;

CREATE FUNCTION public.fn_union_pnl_cash_outcome_touch()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 INSERT INTO public.union_pnl_cash_outcome_touches
 SELECT * FROM public.fn_union_pnl_cash_outcome_touch_row(NEW.table_id,NEW.hand_number,NEW.recognized_at,NEW.game_scope,NEW.evidence)
 ON CONFLICT (table_id,hand_number) DO NOTHING;
 RETURN NULL;
END $function$;

CREATE FUNCTION public.fn_union_pnl_credit_touch()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 INSERT INTO public.union_pnl_credit_touches(id,transaction_id,frame_observed_at,union_id)
 VALUES(NEW.id,NEW.transaction_id,(SELECT b.observed_at FROM public.union_pnl_transaction_frames b WHERE b.transaction_id=NEW.transaction_id),
  NEW.tournament_snapshot->>'union_id')
 ON CONFLICT (id) DO NOTHING;
 RETURN NULL;
END $function$;

-- ── 2. Backfill state: a projection is read only once it is complete ────────
-- end_block is the source's size taken in this migration while it holds the
-- trigger's SHARE ROW EXCLUSIVE lock: every row committed before the writer
-- existed lies below it, and every later row has its projection from the
-- writer. The backfill walks [0, end_block) in physical order.
CREATE TABLE public.union_pnl_projection_build (
  projection text PRIMARY KEY CHECK (projection IN ('inventory_touches','cash_outcome_touches','credit_touches')),
  end_block bigint NOT NULL CHECK (end_block >= 0),
  next_block bigint NOT NULL DEFAULT 0 CHECK (next_block >= 0),
  rows_written bigint NOT NULL DEFAULT 0,
  steps bigint NOT NULL DEFAULT 0,
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz,
  completed_at timestamptz,
  CHECK ((completed_at IS NOT NULL) = (next_block >= end_block))
);
ALTER TABLE public.union_pnl_projection_build ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.union_pnl_projection_build FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.union_pnl_projection_build TO service_role;

CREATE FUNCTION public.fn_union_pnl_projection_build_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF TG_OP<>'UPDATE' OR current_setting('app.union_pnl_projection_build',true) IS DISTINCT FROM 'on'
  OR NEW.projection<>OLD.projection OR NEW.end_block<>OLD.end_block OR NEW.next_block<OLD.next_block
  OR NEW.installed_at<>OLD.installed_at OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at) THEN
  RAISE EXCEPTION 'union_pnl_projection_build_is_written_only_by_its_step' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER union_pnl_projection_build_guard BEFORE UPDATE OR DELETE ON public.union_pnl_projection_build
  FOR EACH ROW EXECUTE FUNCTION public.fn_union_pnl_projection_build_guard();
CREATE TRIGGER union_pnl_projection_build_no_truncate BEFORE TRUNCATE ON public.union_pnl_projection_build
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_union_pnl_inventory_immutable();

CREATE FUNCTION public.fn_union_pnl_projection_ready(p_projection text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT COALESCE((SELECT b.completed_at IS NOT NULL FROM public.union_pnl_projection_build b WHERE b.projection=p_projection),false)
$function$;

-- One throttled, idempotent, resumable step: at most p_max_blocks source
-- pages, read in physical order (a TID range scan), projected with the
-- writer's own expressions, ON CONFLICT DO NOTHING. Safe to repeat, to stop at
-- any point and to run beside live play; steps of one projection serialize on
-- its state row.
CREATE FUNCTION public.fn_union_pnl_projection_build_step(p_projection text, p_max_blocks integer DEFAULT 128)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s public.union_pnl_projection_build; lo bigint; hi bigint; lo_tid tid; hi_tid tid; n bigint:=0;
BEGIN
 IF p_max_blocks IS NULL OR p_max_blocks NOT BETWEEN 1 AND 8192 THEN
  RAISE EXCEPTION 'invalid_union_pnl_projection_build_batch' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM public.union_pnl_projection_build WHERE projection=p_projection FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'unknown_union_pnl_projection:%',p_projection USING ERRCODE='22023'; END IF;
 IF s.completed_at IS NOT NULL THEN
  RETURN jsonb_build_object('projection',p_projection,'status','complete','next_block',s.next_block,'end_block',s.end_block,
   'rows_written',s.rows_written,'completed_at',s.completed_at);
 END IF;
 lo:=s.next_block; hi:=least(s.next_block+p_max_blocks,s.end_block);
 lo_tid:=format('(%s,0)',lo)::tid; hi_tid:=format('(%s,0)',hi)::tid;
 IF p_projection='inventory_touches' THEN
  INSERT INTO public.union_pnl_inventory_touches(event_id,source_name,row_id,observed_at,transaction_id,frame_observed_at,operation,tournament_id,union_id)
  SELECT e.event_id,e.source_name,e.row_id,e.observed_at,e.transaction_id,b.observed_at,e.operation,
   COALESCE(e.after_row,e.before_row)->>'tournament_id',COALESCE(e.after_row,e.before_row)->>'union_id'
  FROM public.union_pnl_inventory_events e
  LEFT JOIN public.union_pnl_transaction_frames b ON b.transaction_id=e.transaction_id
  WHERE e.ctid>=lo_tid AND e.ctid<hi_tid AND e.source_name IN ('tournament_players','tournaments')
  ON CONFLICT (event_id) DO NOTHING;
 ELSIF p_projection='cash_outcome_touches' THEN
  INSERT INTO public.union_pnl_cash_outcome_touches
  SELECT t.* FROM public.union_pnl_cash_outcomes o
  CROSS JOIN LATERAL public.fn_union_pnl_cash_outcome_touch_row(o.table_id,o.hand_number,o.recognized_at,o.game_scope,o.evidence) t
  WHERE o.ctid>=lo_tid AND o.ctid<hi_tid
  ON CONFLICT (table_id,hand_number) DO NOTHING;
 ELSE
  INSERT INTO public.union_pnl_credit_touches(id,transaction_id,frame_observed_at,union_id)
  SELECT c.id,c.transaction_id,b.observed_at,c.tournament_snapshot->>'union_id'
  FROM public.tournament_accounting_credit_receipts c
  LEFT JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
  WHERE c.ctid>=lo_tid AND c.ctid<hi_tid
  ON CONFLICT (id) DO NOTHING;
 END IF;
 GET DIAGNOSTICS n=ROW_COUNT;
 PERFORM set_config('app.union_pnl_projection_build','on',true);
 UPDATE public.union_pnl_projection_build SET next_block=hi,rows_written=rows_written+n,steps=steps+1,updated_at=clock_timestamp(),
  completed_at=CASE WHEN hi>=end_block THEN clock_timestamp() END
 WHERE projection=p_projection;
 PERFORM set_config('app.union_pnl_projection_build','',true);
 RETURN jsonb_build_object('projection',p_projection,'status',CASE WHEN hi>=s.end_block THEN 'complete' ELSE 'running' END,
  'blocks',hi-lo,'rows',n,'next_block',hi,'end_block',s.end_block);
END $function$;

CREATE FUNCTION public.fn_union_pnl_projection_build_pending()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT b.projection FROM public.union_pnl_projection_build b WHERE b.completed_at IS NULL ORDER BY b.projection LIMIT 1
$function$;

-- The throttle: steps with a COMMIT and a pause between them, for at most
-- p_budget_seconds, one runner at a time. The pause keeps the backfill's share
-- of the disk at p_duty_percent: after a step that took t seconds it sleeps
-- t*(100-p_duty_percent)/p_duty_percent (never less than p_pause_ms). A step
-- reads p_max_blocks pages of inventory events (sequential), half as many of
-- cash outcomes (a TOASTed evidence in about one row of eight) and an eighth as
-- many of credits (every tournament snapshot TOASTed, frames looked up at
-- random). Run it from pg_cron each minute until
-- fn_union_pnl_projection_status() reports every projection complete.
-- A procedure (not SECURITY DEFINER, no SET) so that it may COMMIT.
CREATE PROCEDURE public.sp_union_pnl_projection_build(p_max_blocks integer DEFAULT 128, p_pause_ms integer DEFAULT 100,
  p_budget_seconds integer DEFAULT 50, p_duty_percent integer DEFAULT 25)
 LANGUAGE plpgsql
AS $procedure$
DECLARE v_deadline timestamptz; v_projection text; v_result jsonb; v_t0 timestamptz; v_took float8;
BEGIN
 IF p_pause_ms IS NULL OR p_pause_ms NOT BETWEEN 0 AND 60000 OR p_budget_seconds IS NULL OR p_budget_seconds NOT BETWEEN 1 AND 3600
  OR p_duty_percent IS NULL OR p_duty_percent NOT BETWEEN 1 AND 100 OR p_max_blocks IS NULL OR p_max_blocks NOT BETWEEN 1 AND 8192 THEN
  RAISE EXCEPTION 'invalid_union_pnl_projection_build_throttle' USING ERRCODE='22023';
 END IF;
 IF NOT pg_try_advisory_lock(hashtextextended('union-pnl-projection-build',0)) THEN RETURN; END IF;
 v_deadline:=clock_timestamp()+make_interval(secs=>p_budget_seconds);
 LOOP
  PERFORM set_config('search_path','pg_catalog, public, pg_temp',true);
  v_projection:=public.fn_union_pnl_projection_build_pending();
  EXIT WHEN v_projection IS NULL OR clock_timestamp()>=v_deadline;
  v_t0:=clock_timestamp();
  v_result:=public.fn_union_pnl_projection_build_step(v_projection,
   CASE v_projection WHEN 'credit_touches' THEN greatest(1,p_max_blocks/8) WHEN 'cash_outcome_touches' THEN greatest(1,p_max_blocks/2) ELSE p_max_blocks END);
  COMMIT;
  v_took:=extract(epoch FROM clock_timestamp()-v_t0);
  PERFORM pg_sleep(greatest(p_pause_ms/1000.0,v_took*(100-p_duty_percent)/p_duty_percent));
 END LOOP;
 PERFORM pg_advisory_unlock(hashtextextended('union-pnl-projection-build',0));
END $procedure$;

CREATE FUNCTION public.fn_union_pnl_projection_status()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT jsonb_build_object('ready',COALESCE(bool_and(b.completed_at IS NOT NULL),false) AND count(*)=3,
  'projections',COALESCE(jsonb_agg(jsonb_build_object('projection',b.projection,'next_block',b.next_block,'end_block',b.end_block,
   'percent',CASE WHEN b.end_block=0 THEN 100 ELSE round(100.0*b.next_block/b.end_block,2) END,'rows_written',b.rows_written,'steps',b.steps,
   'installed_at',b.installed_at,'updated_at',b.updated_at,'completed_at',b.completed_at) ORDER BY b.projection),'[]'))
 FROM public.union_pnl_projection_build b
$function$;

-- A sampled proof that the projections equal their sources: every row of the
-- sampled source pages (TABLESAMPLE SYSTEM, p_percent of the pages, across the
-- whole table including the newest pages the writers filled) must have exactly
-- its projection. Read-only; cost is p_percent of each source.
CREATE FUNCTION public.fn_union_pnl_projection_verify(p_percent real DEFAULT 0.2)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r jsonb:='{}'; n bigint; bad bigint;
BEGIN
 IF p_percent IS NULL OR p_percent<=0 OR p_percent>100 THEN RAISE EXCEPTION 'invalid_union_pnl_projection_sample' USING ERRCODE='22023'; END IF;
 SELECT count(*),count(*) FILTER(WHERE t.event_id IS NULL OR (t.source_name,t.row_id,t.observed_at,t.transaction_id,t.frame_observed_at,t.operation,t.tournament_id,t.union_id)
   IS DISTINCT FROM (e.source_name,e.row_id,e.observed_at,e.transaction_id,b.observed_at,e.operation,
    COALESCE(e.after_row,e.before_row)->>'tournament_id',COALESCE(e.after_row,e.before_row)->>'union_id'))
 INTO n,bad FROM public.union_pnl_inventory_events e TABLESAMPLE SYSTEM (p_percent)
 LEFT JOIN public.union_pnl_transaction_frames b ON b.transaction_id=e.transaction_id
 LEFT JOIN public.union_pnl_inventory_touches t ON t.event_id=e.event_id
 WHERE e.source_name IN ('tournament_players','tournaments');
 r:=r||jsonb_build_object('inventory_touches',jsonb_build_object('sampled',n,'mismatched',bad));
 SELECT count(*),count(*) FILTER(WHERE t.table_id IS NULL OR to_jsonb(t) IS DISTINCT FROM to_jsonb(x))
 INTO n,bad FROM public.union_pnl_cash_outcomes o TABLESAMPLE SYSTEM (p_percent)
 CROSS JOIN LATERAL public.fn_union_pnl_cash_outcome_touch_row(o.table_id,o.hand_number,o.recognized_at,o.game_scope,o.evidence) x
 LEFT JOIN public.union_pnl_cash_outcome_touches t ON t.table_id=o.table_id AND t.hand_number=o.hand_number;
 r:=r||jsonb_build_object('cash_outcome_touches',jsonb_build_object('sampled',n,'mismatched',bad));
 SELECT count(*),count(*) FILTER(WHERE t.id IS NULL OR (t.transaction_id,t.frame_observed_at,t.union_id)
   IS DISTINCT FROM (c.transaction_id,b.observed_at,c.tournament_snapshot->>'union_id'))
 INTO n,bad FROM public.tournament_accounting_credit_receipts c TABLESAMPLE SYSTEM (p_percent)
 LEFT JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
 LEFT JOIN public.union_pnl_credit_touches t ON t.id=c.id;
 r:=r||jsonb_build_object('credit_touches',jsonb_build_object('sampled',n,'mismatched',bad));
 RETURN r||jsonb_build_object('ok',(SELECT bool_and((v->>'mismatched')::bigint=0) FROM jsonb_each(r) x(k,v)));
END $function$;

-- ── 3. The report's reads: the projection once complete, else the original ──
-- Each pair returns the same rows; the original branch is the statement the
-- report ran before this migration, verbatim.
CREATE FUNCTION public.fn_union_pnl_touched_registrations(p_start timestamptz, p_end timestamptz, p_projected boolean)
 RETURNS TABLE(registration_id uuid, touched_tournament_id text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF p_projected THEN
  RETURN QUERY SELECT i.row_id,i.tournament_id FROM public.union_pnl_inventory_touches i
   WHERE i.source_name='tournament_players' AND i.frame_observed_at>=p_start AND i.frame_observed_at<p_end
    AND i.observed_at>=p_start AND i.observed_at<p_end;
 ELSE
  RETURN QUERY SELECT i.row_id,COALESCE(i.after_row,i.before_row)->>'tournament_id' FROM public.union_pnl_inventory_events i
   JOIN public.union_pnl_transaction_frames b ON b.transaction_id=i.transaction_id
   WHERE i.source_name='tournament_players' AND b.observed_at>=p_start AND b.observed_at<p_end
    AND i.observed_at>=p_start AND i.observed_at<p_end;
 END IF;
END $function$;

CREATE FUNCTION public.fn_union_pnl_tournament_in_union(p_tournament_id text, p_union_id uuid, p_projected boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF p_projected THEN
  RETURN EXISTS(SELECT 1 FROM public.union_pnl_inventory_touches t WHERE t.source_name='tournaments'
   AND t.row_id=CASE WHEN p_tournament_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN p_tournament_id::uuid END
   AND t.row_id::text=p_tournament_id
   AND t.union_id=p_union_id::text);
 END IF;
 RETURN EXISTS(SELECT 1 FROM public.union_pnl_inventory_events t WHERE t.source_name='tournaments'
  AND t.row_id=CASE WHEN p_tournament_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN p_tournament_id::uuid END
  AND t.row_id::text=p_tournament_id
  AND COALESCE(t.after_row,t.before_row)->>'union_id'=p_union_id::text);
END $function$;

CREATE FUNCTION public.fn_union_pnl_first_inventory_operation(p_source text, p_row_id uuid, p_projected boolean)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v text;
BEGIN
 IF p_projected AND p_source IN ('tournament_players','tournaments') THEN
  SELECT t.operation INTO v FROM public.union_pnl_inventory_touches t WHERE t.source_name=p_source AND t.row_id=p_row_id ORDER BY t.event_id LIMIT 1;
 ELSE
  SELECT e.operation INTO v FROM public.union_pnl_inventory_events e WHERE e.source_name=p_source AND e.row_id=p_row_id ORDER BY e.event_id LIMIT 1;
 END IF;
 RETURN v;
END $function$;

-- The hands only a refusal or a resolution can decide, as whole rows (the
-- acceptance test reads the row): through the projection, each re-checked
-- against its row with the original predicates.
CREATE FUNCTION public.fn_union_pnl_week_shaped_hands(p_union_id uuid, p_start timestamptz, p_end timestamptz, p_projected boolean)
 RETURNS SETOF public.union_pnl_cash_outcomes
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF p_projected THEN
  RETURN QUERY SELECT o.* FROM public.union_pnl_cash_outcome_touches h
   CROSS JOIN LATERAL (SELECT q.* FROM public.union_pnl_cash_outcomes q WHERE q.table_id=h.table_id AND q.hand_number=h.hand_number) o
   WHERE h.game_union_id=p_union_id::text AND h.recognized_at>=p_start AND h.recognized_at<p_end AND h.shaped
    AND o.game_scope->>'game_union_id'=p_union_id::text AND o.recognized_at>=p_start AND o.recognized_at<p_end
    AND (o.evidence->>'status' IS DISTINCT FROM 'ready' OR o.evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
     OR o.evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR o.evidence->'game_scope' IS DISTINCT FROM o.game_scope);
 ELSE
  RETURN QUERY SELECT o.* FROM public.union_pnl_cash_outcomes o WHERE o.game_scope->>'game_union_id'=p_union_id::text AND o.recognized_at>=p_start AND o.recognized_at<p_end
   AND (o.evidence->>'status' IS DISTINCT FROM 'ready' OR o.evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
    OR o.evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR o.evidence->'game_scope' IS DISTINCT FROM o.game_scope);
 END IF;
END $function$;

-- Each of the Union's week hands: its accepted rake (text, cast by the
-- report exactly as before) and its participants.
CREATE FUNCTION public.fn_union_pnl_week_hand_lines(p_union_id uuid, p_start timestamptz, p_end timestamptz, p_projected boolean)
 RETURNS TABLE(hand_accepted_rake text, hand_participants jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF p_projected THEN
  RETURN QUERY SELECT h.accepted_rake,h.participants FROM public.union_pnl_cash_outcome_touches h
   WHERE h.game_union_id=p_union_id::text AND h.recognized_at>=p_start AND h.recognized_at<p_end;
 ELSE
  RETURN QUERY SELECT o.evidence->>'accepted_rake',o.evidence->'participants' FROM public.union_pnl_cash_outcomes o
   WHERE o.game_scope->>'game_union_id'=p_union_id::text AND o.recognized_at>=p_start AND o.recognized_at<p_end;
 END IF;
END $function$;

-- The Union's tournament credits framed in the week.
CREATE FUNCTION public.fn_union_pnl_week_union_credits(p_union_id uuid, p_start timestamptz, p_end timestamptz, p_projected boolean)
 RETURNS TABLE(credit_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF p_projected THEN
  RETURN QUERY SELECT t.id FROM public.union_pnl_credit_touches t
   WHERE t.union_id=p_union_id::text AND t.frame_observed_at>=p_start AND t.frame_observed_at<p_end;
 ELSE
  RETURN QUERY SELECT c.id FROM public.tournament_accounting_credit_receipts c
   JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
   WHERE c.tournament_snapshot->>'union_id'=p_union_id::text AND b.observed_at>=p_start AND b.observed_at<p_end;
 END IF;
END $function$;

-- fn_union_pnl_tournament_entry_club, column for column. The row-typed
-- original takes the whole receipt, and forming a whole-row value detoasts
-- every TOASTed snapshot of that receipt (four external values per row in
-- production) for a test that reads six inline columns.
CREATE FUNCTION public.fn_union_pnl_tournament_entry_club_of(p_asset text, p_amount numeric, p_funding_club_id uuid, p_ledger_id uuid,
  p_entitlement_id uuid, p_registration_snapshot jsonb)
 RETURNS uuid
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT CASE WHEN p_asset='chips' AND p_amount>0 THEN p_funding_club_id
  WHEN p_asset='chips' AND p_amount=0 AND p_ledger_id IS NULL AND p_entitlement_id IS NULL
   AND p_registration_snapshot->>'source_satellite_id' IS NULL
   AND p_registration_snapshot->'is_satellite_qualifier'='false'::jsonb
   THEN (p_registration_snapshot->>'club_id')::uuid END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_union_pnl_boundary(p_union_id uuid, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE inv jsonb; holdings jsonb:='[]'; issues jsonb:='[]'; s jsonb; t jsonb; f record; tr record;
 lineage jsonb; owned uuid; owners int; initial int; value numeric; entries int; first_op text;
 nonchips boolean; changed boolean; returned numeric; res_club uuid; res_amount numeric; v_proj boolean;
BEGIN
 inv:=public.fn_union_pnl_inventory_as_of(p_at);
 IF inv->>'status' IS DISTINCT FROM 'observed' THEN RETURN jsonb_build_object('status','blocked','inventory',inv,'holdings',holdings); END IF;
 FOR s IN SELECT x->'row' FROM jsonb_array_elements(COALESCE(inv#>'{population,table_seats}','[]')) x
  WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(inv#>'{population,tables}','[]')) y
   WHERE y#>>'{row,id}'=x#>>'{row,table_id}' AND y#>>'{row,union_id}'=p_union_id::text) LOOP
  lineage:=public.fn_cash_original_funding_lineage((s->>'user_id')::uuid,(s->>'table_id')::uuid,
   (s->>'id')::uuid,(s->>'occupancy_id')::uuid,(s->>'joined_at')::timestamptz,p_at,true);
  SELECT count(*) FILTER(WHERE r.operation_kind='buyin'),count(DISTINCT (r.funding_club_id,r.funding_union_id,r.asset)),min(r.funding_club_id::text)::uuid
   INTO initial,owners,owned FROM jsonb_array_elements(lineage->'funding_receipts') ref
   JOIN public.cash_participant_funding_receipts r ON r.id=(ref->>'id')::uuid;
  value:=public.fn_pnl_evidence_cents(s->'stack');
  IF lineage->'issues'<>'[]'::jsonb OR initial<>1 OR owners<>1 OR owned IS NULL OR value IS NULL OR value<0 THEN
   issues:=issues||jsonb_build_array(jsonb_build_object('reason','cash_boundary_original_funding_missing_or_ambiguous','seat_id',s->'id'));
  ELSE
   holdings:=holdings||jsonb_build_array(jsonb_build_object('club_id',owned,'user_id',s->'user_id','amount',value,'kind','cash_stack','source_id',s->'id'));
  END IF;
 END LOOP;
 -- Money awaiting the original add-on application is still held for its
 -- original funding account. It must not appear as a poker loss at midnight.
 FOR f IN
  SELECT r.*,r.amount-CASE WHEN COALESCE(af.observed_at,a.applied_at)<p_at THEN a.applied+a.refunded ELSE 0 END AS held
  FROM public.cash_participant_funding_receipts r
  LEFT JOIN public.cash_funding_application_receipts a ON a.funding_receipt_id=r.id
  LEFT JOIN public.union_pnl_transaction_frames rf ON rf.transaction_id=r.transaction_id
  LEFT JOIN public.union_pnl_transaction_frames af ON af.transaction_id=a.transaction_id
  WHERE r.pending_addon_id IS NOT NULL AND COALESCE(rf.observed_at,r.recorded_at)<p_at
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(inv#>'{population,tables}','[]')) y
    WHERE y#>>'{row,id}'=r.table_id::text AND y#>>'{row,union_id}'=p_union_id::text)
 LOOP
  IF f.held<0 OR f.funding_club_id IS NULL THEN
   issues:=issues||jsonb_build_array(jsonb_build_object('reason','pending_funding_boundary_invalid','source_id',f.id));
  ELSIF f.held>0 THEN
   holdings:=holdings||jsonb_build_array(jsonb_build_object('club_id',f.funding_club_id,'user_id',f.user_id,'amount',f.held,'kind','pending_cash_funding','source_id',f.id));
  END IF;
 END LOOP;
 -- Preserve the established realized-settlement rule: original gross entry
 -- less money already returned is deferred while a tournament remains open.
 -- This is not market value, ICM, or a new allocation of the prize pool.
 -- First inventory operations come from union_pnl_inventory_touches once its
 -- backfill is complete (20260929044303), else from the wide events.
 v_proj:=public.fn_union_pnl_projection_ready('inventory_touches');
 FOR t IN SELECT x->'row' FROM jsonb_array_elements(COALESCE(inv#>'{population,tournaments}','[]')) x
  WHERE x#>>'{row,union_id}'=p_union_id::text LOOP
  first_op:=public.fn_union_pnl_first_inventory_operation('tournaments',(t->>'id')::uuid,v_proj);
  -- A tournament captured as the baseline (it existed before the original
  -- inventory capture) is read only when every registration of its original
  -- population carries a valid opening resolution for this boundary
  -- (union_pnl_opening_registration_resolutions: its entry re-proved from the
  -- posted chip ledger, bound to these exact population rows). Otherwise it is
  -- refused exactly as before.
  IF first_op IS DISTINCT FROM 'INSERT' AND (first_op IS DISTINCT FROM 'baseline' OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(COALESCE(inv#>'{population,tournament_players}','[]')) y(x)
    WHERE y.x#>>'{row,tournament_id}'=t->>'id'
     AND public.fn_union_pnl_first_inventory_operation('tournament_players',(y.x#>>'{row,id}')::uuid,v_proj) IS DISTINCT FROM 'INSERT'
     AND NOT EXISTS(SELECT 1 FROM public.fn_union_pnl_opening_registration_resolution(p_union_id,p_at,t,y.x->'row')))) THEN
   issues:=issues||jsonb_build_array(jsonb_build_object('reason','open_tournament_precedes_original_population','tournament_id',t->'id')); CONTINUE;
  END IF;
  -- One set-based read per open tournament (it was four queries per seat,
  -- two of them full scans of every tournament credit): the same original
  -- entry, instrument, owner-change and returned-credit facts, per
  -- registration, in the population's order.
  FOR s,entries,owners,owned,value,nonchips,changed,returned,res_club,res_amount IN
   WITH players AS MATERIALIZED (
    SELECT y.x->'row' s,y.o ord,(y.x#>>'{row,id}')::uuid registration_id,(y.x#>>'{row,user_id}')::uuid user_id
    FROM jsonb_array_elements(COALESCE(inv#>'{population,tournament_players}','[]')) WITH ORDINALITY y(x,o)
    WHERE y.x#>>'{row,tournament_id}'=t->>'id'
   ), credits AS MATERIALIZED (
    -- fn_union_pnl_tournament_returns(t,NULL,NULL,p_at): every credit of this
    -- tournament observed before the boundary; the registration filter that
    -- function applied per call is applied per player below.
    SELECT c.user_id,c.credited_club_id,c.amount,c.entry_receipt_ids,true same_tournament
    FROM public.tournament_accounting_credit_receipts c
    JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
    WHERE c.tournament_id=(t->>'id')::uuid AND b.observed_at<p_at
    UNION ALL
    SELECT r2.user_id,r2.source_wallet_club_id,r2.amount_paid_now,ARRAY[r.id],false
    FROM public.tournament_refund_tranches r2
    JOIN public.tournament_participant_funding_receipts r ON r.entitlement_id=r2.entitlement_id
    JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r2.transaction_id
    WHERE r2.tournament_id=(t->>'id')::uuid AND b.observed_at<p_at
     AND NOT EXISTS(SELECT 1 FROM public.tournament_accounting_credit_receipts c WHERE c.ledger_id=r2.credit_ledger_id)
   ) SELECT p.s,e.entries,e.owners,e.owned,e.value,
    EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts r WHERE r.tournament_id=(t->>'id')::uuid AND r.registration_id=p.registration_id AND r.asset<>'chips'),
    k.changed,k.returned,rr.owning_club_id,rr.deferred_amount
   FROM players p
   CROSS JOIN LATERAL (SELECT count(*) entries,count(DISTINCT public.fn_union_pnl_tournament_entry_club_of(r.asset,r.amount,r.funding_club_id,r.ledger_id,r.entitlement_id,r.registration_snapshot)) owners,
     min(public.fn_union_pnl_tournament_entry_club_of(r.asset,r.amount,r.funding_club_id,r.ledger_id,r.entitlement_id,r.registration_snapshot)::text)::uuid owned,sum(r.amount) value
    FROM public.tournament_participant_funding_receipts r
    JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r.transaction_id
    WHERE r.tournament_id=(t->>'id')::uuid AND r.registration_id=p.registration_id AND b.observed_at<p_at AND r.asset='chips') e
   CROSS JOIN LATERAL (SELECT COALESCE(bool_or(c.credited_club_id<>e.owned),false) changed,sum(c.amount) returned
    FROM credits c WHERE c.user_id=p.user_id
     AND EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts r
      WHERE r.registration_id=p.registration_id AND r.id=ANY(c.entry_receipt_ids)
       AND (NOT c.same_tournament OR r.tournament_id=(t->>'id')::uuid))) k
   LEFT JOIN LATERAL (SELECT q.owning_club_id,q.deferred_amount
    FROM public.fn_union_pnl_opening_registration_resolution(p_union_id,p_at,t,p.s) q WHERE first_op='baseline') rr ON true
   ORDER BY p.ord
  LOOP
   -- In a baseline tournament a resolved registration is carried at its
   -- re-proved original entry less its returns before the boundary.
   IF res_club IS NOT NULL THEN
    holdings:=holdings||jsonb_build_array(jsonb_build_object('club_id',res_club,'user_id',s->'user_id','amount',res_amount,
     'kind','deferred_tournament_result','source_id',s->'id','basis','opening_registration_resolution'));
    CONTINUE;
   END IF;
   IF entries=0 OR owners<>1 OR owned IS NULL OR nonchips THEN
    issues:=issues||jsonb_build_array(jsonb_build_object('reason','open_tournament_original_instrument_or_earning_club_missing','registration_id',s->'id')); CONTINUE;
   END IF;
   IF changed THEN
    issues:=issues||jsonb_build_array(jsonb_build_object('reason','open_tournament_credit_owner_changed','registration_id',s->'id')); CONTINUE;
   END IF;
   value:=value-COALESCE(returned,0);
   holdings:=holdings||jsonb_build_array(jsonb_build_object('club_id',owned,'user_id',s->'user_id','amount',value,'kind','deferred_tournament_result','source_id',s->'id'));
  END LOOP;
 END LOOP;
 RETURN jsonb_build_object('status',CASE WHEN issues='[]'::jsonb THEN 'ready' ELSE 'blocked' END,'boundary',p_at,
  'inventory',inv,'holdings',holdings,'issues',issues,'tournament_basis','original_realized_settlement_deferred_while_open');
END $function$;

CREATE OR REPLACE FUNCTION public.fn_union_pnl_evidence_report(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_open jsonb; v_close jsonb; v_issues jsonb:='[]'; v_clubs jsonb; v_eco jsonb; v_terms jsonb;
 v_fence timestamptz; v_bad bigint; v_hands bigint; v_resolved bigint:=0; v_rows bigint; v_cash_reconciled boolean; v_terms_value jsonb; v_cash_rake numeric; v_accepted_rake numeric;
 v_memo_key text; v_memo jsonb; v_report jsonb; v_flows jsonb; v_open_resolved uuid[];
 v_inv boolean; v_cash boolean; v_credit boolean;
BEGIN
 IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end)
  OR p_start<>public.fn_union_week_start(p_start) OR p_end<>public.fn_union_week_start(p_start+interval '8 days')
  OR p_end>clock_timestamp() THEN RAISE EXCEPTION 'invalid_closed_pnl_evidence_period' USING ERRCODE='22023'; END IF;
 SELECT captured_at INTO v_fence FROM public.union_pnl_weekly_capture WHERE singleton;
 IF v_fence IS NULL OR p_start<=v_fence THEN
  RETURN jsonb_build_object('report_version',1,'status','blocked','basis_certified',false,'payment_authorized',false,
   'issues',jsonb_build_array('week_precedes_complete_original_capture'),'capture_started_at',v_fence,'all_players_included',false);
 END IF;
 -- UNION P&L EVIDENCE MEMO (20260928): one weekly close reaches this report
 -- through preparation (close quality), the cascade (qualified clubs, ECO,
 -- player P&L) and the invoices. Inside a union close attempt
 -- (app.accounting_close_memo='on', set only by fn_weekly_accounting_attempt_begin)
 -- the first complete report of this (union, week) is kept for the rest of
 -- the attempt; attempt_begin and attempt_end clear it and a rolled-back
 -- subtransaction forgets it with its settings. Everywhere else the report is
 -- proved on every call, exactly as before.
 IF current_setting('app.accounting_close_memo',true)='on' THEN
  v_memo_key:=p_union_id::text||'|'||p_start::text||'|'||p_end::text;
  v_memo:=NULLIF(current_setting('app.union_pnl_evidence_memo',true),'')::jsonb;
  IF v_memo ? v_memo_key THEN RETURN v_memo->v_memo_key; END IF;
 END IF;
 -- UNION P&L NARROW READS (20260929044303): the week's registration events,
 -- hands and tournament credits are read through their narrow projections
 -- (union_pnl_inventory_touches, union_pnl_cash_outcome_touches,
 -- union_pnl_credit_touches), each written by its source row's own insert,
 -- once the throttled backfill has proved it complete; until then through
 -- the original wide rows, statement for statement as before.
 v_inv:=public.fn_union_pnl_projection_ready('inventory_touches');
 v_cash:=public.fn_union_pnl_projection_ready('cash_outcome_touches');
 v_credit:=public.fn_union_pnl_projection_ready('credit_touches');
 -- Both readers wait for the original book's in-flight transactions; this
 -- function is VOLATILE so every subsequent query sees their committed facts.
 v_open:=public.fn_union_pnl_boundary(p_union_id,p_start);
 v_close:=public.fn_union_pnl_boundary(p_union_id,p_end);
 IF v_open->>'status' IS DISTINCT FROM 'ready' THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','opening_basis_incomplete','evidence',v_open)); END IF;
 IF v_close->>'status' IS DISTINCT FROM 'ready' THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','closing_basis_incomplete','evidence',v_close)); END IF;
 -- The registrations the opening boundary carried through a valid opening
 -- resolution (union_pnl_opening_registration_resolutions): each one's
 -- original entry is proved from the posted chip ledger, not a funding receipt.
 v_open_resolved:=ARRAY(SELECT (x->>'source_id')::uuid FROM jsonb_array_elements(COALESCE(v_open->'holdings','[]')) x
  WHERE x->>'kind'='deferred_tournament_result' AND x->>'basis'='opening_registration_resolution');
 -- A blocked outcome counts as accepted only through an immutable resolution
 -- receipt re-proved from primary receipts and bound to this exact outcome
 -- (hand, payload hash, evidence). The outcome row itself is never changed.
 -- Only a hand outside the ready/certified/all-players/same-scope shape can
 -- be refused or resolved: those hands (the predicate of
 -- union_pnl_cash_outcomes_unaccepted), found through the projection's shape
 -- flag and re-checked against their rows, never the whole week's evidence.
 SELECT count(*) FILTER(WHERE NOT public.fn_union_pnl_cash_outcome_accepted(o)),
  count(*) FILTER(WHERE (o.evidence->>'status' IS DISTINCT FROM 'ready' OR o.evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb)
   AND public.fn_union_pnl_cash_outcome_accepted(o))
 INTO v_bad,v_resolved FROM public.fn_union_pnl_week_shaped_hands(p_union_id,p_start,p_end,v_cash) o;
 -- A hand whose provenance link the engine never recorded (its outcome has no
 -- game scope) counts only through its immutable link resolution
 -- (union_pnl_cash_outcome_link_resolutions), in the Union its re-proved scope
 -- names, and is accepted only when its re-proved evidence is certified.
 SELECT v_bad+count(*) FILTER(WHERE NOT (k.evidence->>'status'='ready' AND k.evidence->'basis_certified'='true'::jsonb
   AND k.evidence->'all_players_included'='true'::jsonb)),
  v_resolved+count(*) FILTER(WHERE k.evidence->>'status'='ready' AND k.evidence->'basis_certified'='true'::jsonb
   AND k.evidence->'all_players_included'='true'::jsonb)
 INTO v_bad,v_resolved FROM public.fn_union_pnl_linked_cash_outcomes(p_union_id,p_start,p_end) k;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','accepted_cash_basis_incomplete','count',v_bad)); END IF;
 -- A missing original game scope cannot silently disappear from every Union.
 SELECT count(*) INTO v_bad FROM public.union_pnl_cash_outcomes WHERE recognized_at>=p_start AND recognized_at<p_end
  AND NOT game_scope ?& ARRAY['game_union_id','host_club_id','tournament_id','is_private','asset','unit_scale']
  AND NOT EXISTS(SELECT 1 FROM public.fn_union_pnl_cash_outcome_link(union_pnl_cash_outcomes));
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','accepted_cash_original_scope_missing','count',v_bad)); END IF;
 SELECT count(*) INTO v_bad FROM public.union_pnl_original_flows WHERE recognized_at>=p_start AND recognized_at<p_end
  AND NOT game_scope ?& ARRAY['game_union_id','host_club_id','tournament_id','is_private','asset','unit_scale'];
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','original_money_flow_scope_missing','count',v_bad)); END IF;
 SELECT count(*) INTO v_bad FROM public.cash_participant_funding_receipts WHERE recorded_at>=v_fence AND recorded_at<p_end AND transaction_id IS NULL;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array('post_capture_funding_transaction_identity_missing'); END IF;
 SELECT count(*) INTO v_bad FROM public.cash_funding_application_receipts WHERE applied_at>=v_fence AND applied_at<p_end AND transaction_id IS NULL;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array('post_capture_application_transaction_identity_missing'); END IF;
 SELECT count(*) INTO v_bad FROM public.cash_hand_provenance_receipts WHERE accepted_at>=v_fence AND accepted_at<p_end AND transaction_id IS NULL;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array('post_capture_hand_transaction_identity_missing'); END IF;
 -- The flow proof is read once; the P&L below reuses these exact rows.
 SELECT count(*) FILTER(WHERE NOT f.valid),COALESCE(jsonb_agg(to_jsonb(f)),'[]') INTO v_bad,v_flows
  FROM public.fn_union_pnl_original_flow_evidence(p_union_id,p_start,p_end) f;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','original_money_flow_basis_incomplete','count',v_bad)); END IF;
 -- Every touched tournament registration must have its original chip entry,
 -- including zero-rake players. Historical/current membership is never used.
 -- The week's registration events, each touched tournament's Union proved
 -- once through its own events (t.row_id::text equality kept; the uuid
 -- equality only lets the index find the same rows and is never attempted on
 -- a non-canonical id). The frame test is unchanged; i.observed_at repeats it
 -- because fn_union_pnl_inventory_observe, the only writer of framed events,
 -- stamps each event with its frame's observed_at (both tables immutable), so
 -- the same rows are reached through union_pnl_inventory_events_players_observed.
 -- Both reads (fn_union_pnl_touched_registrations, fn_union_pnl_tournament_in_union)
 -- come from union_pnl_inventory_touches once it is complete: the same keys,
 -- the frame's observed_at copied at capture, without the wide rows.
 WITH touched AS MATERIALIZED (
  SELECT w.registration_id row_id,w.touched_tournament_id tournament_id
  FROM public.fn_union_pnl_touched_registrations(p_start,p_end,v_inv) w
 ), union_tournaments AS MATERIALIZED (
  SELECT d.tournament_id FROM (SELECT DISTINCT tournament_id FROM touched) d
  WHERE public.fn_union_pnl_tournament_in_union(d.tournament_id,p_union_id,v_inv)
 ), union_touched AS MATERIALIZED (
  SELECT i.row_id FROM touched i WHERE i.tournament_id IN (SELECT tournament_id FROM union_tournaments)
 ), entries AS MATERIALIZED (
  -- the two receipt tests, read once per touched registration (column for
  -- column: a whole-row argument would detoast every receipt's snapshots)
  SELECT r.registration_id,
   bool_or(r.asset='chips' AND public.fn_union_pnl_tournament_entry_club_of(r.asset,r.amount,r.funding_club_id,r.ledger_id,r.entitlement_id,r.registration_snapshot) IS NOT NULL) has_entry,
   bool_or(r.asset<>'chips' OR public.fn_union_pnl_tournament_entry_club_of(r.asset,r.amount,r.funding_club_id,r.ledger_id,r.entitlement_id,r.registration_snapshot) IS NULL) has_other
  FROM public.tournament_participant_funding_receipts r
  WHERE r.registration_id IN (SELECT row_id FROM union_touched)
  GROUP BY r.registration_id
 ) SELECT count(*) INTO v_bad FROM union_touched i LEFT JOIN entries e ON e.registration_id=i.row_id
 WHERE (NOT COALESCE(e.has_entry,false) AND i.row_id<>ALL(v_open_resolved)
   AND public.fn_union_pnl_satellite_seat_owner(i.row_id,NULL) IS NULL)
  OR COALESCE(e.has_other,false);
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','tournament_original_population_or_instrument_incomplete','count',v_bad)); END IF;
 -- An award must return to the original funding club; a changed credited
 -- wallet does not prove a new earning ownership agreement.
 -- The week's credits of this Union (its tournament snapshot's Union, its
 -- frame in the week) come from union_pnl_credit_touches once complete. The
 -- two whole-row resolutions (a whole-row value detoasts every snapshot of
 -- the credit) are asked only of a credit the entry test did not settle: the
 -- same conjunction, in an order the planner may not change.
 SELECT count(*) INTO v_bad FROM public.fn_union_pnl_week_union_credits(p_union_id,p_start,p_end,v_credit) w
 JOIN public.tournament_accounting_credit_receipts c ON c.id=w.credit_id
 WHERE CASE WHEN (cardinality(c.entry_receipt_ids)=0 OR EXISTS(SELECT 1 FROM unnest(c.entry_receipt_ids) original_id(receipt_id)
   LEFT JOIN public.tournament_participant_funding_receipts r ON r.id=original_id.receipt_id
   WHERE r.id IS NULL OR r.asset<>'chips' OR public.fn_union_pnl_tournament_entry_club_of(r.asset,r.amount,r.funding_club_id,r.ledger_id,r.entitlement_id,r.registration_snapshot) IS DISTINCT FROM c.credited_club_id OR r.user_id IS DISTINCT FROM c.user_id))
  THEN NOT public.fn_union_pnl_award_owner_resolved(c,p_union_id,p_start,v_open_resolved)
   AND NOT public.fn_union_pnl_award_satellite_owner(c) ELSE false END;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','tournament_award_original_earning_owner_incomplete','count',v_bad)); END IF;
 v_eco:=public.fn_union_eco_terms_evidence(p_union_id,p_start,p_end);
 IF v_eco->>'status' IS DISTINCT FROM 'ready' THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','eco_commercial_basis_incomplete','evidence',v_eco)); END IF;
 SELECT count(DISTINCT x->'terms') INTO v_bad FROM jsonb_array_elements(COALESCE(v_eco->'segments','[]')) x;
 IF v_bad<>1 THEN v_issues:=v_issues||jsonb_build_array('eco_intraweek_changed_terms_require_original_allocation'); END IF;
 v_terms_value:=v_eco#>'{segments,0,terms}';
 -- Validate every original bank/source leg even when the week has no rows.
 PERFORM public.fn_accounting_union_earned_plan(p_union_id,p_start,p_end);
 WITH flows AS MATERIALIZED (SELECT * FROM jsonb_to_recordset(v_flows)
  AS f(ledger_id uuid,club_id uuid,user_id uuid,buyins numeric,cashouts numeric,kind text,valid boolean)),
 -- One read of the week's hands: each (club, player) delta total, and (kind 0)
 -- the hand count and accepted rake that used to cost two more reads.
 outcome_pass AS MATERIALIZED (
  SELECT x.kind,x.club_id,x.user_id,sum(x.delta) delta,count(*) hands,sum(x.rake) rake
  FROM (SELECT h.hand_accepted_rake accepted_rake,h.hand_participants participants
   FROM public.fn_union_pnl_week_hand_lines(p_union_id,p_start,p_end,v_cash) h
   -- with this Union's linked hands, through their link resolutions
   UNION ALL SELECT k.evidence->>'accepted_rake',k.evidence->'participants' FROM public.fn_union_pnl_linked_cash_outcomes(p_union_id,p_start,p_end) k) o CROSS JOIN LATERAL (
   SELECT 0 kind,NULL::uuid club_id,NULL::uuid user_id,NULL::numeric delta,o.accepted_rake::numeric rake
   UNION ALL
   SELECT 1,(p->>'earning_club_id')::uuid,(p->>'user_id')::uuid,(p->>'observed_stack_delta')::numeric,NULL::numeric
   FROM jsonb_array_elements(COALESCE(o.participants,'[]')) p) x
  GROUP BY x.kind,x.club_id,x.user_id
 ), hand_players AS (SELECT club_id,user_id,delta FROM outcome_pass WHERE kind=1), opening AS (SELECT (x->>'club_id')::uuid club_id,sum((x->>'amount')::numeric) amount,
   sum((x->>'amount')::numeric) FILTER(WHERE x->>'kind'<>'deferred_tournament_result') cash
   FROM jsonb_array_elements(COALESCE(v_open->'holdings','[]')) x GROUP BY 1),
 closing AS (SELECT (x->>'club_id')::uuid club_id,sum((x->>'amount')::numeric) amount,
   sum((x->>'amount')::numeric) FILTER(WHERE x->>'kind'<>'deferred_tournament_result') cash
   FROM jsonb_array_elements(COALESCE(v_close->'holdings','[]')) x GROUP BY 1),
 -- The canonical payout basis excludes retained Union-house rake. Gross
 -- original rake still belongs in the all-player P&L and bank reconciliation.
 rake AS MATERIALIZED (
  SELECT s.club_id,sum(s.rake_credit) generated,COALESCE(k.earned,0) earned,
   sum(s.rake_credit) FILTER(WHERE s.source_type='cash_rake_accrual') cash_rake,
   sum(s.rake_credit) FILTER(WHERE s.source_type='tournament_fee_accrual') tournament_rake
  FROM public.accounting_payable_earning_sources s
  LEFT JOIN (SELECT club_id,sum(payout) earned FROM public.fn_union_club_rake_basis(p_union_id,p_start,p_end) GROUP BY club_id) k ON k.club_id=s.club_id
  WHERE s.union_id=p_union_id AND s.earned_at>=p_start AND s.earned_at<p_end GROUP BY s.club_id,k.earned
 ),
 roster AS (
  SELECT DISTINCT (COALESCE(after_row,before_row)->>'club_id')::uuid club_id FROM public.union_pnl_inventory_events
   WHERE source_name='union_clubs' AND COALESCE(after_row,before_row)->>'union_id'=p_union_id::text AND observed_at<p_end
    AND (observed_at>=p_start OR row_id::text IN(SELECT x#>>'{row,id}' FROM jsonb_array_elements(COALESCE(v_open#>'{inventory,population,union_clubs}','[]')) x))
  UNION SELECT club_id FROM rake UNION SELECT club_id FROM flows UNION SELECT club_id FROM hand_players UNION SELECT club_id FROM opening UNION SELECT club_id FROM closing
 ), movement AS (SELECT club_id,sum(buyins) buyins,sum(cashouts) cashouts,
  sum(cashouts-buyins) FILTER(WHERE kind IN('cash_funding','cash_return')) cash_flow,
  sum(buyins) FILTER(WHERE kind='cash_funding') cash_buyins,sum(cashouts) FILTER(WHERE kind='cash_return') cash_cashouts FROM flows GROUP BY club_id),
 hands AS (SELECT club_id,sum(delta) delta FROM hand_players GROUP BY club_id),
 people AS (SELECT club_id,count(DISTINCT user_id)::int players FROM(SELECT club_id,user_id FROM flows UNION SELECT club_id,user_id FROM hand_players
  UNION SELECT (x->>'club_id')::uuid,(x->>'user_id')::uuid FROM jsonb_array_elements(COALESCE(v_open->'holdings','[]')||COALESCE(v_close->'holdings','[]')) x) q GROUP BY club_id),
 club_rows AS (
  SELECT r.club_id,COALESCE(m.buyins,0) buyins,COALESCE(m.cashouts,0) cashouts,COALESCE(m.cash_buyins,0) cash_buyins,COALESCE(m.cash_cashouts,0) cash_cashouts,
   COALESCE(m.cashouts,0)-COALESCE(m.buyins,0) realized_net,COALESCE(o.amount,0) seated_start,COALESCE(c.amount,0) seated_end,
   COALESCE(o.cash,0) seated_start_cash,COALESCE(c.cash,0) seated_end_cash,
   COALESCE(c.amount,0)-COALESCE(o.amount,0) stack_delta,COALESCE(h.delta,0) cash_player_pnl,
   COALESCE(m.cashouts,0)-COALESCE(m.buyins,0)+COALESCE(c.amount,0)-COALESCE(o.amount,0)-COALESCE(h.delta,0) tournament_player_pnl,
   COALESCE(m.cash_flow,0)+COALESCE(c.cash,0)-COALESCE(o.cash,0)=COALESCE(h.delta,0) cash_reconciled,
   COALESCE(p.players,0) players,COALESCE(k.generated,0) rake_paid,COALESCE(k.earned,0) rake_earned,COALESCE(k.cash_rake,0) cash_rake,COALESCE(k.tournament_rake,0) tournament_rake,
   COALESCE(m.cashouts,0)-COALESCE(m.buyins,0)+COALESCE(c.amount,0)-COALESCE(o.amount,0)+COALESCE(k.generated,0) net
  FROM roster r LEFT JOIN movement m USING(club_id) LEFT JOIN opening o USING(club_id) LEFT JOIN closing c USING(club_id)
  LEFT JOIN hands h USING(club_id) LEFT JOIN people p USING(club_id) LEFT JOIN rake k USING(club_id)
  WHERE r.club_id IS NOT NULL
 ), player_results AS (
  SELECT club_id,user_id,sum(delta) delta FROM (
   SELECT club_id,user_id,cashouts-buyins delta FROM flows
   UNION ALL SELECT (x->>'club_id')::uuid,(x->>'user_id')::uuid,(x->>'amount')::numeric FROM jsonb_array_elements(COALESCE(v_close->'holdings','[]')) x
   UNION ALL SELECT (x->>'club_id')::uuid,(x->>'user_id')::uuid,-(x->>'amount')::numeric FROM jsonb_array_elements(COALESCE(v_open->'holdings','[]')) x
  ) amounts GROUP BY club_id,user_id
 ), wins AS(SELECT club_id,sum(greatest(delta,0)) winnings,sum(greatest(-delta,0)) losses FROM player_results GROUP BY club_id), complete AS (
  SELECT q.*,COALESCE(w.winnings,0) winnings,COALESCE(w.losses,0) losses,
   CASE v_terms_value->>'eco_base_mode'
    WHEN 'club_cash_profit' THEN rake_earned-cash_player_pnl
    WHEN 'net_invoice_position' THEN realized_net+stack_delta+rake_paid+rake_earned
    WHEN 'winnings_plus_rake' THEN realized_net+stack_delta+rake_paid
    WHEN 'winnings_only' THEN realized_net+stack_delta END eco_base
  FROM club_rows q LEFT JOIN wins w USING(club_id)
 ) SELECT COALESCE(jsonb_agg(to_jsonb(q)||jsonb_build_object('eco_amount',CASE WHEN v_terms_value->'eco_enabled'='true'::jsonb
  THEN round(-(v_terms_value->>'eco_rate')::numeric*eco_base,2) ELSE 0 END) ORDER BY club_id),'[]'),
  COALESCE(bool_and(cash_reconciled),true),count(*),COALESCE(sum(cash_rake),0),
  COALESCE((SELECT h.hands FROM outcome_pass h WHERE h.kind=0),0),(SELECT COALESCE(sum(h.rake),0) FROM outcome_pass h WHERE h.kind=0)
  INTO v_clubs,v_cash_reconciled,v_rows,v_cash_rake,v_hands,v_accepted_rake FROM complete q;
 IF v_accepted_rake IS DISTINCT FROM v_cash_rake THEN v_issues:=v_issues||jsonb_build_array('accepted_cash_rake_does_not_match_original_earning_and_bank_basis'); END IF;
 IF NOT v_cash_reconciled THEN v_issues:=v_issues||jsonb_build_array('accepted_cash_deltas_do_not_reconcile_original_flows_and_boundaries'); END IF;
 v_report:=jsonb_build_object('report_version',1,'status',CASE WHEN v_issues='[]'::jsonb THEN 'ready' ELSE 'blocked' END,
  'basis_certified',v_issues='[]'::jsonb,'payment_authorized',false,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,
  'issues',v_issues,'clubs',v_clubs,'opening_basis',v_open,'closing_basis',v_close,'eco_commercial_terms_evidence',v_eco,
  'accepted_cash_hands',v_hands,'accepted_cash_hands_resolved',v_resolved,'club_count',v_rows,'current_seats_used',false,'current_membership_used',false,
  'all_players_included',v_issues='[]'::jsonb,'tournament_basis','original_realized_settlement_deferred_while_open');
 IF v_memo_key IS NOT NULL THEN
  PERFORM set_config('app.union_pnl_evidence_memo',(COALESCE(NULLIF(current_setting('app.union_pnl_evidence_memo',true),'')::jsonb,'{}')
   ||jsonb_build_object(v_memo_key,v_report))::text,true);
 END IF;
 RETURN v_report;
END $function$;

REVOKE ALL ON FUNCTION public.fn_union_pnl_compact_participants(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_cash_outcome_touch_row(uuid,bigint,timestamp with time zone,jsonb,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_touch() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_cash_outcome_touch() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_credit_touch() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_projection_build_guard() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_projection_ready(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_projection_build_step(text,integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_projection_build_pending() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_projection_status() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_projection_verify(real) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_touched_registrations(timestamp with time zone,timestamp with time zone,boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_tournament_in_union(text,uuid,boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_first_inventory_operation(text,uuid,boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_week_shaped_hands(uuid,timestamp with time zone,timestamp with time zone,boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_week_hand_lines(uuid,timestamp with time zone,timestamp with time zone,boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_week_union_credits(uuid,timestamp with time zone,timestamp with time zone,boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_tournament_entry_club_of(text,numeric,uuid,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_boundary(uuid,timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON PROCEDURE public.sp_union_pnl_projection_build(integer,integer,integer,integer) FROM PUBLIC, anon, authenticated, service_role;

-- ── 4. The writers go live last: each takes its source's SHARE ROW EXCLUSIVE
-- lock (waiting out, under lock_timeout, every transaction that already wrote
-- the source), and the source's size is read under that lock. Every row
-- committed before the writer lies below end_block; every later row is
-- projected by the writer in its own statement.
CREATE TRIGGER union_pnl_inventory_touch AFTER INSERT ON public.union_pnl_inventory_events
  FOR EACH ROW WHEN (NEW.source_name IN ('tournament_players','tournaments')) EXECUTE FUNCTION public.fn_union_pnl_inventory_touch();
CREATE TRIGGER union_pnl_cash_outcome_touch AFTER INSERT ON public.union_pnl_cash_outcomes
  FOR EACH ROW EXECUTE FUNCTION public.fn_union_pnl_cash_outcome_touch();
CREATE TRIGGER union_pnl_credit_touch AFTER INSERT ON public.tournament_accounting_credit_receipts
  FOR EACH ROW EXECUTE FUNCTION public.fn_union_pnl_credit_touch();
INSERT INTO public.union_pnl_projection_build(projection,end_block,completed_at)
SELECT p,b,CASE WHEN b=0 THEN clock_timestamp() END FROM (VALUES
  ('inventory_touches',pg_relation_size('public.union_pnl_inventory_events')/current_setting('block_size')::bigint),
  ('cash_outcome_touches',pg_relation_size('public.union_pnl_cash_outcomes')/current_setting('block_size')::bigint),
  ('credit_touches',pg_relation_size('public.tournament_accounting_credit_receipts')/current_setting('block_size')::bigint)) v(p,b);

DO $post$
DECLARE f text;
BEGIN
  IF md5(pg_get_functiondef('public.fn_union_pnl_boundary(uuid,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '9692532c4253287b2a79fde4690642c9' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_boundary(uuid,timestamp with time zone)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_cash_outcome_touch()'::regprocedure)) IS DISTINCT FROM '4b54f6fd75c38d0e9695cee75b330407' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_cash_outcome_touch()' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_cash_outcome_touch_row(uuid,bigint,timestamp with time zone,jsonb,jsonb)'::regprocedure)) IS DISTINCT FROM 'ac9e2cb0b61b4335c9ceae308a1bfe26' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_cash_outcome_touch_row(uuid,bigint,timestamp with time zone,jsonb,jsonb)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_compact_participants(jsonb)'::regprocedure)) IS DISTINCT FROM '5fc79416982e2cebdb59c970da1c8da4' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_compact_participants(jsonb)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_credit_touch()'::regprocedure)) IS DISTINCT FROM '3d52386d79eb9bc88107fb81f3c7da6e' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_credit_touch()' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM 'e56b7e668d49ae06191cdfeca5933b86' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_first_inventory_operation(text,uuid,boolean)'::regprocedure)) IS DISTINCT FROM 'edb416e15385bedbc271033141502456' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_first_inventory_operation(text,uuid,boolean)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_inventory_touch()'::regprocedure)) IS DISTINCT FROM '656eb1b8a853324b3276bcb1bfb95b23' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_inventory_touch()' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_projection_build_guard()'::regprocedure)) IS DISTINCT FROM 'f34477baca1efd790ed540b1aa833fb1' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_projection_build_guard()' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_projection_build_pending()'::regprocedure)) IS DISTINCT FROM 'a85ba9e7af6d8003cfe8547f3fd250bb' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_projection_build_pending()' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_projection_build_step(text,integer)'::regprocedure)) IS DISTINCT FROM '32f93dd34c864069cb28ae148166fdb7' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_projection_build_step(text,integer)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_projection_ready(text)'::regprocedure)) IS DISTINCT FROM '5f643c03d3595c20354d753087988476' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_projection_ready(text)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_projection_status()'::regprocedure)) IS DISTINCT FROM '4589823f3961d1c682f29ab5361d6e53' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_projection_status()' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_projection_verify(real)'::regprocedure)) IS DISTINCT FROM '38e1f4f0249423b4d87913cb3792fc6a' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_projection_verify(real)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_touched_registrations(timestamp with time zone,timestamp with time zone,boolean)'::regprocedure)) IS DISTINCT FROM 'e45d89f53048f070a3ddc9264d1ecdff' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_touched_registrations(timestamp with time zone,timestamp with time zone,boolean)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_tournament_entry_club_of(text,numeric,uuid,uuid,uuid,jsonb)'::regprocedure)) IS DISTINCT FROM 'b875ae9c879c65cd1db5ae207af9f3c3' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_tournament_entry_club_of(text,numeric,uuid,uuid,uuid,jsonb)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_tournament_in_union(text,uuid,boolean)'::regprocedure)) IS DISTINCT FROM 'e46d1253e8fc17f3fb8616d8a3e13793' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_tournament_in_union(text,uuid,boolean)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_week_hand_lines(uuid,timestamp with time zone,timestamp with time zone,boolean)'::regprocedure)) IS DISTINCT FROM '8826ad945a9af4f9534ebd4c31bad4f7' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_week_hand_lines(uuid,timestamp with time zone,timestamp with time zone,boolean)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_week_shaped_hands(uuid,timestamp with time zone,timestamp with time zone,boolean)'::regprocedure)) IS DISTINCT FROM '393e98309bb57d2cb914d581e5da201a' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_week_shaped_hands(uuid,timestamp with time zone,timestamp with time zone,boolean)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_week_union_credits(uuid,timestamp with time zone,timestamp with time zone,boolean)'::regprocedure)) IS DISTINCT FROM 'b74693f685ad4b69b2738d1f3abfba19' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_week_union_credits(uuid,timestamp with time zone,timestamp with time zone,boolean)' USING ERRCODE='55000'; END IF;
  FOREACH f IN ARRAY ARRAY['public.fn_union_pnl_compact_participants(jsonb)', 'public.fn_union_pnl_cash_outcome_touch_row(uuid,bigint,timestamp with time zone,jsonb,jsonb)', 'public.fn_union_pnl_inventory_touch()', 'public.fn_union_pnl_cash_outcome_touch()', 'public.fn_union_pnl_credit_touch()', 'public.fn_union_pnl_projection_build_guard()', 'public.fn_union_pnl_projection_ready(text)', 'public.fn_union_pnl_projection_build_step(text,integer)', 'public.fn_union_pnl_projection_build_pending()', 'public.fn_union_pnl_projection_status()', 'public.fn_union_pnl_projection_verify(real)', 'public.fn_union_pnl_touched_registrations(timestamp with time zone,timestamp with time zone,boolean)', 'public.fn_union_pnl_tournament_in_union(text,uuid,boolean)', 'public.fn_union_pnl_first_inventory_operation(text,uuid,boolean)', 'public.fn_union_pnl_week_shaped_hands(uuid,timestamp with time zone,timestamp with time zone,boolean)', 'public.fn_union_pnl_week_hand_lines(uuid,timestamp with time zone,timestamp with time zone,boolean)', 'public.fn_union_pnl_week_union_credits(uuid,timestamp with time zone,timestamp with time zone,boolean)', 'public.fn_union_pnl_tournament_entry_club_of(text,numeric,uuid,uuid,uuid,jsonb)', 'public.fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)', 'public.fn_union_pnl_boundary(uuid,timestamp with time zone)'] LOOP
    IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') OR has_function_privilege('service_role',f,'EXECUTE') THEN
      RAISE EXCEPTION 'postimage: % is executable outside the owner',f USING ERRCODE='55000';
    END IF;
  END LOOP;
  IF has_function_privilege('service_role','public.sp_union_pnl_projection_build(integer,integer,integer,integer)','EXECUTE') OR has_function_privilege('authenticated','public.sp_union_pnl_projection_build(integer,integer,integer,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'postimage: the backfill procedure is executable outside the owner' USING ERRCODE='55000';
  END IF;
  FOREACH f IN ARRAY ARRAY['public.union_pnl_inventory_touches', 'public.union_pnl_cash_outcome_touches', 'public.union_pnl_credit_touches', 'public.union_pnl_projection_build'] LOOP
    IF has_table_privilege('anon',f,'SELECT') OR has_table_privilege('authenticated',f,'SELECT')
       OR has_table_privilege('service_role',f,'INSERT') OR has_table_privilege('service_role',f,'UPDATE') THEN
      RAISE EXCEPTION 'postimage: % is writable or browser-readable',f USING ERRCODE='55000';
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname='original_pnl_immutable'
       AND tgrelid IN ('public.union_pnl_inventory_touches'::regclass,'public.union_pnl_cash_outcome_touches'::regclass,'public.union_pnl_credit_touches'::regclass))<>3
     OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND tgname IN ('union_pnl_inventory_touch','union_pnl_cash_outcome_touch','union_pnl_credit_touch'))<>3
     OR (SELECT count(*) FROM public.union_pnl_projection_build)<>3 THEN
    RAISE EXCEPTION 'postimage: a projection, its writer or its backfill state is missing' USING ERRCODE='55000';
  END IF;
  -- No balance column is written here (the money-RPC registry guard's own test).
  IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid IN ('public.fn_union_pnl_compact_participants(jsonb)'::regprocedure, 'public.fn_union_pnl_cash_outcome_touch_row(uuid,bigint,timestamp with time zone,jsonb,jsonb)'::regprocedure, 'public.fn_union_pnl_inventory_touch()'::regprocedure, 'public.fn_union_pnl_cash_outcome_touch()'::regprocedure, 'public.fn_union_pnl_credit_touch()'::regprocedure, 'public.fn_union_pnl_projection_build_guard()'::regprocedure, 'public.fn_union_pnl_projection_ready(text)'::regprocedure, 'public.fn_union_pnl_projection_build_step(text,integer)'::regprocedure, 'public.fn_union_pnl_projection_build_pending()'::regprocedure, 'public.fn_union_pnl_projection_status()'::regprocedure, 'public.fn_union_pnl_projection_verify(real)'::regprocedure, 'public.fn_union_pnl_touched_registrations(timestamp with time zone,timestamp with time zone,boolean)'::regprocedure, 'public.fn_union_pnl_tournament_in_union(text,uuid,boolean)'::regprocedure, 'public.fn_union_pnl_first_inventory_operation(text,uuid,boolean)'::regprocedure, 'public.fn_union_pnl_week_shaped_hands(uuid,timestamp with time zone,timestamp with time zone,boolean)'::regprocedure, 'public.fn_union_pnl_week_hand_lines(uuid,timestamp with time zone,timestamp with time zone,boolean)'::regprocedure, 'public.fn_union_pnl_week_union_credits(uuid,timestamp with time zone,timestamp with time zone,boolean)'::regprocedure, 'public.fn_union_pnl_tournament_entry_club_of(text,numeric,uuid,uuid,uuid,jsonb)'::regprocedure, 'public.fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure, 'public.fn_union_pnl_boundary(uuid,timestamp with time zone)'::regprocedure, 'public.sp_union_pnl_projection_build(integer,integer,integer,integer)'::regprocedure)
      AND public.fn_ca_money_rpc_writes_balances(p.prosrc)) THEN
    RAISE EXCEPTION 'postimage: a function here writes balances' USING ERRCODE='55000';
  END IF;
END $post$;

COMMIT;
