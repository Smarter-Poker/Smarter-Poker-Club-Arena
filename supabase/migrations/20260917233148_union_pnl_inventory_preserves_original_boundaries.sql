-- The old P&L reader used current seats and current tournament state as historical
-- boundary equity. Preserve the observed active population at installation and
-- every subsequent original financial/scope transition. This does not invent a
-- pre-installation balance, classify tournament instruments, or activate payment.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

-- Tournament creation/settlement owns tournaments before tables; cash settlement
-- owns tables before seats and later upgrades its table row lock. Drain in that
-- original order. EXCLUSIVE includes FOR SHARE/FOR UPDATE readers, unlike SHARE
-- ROW EXCLUSIVE, while permitting plain reads. Measured hand owners can take
-- eight seconds, so admission is bounded at ten seconds for each owner table.
SET LOCAL lock_timeout='10s';
LOCK TABLE public.tournaments IN EXCLUSIVE MODE;
LOCK TABLE public.tables IN EXCLUSIVE MODE;
SET LOCAL lock_timeout='3s';
-- Any different source ordering refuses this apply immediately, never a live hand.
LOCK TABLE public.table_seats,public.tournament_players,public.union_clubs IN SHARE ROW EXCLUSIVE MODE NOWAIT;

CREATE TABLE public.union_pnl_inventory_capture (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 captured_at timestamptz NOT NULL CHECK(isfinite(captured_at)),
 contract_version integer NOT NULL CHECK(contract_version=1),
 source_counts jsonb NOT NULL CHECK(jsonb_typeof(source_counts)='object')
);
CREATE TABLE public.union_pnl_inventory_events (
 event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 source_name text NOT NULL CHECK(source_name IN ('union_clubs','tables','table_seats','tournaments','tournament_players')),
 row_id uuid NOT NULL,
 observed_at timestamptz NOT NULL CHECK(isfinite(observed_at)),
 transaction_id xid8 NOT NULL,
 operation text NOT NULL CHECK(operation IN ('baseline','INSERT','UPDATE','DELETE')),
 before_row jsonb,
 after_row jsonb,
 CHECK(before_row IS NOT NULL OR after_row IS NOT NULL),
 CHECK((before_row IS NULL OR (jsonb_typeof(before_row)='object' AND before_row->>'id'=row_id::text)) IS TRUE),
 CHECK((after_row IS NULL OR (jsonb_typeof(after_row)='object' AND after_row->>'id'=row_id::text)) IS TRUE),
 CHECK((operation IN ('baseline','INSERT') AND before_row IS NULL AND after_row IS NOT NULL)
  OR (operation='UPDATE' AND before_row IS NOT NULL AND after_row IS NOT NULL)
  OR (operation='DELETE' AND before_row IS NOT NULL AND after_row IS NULL))
);
CREATE INDEX union_pnl_inventory_identity ON public.union_pnl_inventory_events(source_name,row_id,event_id DESC);
CREATE INDEX union_pnl_inventory_boundary ON public.union_pnl_inventory_events(observed_at,event_id);
ALTER TABLE public.union_pnl_inventory_capture ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.union_pnl_inventory_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.union_pnl_inventory_capture,public.union_pnl_inventory_events FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON SEQUENCE public.union_pnl_inventory_events_event_id_seq FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_union_pnl_inventory_project(p_source text,p_row jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE keys text[]; result jsonb;
BEGIN
 IF p_row IS NULL THEN RETURN NULL; END IF;
 keys:=CASE p_source
  WHEN 'union_clubs' THEN ARRAY['id','union_id','club_id','joined_at']
  WHEN 'tables' THEN ARRAY['id','club_id','union_id','tournament_id','is_private']
  WHEN 'table_seats' THEN ARRAY['id','table_id','user_id','club_id','occupancy_id','joined_at','left_at','stack']
  WHEN 'tournaments' THEN ARRAY['id','club_id','union_id','is_private','status','started_at','ended_at','prize_pool','bounty_pool','bounty_pool_paid']
  WHEN 'tournament_players' THEN ARRAY['id','tournament_id','user_id','club_id','status','registered_at','eliminated_at','prize','bounty_winnings','source_satellite_id']
  ELSE NULL END;
 IF keys IS NULL OR NOT p_row ?& keys THEN RAISE EXCEPTION 'pnl_inventory_source_contract_changed:%',p_source USING ERRCODE='55000'; END IF;
 SELECT jsonb_object_agg(k,p_row->k) INTO result FROM unnest(keys) k;
 RETURN result;
END $$;

CREATE FUNCTION public.fn_union_pnl_inventory_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'original_pnl_inventory_is_immutable' USING ERRCODE='55000'; END $$;
CREATE TRIGGER original_pnl_inventory_capture_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.union_pnl_inventory_capture
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_union_pnl_inventory_immutable();
CREATE TRIGGER original_pnl_inventory_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.union_pnl_inventory_events
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_union_pnl_inventory_immutable();

CREATE FUNCTION public.fn_union_pnl_inventory_observe()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE prior jsonb; following jsonb; observed timestamptz; book timestamptz;
BEGIN
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'pnl_inventory_source_truncate_refused' USING ERRCODE='55000'; END IF;
 IF TG_OP<>'INSERT' THEN prior:=public.fn_union_pnl_inventory_project(TG_TABLE_NAME,to_jsonb(OLD)); END IF;
 IF TG_OP<>'DELETE' THEN following:=public.fn_union_pnl_inventory_project(TG_TABLE_NAME,to_jsonb(NEW)); END IF;
 IF prior IS NOT DISTINCT FROM following THEN RETURN NULL; END IF;
 -- The capture timestamp belongs to this original write, never a caller's
 -- historical date. Locks cover only that book; closed-book readers cannot
 -- miss a still-running transaction, and do not freeze current-week gameplay.
 observed:=clock_timestamp();book:=public.fn_union_week_start(observed);
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('union-pnl-inventory:'||extract(epoch FROM book)::bigint::text,0));
 observed:=clock_timestamp();
 IF public.fn_union_week_start(observed)<>book THEN
  book:=public.fn_union_week_start(observed);
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('union-pnl-inventory:'||extract(epoch FROM book)::bigint::text,0));
  observed:=clock_timestamp();
  IF public.fn_union_week_start(observed)<>book THEN RAISE EXCEPTION 'pnl_inventory_clock_crossed_twice' USING ERRCODE='40001'; END IF;
 END IF;
 INSERT INTO public.union_pnl_inventory_events(source_name,row_id,observed_at,transaction_id,operation,before_row,after_row)
 VALUES(TG_TABLE_NAME,(COALESCE(following,prior)->>'id')::uuid,observed,pg_current_xact_id(),TG_OP,prior,following);
 RETURN NULL;
END $$;

INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note) VALUES
 ('table_seats','union_pnl_original_inventory','Original compact population/balance evidence in the owning transaction; no monetary mutation.'),
 ('tournaments','union_pnl_original_inventory','Original scope and open-liability inventory; no instrument valuation or monetary mutation.'),
 ('tournament_players','union_pnl_original_inventory','Original registration population includes every player; no monetary mutation.'),
 ('table_seats','union_pnl_original_inventory_no_truncate','Refuses deletion of complete original population through TRUNCATE.'),
 ('tournaments','union_pnl_original_inventory_no_truncate','Refuses deletion of original scope/obligation population through TRUNCATE.'),
 ('tournament_players','union_pnl_original_inventory_no_truncate','Refuses deletion of original registration population through TRUNCATE.');

-- Exactly the owner tables, no broad money-table rewrite and no scheduler.
-- CREATE TRIGGER holds its normal table lock through the bounded seed, so there
-- is no gap between the initial observed inventory and original write capture.
CREATE TRIGGER union_pnl_original_inventory AFTER INSERT OR UPDATE OR DELETE ON public.union_clubs FOR EACH ROW EXECUTE FUNCTION public.fn_union_pnl_inventory_observe();
CREATE TRIGGER union_pnl_original_inventory AFTER INSERT OR UPDATE OR DELETE ON public.tables FOR EACH ROW EXECUTE FUNCTION public.fn_union_pnl_inventory_observe();
CREATE TRIGGER union_pnl_original_inventory AFTER INSERT OR UPDATE OR DELETE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION public.fn_union_pnl_inventory_observe();
CREATE TRIGGER union_pnl_original_inventory AFTER INSERT OR UPDATE OR DELETE ON public.tournaments FOR EACH ROW EXECUTE FUNCTION public.fn_union_pnl_inventory_observe();
CREATE TRIGGER union_pnl_original_inventory AFTER INSERT OR UPDATE OR DELETE ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION public.fn_union_pnl_inventory_observe();
CREATE TRIGGER union_pnl_original_inventory_no_truncate BEFORE TRUNCATE ON public.union_clubs FOR EACH STATEMENT EXECUTE FUNCTION public.fn_union_pnl_inventory_observe();
CREATE TRIGGER union_pnl_original_inventory_no_truncate BEFORE TRUNCATE ON public.tables FOR EACH STATEMENT EXECUTE FUNCTION public.fn_union_pnl_inventory_observe();
CREATE TRIGGER union_pnl_original_inventory_no_truncate BEFORE TRUNCATE ON public.table_seats FOR EACH STATEMENT EXECUTE FUNCTION public.fn_union_pnl_inventory_observe();
CREATE TRIGGER union_pnl_original_inventory_no_truncate BEFORE TRUNCATE ON public.tournaments FOR EACH STATEMENT EXECUTE FUNCTION public.fn_union_pnl_inventory_observe();
CREATE TRIGGER union_pnl_original_inventory_no_truncate BEFORE TRUNCATE ON public.tournament_players FOR EACH STATEMENT EXECUTE FUNCTION public.fn_union_pnl_inventory_observe();

DO $capture$
DECLARE at_time timestamptz:=clock_timestamp(); counts jsonb;
BEGIN
 INSERT INTO public.union_pnl_inventory_events(source_name,row_id,observed_at,transaction_id,operation,after_row)
 SELECT 'union_clubs',id,at_time,pg_current_xact_id(),'baseline',public.fn_union_pnl_inventory_project('union_clubs',to_jsonb(x)) FROM public.union_clubs x
 UNION ALL SELECT 'tables',id,at_time,pg_current_xact_id(),'baseline',public.fn_union_pnl_inventory_project('tables',to_jsonb(x)) FROM public.tables x WHERE tournament_id IS NULL
 UNION ALL SELECT 'table_seats',id,at_time,pg_current_xact_id(),'baseline',public.fn_union_pnl_inventory_project('table_seats',to_jsonb(x)) FROM public.table_seats x WHERE left_at IS NULL
 UNION ALL SELECT 'tournaments',id,at_time,pg_current_xact_id(),'baseline',public.fn_union_pnl_inventory_project('tournaments',to_jsonb(x)) FROM public.tournaments x WHERE status NOT IN ('COMPLETED','CANCELLED')
 UNION ALL SELECT 'tournament_players',x.id,at_time,pg_current_xact_id(),'baseline',public.fn_union_pnl_inventory_project('tournament_players',to_jsonb(x))
 FROM public.tournament_players x JOIN public.tournaments t ON t.id=x.tournament_id WHERE t.status NOT IN ('COMPLETED','CANCELLED');
 SELECT jsonb_object_agg(source_name,n) INTO counts FROM (SELECT source_name,count(*) n FROM public.union_pnl_inventory_events GROUP BY source_name) q;
 INSERT INTO public.union_pnl_inventory_capture(singleton,captured_at,contract_version,source_counts) VALUES(true,at_time,1,'{"union_clubs":0,"tables":0,"table_seats":0,"tournaments":0,"tournament_players":0}'::jsonb||COALESCE(counts,'{}'));
END $capture$;

CREATE FUNCTION public.fn_union_pnl_inventory_as_of(p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE origin public.union_pnl_inventory_capture%ROWTYPE; book timestamptz; population jsonb; gaps jsonb;
BEGIN
 SELECT * INTO origin FROM public.union_pnl_inventory_capture WHERE singleton;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','reason','inventory_capture_missing'); END IF;
 IF p_at IS NULL OR NOT isfinite(p_at) OR p_at<>public.fn_union_week_start(p_at) OR p_at>clock_timestamp() THEN
  RETURN jsonb_build_object('status','blocked','reason','closed_original_week_boundary_required'); END IF;
 IF p_at<=origin.captured_at THEN RETURN jsonb_build_object('status','blocked','reason','boundary_precedes_original_inventory_capture','capture_started_at',origin.captured_at); END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RETURN jsonb_build_object('status','blocked','reason','inventory_requires_fresh_read_committed_snapshot'); END IF;
 book:=public.fn_union_week_start(origin.captured_at);
 WHILE book<p_at LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('union-pnl-inventory:'||extract(epoch FROM book)::bigint::text,0));
  book:=public.fn_union_week_start(book+interval '8 days');
 END LOOP;
 -- VOLATILE intentionally obtains a fresh snapshot after the old-book writers
 -- have committed. A stable/snapshot reader could omit those committed events.
 WITH history AS MATERIALIZED (
  SELECT e.*,row_number() OVER(PARTITION BY source_name,row_id ORDER BY event_id DESC) latest,
   first_value(operation) OVER(PARTITION BY source_name,row_id ORDER BY event_id) first_operation,
   row_number() OVER(PARTITION BY source_name,row_id ORDER BY event_id) ordinal,
   lag(after_row) OVER(PARTITION BY source_name,row_id ORDER BY event_id) prior_after
  FROM public.union_pnl_inventory_events e WHERE observed_at<p_at
 ), current_rows AS MATERIALIZED (
  SELECT source_name,row_id,event_id,after_row,first_operation FROM history WHERE latest=1 AND after_row IS NOT NULL
 ), active AS MATERIALIZED (
  SELECT * FROM current_rows r WHERE source_name='union_clubs'
   OR (source_name='tables' AND after_row->'tournament_id'='null'::jsonb)
   OR (source_name='table_seats' AND after_row->'left_at'='null'::jsonb)
   OR (source_name='tournaments' AND after_row->>'status' NOT IN ('COMPLETED','CANCELLED'))
   OR (source_name='tournament_players' AND EXISTS(SELECT 1 FROM current_rows t WHERE t.source_name='tournaments'
    AND t.row_id::text=r.after_row->>'tournament_id' AND t.after_row->>'status' NOT IN ('COMPLETED','CANCELLED')))
 ), grouped AS (
  SELECT source_name,jsonb_agg(jsonb_build_object('source_event_id',event_id,'row',after_row) ORDER BY row_id) rows FROM active GROUP BY source_name
 ) SELECT COALESCE((SELECT jsonb_object_agg(source_name,rows) FROM grouped),'{}'),
  COALESCE((SELECT jsonb_agg(jsonb_build_object('source_name',source_name,'row_id',row_id,'reason','active_row_original_population_missing') ORDER BY source_name,row_id)
   FROM active WHERE first_operation NOT IN ('baseline','INSERT')),'[]')
  ||COALESCE((SELECT jsonb_agg(jsonb_build_object('source_name',source_name,'row_id',row_id,'source_event_id',event_id,'reason','original_inventory_chain_disagrees') ORDER BY source_name,row_id,event_id)
   FROM history WHERE ordinal>1 AND prior_after IS DISTINCT FROM before_row),'[]') INTO population,gaps;
 RETURN jsonb_build_object('status',CASE WHEN gaps='[]'::jsonb THEN 'observed' ELSE 'blocked' END,
  'inventory_version',1,'capture_started_at',origin.captured_at,'boundary',p_at,'population',population,'issues',gaps,
  'current_state_used',false,'financial_basis_certified',false,
  'coverage','Original active population and later captured transitions; monetary funding and obligation receipts must independently certify equity.');
END $$;
REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_project(text,jsonb),public.fn_union_pnl_inventory_immutable(),
 public.fn_union_pnl_inventory_observe(),public.fn_union_pnl_inventory_as_of(timestamptz) FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON FUNCTION public.fn_union_pnl_inventory_as_of(timestamptz) IS 'Private original as-of population. No backdated balances, monetary valuation, current-membership inference or payment authorization.';
COMMIT;
