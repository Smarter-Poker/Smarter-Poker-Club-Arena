-- Exact current captured inventory/felt authority for isolated native fixtures only.
BEGIN;
CREATE TABLE public.union_pnl_transaction_frames (
transaction_id xid8 NOT NULL,
observed_at timestamp with time zone NOT NULL,
book_start timestamp with time zone NOT NULL,
CONSTRAINT union_pnl_transaction_frames_observed_at_check CHECK (isfinite(observed_at)),
CONSTRAINT union_pnl_transaction_frames_pkey PRIMARY KEY (transaction_id)
);
ALTER TABLE public.union_pnl_transaction_frames OWNER TO postgres;
ALTER TABLE public.union_pnl_transaction_frames ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.union_pnl_transaction_frames FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE public.tournament_paid_stack_custody_receipts (
id uuid NOT NULL,
transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
tournament_id uuid NOT NULL,
user_id uuid NOT NULL,
candidate_id uuid NOT NULL,
entitlement_id uuid NOT NULL,
source_ledger_id uuid NOT NULL,
source_wallet_id uuid NOT NULL,
destination_table_id uuid NOT NULL,
destination_seat_number integer NOT NULL,
grant_chips numeric NOT NULL,
live_chips_before numeric NOT NULL,
funded_supply numeric NOT NULL,
scoring_excess numeric NOT NULL,
expected jsonb NOT NULL,
state text NOT NULL,
assignment jsonb,
created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
completed_at timestamp with time zone,
CONSTRAINT tournament_paid_stack_custody_rec_destination_seat_number_check CHECK (((destination_seat_number >= 1) AND (destination_seat_number <= 10))),
CONSTRAINT tournament_paid_stack_custody_receipts_candidate_id_key UNIQUE (candidate_id),
CONSTRAINT tournament_paid_stack_custody_receipts_check CHECK ((scoring_excess = ((live_chips_before + grant_chips) - funded_supply))),
CONSTRAINT tournament_paid_stack_custody_receipts_check1 CHECK ((((state = 'reserved'::text) AND (assignment IS NULL) AND (completed_at IS NULL)) OR ((state = 'seated'::text) AND (assignment IS NOT NULL) AND (completed_at IS NOT NULL)))),
CONSTRAINT tournament_paid_stack_custody_receipts_entitlement_id_key UNIQUE (entitlement_id),
CONSTRAINT tournament_paid_stack_custody_receipts_expected_check CHECK ((jsonb_typeof(expected) = 'object'::text)),
CONSTRAINT tournament_paid_stack_custody_receipts_funded_supply_check CHECK (((funded_supply > (0)::numeric) AND (funded_supply < 'Infinity'::numeric))),
CONSTRAINT tournament_paid_stack_custody_receipts_grant_chips_check CHECK (((grant_chips > (0)::numeric) AND (grant_chips = trunc(grant_chips)) AND (grant_chips < ('2147483648'::bigint)::numeric))),
CONSTRAINT tournament_paid_stack_custody_receipts_live_chips_before_check CHECK (((live_chips_before >= (0)::numeric) AND (live_chips_before < 'Infinity'::numeric))),
CONSTRAINT tournament_paid_stack_custody_receipts_pkey PRIMARY KEY (id),
CONSTRAINT tournament_paid_stack_custody_receipts_source_ledger_id_key UNIQUE (source_ledger_id),
CONSTRAINT tournament_paid_stack_custody_receipts_source_wallet_id_key UNIQUE (source_wallet_id),
CONSTRAINT tournament_paid_stack_custody_receipts_state_check CHECK ((state = ANY (ARRAY['reserved'::text, 'seated'::text])))
);
ALTER TABLE public.tournament_paid_stack_custody_receipts OWNER TO postgres;
ALTER TABLE public.tournament_paid_stack_custody_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_paid_stack_custody_receipts FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN RAISE EXCEPTION 'original_pnl_inventory_is_immutable' USING ERRCODE='55000'; END $function$;
ALTER FUNCTION public.fn_union_pnl_inventory_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_immutable() FROM PUBLIC,anon,authenticated,service_role;
DO $v$ BEGIN IF (SELECT md5(pg_get_functiondef(oid))='307d83a1ee3d912bade24c48144aa801' AND proowner='postgres'::regrole AND prosecdef=false AND proacl::text='{postgres=X/postgres}' FROM pg_proc WHERE oid='public.fn_union_pnl_inventory_immutable()'::regprocedure) IS DISTINCT FROM true THEN RAISE EXCEPTION 'CURRENT_FELT_SOURCE_METADATA:public.fn_union_pnl_inventory_immutable()'; END IF; END $v$;
CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_project(p_source text, p_row jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$;
ALTER FUNCTION public.fn_union_pnl_inventory_project(text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_project(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
DO $v$ BEGIN IF (SELECT md5(pg_get_functiondef(oid))='cc819d2476a0252326e7bdd4e72d468f' AND proowner='postgres'::regrole AND prosecdef=false AND proacl::text='{postgres=X/postgres}' FROM pg_proc WHERE oid='public.fn_union_pnl_inventory_project(text,jsonb)'::regprocedure) IS DISTINCT FROM true THEN RAISE EXCEPTION 'CURRENT_FELT_SOURCE_METADATA:public.fn_union_pnl_inventory_project(text,jsonb)'; END IF; END $v$;
CREATE OR REPLACE FUNCTION public.fn_union_pnl_original_frame()
 RETURNS union_pnl_transaction_frames
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE frame public.union_pnl_transaction_frames; observed timestamptz; book timestamptz;
BEGIN
 SELECT * INTO frame FROM public.union_pnl_transaction_frames WHERE transaction_id=pg_current_xact_id();
 IF FOUND THEN RETURN frame; END IF;
 observed:=clock_timestamp(); book:=public.fn_union_week_start(observed);
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('union-pnl-inventory:'||extract(epoch FROM book)::bigint::text,0));
 observed:=clock_timestamp();
 IF public.fn_union_week_start(observed)<>book THEN
  book:=public.fn_union_week_start(observed);
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('union-pnl-inventory:'||extract(epoch FROM book)::bigint::text,0));
  observed:=clock_timestamp();
  IF public.fn_union_week_start(observed)<>book THEN RAISE EXCEPTION 'pnl_frame_clock_crossed_twice' USING ERRCODE='40001'; END IF;
 END IF;
 INSERT INTO public.union_pnl_transaction_frames VALUES(pg_current_xact_id(),observed,book) RETURNING * INTO frame;
 RETURN frame;
END $function$;
ALTER FUNCTION public.fn_union_pnl_original_frame() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_union_pnl_original_frame() FROM PUBLIC,anon,authenticated,service_role;
DO $v$ BEGIN IF (SELECT md5(pg_get_functiondef(oid))='9a6559774cc1ed4ed49b315a3428abdb' AND proowner='postgres'::regrole AND prosecdef=true AND proacl::text='{postgres=X/postgres}' FROM pg_proc WHERE oid='public.fn_union_pnl_original_frame()'::regprocedure) IS DISTINCT FROM true THEN RAISE EXCEPTION 'CURRENT_FELT_SOURCE_METADATA:public.fn_union_pnl_original_frame()'; END IF; END $v$;
CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_observe()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE prior jsonb; following jsonb; frame public.union_pnl_transaction_frames;
BEGIN
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'pnl_inventory_source_truncate_refused' USING ERRCODE='55000'; END IF;
 IF TG_OP<>'INSERT' THEN prior:=public.fn_union_pnl_inventory_project(TG_TABLE_NAME,to_jsonb(OLD)); END IF;
 IF TG_OP<>'DELETE' THEN following:=public.fn_union_pnl_inventory_project(TG_TABLE_NAME,to_jsonb(NEW)); END IF;
 IF prior IS NOT DISTINCT FROM following THEN RETURN NULL; END IF;
 frame:=public.fn_union_pnl_original_frame();
 INSERT INTO public.union_pnl_inventory_events(source_name,row_id,observed_at,transaction_id,operation,before_row,after_row)
 VALUES(TG_TABLE_NAME,(COALESCE(following,prior)->>'id')::uuid,frame.observed_at,frame.transaction_id,TG_OP,prior,following);
 RETURN NULL;
END $function$;
ALTER FUNCTION public.fn_union_pnl_inventory_observe() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_observe() FROM PUBLIC,anon,authenticated,service_role;
DO $v$ BEGIN IF (SELECT md5(pg_get_functiondef(oid))='11c7c788d943a11375a15819e78873ba' AND proowner='postgres'::regrole AND prosecdef=true AND proacl::text='{postgres=X/postgres}' FROM pg_proc WHERE oid='public.fn_union_pnl_inventory_observe()'::regprocedure) IS DISTINCT FROM true THEN RAISE EXCEPTION 'CURRENT_FELT_SOURCE_METADATA:public.fn_union_pnl_inventory_observe()'; END IF; END $v$;
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_felt_may_not_exceed_supply()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_was numeric;
  v_now numeric;
  v_delta numeric;
  v_felt numeric;
  v_supply numeric;
BEGIN
  -- What this row contributes to the felt. A vacated seat contributes nothing,
  -- whatever its stack still says - that stale figure is the whole defect.
  v_now := CASE WHEN NEW.left_at IS NULL THEN COALESCE(NEW.stack,0) ELSE 0 END;
  v_was := CASE WHEN TG_OP = 'INSERT' THEN 0
                WHEN OLD.left_at IS NULL THEN COALESCE(OLD.stack,0)
                ELSE 0 END;
  v_delta := v_now - v_was;

  -- Only growth is judged. A seat exit, a losing bet and a no-op never refuse:
  -- a guard that can refuse a seat exit strands a player mid-hand.
  IF v_delta <= 0 THEN
    RETURN NULL;
  END IF;

  SELECT tb.tournament_id INTO v_tournament_id
    FROM public.tables tb WHERE tb.id = NEW.table_id;
  IF v_tournament_id IS NULL THEN
    RETURN NULL;                      -- a cash seat; supply is not the meter
  END IF;

  -- DEFERRED, so this is the committed end state of the whole transaction:
  -- every seat of a settled hand, or the vacate and the re-seat of a move.
  v_felt   := public.fn_ca_tournament_felt_total(v_tournament_id);
  v_supply := public.fn_ca_tournament_chip_supply(v_tournament_id);

  -- Tolerate history, refuse growth: only the write that CARRIES the felt over
  -- the line is refused. An event already over stays playable.
  IF v_felt > v_supply AND (v_felt - v_delta) <= v_supply
     AND NOT EXISTS (
       SELECT 1 FROM public.union_pnl_inventory_events own
       WHERE own.transaction_id=pg_current_xact_id() AND own.source_name='table_seats'
         AND own.row_id=NEW.id AND own.operation=TG_OP
         AND own.after_row=public.fn_union_pnl_inventory_project('table_seats',to_jsonb(NEW))
         AND own.before_row=CASE WHEN TG_OP='UPDATE'
           THEN public.fn_union_pnl_inventory_project('table_seats',to_jsonb(OLD)) ELSE NULL END
         AND (SELECT count(*)>=2 AND bool_and((
                  e.operation='UPDATE'
                  AND e.before_row->>'table_id'=NEW.table_id::text
                  AND e.after_row->>'table_id'=NEW.table_id::text
                  AND e.before_row->>'user_id'=e.after_row->>'user_id'
                  AND e.before_row->>'occupancy_id'=e.after_row->>'occupancy_id'
                  AND e.before_row->>'joined_at'=e.after_row->>'joined_at') IS TRUE)
                AND sum(CASE WHEN e.after_row->>'left_at' IS NULL
                             THEN COALESCE((e.after_row->>'stack')::numeric,0) ELSE 0 END
                      - CASE WHEN e.before_row->>'left_at' IS NULL
                             THEN COALESCE((e.before_row->>'stack')::numeric,0) ELSE 0 END)=0
              FROM public.union_pnl_inventory_events e
              WHERE e.transaction_id=pg_current_xact_id() AND e.source_name='table_seats'
                AND (e.before_row->>'table_id'=NEW.table_id::text
                  OR e.after_row->>'table_id'=NEW.table_id::text)) IS TRUE
         AND NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_events scope
           WHERE scope.transaction_id=pg_current_xact_id() AND scope.source_name='tables'
             AND scope.row_id=NEW.table_id
             AND scope.before_row->'tournament_id' IS DISTINCT FROM scope.after_row->'tournament_id')
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_paid_stack_custody_receipts r
       JOIN public.table_seats s ON s.id=NEW.id
       WHERE r.transaction_id=pg_current_xact_id() AND r.state='seated'
         AND r.tournament_id=v_tournament_id AND r.user_id=NEW.user_id
         AND r.destination_table_id=NEW.table_id AND r.destination_seat_number=NEW.seat_number
         AND r.assignment->>'seat_id'=NEW.id::text
         AND r.assignment->>'occupancy_id'=NEW.occupancy_id::text
         AND s.user_id=NEW.user_id AND s.table_id=NEW.table_id AND s.seat_number=NEW.seat_number
         AND s.occupancy_id=NEW.occupancy_id AND s.left_at IS NULL AND s.stack=r.grant_chips
         AND v_was=0 AND v_now=r.grant_chips AND v_delta=r.grant_chips
         AND r.live_chips_before+r.grant_chips=v_felt
         AND (r.expected->>'acknowledged_supply')::numeric=v_supply
         AND r.expected->'supply_acknowledgement' IS NOT DISTINCT FROM
           (SELECT to_jsonb(a) FROM public.tournament_felt_supply_acknowledgements a WHERE a.tournament_id=v_tournament_id)
     ) THEN
    RAISE EXCEPTION
      'TOURNAMENT_FELT_WOULD_EXCEED_SUPPLY: seat % (table %, seat %) adds % chips, '
      'leaving % on the felt of tournament % against % ever bought in',
      NEW.id, NEW.table_id, NEW.seat_number, v_delta, v_felt,
      v_tournament_id, v_supply
      USING ERRCODE = '55000',
            HINT = 'A vacated seat''s stack is a stale snapshot, not chips. '
                   'Fund a seat from the felt the player is leaving, or record '
                   'the creation in tournament_felt_supply_acknowledgements.';
  END IF;

  RETURN NULL;
END;
$function$;
ALTER FUNCTION public.fn_ca_tournament_felt_may_not_exceed_supply() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_felt_may_not_exceed_supply() FROM PUBLIC,anon,authenticated,service_role;
DO $v$ BEGIN IF (SELECT md5(pg_get_functiondef(oid))='81fda5e596905c96a07bebfcff7f32b3' AND proowner='postgres'::regrole AND prosecdef=true AND proacl::text='{postgres=X/postgres}' FROM pg_proc WHERE oid='public.fn_ca_tournament_felt_may_not_exceed_supply()'::regprocedure) IS DISTINCT FROM true THEN RAISE EXCEPTION 'CURRENT_FELT_SOURCE_METADATA:public.fn_ca_tournament_felt_may_not_exceed_supply()'; END IF; END $v$;
CREATE OR REPLACE FUNCTION public.fn_ca_original_paid_stack_must_complete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.tournament_paid_stack_custody_receipts r
 WHERE r.id=NEW.id AND r.state='seated' AND r.assignment->>'ok'='true'
 AND r.assignment->>'tournament_id'=r.tournament_id::text
 AND r.assignment->>'user_id'=r.user_id::text
 AND r.assignment->>'table_id'=r.destination_table_id::text
 AND (r.assignment->>'seat_number')::integer=r.destination_seat_number
 AND (r.assignment->>'stack')::numeric=r.grant_chips) THEN
  RAISE EXCEPTION 'ORIGINAL_PAID_CUSTODY_INCOMPLETE' USING ERRCODE='55000';
 END IF;
 RETURN NULL;
END $function$;
ALTER FUNCTION public.fn_ca_original_paid_stack_must_complete() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_original_paid_stack_must_complete() FROM PUBLIC,anon,authenticated,service_role;
DO $v$ BEGIN IF (SELECT md5(pg_get_functiondef(oid))='8e221724e453fe284280f1f72dedaa7d' AND proowner='postgres'::regrole AND prosecdef=true AND proacl::text='{postgres=X/postgres}' FROM pg_proc WHERE oid='public.fn_ca_original_paid_stack_must_complete()'::regprocedure) IS DISTINCT FROM true THEN RAISE EXCEPTION 'CURRENT_FELT_SOURCE_METADATA:public.fn_ca_original_paid_stack_must_complete()'; END IF; END $v$;
CREATE OR REPLACE FUNCTION public.fn_ca_guard_original_paid_stack_receipt()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
 IF TG_OP='DELETE' OR TG_OP='TRUNCATE' THEN
  RAISE EXCEPTION 'ORIGINAL_PAID_CUSTODY_IMMUTABLE' USING ERRCODE='55000';
 ELSIF TG_OP='INSERT' THEN
  IF NEW.state IS DISTINCT FROM 'reserved' OR NEW.transaction_id IS DISTINCT FROM pg_current_xact_id() THEN
   RAISE EXCEPTION 'ORIGINAL_PAID_CUSTODY_RESERVATION_REQUIRED' USING ERRCODE='55000';
  END IF;
 ELSIF OLD.state IS DISTINCT FROM 'reserved' OR NEW.state IS DISTINCT FROM 'seated'
 OR OLD.transaction_id IS DISTINCT FROM pg_current_xact_id()
 OR (to_jsonb(NEW)-ARRAY['state','assignment','completed_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['state','assignment','completed_at']) THEN
  RAISE EXCEPTION 'ORIGINAL_PAID_CUSTODY_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_ca_guard_original_paid_stack_receipt() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_guard_original_paid_stack_receipt() FROM PUBLIC,anon,authenticated,service_role;
DO $v$ BEGIN IF (SELECT md5(pg_get_functiondef(oid))='06bbbafae6950b54fdb00297830a30a4' AND proowner='postgres'::regrole AND prosecdef=true AND proacl::text='{postgres=X/postgres}' FROM pg_proc WHERE oid='public.fn_ca_guard_original_paid_stack_receipt()'::regprocedure) IS DISTINCT FROM true THEN RAISE EXCEPTION 'CURRENT_FELT_SOURCE_METADATA:public.fn_ca_guard_original_paid_stack_receipt()'; END IF; END $v$;
CREATE TRIGGER original_pnl_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.union_pnl_transaction_frames FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_immutable();
DROP TRIGGER IF EXISTS union_pnl_original_inventory ON table_seats;
CREATE TRIGGER union_pnl_original_inventory AFTER INSERT OR DELETE OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_union_pnl_inventory_observe();
DROP TRIGGER IF EXISTS union_pnl_original_inventory_no_truncate ON table_seats;
CREATE TRIGGER union_pnl_original_inventory_no_truncate BEFORE TRUNCATE ON public.table_seats FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_observe();
DROP TRIGGER IF EXISTS union_pnl_original_inventory ON tables;
CREATE TRIGGER union_pnl_original_inventory AFTER INSERT OR DELETE OR UPDATE ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_union_pnl_inventory_observe();
DROP TRIGGER IF EXISTS union_pnl_original_inventory_no_truncate ON tables;
CREATE TRIGGER union_pnl_original_inventory_no_truncate BEFORE TRUNCATE ON public.tables FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_observe();
DROP TRIGGER IF EXISTS original_paid_custody_completed ON public.tournament_paid_stack_custody_receipts;
CREATE CONSTRAINT TRIGGER original_paid_custody_completed AFTER INSERT OR UPDATE ON public.tournament_paid_stack_custody_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_ca_original_paid_stack_must_complete();
DROP TRIGGER IF EXISTS original_paid_custody_immutable ON public.tournament_paid_stack_custody_receipts;
CREATE TRIGGER original_paid_custody_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.tournament_paid_stack_custody_receipts FOR EACH ROW EXECUTE FUNCTION fn_ca_guard_original_paid_stack_receipt();
DROP TRIGGER IF EXISTS original_paid_custody_no_truncate ON public.tournament_paid_stack_custody_receipts;
CREATE TRIGGER original_paid_custody_no_truncate BEFORE TRUNCATE ON public.tournament_paid_stack_custody_receipts FOR EACH STATEMENT EXECUTE FUNCTION fn_ca_guard_original_paid_stack_receipt();
COMMIT;
