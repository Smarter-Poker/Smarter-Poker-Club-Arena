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
