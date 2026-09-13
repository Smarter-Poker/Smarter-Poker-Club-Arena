-- Prepared exact current terminal activation. NOT APPLIED.
-- Run only after the full engine and bootstrap compatibility gates pass.
-- One atomic transaction: current satellite adapter, target authority, strict cutover.
BEGIN;

-- Preserve the strict cutover's global-catalog-before-public-DDL lock order.
/* A busy relation aborts the whole cutover instead of making a live table
   wait behind DDL. Re-run only in the audited quiet window after inspecting
   the unchanged catalog; never hide a timeout behind an automatic retry. */
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

/* Supabase Realtime takes relation-catalog locks while rebuilding its
   subscription state. Acquire that global catalog boundary before this
   migration inspects or changes any public object, so the cutover cannot form
   the inverse public-relation -> realtime.subscription lock order. NOWAIT
   aborts an occupied window whole instead of pausing live tables behind DDL. */
LOCK TABLE realtime.subscription IN ACCESS EXCLUSIVE MODE NOWAIT;

-- Acquire the unchanged canonical public lock boundary before component DDL.
-- Managers that arrive after this boundary cannot hold a lease across cutover.
LOCK TABLE public.tables IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournament_table_origins IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournament_capacity_table_receipts
  IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournament_manager_wakes IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.engine_tournament_leases IN EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournaments IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournament_obligations IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournament_payouts IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournament_final_table_deal_batches
  IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournament_final_table_deal_receipts
  IN SHARE ROW EXCLUSIVE MODE NOWAIT;

-- BEGIN ACTIVATION COMPONENT scripts/deploy/phase-three-current-satellite-terminal.sql SHA256 a6444cab844a6e2da87600ee4443c3349e0f2d6c988b5a3198a356bc5a333d2f
-- Current M2 satellite receipts participate in the complete Stage B guards.
-- Preserve the live-proved public R3 wrapper486d, money gate and durable replay door.
-- Financial proof is the exact current M2 verifier. An owner-only, transaction-
-- bound capability permits only the known parent-before-table close ordering;
-- the original full receipt must still pass before the transaction can commit.

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $preflight$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_settle_satellite_tournament(uuid,uuid)')
   AND md5(prosrc)='486d0e6729de8d518d7faf0c253b65d3' AND proowner='postgres'::regrole AND prosecdef) THEN
  RAISE EXCEPTION 'live-proved public satellite R3 wrapper differs'; END IF;
 IF to_regprocedure('public.fn_ca_satellite_terminal_scope(uuid)') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_satellite_terminal_scope(uuid)') AND md5(prosrc)='0bd1220dbfb2e23b27e9e102959829e2' AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=public, pg_temp']::text[] AND proacl=ARRAY['postgres=X/postgres']::aclitem[]) THEN RAISE EXCEPTION 'existing satellite helper differs: fn_ca_satellite_terminal_scope'; END IF;
 IF to_regprocedure('public.fn_ca_open_satellite_terminal_scope(uuid)') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_open_satellite_terminal_scope(uuid)') AND md5(prosrc)='519bfbe4b59c3d833ae7d59570b89203' AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=public, pg_temp']::text[] AND proacl=ARRAY['postgres=X/postgres']::aclitem[]) THEN RAISE EXCEPTION 'existing satellite helper differs: fn_ca_open_satellite_terminal_scope'; END IF;
 IF to_regprocedure('public.fn_ca_close_satellite_terminal_scope(uuid,jsonb)') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_close_satellite_terminal_scope(uuid,jsonb)') AND md5(prosrc)='1470b469991c59834c66bfb3d4a2f432' AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=public, pg_temp']::text[] AND proacl=ARRAY['postgres=X/postgres']::aclitem[]) THEN RAISE EXCEPTION 'existing satellite helper differs: fn_ca_close_satellite_terminal_scope'; END IF;
 IF to_regprocedure('public.fn_ca_satellite_pending_transition(public.tournaments,public.tournaments)') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_satellite_pending_transition(public.tournaments,public.tournaments)') AND md5(prosrc)='34412a6273353af272200836335737a1' AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=public, pg_temp']::text[] AND proacl=ARRAY['postgres=X/postgres']::aclitem[]) THEN RAISE EXCEPTION 'existing satellite helper differs: fn_ca_satellite_pending_transition'; END IF;
 IF to_regprocedure('public.fn_ca_satellite_terminal_commit_proof()') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_satellite_terminal_commit_proof()') AND md5(prosrc)='61b521747a6794f4e473a25a6313c6d2' AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=public, pg_temp']::text[] AND proacl=ARRAY['postgres=X/postgres']::aclitem[]) THEN RAISE EXCEPTION 'existing satellite helper differs: fn_ca_satellite_terminal_commit_proof'; END IF;
 IF to_regprocedure('public.fn_ca_satellite_terminal_scope_consumed()') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_satellite_terminal_scope_consumed()') AND md5(prosrc)='fce60b982977156c653d56fe212de6ae' AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=public, pg_temp']::text[] AND proacl=ARRAY['postgres=X/postgres']::aclitem[]) THEN RAISE EXCEPTION 'existing satellite helper differs: fn_ca_satellite_terminal_scope_consumed'; END IF;
 IF to_regprocedure('public.fn_ca_verify_current_satellite_terminal(uuid,uuid,boolean)') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_verify_current_satellite_terminal(uuid,uuid,boolean)') AND md5(prosrc)='0977ca13c91ea1aef766cf6d81f0c816' AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=public','statement_timeout=30s']::text[] AND proacl=ARRAY['postgres=X/postgres']::aclitem[]) THEN RAISE EXCEPTION 'existing satellite helper differs: fn_ca_verify_current_satellite_terminal'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_satellite_settlement_receipt(uuid,uuid)'::regprocedure
     AND md5(prosrc)='381b3e0691a2b9303693653f5110d568' AND proowner='postgres'::regrole AND prosecdef)
  OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_guard_tournament_completing_claim()'::regprocedure
     AND md5(prosrc)='82078938fd926c94a0ab778acd77dd61')
  OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_guard_tournament_completed_certificate()'::regprocedure
     AND md5(prosrc)='d994347e1b76c936ce13361d73f94fd2') THEN
  RAISE EXCEPTION 'current satellite receipt or shared certificate preimage differs'; END IF;
END $preflight$;

CREATE TABLE IF NOT EXISTS public.tournament_satellite_terminal_authorizations(
 tournament_id uuid PRIMARY KEY REFERENCES public.tournaments(id) ON DELETE RESTRICT,
 backend_pid integer NOT NULL,transaction_id bigint NOT NULL,token uuid NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 authorized_seats jsonb NOT NULL CHECK(jsonb_typeof(authorized_seats)='array')
);
DO $capability_table_shape$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.tournament_satellite_terminal_authorizations'::regclass
    AND relowner='postgres'::regrole AND relkind='r')
  OR (SELECT jsonb_agg(jsonb_build_array(attname,atttypid::regtype::text,attnotnull) ORDER BY attnum)
    FROM pg_attribute WHERE attrelid='public.tournament_satellite_terminal_authorizations'::regclass
      AND attnum>0 AND NOT attisdropped) IS DISTINCT FROM
   '[ ["tournament_id","uuid",true], ["backend_pid","integer",true], ["transaction_id","bigint",true], ["token","uuid",true], ["created_at","timestamp with time zone",true], ["authorized_seats","jsonb",true] ]'::jsonb
  OR (SELECT count(*) FROM pg_constraint WHERE conrelid='public.tournament_satellite_terminal_authorizations'::regclass AND contype IN ('p','u','f','c'))<>4
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tournament_satellite_terminal_authorizations'::regclass
    AND contype='p' AND conkey=ARRAY[1]::smallint[] AND convalidated)
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tournament_satellite_terminal_authorizations'::regclass
    AND contype='u' AND conkey=ARRAY[4]::smallint[] AND convalidated)
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tournament_satellite_terminal_authorizations'::regclass
    AND contype='f' AND conkey=ARRAY[1]::smallint[] AND confrelid='public.tournaments'::regclass
    AND confdeltype='r' AND convalidated)
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tournament_satellite_terminal_authorizations'::regclass
    AND contype='c' AND convalidated
    AND pg_get_expr(conbin,conrelid)=$cap_check$(jsonb_typeof(authorized_seats) = 'array'::text)$cap_check$)
  OR EXISTS(SELECT 1 FROM public.tournament_satellite_terminal_authorizations)
 THEN RAISE EXCEPTION 'existing satellite capability table shape or empty-state differs'; END IF;
END $capability_table_shape$;
ALTER TABLE public.tournament_satellite_terminal_authorizations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_satellite_terminal_authorizations FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_satellite_terminal_scope(p_tournament_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $scope$
 SELECT EXISTS(SELECT 1 FROM public.tournament_satellite_terminal_authorizations a
  WHERE a.tournament_id=p_tournament_id AND a.backend_pid=pg_backend_pid()
   AND a.transaction_id=txid_current() AND a.created_at=transaction_timestamp()
   AND a.token=NULLIF(current_setting('app.tournament_seat_exit_token',true),'')::uuid
   AND current_setting('app.tournament_seat_exit_operation',true)='satellite_finish')
 AND (SELECT count(*)=2 FROM unnest(ARRAY[
  hashtextextended('ca:tournament-terminal-settlement:v1',0),
  hashtextextended('ca:hand-settlement-barrier:v1',0)]) k(lock_key)
  WHERE EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=pg_backend_pid()
   AND l.locktype='advisory' AND l.mode='ExclusiveLock' AND l.granted
   AND l.objsubid=1 AND l.classid=((k.lock_key>>32)&4294967295)::oid
   AND l.objid=(k.lock_key&4294967295)::oid));
$scope$;

CREATE OR REPLACE FUNCTION public.fn_ca_open_satellite_terminal_scope(p_tournament_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $open_scope$
DECLARE v_before_token text:=current_setting('app.tournament_seat_exit_token',true);
 v_before_operation text:=current_setting('app.tournament_seat_exit_operation',true);
 v_token uuid; v_owned boolean:=false; v_live integer; v_exact integer;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN
  RAISE EXCEPTION 'satellite terminal scope requires engine authority' USING ERRCODE='28000'; END IF;
 -- The source-gated core already owns G and B before any row or chair lock.
 -- Re-enter the same lane here; no alternate lock order or money door is added.
 PERFORM public.fn_ca_lock_settlement_lane_global();
 SELECT count(*) INTO v_live FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
  WHERE t.tournament_id=p_tournament_id AND s.left_at IS NULL;
 IF NULLIF(v_before_token,'') IS NOT NULL AND v_before_operation='satellite_finish' THEN
  SELECT count(*) INTO v_exact FROM public.tournament_seat_exit_authorizations a
   JOIN public.table_seats s ON s.id=a.seat_id JOIN public.tables t ON t.id=s.table_id
   WHERE a.token=v_before_token::uuid AND a.tournament_id=p_tournament_id
    AND a.operation='satellite_finish' AND a.created_at=transaction_timestamp()
    AND t.tournament_id=p_tournament_id AND s.user_id=a.user_id AND s.left_at IS NULL;
  IF v_live>0 AND v_exact=v_live AND (SELECT count(*) FROM public.tournament_seat_exit_authorizations
      WHERE token=v_before_token::uuid)=v_live THEN v_token:=v_before_token::uuid; END IF;
 END IF;
 IF v_token IS NULL THEN
  v_token:=public.fn_ca_open_tournament_seat_exit_authority(p_tournament_id,'satellite_finish',NULL);
  v_owned:=true;
 END IF;
 -- The canonical seat guard consumes rows as each seat exits. Preserve
 -- the exact issued set here before the first exit, then prove that every
 -- issued capability was consumed and its durable seat closure still matches.
 INSERT INTO public.tournament_satellite_terminal_authorizations(
  tournament_id,backend_pid,transaction_id,token,authorized_seats)
 SELECT p_tournament_id,pg_backend_pid(),txid_current(),v_token,
  COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.seat_id),'[]'::jsonb)
 FROM public.tournament_seat_exit_authorizations a WHERE a.token=v_token;
 IF NOT public.fn_ca_satellite_terminal_scope(p_tournament_id) THEN
  RAISE EXCEPTION 'satellite terminal scope lacks exact transaction locks and capability' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('token',v_token,'owns_seat_token',v_owned,
  'previous_token',v_before_token,'previous_operation',v_before_operation);
END $open_scope$;

CREATE OR REPLACE FUNCTION public.fn_ca_close_satellite_terminal_scope(p_tournament_id uuid,p_scope jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $close_scope$
DECLARE n integer;
BEGIN
 IF NOT public.fn_ca_satellite_terminal_scope(p_tournament_id)
  OR (p_scope->>'token')::uuid IS DISTINCT FROM NULLIF(current_setting('app.tournament_seat_exit_token',true),'')::uuid
 THEN RAISE EXCEPTION 'satellite terminal scope changed before final receipt' USING ERRCODE='42501'; END IF;
 DELETE FROM public.tournament_satellite_terminal_authorizations
 WHERE tournament_id=p_tournament_id AND backend_pid=pg_backend_pid()
  AND transaction_id=txid_current() AND token=(p_scope->>'token')::uuid;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'satellite terminal scope did not close exactly once' USING ERRCODE='40001'; END IF;
 IF (p_scope->>'owns_seat_token')::boolean THEN
  PERFORM public.fn_ca_close_tournament_seat_exit_authority((p_scope->>'token')::uuid,true);
  PERFORM set_config('app.tournament_seat_exit_token',COALESCE(p_scope->>'previous_token',''),true);
  PERFORM set_config('app.tournament_seat_exit_operation',COALESCE(p_scope->>'previous_operation',''),true);
 END IF;
END $close_scope$;

CREATE OR REPLACE FUNCTION public.fn_ca_satellite_pending_transition(p_old public.tournaments,p_new public.tournaments)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $pending_transition$
DECLARE h public.tournament_satellite_settlements%ROWTYPE;
BEGIN
 SELECT * INTO STRICT h FROM public.tournament_satellite_settlements WHERE tournament_id=p_new.id;
 IF NOT public.fn_ca_satellite_terminal_scope(p_new.id)
  OR p_old.id IS DISTINCT FROM p_new.id OR p_old.status IS DISTINCT FROM 'COMPLETING'
  OR p_new.status IS DISTINCT FROM 'COMPLETED' OR p_new.ended_at IS DISTINCT FROM h.source_closed_at
  OR p_new.current_players IS DISTINCT FROM 0 OR p_new.on_break IS DISTINCT FROM false
  OR p_new.break_started_at IS NOT NULL OR p_new.break_ends_at IS NOT NULL
  OR p_new.prize_pool_finalized IS DISTINCT FROM true
  OR (to_jsonb(p_new)-ARRAY['status','ended_at','current_players','on_break','break_started_at','break_ends_at','updated_at'])
     IS DISTINCT FROM
     (to_jsonb(p_old)-ARRAY['status','ended_at','current_players','on_break','break_started_at','break_ends_at','updated_at'])
 THEN RAISE EXCEPTION 'satellite completion is not its exact owned pending transition' USING ERRCODE='42501'; END IF;
END $pending_transition$;

CREATE OR REPLACE FUNCTION public.fn_ca_satellite_terminal_commit_proof()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $commit_proof$
DECLARE h public.tournament_satellite_settlements%ROWTYPE;
BEGIN
 SELECT * INTO h FROM public.tournament_satellite_settlements WHERE tournament_id=NEW.id;
 IF FOUND THEN
  PERFORM public.fn_ca_satellite_settlement_receipt(NEW.id,h.winner_id);
  IF NOT EXISTS(SELECT 1 FROM public.tournament_finish_receipts f WHERE f.tournament_id=NEW.id
   AND f.winner_user_id=h.winner_id AND f.finish_kind='satellite'
   AND f.certified_at IS NOT NULL AND f.completed_at IS NOT NULL)
   OR EXISTS(SELECT 1 FROM public.tournament_satellite_terminal_authorizations WHERE tournament_id=NEW.id)
  THEN RAISE EXCEPTION 'satellite terminal commit lacks a complete claim or retained a capability' USING ERRCODE='P0404'; END IF;
 END IF;
 RETURN NULL;
END $commit_proof$;

CREATE OR REPLACE FUNCTION public.fn_ca_satellite_terminal_scope_consumed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $scope_consumed$
BEGIN
 IF EXISTS(SELECT 1 FROM public.tournament_satellite_terminal_authorizations WHERE tournament_id=NEW.tournament_id)
 THEN RAISE EXCEPTION 'satellite terminal capability cannot survive its transaction' USING ERRCODE='P0404'; END IF;
 RETURN NULL;
END $scope_consumed$;

CREATE OR REPLACE FUNCTION public.fn_ca_verify_current_satellite_terminal(p_tournament_id uuid,p_observed_winner_id uuid,p_inflight boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' SET statement_timeout TO '30s'
AS $current_satellite_proof$
DECLARE
  v_h public.tournament_satellite_settlements%ROWTYPE;
  v_source record;
  v_target record;
  v_source_escrow public.tournament_escrow%ROWTYPE;
  v_rake_settlement record;
  v_field_size integer;
  v_position_count integer;
  v_rows integer;
  v_expected_rows integer;
  v_amount numeric;
  v_rake numeric;
  v_awards jsonb := '[]'::jsonb;
  v_seats jsonb := '[]'::jsonb;
  v_remainder jsonb := NULL;
  v_winner_amount numeric := 0;
  v_source_table_ids uuid[];
  v_source_seat_ids uuid[];
  v_durable_released_ids uuid[];
  v_durable_released_count integer;
BEGIN
  IF p_inflight AND NOT public.fn_ca_satellite_terminal_scope(p_tournament_id) THEN
    RAISE EXCEPTION 'satellite in-flight proof has no owned transaction capability' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.tournament_finish_receipts f
    WHERE f.tournament_id=p_tournament_id AND f.winner_user_id=p_observed_winner_id
      AND f.finish_kind='satellite'
      AND (p_inflight OR (f.certified_at IS NOT NULL AND f.completed_at IS NOT NULL)))
    OR EXISTS(SELECT 1 FROM public.tournaments t WHERE t.id=p_tournament_id
      AND (COALESCE(t.is_bounty,false) OR COALESCE(t.is_pko,false)
        OR COALESCE(t.is_mystery_bounty,false) OR COALESCE(t.is_premium_spin,false))) THEN
    RAISE EXCEPTION 'satellite proof has no exact supported finish claim' USING ERRCODE='P0404';
  END IF;
  IF p_tournament_id IS NULL OR p_observed_winner_id IS NULL THEN
    RAISE EXCEPTION 'satellite receipt requires tournament and observed winner ids'
      USING ERRCODE = '22004';
  END IF;

  SELECT * INTO v_h
    FROM public.tournament_satellite_settlements s
   WHERE s.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'satellite % has no immutable settlement header',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF v_h.winner_id IS DISTINCT FROM p_observed_winner_id THEN
    RAISE EXCEPTION
      'satellite % receipt winner % differs from observed winner %',
      p_tournament_id, v_h.winner_id, p_observed_winner_id
      USING ERRCODE = '40001';
  END IF;
  IF v_h.receipt_version IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'satellite % has unsupported receipt version %',
      p_tournament_id, v_h.receipt_version USING ERRCODE = 'P0404';
  END IF;

  -- Target lifecycle state is intentionally absent from replay. A target may
  -- close after commit without changing what was already delivered.
  PERFORM 1 FROM public.tournaments t
   WHERE t.id IN (p_tournament_id, v_h.target_id)
   ORDER BY CASE WHEN t.id = v_h.target_id THEN 0 ELSE 1 END, t.id
   FOR UPDATE;
  SELECT t.id, t.status, t.variant, t.tournament_type,
         t.satellite_target_id, t.satellite_target, t.satellite_seats,
         t.prize_pool, t.prize_pool_finalized, t.ended_at,
         t.current_players, t.on_break, t.break_started_at, t.break_ends_at
    INTO v_source FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF v_source.id IS NULL THEN
    RAISE EXCEPTION 'satellite % source row is missing',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF p_inflight THEN
    IF upper(COALESCE(v_source.status,''))<>'COMPLETING'
       OR v_source.prize_pool_finalized IS DISTINCT FROM true
       OR NOT public.fn_ca_satellite_terminal_scope(p_tournament_id)
       OR (SELECT jsonb_array_length(a.authorized_seats)
           FROM public.tournament_satellite_terminal_authorizations a
           WHERE a.tournament_id=p_tournament_id)<>v_h.released_seat_count
       OR (SELECT count(DISTINCT e->>'seat_id')
           FROM public.tournament_satellite_terminal_authorizations a
           CROSS JOIN LATERAL jsonb_array_elements(a.authorized_seats) e
           WHERE a.tournament_id=p_tournament_id)<>v_h.released_seat_count
       OR EXISTS(SELECT 1 FROM public.tournament_satellite_terminal_authorizations a
          CROSS JOIN LATERAL jsonb_array_elements(a.authorized_seats) e
          WHERE a.tournament_id=p_tournament_id AND (
            (e->>'token')::uuid IS DISTINCT FROM a.token
            OR (e->>'tournament_id')::uuid IS DISTINCT FROM p_tournament_id
            OR e->>'operation' IS DISTINCT FROM 'satellite_finish'
            OR (e->>'created_at')::timestamptz IS DISTINCT FROM transaction_timestamp()
            OR NOT (e->>'seat_id')::uuid=ANY(v_h.released_seat_ids)
            OR NOT EXISTS(SELECT 1 FROM public.table_seats seat
              JOIN public.tables source_table ON source_table.id=seat.table_id
              WHERE seat.id=(e->>'seat_id')::uuid AND seat.user_id=(e->>'user_id')::uuid
                AND source_table.tournament_id=p_tournament_id)))
       OR EXISTS(SELECT 1 FROM public.tournament_seat_exit_authorizations a
         WHERE a.token=NULLIF(current_setting('app.tournament_seat_exit_token',true),'')::uuid) THEN
      RAISE EXCEPTION 'satellite pending close has no exact owned seat set' USING ERRCODE='P0404';
    END IF;
  ELSE
  IF upper(COALESCE(v_source.status, '')) <> 'COMPLETED'
     OR COALESCE(v_source.prize_pool_finalized, false) IS NOT TRUE
     OR v_source.ended_at IS NULL
     OR v_source.ended_at IS DISTINCT FROM v_h.source_closed_at
     OR v_source.current_players IS DISTINCT FROM 0
     OR v_source.on_break IS DISTINCT FROM false
     OR v_source.break_started_at IS NOT NULL
     OR v_source.break_ends_at IS NOT NULL THEN
    RAISE EXCEPTION 'satellite % receipt is not attached to one completed close',
      p_tournament_id USING ERRCODE = '55000';
  END IF;
  END IF;
  IF lower(COALESCE(v_source.variant, '')) <> 'satellite'
     AND upper(COALESCE(v_source.tournament_type, '')) <> 'SATELLITE'
     AND v_source.satellite_target_id IS NULL
     AND v_source.satellite_target IS NULL THEN
    RAISE EXCEPTION 'tournament % no longer identifies as a satellite',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF v_source.satellite_target_id IS NOT NULL
     AND v_source.satellite_target IS NOT NULL
     AND v_source.satellite_target_id IS DISTINCT FROM v_source.satellite_target THEN
    RAISE EXCEPTION 'satellite % has conflicting target columns',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  IF COALESCE(v_source.satellite_target_id, v_source.satellite_target)
       IS DISTINCT FROM v_h.target_id
     OR v_source.prize_pool IS NULL
     OR v_source.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR round(v_source.prize_pool, 2) IS DISTINCT FROM v_h.pool
     OR COALESCE(v_source.satellite_seats, 0) IS DISTINCT FROM v_h.advertised_seats
     OR v_h.pool < v_h.advertised_seats * v_h.ticket_cost
     OR floor(v_h.pool / v_h.ticket_cost)::integer IS DISTINCT FROM v_h.ticket_award_count
     OR round(v_h.pool - v_h.ticket_award_count * v_h.ticket_cost, 2)
          IS DISTINCT FROM v_h.remainder THEN
    RAISE EXCEPTION 'satellite % immutable receipt disagrees with its locked contract',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT t.id,t.buy_in_amount,t.buy_in_fee,t.bounty_amount,t.is_bounty,
         t.is_pko,t.is_mystery_bounty,t.is_premium_spin,t.variant,
         t.tournament_type,t.club_id
    INTO v_target FROM public.tournaments t
   WHERE t.id = v_h.target_id
   FOR SHARE;
  IF v_target.id IS NULL
     OR v_h.target_was_missing IS DISTINCT FROM false
     OR v_h.target_contract_version IS NOT NULL
     OR ((v_h.seat_count > 0 OR v_h.entry_ticket_count > 0) AND (
          v_target.buy_in_amount IS DISTINCT FROM v_h.target_buy_in
       OR COALESCE(v_target.buy_in_fee,0) IS DISTINCT FROM v_h.target_fee
       OR COALESCE(v_target.bounty_amount,0) <> 0
       OR COALESCE(v_target.is_bounty,false)
       OR COALESCE(v_target.is_pko,false)
       OR COALESCE(v_target.is_mystery_bounty,false)
       OR COALESCE(v_target.is_premium_spin,false)
       OR lower(COALESCE(v_target.variant,'')) = 'spin'
       OR upper(COALESCE(v_target.tournament_type,'')) = 'SPIN')) THEN
    RAISE EXCEPTION 'satellite % immutable receipt lost its locked target row',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  -- The header is the immutable settlement-time contract. Replay proves that
  -- exact value through its award, transfer and fee evidence. The terminal
  -- hardening migration also freezes the target's economic columns after its
  -- first actual seat, so cancellation and unregister use the same split.

  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id IN (p_tournament_id, v_h.target_id)
   ORDER BY tp.tournament_id, tp.id FOR SHARE;
  SELECT count(*), count(DISTINCT tp.position)
    INTO v_field_size, v_position_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  IF v_field_size <> v_h.field_size
     OR v_position_count <> v_h.field_size
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND (tp.position IS NULL OR tp.position < 1 OR tp.position > v_h.field_size)
    ) OR NOT EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.user_id = v_h.winner_id
          AND tp.position = 1 AND tp.status::text = 'winner'
          AND tp.eliminated_at IS NULL
          AND tp.elimination_sequence IS NULL
     ) OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.position > 1
          AND tp.status::text IS DISTINCT FROM 'eliminated'
     ) THEN
    RAISE EXCEPTION 'satellite % receipt has no exact final standings',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- A satellite is not terminal while its felt still owns live seats. The
  -- header freezes every source table and seat identity, plus the subset that
  -- this settlement itself released. Replay requires the exact same durable
  -- rows, every table closed at zero and no live seat left behind.
  PERFORM 1 FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY tb.id FOR UPDATE;
  PERFORM 1
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY ts.table_id, ts.id FOR UPDATE OF ts;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id), ARRAY[]::uuid[])
    INTO v_source_table_ids
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id), ARRAY[]::uuid[])
    INTO v_source_seat_ids
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id), ARRAY[]::uuid[])
    INTO v_durable_released_ids
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id
     AND ts.left_at IS NOT DISTINCT FROM v_h.settled_at
     AND ts.status IS NOT DISTINCT FROM 'left'
     AND ts.leave_pending IS FALSE
     AND ts.is_sitting_out IS FALSE
     AND ts.is_away IS FALSE
     AND ts.sit_out_at IS NULL
     AND ts.scheduled_leave_hands IS NULL;
  v_durable_released_count := cardinality(v_durable_released_ids);
  IF v_source_table_ids IS DISTINCT FROM v_h.source_table_ids
     OR cardinality(v_source_table_ids) IS DISTINCT FROM v_h.source_table_count
     OR v_source_seat_ids IS DISTINCT FROM v_h.source_seat_ids
     OR cardinality(v_source_seat_ids) IS DISTINCT FROM v_h.source_seat_count
     OR v_durable_released_ids IS DISTINCT FROM v_h.released_seat_ids
     OR v_durable_released_count IS DISTINCT FROM v_h.released_seat_count
     OR (NOT p_inflight AND EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.tournament_id = p_tournament_id
          AND (lower(COALESCE(tb.status::text, '')) <> 'closed'
            OR lower(COALESCE(tb.lifecycle, '')) <> 'closed'
            OR tb.current_players IS DISTINCT FROM 0
            OR tb.terminal_closed_at IS DISTINCT FROM v_h.source_closed_at)
     )) OR EXISTS (
       SELECT 1
        FROM public.table_seats ts
         JOIN public.tables tb ON tb.id = ts.table_id
        WHERE tb.tournament_id = p_tournament_id
          AND (ts.left_at IS NULL
            OR ts.status IS DISTINCT FROM 'left'
            OR ts.leave_pending IS DISTINCT FROM false
            OR ts.is_sitting_out IS DISTINCT FROM false
            OR ts.is_away IS DISTINCT FROM false
            OR ts.sit_out_at IS NOT NULL
            OR ts.scheduled_leave_hands IS NOT NULL)
     ) THEN
    RAISE EXCEPTION
      'satellite % source table or seat closeout differs from its immutable receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_rows
    FROM public.tournament_satellite_awards a
   WHERE a.tournament_id = p_tournament_id;
  IF v_rows <> v_h.ticket_award_count
     OR (SELECT count(*) FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id AND a.delivery_kind = 'seat')
          <> v_h.seat_count
     OR (SELECT count(*) FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id AND a.delivery_kind = 'cash')
          <> v_h.cash_ticket_count
     OR (SELECT count(*) FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id AND a.delivery_kind = 'ticket')
          <> v_h.entry_ticket_count
     OR EXISTS (
       SELECT 1
         FROM public.tournament_satellite_awards a
         JOIN public.tournament_players tp
           ON tp.tournament_id = p_tournament_id AND tp.position = a.place
        WHERE a.tournament_id = p_tournament_id
          AND (a.place > v_h.ticket_award_count
            OR a.user_id IS DISTINCT FROM tp.user_id
            OR a.amount IS DISTINCT FROM v_h.ticket_cost)
     ) OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.position BETWEEN 1 AND v_h.ticket_award_count
          AND NOT EXISTS (
            SELECT 1 FROM public.tournament_satellite_awards a
             WHERE a.tournament_id = p_tournament_id
               AND a.place = tp.position AND a.user_id = tp.user_id)
     ) THEN
    RAISE EXCEPTION 'satellite % has incomplete or non-contiguous award lines',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Every line has one exact payout row. Cash lines additionally prove the
  -- wallet credit and closed obligation; seats prove the registration and
  -- source-to-target funding leg below.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_payouts p ON p.id = a.payout_id
     WHERE a.tournament_id = p_tournament_id
       AND (p.id IS NULL
         OR p.tournament_id IS DISTINCT FROM p_tournament_id
         OR p.user_id IS DISTINCT FROM a.user_id
         OR p."position" IS DISTINCT FROM a.place
         OR p.amount IS DISTINCT FROM a.amount
         OR p.source IS DISTINCT FROM a.payout_source
         OR p.idempotency_key IS DISTINCT FROM a.idempotency_key)
  ) THEN
    RAISE EXCEPTION 'satellite % award line has no exact payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_obligations o ON o.id = a.obligation_id
      LEFT JOIN public.wallet_credit_idempotency k ON k.key = a.idempotency_key
     WHERE a.tournament_id = p_tournament_id
       AND a.delivery_kind = 'cash'
       AND (o.id IS NULL
         OR o.tournament_id IS DISTINCT FROM p_tournament_id
         OR o.kind IS DISTINCT FROM a.obligation_kind
         OR o.place IS DISTINCT FROM a.place
         OR o.user_id IS DISTINCT FROM a.user_id
         OR o.amount_owed IS DISTINCT FROM a.amount
         OR o.amount_paid IS DISTINCT FROM a.amount
         OR o.settled_at IS NULL
         OR k.key IS NULL
         OR k.user_id IS DISTINCT FROM a.user_id
         OR k.amount IS DISTINCT FROM a.amount)
  ) THEN
    RAISE EXCEPTION 'satellite % cash ticket has no exact wallet/debt evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- A cap-blocked full award remains the source pool's money but is held in a
  -- noncash, target-scoped ticket escrow. Prove the immutable award identity,
  -- exact issue journal and absence of a wallet credit on every replay.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_payouts p ON p.id=a.payout_id
      LEFT JOIN public.tournament_tickets tk ON tk.id=a.ticket_id
      LEFT JOIN public.chip_ledger l
        ON l.idempotency_key=a.idempotency_key||':ticket_escrow'
       AND l.to_type='escrow' AND l.to_entity_id=a.ticket_id
     WHERE a.tournament_id=p_tournament_id
       AND a.delivery_kind='ticket'
       AND (tk.id IS NULL
         OR tk.issued_by IS DISTINCT FROM
              '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid
         OR tk.holder_id IS DISTINCT FROM a.user_id
         OR tk.value IS DISTINCT FROM a.amount
         OR tk.status NOT IN ('issued','redeemed')
         OR tk.redemption_mode IS DISTINCT FROM 'tournament_entry_only'
         OR tk.source_tournament_id IS DISTINCT FROM v_h.target_id
         OR tk.source_satellite_id IS DISTINCT FROM p_tournament_id
         OR tk.source_refund_entitlement_id IS NOT NULL
         OR tk.source_satellite_award_place IS DISTINCT FROM a.place
         OR tk.entry_prize IS DISTINCT FROM v_h.target_buy_in
         OR tk.entry_bounty IS DISTINCT FROM 0::numeric
         OR tk.entry_fee IS DISTINCT FROM v_h.target_fee
         OR p.metadata->>'delivery_kind' IS DISTINCT FROM 'ticket'
         OR p.metadata->>'ticket_id' IS DISTINCT FROM tk.id::text
         OR p.metadata->>'satellite_target_id' IS DISTINCT FROM v_h.target_id::text
         OR p.metadata->>'wallet_chips_credited' IS DISTINCT FROM '0'
         OR l.id IS NULL
         OR l.status IS DISTINCT FROM 'posted'
         OR l.from_type IS DISTINCT FROM 'prize_liability'
         OR l.from_entity_id IS DISTINCT FROM p_tournament_id
         OR l.to_type IS DISTINCT FROM 'escrow'
         OR l.to_entity_id IS DISTINCT FROM tk.id
         OR l.amount IS DISTINCT FROM a.amount
         OR l.category IS DISTINCT FROM 'ticket_issue'
         OR l.club_id IS DISTINCT FROM tk.club_id
         OR l.tournament_id IS DISTINCT FROM p_tournament_id
         OR l.settlement_id IS DISTINCT FROM
              'satellite-ticket:'||tk.id::text
         OR l.actor_service IS DISTINCT FROM 'fn_settle_satellite_tournament'
         OR l.pre_from_balance IS DISTINCT FROM
              round(v_h.pool-(a.place-1)*v_h.ticket_cost,2)
         OR l.post_from_balance IS DISTINCT FROM
              round(v_h.pool-a.place*v_h.ticket_cost,2)
         OR l.pre_to_balance IS DISTINCT FROM 0::numeric
         OR l.post_to_balance IS DISTINCT FROM a.amount
         OR l.metadata->>'kind' IS DISTINCT FROM
              'direct_satellite_entry_ticket'
         OR l.metadata->>'delivery_kind' IS DISTINCT FROM 'ticket'
         OR l.metadata->>'ticket_id' IS DISTINCT FROM tk.id::text
         OR l.metadata->>'payout_id' IS DISTINCT FROM a.payout_id::text
         OR l.metadata->>'satellite_id' IS DISTINCT FROM p_tournament_id::text
         OR l.metadata->>'satellite_target_id' IS DISTINCT FROM v_h.target_id::text
         OR l.metadata->>'user_id' IS DISTINCT FROM a.user_id::text
         OR l.metadata->>'position' IS DISTINCT FROM a.place::text
         OR (l.metadata->>'entry_prize')::numeric IS DISTINCT FROM
              v_h.target_buy_in
         OR (l.metadata->>'entry_bounty')::numeric IS DISTINCT FROM 0::numeric
         OR (l.metadata->>'entry_fee')::numeric IS DISTINCT FROM v_h.target_fee
         OR l.metadata->>'wallet_chips_credited' IS DISTINCT FROM '0'
         OR EXISTS (
           SELECT 1 FROM public.wallet_credit_idempotency wallet_key
            WHERE wallet_key.key=a.idempotency_key)
         OR (SELECT count(*)
               FROM public.chip_transactions issue_tx
              WHERE issue_tx.transaction_type='tournament_ticket_issue'
                AND issue_tx.club_id=tk.club_id
                AND issue_tx.from_user_id IS NULL
                AND issue_tx.to_user_id=a.user_id
                AND issue_tx.amount=a.amount
                AND issue_tx.metadata->>'ticket_id'=tk.id::text
                AND issue_tx.metadata->>'escrow_entity_id'=tk.id::text
                AND issue_tx.metadata->>'holder_id'=a.user_id::text
                AND (issue_tx.metadata->>'value')::numeric=a.amount
                AND issue_tx.metadata->>'redemption_mode'=
                      'tournament_entry_only'
                AND issue_tx.metadata->>'source_tournament_id'=
                      v_h.target_id::text
                AND issue_tx.metadata->>'source_satellite_id'=
                      p_tournament_id::text
                AND issue_tx.metadata->>'source_award_place'=a.place::text
                AND issue_tx.metadata->>'payout_id'=a.payout_id::text
                AND issue_tx.metadata->>'ledger_id'=l.id::text
                AND issue_tx.metadata->>'idempotency_key'=a.idempotency_key
                AND issue_tx.metadata->>'wallet_chips_credited'='0') <> 1)
  ) OR (SELECT count(*) FROM public.tournament_tickets tk
         WHERE tk.source_satellite_id=p_tournament_id
           AND tk.source_satellite_award_place IS NOT NULL)
       <> v_h.entry_ticket_count
    OR (SELECT count(*) FROM public.chip_ledger l
         WHERE l.from_type='prize_liability'
           AND l.from_entity_id=p_tournament_id
           AND l.category='ticket_issue'
           AND l.metadata->>'kind'='direct_satellite_entry_ticket')
       <> v_h.entry_ticket_count THEN
    RAISE EXCEPTION
      'satellite % direct ticket has no exact noncash escrow evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_h.seat_count > 0 AND v_target.id IS NULL THEN
    RAISE EXCEPTION 'satellite % delivered seats into a missing target',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_players target_player
        ON target_player.id = a.registration_id
      LEFT JOIN public.chip_ledger l
        ON l.idempotency_key = 'tourney:' || p_tournament_id::text
                               || ':seat:' || a.user_id::text || ':pool_transfer'
     WHERE a.tournament_id = p_tournament_id
       AND a.delivery_kind = 'seat'
       AND (target_player.id IS NULL
         OR target_player.tournament_id IS DISTINCT FROM v_h.target_id
           OR target_player.user_id IS DISTINCT FROM a.user_id
           OR COALESCE(target_player.is_satellite_qualifier, false) IS NOT TRUE
           OR target_player.source_satellite_id IS DISTINCT FROM p_tournament_id
         OR l.id IS NULL
         OR l.amount IS DISTINCT FROM v_h.ticket_cost
         OR l.from_type IS DISTINCT FROM 'prize_liability'
         OR l.from_entity_id IS DISTINCT FROM p_tournament_id
         OR l.to_type IS DISTINCT FROM 'prize_liability'
         OR l.to_entity_id IS DISTINCT FROM v_h.target_id
         OR l.category IS DISTINCT FROM 'tournament_buyin'
         OR l.metadata->>'registration_id' IS DISTINCT FROM a.registration_id::text)
  ) OR EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = v_h.target_id
       AND tp.source_satellite_id = p_tournament_id
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id
            AND a.delivery_kind = 'seat' AND a.registration_id = tp.id)
  ) OR (SELECT count(*) FROM public.chip_ledger l
         WHERE l.from_type = 'prize_liability'
           AND l.from_entity_id = p_tournament_id
           AND l.idempotency_key LIKE 'tourney:' || p_tournament_id::text
                                          || ':seat:%:pool_transfer')
       <> v_h.seat_count THEN
    RAISE EXCEPTION 'satellite % has malformed or extra actual-seat evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*), round(COALESCE(sum(r.rake_amount), 0), 2)
    INTO v_rows, v_rake
    FROM public.rake_records r
   WHERE r.tournament_id = v_h.target_id
     AND r.is_tournament
     AND r.source = 'fn_award_satellite_seat'
     AND r.metadata->>'satellite_id' = p_tournament_id::text;
  IF v_rows <> (CASE WHEN v_h.target_fee > 0 THEN v_h.seat_count ELSE 0 END)
     OR v_rake IS DISTINCT FROM round(v_h.seat_count * v_h.target_fee, 2)
     OR (SELECT count(DISTINCT r.metadata->>'registration_id')
           FROM public.rake_records r
          WHERE r.tournament_id = v_h.target_id
            AND r.is_tournament
            AND r.source = 'fn_award_satellite_seat'
            AND r.metadata->>'satellite_id' = p_tournament_id::text)
          <> (CASE WHEN v_h.target_fee > 0 THEN v_h.seat_count ELSE 0 END)
     OR EXISTS (
       SELECT 1 FROM public.rake_records r
        WHERE r.tournament_id = v_h.target_id
          AND r.is_tournament
          AND r.source = 'fn_award_satellite_seat'
          AND r.metadata->>'satellite_id' = p_tournament_id::text
          AND (r.rake_amount IS DISTINCT FROM v_h.target_fee
            OR r.pot_size IS DISTINCT FROM v_h.ticket_cost
            OR r.metadata->>'kind' IS DISTINCT FROM 'satellite_seat_entry_fee'
            OR NOT EXISTS (
              SELECT 1 FROM public.tournament_satellite_awards a
               WHERE a.tournament_id = p_tournament_id
                 AND a.delivery_kind = 'seat'
                 AND a.user_id::text = r.metadata->>'user_id'
                 AND a.registration_id::text = r.metadata->>'registration_id'))
     ) OR EXISTS (
       SELECT 1
         FROM public.tournament_satellite_awards a
        WHERE a.tournament_id = p_tournament_id
          AND a.delivery_kind = 'seat'
          AND v_h.target_fee > 0
          AND (SELECT count(*)
                 FROM public.rake_records r
                WHERE r.tournament_id = v_h.target_id
                  AND r.is_tournament
                  AND r.source = 'fn_award_satellite_seat'
                  AND r.metadata->>'kind' = 'satellite_seat_entry_fee'
                  AND r.metadata->>'satellite_id' = p_tournament_id::text
                  AND r.metadata->>'user_id' = a.user_id::text
                  AND r.metadata->>'registration_id' = a.registration_id::text
                  AND r.rake_amount = v_h.target_fee
                  AND r.pot_size = v_h.ticket_cost) <> 1
     ) THEN
    RAISE EXCEPTION 'satellite % has malformed target-entry evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_rows
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id;
  IF v_rows <> (v_h.cash_ticket_count
                + CASE WHEN v_h.remainder > 0 THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION 'satellite % has missing or extra obligation evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_h.remainder > 0 THEN
    IF (SELECT count(*) FROM public.tournament_satellite_remainders r
         WHERE r.tournament_id = p_tournament_id) <> 1
       OR NOT EXISTS (
      SELECT 1
        FROM public.tournament_players bubble
        JOIN public.tournament_satellite_remainders r
          ON r.tournament_id = p_tournament_id
         AND r.user_id = bubble.user_id
         AND r.place = v_h.bubble_position
         AND r.amount = v_h.remainder
        JOIN public.tournament_payouts p
          ON p.id = r.payout_id
         AND p.tournament_id = p_tournament_id
         AND p.user_id = bubble.user_id
         AND p."position" IS NOT DISTINCT FROM r.payout_position
         AND p.amount = v_h.remainder
         AND p.source = r.payout_source
         AND p.idempotency_key = r.idempotency_key
        JOIN public.tournament_obligations o
          ON o.id = r.obligation_id
         AND o.tournament_id = p_tournament_id
         AND o.kind = r.obligation_kind
         AND o.place IS NOT DISTINCT FROM r.obligation_place
         AND o.user_id = bubble.user_id
         AND o.amount_owed = v_h.remainder
         AND o.amount_paid = v_h.remainder
         AND o.settled_at IS NOT NULL
        JOIN public.wallet_credit_idempotency k
          ON k.key = r.idempotency_key
         AND k.user_id = bubble.user_id
         AND k.amount = v_h.remainder
       WHERE bubble.tournament_id = p_tournament_id
         AND bubble.user_id = v_h.bubble_user_id
         AND bubble.position = v_h.bubble_position
         AND (
           (r.evidence_kind = 'atomic'
             AND r.payout_position IS NOT DISTINCT FROM r.place
             AND r.obligation_place IS NOT DISTINCT FROM r.place
             AND r.idempotency_key = 'tourney:' || p_tournament_id::text
                 || ':satellite_remainder:place:' || r.place::text)
           OR r.evidence_kind = 'legacy_20260908_682')
    ) THEN
      RAISE EXCEPTION 'satellite % has no exact single-bubble remainder payment',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    v_remainder := jsonb_build_object(
      'user_id', v_h.bubble_user_id,
      'position', v_h.bubble_position,
      'amount', v_h.remainder);
  ELSIF EXISTS (SELECT 1 FROM public.tournament_satellite_remainders r
                 WHERE r.tournament_id = p_tournament_id)
     OR EXISTS (
       SELECT 1 FROM public.tournament_payouts p
        WHERE p.tournament_id = p_tournament_id
          AND p.source = 'satellite_remainder'
     ) THEN
    RAISE EXCEPTION 'satellite % has remainder evidence when remainder is zero',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_expected_rows := v_h.ticket_award_count
                     + CASE WHEN v_h.remainder > 0 THEN 1 ELSE 0 END;
  SELECT count(*), round(COALESCE(sum(p.amount), 0), 2)
    INTO v_rows, v_amount
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id;
  IF v_rows <> v_expected_rows OR v_amount IS DISTINCT FROM v_h.pool THEN
    RAISE EXCEPTION
      'satellite % payout evidence has % rows / % chips, expected % / %',
      p_tournament_id, v_rows, v_amount, v_expected_rows, v_h.pool
      USING ERRCODE = 'P0404';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.prize IS DISTINCT FROM CASE
         WHEN tp.position BETWEEN 1 AND v_h.ticket_award_count THEN v_h.ticket_cost
         WHEN v_h.remainder > 0 AND tp.position = v_h.bubble_position
           THEN v_h.remainder
         ELSE 0::numeric
       END
  ) THEN
    RAISE EXCEPTION 'satellite % prize cache disagrees with its receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_source_escrow
    FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id
   FOR UPDATE;
  IF v_source_escrow.tournament_id IS NULL
     OR COALESCE(v_source_escrow.enforced, false) IS NOT TRUE
     OR v_source_escrow.prize_out IS DISTINCT FROM v_h.pool
     OR v_source_escrow.bounty_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.refund_bounty IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.prize_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.closed_at IS DISTINCT FROM v_h.source_escrow_closed_at
     OR v_source_escrow.close_note IS DISTINCT FROM v_h.source_escrow_close_note
     OR EXISTS (
       SELECT 1
         FROM unnest(ARRAY[
           'gross_in','fee_entries_in','satellite_fee_in','bounty_in',
           'overlay_in','satellite_in','prize_out','bounty_out','fee_out',
           'refund_prize','refund_bounty','refund_fee',
           'prize_balance','bounty_balance','fee_balance',
           'reserve_out','reserve_in'
         ]::text[]) AS component(name)
         CROSS JOIN LATERAL (
           SELECT (to_jsonb(v_source_escrow)->>component.name)::numeric AS amount
         ) AS persisted
        WHERE persisted.amount IS NULL
           OR CASE
                WHEN persisted.amount::text IN ('NaN','Infinity','-Infinity')
                  THEN true
                ELSE persisted.amount < 0
                  OR persisted.amount IS DISTINCT FROM round(persisted.amount,2)
              END
     ) THEN
    RAISE EXCEPTION 'satellite % did not close every escrow bank at zero',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_rake_settlement
    FROM public.tournament_rake_settlements s
   WHERE s.tournament_id = p_tournament_id;
  SELECT round(COALESCE(sum(r.rake_amount), 0), 2) INTO v_rake
    FROM public.rake_records r
   WHERE r.tournament_id = p_tournament_id AND r.is_tournament;
  IF v_rake_settlement.tournament_id IS NULL
     OR v_rake_settlement.settled_at IS NULL
     OR v_rake_settlement.amount IS DISTINCT FROM v_rake
     OR (v_rake > 0 AND v_rake_settlement.attributed_at IS NULL) THEN
    RAISE EXCEPTION 'satellite % rake has no exact terminal settlement',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'user_id', a.user_id,
           'position', a.place,
           'amount', a.amount,
           'delivery_kind', a.delivery_kind,
           'payout_id', a.payout_id,
           'registration_id', a.registration_id,
           'ticket_id', a.ticket_id)
         ORDER BY a.place), '[]'::jsonb)
    INTO v_awards
    FROM public.tournament_satellite_awards a
   WHERE a.tournament_id = p_tournament_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'user_id', a.user_id,
           'position', a.place,
           'amount', a.amount,
           'registration_id', a.registration_id)
         ORDER BY a.place), '[]'::jsonb)
    INTO v_seats
    FROM public.tournament_satellite_awards a
   WHERE a.tournament_id = p_tournament_id
     AND a.delivery_kind = 'seat';

  v_winner_amount := CASE WHEN v_h.ticket_award_count > 0
                          THEN v_h.ticket_cost ELSE v_h.remainder END;
  RETURN jsonb_build_object(
    'ok', true,
    'fully_settled', NOT p_inflight,
    'status', CASE WHEN p_inflight THEN 'COMPLETING' ELSE 'COMPLETED' END,
    'inflight_financial_proof',p_inflight,
    'tournament_id', p_tournament_id,
    'target_id', v_h.target_id,
    'winner_id', v_h.winner_id,
    'field_size', v_h.field_size,
    'pool', v_h.pool,
    'ticket_cost', v_h.ticket_cost,
    'ticket_award_count', v_h.ticket_award_count,
    'seat_count', v_h.seat_count,
    'cash_ticket_count', v_h.cash_ticket_count,
    'entry_ticket_count', v_h.entry_ticket_count,
    'awards', v_awards,
    'seats', v_seats,
    'remainder', v_remainder,
    'winner_amount', v_winner_amount,
    'source_table_count', v_h.source_table_count,
    'source_seat_count', v_h.source_seat_count,
    'released_seat_count', v_h.released_seat_count,
    'source_closeout', jsonb_build_object(
      'source_table_count', v_h.source_table_count,
      'source_table_ids', to_jsonb(v_h.source_table_ids),
      'source_seat_count', v_h.source_seat_count,
      'source_seat_ids', to_jsonb(v_h.source_seat_ids),
      'released_seat_count', v_h.released_seat_count,
      'released_seat_ids', to_jsonb(v_h.released_seat_ids),
      'closed_at', v_h.source_closed_at,
      'escrow_closed_at', v_h.source_escrow_closed_at,
      'escrow_close_note', v_h.source_escrow_close_note),
    'settled_at', v_h.settled_at,
    'receipt_version', v_h.receipt_version);
END;
$current_satellite_proof$;

DO $patch_core$
DECLARE v_oid oid:=to_regprocedure('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)'); v_body text;v_definition text;v_before jsonb;v_after jsonb;
BEGIN
 SELECT prosrc,pg_get_functiondef(oid),to_jsonb(p)-'prosrc'
 INTO v_body,v_definition,v_before FROM pg_proc p WHERE oid=v_oid;
 IF v_oid IS NULL OR md5(v_body) NOT IN ('83bf8b297d07bbae671707f24afec271','0e2066fafe3c4e1fceb96db9937b3140')
    OR (v_before->>'proowner')::oid<>'postgres'::regrole::oid
    OR (v_before->>'prosecdef')::boolean IS DISTINCT FROM true
    OR has_function_privilege('anon',v_oid,'EXECUTE')
    OR has_function_privilege('authenticated',v_oid,'EXECUTE')
    OR has_function_privilege('service_role',v_oid,'EXECUTE') THEN
  RAISE EXCEPTION 'current satellite core source or owner differs'; END IF;
 IF md5(v_body)='83bf8b297d07bbae671707f24afec271' THEN
  EXECUTE replace(v_definition,v_body,$patch_body_core$
DECLARE
  v_source record;
  v_target record;
  v_target_after record;
  v_winner public.tournament_players%ROWTYPE;
  v_finisher public.tournament_players%ROWTYPE;
  v_existing_target public.tournament_players%ROWTYPE;
  v_source_escrow public.tournament_escrow%ROWTYPE;
  v_target_escrow public.tournament_escrow%ROWTYPE;
  v_target_escrow_after public.tournament_escrow%ROWTYPE;
  v_existing_header public.tournament_satellite_settlements%ROWTYPE;
  v_obligation public.tournament_obligations%ROWTYPE;
  v_observed_target_id uuid;
  v_target_id uuid;
  v_target_open boolean := false;
  v_pool numeric;
  v_target_buy_in numeric;
  v_target_fee numeric;
  v_ticket_cost numeric;
  v_advertised_seats integer;
  v_ticket_award_count integer;
  v_seat_count integer := 0;
  v_cash_ticket_count integer := 0;
  v_entry_ticket_count integer := 0;
  v_remainder numeric;
  v_bubble_position integer;
  v_bubble_user_id uuid;
  v_field_size integer;
  v_target_count integer := 0;
  v_target_count_before integer := 0;
  v_target_live_count integer := 0;
  v_target_live_count_before integer := 0;
  v_target_counter_before integer := 0;
  v_target_counter_after integer := 0;
  v_target_slots integer := 0;
  v_live_count integer;
  v_eliminated_count integer;
  v_sequenced_count integer;
  v_distinct_sequence_count integer;
  v_place integer;
  v_cap_user_id uuid;
  v_cap_load integer;
  v_rows integer;
  v_registration_id uuid;
  v_ticket_id uuid;
  v_ticket_club_id uuid;
  v_ticket_ledger_id uuid;
  v_ticket_transaction_id uuid;
  v_payout_id uuid;
  v_pool_before numeric;
  v_rake_result jsonb;
  v_phase_three_scope jsonb;
  v_phase_three_claim jsonb;
  v_phase_three_receipt jsonb;
  v_credited boolean;
  v_payout_count integer;
  v_paid numeric;
  v_delivery_kind text;
  v_payout_key text;
  v_plan jsonb := '[]'::jsonb;
  v_plan_item jsonb;
  v_source_table_ids uuid[] := ARRAY[]::uuid[];
  v_source_seat_ids uuid[] := ARRAY[]::uuid[];
  v_released_seat_ids uuid[] := ARRAY[]::uuid[];
  v_source_table_count integer := 0;
  v_source_seat_count integer := 0;
  v_released_seat_count integer := 0;
  v_closeout_at timestamptz := transaction_timestamp();
  v_source_escrow_close_note text :=
    'atomic satellite terminal receipt: exact zero';
BEGIN
  -- Every terminal money authority takes this transaction lock before any
  -- row lock. Cash and satellite finishes can pay the same wallets, so one
  -- shared first lock prevents opposite recipient orders from deadlocking.
  PERFORM public.fn_ca_lock_settlement_lane_global();

  IF p_tournament_id IS NULL OR p_observed_winner_id IS NULL THEN
    RAISE EXCEPTION 'satellite settlement requires tournament and observed winner ids'
      USING ERRCODE = '22004';
  END IF;

  -- A committed header wins before target admission is inspected. Replays can
  -- never turn a previously delivered seat into cash because a target closed.
  SELECT * INTO v_existing_header
    FROM public.tournament_satellite_settlements s
   WHERE s.tournament_id = p_tournament_id
   FOR UPDATE;
  IF FOUND THEN
    RETURN public.fn_ca_satellite_settlement_receipt(
      p_tournament_id, p_observed_winner_id);
  END IF;

  v_phase_three_scope:=public.fn_ca_open_satellite_terminal_scope(p_tournament_id);

  SELECT COALESCE(t.satellite_target_id, t.satellite_target)
    INTO v_observed_target_id
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_observed_target_id IS NULL OR v_observed_target_id = p_tournament_id THEN
    RAISE EXCEPTION 'satellite % has no distinct target', p_tournament_id
      USING ERRCODE = '23514';
  END IF;

  -- During the rolling cutover the legacy seat door still takes target before
  -- source. Match that order until stage two removes it; the global lock also
  -- serializes this authority with every new terminal payer.
  PERFORM 1 FROM public.tournaments t
   WHERE t.id IN (p_tournament_id, v_observed_target_id)
   ORDER BY CASE WHEN t.id = v_observed_target_id THEN 0 ELSE 1 END, t.id
   FOR UPDATE;
  SELECT t.id, t.name, t.club_id, t.status, t.variant, t.tournament_type,
         t.satellite_target_id, t.satellite_target, t.satellite_seats,
         t.prize_pool, t.prize_pool_finalized, t.is_bounty, t.is_pko,
         t.is_mystery_bounty, t.is_premium_spin
    INTO v_source FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF v_source.id IS NULL THEN
    RAISE EXCEPTION 'tournament % disappeared while being locked', p_tournament_id
      USING ERRCODE = '40001';
  END IF;
  IF v_source.satellite_target_id IS NOT NULL
     AND v_source.satellite_target IS NOT NULL
     AND v_source.satellite_target_id IS DISTINCT FROM v_source.satellite_target THEN
    RAISE EXCEPTION 'satellite % has conflicting target columns',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  v_target_id := COALESCE(v_source.satellite_target_id, v_source.satellite_target);
  IF v_target_id IS DISTINCT FROM v_observed_target_id THEN
    RAISE EXCEPTION 'satellite % target changed while settlement acquired locks',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  -- A concurrent caller may have committed while this caller waited above.
  SELECT * INTO v_existing_header
    FROM public.tournament_satellite_settlements s
   WHERE s.tournament_id = p_tournament_id
   FOR UPDATE;
  IF FOUND THEN
    RETURN public.fn_ca_satellite_settlement_receipt(
      p_tournament_id, p_observed_winner_id);
  END IF;

  IF lower(COALESCE(v_source.variant, '')) <> 'satellite'
     AND upper(COALESCE(v_source.tournament_type, '')) <> 'SATELLITE'
     AND v_source.satellite_target_id IS NULL
     AND v_source.satellite_target IS NULL THEN
    RAISE EXCEPTION 'tournament % is not a satellite', p_tournament_id
      USING ERRCODE = '22023';
  END IF;
  IF upper(COALESCE(v_source.status, '')) NOT IN ('RUNNING','COMPLETING') THEN
    RAISE EXCEPTION 'satellite % cannot first-settle from status %',
      p_tournament_id, v_source.status USING ERRCODE = '55000';
  END IF;
  IF COALESCE(v_source.prize_pool_finalized, false) IS NOT TRUE THEN
    RAISE EXCEPTION
      'satellite % prize pool is not finalized; guarantee funding is not proven',
      p_tournament_id USING ERRCODE = '55000';
  END IF;
  IF COALESCE(v_source.is_bounty, false)
     OR COALESCE(v_source.is_pko, false)
     OR COALESCE(v_source.is_mystery_bounty, false)
     OR COALESCE(v_source.is_premium_spin, false)
     OR lower(COALESCE(v_source.variant, '')) = 'spin'
     OR upper(COALESCE(v_source.tournament_type, '')) = 'SPIN' THEN
    RAISE EXCEPTION 'satellite % mixes another payout authority', p_tournament_id
      USING ERRCODE = '22023';
  END IF;

  v_pool := v_source.prize_pool;
  v_advertised_seats := COALESCE(v_source.satellite_seats, 0);
  IF v_pool IS NULL OR v_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_pool < 0 OR v_pool IS DISTINCT FROM round(v_pool, 2) THEN
    RAISE EXCEPTION 'satellite % has invalid whole-cent pool %',
      p_tournament_id, v_pool USING ERRCODE = '22003';
  END IF;
  IF v_advertised_seats < 0 THEN
    RAISE EXCEPTION 'satellite % has invalid advertised seat count %',
      p_tournament_id, v_advertised_seats USING ERRCODE = '22003';
  END IF;

  SELECT t.id, t.name, t.club_id, t.status, t.variant, t.tournament_type,
         t.buy_in_amount, t.buy_in_fee, t.is_bounty, t.is_pko,
         t.is_mystery_bounty, t.is_premium_spin,
         t.max_players, t.current_players, t.current_level,
         t.late_reg_levels, t.rebuy_levels, t.prize_pool_finalized,
         t.prize_pool, t.total_rake
    INTO v_target FROM public.tournaments t
   WHERE t.id = v_target_id
   FOR UPDATE;
  IF v_target.id IS NULL THEN
    -- PostgreSQL cannot row-lock an absent target. Refuse the settlement so a
    -- concurrent same-id target insert can never race a cash substitution.
    RAISE EXCEPTION
      'satellite % target % is missing; absence cannot authorize cash substitution',
      p_tournament_id, v_target_id USING ERRCODE = 'P0404';
  END IF;
  v_target_buy_in := v_target.buy_in_amount;
  v_target_fee := COALESCE(v_target.buy_in_fee, 0);
  IF v_target_buy_in IS NULL
     OR v_target_buy_in::text IN ('NaN','Infinity','-Infinity')
     OR v_target_buy_in < 0
     OR v_target_buy_in IS DISTINCT FROM round(v_target_buy_in, 2)
     OR v_target_fee IS NULL
     OR v_target_fee::text IN ('NaN','Infinity','-Infinity')
     OR v_target_fee < 0
     OR v_target_fee IS DISTINCT FROM round(v_target_fee, 2) THEN
    RAISE EXCEPTION 'satellite % target has an invalid whole-cent entry contract',
      p_tournament_id USING ERRCODE = '22003';
  END IF;
  v_ticket_cost := round(v_target_buy_in + v_target_fee, 2);
  IF v_ticket_cost <= 0 THEN
    RAISE EXCEPTION 'satellite % target ticket has no positive value',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  -- A bounty or Spin target needs a different, fully receipted split across
  -- prize, fee and bounty rails. This authority deliberately refuses that
  -- contract instead of silently classifying the bounty slice as prize.
  IF (
       v_target.is_bounty IS DISTINCT FROM false
       OR v_target.is_pko IS DISTINCT FROM false
       OR v_target.is_mystery_bounty IS DISTINCT FROM false
       OR v_target.is_premium_spin IS DISTINCT FROM false
       OR lower(COALESCE(v_target.variant,'')) = 'spin'
       OR upper(COALESCE(v_target.tournament_type,'')) = 'SPIN'
     ) THEN
    RAISE EXCEPTION
      'satellite % target % uses an unsupported bounty or Spin entry split',
      p_tournament_id, v_target_id USING ERRCODE = '22023';
  END IF;
  IF v_pool < v_advertised_seats * v_ticket_cost THEN
    RAISE EXCEPTION
      'satellite % finalized pool % does not fund its % advertised tickets at % each',
      p_tournament_id, v_pool, v_advertised_seats, v_ticket_cost
      USING ERRCODE = 'P0403';
  END IF;

  -- Open and own only the source escrow before the delivery plan is known. A
  -- cash-only plan must not touch a completed target's immutable escrow merely
  -- to prove that no seat will be delivered there.
  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id, 'atomic satellite settlement source lock');
  PERFORM 1 FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id
   FOR UPDATE;
  SELECT * INTO v_source_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id;
  IF v_source_escrow.tournament_id IS NULL
     OR COALESCE(v_source_escrow.enforced, false) IS NOT TRUE
     OR v_source_escrow.closed_at IS NOT NULL
     OR v_source_escrow.close_note IS NOT NULL
     OR v_source_escrow.prize_balance IS DISTINCT FROM v_pool
     OR v_source_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.refund_bounty IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_balance IS NULL
     OR v_source_escrow.fee_balance::text IN ('NaN','Infinity','-Infinity')
     OR v_source_escrow.fee_balance < 0
     OR v_source_escrow.fee_balance IS DISTINCT FROM round(v_source_escrow.fee_balance, 2)
     OR EXISTS (
       SELECT 1
         FROM unnest(ARRAY[
           'gross_in','fee_entries_in','satellite_fee_in','bounty_in',
           'overlay_in','satellite_in','prize_out','bounty_out','fee_out',
           'refund_prize','refund_bounty','refund_fee',
           'prize_balance','bounty_balance','fee_balance',
           'reserve_out','reserve_in'
         ]::text[]) AS component(name)
         CROSS JOIN LATERAL (
           SELECT (to_jsonb(v_source_escrow)->>component.name)::numeric AS amount
         ) AS persisted
        WHERE persisted.amount IS NULL
           OR CASE
                WHEN persisted.amount::text IN ('NaN','Infinity','-Infinity')
                  THEN true
                ELSE persisted.amount < 0
                  OR persisted.amount IS DISTINCT FROM round(persisted.amount,2)
              END
     ) THEN
    RAISE EXCEPTION
      'satellite % escrow does not hold exactly its locked pool (pool %, prize %, bounty %, fee %)',
      p_tournament_id, v_pool, v_source_escrow.prize_balance,
      v_source_escrow.bounty_balance, v_source_escrow.fee_balance
      USING ERRCODE = 'P0403';
  END IF;
  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id IN (p_tournament_id, v_target_id)
   ORDER BY tp.tournament_id, tp.id FOR UPDATE;

  -- Keep the same root lock order used by every terminal authority: tournament,
  -- tournament roster, source tables, then source seats. The identities are
  -- frozen before any payer runs and become part of the immutable header.
  PERFORM 1 FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY tb.id FOR UPDATE;
  PERFORM 1
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY ts.table_id, ts.id FOR UPDATE OF ts;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id), ARRAY[]::uuid[])
    INTO v_source_table_ids
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id), ARRAY[]::uuid[]),
         COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id)
                    FILTER (WHERE ts.left_at IS NULL), ARRAY[]::uuid[])
    INTO v_source_seat_ids, v_released_seat_ids
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id;
  v_source_table_count := cardinality(v_source_table_ids);
  v_source_seat_count := cardinality(v_source_seat_ids);
  v_released_seat_count := cardinality(v_released_seat_ids);
  IF v_source_table_count < 1 THEN
    RAISE EXCEPTION 'satellite % has no source table to close', p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_field_size FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  SELECT count(*),
         count(*) FILTER (
           WHERE tp.status::text IN ('registered','playing'))
    INTO v_target_count, v_target_live_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = v_target_id;
  v_target_count_before := v_target_count;
  v_target_live_count_before := v_target_live_count;
  -- Before start, current_players is the live lobby count maintained by the
  -- canonical roster trigger. Once RUNNING, it is the immutable total entrant
  -- count and must not shrink when a player is eliminated.
  v_target_counter_before := CASE
    WHEN upper(COALESCE(v_target.status, '')) IN ('ANNOUNCED','REGISTERING')
      THEN v_target_live_count_before
    ELSE v_target_count_before
  END;
  IF v_field_size < 1 THEN
    RAISE EXCEPTION 'satellite % has no final field', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND (tp.status IS NULL
         OR tp.status::text NOT IN ('playing','winner','eliminated'))
  ) THEN
    RAISE EXCEPTION 'satellite % still has an unresolved roster',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Apart from the one explicitly adopted historical miss below, a new
  -- settlement must start with no money, target-seat or cache fragments.
  IF EXISTS (SELECT 1 FROM public.tournament_payouts p
              WHERE p.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_rake_settlements r
                 WHERE r.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_players tp
                 WHERE tp.tournament_id = p_tournament_id
                   AND COALESCE(tp.prize, 0) <> 0)
     OR EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.from_entity_id = p_tournament_id
          AND l.idempotency_key LIKE 'tourney:' || p_tournament_id::text
                                       || ':seat:%:pool_transfer')
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = v_target_id
          AND tp.source_satellite_id = p_tournament_id)
     OR EXISTS (
       SELECT 1 FROM public.rake_records r
        WHERE r.tournament_id = v_target_id
          AND r.source = 'fn_award_satellite_seat'
          AND r.metadata->>'satellite_id' = p_tournament_id::text) THEN
    RAISE EXCEPTION 'satellite % has partial or legacy settlement evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_live_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text IN ('playing','winner');
  IF v_live_count > 1 THEN
    RAISE EXCEPTION 'satellite % still has % live players',
      p_tournament_id, v_live_count USING ERRCODE = '55000';
  ELSIF v_live_count = 1 THEN
    SELECT * INTO v_winner FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text IN ('playing','winner');
  ELSE
    SELECT * INTO v_winner FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id = p_observed_winner_id
       AND tp.status::text = 'eliminated'
       AND tp.elimination_sequence IS NOT NULL;
    IF FOUND AND EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.id <> v_winner.id
         AND tp.elimination_sequence = v_winner.elimination_sequence
    ) THEN
      RAISE EXCEPTION
        'satellite % has an ambiguous final elimination witness',
        p_tournament_id USING ERRCODE = '23505';
    END IF;
    IF FOUND AND EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status::text = 'eliminated'
         AND (tp.elimination_sequence IS NULL
           OR tp.elimination_sequence > v_winner.elimination_sequence)
    ) THEN
      v_winner := NULL;
    END IF;
  END IF;
  IF v_winner.id IS NULL
     OR v_winner.user_id IS DISTINCT FROM p_observed_winner_id THEN
    RAISE EXCEPTION
      'observed winner % does not match the locked last survivor in satellite %',
      p_observed_winner_id, p_tournament_id USING ERRCODE = '40001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = 1 AND tp.user_id IS DISTINCT FROM v_winner.user_id
  ) THEN
    RAISE EXCEPTION 'satellite % assigns first place to another player',
      p_tournament_id USING ERRCODE = '23505';
  END IF;

  UPDATE public.tournament_players
     SET status = 'winner', position = 1,
         eliminated_at = NULL, elimination_sequence = NULL
   WHERE id = v_winner.id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not promote exactly one winner',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*), count(tp.elimination_sequence),
         count(DISTINCT tp.elimination_sequence)
    INTO v_eliminated_count, v_sequenced_count, v_distinct_sequence_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'eliminated';
  IF v_eliminated_count <> v_field_size - 1
     OR v_sequenced_count <> v_eliminated_count
     OR v_distinct_sequence_count <> v_eliminated_count THEN
    RAISE EXCEPTION
      'satellite % has no complete durable elimination sequence (%/% of %)',
      p_tournament_id, v_sequenced_count, v_distinct_sequence_count,
      v_eliminated_count USING ERRCODE = 'P0404';
  END IF;

  -- No evidence exists, so numeric positions can be rebuilt from the durable
  -- transition order without relabelling a payment.
  UPDATE public.tournament_players tp
     SET position = NULL
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'eliminated';
  WITH ranked AS (
    SELECT tp.id,
           row_number() OVER (
             ORDER BY tp.elimination_sequence DESC, tp.id ASC
           )::integer + 1 AS final_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text = 'eliminated'
  )
  UPDATE public.tournament_players tp
     SET position = ranked.final_position
    FROM ranked
   WHERE tp.id = ranked.id;

  SELECT count(*), count(DISTINCT tp.position)
    INTO v_rows, v_distinct_sequence_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.position BETWEEN 1 AND v_field_size;
  IF v_rows <> v_field_size OR v_distinct_sequence_count <> v_field_size THEN
    RAISE EXCEPTION 'satellite % could not prove contiguous final standings',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_ticket_award_count := floor(v_pool / v_ticket_cost)::integer;
  v_remainder := round(v_pool - v_ticket_award_count * v_ticket_cost, 2);
  IF v_remainder < 0 OR v_remainder >= v_ticket_cost THEN
    RAISE EXCEPTION 'satellite % derived invalid residual % below ticket %',
      p_tournament_id, v_remainder, v_ticket_cost USING ERRCODE = '23514';
  END IF;
  IF (v_ticket_award_count
      + CASE WHEN v_remainder > 0 THEN 1 ELSE 0 END) > v_field_size THEN
    RAISE EXCEPTION
      'satellite % pool needs % ticket/remainder finishers but field has %',
      p_tournament_id,
      v_ticket_award_count + CASE WHEN v_remainder > 0 THEN 1 ELSE 0 END,
      v_field_size USING ERRCODE = '23514';
  END IF;
  IF v_remainder > 0 THEN
    v_bubble_position := v_ticket_award_count + 1;
    SELECT tp.user_id INTO v_bubble_user_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = v_bubble_position;
    IF NOT FOUND OR v_bubble_user_id IS NULL THEN
      RAISE EXCEPTION 'satellite % has no single bubble at place %',
        p_tournament_id, v_bubble_position USING ERRCODE = 'P0404';
    END IF;
  END IF;

  -- Decide a complete immutable delivery plan while target and roster locks are
  -- held. Only explicit terminal or full states become cash. Any other
  -- unknown lifecycle state refuses the whole settlement.
  IF COALESCE(v_target.max_players, 0) < 0
     OR v_target.late_reg_levels < 0
     OR v_target.rebuy_levels < 0 THEN
    RAISE EXCEPTION
      'satellite % target % has invalid admission bounds',
      p_tournament_id, v_target_id USING ERRCODE = '22003';
  END IF;
  IF v_target.max_players IS NOT NULL AND v_target.max_players > 0
     AND v_target_count >= v_target.max_players THEN
    v_target_open := false;
  ELSIF COALESCE(v_target.prize_pool_finalized, false) THEN
    v_target_open := false;
  ELSIF upper(COALESCE(v_target.status, '')) IN ('ANNOUNCED','REGISTERING') THEN
    v_target_open := true;
  ELSIF upper(COALESCE(v_target.status, '')) = 'RUNNING' THEN
    IF v_target.current_level < 0 THEN
      RAISE EXCEPTION
        'satellite % target % has invalid RUNNING admission level',
        p_tournament_id, v_target_id USING ERRCODE = '55000';
    END IF;
    -- The target row and both rosters are already locked. Delegate the actual
    -- RUNNING admission decision to the same canonical authority used by every
    -- other late-registration path, including its minutes-based fallback.
    v_target_open :=
      public.fn_tournament_late_registration_open(v_target_id);
  ELSIF upper(COALESCE(v_target.status, '')) IN
        ('COMPLETING','COMPLETED','CANCELLED','CANCELED') THEN
    v_target_open := false;
  ELSE
    RAISE EXCEPTION
      'satellite % target % admission state % is ambiguous',
      p_tournament_id, v_target_id, v_target.status
      USING ERRCODE = '55000';
  END IF;
  IF v_target_open THEN
    v_target_slots := CASE
      WHEN v_target.max_players IS NULL OR v_target.max_players = 0
        THEN v_ticket_award_count
      ELSE GREATEST(v_target.max_players - v_target_count, 0)
    END;
  END IF;

  -- The booking and live-seat triggers serialize every four-table decision on
  -- this same user key. Take all winner keys in UUID order before classifying
  -- anyone, so a concurrent seat cannot race a direct-ticket disposition and
  -- two multi-award satellites cannot deadlock by taking the keys oppositely.
  FOR v_cap_user_id IN
    SELECT tp.user_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id
       AND tp.position BETWEEN 1 AND v_ticket_award_count
     ORDER BY tp.user_id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('table_cap:'||v_cap_user_id::text,0));
  END LOOP;

  IF v_ticket_award_count > 0 THEN
    FOR v_place IN 1..v_ticket_award_count LOOP
      SELECT * INTO v_finisher FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id AND tp.position = v_place;
      IF v_finisher.id IS NULL THEN
        RAISE EXCEPTION 'satellite % has no finisher at ticket place %',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      v_delivery_kind := 'cash';
      SELECT * INTO v_existing_target FROM public.tournament_players tp
       WHERE tp.tournament_id = v_target_id
         AND tp.user_id = v_finisher.user_id;
      IF FOUND THEN
        IF COALESCE(v_existing_target.is_satellite_qualifier, false) IS NOT TRUE THEN
          v_delivery_kind := 'cash';
        ELSIF v_existing_target.source_satellite_id IS NULL THEN
          RAISE EXCEPTION
            'satellite % cannot prove origin of target seat held by place %',
            p_tournament_id, v_place USING ERRCODE = 'P0404';
        ELSIF v_existing_target.source_satellite_id = p_tournament_id THEN
          RAISE EXCEPTION
            'satellite % has an unreceipted target seat already delivered to place %',
            p_tournament_id, v_place USING ERRCODE = 'P0404';
        ELSE
          v_delivery_kind := 'cash';
        END IF;
      ELSIF v_target_open AND v_seat_count < v_target_slots THEN
        v_cap_load:=public.fn_concurrent_game_load(
          v_finisher.user_id,NULL,NULL,v_target_id);
        IF v_cap_load>=4 THEN
          -- The cap remains absolute. The winner receives the funded entry as
          -- a noncash tournament ticket instead of a fifth game or wallet chips.
          v_delivery_kind := 'ticket';
        ELSE
          v_delivery_kind := 'seat';
        END IF;
      END IF;

      IF v_delivery_kind = 'seat' THEN
        v_seat_count := v_seat_count + 1;
      ELSIF v_delivery_kind = 'ticket' THEN
        v_entry_ticket_count := v_entry_ticket_count + 1;
      ELSE
        v_cash_ticket_count := v_cash_ticket_count + 1;
      END IF;
      v_plan := v_plan || jsonb_build_array(jsonb_build_object(
        'place', v_place,
        'user_id', v_finisher.user_id,
        'delivery_kind', v_delivery_kind));
    END LOOP;
  END IF;
  IF v_seat_count + v_cash_ticket_count + v_entry_ticket_count
       <> v_ticket_award_count THEN
    RAISE EXCEPTION 'satellite % did not classify every funded ticket',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  -- Closed/full/independently-held tickets are cash substitutions and do not
  -- touch target aggregates. Validate those mutable target banks only when
  -- this exact plan will add at least one real registration.
  IF v_seat_count > 0 THEN
    -- Zero-delta reconstruction is a write when the escrow already exists, so
    -- it belongs after seat classification and only on the actual seat path.
    PERFORM public.fn_ca_escrow_apply(
      v_target_id, 'atomic satellite settlement target seat lock');
    SELECT * INTO v_target_escrow FROM public.tournament_escrow e
     WHERE e.tournament_id = v_target_id
     FOR UPDATE;
  END IF;
  IF v_seat_count > 0 AND (
       v_target.current_players IS NULL
       OR v_target.current_players < 0
       OR v_target.current_players IS DISTINCT FROM v_target_counter_before
       OR v_target.prize_pool IS NULL
       OR v_target.prize_pool::text IN ('NaN','Infinity','-Infinity')
       OR v_target.prize_pool < 0
       OR v_target.prize_pool IS DISTINCT FROM round(v_target.prize_pool, 2)
       OR v_target.total_rake IS NULL
       OR v_target.total_rake::text IN ('NaN','Infinity','-Infinity')
       OR v_target.total_rake < 0
       OR v_target.total_rake IS DISTINCT FROM round(v_target.total_rake, 2)
       OR (v_target_fee > 0 AND v_target.club_id IS NULL)
       OR v_target_escrow.tournament_id IS NULL
       OR v_target_escrow.enforced IS DISTINCT FROM true
       OR v_target_escrow.closed_at IS NOT NULL
       OR v_target_escrow.close_note IS NOT NULL
       OR v_target_escrow.prize_balance IS NULL
       OR v_target_escrow.prize_balance::text IN ('NaN','Infinity','-Infinity')
       OR v_target_escrow.prize_balance < 0
       OR v_target_escrow.prize_balance IS DISTINCT FROM
            round(v_target_escrow.prize_balance, 2)
       OR v_target.prize_pool IS DISTINCT FROM v_target_escrow.prize_balance
       OR v_target_escrow.bounty_balance IS DISTINCT FROM 0::numeric
       OR v_target_escrow.fee_balance IS NULL
       OR v_target_escrow.fee_balance::text IN ('NaN','Infinity','-Infinity')
       OR v_target_escrow.fee_balance < 0
       OR v_target_escrow.fee_balance IS DISTINCT FROM
            round(v_target_escrow.fee_balance, 2)
       OR v_target.total_rake IS DISTINCT FROM v_target_escrow.fee_balance
       OR EXISTS (
         SELECT 1
           FROM unnest(ARRAY[
             'gross_in','fee_entries_in','satellite_fee_in','bounty_in',
             'overlay_in','satellite_in','prize_out','bounty_out','fee_out',
             'refund_prize','refund_bounty','refund_fee',
             'reserve_out','reserve_in'
           ]::text[]) AS component(name)
           CROSS JOIN LATERAL (
             SELECT (to_jsonb(v_target_escrow)->>component.name)::numeric AS amount
           ) AS persisted
          WHERE persisted.amount IS NULL
             OR CASE
                  WHEN persisted.amount::text IN ('NaN','Infinity','-Infinity')
                    THEN true
                  ELSE persisted.amount < 0
                    OR persisted.amount IS DISTINCT FROM round(persisted.amount,2)
                END
       )
     ) THEN
    RAISE EXCEPTION
      'satellite % cannot deliver a target seat against malformed aggregate or escrow state',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  INSERT INTO public.tournament_satellite_settlements
    (tournament_id, target_id, target_was_missing, target_contract_version,
     winner_id, field_size, advertised_seats, pool,
     target_buy_in, target_fee, ticket_cost, ticket_award_count,
     seat_count, cash_ticket_count, entry_ticket_count,
     remainder, bubble_user_id, bubble_position,
     source_table_count, source_table_ids, source_seat_count, source_seat_ids,
     released_seat_count, released_seat_ids, source_closed_at,
     source_escrow_closed_at, source_escrow_close_note, settled_at)
  VALUES
    (p_tournament_id, v_target_id, false, NULL,
     p_observed_winner_id, v_field_size, v_advertised_seats, v_pool,
     v_target_buy_in, v_target_fee, v_ticket_cost, v_ticket_award_count,
     v_seat_count, v_cash_ticket_count, v_entry_ticket_count, v_remainder,
     v_bubble_user_id, v_bubble_position,
     v_source_table_count, v_source_table_ids, v_source_seat_count,
     v_source_seat_ids, v_released_seat_count, v_released_seat_ids,
     v_closeout_at, v_closeout_at, v_source_escrow_close_note, v_closeout_at);

  v_phase_three_claim:=public.fn_claim_tournament_finish(
    p_tournament_id,v_winner.user_id,'atomic_satellite_terminal_receipt');
  IF COALESCE((v_phase_three_claim->>'ok')::boolean,false) IS NOT TRUE
     OR (v_phase_three_claim->>'winner_user_id')::uuid IS DISTINCT FROM v_winner.user_id
     OR v_phase_three_claim->>'finish_kind' IS DISTINCT FROM 'satellite' THEN
    RAISE EXCEPTION 'satellite finish claim disagrees with its immutable header: %',v_phase_three_claim
      USING ERRCODE='P0404';
  END IF;

  UPDATE public.tournaments
     SET status = 'COMPLETING', updated_at = now()
   WHERE id = p_tournament_id
     AND upper(COALESCE(status, '')) IN ('RUNNING','COMPLETING')
     AND COALESCE(prize_pool_finalized, false);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not claim its atomic settlement',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  FOR v_plan_item IN SELECT value FROM jsonb_array_elements(v_plan) LOOP
    v_place := (v_plan_item->>'place')::integer;
    v_delivery_kind := v_plan_item->>'delivery_kind';
    SELECT * INTO v_finisher FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = v_place
       AND tp.user_id = (v_plan_item->>'user_id')::uuid;
    IF v_finisher.id IS NULL THEN
      RAISE EXCEPTION 'satellite % delivery plan lost finisher at place %',
        p_tournament_id, v_place USING ERRCODE = 'P0404';
    END IF;

    IF v_delivery_kind = 'seat' THEN
      INSERT INTO public.tournament_players
        (tournament_id, user_id, username, chips, status,
         is_satellite_qualifier, source_satellite_id)
      VALUES
        (v_target_id, v_finisher.user_id, v_finisher.username, 0, 'registered',
         true, p_tournament_id)
      RETURNING id INTO v_registration_id;
      IF v_registration_id IS NULL THEN
        RAISE EXCEPTION 'satellite % seat % returned no registration receipt',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      v_pool_before := round(v_pool - (v_place - 1) * v_ticket_cost, 2);
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, tournament_id, idempotency_key,
         settlement_id, actor_service, description, metadata,
         pre_from_balance, post_from_balance)
      VALUES
        (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
         'prize_liability', p_tournament_id, 'tournaments.prize_pool',
         'prize_liability', v_target_id, 'tournaments.prize_pool+total_rake',
         v_ticket_cost, 'tournament_buyin', v_target.club_id, p_tournament_id,
         'tourney:' || p_tournament_id::text || ':seat:'
            || v_finisher.user_id::text || ':pool_transfer',
         'satellite:' || p_tournament_id::text,
         'fn_settle_satellite_tournament',
         format('Satellite ticket place %s delivered as target seat (%s)',
                v_place, v_ticket_cost),
         jsonb_build_object(
           'kind', 'satellite_seat_pool_transfer',
           'satellite_id', p_tournament_id,
           'satellite_target_id', v_target_id,
           'user_id', v_finisher.user_id,
           'position', v_place,
           'registration_id', v_registration_id,
           'seat_value', v_ticket_cost,
           'moved', v_ticket_cost,
           'unbacked', 0),
         v_pool_before, round(v_pool_before - v_ticket_cost, 2));

      -- The transfer leg puts the complete ticket into target satellite-in.
      -- A positive fee row reclassifies only that fee from target prize to
      -- target fee escrow. A zero-fee target needs no synthetic rake record.
      IF v_target_fee > 0 THEN
        INSERT INTO public.rake_records
          (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
           bbj_contribution, is_tournament, tournament_id, source, metadata)
        VALUES
          (NULL, NULL, v_target.club_id, v_target_fee, v_ticket_cost, 1,
           0, true, v_target_id, 'fn_award_satellite_seat',
           jsonb_build_object(
             'kind', 'satellite_seat_entry_fee',
             'recorded_by', 'fn_settle_satellite_tournament',
             'user_id', v_finisher.user_id,
             'position', v_place,
             'satellite_id', p_tournament_id,
             'registration_id', v_registration_id));
      END IF;

      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':seat:' || v_finisher.user_id::text;
      INSERT INTO public.tournament_payouts
        (tournament_id, user_id, "position", amount, source, idempotency_key,
         paid_at, tournament_type, field_size, prize_pool, payout_structure,
         recorded_by, metadata)
      VALUES
        (p_tournament_id, v_finisher.user_id, v_place, v_ticket_cost,
         'satellite_seat', v_payout_key, now(), v_source.tournament_type,
         v_field_size, v_pool, NULL, 'fn_settle_satellite_tournament',
         jsonb_build_object(
           'satellite_target_id', v_target_id,
           'target_name', v_target.name,
           'registration_id', v_registration_id,
           'target_buy_in', v_target_buy_in,
           'target_fee', v_target_fee,
           'pool_transfer', v_ticket_cost,
           'unbacked', 0))
      RETURNING id INTO v_payout_id;

      INSERT INTO public.tournament_satellite_awards
        (tournament_id, place, user_id, delivery_kind, amount,
         payout_id, payout_source, idempotency_key, registration_id)
      VALUES
        (p_tournament_id, v_place, v_finisher.user_id, 'seat', v_ticket_cost,
         v_payout_id, 'satellite_seat', v_payout_key, v_registration_id);
    ELSIF v_delivery_kind = 'ticket' THEN
      -- A four-table cap is not an economic failure and cannot turn a funded
      -- satellite award into wallet chips. Resolve the exact target club and
      -- escrow the funded award in a target-scoped, noncash ticket instead.
      v_ticket_club_id := public.fn_tournament_club_for_user(
        v_finisher.user_id, v_target_id,
        COALESCE(v_target.club_id, v_source.club_id));
      -- A UNION TICKET IS ISSUED AT THE CLUB THE WINNER PLAYS FROM
      -- (2026-09-10): a union-hosted target accepts a ticket at any member
      -- club of its union, exactly as redemption already does. Demanding the
      -- house club refused every capped winner of a union satellite.
      IF v_ticket_club_id IS NULL
         OR (v_target.club_id IS NOT NULL
             AND v_ticket_club_id IS DISTINCT FROM v_target.club_id
             AND NOT EXISTS (
               SELECT 1 FROM public.tournaments tt
               JOIN public.union_clubs uc ON uc.union_id = tt.union_id
              WHERE tt.id = v_target_id AND uc.club_id = v_ticket_club_id)) THEN
        RAISE EXCEPTION
          'satellite % ticket place % has no exact target club',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      v_ticket_id := gen_random_uuid();
      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':satellite_ticket:place:' || v_place::text;
      INSERT INTO public.tournament_payouts
        (tournament_id, user_id, "position", amount, source, idempotency_key,
         paid_at, tournament_type, field_size, prize_pool, payout_structure,
         recorded_by, metadata)
      VALUES
        (p_tournament_id, v_finisher.user_id, v_place, v_ticket_cost,
         'satellite_ticket', v_payout_key, now(), v_source.tournament_type,
         v_field_size, v_pool, NULL, 'fn_settle_satellite_tournament',
         jsonb_build_object(
           'delivery_kind', 'ticket',
           'ticket_id', v_ticket_id,
           'satellite_target_id', v_target_id,
           'target_name', v_target.name,
           'target_buy_in', v_target_buy_in,
           'target_fee', v_target_fee,
           'wallet_chips_credited', 0,
           'unbacked', 0))
      RETURNING id INTO v_payout_id;

      INSERT INTO public.tournament_tickets
        (id, club_id, issued_by, holder_id, value, status, note,
         redemption_mode, source_tournament_id, source_satellite_id,
         source_refund_entitlement_id, source_satellite_award_place,
         entry_prize, entry_bounty, entry_fee, created_at)
      VALUES
        (v_ticket_id, v_ticket_club_id,
         '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid,
         v_finisher.user_id, v_ticket_cost, 'issued',
         'Four-Table Cap Satellite Award: Tournament Entry Only',
         'tournament_entry_only', v_target_id, p_tournament_id,
         NULL, v_place, v_target_buy_in, 0, v_target_fee,
         transaction_timestamp());

      v_pool_before := round(v_pool - (v_place - 1) * v_ticket_cost, 2);
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, tournament_id, idempotency_key,
         settlement_id, actor_service, description, metadata,
         pre_from_balance, post_from_balance,
         pre_to_balance, post_to_balance)
      VALUES
        (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
         'prize_liability', p_tournament_id, 'tournaments.prize_pool',
         'escrow', v_ticket_id, 'satellite tournament entry ticket',
         v_ticket_cost, 'ticket_issue', v_ticket_club_id, p_tournament_id,
         v_payout_key || ':ticket_escrow',
         'satellite-ticket:' || v_ticket_id::text,
         'fn_settle_satellite_tournament',
         format('Satellite ticket place %s held as noncash target entry (%s)',
                v_place, v_ticket_cost),
         jsonb_build_object(
           'kind', 'direct_satellite_entry_ticket',
           'delivery_kind', 'ticket',
           'ticket_id', v_ticket_id,
           'payout_id', v_payout_id,
           'satellite_id', p_tournament_id,
           'satellite_target_id', v_target_id,
           'user_id', v_finisher.user_id,
           'position', v_place,
           'entry_prize', v_target_buy_in,
           'entry_bounty', 0,
           'entry_fee', v_target_fee,
           'wallet_chips_credited', 0,
           'unbacked', 0),
         v_pool_before, round(v_pool_before - v_ticket_cost, 2),
         0, v_ticket_cost)
      RETURNING id INTO v_ticket_ledger_id;

      INSERT INTO public.chip_transactions
        (club_id, from_user_id, to_user_id, amount, transaction_type,
         notes, balance_after, metadata)
      VALUES
        (v_ticket_club_id, NULL, v_finisher.user_id, v_ticket_cost,
         'tournament_ticket_issue',
         'Satellite Award Held As Tournament-Entry Ticket', NULL,
         jsonb_build_object(
           'ticket_id', v_ticket_id,
           'escrow_entity_id', v_ticket_id,
           'holder_id', v_finisher.user_id,
           'value', v_ticket_cost,
           'redemption_mode', 'tournament_entry_only',
           'source_tournament_id', v_target_id,
           'source_satellite_id', p_tournament_id,
           'source_award_place', v_place,
           'payout_id', v_payout_id,
           'ledger_id', v_ticket_ledger_id,
           'idempotency_key', v_payout_key,
           'wallet_chips_credited', 0))
      RETURNING id INTO v_ticket_transaction_id;

      PERFORM public.fn_ca_escrow_apply(
        p_tournament_id, 'direct satellite entry ticket out',
        p_prize_out => v_ticket_cost);

      INSERT INTO public.tournament_satellite_awards
        (tournament_id, place, user_id, delivery_kind, amount,
         payout_id, payout_source, idempotency_key, ticket_id)
      VALUES
        (p_tournament_id, v_place, v_finisher.user_id, 'ticket',
         v_ticket_cost, v_payout_id, 'satellite_ticket', v_payout_key,
         v_ticket_id);
    ELSIF v_delivery_kind = 'cash' THEN
      INSERT INTO public.tournament_obligations
        (tournament_id, kind, place, user_id, amount_owed, amount_paid,
         source, settled_at)
      VALUES
        (p_tournament_id, 'seat', v_place, v_finisher.user_id,
         v_ticket_cost, 0, 'engine.fn_settle_satellite_tournament', NULL)
      RETURNING * INTO v_obligation;

      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':satellite_ticket:place:' || v_place::text;
      v_credited := public.fn_credit_and_log(
        p_user_id => v_finisher.user_id,
        p_amount => v_ticket_cost,
        p_idempotency_key => v_payout_key,
        p_category => 'prize',
        p_description => 'Satellite ticket paid in cash because target admission was definitively unavailable',
        p_related_entity_id => p_tournament_id,
        p_wallet_type => 'PLAYER',
        p_table_id => NULL,
        p_hand_id => NULL,
        p_payout_position => v_place,
        p_payout_source => 'satellite_ticket');
      IF v_credited IS NOT TRUE THEN
        RAISE EXCEPTION 'satellite % cash ticket % was not a new exact credit',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      UPDATE public.tournament_obligations o
         SET amount_paid = v_ticket_cost, settled_at = now(), updated_at = now()
       WHERE o.id = v_obligation.id
         AND o.amount_owed = v_ticket_cost AND o.amount_paid = 0;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'satellite % could not close cash ticket debt %',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      SELECT p.id INTO v_payout_id FROM public.tournament_payouts p
       WHERE p.idempotency_key = v_payout_key
         AND p.tournament_id = p_tournament_id
         AND p.user_id = v_finisher.user_id
         AND p."position" = v_place
         AND p.amount = v_ticket_cost
         AND p.source = 'satellite_ticket';
      IF v_payout_id IS NULL THEN
        RAISE EXCEPTION 'satellite % cash ticket % has no payout row',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      INSERT INTO public.tournament_satellite_awards
        (tournament_id, place, user_id, delivery_kind, amount,
         payout_id, payout_source, idempotency_key,
         obligation_id, obligation_kind)
      VALUES
        (p_tournament_id, v_place, v_finisher.user_id, 'cash', v_ticket_cost,
         v_payout_id, 'satellite_ticket', v_payout_key,
         v_obligation.id, 'seat');
    ELSE
      RAISE EXCEPTION 'satellite % has unknown delivery kind % at place %',
        p_tournament_id, v_delivery_kind, v_place USING ERRCODE = 'P0404';
    END IF;
  END LOOP;

  IF v_seat_count > 0 THEN
    SELECT count(*),
           count(*) FILTER (
             WHERE tp.status::text IN ('registered','playing'))
      INTO v_target_count, v_target_live_count
      FROM public.tournament_players tp
     WHERE tp.tournament_id = v_target_id;
    v_target_counter_after := CASE
      WHEN upper(COALESCE(v_target.status, '')) IN ('ANNOUNCED','REGISTERING')
        THEN v_target_live_count
      ELSE v_target_count
    END;
    IF v_target_count IS DISTINCT FROM v_target_count_before + v_seat_count
       OR v_target_live_count IS DISTINCT FROM
            v_target_live_count_before + v_seat_count
       OR v_target_counter_after IS DISTINCT FROM
            v_target_counter_before + v_seat_count THEN
      RAISE EXCEPTION
        'satellite % target roster changed outside its locked delivery plan',
        p_tournament_id USING ERRCODE = '40001';
    END IF;
    UPDATE public.tournaments
       SET current_players = v_target.current_players + v_seat_count,
           prize_pool = round(COALESCE(prize_pool, 0)
                              + v_seat_count * v_target_buy_in, 2),
           total_rake = round(COALESCE(total_rake, 0)
                             + v_seat_count * v_target_fee, 2),
           updated_at = now()
     WHERE id = v_target_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite % could not update target aggregate receipt',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    SELECT t.id, t.current_players, t.prize_pool, t.total_rake
      INTO v_target_after
      FROM public.tournaments t
     WHERE t.id = v_target_id;
    SELECT * INTO v_target_escrow_after
      FROM public.tournament_escrow e
     WHERE e.tournament_id = v_target_id
     FOR UPDATE;
    IF v_target_after.id IS NULL
       OR v_target_after.current_players IS DISTINCT FROM
            v_target.current_players + v_seat_count
       OR v_target_after.current_players IS DISTINCT FROM v_target_counter_after
       OR v_target_after.prize_pool IS DISTINCT FROM
            round(v_target.prize_pool + v_seat_count * v_target_buy_in, 2)
       OR v_target_after.total_rake IS DISTINCT FROM
            round(v_target.total_rake + v_seat_count * v_target_fee, 2)
       OR v_target_escrow_after.tournament_id IS DISTINCT FROM v_target_id
       OR v_target_escrow_after.enforced IS DISTINCT FROM v_target_escrow.enforced
       OR v_target_escrow_after.gross_in IS DISTINCT FROM v_target_escrow.gross_in
       OR v_target_escrow_after.fee_entries_in IS DISTINCT FROM v_target_escrow.fee_entries_in
       OR v_target_escrow_after.satellite_fee_in IS DISTINCT FROM
            round(v_target_escrow.satellite_fee_in
                  + v_seat_count * v_target_fee, 2)
       OR v_target_escrow_after.bounty_in IS DISTINCT FROM v_target_escrow.bounty_in
       OR v_target_escrow_after.overlay_in IS DISTINCT FROM v_target_escrow.overlay_in
       OR v_target_escrow_after.satellite_in IS DISTINCT FROM
            round(v_target_escrow.satellite_in
                  + v_seat_count * v_target_buy_in, 2)
       OR v_target_escrow_after.prize_out IS DISTINCT FROM v_target_escrow.prize_out
       OR v_target_escrow_after.bounty_out IS DISTINCT FROM v_target_escrow.bounty_out
       OR v_target_escrow_after.fee_out IS DISTINCT FROM v_target_escrow.fee_out
       OR v_target_escrow_after.refund_prize IS DISTINCT FROM v_target_escrow.refund_prize
       OR v_target_escrow_after.refund_bounty IS DISTINCT FROM v_target_escrow.refund_bounty
       OR v_target_escrow_after.refund_fee IS DISTINCT FROM v_target_escrow.refund_fee
       OR v_target_escrow_after.reserve_out IS DISTINCT FROM v_target_escrow.reserve_out
       OR v_target_escrow_after.reserve_in IS DISTINCT FROM v_target_escrow.reserve_in
       OR v_target_escrow_after.prize_balance IS DISTINCT FROM
            round(v_target_escrow.prize_balance
                  + v_seat_count * v_target_buy_in, 2)
       OR v_target_escrow_after.bounty_balance IS DISTINCT FROM v_target_escrow.bounty_balance
       OR v_target_escrow_after.fee_balance IS DISTINCT FROM
            round(v_target_escrow.fee_balance
                  + v_seat_count * v_target_fee, 2)
       OR v_target_escrow_after.opened_at IS DISTINCT FROM v_target_escrow.opened_at
       OR v_target_escrow_after.opened_from IS DISTINCT FROM v_target_escrow.opened_from
       OR v_target_escrow_after.closed_at IS DISTINCT FROM v_target_escrow.closed_at
       OR v_target_escrow_after.close_note IS DISTINCT FROM v_target_escrow.close_note THEN
      RAISE EXCEPTION
        'satellite % target aggregate or escrow delta is not the exact delivered seat value',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;

  IF v_remainder > 0 THEN
    INSERT INTO public.tournament_obligations
      (tournament_id, kind, place, user_id, amount_owed, amount_paid,
       source, settled_at)
    VALUES
      (p_tournament_id, 'satellite_remainder', v_bubble_position,
       v_bubble_user_id, v_remainder, 0,
       'engine.fn_settle_satellite_tournament', NULL)
    RETURNING * INTO v_obligation;

    v_payout_key := 'tourney:' || p_tournament_id::text
                    || ':satellite_remainder:place:'
                    || v_bubble_position::text;
    v_credited := public.fn_credit_and_log(
      p_user_id => v_bubble_user_id,
      p_amount => v_remainder,
      p_idempotency_key => v_payout_key,
      p_category => 'prize',
      p_description => 'Satellite pool remainder paid to the single bubble',
      p_related_entity_id => p_tournament_id,
      p_wallet_type => 'PLAYER',
      p_table_id => NULL,
      p_hand_id => NULL,
      p_payout_position => v_bubble_position,
      p_payout_source => 'satellite_remainder');
    IF v_credited IS NOT TRUE THEN
      RAISE EXCEPTION 'satellite % remainder credit was not a new exact credit',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    UPDATE public.tournament_obligations
       SET amount_paid = v_remainder, settled_at = now(), updated_at = now()
     WHERE id = v_obligation.id
       AND tournament_id = p_tournament_id
       AND kind = 'satellite_remainder' AND place = v_bubble_position
       AND user_id = v_bubble_user_id
       AND amount_owed = v_remainder
       AND amount_paid = 0;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite % could not close one exact remainder debt',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    SELECT p.id INTO v_payout_id
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.user_id = v_bubble_user_id
       AND p."position" = v_bubble_position
       AND p.amount = v_remainder
       AND p.source = 'satellite_remainder'
       AND p.idempotency_key = v_payout_key;
    IF v_payout_id IS NULL THEN
      RAISE EXCEPTION 'satellite % remainder has no exact payout row',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    INSERT INTO public.tournament_satellite_remainders
      (tournament_id, user_id, place, amount,
       payout_id, payout_source, payout_position, idempotency_key,
       obligation_id, obligation_kind, obligation_place, evidence_kind)
    VALUES
      (p_tournament_id, v_bubble_user_id, v_bubble_position, v_remainder,
       v_payout_id, 'satellite_remainder', v_bubble_position, v_payout_key,
       v_obligation.id, 'satellite_remainder', v_bubble_position, 'atomic');
  END IF;

  UPDATE public.tournament_players SET prize = 0
   WHERE tournament_id = p_tournament_id;
  UPDATE public.tournament_players SET prize = v_ticket_cost
   WHERE tournament_id = p_tournament_id
     AND position BETWEEN 1 AND v_ticket_award_count;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> v_ticket_award_count THEN
    RAISE EXCEPTION 'satellite % stamped % ticket caches, expected %',
      p_tournament_id, v_rows, v_ticket_award_count USING ERRCODE = 'P0404';
  END IF;
  IF v_remainder > 0 THEN
    UPDATE public.tournament_players SET prize = v_remainder
     WHERE tournament_id = p_tournament_id
       AND user_id = v_bubble_user_id AND position = v_bubble_position;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite % could not stamp the single bubble cache',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;

  SELECT count(*), round(COALESCE(sum(p.amount), 0), 2)
    INTO v_payout_count, v_paid
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id;
  IF v_payout_count <> (v_ticket_award_count
                        + CASE WHEN v_remainder > 0 THEN 1 ELSE 0 END)
     OR v_paid IS DISTINCT FROM v_pool THEN
    RAISE EXCEPTION 'satellite % paid % of locked pool % across % rows',
      p_tournament_id, v_paid, v_pool, v_payout_count
      USING ERRCODE = 'P0404';
  END IF;

  v_rake_result := public.fn_settle_tournament_rake(
    p_tournament_id, 'engine.fn_settle_satellite_tournament');
  IF COALESCE((v_rake_result->>'ok')::boolean, false) IS NOT TRUE
     OR (COALESCE((v_rake_result->>'amount')::numeric, 0) > 0
         AND COALESCE((v_rake_result->>'attributed')::boolean, false) IS NOT TRUE) THEN
    RAISE EXCEPTION 'satellite % rake did not settle and attribute exactly: %',
      p_tournament_id, v_rake_result USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_source_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_source_escrow.prize_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_balance IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION
      'satellite % settlement leaves escrow prize %, bounty %, fee %',
      p_tournament_id, v_source_escrow.prize_balance,
      v_source_escrow.bounty_balance, v_source_escrow.fee_balance
      USING ERRCODE = 'P0404';
  END IF;

  -- The atomic authority, not the legacy lifecycle observer, owns the escrow
  -- close. Stamp the exact zero proof before publishing COMPLETED so the
  -- receipt remains valid after that observer is retired by the terminal
  -- cutover migration.
  UPDATE public.tournament_escrow
     SET closed_at = v_closeout_at,
         close_note = v_source_escrow_close_note,
         updated_at = now()
   WHERE tournament_id = p_tournament_id
     AND closed_at IS NULL
     AND close_note IS NULL
     AND prize_balance = 0
     AND bounty_balance = 0
     AND fee_balance = 0;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not commit its exact escrow close',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  -- Source felt closure is part of the money commit. This runs after tickets,
  -- the single Bubble remainder, rake and escrow so any table/seat refusal
  -- rolls all of those effects back. The pre-payer identity arrays prevent a
  -- concurrent table or seat from appearing outside the receipt.
  UPDATE public.table_seats ts
     SET left_at = v_closeout_at,
         status = 'left',
         leave_pending = false,
         is_sitting_out = false,
         is_away = false,
         sit_out_at = NULL,
         scheduled_leave_hands = NULL
   WHERE ts.id = ANY(v_released_seat_ids)
     AND ts.left_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows IS DISTINCT FROM v_released_seat_count THEN
    RAISE EXCEPTION 'satellite % released % source seats, expected %',
      p_tournament_id, v_rows, v_released_seat_count USING ERRCODE = '40001';
  END IF;

  -- Elimination already gave predeparted seats a durable departure time. Close
  -- only their mutable occupancy flags here; never rewrite that historical time
  -- or fire left_at-specific effects a second time.
  UPDATE public.table_seats ts
     SET status = 'left', leave_pending = false, is_sitting_out = false,
         is_away = false, sit_out_at = NULL, scheduled_leave_hands = NULL
   WHERE ts.id = ANY(v_source_seat_ids)
     AND ts.left_at IS NOT NULL
     AND (ts.status IS DISTINCT FROM 'left'
       OR ts.leave_pending IS DISTINCT FROM false
       OR ts.is_sitting_out IS DISTINCT FROM false
       OR ts.is_away IS DISTINCT FROM false
       OR ts.sit_out_at IS NOT NULL
       OR ts.scheduled_leave_hands IS NOT NULL);

  -- Mark the game terminal only after its seats are released, but before its
  -- tables close. The existing table-status trigger treats a close under a
  -- COMPLETING tournament as an accidental live-game close and files an
  -- incident. COMPLETED is therefore the canonical parent-before-child order.
  -- A later table-close refusal still rolls this status and all money back.
  UPDATE public.tournaments
     SET status = 'COMPLETED', ended_at = now(), prize_pool_finalized = true,
         current_players = 0, on_break = false,
         break_started_at = NULL, break_ends_at = NULL, updated_at = now()
   WHERE id = p_tournament_id AND upper(COALESCE(status, '')) = 'COMPLETING';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not commit COMPLETING to COMPLETED',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  UPDATE public.tables tb
     SET status = 'closed',
         lifecycle = 'closed',
         current_players = 0,
         terminal_closed_at = v_closeout_at,
         updated_at = now()
   WHERE tb.id = ANY(v_source_table_ids)
     AND tb.tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows IS DISTINCT FROM v_source_table_count
     OR EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.tournament_id = p_tournament_id
          AND (lower(COALESCE(tb.status::text, '')) <> 'closed'
            OR lower(COALESCE(tb.lifecycle, '')) <> 'closed'
            OR tb.current_players IS DISTINCT FROM 0)
     ) OR EXISTS (
       SELECT 1
        FROM public.table_seats ts
         JOIN public.tables tb ON tb.id = ts.table_id
        WHERE tb.tournament_id = p_tournament_id
          AND (ts.left_at IS NULL
            OR ts.status IS DISTINCT FROM 'left'
            OR ts.leave_pending IS DISTINCT FROM false
            OR ts.is_sitting_out IS DISTINCT FROM false
            OR ts.is_away IS DISTINCT FROM false
            OR ts.sit_out_at IS NOT NULL
            OR ts.scheduled_leave_hands IS NOT NULL)
     ) THEN
    RAISE EXCEPTION
      'satellite % did not durably release every source seat and close every source table',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  v_phase_three_receipt:=public.fn_ca_satellite_settlement_receipt(
    p_tournament_id, p_observed_winner_id);
  PERFORM public.fn_ca_close_satellite_terminal_scope(p_tournament_id,v_phase_three_scope);
  RETURN v_phase_three_receipt;
END;
$patch_body_core$);
 END IF;
 SELECT prosrc,to_jsonb(p)-'prosrc' INTO v_body,v_after FROM pg_proc p WHERE oid=v_oid;
 IF md5(v_body)<>'0e2066fafe3c4e1fceb96db9937b3140' OR v_before IS DISTINCT FROM v_after THEN
  RAISE EXCEPTION 'current satellite core source or metadata postcondition differs'; END IF;
END $patch_core$;

DO $patch_readiness$
DECLARE v_oid oid:='public.fn_tournament_finish_readiness(uuid,uuid)'::regprocedure; v_body text;v_definition text;v_before jsonb;v_after jsonb;
BEGIN
 SELECT prosrc,pg_get_functiondef(oid),to_jsonb(p)-'prosrc'
 INTO v_body,v_definition,v_before FROM pg_proc p WHERE oid=v_oid;
 IF v_oid IS NULL OR md5(v_body) NOT IN ('993e6e1de9edba2fe235d86ff6c243c9','0388659818612493c16b02048dae5b3f')
    OR (v_before->>'proowner')::oid<>'postgres'::regrole::oid
    OR (v_before->>'prosecdef')::boolean IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'current satellite readiness source or owner differs'; END IF;
 IF md5(v_body)='993e6e1de9edba2fe235d86ff6c243c9' THEN
  EXECUTE replace(v_definition,v_body,$patch_body_readiness$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_finish public.tournament_finish_receipts%ROWTYPE;
  v_kind text;
  v_failures jsonb := '[]'::jsonb;
  v_winner_count integer := 0;
  v_position_one_count integer := 0;
  v_canonical_winner uuid;
  v_position_one_winner uuid;
  v_open_players integer := 0;
  v_unranked integer := 0;
  v_duplicate_positions integer := 0;
  v_unsettled_obligations integer := 0;
  v_bad_place_evidence integer := 0;
  v_bad_player_prizes integer := 0;
  v_place_owed numeric := 0;
  v_escrow public.tournament_escrow%ROWTYPE;
  v_escrow_found boolean := false;
  v_rake_expected numeric := 0;
  v_rake_recorded numeric;
  v_rake_destination text;
  v_rake_settled_at timestamptz;
  v_rake_attributed_at timestamptz;
  v_rake_found boolean := false;
  v_bounty public.tournament_bounty_completion_receipts%ROWTYPE;
  v_place_batch public.tournament_place_settlement_batches%ROWTYPE;
  v_deal public.tournament_final_table_deal_batches%ROWTYPE;
  v_satellite public.tournament_satellite_settlement_batches%ROWTYPE;
  v_domain_check jsonb;
  v_modern_place boolean := false;
  v_modern_deal boolean := false;
  v_bad_satellite_seats integer := 0;
  v_bad_satellite_outcomes integer := 0;
  v_satellite_award_gaps integer := 0;
BEGIN
  SELECT * INTO v_t FROM public.tournaments WHERE id = p_tournament_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found',
      'failures',jsonb_build_array(jsonb_build_object('code','tournament_not_found')));
  END IF;
  v_kind := public.fn_tournament_finish_kind(p_tournament_id);
  IF v_kind='satellite' AND EXISTS(SELECT 1 FROM public.tournament_satellite_settlements h
       WHERE h.tournament_id=p_tournament_id) THEN
    -- Exact M2 receipt, including every source/recipient money proof. The
    -- in-flight variant is possible only inside the owner-only transaction
    -- capability; deferred certification still requires actual table closure.
    RETURN public.fn_ca_verify_current_satellite_terminal(
      p_tournament_id,p_winner_user_id,v_t.status='COMPLETING');
  END IF;
  IF v_kind='normal' THEN
    SELECT COALESCE((to_jsonb(b)->>'contract_version')::integer,1)=2
      INTO v_modern_place FROM public.tournament_place_settlement_batches b
     WHERE b.tournament_id=p_tournament_id;
  ELSIF v_kind='final_table_deal' THEN
    SELECT COALESCE((to_jsonb(b)->>'contract_version')::integer,1)=2
      INTO v_modern_deal FROM public.tournament_final_table_deal_batches b
     WHERE b.tournament_id=p_tournament_id;
  END IF;
  v_modern_place:=COALESCE(v_modern_place,false);
  v_modern_deal:=COALESCE(v_modern_deal,false);


  SELECT * INTO v_finish FROM public.tournament_finish_receipts
   WHERE tournament_id = p_tournament_id;
  IF NOT FOUND THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','finish_claim_missing'));
  ELSIF v_finish.winner_user_id IS DISTINCT FROM p_winner_user_id
     OR v_finish.finish_kind IS DISTINCT FROM v_kind THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','finish_claim_conflict','claimed_winner',v_finish.winner_user_id,
      'claimed_kind',v_finish.finish_kind,'observed_kind',v_kind));
  END IF;

  SELECT count(*), (array_agg(tp.user_id ORDER BY tp.user_id))[1]
    INTO v_winner_count, v_canonical_winner
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status = 'winner' AND tp.position = 1;
  SELECT count(*), (array_agg(tp.user_id ORDER BY tp.user_id))[1]
    INTO v_position_one_count, v_position_one_winner
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id AND tp.position = 1;
  IF v_winner_count <> 1 OR v_position_one_count <> 1
     OR v_canonical_winner IS DISTINCT FROM p_winner_user_id
     OR v_position_one_winner IS DISTINCT FROM p_winner_user_id THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','canonical_winner_not_proven','winner_rows',v_winner_count,
      'position_one_rows',v_position_one_count,'observed_winner',v_canonical_winner,
      'requested_winner',p_winner_user_id));
  END IF;

  SELECT count(*) FILTER (WHERE tp.status IN ('registered','playing')),
         count(*) FILTER (WHERE tp.position IS NULL)
    INTO v_open_players, v_unranked
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  SELECT count(*) INTO v_duplicate_positions
    FROM (
      SELECT tp.position FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id AND tp.position IS NOT NULL
       GROUP BY tp.position HAVING count(*) <> 1
    ) duplicates;
  IF v_open_players <> 0 OR v_unranked <> 0 OR v_duplicate_positions <> 0 THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','standings_not_terminal','open_players',v_open_players,
      'unranked_players',v_unranked,'duplicate_positions',v_duplicate_positions));
  END IF;
  IF COALESCE(v_t.on_break,false) THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','terminal_break_flag_set'));
  END IF;

  SELECT count(*) INTO v_unsettled_obligations
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND abs(round(COALESCE(o.amount_paid,0),2)
           - round(COALESCE(o.amount_owed,0),2)) > 0.005;
  IF v_unsettled_obligations <> 0 THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','unsettled_obligations','count',v_unsettled_obligations));
  END IF;

  -- Satellite prize history is one combined entitlement row (ticket value plus
  -- an optional cash remainder). Its format checker proves both constituent
  -- receipts exactly; comparing that cache to either receipt alone would
  -- falsely reject a short-field last-seat winner. The generic relation stays
  -- an independent certificate for every other format.
  IF v_kind <> 'satellite' AND NOT v_modern_place AND NOT v_modern_deal THEN
    SELECT count(*) INTO v_bad_place_evidence
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
       AND o.amount_owed > 0
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_players tp
          WHERE tp.tournament_id = o.tournament_id
            AND tp.position = o.place AND tp.user_id = o.user_id
            AND abs(round(COALESCE(tp.prize,0),2) - round(o.amount_owed,2)) <= 0.005
       );
    SELECT count(*) INTO v_bad_player_prizes
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id AND round(COALESCE(tp.prize,0),2) > 0
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_obligations o
          WHERE o.tournament_id = tp.tournament_id AND o.kind = 'place'
            AND o.place = tp.position AND o.user_id = tp.user_id
            AND abs(round(o.amount_paid,2) - round(COALESCE(tp.prize,0),2)) <= 0.005
            AND abs(round(o.amount_owed,2) - round(o.amount_paid,2)) <= 0.005
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_obligations o
          WHERE o.tournament_id = tp.tournament_id AND o.kind = 'final_table_deal'
            AND o.user_id = tp.user_id
            AND abs(round(o.amount_paid,2) - round(COALESCE(tp.prize,0),2)) <= 0.005
            AND abs(round(o.amount_owed,2) - round(o.amount_paid,2)) <= 0.005
       );
  END IF;
  IF v_bad_place_evidence <> 0 OR v_bad_player_prizes <> 0 THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','prize_evidence_mismatch','place_obligations',v_bad_place_evidence,
      'player_prizes',v_bad_player_prizes));
  END IF;

  IF v_kind = 'normal' THEN
    SELECT * INTO v_place_batch
      FROM public.tournament_place_settlement_batches b
     WHERE b.tournament_id = p_tournament_id;
    IF NOT FOUND OR v_place_batch.settled_at IS NULL THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','atomic_place_batch_not_settled'));
    END IF;

    IF v_modern_place THEN
      BEGIN
        v_domain_check:=public.fn_ca_verify_terminal_place_batch(p_tournament_id,true);
        IF COALESCE((v_domain_check->>'ok')::boolean,false) IS NOT TRUE THEN
          RAISE EXCEPTION 'canonical place proof refused';
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_failures:=v_failures||jsonb_build_array(jsonb_build_object(
          'code','canonical_place_batch_not_proven','detail',SQLERRM));
      END;
    END IF;

    SELECT round(COALESCE(sum(o.amount_owed),0),2) INTO v_place_owed
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place';
    IF NOT v_modern_place AND abs(v_place_owed - round(COALESCE(v_t.prize_pool,0),2)) > 0.005 THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','prize_pool_not_fully_obligated','prize_pool',v_t.prize_pool,
        'place_obligations',v_place_owed));
    END IF;
    IF round(COALESCE(v_t.guaranteed_prize,0),2)
         > round(COALESCE(v_t.prize_pool,0),2) + 0.005 THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','guarantee_not_funded','guarantee',v_t.guaranteed_prize,
        'prize_pool',v_t.prize_pool));
    END IF;
  END IF;

  SELECT * INTO v_escrow FROM public.tournament_escrow
   WHERE tournament_id = p_tournament_id;
  v_escrow_found := FOUND;
  IF NOT v_escrow_found THEN
    IF COALESCE(v_t.prize_pool,0) <> 0 OR COALESCE(v_t.bounty_pool,0) <> 0
       OR COALESCE(v_t.total_rake,0) <> 0
       OR EXISTS (SELECT 1 FROM public.tournament_payouts po
                   WHERE po.tournament_id = p_tournament_id) THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','escrow_evidence_missing'));
    END IF;
  ELSIF abs(round(v_escrow.prize_balance,2)) > 0.005
     OR abs(round(v_escrow.bounty_balance,2)) > 0.005
     OR abs(round(v_escrow.fee_balance,2)) > 0.005 THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','escrow_not_zero','prize_balance',v_escrow.prize_balance,
      'bounty_balance',v_escrow.bounty_balance,'fee_balance',v_escrow.fee_balance));
  END IF;

  SELECT GREATEST(round(COALESCE(sum(rr.rake_amount),0),2),0) INTO v_rake_expected
    FROM public.rake_records rr
   WHERE rr.tournament_id = p_tournament_id AND rr.is_tournament;
  SELECT amount,destination,settled_at,attributed_at
    INTO v_rake_recorded,v_rake_destination,v_rake_settled_at,v_rake_attributed_at
    FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id = p_tournament_id;
  v_rake_found := FOUND;
  IF NOT v_rake_found OR v_rake_settled_at IS NULL
     OR v_rake_attributed_at IS NULL OR v_rake_destination = 'pending'
     OR abs(round(COALESCE(v_rake_recorded,0),2) - v_rake_expected) > 0.005 THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','rake_not_settled','expected',v_rake_expected,
      'recorded',CASE WHEN v_rake_found THEN v_rake_recorded ELSE NULL END,
      'destination',CASE WHEN v_rake_found THEN v_rake_destination ELSE NULL END,
      'attributed_at',CASE WHEN v_rake_found THEN v_rake_attributed_at ELSE NULL END));
  END IF;

  IF COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
     OR COALESCE(v_t.is_mystery_bounty,false) THEN
    IF public.fn_tournament_has_unsettled_bounties(p_tournament_id) THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','pending_bounty_obligations'));
    END IF;
    SELECT * INTO v_bounty FROM public.tournament_bounty_completion_receipts
     WHERE tournament_id = p_tournament_id;
    IF NOT FOUND OR v_bounty.winner_user_id IS DISTINCT FROM p_winner_user_id
       OR v_bounty.pool_finalized_at IS NULL
       OR COALESCE((v_bounty.pool_result->>'ok')::boolean,false) IS NOT TRUE THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','bounty_pool_not_certified'));
    END IF;
    IF COALESCE(v_t.is_mystery_bounty,false)
       AND COALESCE(v_t.mystery_bounty_stage,'pending') <> 'pending'
       AND (v_bounty.mystery_settled_at IS NULL
            OR COALESCE((v_bounty.mystery_result->>'ok')::boolean,false) IS NOT TRUE
            OR COALESCE((v_bounty.mystery_result->>'balanced')::boolean,false) IS NOT TRUE) THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','mystery_bounty_not_certified'));
    END IF;
  END IF;

  IF v_kind = 'final_table_deal' THEN
    SELECT * INTO v_deal FROM public.tournament_final_table_deal_batches
     WHERE tournament_id = p_tournament_id;
    IF NOT FOUND OR v_deal.chip_leader IS DISTINCT FROM p_winner_user_id
       OR v_deal.settled_at IS NULL OR v_deal.escrow_prize_after IS NULL THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','atomic_final_table_deal_batch_not_settled'));
    ELSE
      IF v_modern_deal THEN
        BEGIN
          v_domain_check:=public.fn_ca_verify_terminal_final_deal_batch(p_tournament_id,true);
        EXCEPTION WHEN OTHERS THEN
          v_domain_check:=jsonb_build_object('ok',false,'reason',SQLERRM);
        END;
      ELSE
        v_domain_check := public.fn_check_atomic_final_table_deal(p_tournament_id);
      END IF;
      IF COALESCE((v_domain_check->>'ok')::boolean,false) IS NOT TRUE THEN
        v_failures := v_failures || jsonb_build_array(jsonb_build_object(
          'code','atomic_final_table_deal_not_proven','detail',v_domain_check));
      END IF;
    END IF;
  END IF;

  IF v_kind = 'satellite' THEN
    SELECT * INTO v_satellite
      FROM public.tournament_satellite_settlement_batches b
     WHERE b.tournament_id = p_tournament_id;
    IF NOT FOUND OR v_satellite.winner_user_id IS DISTINCT FROM p_winner_user_id
       OR v_satellite.settled_at IS NULL THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','atomic_satellite_batch_not_settled'));
    ELSE
      v_domain_check := public.fn_check_atomic_satellite_finish(p_tournament_id);
      IF COALESCE((v_domain_check->>'ok')::boolean,false) IS NOT TRUE THEN
        v_failures := v_failures || jsonb_build_array(jsonb_build_object(
          'code','atomic_satellite_finish_not_proven','detail',v_domain_check));
      END IF;
    END IF;

    SELECT count(*) INTO v_bad_satellite_seats
      FROM public.tournament_players target_seat
     WHERE target_seat.source_satellite_id = p_tournament_id
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_payouts po
          WHERE po.tournament_id = p_tournament_id
            AND po.source = 'satellite_seat'
            AND po.user_id = target_seat.user_id
            AND po.metadata->>'registration_id' = target_seat.id::text
       );
    IF v_bad_satellite_seats <> 0 THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','satellite_seat_evidence_missing','count',v_bad_satellite_seats));
    END IF;

    -- Every in-kind payout names the original finisher/place and the exact
    -- target registration it funded. A payout row by itself is not a seat,
    -- and a target seat by itself is not a durable payout record.
    SELECT count(*) INTO v_bad_satellite_outcomes
      FROM public.tournament_payouts po
     WHERE po.tournament_id = p_tournament_id AND po.source = 'satellite_seat'
       AND (po."position" IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM public.tournament_players finisher
               WHERE finisher.tournament_id = p_tournament_id
                 AND finisher.user_id = po.user_id
                 AND finisher.position = po."position"
            )
            OR NOT EXISTS (
              SELECT 1 FROM public.tournament_players target_seat
               WHERE target_seat.id::text = po.metadata->>'registration_id'
                 AND target_seat.user_id = po.user_id
                 AND target_seat.source_satellite_id = p_tournament_id
            ));

    -- Seat awards and cash ticket fallbacks form a top-finisher prefix. A gap
    -- means a lower place was paid while a higher promised place was skipped.
    WITH awarded_positions AS (
      SELECT po."position" AS place
        FROM public.tournament_payouts po
       WHERE po.tournament_id = p_tournament_id
         AND po.source = 'satellite_seat' AND po."position" IS NOT NULL
      UNION
      SELECT o.place
        FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
         AND o.place IS NOT NULL AND round(o.amount_paid,2) > 0
         AND abs(round(o.amount_paid,2)-round(o.amount_owed,2)) <= 0.005
    ), bounds AS (SELECT max(place) AS max_place FROM awarded_positions)
    SELECT count(*) INTO v_satellite_award_gaps
      FROM bounds b
      CROSS JOIN LATERAL generate_series(1,b.max_place) expected(place)
     WHERE b.max_place IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM awarded_positions a WHERE a.place=expected.place);

    IF v_bad_satellite_outcomes <> 0 OR v_satellite_award_gaps <> 0
       OR EXISTS (
         SELECT 1 FROM public.tournament_obligations o
          WHERE o.tournament_id = p_tournament_id
            AND o.kind = 'satellite_remainder'
            AND NOT EXISTS (
              SELECT 1 FROM public.tournament_players tp
               WHERE tp.tournament_id=p_tournament_id AND tp.user_id=o.user_id
            )
       ) THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','satellite_awards_not_certified',
        'invalid_outcomes',v_bad_satellite_outcomes,
        'award_gaps',v_satellite_award_gaps));
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok',jsonb_array_length(v_failures) = 0,
    'reason',CASE WHEN jsonb_array_length(v_failures) = 0 THEN NULL
                  ELSE v_failures->0->>'code' END,
    'tournament_id',p_tournament_id,'winner_user_id',p_winner_user_id,
    'finish_kind',v_kind,'failures',v_failures,
    'financials',jsonb_build_object(
      'unsettled_obligations',v_unsettled_obligations,
      'place_obligations',v_place_owed,
      'rake_expected',v_rake_expected,
      'prize_balance',CASE WHEN v_escrow_found THEN v_escrow.prize_balance ELSE NULL END,
      'bounty_balance',CASE WHEN v_escrow_found THEN v_escrow.bounty_balance ELSE NULL END,
      'fee_balance',CASE WHEN v_escrow_found THEN v_escrow.fee_balance ELSE NULL END));
END;
$patch_body_readiness$);
 END IF;
 SELECT prosrc,to_jsonb(p)-'prosrc' INTO v_body,v_after FROM pg_proc p WHERE oid=v_oid;
 IF md5(v_body)<>'0388659818612493c16b02048dae5b3f' OR v_before IS DISTINCT FROM v_after THEN
  RAISE EXCEPTION 'current satellite readiness source or metadata postcondition differs'; END IF;
END $patch_readiness$;

DO $patch_satellite_guard$
DECLARE v_oid oid:='public.trg_guard_atomic_satellite_completion()'::regprocedure; v_body text;v_definition text;v_before jsonb;v_after jsonb;
BEGIN
 SELECT prosrc,pg_get_functiondef(oid),to_jsonb(p)-'prosrc'
 INTO v_body,v_definition,v_before FROM pg_proc p WHERE oid=v_oid;
 IF v_oid IS NULL OR md5(v_body) NOT IN ('517504ed4bae5ac000d6c47a6f5cb0d9','f218a7d769971c064cb11043fa6b45ce')
    OR (v_before->>'proowner')::oid<>'postgres'::regrole::oid
    OR (v_before->>'prosecdef')::boolean IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'current satellite satellite_guard source or owner differs'; END IF;
 IF md5(v_body)='517504ed4bae5ac000d6c47a6f5cb0d9' THEN
  EXECUTE replace(v_definition,v_body,$patch_body_satellite_guard$
DECLARE v_check jsonb;
BEGIN
  IF NEW.status='COMPLETED' AND OLD.status IS DISTINCT FROM 'COMPLETED'
     AND EXISTS(SELECT 1 FROM public.tournament_satellite_settlements h WHERE h.tournament_id=NEW.id) THEN
    PERFORM public.fn_ca_satellite_pending_transition(OLD,NEW);
    SELECT public.fn_ca_verify_current_satellite_terminal(NEW.id,h.winner_id,true)
      INTO v_check FROM public.tournament_satellite_settlements h WHERE h.tournament_id=NEW.id;
    IF COALESCE((v_check->>'ok')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'satellite completion has no exact current receipt proof' USING ERRCODE='P0404';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status='COMPLETED' AND OLD.status IS DISTINCT FROM 'COMPLETED'
     AND (lower(COALESCE(NEW.variant,''))='satellite'
       OR upper(COALESCE(NEW.tournament_type,''))='SATELLITE'
       OR NEW.satellite_target_id IS NOT NULL) THEN
    IF OLD.status<>'COMPLETING' THEN
      RAISE EXCEPTION 'satellite tournament cannot complete from %',OLD.status
        USING ERRCODE='check_violation';
    END IF;
    v_check:=public.fn_check_atomic_satellite_finish(NEW.id);
    IF COALESCE((v_check->>'ok')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'satellite completion has no exact atomic receipt: %',v_check
        USING ERRCODE='check_violation';
    END IF;
    NEW.on_break:=false;
    NEW.break_started_at:=NULL;
    NEW.break_ends_at:=NULL;
  END IF;
  RETURN NEW;
END;
$patch_body_satellite_guard$);
 END IF;
 SELECT prosrc,to_jsonb(p)-'prosrc' INTO v_body,v_after FROM pg_proc p WHERE oid=v_oid;
 IF md5(v_body)<>'f218a7d769971c064cb11043fa6b45ce' OR v_before IS DISTINCT FROM v_after THEN
  RAISE EXCEPTION 'current satellite satellite_guard source or metadata postcondition differs'; END IF;
END $patch_satellite_guard$;

REVOKE ALL ON FUNCTION public.fn_ca_satellite_terminal_scope(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ca_open_satellite_terminal_scope(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ca_close_satellite_terminal_scope(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ca_satellite_pending_transition(public.tournaments,public.tournaments) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ca_satellite_terminal_commit_proof() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ca_satellite_terminal_scope_consumed() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ca_verify_current_satellite_terminal(uuid,uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;

DROP TRIGGER IF EXISTS current_satellite_terminal_commit_proof ON public.tournaments;
CREATE CONSTRAINT TRIGGER current_satellite_terminal_commit_proof
 AFTER UPDATE ON public.tournaments DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW WHEN(NEW.status='COMPLETED' AND OLD.status IS DISTINCT FROM 'COMPLETED')
 EXECUTE FUNCTION public.fn_ca_satellite_terminal_commit_proof();
DROP TRIGGER IF EXISTS satellite_terminal_scope_must_be_consumed ON public.tournament_satellite_terminal_authorizations;
CREATE CONSTRAINT TRIGGER satellite_terminal_scope_must_be_consumed
 AFTER INSERT ON public.tournament_satellite_terminal_authorizations DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION public.fn_ca_satellite_terminal_scope_consumed();
DO $postflight$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_settle_satellite_tournament(uuid,uuid)')
   AND md5(prosrc)='486d0e6729de8d518d7faf0c253b65d3' AND proowner='postgres'::regrole AND prosecdef) THEN
  RAISE EXCEPTION 'live-proved public satellite R3 wrapper differs'; END IF;
 IF EXISTS(SELECT 1 FROM public.tournament_satellite_terminal_authorizations)
  OR has_table_privilege('anon','public.tournament_satellite_terminal_authorizations','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('authenticated','public.tournament_satellite_terminal_authorizations','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('service_role','public.tournament_satellite_terminal_authorizations','SELECT,INSERT,UPDATE,DELETE')
  OR NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.tournament_satellite_terminal_authorizations'::regclass
   AND relowner='postgres'::regrole AND relrowsecurity)
 THEN RAISE EXCEPTION 'current satellite capability ownership or empty-state gate failed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.tournaments'::regclass
  AND tgname='current_satellite_terminal_commit_proof' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.tournament_satellite_terminal_authorizations'::regclass
  AND tgname='satellite_terminal_scope_must_be_consumed' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
 THEN RAISE EXCEPTION 'current satellite deferred proofs are missing'; END IF;
END $postflight$;


-- END ACTIVATION COMPONENT scripts/deploy/phase-three-current-satellite-terminal.sql

-- BEGIN ACTIVATION COMPONENT scripts/deploy/phase-three-satellite-manager-target-scope.sql SHA256 2ab1719a7c8f22ac975f232845fa145e7cb0492742bb8fd41b12e4737010bc0a
-- Add the exact target side of the current M2 source-manager transaction.
-- This file is composed into the single Stage B activation transaction.

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_sync_tournament_current_players()') AND p.proisstrict=false AND pg_get_function_arguments(p.oid)='' AND pg_get_function_result(p.oid)='trigger' AND md5(p.prosrc)=ANY(ARRAY['ecb120c2c6a4ecee6c2e04d4c9b5ebc7']) AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public']::text[] AND p.prosecdef=true AND p.provolatile='v') THEN
  RAISE EXCEPTION 'satellite manager target requires the exact current roster recount';
 END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.tournament_players'::regclass AND t.tgname='trg_sync_tournament_current_players' AND t.tgfoid=to_regprocedure('public.fn_sync_tournament_current_players()') AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgtype=29 AND t.tgnargs=0 AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgqual IS NULL AND ARRAY(SELECT a.attname::text FROM unnest(t.tgattr::smallint[]) WITH ORDINALITY x(num,ord) JOIN pg_attribute a ON a.attrelid=t.tgrelid AND a.attnum=x.num ORDER BY x.ord)=ARRAY['status','tournament_id']::text[]) THEN
  RAISE EXCEPTION 'satellite manager target requires the exact current roster recount';
 END IF;

 IF EXISTS(SELECT 1 FROM (VALUES
  ('public.fn_ca_satellite_manager_target_immutable()','fba02ebdf76a196cd8997199b56f6da9'),
  ('public.fn_ca_publish_satellite_manager_target(uuid,uuid,jsonb)','92a5126174e4098aa57f4c42fbb9939f'),
  ('public.fn_ca_satellite_manager_target_write(text,text,jsonb,jsonb)','d1b68a808b9ee22eaee833a25bec5ca6')) e(identity,body_md5) WHERE to_regprocedure(e.identity) IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(e.identity) AND md5(p.prosrc)=e.body_md5 AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[] AND p.proacl=ARRAY['postgres=X/postgres']::aclitem[])) THEN RAISE EXCEPTION 'satellite manager target helper source or owner metadata differs'; END IF;

 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_settle_satellite_tournament(uuid,uuid)')
  AND md5(prosrc)='486d0e6729de8d518d7faf0c253b65d3' AND proowner='postgres'::regrole AND prosecdef)
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_satellite_terminal_scope(uuid)')
  AND md5(prosrc)='0bd1220dbfb2e23b27e9e102959829e2' AND proowner='postgres'::regrole AND prosecdef)
 THEN RAISE EXCEPTION 'satellite manager target scope needs the proved current R3 adapter'; END IF;
END $preflight$;

-- A new non-NULL insertion default or required column changes the allowed row.
-- This exact catalog-only comparison also runs against production before DDL.
DO $target_insert_defaults$
BEGIN
 IF (SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid::regtype::text,a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attname)
 FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
 WHERE a.attrelid='public.tournament_players'::regclass AND a.attnum>0 AND NOT a.attisdropped
 AND (a.attnotnull OR d.oid IS NOT NULL)) IS DISTINCT FROM $defaults$[["add_on","boolean",false,"false"],["bounties_collected","integer",false,"0"],["bounty_winnings","numeric",false,"0"],["chip_count","numeric",false,"0"],["chips","integer",false,"0"],["current_bounty","numeric",false,"0"],["id","uuid",true,"gen_random_uuid()"],["is_satellite_qualifier","boolean",false,"false"],["mystery_bounty_value","numeric",false,"0"],["prize","numeric",false,"0"],["push_15m_sent","boolean",false,"false"],["push_2m_sent","boolean",false,"false"],["rebuys","integer",false,"0"],["registered_at","timestamp with time zone",false,"now()"],["status","text",false,"'registered'::text"],["tournament_id","uuid",true,null],["user_id","uuid",true,null]]$defaults$::jsonb THEN
 RAISE EXCEPTION 'satellite target registration insertion defaults differ from reviewed row shape'; END IF;
END $target_insert_defaults$;

-- This child cannot outlive, widen, or replace its source capability.
CREATE TABLE IF NOT EXISTS public.tournament_satellite_manager_targets(
 tournament_id uuid PRIMARY KEY REFERENCES public.tournament_satellite_terminal_authorizations(tournament_id) ON DELETE CASCADE,
 token uuid NOT NULL,
 lease_generation uuid NOT NULL,
 target_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE RESTRICT,
 target_before jsonb NOT NULL CHECK(jsonb_typeof(target_before)='object'),
 escrow_before jsonb NOT NULL CHECK(jsonb_typeof(escrow_before)='object'),
 planned_seats jsonb NOT NULL CHECK(jsonb_typeof(planned_seats)='array')
);
ALTER TABLE public.tournament_satellite_manager_targets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_satellite_manager_targets FROM PUBLIC,anon,authenticated,service_role;
DO $target_table_shape$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.tournament_satellite_manager_targets'::regclass
  AND relowner='postgres'::regrole AND relkind='r' AND relrowsecurity)
 OR (SELECT jsonb_agg(jsonb_build_array(attname,atttypid::regtype::text,attnotnull) ORDER BY attnum)
  FROM pg_attribute WHERE attrelid='public.tournament_satellite_manager_targets'::regclass AND attnum>0 AND NOT attisdropped)
  IS DISTINCT FROM '[["tournament_id","uuid",true],["token","uuid",true],["lease_generation","uuid",true],["target_id","uuid",true],["target_before","jsonb",true],["escrow_before","jsonb",true],["planned_seats","jsonb",true]]'::jsonb
 OR (SELECT count(*) FROM pg_constraint WHERE conrelid='public.tournament_satellite_manager_targets'::regclass)<>6
 OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tournament_satellite_manager_targets'::regclass
  AND contype='p' AND conkey=ARRAY[1]::smallint[] AND convalidated)
 OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tournament_satellite_manager_targets'::regclass
  AND contype='f' AND conkey=ARRAY[1]::smallint[] AND confrelid='public.tournament_satellite_terminal_authorizations'::regclass
  AND confkey=ARRAY[1]::smallint[] AND confdeltype='c' AND convalidated)
 OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tournament_satellite_manager_targets'::regclass
  AND contype='f' AND conkey=ARRAY[4]::smallint[] AND confrelid='public.tournaments'::regclass
  AND confkey=ARRAY[1]::smallint[] AND confdeltype='r' AND convalidated)
 OR EXISTS(SELECT 1 FROM (VALUES ('target_before','object'),('escrow_before','object'),('planned_seats','array')) e(col,kind)
  WHERE NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.tournament_satellite_manager_targets'::regclass
   AND c.contype='c' AND c.convalidated AND pg_get_expr(c.conbin,c.conrelid)='(jsonb_typeof('||e.col||') = '||quote_literal(e.kind)||'::text)'))
 OR EXISTS(SELECT 1 FROM public.tournament_satellite_manager_targets)
 OR has_table_privilege('anon','public.tournament_satellite_manager_targets','SELECT,INSERT,UPDATE,DELETE')
 OR has_table_privilege('authenticated','public.tournament_satellite_manager_targets','SELECT,INSERT,UPDATE,DELETE')
 OR has_table_privilege('service_role','public.tournament_satellite_manager_targets','SELECT,INSERT,UPDATE,DELETE')
 THEN RAISE EXCEPTION 'satellite manager target table shape, ownership, or empty-state differs'; END IF;
END $target_table_shape$;


CREATE OR REPLACE FUNCTION public.fn_ca_satellite_manager_target_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
AS $immutable$
BEGIN
 IF TG_OP='UPDATE' OR pg_trigger_depth()<2 OR EXISTS(
  SELECT 1 FROM public.tournament_satellite_terminal_authorizations
   WHERE tournament_id=OLD.tournament_id) THEN
  RAISE EXCEPTION 'TOURNAMENT_MANAGER_SCOPE_VIOLATION: published satellite target authority is immutable'
   USING ERRCODE='42501';
 END IF;
 RETURN OLD;
END $immutable$;
DROP TRIGGER IF EXISTS satellite_manager_target_immutable ON public.tournament_satellite_manager_targets;
CREATE TRIGGER satellite_manager_target_immutable BEFORE UPDATE OR DELETE ON public.tournament_satellite_manager_targets
 FOR EACH ROW EXECUTE FUNCTION public.fn_ca_satellite_manager_target_immutable();

CREATE OR REPLACE FUNCTION public.fn_ca_publish_satellite_manager_target(
 p_source uuid,p_target uuid,p_plan jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
AS $publish$
DECLARE
 h public.tournament_satellite_settlements%ROWTYPE;
 a public.tournament_satellite_terminal_authorizations%ROWTYPE;
 v_generation uuid; v_before_row jsonb; v_before_escrow jsonb; v_seats jsonb;
BEGIN
 IF current_setting('app.smarter_data_actor',true) IS DISTINCT FROM 'tournament-manager' THEN RETURN; END IF;
 PERFORM public.fn_assert_tournament_manager_write_scope(p_source);
 v_generation:=NULLIF(current_setting('app.smarter_tournament_lease_generation',true),'')::uuid;
 IF NOT public.fn_ca_satellite_terminal_scope(p_source)
  OR current_setting('app.money_path',true) IS DISTINCT FROM 'fn_settle_satellite_tournament' THEN
  RAISE EXCEPTION 'TOURNAMENT_MANAGER_SCOPE_VIOLATION: target plan has no current satellite authority' USING ERRCODE='42501';
 END IF;
 PERFORM 1 FROM public.engine_tournament_leases l WHERE l.tournament_id=p_source
  AND l.protocol_version=2 AND l.lease_generation=v_generation
  AND l.heartbeat_at>=clock_timestamp()-interval '30 seconds' FOR KEY SHARE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'TOURNAMENT_MANAGER_SCOPE_VIOLATION: target plan has no current source lease' USING ERRCODE='42501';
 END IF;
 SELECT * INTO STRICT a FROM public.tournament_satellite_terminal_authorizations WHERE tournament_id=p_source;
 SELECT * INTO STRICT h FROM public.tournament_satellite_settlements WHERE tournament_id=p_source;
 IF h.seat_count=0 THEN RETURN; END IF;
 SELECT to_jsonb(t) INTO STRICT v_before_row FROM public.tournaments t WHERE t.id=p_target;
 SELECT to_jsonb(e) INTO STRICT v_before_escrow FROM public.tournament_escrow e WHERE e.tournament_id=p_target;
 IF p_source IS NOT DISTINCT FROM p_target OR h.target_id IS DISTINCT FROM p_target
  OR h.receipt_version IS DISTINCT FROM 2 OR h.seat_count IS NULL
  OR jsonb_typeof(p_plan) IS DISTINCT FROM 'array'
  OR jsonb_array_length(p_plan) IS DISTINCT FROM h.ticket_award_count
  OR (SELECT count(*) FROM jsonb_array_elements(p_plan) x WHERE x->>'delivery_kind'='seat')<>h.seat_count
  OR (SELECT count(*) FROM jsonb_array_elements(p_plan) x WHERE x->>'delivery_kind'='cash')<>h.cash_ticket_count
  OR (SELECT count(*) FROM jsonb_array_elements(p_plan) x WHERE x->>'delivery_kind'='ticket')<>h.entry_ticket_count
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_plan) x
   WHERE x-ARRAY['place','user_id','delivery_kind']<>'{}'::jsonb
    OR x->>'delivery_kind' NOT IN ('seat','cash','ticket')
    OR NOT EXISTS(SELECT 1 FROM public.tournament_players p WHERE p.tournament_id=p_source
      AND p.user_id=(x->>'user_id')::uuid AND p.position=(x->>'place')::integer))
  OR (SELECT count(DISTINCT x->>'user_id') FROM jsonb_array_elements(p_plan) x)<>h.ticket_award_count
  OR (SELECT count(DISTINCT x->>'place') FROM jsonb_array_elements(p_plan) x)<>h.ticket_award_count
 THEN RAISE EXCEPTION 'TOURNAMENT_MANAGER_SCOPE_VIOLATION: target plan differs from immutable source contract' USING ERRCODE='42501'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id',p.user_id,'place',p.position,'username',p.username)
  ORDER BY p.position),'[]'::jsonb) INTO v_seats
 FROM jsonb_array_elements(p_plan) x JOIN public.tournament_players p
  ON p.tournament_id=p_source AND p.user_id=(x->>'user_id')::uuid AND p.position=(x->>'place')::integer
 WHERE x->>'delivery_kind'='seat';
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_seats) x JOIN public.tournament_players p
  ON p.tournament_id=p_target AND p.user_id=(x->>'user_id')::uuid) THEN
  RAISE EXCEPTION 'TOURNAMENT_MANAGER_SCOPE_VIOLATION: planned target registration already exists' USING ERRCODE='42501';
 END IF;
 INSERT INTO public.tournament_satellite_manager_targets
  (tournament_id,token,lease_generation,target_id,target_before,escrow_before,planned_seats)
 VALUES(p_source,a.token,v_generation,p_target,v_before_row,v_before_escrow,v_seats);
END $publish$;

CREATE OR REPLACE FUNCTION public.fn_ca_satellite_manager_target_write(
 p_relation text,p_operation text,p_old jsonb,p_new jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
AS $target_write$
DECLARE
 v_source_id uuid; v_target_id uuid; v_expected jsonb; v_plan jsonb;
 a public.tournament_satellite_manager_targets%ROWTYPE;
 h public.tournament_satellite_settlements%ROWTYPE;
 v_seat_count integer; v_registered_seats integer; v_unreceipted_seats integer;
 v_live_count integer; v_base_count integer; v_counted_target boolean;
BEGIN
 -- No table, chair, roster UPDATE/DELETE, or tournament INSERT/DELETE exception.
 IF NOT ((p_relation='tournament_players' AND p_operation='INSERT')
  OR (p_relation='tournaments' AND p_operation='UPDATE')) THEN RETURN false; END IF;
 v_source_id:=NULLIF(current_setting('app.smarter_tournament_id',true),'')::uuid;
 IF v_source_id IS NULL THEN RETURN false; END IF;
 PERFORM public.fn_assert_tournament_manager_write_scope(v_source_id);
 v_target_id:=CASE p_relation WHEN 'tournaments' THEN (p_new->>'id')::uuid
  ELSE (p_new->>'tournament_id')::uuid END;
 SELECT * INTO a FROM public.tournament_satellite_manager_targets t
  WHERE t.tournament_id=v_source_id AND t.target_id=v_target_id;
 IF NOT FOUND OR a.lease_generation IS DISTINCT FROM
  NULLIF(current_setting('app.smarter_tournament_lease_generation',true),'')::uuid
  OR a.token IS DISTINCT FROM NULLIF(current_setting('app.tournament_seat_exit_token',true),'')::uuid
  OR NOT public.fn_ca_satellite_terminal_scope(v_source_id)
  OR current_setting('app.money_path',true) IS DISTINCT FROM 'fn_settle_satellite_tournament'
 THEN RETURN false; END IF;
 SELECT * INTO STRICT h FROM public.tournament_satellite_settlements WHERE tournament_id=v_source_id;
 v_seat_count:=jsonb_array_length(a.planned_seats);
 IF h.target_id IS DISTINCT FROM v_target_id OR h.seat_count IS DISTINCT FROM v_seat_count THEN RETURN false; END IF;

 IF p_relation='tournament_players' THEN
  SELECT x INTO v_plan FROM jsonb_array_elements(a.planned_seats) x WHERE x->>'user_id'=p_new->>'user_id';
  IF v_plan IS NULL OR p_old IS NOT NULL OR p_new->>'id' IS NULL
   OR EXISTS(SELECT 1 FROM public.tournament_players p WHERE p.tournament_id=v_target_id
    AND p.user_id=(v_plan->>'user_id')::uuid) THEN RETURN false; END IF;
  v_expected:=jsonb_build_object(
   'id',p_new->'id','tournament_id',v_target_id,'user_id',v_plan->'user_id','username',v_plan->'username',
   'chips',0,'status','registered','prize',0,'rebuys',0,'add_on',false,
   'registered_at',transaction_timestamp(),'bounties_collected',0,'bounty_winnings',0,
   'mystery_bounty_value',0,'current_bounty',0,'chip_count',0,
   'is_satellite_qualifier',true,'source_satellite_id',v_source_id,'push_15m_sent',false,'push_2m_sent',false);
  -- Every unlisted field must retain its NULL insertion default. Never admit a
  -- pre-seated row, terminal marker, rebuy generation, bounty, or unrelated club.
  RETURN jsonb_strip_nulls(p_new)=jsonb_strip_nulls(v_expected);
 END IF;

 -- The live, source-pinned roster trigger recounts each newly inserted row
 -- before M2 writes that row's award. It changes only the lobby headcount.
 v_base_count:=(a.target_before->>'current_players')::integer;
 v_counted_target:=a.target_before->>'status' IN ('ANNOUNCED','REGISTERING');
 SELECT count(*),count(*) FILTER(WHERE NOT EXISTS(
   SELECT 1 FROM public.tournament_satellite_awards w WHERE w.tournament_id=v_source_id
    AND w.delivery_kind='seat' AND w.registration_id=p.id
    AND w.user_id=p.user_id AND w.place=(x->>'place')::integer))
  INTO v_registered_seats,v_unreceipted_seats
 FROM jsonb_array_elements(a.planned_seats) x JOIN public.tournament_players p
  ON p.tournament_id=v_target_id AND p.user_id=(x->>'user_id')::uuid
 WHERE p.status='registered' AND p.chips=0 AND p.chip_count=0
  AND p.table_id IS NULL AND p.seat_number IS NULL
  AND p.username IS NOT DISTINCT FROM x->>'username'
  AND p.is_satellite_qualifier AND p.source_satellite_id=v_source_id;
 SELECT count(*) INTO v_live_count FROM public.tournament_players p
  WHERE p.tournament_id=v_target_id AND p.status IN ('registered','playing');
 IF v_counted_target AND pg_trigger_depth()>=2
  AND v_registered_seats BETWEEN 1 AND v_seat_count AND v_unreceipted_seats=1
  AND (p_old->>'id')::uuid=v_target_id AND (p_new->>'id')::uuid=v_target_id
  AND (p_new-'current_players')=(p_old-'current_players')
  AND (p_old-ARRAY['current_players','updated_at'])=(a.target_before-ARRAY['current_players','updated_at'])
  AND ((p_old->>'updated_at')::timestamptz IS NOT DISTINCT FROM (a.target_before->>'updated_at')::timestamptz
    OR (p_old->>'updated_at')::timestamptz=transaction_timestamp())
  AND (p_old->>'current_players')::integer=v_base_count+v_registered_seats-1
  AND (p_new->>'current_players')::integer=v_base_count+v_registered_seats
  AND (p_new->>'current_players')::integer=v_live_count
 THEN RETURN true; END IF;

 -- M2's final assignment uses its captured target count. The genuine nested
 -- recount has already included the inserted rows for a registering target;
 -- a RUNNING target is not touched by that roster trigger.
 IF (p_old-ARRAY['current_players','updated_at'])
    IS DISTINCT FROM (a.target_before-ARRAY['current_players','updated_at'])
  OR (p_old->>'id')::uuid IS DISTINCT FROM v_target_id
  OR ((p_old->>'updated_at')::timestamptz IS DISTINCT FROM (a.target_before->>'updated_at')::timestamptz
    AND (p_old->>'updated_at')::timestamptz IS DISTINCT FROM transaction_timestamp())
  OR (p_old->>'current_players')::integer IS DISTINCT FROM
     (v_base_count+CASE WHEN v_counted_target THEN v_seat_count ELSE 0 END)
  OR (p_new-ARRAY['current_players','prize_pool','total_rake','updated_at'])
   IS DISTINCT FROM (p_old-ARRAY['current_players','prize_pool','total_rake','updated_at'])
  OR (p_new->>'current_players')::integer IS DISTINCT FROM v_base_count+v_seat_count
  OR (p_new->>'prize_pool')::numeric IS DISTINCT FROM round((a.target_before->>'prize_pool')::numeric+v_seat_count*h.target_buy_in,2)
  OR (p_new->>'total_rake')::numeric IS DISTINCT FROM round((a.target_before->>'total_rake')::numeric+v_seat_count*h.target_fee,2)
  OR (p_new->>'updated_at')::timestamptz IS DISTINCT FROM transaction_timestamp()
 THEN RETURN false; END IF;
 -- The registration precedes its award. This aggregate update follows all
 -- awards, so every planned registration must now have its exact funded receipt.
 IF (SELECT count(*) FROM public.tournament_satellite_awards w
      WHERE w.tournament_id=v_source_id AND w.delivery_kind='seat')<>v_seat_count
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(a.planned_seats) x WHERE NOT EXISTS(
  SELECT 1 FROM public.tournament_satellite_awards w
   JOIN public.tournament_players p ON p.id=w.registration_id
   JOIN public.tournament_payouts pay ON pay.id=w.payout_id
   JOIN public.chip_ledger l ON l.idempotency_key='tourney:'||v_source_id::text||':seat:'||(x->>'user_id')||':pool_transfer'
  WHERE w.tournament_id=v_source_id AND w.user_id=(x->>'user_id')::uuid
   AND w.place=(x->>'place')::integer AND w.delivery_kind='seat' AND w.amount=h.ticket_cost
   AND p.tournament_id=v_target_id AND p.user_id=w.user_id AND p.status='registered'
   AND p.chips=0 AND p.table_id IS NULL AND p.seat_number IS NULL
   AND p.is_satellite_qualifier AND p.source_satellite_id=v_source_id
   AND pay.tournament_id=v_source_id AND pay.user_id=w.user_id AND pay.amount=h.ticket_cost
   AND pay.source='satellite_seat' AND pay.idempotency_key=w.idempotency_key
   AND l.from_type='prize_liability' AND l.from_entity_id=v_source_id
   AND l.to_type='prize_liability' AND l.to_entity_id=v_target_id AND l.amount=h.ticket_cost
   AND l.category='tournament_buyin' AND l.metadata->>'registration_id'=p.id::text))
 OR NOT EXISTS(SELECT 1 FROM public.tournament_escrow e WHERE e.tournament_id=v_target_id
   AND e.prize_balance=(a.escrow_before->>'prize_balance')::numeric+v_seat_count*h.target_buy_in
   AND e.fee_balance=(a.escrow_before->>'fee_balance')::numeric+v_seat_count*h.target_fee
   AND e.satellite_in=(a.escrow_before->>'satellite_in')::numeric+v_seat_count*h.target_buy_in
   AND e.satellite_fee_in=(a.escrow_before->>'satellite_fee_in')::numeric+v_seat_count*h.target_fee
   AND (to_jsonb(e)-ARRAY['satellite_in','satellite_fee_in','prize_balance','fee_balance','updated_at'])
    IS NOT DISTINCT FROM (a.escrow_before-ARRAY['satellite_in','satellite_fee_in','prize_balance','fee_balance','updated_at'])
   AND e.enforced AND e.closed_at IS NULL)
 THEN RETURN false; END IF;
 RETURN true;
END $target_write$;

REVOKE ALL ON FUNCTION public.fn_ca_satellite_manager_target_immutable(),
 public.fn_ca_publish_satellite_manager_target(uuid,uuid,jsonb),
 public.fn_ca_satellite_manager_target_write(text,text,jsonb,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;

-- Exact transformations are generated from the reviewed adapter/Stage B bodies.
DO $patch_core$
DECLARE f oid:=to_regprocedure('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)');
 body text; definition text; before_meta jsonb; after_meta jsonb;
BEGIN
 SELECT prosrc,pg_get_functiondef(oid),to_jsonb(p)-'prosrc' INTO body,definition,before_meta FROM pg_proc p WHERE oid=f;
 IF f IS NULL OR md5(body) NOT IN ('0e2066fafe3c4e1fceb96db9937b3140','c5ba0595fc5363ecc94243b003a3d326')
  OR (before_meta->>'proowner')::oid<>'postgres'::regrole::oid
  OR (before_meta->>'prosecdef')::boolean IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'satellite manager target core preimage differs'; END IF;
 IF md5(body)='0e2066fafe3c4e1fceb96db9937b3140' THEN
  EXECUTE replace(definition,body,replace(body,'  UPDATE public.tournaments
     SET status = ''COMPLETING'', updated_at = now()','  PERFORM public.fn_ca_publish_satellite_manager_target(
    p_tournament_id,v_target_id,v_plan);

  UPDATE public.tournaments
     SET status = ''COMPLETING'', updated_at = now()'));
 END IF;
 SELECT prosrc,to_jsonb(p)-'prosrc' INTO body,after_meta FROM pg_proc p WHERE oid=f;
 IF md5(body)<>'c5ba0595fc5363ecc94243b003a3d326' OR before_meta IS DISTINCT FROM after_meta THEN
  RAISE EXCEPTION 'satellite manager target core source or metadata postimage differs'; END IF;
END $patch_core$;


DO $postflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_sync_tournament_current_players()') AND p.proisstrict=false AND pg_get_function_arguments(p.oid)='' AND pg_get_function_result(p.oid)='trigger' AND md5(p.prosrc)=ANY(ARRAY['ecb120c2c6a4ecee6c2e04d4c9b5ebc7']) AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public']::text[] AND p.prosecdef=true AND p.provolatile='v') THEN
  RAISE EXCEPTION 'satellite manager target requires the exact current roster recount';
 END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.tournament_players'::regclass AND t.tgname='trg_sync_tournament_current_players' AND t.tgfoid=to_regprocedure('public.fn_sync_tournament_current_players()') AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgtype=29 AND t.tgnargs=0 AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgqual IS NULL AND ARRAY(SELECT a.attname::text FROM unnest(t.tgattr::smallint[]) WITH ORDINALITY x(num,ord) JOIN pg_attribute a ON a.attrelid=t.tgrelid AND a.attnum=x.num ORDER BY x.ord)=ARRAY['status','tournament_id']::text[]) THEN
  RAISE EXCEPTION 'satellite manager target requires the exact current roster recount';
 END IF;

 IF EXISTS(SELECT 1 FROM (VALUES
  ('public.fn_ca_satellite_manager_target_immutable()','fba02ebdf76a196cd8997199b56f6da9'),
  ('public.fn_ca_publish_satellite_manager_target(uuid,uuid,jsonb)','92a5126174e4098aa57f4c42fbb9939f'),
  ('public.fn_ca_satellite_manager_target_write(text,text,jsonb,jsonb)','d1b68a808b9ee22eaee833a25bec5ca6')) e(identity,body_md5) WHERE NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(e.identity) AND md5(p.prosrc)=e.body_md5 AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[] AND p.proacl=ARRAY['postgres=X/postgres']::aclitem[])) THEN RAISE EXCEPTION 'satellite manager target helper source or owner metadata differs'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.tournament_satellite_manager_targets'::regclass AND tgname='satellite_manager_target_immutable' AND tgenabled='O' AND tgfoid='public.fn_ca_satellite_manager_target_immutable()'::regprocedure AND tgtype=27) THEN RAISE EXCEPTION 'satellite target immutability trigger differs'; END IF;
END $postflight$;


-- END ACTIVATION COMPONENT scripts/deploy/phase-three-satellite-manager-target-scope.sql

-- BEGIN ACTIVATION COMPONENT scripts/deploy/phase-three-strict-tournament-cutover.sql SHA256 2862c27eae420c623a3ccc9ccc086245d208fc48dad3c0e97f2a5b0da1c6dabc
-- Prepared accounting Phase 3 strict tournament cutover. NOT APPLIED.
-- Final-deal v2 creation, testing and staged deployment were explicitly approved.
-- This whole cutover remains unverified and NOT APPLIED until its gates pass.
-- The exact-hand prerequisite is resolved. The remaining cutover blocker is
-- complete current satellite target authority and full manager rehearsal. Preserve every source
-- and engine-adoption gate; reserve a fresh migration only after the complete
-- approved rehearsal passes.
-- Player rebuy/decline route compatibility is covered by the focused PG probe.
-- Historical certificates and incident findings remain unchanged.



-- Read-only fail-closed prerequisite before any table lock or DDL. Existence
-- alone is not deployment certification; every later source/adoption gate stays.
DO $require_final_deal_v2_contract$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE
    oid=to_regprocedure('public.fn_ca_verify_terminal_final_deal_batch(uuid,boolean)')
    AND md5(prosrc)='260c94b41d7f2bb021a88a546a1714ac' AND proowner='postgres'::regrole AND prosecdef
    AND proconfig=ARRAY['search_path=public, pg_temp']::text[])
    OR has_function_privilege('anon',
      to_regprocedure('public.fn_ca_verify_terminal_final_deal_batch(uuid,boolean)'),'EXECUTE')
    OR has_function_privilege('authenticated',
      to_regprocedure('public.fn_ca_verify_terminal_final_deal_batch(uuid,boolean)'),'EXECUTE')
    OR has_function_privilege('service_role',
      to_regprocedure('public.fn_ca_verify_terminal_final_deal_batch(uuid,boolean)'),'EXECUTE') THEN
    RAISE EXCEPTION 'Stage B requires the exact approved final-deal v2 verifier and owner-only access';
  END IF;
  IF EXISTS(SELECT 1 FROM (VALUES
    ('public.fn_complete_tournament_terminal(uuid,uuid,text)','96a61ea5e16560735bcb70b355aa79ab'),
    ('public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)','90f7506df2f1a94fe22952714fcd9f85'),
   ('public.fn_ca_tournament_terminal_receipt(uuid,uuid)','bb4b0e1d1c758943fca29f9a83d064e4'),
    ('public.fn_settle_tournament_final_table_deal(uuid)','b1941b2e55dade307ecd74068ab3e500'),
    ('public.fn_guard_tournament_completing_claim()','82078938fd926c94a0ab778acd77dd61'),
    ('public.trg_lock_atomic_final_table_deal_status()','ddc5e3121ed9cc73d41525e6c1ba6c34'),
    ('public.fn_guard_tournament_completed_certificate()','d994347e1b76c936ce13361d73f94fd2'),
    ('public.trg_atomic_final_table_deal_completion_guard()','9f5f5fefa77ae93bfeffc9f414a63a0d'),
    ('public.trg_freeze_atomic_final_table_deal_obligation()','d338c5278ef1247ff0f4a7c4ba774cc5')
  ) e(identity,body_md5) WHERE NOT EXISTS(SELECT 1 FROM pg_proc p
    WHERE p.oid=to_regprocedure(e.identity) AND md5(p.prosrc)=e.body_md5
      AND p.proowner='postgres'::regrole AND p.prosecdef)) THEN
    RAISE EXCEPTION 'Stage B requires the complete approved final-deal v2 writer and completion guards';
  END IF;
END;
$require_final_deal_v2_contract$;

DO $require_current_satellite_manager_contract$
BEGIN
 IF EXISTS(SELECT 1 FROM (VALUES
  ('public.fn_settle_satellite_tournament(uuid,uuid)','486d0e6729de8d518d7faf0c253b65d3'),
  ('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)','c5ba0595fc5363ecc94243b003a3d326'),
  ('public.fn_ca_satellite_settlement_receipt(uuid,uuid)','381b3e0691a2b9303693653f5110d568'),
  ('public.fn_resolve_satellite_settlement_outcome(uuid,uuid)','c332627d5d8c7c9ac951392c95c53551'),
  ('public.fn_tournament_finish_readiness(uuid,uuid)','0388659818612493c16b02048dae5b3f'),
  ('public.trg_guard_atomic_satellite_completion()','f218a7d769971c064cb11043fa6b45ce'),
  ('public.fn_ca_satellite_terminal_scope(uuid)','0bd1220dbfb2e23b27e9e102959829e2'),
  ('public.fn_ca_open_satellite_terminal_scope(uuid)','519bfbe4b59c3d833ae7d59570b89203'),
  ('public.fn_ca_close_satellite_terminal_scope(uuid,jsonb)','1470b469991c59834c66bfb3d4a2f432'),
  ('public.fn_ca_verify_current_satellite_terminal(uuid,uuid,boolean)','0977ca13c91ea1aef766cf6d81f0c816'),
  ('public.fn_sync_tournament_current_players()','ecb120c2c6a4ecee6c2e04d4c9b5ebc7'),
  ('public.fn_ca_satellite_manager_target_immutable()','fba02ebdf76a196cd8997199b56f6da9'),
  ('public.fn_ca_publish_satellite_manager_target(uuid,uuid,jsonb)','92a5126174e4098aa57f4c42fbb9939f'),
  ('public.fn_ca_satellite_manager_target_write(text,text,jsonb,jsonb)','d1b68a808b9ee22eaee833a25bec5ca6')) e(identity,body_md5) WHERE NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(e.identity) AND md5(p.prosrc)=e.body_md5 AND p.proowner='postgres'::regrole AND p.prosecdef)) THEN RAISE EXCEPTION 'Stage B requires the complete current satellite manager target contract'; END IF;
END $require_current_satellite_manager_contract$;


/* A busy relation aborts the whole cutover instead of making a live table
   wait behind DDL. Re-run only in the audited quiet window after inspecting
   the unchanged catalog; never hide a timeout behind an automatic retry. */
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

/* Supabase Realtime takes relation-catalog locks while rebuilding its
   subscription state. Acquire that global catalog boundary before this
   migration inspects or changes any public object, so the cutover cannot form
   the inverse public-relation -> realtime.subscription lock order. NOWAIT
   aborts an occupied window whole instead of pausing live tables behind DDL. */
LOCK TABLE realtime.subscription IN ACCESS EXCLUSIVE MODE NOWAIT;

/* Stage B is a contraction after the independently receipted seat-first
   retirement. Refuse to duplicate or bypass that boundary: the atomic creator
   must exist and both legacy repair doors must already be absent. */
DO $require_seat_first_retirement$
BEGIN
  IF to_regprocedure(
       'public.fn_create_seat_first_game_atomic(uuid,jsonb)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'Stage-B manager fencing requires the atomic seat-first creator';
  END IF;

  IF to_regprocedure('public.fn_repair_seat_first_games(integer)') IS NOT NULL
     OR to_regprocedure(
          'public.fn_repair_seat_first_games_before_maintenance_gate(integer)'
        ) IS NOT NULL THEN
    RAISE EXCEPTION
      'Stage-B manager fencing requires the receipted seat-first retirement first';
  END IF;
END;
$require_seat_first_retirement$;

/* Refuse an out-of-order cutover or an accidental replacement of an unrelated
   PostgREST hook.  Reapplying this exact migration is harmless. */
DO $require_stage_a_request_authority$
DECLARE
  v_source text;
BEGIN
  IF to_regprocedure(
       'smarter_private.fn_smarter_data_api_pre_request()'
     ) IS NULL THEN
    RAISE EXCEPTION
      'Stage-B manager request fencing requires the Stage-A request hook first';
  END IF;

  SELECT p.prosrc
    INTO STRICT v_source
    FROM pg_proc p
   WHERE p.oid =
         'smarter_private.fn_smarter_data_api_pre_request()'::regprocedure
     AND p.prosecdef;

  -- Preserve the deployed busy-manager fix. A generic FOR SHARE substring
  -- also occurs in comments, so exact source identities guard this upgrade.
  IF md5(v_source) NOT IN ('ab227471f29f2944ebd64909622b6af7',
                          'c43a9c75d3d4c1e4945c908d16e3b5d6')
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid=to_regprocedure('public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)')
          AND md5(p.prosrc)='d1b5100c2b9f92bec5fd1680b0b4f230'
          AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
          AND p.proconfig=ARRAY['search_path=public, pg_temp']
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid=to_regprocedure('public.heartbeat_tournament_leases_v4(text,jsonb,integer)')
          AND md5(p.prosrc)='5e6c99545e07c21efcb50e5cb3441c14'
          AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
          AND p.proconfig=ARRAY['search_path=public, pg_temp']
     ) THEN
    RAISE EXCEPTION
      'Stage-B requires the exact KEY SHARE hook, UPDATE takeover and non-key heartbeat authorities';
  END IF;

  -- The browser reveal exception delegates only to the already hardened body.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
       WHERE p.oid=to_regprocedure('public.fn_mystery_bounty_reveal(uuid,uuid,boolean)')
         AND md5(p.prosrc)='5578ec53c8a531eeba47d448ae9af1b1'
         AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
         AND p.proconfig=ARRAY['search_path=public, pg_temp']
         AND p.proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION 'Stage-B shared player reveal requires the exact hardened identity authority';
  END IF;

  IF position('app.smarter_data_actor' IN v_source) = 0
     OR position('x-smarter-data-actor' IN v_source) = 0
     OR position('l.lease_generation = v_lease_generation' IN v_source) = 0
     OR position(E'     FOR KEY SHARE;\n  END IF;' IN v_source) = 0
     OR position('request.jwt.claims' IN v_source) = 0
     OR position('auth.role()' IN v_source) = 0
     OR position('verified JWT role disagrees with request claims' IN v_source) = 0 THEN
    RAISE EXCEPTION
      'Refusing Stage-B activation over an unknown or incomplete request hook';
  END IF;

  IF to_regprocedure(
       'public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'
     ) IS NULL
     OR to_regprocedure(
          'public.heartbeat_tournament_leases_v3(text,jsonb,integer)'
        ) IS NULL
     OR to_regprocedure(
          'public.release_tournament_leases_v2(text,jsonb)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamptz,uuid)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid)'
        ) IS NULL
     OR to_regprocedure(
          'public.claim_table_lease_v2(uuid,text,text,uuid,integer)'
        ) IS NULL
     OR to_regprocedure(
          'public.heartbeat_table_leases_v3(text,jsonb,integer)'
        ) IS NULL
     OR to_regprocedure(
          'public.release_table_leases_v2(text,jsonb)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_ca_process_hand_post_commit_obligations(uuid)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'
        ) IS NULL THEN
    RAISE EXCEPTION
      'Stage-B manager request fencing requires every tournament and table protocol-2 authority door';
  END IF;

  /* This contraction deletes the rolling 11-argument hand door below. The
     exact-seat expansion is intentionally versioned before Stage B and must
     already have hardened the surviving 12-argument door. Without this pin,
     an accidentally reordered migration set can destroy the compatibility
     door before the expansion has inspected it. */
  IF position(
       'seat_joined_at' IN pg_get_functiondef(
         'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure
       )
     ) = 0
     OR position(
       'time_bank_seat_generation_mismatch' IN pg_get_functiondef(
         'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure
       )
     ) = 0 THEN
    RAISE EXCEPTION
      'Stage-B manager fencing requires 20260908161534 exact-seat expansion first';
  END IF;
END;
$require_stage_a_request_authority$;

/* Contract the Stage-A tournament-settlement compatibility door only after the
   exact atomic-batch engine is the sole running build. Stage A deliberately
   kept this public signature behavior-compatible with older engines and kept
   every format completion, certificate and pool-lifecycle trigger disabled.
   The payer and all seven guards contract in this one transaction, so no state can expose one
   strict boundary without the others. */
DO $require_stage_a_tournament_settlement_expand$
DECLARE
  v_source text;
  v_satellite_cash_source text;
  v_satellite_guard_enabled boolean;
  v_guard_enabled boolean;
  v_final_deal_guard_enabled boolean;
  v_finish_claim_guard_enabled boolean;
  v_finish_certificate_guard_enabled boolean;
  v_pool_window_guard_enabled boolean;
  v_pool_freeze_guard_enabled boolean;
BEGIN
  IF to_regprocedure(
       'public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)'
     ) IS NULL
     OR to_regprocedure(
          'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)'
        ) IS NULL
     OR to_regprocedure(
          'public.trg_tournament_atomic_place_completion_guard()'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_settle_satellite_cash_entitlement_exact(uuid,text,integer,uuid,numeric,text)'
        ) IS NULL
     OR to_regprocedure(
          'public.trg_guard_atomic_satellite_completion()'
        ) IS NULL
     OR to_regprocedure(
          'public.trg_atomic_final_table_deal_completion_guard()'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_guard_tournament_completing_claim()'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_guard_tournament_completed_certificate()'
        ) IS NULL
     OR to_regprocedure(
          'public.trg_tournament_pool_finalization_window_guard()'
        ) IS NULL
     OR to_regprocedure(
          'public.trg_freeze_finalized_tournament_prize_pool()'
        ) IS NULL THEN
    RAISE EXCEPTION
      'Stage-B tournament settlement contraction requires the Stage-A expand objects';
  END IF;

  SELECT pg_get_functiondef(
           'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)'::regprocedure
         )
    INTO v_source;
  IF position('fn_settle_tournament_obligation_before_atomic_batch_gate('
              IN v_source) = 0 THEN
    RAISE EXCEPTION
      'Refusing Stage-B contraction over an unknown single-obligation wrapper';
  END IF;

  SELECT pg_get_functiondef(
           'public.fn_settle_satellite_cash_entitlement_exact(uuid,text,integer,uuid,numeric,text)'::regprocedure
         )
    INTO v_satellite_cash_source;
  IF position('fn_settle_tournament_obligation_before_atomic_batch_gate('
              IN v_satellite_cash_source) = 0
     OR position('public.fn_settle_tournament_obligation('
                 IN v_satellite_cash_source) > 0 THEN
    RAISE EXCEPTION
      'Stage-B requires the atomic satellite helper to use the private obligation core';
  END IF;

  SELECT t.tgenabled <> 'D'
    INTO v_satellite_guard_enabled
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.tournaments'::regclass
     AND t.tgname = 'aaa_guard_atomic_satellite_completion'
     AND NOT t.tgisinternal;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Stage-B tournament settlement contraction requires the Stage-A satellite completion guard';
  END IF;

  SELECT t.tgenabled <> 'D'
    INTO v_guard_enabled
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.tournaments'::regclass
     AND t.tgname = 'zzzz_tournaments_atomic_place_completion_guard'
     AND NOT t.tgisinternal;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Stage-B tournament settlement contraction requires the Stage-A completion guard';
  END IF;

  SELECT t.tgenabled <> 'D'
    INTO v_final_deal_guard_enabled
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.tournaments'::regclass
     AND t.tgname = 'zzzzz_tournaments_atomic_final_table_deal_completion_guard'
     AND NOT t.tgisinternal;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Stage-B tournament settlement contraction requires the Stage-A final-table-deal completion guard';
  END IF;

  SELECT t.tgenabled <> 'D'
    INTO v_finish_claim_guard_enabled
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.tournaments'::regclass
     AND t.tgname = 'aa_guard_tournament_completing_claim'
     AND NOT t.tgisinternal;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Stage-B tournament settlement contraction requires the Stage-A finish-claim guard';
  END IF;

  SELECT t.tgenabled <> 'D'
    INTO v_finish_certificate_guard_enabled
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.tournaments'::regclass
     AND t.tgname = 'zzzzzz_tournaments_financial_certificate'
     AND NOT t.tgisinternal;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Stage-B tournament settlement contraction requires the Stage-A financial-certificate guard';
  END IF;

  SELECT t.tgenabled <> 'D'
    INTO v_pool_window_guard_enabled
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.tournaments'::regclass
     AND t.tgname = 'zzzz_tournament_pool_finalization_window_guard'
     AND NOT t.tgisinternal;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Stage-B tournament settlement contraction requires the Stage-A pool-window guard';
  END IF;

  SELECT t.tgenabled <> 'D'
    INTO v_pool_freeze_guard_enabled
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.tournaments'::regclass
     AND t.tgname = 'zzzz_freeze_finalized_tournament_prize_pool'
     AND NOT t.tgisinternal;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Stage-B tournament settlement contraction requires the Stage-A finalized-pool guard';
  END IF;

  IF position('atomic_batch_required' IN v_source) = 0 THEN
    IF position('FOR UPDATE' IN v_source) > 0
       OR v_satellite_guard_enabled
       OR v_guard_enabled
       OR v_final_deal_guard_enabled
       OR v_finish_claim_guard_enabled
       OR v_finish_certificate_guard_enabled
       OR v_pool_window_guard_enabled
       OR v_pool_freeze_guard_enabled THEN
      RAISE EXCEPTION
        'Stage-A settlement expand objects are not in their compatible state';
    END IF;
  ELSIF position('v_kind' IN v_source) = 0
        OR position('v_atomic_kinds' IN v_source) = 0
        OR position('v_kind = ANY(v_atomic_kinds)' IN v_source) = 0
        OR position('satellite_remainder' IN v_source) = 0
        OR position($needle$'seat'$needle$ IN v_source) = 0
        OR position('FOR UPDATE' IN v_source) > 0
        OR position('v_is_satellite' IN v_source) > 0
        OR NOT v_satellite_guard_enabled
        OR NOT v_guard_enabled
        OR NOT v_final_deal_guard_enabled
        OR NOT v_finish_claim_guard_enabled
        OR NOT v_finish_certificate_guard_enabled
        OR NOT v_pool_window_guard_enabled
        OR NOT v_pool_freeze_guard_enabled THEN
    RAISE EXCEPTION
      'Existing Stage-B settlement contract is incomplete';
  END IF;
END;
$require_stage_a_tournament_settlement_expand$;

/* Retire the raw-table rolling bridge at one explicit writer boundary. Lock
   tables first because the old request obtains that relation before its
   deferred validator locks a protocol-1 lease. NOWAIT makes a concurrent
   legacy insert or wake/receipt writer abort this entire cutover without a
   partial catalog change. Holding the lease relation EXCLUSIVE then prevents
   a heartbeat or a bridge FOR SHARE lock from crossing the replacement. */
LOCK TABLE public.tables IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournament_table_origins IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournament_capacity_table_receipts
  IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournament_manager_wakes IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.engine_tournament_leases IN EXCLUSIVE MODE NOWAIT;

DO $refuse_live_protocol_one_tournament_manager$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.engine_tournament_leases l
     WHERE l.protocol_version = 1
       AND l.heartbeat_at >= clock_timestamp() - interval '30 seconds'
  ) THEN
    RAISE EXCEPTION
      'Stage-B cutover refused: a fresh protocol-1 tournament manager still owns a lease';
  END IF;
END;
$refuse_live_protocol_one_tournament_manager$;

/* Stage B preserves every already-committed bridge table as an ordinary
   capacity origin with its canonical receipt. Only the transaction-time
   synthesis is removed; all future capacity paths are receipt-only. */
CREATE OR REPLACE FUNCTION public.trg_validate_tournament_table_origin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_parent_status text;
BEGIN
  SELECT t.status::text INTO v_parent_status
    FROM public.tournaments t
   WHERE t.id = NEW.tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament table origin lost parent tournament %', NEW.tournament_id
      USING ERRCODE = '23503';
  END IF;

  IF NEW.origin_kind = 'capacity' THEN
    IF upper(v_parent_status) <> 'RUNNING'
       OR NOT EXISTS (
         SELECT 1
           FROM public.tournament_capacity_table_receipts c
          WHERE c.table_id = NEW.table_id
            AND c.tournament_id = NEW.tournament_id
       ) THEN
      RAISE EXCEPTION
        'TOURNAMENT_CAPACITY_RECEIPT_REQUIRED: RUNNING table % must create its canonical capacity receipt in the same transaction',
        NEW.table_id
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.origin_kind = 'launch' THEN
    IF upper(v_parent_status) <> 'REGISTERING'
       OR NOT EXISTS (
         SELECT 1
           FROM public.tournament_launch_receipts r
          WHERE r.tournament_id = NEW.tournament_id
            AND r.launch_id = NEW.launch_id
            AND r.lease_generation = NEW.launch_lease_generation
            AND r.completed_at IS NULL
       ) THEN
      RAISE EXCEPTION
        'STALE_TOURNAMENT_LAUNCH_TABLE: table % does not belong to the exact incomplete launch receipt',
        NEW.table_id
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.origin_kind = 'prelaunch' THEN
    IF upper(v_parent_status) = 'RUNNING'
       OR EXISTS (
         SELECT 1
           FROM public.tournament_launch_receipts r
          WHERE r.tournament_id = NEW.tournament_id
       ) THEN
      RAISE EXCEPTION
        'TOURNAMENT_PRELAUNCH_ORIGIN_STALE: table % crossed a launch boundary in its birth transaction',
        NEW.table_id
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.origin_kind = 'legacy' THEN
    RETURN NEW;
  ELSE
    RAISE EXCEPTION 'unknown tournament table origin %', NEW.origin_kind
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP FUNCTION IF EXISTS public.fn_stage_a_bridge_legacy_capacity_receipt(uuid,uuid)
  RESTRICT;

DO $assert_stage_a_legacy_capacity_bridge_retired$
DECLARE
  v_origin_source text;
BEGIN
  SELECT p.prosrc INTO STRICT v_origin_source
    FROM pg_proc p
   WHERE p.oid =
     'public.trg_validate_tournament_table_origin()'::regprocedure
     AND p.prosecdef;

  IF to_regprocedure(
       'public.fn_stage_a_bridge_legacy_capacity_receipt(uuid,uuid)'
     ) IS NOT NULL
     OR position('fn_stage_a_bridge_legacy_capacity_receipt'
                 IN v_origin_source) > 0
     OR position('tournament_capacity_table_receipts'
                 IN v_origin_source) = 0
     OR position('TOURNAMENT_CAPACITY_RECEIPT_REQUIRED'
                 IN v_origin_source) = 0 THEN
    RAISE EXCEPTION 'Stage-B capacity validation still has a legacy admission path';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.tournament_table_origins o
     WHERE o.origin_kind = 'capacity'
       AND NOT EXISTS (
         SELECT 1
           FROM public.tournament_capacity_table_receipts c
          WHERE c.table_id = o.table_id
            AND c.tournament_id = o.tournament_id
       )
  ) THEN
    RAISE EXCEPTION 'Stage-B found a capacity origin without durable receipt provenance';
  END IF;
END;
$assert_stage_a_legacy_capacity_bridge_retired$;

/* Freeze the five ledgers that can reveal an in-flight legacy final-table
   deal before inspecting them. A concurrent writer refuses this attempt;
   holding these locks through COMMIT prevents a new one from crossing between
   the proof and the strict payer/trigger activation. */
LOCK TABLE public.tournaments IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournament_obligations IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournament_payouts IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournament_final_table_deal_batches
  IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournament_final_table_deal_receipts
  IN SHARE ROW EXCLUSIVE MODE NOWAIT;

DO $refuse_inflight_legacy_final_table_deal$
BEGIN
  IF EXISTS (
    SELECT 1
     FROM public.tournaments t
     WHERE upper(COALESCE(t.status, '')) IN ('RUNNING', 'COMPLETING')
       AND (
         EXISTS (
           SELECT 1
             FROM public.tournament_final_table_deal_batches b
            WHERE b.tournament_id = t.id
         )
         OR EXISTS (
           SELECT 1
             FROM public.tournament_final_table_deal_receipts r
            WHERE r.tournament_id = t.id
         )
         OR EXISTS (
           SELECT 1
             FROM public.tournament_obligations o
            WHERE o.tournament_id = t.id
              AND o.kind = 'final_table_deal'
         )
         OR EXISTS (
           SELECT 1
             FROM public.tournament_payouts p
            WHERE p.tournament_id = t.id
              AND p.source = 'final_table_deal'
         )
       )
  ) THEN
    RAISE EXCEPTION
      'an active final-table deal has a batch or payment evidence that cannot replay; drain or resolve it before Stage B';
  END IF;
END;
$refuse_inflight_legacy_final_table_deal$;

/* Cash batches retain their owner-only payment primitives when the public
   compatibility door contracts. Each primitive calls the existing private
   obligation core in the same outer transaction. Do not relax the public gate
   or introduce a caller-controlled bypass flag. */
-- BEGIN CANONICAL TERMINAL PLACE BATCH CONTRACT
-- Version is owned by this writer; legacy p_source cannot choose semantics.
ALTER TABLE public.tournament_place_settlement_batches
 ADD COLUMN IF NOT EXISTS contract_version integer NOT NULL DEFAULT 1;
DO $canonical_place_batch_version$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_attrdef d
   ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE a.attrelid='public.tournament_place_settlement_batches'::regclass
    AND a.attname='contract_version' AND a.atttypid='integer'::regtype
    AND a.attnotnull AND pg_get_expr(d.adbin,d.adrelid)='1') THEN
  RAISE EXCEPTION 'canonical place batch version column differs';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint
  WHERE conrelid='public.tournament_place_settlement_batches'::regclass
   AND conname='tournament_place_batch_contract_version') THEN
  ALTER TABLE public.tournament_place_settlement_batches
   ADD CONSTRAINT tournament_place_batch_contract_version CHECK(contract_version IN (1,2));
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint
   WHERE conrelid='public.tournament_place_settlement_batches'::regclass
    AND conname='tournament_place_batch_contract_version' AND convalidated
    AND pg_get_constraintdef(oid)='CHECK ((contract_version = ANY (ARRAY[1, 2])))') THEN
  RAISE EXCEPTION 'canonical place batch version constraint differs';
 END IF;
END;
$canonical_place_batch_version$;

-- Verify the current cash authority's version 2 batch against its canonical
-- ladder, durable bust sequence, every paid obligation and wallet receipt.
CREATE OR REPLACE FUNCTION public.fn_ca_verify_terminal_place_batch(
 p_tournament_id uuid,p_require_terminal boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $verify_terminal_place_batch$
DECLARE
 v_t public.tournaments%ROWTYPE;
 v_b public.tournament_place_settlement_batches%ROWTYPE;
 v_e public.tournament_escrow%ROWTYPE;
 v_ladder jsonb; v_plan jsonb;
 v_field integer; v_positive integer; v_bubble_place integer;
 v_place_total numeric; v_bubble_amount numeric:=0;
 v_bubble_user uuid; v_ob public.tournament_obligations%ROWTYPE;
 v_bubble_count integer;
BEGIN
 SELECT * INTO STRICT v_t FROM public.tournaments WHERE id=p_tournament_id;
 SELECT * INTO STRICT v_b FROM public.tournament_place_settlement_batches
  WHERE tournament_id=p_tournament_id;
 IF v_b.contract_version<>2 OR v_b.mode<>'structure' OR v_b.settled_at IS NULL
  OR v_t.prize_pool_finalized IS DISTINCT FROM true
  OR v_t.prize_pool IS NULL OR v_t.prize_pool<0
  OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
  OR v_t.prize_pool<>round(v_t.prize_pool,2)
  OR v_t.prize_pool<COALESCE(v_t.guaranteed_prize,0)
 THEN RAISE EXCEPTION 'canonical terminal batch is not funded and settled'; END IF;
 SELECT count(*) INTO v_field FROM public.tournament_players
  WHERE tournament_id=p_tournament_id;
 IF v_field=0 OR
  (SELECT count(*) FROM public.tournament_players WHERE tournament_id=p_tournament_id
   AND status='winner' AND position=1)<>1
  OR (SELECT count(DISTINCT position) FROM public.tournament_players
   WHERE tournament_id=p_tournament_id)<>v_field
  OR EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=p_tournament_id
    AND (position IS NULL OR position<1 OR position>v_field
     OR status NOT IN ('winner','eliminated')
     OR (status='winner' AND position<>1)
     OR (status='eliminated' AND (eliminated_at IS NULL OR elimination_sequence IS NULL))))
  OR (SELECT count(DISTINCT elimination_sequence) FROM public.tournament_players
   WHERE tournament_id=p_tournament_id AND status='eliminated')<>v_field-1
  OR EXISTS(SELECT 1 FROM (
   SELECT position,row_number() OVER(ORDER BY elimination_sequence DESC,id)+1 AS expected
    FROM public.tournament_players WHERE tournament_id=p_tournament_id AND status='eliminated'
   ) ranked WHERE position<>expected)
 THEN RAISE EXCEPTION 'canonical terminal batch has no exact durable standings'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('place',a.place,'amount',a.amount)
   ORDER BY a.place),'[]'::jsonb),COALESCE(sum(a.amount),0),
   count(*) FILTER(WHERE a.amount>0),max(a.place)+1
 INTO v_ladder,v_place_total,v_positive,v_bubble_place
 FROM public.fn_ca_tournament_place_amounts(p_tournament_id) a;
 IF jsonb_array_length(v_ladder)=0
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_ladder) a
   WHERE (a->>'amount')::numeric<0 OR (a->>'amount')::numeric<>round((a->>'amount')::numeric,2))
 THEN RAISE EXCEPTION 'canonical terminal batch ladder is invalid'; END IF;
 IF v_t.bubble_protection AND v_bubble_place<=v_field THEN
  v_bubble_amount:=v_t.buy_in_amount;
  IF v_bubble_amount IS NULL OR v_bubble_amount<=0
   OR v_bubble_amount::text IN ('NaN','Infinity','-Infinity')
   OR v_bubble_amount<>round(v_bubble_amount,2)
  THEN RAISE EXCEPTION 'canonical terminal batch Bubble amount is invalid'; END IF;
  SELECT user_id INTO STRICT v_bubble_user FROM public.tournament_players
   WHERE tournament_id=p_tournament_id AND position=v_bubble_place AND status='eliminated';
 END IF;
 IF v_place_total+v_bubble_amount IS DISTINCT FROM v_t.prize_pool
 THEN RAISE EXCEPTION 'canonical ladder and Bubble do not allocate one pool'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('place',(a->>'place')::integer,
  'user_id',tp.user_id,'club_id',tp.club_id,'cents',round((a->>'amount')::numeric*100)::bigint)
  ORDER BY (a->>'place')::integer),'[]'::jsonb) INTO v_plan
 FROM jsonb_array_elements(v_ladder) a JOIN public.tournament_players tp
  ON tp.tournament_id=p_tournament_id AND tp.position=(a->>'place')::integer
 WHERE (a->>'amount')::numeric>0;
 IF jsonb_array_length(v_plan)<>v_positive OR v_b.place_count<>v_positive
  OR v_b.amount_owed IS DISTINCT FROM v_place_total
  OR v_b.plan_fingerprint IS DISTINCT FROM md5(v_plan::text)
  OR v_b.escrow_required<0 OR v_b.escrow_available<v_b.escrow_required
  OR v_b.escrow_required>v_t.prize_pool
  OR v_b.escrow_required<>round(v_b.escrow_required,2)
  OR v_b.escrow_available<>round(v_b.escrow_available,2)
 THEN RAISE EXCEPTION 'canonical terminal batch header or funding proof differs'; END IF;
 IF EXISTS(SELECT 1 FROM public.tournament_players tp
  LEFT JOIN LATERAL (SELECT (a->>'amount')::numeric AS amount
   FROM jsonb_array_elements(v_ladder) a WHERE (a->>'place')::integer=tp.position) expected ON true
  WHERE tp.tournament_id=p_tournament_id
   AND tp.prize IS DISTINCT FROM COALESCE(expected.amount,
    CASE WHEN tp.user_id=v_bubble_user THEN v_bubble_amount ELSE 0 END))
 THEN RAISE EXCEPTION 'canonical terminal batch prize cache differs'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_plan) a
  LEFT JOIN public.tournament_obligations o ON o.tournament_id=p_tournament_id
   AND o.kind='place' AND o.place=(a->>'place')::integer
  WHERE o.id IS NULL OR o.user_id IS DISTINCT FROM (a->>'user_id')::uuid
   OR o.amount_owed IS DISTINCT FROM (a->>'cents')::numeric/100
   OR o.amount_paid IS DISTINCT FROM o.amount_owed OR o.settled_at IS NULL)
  OR EXISTS(SELECT 1 FROM public.tournament_obligations o
   WHERE o.tournament_id=p_tournament_id AND o.kind='place'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_plan) a
     WHERE o.place=(a->>'place')::integer AND o.user_id=(a->>'user_id')::uuid
      AND o.amount_owed=(a->>'cents')::numeric/100))
 THEN RAISE EXCEPTION 'canonical terminal batch obligations differ'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_plan) a WHERE
  (SELECT COALESCE(sum(p.amount),0) FROM public.tournament_payouts p
   WHERE p.tournament_id=p_tournament_id AND p.position=(a->>'place')::integer
    AND p.user_id=(a->>'user_id')::uuid) IS DISTINCT FROM (a->>'cents')::numeric/100)
  OR EXISTS(SELECT 1 FROM public.tournament_payouts p
   WHERE p.tournament_id=p_tournament_id AND p.position IS NOT NULL AND
    (NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_plan) a
      WHERE p.position=(a->>'place')::integer AND p.user_id=(a->>'user_id')::uuid)
     OR p.amount IS NULL OR p.amount<=0 OR p.amount<>round(p.amount,2)
     OR p.idempotency_key IS NULL OR NOT EXISTS(
      SELECT 1 FROM public.wallet_credit_idempotency k WHERE k.key=p.idempotency_key
       AND k.user_id=p.user_id AND k.amount=p.amount)))
 THEN RAISE EXCEPTION 'canonical terminal batch payout or wallet receipt differs'; END IF;
 SELECT count(*) INTO v_bubble_count FROM public.tournament_obligations
  WHERE tournament_id=p_tournament_id AND kind='bubble_protection';
 IF v_bubble_amount>0 THEN
  SELECT * INTO STRICT v_ob FROM public.tournament_obligations
   WHERE tournament_id=p_tournament_id AND kind='bubble_protection';
  IF v_bubble_count<>1 OR v_ob.place IS NOT NULL OR v_ob.user_id IS DISTINCT FROM v_bubble_user
   OR v_ob.amount_owed IS DISTINCT FROM v_bubble_amount OR v_ob.amount_paid IS DISTINCT FROM v_bubble_amount
   OR v_ob.settled_at IS NULL
   OR v_ob.source IS NULL
   OR v_ob.source NOT IN ('engine.eliminatePlayer','engine.atomicPlaceSettlement','engine.fn_settle_tournament_places','engine.fn_settle_tournament_bubble_protection')
   OR v_b.bubble_contract_required IS DISTINCT FROM true
   OR v_b.bubble_obligation_id IS DISTINCT FROM v_ob.id
   OR v_b.bubble_user_id IS DISTINCT FROM v_bubble_user
   OR v_b.bubble_source IS DISTINCT FROM v_ob.source
   OR v_b.bubble_amount_owed IS DISTINCT FROM v_bubble_amount
   OR v_b.bubble_amount_paid_before<0 OR v_b.bubble_amount_paid_before>v_bubble_amount
   OR (SELECT COALESCE(sum(amount),0) FROM public.tournament_payouts
    WHERE tournament_id=p_tournament_id AND source='bubble_protection')<>v_bubble_amount
   OR EXISTS(SELECT 1 FROM public.tournament_payouts p
    WHERE p.tournament_id=p_tournament_id AND p.source='bubble_protection'
     AND (p.position IS NOT NULL OR p.user_id IS DISTINCT FROM v_bubble_user OR p.amount<=0
      OR p.amount<>round(p.amount,2) OR p.idempotency_key IS NULL
      OR NOT EXISTS(SELECT 1 FROM public.wallet_credit_idempotency k
       WHERE k.key=p.idempotency_key AND k.user_id=p.user_id AND k.amount=p.amount)))
  THEN RAISE EXCEPTION 'canonical terminal batch Bubble proof differs'; END IF;
 ELSIF v_bubble_count<>0 OR v_b.bubble_contract_required IS DISTINCT FROM false
  OR v_b.bubble_obligation_id IS NOT NULL OR v_b.bubble_user_id IS NOT NULL
  OR v_b.bubble_source IS NOT NULL OR v_b.bubble_amount_owed<>0
  OR v_b.bubble_amount_paid_before<>0
  OR EXISTS(SELECT 1 FROM public.tournament_payouts
   WHERE tournament_id=p_tournament_id AND source='bubble_protection')
 THEN RAISE EXCEPTION 'canonical terminal batch has uncontracted Bubble evidence'; END IF;
 SELECT * INTO STRICT v_e FROM public.tournament_escrow WHERE tournament_id=p_tournament_id;
 IF v_e.enforced IS DISTINCT FROM true OR v_e.prize_balance IS DISTINCT FROM 0::numeric
  OR (p_require_terminal AND (v_e.bounty_balance IS DISTINCT FROM 0::numeric
   OR v_e.fee_balance IS DISTINCT FROM 0::numeric OR v_e.closed_at IS NULL
   OR EXISTS(SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
    WHERE t.tournament_id=p_tournament_id AND (s.left_at IS NULL OR s.status IS DISTINCT FROM 'left'))))
 THEN RAISE EXCEPTION 'canonical terminal batch has open custody or seats'; END IF;
 RETURN jsonb_build_object('ok',true,'contract_version',2,'place_total',v_place_total,
  'bubble_amount',v_bubble_amount,'place_count',v_positive,'plan_fingerprint',v_b.plan_fingerprint);
END;
$verify_terminal_place_batch$;
REVOKE ALL ON FUNCTION public.fn_ca_verify_terminal_place_batch(uuid,boolean)
 FROM PUBLIC,anon,authenticated,service_role;

DO $contract_terminal_place_batch$
DECLARE
 v_oid oid; v_definition text; v_source text; v_before jsonb; v_after jsonb;
BEGIN
 v_oid:=to_regprocedure('public.fn_settle_tournament_places(uuid,uuid)');
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_oid AND proowner='postgres'::regrole
  AND prosecdef AND proconfig=ARRAY['search_path=public','statement_timeout=30s']::text[]
  AND prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql'))
  OR has_function_privilege('anon',v_oid,'EXECUTE')
  OR has_function_privilege('authenticated',v_oid,'EXECUTE')
  OR NOT has_function_privilege('service_role',v_oid,'EXECUTE') THEN
  RAISE EXCEPTION 'canonical place batch prerequisite metadata differs: fn_settle_tournament_places';
 END IF;
 SELECT prosrc,pg_get_functiondef(oid),
  jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,
   'language',prolang,'args',proargtypes::text,'defaults',pronargdefaults,'return',prorettype)
 INTO v_source,v_definition,v_before FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source) NOT IN ('d0262f4928b12eea1cc5e9175cbf2737','2fb9eb9761e248315f36df617e519512') THEN
  RAISE EXCEPTION 'canonical place batch prerequisite body differs: fn_settle_tournament_places';
 END IF;
 IF md5(v_source)='d0262f4928b12eea1cc5e9175cbf2737' THEN
  IF position($canonical_old_0_0$  v_rows integer;$canonical_old_0_0$ IN v_definition)=0 THEN RAISE EXCEPTION 'canonical batch source fragment 0/0 absent'; END IF;
  v_definition:=replace(v_definition,$canonical_old_0_0$  v_rows integer;$canonical_old_0_0$,$canonical_new_0_0$  v_rows integer;
  v_modern_batch public.tournament_place_settlement_batches%ROWTYPE;
  v_modern_replay boolean := false;
  v_modern_required numeric := 0;
  v_modern_escrow_before numeric := 0;
  v_modern_plan jsonb;
  v_modern_positive integer;
$canonical_new_0_0$);
  IF position($canonical_old_0_1$  IF lower(COALESCE(v_t.variant,'')) = 'satellite'$canonical_old_0_1$ IN v_definition)=0 THEN RAISE EXCEPTION 'canonical batch source fragment 0/1 absent'; END IF;
  v_definition:=replace(v_definition,$canonical_old_0_1$  IF lower(COALESCE(v_t.variant,'')) = 'satellite'$canonical_old_0_1$,$canonical_new_0_1$  -- A published batch is an immutable money plan. Replay it without even
  -- transiently clearing cached prizes or rewriting a frozen obligation.
  SELECT * INTO v_modern_batch FROM public.tournament_place_settlement_batches
   WHERE tournament_id=p_tournament_id FOR UPDATE;
  IF FOUND THEN
    IF v_modern_batch.contract_version<>2 OR v_modern_batch.settled_at IS NULL THEN
      RAISE EXCEPTION 'existing place batch requires its original settlement authority'
        USING ERRCODE='55000';
    END IF;
    v_modern_replay:=true;
  END IF;

  IF lower(COALESCE(v_t.variant,'')) = 'satellite'$canonical_new_0_1$);
  IF position($canonical_old_0_2$v_status = 'COMPLETED'$canonical_old_0_2$ IN v_definition)=0 THEN RAISE EXCEPTION 'canonical batch source fragment 0/2 absent'; END IF;
  v_definition:=replace(v_definition,$canonical_old_0_2$v_status = 'COMPLETED'$canonical_old_0_2$,$canonical_new_0_2$(v_status = 'COMPLETED' OR v_modern_replay)$canonical_new_0_2$);
  IF position($canonical_old_0_3$v_status <> 'COMPLETED'$canonical_old_0_3$ IN v_definition)=0 THEN RAISE EXCEPTION 'canonical batch source fragment 0/3 absent'; END IF;
  v_definition:=replace(v_definition,$canonical_old_0_3$v_status <> 'COMPLETED'$canonical_old_0_3$,$canonical_new_0_3$(v_status <> 'COMPLETED' AND NOT v_modern_replay)$canonical_new_0_3$);
  IF position($canonical_old_0_4$    IF v_bubble_amount > 0 THEN
      v_bubble_result :=$canonical_old_0_4$ IN v_definition)=0 THEN RAISE EXCEPTION 'canonical batch source fragment 0/4 absent'; END IF;
  v_definition:=replace(v_definition,$canonical_old_0_4$    IF v_bubble_amount > 0 THEN
      v_bubble_result :=$canonical_old_0_4$,$canonical_new_0_4$    SELECT e.prize_balance INTO STRICT v_modern_escrow_before
      FROM public.tournament_escrow e
     WHERE e.tournament_id=p_tournament_id AND e.enforced FOR UPDATE;
    SELECT COALESCE(sum(o.amount_owed-o.amount_paid),0)
      INTO v_modern_required FROM public.tournament_obligations o
     WHERE o.tournament_id=p_tournament_id AND o.kind IN ('place','bubble_protection');
    IF v_modern_required<0 OR v_modern_required<>round(v_modern_required,2)
       OR v_modern_escrow_before IS NULL
       OR v_modern_escrow_before<v_modern_required
       OR v_modern_escrow_before<>round(v_modern_escrow_before,2) THEN
      RAISE EXCEPTION 'canonical place batch lacks exact pre-credit funding'
        USING ERRCODE='23514';
    END IF;

    IF v_bubble_amount > 0 THEN
      v_bubble_result :=$canonical_new_0_4$);
  IF position($canonical_old_0_5$  RETURN jsonb_build_object(
    'ok',true,$canonical_old_0_5$ IN v_definition)=0 THEN RAISE EXCEPTION 'canonical batch source fragment 0/5 absent'; END IF;
  v_definition:=replace(v_definition,$canonical_old_0_5$  RETURN jsonb_build_object(
    'ok',true,$canonical_old_0_5$,$canonical_new_0_5$  -- This header certifies money the same authority just proved and paid.
  -- It never invents or seeds a payment, and its original funding snapshot is
  -- preserved unchanged on every retry.
  IF NOT v_modern_replay THEN
    IF v_status='COMPLETED' THEN
      RAISE EXCEPTION 'completed event has no current canonical place batch'
        USING ERRCODE='55000';
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'place',(a->>'place')::integer,'user_id',tp.user_id,'club_id',tp.club_id,
      'cents',round((a->>'amount')::numeric*100)::bigint)
      ORDER BY (a->>'place')::integer),'[]'::jsonb),count(*)
      INTO v_modern_plan,v_modern_positive
      FROM jsonb_array_elements(v_ladder) a JOIN public.tournament_players tp
       ON tp.tournament_id=p_tournament_id AND tp.position=(a->>'place')::integer
     WHERE (a->>'amount')::numeric>0;
    IF (SELECT e.prize_balance FROM public.tournament_escrow e
         WHERE e.tournament_id=p_tournament_id) IS DISTINCT FROM
         v_modern_escrow_before-v_modern_required THEN
      RAISE EXCEPTION 'canonical place batch lost its exact escrow delta'
        USING ERRCODE='23514';
    END IF;
    -- The real Bubble payer may normalize source while crediting. Record its
    -- settled identity, retaining v_bubble_paid as the pre-credit snapshot.
    IF v_bubble_amount>0 THEN
      SELECT * INTO STRICT v_bubble_ob FROM public.tournament_obligations
       WHERE tournament_id=p_tournament_id AND kind='bubble_protection';
    END IF;
    INSERT INTO public.tournament_place_settlement_batches(
      tournament_id,mode,plan_fingerprint,place_count,amount_owed,
      escrow_required,escrow_available,bubble_contract_required,
      bubble_obligation_id,bubble_user_id,bubble_source,
      bubble_amount_owed,bubble_amount_paid_before,source,settled_at,contract_version)
    VALUES(p_tournament_id,'structure',md5(v_modern_plan::text),
      v_modern_positive,v_total_expected,v_modern_required,v_modern_escrow_before,
      v_bubble_amount>0,
      CASE WHEN v_bubble_amount>0 THEN v_bubble_ob.id ELSE NULL END,
      CASE WHEN v_bubble_amount>0 THEN v_bubble_user_id ELSE NULL END,
      CASE WHEN v_bubble_amount>0 THEN v_bubble_ob.source ELSE NULL END,
      v_bubble_amount,CASE WHEN v_bubble_amount>0 THEN v_bubble_paid ELSE 0 END,
      'engine.fn_settle_tournament_places',transaction_timestamp(),2);
  END IF;
  PERFORM public.fn_ca_verify_terminal_place_batch(p_tournament_id,false);

  RETURN jsonb_build_object(
    'ok',true,$canonical_new_0_5$);
  EXECUTE v_definition;
 END IF;
 SELECT prosrc,
  jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,
   'language',prolang,'args',proargtypes::text,'defaults',pronargdefaults,'return',prorettype)
 INTO v_source,v_after FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source)<>'2fb9eb9761e248315f36df617e519512' OR v_before IS DISTINCT FROM v_after THEN
  RAISE EXCEPTION 'canonical place batch postcondition differs: fn_settle_tournament_places';
 END IF;
 v_oid:=to_regprocedure('public.trg_tournament_atomic_place_completion_guard()');
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_oid AND proowner='postgres'::regrole
  AND prosecdef AND proconfig=ARRAY['search_path=public']::text[]
  AND prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql'))
  OR has_function_privilege('anon',v_oid,'EXECUTE')
  OR has_function_privilege('authenticated',v_oid,'EXECUTE')
  OR NOT has_function_privilege('service_role',v_oid,'EXECUTE') THEN
  RAISE EXCEPTION 'canonical place batch prerequisite metadata differs: trg_tournament_atomic_place_completion_guard';
 END IF;
 SELECT prosrc,pg_get_functiondef(oid),
  jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,
   'language',prolang,'args',proargtypes::text,'defaults',pronargdefaults,'return',prorettype)
 INTO v_source,v_definition,v_before FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source) NOT IN ('3e43d26ddd36a55e736a9a304a89ba9a','1bde80d6520fbc3a93409fe88651109e') THEN
  RAISE EXCEPTION 'canonical place batch prerequisite body differs: trg_tournament_atomic_place_completion_guard';
 END IF;
 IF md5(v_source)='3e43d26ddd36a55e736a9a304a89ba9a' THEN
  IF position($canonical_old_1_0$  IF v_batch.escrow_available + 0.005 < v_batch.escrow_required THEN$canonical_old_1_0$ IN v_definition)=0 THEN RAISE EXCEPTION 'canonical batch source fragment 1/0 absent'; END IF;
  v_definition:=replace(v_definition,$canonical_old_1_0$  IF v_batch.escrow_available + 0.005 < v_batch.escrow_required THEN$canonical_old_1_0$,$canonical_new_1_0$  IF v_batch.contract_version=2 THEN
    PERFORM public.fn_ca_verify_terminal_place_batch(NEW.id,true);
    RETURN NEW;
  END IF;

  IF v_batch.escrow_available + 0.005 < v_batch.escrow_required THEN$canonical_new_1_0$);
  EXECUTE v_definition;
 END IF;
 SELECT prosrc,
  jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,
   'language',prolang,'args',proargtypes::text,'defaults',pronargdefaults,'return',prorettype)
 INTO v_source,v_after FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source)<>'1bde80d6520fbc3a93409fe88651109e' OR v_before IS DISTINCT FROM v_after THEN
  RAISE EXCEPTION 'canonical place batch postcondition differs: trg_tournament_atomic_place_completion_guard';
 END IF;
END;
$contract_terminal_place_batch$;
DO $canonical_batch_terminal_marker$
DECLARE v_oid oid:='public.trg_freeze_batched_tournament_place()'::regprocedure;
 v_source text; v_definition text; v_before jsonb; v_after jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_oid AND proowner='postgres'::regrole
   AND prosecdef AND proconfig=ARRAY['search_path=public']::text[]) THEN
  RAISE EXCEPTION 'frozen batch trigger metadata differs';
 END IF;
 SELECT prosrc,pg_get_functiondef(oid),jsonb_build_object('owner',proowner,'acl',proacl,
  'config',proconfig,'definer',prosecdef,'language',prolang,'args',proargtypes::text,'returns',prorettype)
 INTO v_source,v_definition,v_before FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source) NOT IN ('da224a232366acc2443f0ec5428567e0','5c00f4babf2e07dd86e9f47e14588b07') THEN
  RAISE EXCEPTION 'frozen batch trigger source differs';
 END IF;
 IF md5(v_source)='da224a232366acc2443f0ec5428567e0' THEN
  IF position($marker_old$  IF v_gate <> OLD.tournament_id::text THEN$marker_old$ IN v_definition)=0 THEN
   RAISE EXCEPTION 'frozen batch trigger marker anchor absent';
  END IF;
  v_definition:=replace(v_definition,$marker_old$  IF v_gate <> OLD.tournament_id::text THEN$marker_old$,$marker_new$  -- Stamp only the exact lifecycle marker after completion. Frozen monetary
  -- columns and payment gates retain their original restrictions.
  IF OLD.terminal_closed_at IS NULL AND NEW.terminal_closed_at IS NOT NULL
     AND isfinite(NEW.terminal_closed_at)
     AND (to_jsonb(NEW)-'terminal_closed_at') IS NOT DISTINCT FROM
         (to_jsonb(OLD)-'terminal_closed_at')
     AND EXISTS(SELECT 1 FROM public.tournament_place_settlement_batches b
       WHERE b.tournament_id=OLD.tournament_id AND b.contract_version=2
        AND b.settled_at IS NOT NULL)
     AND EXISTS(SELECT 1 FROM public.tournaments t
       WHERE t.id=OLD.tournament_id AND upper(t.status::text)='COMPLETED'
        AND t.ended_at IS NOT DISTINCT FROM NEW.terminal_closed_at) THEN
    PERFORM public.fn_ca_verify_terminal_place_batch(OLD.tournament_id,true);
    RETURN NEW;
  END IF;
  IF v_gate <> OLD.tournament_id::text THEN$marker_new$);
  EXECUTE v_definition;
 END IF;
 SELECT prosrc,jsonb_build_object('owner',proowner,'acl',proacl,
  'config',proconfig,'definer',prosecdef,'language',prolang,'args',proargtypes::text,'returns',prorettype)
 INTO v_source,v_after FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source)<>'5c00f4babf2e07dd86e9f47e14588b07' OR v_before IS DISTINCT FROM v_after THEN
  RAISE EXCEPTION 'frozen batch marker postcondition differs';
 END IF;
END;
$canonical_batch_terminal_marker$;
-- END CANONICAL TERMINAL PLACE BATCH CONTRACT

-- BEGIN CANONICAL TERMINAL READINESS DISPATCH
-- Only the versioned format proof changes. Shared finish claim, winner,
-- obligation, custody, rake, bounty and mystery certification remain intact.
DO $contract_terminal_batch_readiness$
DECLARE v_oid oid:='public.fn_tournament_finish_readiness(uuid,uuid)'::regprocedure;
 v_source text; v_definition text; v_before jsonb; v_after jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_oid AND proowner='postgres'::regrole
  AND prosecdef AND proconfig=ARRAY['search_path=public, pg_temp']::text[])
  OR has_function_privilege('anon',v_oid,'EXECUTE')
  OR has_function_privilege('authenticated',v_oid,'EXECUTE')
  OR has_function_privilege('service_role',v_oid,'EXECUTE') THEN
  RAISE EXCEPTION 'terminal readiness owner-only metadata differs';
 END IF;
 SELECT prosrc,pg_get_functiondef(oid),
  jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,
    'language',prolang,'args',proargtypes::text,'defaults',pronargdefaults,'return',prorettype)
 INTO v_source,v_definition,v_before FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source) NOT IN ('ac4a33b4428ca68fb385b7de764a8590','993e6e1de9edba2fe235d86ff6c243c9','0388659818612493c16b02048dae5b3f') THEN RAISE EXCEPTION 'terminal readiness source differs'; END IF;
 IF md5(v_source)='ac4a33b4428ca68fb385b7de764a8590' THEN
  IF position($readiness_old_0$  v_bad_satellite_seats integer := 0;$readiness_old_0$ IN v_definition)=0 THEN RAISE EXCEPTION 'readiness fragment 0 absent'; END IF;
  v_definition:=replace(v_definition,$readiness_old_0$  v_bad_satellite_seats integer := 0;$readiness_old_0$,$readiness_new_0$  v_modern_place boolean := false;
  v_modern_deal boolean := false;
  v_bad_satellite_seats integer := 0;$readiness_new_0$);
  IF position($readiness_old_1$  v_kind := public.fn_tournament_finish_kind(p_tournament_id);$readiness_old_1$ IN v_definition)=0 THEN RAISE EXCEPTION 'readiness fragment 1 absent'; END IF;
  v_definition:=replace(v_definition,$readiness_old_1$  v_kind := public.fn_tournament_finish_kind(p_tournament_id);$readiness_old_1$,$readiness_new_1$  v_kind := public.fn_tournament_finish_kind(p_tournament_id);
  IF v_kind='normal' THEN
    SELECT COALESCE((to_jsonb(b)->>'contract_version')::integer,1)=2
      INTO v_modern_place FROM public.tournament_place_settlement_batches b
     WHERE b.tournament_id=p_tournament_id;
  ELSIF v_kind='final_table_deal' THEN
    SELECT COALESCE((to_jsonb(b)->>'contract_version')::integer,1)=2
      INTO v_modern_deal FROM public.tournament_final_table_deal_batches b
     WHERE b.tournament_id=p_tournament_id;
  END IF;
  v_modern_place:=COALESCE(v_modern_place,false);
  v_modern_deal:=COALESCE(v_modern_deal,false);
$readiness_new_1$);
  IF position($readiness_old_2$  IF v_kind <> 'satellite' THEN$readiness_old_2$ IN v_definition)=0 THEN RAISE EXCEPTION 'readiness fragment 2 absent'; END IF;
  v_definition:=replace(v_definition,$readiness_old_2$  IF v_kind <> 'satellite' THEN$readiness_old_2$,$readiness_new_2$  IF v_kind <> 'satellite' AND NOT v_modern_place AND NOT v_modern_deal THEN$readiness_new_2$);
  IF position($readiness_old_3$    SELECT round(COALESCE(sum(o.amount_owed),0),2) INTO v_place_owed$readiness_old_3$ IN v_definition)=0 THEN RAISE EXCEPTION 'readiness fragment 3 absent'; END IF;
  v_definition:=replace(v_definition,$readiness_old_3$    SELECT round(COALESCE(sum(o.amount_owed),0),2) INTO v_place_owed$readiness_old_3$,$readiness_new_3$    IF v_modern_place THEN
      BEGIN
        v_domain_check:=public.fn_ca_verify_terminal_place_batch(p_tournament_id,true);
        IF COALESCE((v_domain_check->>'ok')::boolean,false) IS NOT TRUE THEN
          RAISE EXCEPTION 'canonical place proof refused';
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_failures:=v_failures||jsonb_build_array(jsonb_build_object(
          'code','canonical_place_batch_not_proven','detail',SQLERRM));
      END;
    END IF;

    SELECT round(COALESCE(sum(o.amount_owed),0),2) INTO v_place_owed$readiness_new_3$);
  IF position($readiness_old_4$    IF abs(v_place_owed - round(COALESCE(v_t.prize_pool,0),2)) > 0.005 THEN$readiness_old_4$ IN v_definition)=0 THEN RAISE EXCEPTION 'readiness fragment 4 absent'; END IF;
  v_definition:=replace(v_definition,$readiness_old_4$    IF abs(v_place_owed - round(COALESCE(v_t.prize_pool,0),2)) > 0.005 THEN$readiness_old_4$,$readiness_new_4$    IF NOT v_modern_place AND abs(v_place_owed - round(COALESCE(v_t.prize_pool,0),2)) > 0.005 THEN$readiness_new_4$);
  IF position($readiness_old_5$      v_domain_check := public.fn_check_atomic_final_table_deal(p_tournament_id);$readiness_old_5$ IN v_definition)=0 THEN RAISE EXCEPTION 'readiness fragment 5 absent'; END IF;
  v_definition:=replace(v_definition,$readiness_old_5$      v_domain_check := public.fn_check_atomic_final_table_deal(p_tournament_id);$readiness_old_5$,$readiness_new_5$      IF v_modern_deal THEN
        BEGIN
          v_domain_check:=public.fn_ca_verify_terminal_final_deal_batch(p_tournament_id,true);
        EXCEPTION WHEN OTHERS THEN
          v_domain_check:=jsonb_build_object('ok',false,'reason',SQLERRM);
        END;
      ELSE
        v_domain_check := public.fn_check_atomic_final_table_deal(p_tournament_id);
      END IF;$readiness_new_5$);
  EXECUTE v_definition;
 END IF;
 SELECT prosrc,
  jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,
    'language',prolang,'args',proargtypes::text,'defaults',pronargdefaults,'return',prorettype)
 INTO v_source,v_after FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source) NOT IN ('993e6e1de9edba2fe235d86ff6c243c9','0388659818612493c16b02048dae5b3f') OR v_before IS DISTINCT FROM v_after THEN RAISE EXCEPTION 'readiness source or metadata postcondition differs'; END IF;
END;
$contract_terminal_batch_readiness$;
-- END CANONICAL TERMINAL READINESS DISPATCH

DO $contract_cash_batch_payers$
DECLARE
  v_row record;
  v_source text;
  v_definition text;
  v_old CONSTANT text := 'public.fn_settle_tournament_obligation(';
  v_new CONSTANT text := 'public.fn_settle_tournament_obligation_before_atomic_batch_gate(';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
     WHERE p.oid=to_regprocedure(
       'public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)')
       AND md5(p.prosrc)='ebabbaf0456d80335aaa2e04471d0ab6'
       AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
       AND l.lanname='plpgsql'
       AND p.proconfig=ARRAY['search_path=public']::text[]
  ) THEN
    RAISE EXCEPTION 'Stage-B cash contraction requires the exact private obligation core';
  END IF;

  FOR v_row IN SELECT * FROM (VALUES
    ('public.fn_ca_settle_tournament_place_raw(uuid,integer,uuid,numeric)',
     '329237bd65214e17d4ca3298f363f248', '3585ddbfdb0a197243d5e6eefb6b670f'),
    ('public.fn_ca_settle_tournament_bubble_raw(uuid,uuid,numeric)',
     '3a5a0f079b7884a5bd2e6bfe6a15ccb7', 'f1fc7a0bf480b1034f0f1d9cba3b4d0b'),
    ('public.fn_ca_settle_final_table_deal_share_raw(uuid,uuid,numeric)',
     '58e2768644b692f23a9a071a8a5d1ee8', '852e35483b67c1fc59b6347b51c79cb8')
  ) expected(identity, before_md5, after_md5)
  LOOP
    SELECT p.prosrc, pg_get_functiondef(p.oid)
      INTO v_source, v_definition
      FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
     WHERE p.oid=to_regprocedure(v_row.identity)
       AND md5(p.prosrc) IN (v_row.before_md5,v_row.after_md5)
       AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
       AND l.lanname='plpgsql'
       AND p.proconfig=ARRAY['search_path=public']::text[];
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Stage-B cash payer source differs: %',v_row.identity;
    END IF;
    IF md5(v_source)=v_row.before_md5 AND (
       (length(v_source)-length(replace(v_source,v_old,''))) IS DISTINCT FROM length(v_old)
       OR position(v_new IN v_source)>0) THEN
      RAISE EXCEPTION 'Stage-B cash payer preimage differs: %',v_row.identity;
    END IF;
    IF md5(v_source)=v_row.after_md5 AND (
       position(v_old IN v_source)>0
       OR (length(v_source)-length(replace(v_source,v_new,''))) IS DISTINCT FROM length(v_new)) THEN
      RAISE EXCEPTION 'Stage-B cash payer postimage differs: %',v_row.identity;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(
        COALESCE(p.proacl,acldefault('f',p.proowner))) privilege
       WHERE p.oid=to_regprocedure(v_row.identity)
         AND privilege.privilege_type='EXECUTE'
         AND privilege.grantee<>p.proowner
    ) OR has_function_privilege('anon',v_row.identity,'EXECUTE')
      OR has_function_privilege('authenticated',v_row.identity,'EXECUTE')
      OR has_function_privilege('service_role',v_row.identity,'EXECUTE') THEN
      RAISE EXCEPTION 'Stage-B cash payer is not owner-only: %',v_row.identity;
    END IF;

    IF md5(v_source)=v_row.before_md5 THEN
      EXECUTE replace(v_definition,v_old,v_new);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
       WHERE p.oid=to_regprocedure(v_row.identity)
         AND md5(p.prosrc)=v_row.after_md5
         AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
         AND l.lanname='plpgsql'
         AND p.proconfig=ARRAY['search_path=public']::text[]
         AND position(v_old IN p.prosrc)=0
         AND (length(p.prosrc)-length(replace(p.prosrc,v_new,'')))=length(v_new)
    ) OR EXISTS (
      SELECT 1 FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(
        COALESCE(p.proacl,acldefault('f',p.proowner))) privilege
       WHERE p.oid=to_regprocedure(v_row.identity)
         AND privilege.privilege_type='EXECUTE'
         AND privilege.grantee<>p.proowner
    ) OR has_function_privilege('anon',v_row.identity,'EXECUTE')
      OR has_function_privilege('authenticated',v_row.identity,'EXECUTE')
      OR has_function_privilege('service_role',v_row.identity,'EXECUTE') THEN
      RAISE EXCEPTION 'Stage-B cash payer postcondition differs: %',v_row.identity;
    END IF;
  END LOOP;
END;
$contract_cash_batch_payers$;

CREATE OR REPLACE FUNCTION public.fn_settle_tournament_obligation(
  p_tournament_id uuid,
  p_kind text,
  p_place integer,
  p_user_id uuid,
  p_amount numeric,
  p_source text,
  p_description text DEFAULT NULL,
  p_adjustment_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_kind text := lower(btrim(COALESCE(p_kind, '')));
  v_atomic_kinds CONSTANT text[] := ARRAY[
    'place', 'late_reg_adjustment', 'bubble_protection',
    'final_table_deal', 'satellite_remainder', 'seat'
  ];
BEGIN
  -- Keep the current exact-refund door authoritative for every input shape.
  IF v_kind='refund' THEN
    RETURN jsonb_build_object('ok',false,'paid',0,'already_paid',0,
      'refused_reason','exact_refund_authority_required','obligation_id',NULL,
      'idempotency_key',NULL);
  END IF;
  /* Preserve the private core's canonical validation responses for malformed
     calls and non-structure classes. Every valid structure class is private to
     its complete atomic transaction, regardless of tournament format. */
  IF p_tournament_id IS NULL OR p_user_id IS NULL
     OR round(COALESCE(p_amount, 0), 2) < 0
     OR v_kind NOT IN ('place','bounty','bounty_residual','mystery_bounty',
                       'refund','seat','satellite_remainder',
                       'bubble_protection','final_table_deal',
                       'late_reg_adjustment')
     OR (v_kind IN ('place', 'late_reg_adjustment') AND p_place IS NULL)
     OR NOT (v_kind = ANY(v_atomic_kinds)) THEN
    RETURN public.fn_settle_tournament_obligation_before_atomic_batch_gate(
      p_tournament_id, p_kind, p_place, p_user_id, p_amount, p_source,
      p_description, p_adjustment_id);
  END IF;

  RETURN jsonb_build_object(
    'ok', false, 'paid', 0, 'already_paid', 0,
    'refused_reason', 'atomic_batch_required', 'obligation_id', NULL,
    'idempotency_key', NULL,
    'detail', 'prize-pool money, including satellite seats and cash remainder, moves only inside its complete atomic batch');
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_settle_tournament_obligation(
  uuid, text, integer, uuid, numeric, text, text, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_obligation(
  uuid, text, integer, uuid, numeric, text, text, uuid
) TO service_role;

COMMENT ON FUNCTION public.fn_settle_tournament_obligation(
  uuid, text, integer, uuid, numeric, text, text, uuid
) IS
  'Strict Stage-B single-obligation payer for non-pool money. Every prize-pool kind, including satellite seats and cash remainder, is refused for every tournament format; only private cores inside complete atomic batch functions may move that money.';

ALTER TABLE public.tournaments
  ENABLE TRIGGER aaa_guard_atomic_satellite_completion;
ALTER TABLE public.tournaments
  ENABLE TRIGGER zzzz_tournaments_atomic_place_completion_guard;
ALTER TABLE public.tournaments
  ENABLE TRIGGER zzzzz_tournaments_atomic_final_table_deal_completion_guard;
ALTER TABLE public.tournaments
  ENABLE TRIGGER aa_guard_tournament_completing_claim;
ALTER TABLE public.tournaments
  ENABLE TRIGGER zzzzzz_tournaments_financial_certificate;
ALTER TABLE public.tournaments
  ENABLE TRIGGER zzzz_tournament_pool_finalization_window_guard;
ALTER TABLE public.tournaments
  ENABLE TRIGGER zzzz_freeze_finalized_tournament_prize_pool;

/* Historical completion evidence remains unchanged. Enabling the guards
   constrains future writes; historical certificate review belongs to Phase 9. */

/* The atomic engines are now the only running builds, so retire the complete
   deferred payout-repair graph in this contraction transaction. Stage A left
   these exact RPCs and dispatch routes alive for rolling compatibility with
   older processes. RESTRICT makes an unknown database dependency abort the
   cutover instead of being cascade-dropped. */
DO $retire_applying_rpc_authority$
BEGIN
  IF to_regprocedure('public.fn_tournament_payout_sweep(integer,boolean,integer)')
     IS NOT NULL THEN
    EXECUTE
      'REVOKE ALL ON FUNCTION public.fn_tournament_payout_sweep(integer, boolean, integer) FROM PUBLIC, anon, authenticated, service_role';
  END IF;
  IF to_regprocedure('public.fn_ca_backpay_guarantee_shortfalls(boolean,integer)')
     IS NOT NULL THEN
    EXECUTE
      'REVOKE ALL ON FUNCTION public.fn_ca_backpay_guarantee_shortfalls(boolean, integer) FROM PUBLIC, anon, authenticated, service_role';
  END IF;
  IF to_regprocedure('public.sp_ca_reconcile_backpaid_events(boolean)')
     IS NOT NULL THEN
    EXECUTE
      'REVOKE ALL ON PROCEDURE public.sp_ca_reconcile_backpaid_events(boolean) FROM PUBLIC, anon, authenticated, service_role';
  END IF;
  IF to_regclass('public.ca_settle_sources') IS NOT NULL THEN
    EXECUTE
      'DELETE FROM public.ca_settle_sources WHERE lower(source) = ANY($1)'
      USING ARRAY[
        'reconcile',
        'fn_tournament_payout_reconcile',
        'fn_pay_backed_payout_shortfalls',
        'fn_ca_backpay_guarantee_shortfalls',
        'fn_tournament_payout_sweep',
        'sp_ca_reconcile_backpaid_events',
        'fn_backpay_hu_winner_shortfalls'
      ]::text[];
  END IF;
END;
$retire_applying_rpc_authority$;

/* A removed RPC must not remain discoverable as a dormant money path. The
   historical payout and alert rows stay intact; only executable and dispatch
   authority is retired. */
DELETE FROM public.ca_money_rpc_registry
 WHERE proname IN (
   'fn_tournament_payout_reconcile',
   'fn_pay_backed_payout_shortfalls',
   'fn_ca_backpay_guarantee_shortfalls',
   'fn_tournament_payout_sweep',
   'sp_ca_reconcile_backpaid_events',
   'fn_backpay_hu_winner_shortfalls'
 );

DO $retire_applying_sweep$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    PERFORM cron.unschedule(j.jobid)
      FROM cron.job j
     WHERE j.jobname = 'ca-payout-sweep-hourly'
        OR j.command ~* '(fn_tournament_payout_sweep|fn_tournament_payout_reconcile|fn_pay_backed_payout_shortfalls|fn_ca_backpay_guarantee_shortfalls|sp_ca_reconcile_backpaid_events|fn_backpay_hu_winner_shortfalls)';
  END IF;
END;
$retire_applying_sweep$;

DO $retire_legacy_roster$
BEGIN
  IF to_regclass('public.ca_expected_cron_jobs') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.ca_expected_cron_jobs WHERE jobname = $1'
      USING 'ca-payout-sweep-hourly';
  END IF;
END;
$retire_legacy_roster$;

DROP PROCEDURE IF EXISTS public.sp_ca_reconcile_backpaid_events(boolean) RESTRICT;
DROP FUNCTION IF EXISTS public.fn_tournament_payout_sweep(integer, boolean, integer) RESTRICT;
DROP FUNCTION IF EXISTS public.fn_pay_backed_payout_shortfalls(boolean, integer) RESTRICT;
DROP FUNCTION IF EXISTS public.fn_ca_backpay_guarantee_shortfalls(boolean, integer) RESTRICT;
DROP FUNCTION IF EXISTS public.fn_backpay_hu_winner_shortfalls(integer) RESTRICT;
DROP FUNCTION IF EXISTS public.fn_tournament_payout_reconcile(uuid, boolean) RESTRICT;

/* Retiring an executable repair path does not resolve its historical findings. */

REVOKE ALL ON SCHEMA smarter_private
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT USAGE ON SCHEMA smarter_private TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION smarter_private.fn_smarter_data_api_pre_request()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_headers jsonb;
  v_claims jsonb;
  v_actor text;
  v_protocol text;
  v_request_role text;
  v_method text;
  v_path text;
  v_tournament_id uuid;
  v_lease_generation uuid;
  v_stale_seconds constant integer := 30;
  v_manager_exclusive_paths constant text[] := ARRAY[
    'rpc/fn_settle_satellite_tournament',
    'rpc/fn_complete_tournament_terminal',
    'rpc/fn_ca_reprice_unpaid_tournament_place',
    'rpc/fn_assign_tournament_player_seat_atomic',
    'rpc/fn_ack_tournament_capacity_tables',
    'rpc/fn_begin_tournament_launch_atomic',
    'rpc/fn_bounty_obligation_has_complete_marker',
    'rpc/fn_claim_tournament_bounty_elimination',
    'rpc/fn_close_tournament_addon_period',
    'rpc/fn_close_empty_tournament_table',
    'rpc/fn_close_tournament_entry_window',
    'rpc/fn_collect_bounty',
    'rpc/fn_complete_tournament_entry_reprice',
    'rpc/fn_complete_tournament_launch_atomic',
    'rpc/fn_complete_tournament_terminal_proposal',
    'rpc/fn_begin_tournament_deal_review',
    'rpc/fn_close_tournament_deal_review',
    'rpc/fn_decline_tournament_rebuy',
    'rpc/fn_eliminate_tournament_player_atomic',
    'rpc/fn_ensure_late_registration_capacity',
    'rpc/fn_get_tournament_satellite_entitlement_depth',
    'rpc/fn_mystery_bounty_pay',
    'rpc/fn_mystery_bounty_reserve',
    'rpc/fn_mystery_bounty_reveal',
    'rpc/fn_mystery_bounty_seed',
    'rpc/fn_move_tournament_player',
    'rpc/fn_move_tournament_player_atomic',
    'rpc/fn_open_tournament_rebuy_decisions',
    'rpc/fn_settle_final_table_deal_atomic',
    'rpc/fn_spin_draw_and_settle_atomic',
    'rpc/fn_spin_draw_multiplier',
    'rpc/fn_spin_settle_game',
    'rpc/fn_sync_tournament_live_seat_chips',
    'rpc/fn_tournament_has_unsettled_bounties',
    'rpc/process_tournament_rebuy'
  ]::text[];
  v_engine_service_paths constant text[] := ARRAY[
    'rpc/fn_resolve_tournament_terminal_proposal_outcome',
    'rpc/fn_resolve_tournament_terminal_outcome',
    'rpc/fn_resolve_satellite_settlement_outcome',
    'rpc/fn_prove_played_spin_launch_recovery',
    'rpc/fn_get_tournament_deal_consensus',
    'rpc/claim_table_lease_v2',
    'rpc/claim_tournament_lease_v2',
    'rpc/fn_ack_tournament_manager_wakes',
    'rpc/fn_apply_prize_guarantee',
    'rpc/fn_ca_commit_hand_settlement',
    'rpc/fn_ca_process_hand_post_commit_obligations',
    'rpc/fn_certify_tournament_finish',
    'rpc/fn_claim_tournament_finish',
    'rpc/fn_finalize_bounty_pool',
    'rpc/fn_mystery_bounty_settle',
    'rpc/fn_normalize_tournament_final_standings',
    'rpc/fn_prepare_tournament_place_obligations',
    'rpc/fn_project_hand_side_effects',
    'rpc/fn_settle_satellite_finish_atomic',
    'rpc/fn_settle_tournament_obligation',
    'rpc/fn_settle_tournament_places_atomic',
    'rpc/fn_settle_tournament_rake',
    'rpc/fn_sweep_pending_tournament_bounties',
    'rpc/fn_sync_seat_first_player_count',
    'rpc/heartbeat_table_leases_v3',
    'rpc/heartbeat_tournament_leases_v3',
    'rpc/heartbeat_tournament_leases_v4',
    'rpc/release_table_leases_v2',
    'rpc/release_tournament_leases_v2'
  ]::text[];
BEGIN
  BEGIN
    v_headers := COALESCE(
      NULLIF(current_setting('request.headers', true), '')::jsonb,
      '{}'::jsonb
    );
    v_claims := COALESCE(
      NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
      '{}'::jsonb
    );
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: malformed PostgREST request context'
      USING ERRCODE = '22023';
  END;

  v_actor := lower(btrim(COALESCE(v_headers ->> 'x-smarter-data-actor', '')));
  v_protocol := btrim(COALESCE(v_headers ->> 'x-smarter-data-protocol', ''));
  /* SECURITY DEFINER makes current_user the function owner.  The JWT claims
     supplied and verified by PostgREST are the request identity here. */
  v_request_role := btrim(COALESCE(auth.role(), ''));
  IF v_actor <> ''
     AND v_request_role <> btrim(COALESCE(v_claims ->> 'role', '')) THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: verified JWT role disagrees with request claims'
      USING ERRCODE = '22023';
  END IF;
  v_method := upper(btrim(COALESCE(current_setting('request.method', true), '')));
  v_path := lower(btrim(COALESCE(current_setting('request.path', true), ''), '/'));
  /* Direct PostgREST reports `rpc/name`; Supabase gateways may retain the
     `rest/v1/` prefix. Normalize both shapes before applying the same exact
     route allowlist. Never use a suffix/substring match for authority. */
  IF left(v_path, 8) = 'rest/v1/' THEN
    v_path := substr(v_path, 9);
  END IF;

  /* Transaction-local settings are reset by PostgreSQL at transaction end,
     but clear the proof explicitly before evaluating this request as a
     fail-closed defence against an incorrectly pooled session. */
  PERFORM set_config('app.smarter_manager_request_fenced', '', true);
  PERFORM set_config('app.smarter_manager_deleted_table_ids', '', true);

  IF v_path = 'rpc/fn_smarter_data_api_pre_request' THEN
    RAISE EXCEPTION 'DATA_ACTOR_FORBIDDEN: request hook is not an RPC'
      USING ERRCODE = '42501';
  END IF;

  /* This hook is shared by the entire estate. Do not turn the shared
     service-role credential into a Club-Arena-only protocol. Restrict only
     the RPC routes whose authority belongs to the engine. Manager-exclusive
     routes fail when a callback loses its bound manager context; recovery and
     lease-coordination routes accept the explicitly marked service actor too.
     Old/headerless engine binaries can use neither family after cutover. */
  -- Rebuy, decline and mystery reveal are shared player/manager RPCs. Their
  -- authenticated callers retain each function's own player/session checks
  -- (reveal uses auth.uid(), never supplied actor/auto) and receive no manager
  -- proof. All server callers still require their exact manager lease.
  IF v_path = ANY(v_manager_exclusive_paths)
     AND v_actor IS DISTINCT FROM 'tournament-manager'
     AND NOT (
       v_request_role = 'authenticated'
       AND v_actor = ''
       AND v_path IN (
         'rpc/process_tournament_rebuy', 'rpc/fn_decline_tournament_rebuy',
         'rpc/fn_mystery_bounty_reveal'
       )
     ) THEN
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_AUTHORITY_REQUIRED: manager RPC requires exact lease authority'
      USING ERRCODE = '42501';
  END IF;
  IF v_path = ANY(v_engine_service_paths)
     AND v_actor NOT IN ('service', 'tournament-manager') THEN
    RAISE EXCEPTION
      'ENGINE_DATA_AUTHORITY_REQUIRED: engine RPC requires an identified service actor'
      USING ERRCODE = '42501';
  END IF;

  /* Unrelated World Hub/Club Arena service traffic deliberately remains
     compatible when unmarked. Browser traffic keeps its normal unmarked
     shape too. Only the engine-private paths above require identification. */
  IF v_actor = '' THEN
    IF v_request_role = 'service_role' THEN
      PERFORM set_config('app.smarter_data_actor', 'shared-estate-service', true);
    ELSE
      PERFORM set_config('app.smarter_data_actor', 'browser', true);
    END IF;
    PERFORM set_config('app.smarter_tournament_id', '', true);
    PERFORM set_config('app.smarter_tournament_lease_generation', '', true);
    RETURN;
  END IF;

  IF v_request_role <> 'service_role' THEN
    RAISE EXCEPTION 'DATA_ACTOR_FORBIDDEN: marked server actor requires service_role'
      USING ERRCODE = '42501';
  END IF;

  IF v_actor = 'service' THEN
    IF v_protocol <> '1'
       OR length(btrim(COALESCE(v_headers ->> 'x-smarter-tournament-id', ''))) > 0
       OR length(
            btrim(
              COALESCE(v_headers ->> 'x-smarter-tournament-lease-generation', '')
            )
          ) > 0 THEN
      RAISE EXCEPTION 'DATA_ACTOR_INVALID: service authority headers are inconsistent'
        USING ERRCODE = '22023';
    END IF;
    PERFORM set_config('app.smarter_data_actor', 'service', true);
    PERFORM set_config('app.smarter_tournament_id', '', true);
    PERFORM set_config('app.smarter_tournament_lease_generation', '', true);
    RETURN;
  END IF;

  IF v_actor <> 'tournament-manager' OR v_protocol <> '2' THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: unknown actor or protocol'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_tournament_id := (v_headers ->> 'x-smarter-tournament-id')::uuid;
    v_lease_generation :=
      (v_headers ->> 'x-smarter-tournament-lease-generation')::uuid;
  EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: manager authority requires two UUIDs'
      USING ERRCODE = '22023';
  END;
  IF v_tournament_id IS NULL OR v_lease_generation IS NULL THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: manager authority requires two UUIDs'
      USING ERRCODE = '22023';
  END IF;

  IF v_method IN ('GET', 'HEAD', 'OPTIONS') THEN
    PERFORM 1
      FROM public.engine_tournament_leases l
     WHERE l.tournament_id = v_tournament_id
       AND l.protocol_version = 2
       AND l.lease_generation = v_lease_generation
       AND l.heartbeat_at >=
           clock_timestamp() - make_interval(secs => v_stale_seconds);
  ELSE
    PERFORM 1
      FROM public.engine_tournament_leases l
     WHERE l.tournament_id = v_tournament_id
       AND l.protocol_version = 2
       AND l.lease_generation = v_lease_generation
       AND l.heartbeat_at >=
           clock_timestamp() - make_interval(secs => v_stale_seconds)
     FOR KEY SHARE;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_FENCED: lease generation is no longer current'
      USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('app.smarter_data_actor', 'tournament-manager', true);
  PERFORM set_config('app.smarter_tournament_id', v_tournament_id::text, true);
  PERFORM set_config(
    'app.smarter_tournament_lease_generation',
    v_lease_generation::text,
    true
  );
  /* This marker is written last and only after the exact lease row is held
     FOR KEY SHARE. Row triggers can consume this transaction proof without doing
     the same indexed lease read again for every affected row. */
  PERFORM set_config('app.smarter_manager_request_fenced', 'protocol-2', true);
END;
$function$;

REVOKE ALL ON FUNCTION smarter_private.fn_smarter_data_api_pre_request()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION smarter_private.fn_smarter_data_api_pre_request()
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION smarter_private.fn_smarter_data_api_pre_request() IS
  'Private, non-API Stage-B shared-estate Data API boundary. Unrelated unmarked service_role traffic remains valid; engine-private routes require an identified actor; protocol-2 tournament managers must hold and transaction-lock one exact fresh generation.';

DROP FUNCTION IF EXISTS public.fn_smarter_data_api_pre_request();

/* A marked manager is not merely "some manager".  Every direct row it touches
   must resolve to the same tournament named by the transaction-local request
   proof. The pre-request hook already holds the exact lease FOR KEY SHARE for the
   complete PostgREST transaction. Re-reading that same row once per affected
   row would add hot-path work without strengthening the lock. */
CREATE OR REPLACE FUNCTION public.fn_assert_tournament_manager_write_scope(
  p_tournament_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_tournament_id uuid;
  v_lease_generation uuid;
BEGIN
  IF current_setting('app.smarter_data_actor', true)
       IS DISTINCT FROM 'tournament-manager' THEN
    RAISE EXCEPTION 'TOURNAMENT_MANAGER_SCOPE_REQUIRED: manager actor is absent'
      USING ERRCODE = '42501';
  END IF;

  IF current_setting('app.smarter_manager_request_fenced', true)
       IS DISTINCT FROM 'protocol-2' THEN
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_SCOPE_REQUIRED: request lease proof is absent'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_tournament_id :=
      NULLIF(current_setting('app.smarter_tournament_id', true), '')::uuid;
    v_lease_generation :=
      NULLIF(
        current_setting('app.smarter_tournament_lease_generation', true),
        ''
      )::uuid;
  EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
    RAISE EXCEPTION 'TOURNAMENT_MANAGER_SCOPE_INVALID: malformed authority context'
      USING ERRCODE = '22023';
  END;

  IF p_tournament_id IS NULL
     OR v_tournament_id IS NULL
     OR v_lease_generation IS NULL
     OR p_tournament_id IS DISTINCT FROM v_tournament_id THEN
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_SCOPE_VIOLATION: row belongs to another tournament'
      USING ERRCODE = '42501';
  END IF;

END;
$function$;

REVOKE ALL ON FUNCTION public.fn_assert_tournament_manager_write_scope(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trg_tournament_manager_write_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_deleted_table_ids uuid[];
BEGIN
  /* Shared tables have valid ordinary service writers.  Only the explicitly
     marked manager actor is scoped by this trigger; guessing from relation
     names would reject registration, scheduling, recovery, and cash games. */
  IF current_setting('app.smarter_data_actor', true)
       IS DISTINCT FROM 'tournament-manager' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'tournaments' THEN
    IF TG_OP <> 'INSERT' THEN v_old_tournament_id := OLD.id; END IF;
    IF TG_OP <> 'DELETE' THEN v_new_tournament_id := NEW.id; END IF;
  ELSIF TG_TABLE_NAME = 'tournament_players' THEN
    IF TG_OP <> 'INSERT' THEN v_old_tournament_id := OLD.tournament_id; END IF;
    IF TG_OP <> 'DELETE' THEN v_new_tournament_id := NEW.tournament_id; END IF;
  ELSIF TG_TABLE_NAME = 'tables' THEN
    IF TG_OP <> 'INSERT' THEN v_old_tournament_id := OLD.tournament_id; END IF;
    IF TG_OP <> 'DELETE' THEN v_new_tournament_id := NEW.tournament_id; END IF;
  ELSIF TG_TABLE_NAME = 'table_seats' THEN
    IF TG_OP <> 'INSERT' THEN
      SELECT t.tournament_id INTO v_old_tournament_id
        FROM public.tables t
       WHERE t.id = OLD.table_id;
      IF NOT FOUND THEN
        /* An ON DELETE CASCADE seat trigger runs after its parent table tuple
           has become invisible to this statement. The parent's own BEFORE
           DELETE scope trigger already proved the exact tournament. Consume
           that transaction proof only for a nested DELETE; a direct orphan
           mutation still fails closed. */
        BEGIN
          v_deleted_table_ids := COALESCE(
            NULLIF(
              current_setting('app.smarter_manager_deleted_table_ids', true),
              ''
            )::uuid[],
            '{}'::uuid[]
          );
        EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
          v_deleted_table_ids := '{}'::uuid[];
        END;
        IF TG_OP = 'DELETE'
           AND pg_trigger_depth() > 1
           AND OLD.table_id = ANY(v_deleted_table_ids) THEN
          BEGIN
            v_old_tournament_id :=
              NULLIF(current_setting('app.smarter_tournament_id', true), '')::uuid;
          EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
            v_old_tournament_id := NULL;
          END;
          IF v_old_tournament_id IS NULL THEN
            RAISE EXCEPTION
              'TOURNAMENT_MANAGER_SCOPE_VIOLATION: cascaded seat has no parent proof'
              USING ERRCODE = '42501';
          END IF;
        ELSE
          RAISE EXCEPTION
            'TOURNAMENT_MANAGER_SCOPE_VIOLATION: old seat table is missing'
            USING ERRCODE = '42501';
        END IF;
      END IF;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      SELECT t.tournament_id INTO v_new_tournament_id
        FROM public.tables t
       WHERE t.id = NEW.table_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION
          'TOURNAMENT_MANAGER_SCOPE_VIOLATION: new seat table is missing'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  ELSE
    RAISE EXCEPTION 'TOURNAMENT_MANAGER_SCOPE_INVALID: unsupported trigger relation'
      USING ERRCODE = '55000';
  END IF;

  -- The immutable M2 plan admits only its exact target registration and funded
  -- aggregate update while the source manager's owner-only capability is open.
  IF public.fn_ca_satellite_manager_target_write(TG_TABLE_NAME,TG_OP,
       CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,
       CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END) THEN
    RETURN NEW;
  END IF;

  IF v_old_tournament_id IS NOT NULL THEN
    PERFORM public.fn_assert_tournament_manager_write_scope(v_old_tournament_id);
  END IF;
  IF v_new_tournament_id IS NOT NULL
     AND v_new_tournament_id IS DISTINCT FROM v_old_tournament_id THEN
    PERFORM public.fn_assert_tournament_manager_write_scope(v_new_tournament_id);
  END IF;

  /* A manager must never touch a cash table/seat (NULL tournament_id), nor may
     it turn a tournament table into a cash table. */
  IF (TG_OP <> 'INSERT' AND v_old_tournament_id IS NULL)
     OR (TG_OP <> 'DELETE' AND v_new_tournament_id IS NULL) THEN
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_SCOPE_VIOLATION: manager write has no tournament'
      USING ERRCODE = '42501';
  END IF;

  /* The exact parent row has now passed manager scope. Persist its id only
     for this transaction so the subsequent FK ON DELETE CASCADE can prove
     why its parent tuple is no longer visible. This is not a broad nested-
     trigger exemption: the child must name an id admitted here. */
  IF TG_TABLE_NAME = 'tables' AND TG_OP = 'DELETE' THEN
    BEGIN
      v_deleted_table_ids := COALESCE(
        NULLIF(
          current_setting('app.smarter_manager_deleted_table_ids', true),
          ''
        )::uuid[],
        '{}'::uuid[]
      );
    EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
      RAISE EXCEPTION
        'TOURNAMENT_MANAGER_SCOPE_INVALID: malformed deleted-table proof'
        USING ERRCODE = '22023';
    END;
    IF NOT OLD.id = ANY(v_deleted_table_ids) THEN
      v_deleted_table_ids := array_append(v_deleted_table_ids, OLD.id);
    END IF;
    PERFORM set_config(
      'app.smarter_manager_deleted_table_ids',
      v_deleted_table_ids::text,
      true
    );
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_tournament_manager_write_scope()
  FROM PUBLIC, anon, authenticated, service_role;

/* `a0_` is intentional. PostgreSQL runs same-kind triggers alphabetically;
   manager authority must lock the lease before the existing `aa_` launch
   triggers lock receipt/tournament parents. */
DROP TRIGGER IF EXISTS a0_tournament_manager_write_scope
  ON public.tournaments;
CREATE TRIGGER a0_tournament_manager_write_scope
  BEFORE INSERT OR UPDATE OR DELETE ON public.tournaments
  FOR EACH ROW EXECUTE FUNCTION public.trg_tournament_manager_write_scope();

DROP TRIGGER IF EXISTS a0_tournament_manager_write_scope
  ON public.tournament_players;
CREATE TRIGGER a0_tournament_manager_write_scope
  BEFORE INSERT OR UPDATE OR DELETE ON public.tournament_players
  FOR EACH ROW EXECUTE FUNCTION public.trg_tournament_manager_write_scope();

DROP TRIGGER IF EXISTS a0_tournament_manager_write_scope
  ON public.tables;
CREATE TRIGGER a0_tournament_manager_write_scope
  BEFORE INSERT OR UPDATE OR DELETE ON public.tables
  FOR EACH ROW EXECUTE FUNCTION public.trg_tournament_manager_write_scope();

DROP TRIGGER IF EXISTS a0_tournament_manager_write_scope
  ON public.table_seats;
CREATE TRIGGER a0_tournament_manager_write_scope
  BEFORE INSERT OR UPDATE OR DELETE ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.trg_tournament_manager_write_scope();

/* No application role may bypass the exact RPCs by editing lease rows. */
REVOKE ALL ON TABLE public.engine_tournament_leases
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.engine_table_leases
  FROM PUBLIC, anon, authenticated, service_role;

/* Remove every generation-blind or superseded engine door after the old
   process drain. No CASCADE: an unexpected dependency aborts this cutover. */
DROP FUNCTION IF EXISTS public.claim_tournament_lease(uuid, text, text, integer);
DROP FUNCTION IF EXISTS public.heartbeat_tournament_leases_v2(text, uuid[], integer);
DROP FUNCTION IF EXISTS public.heartbeat_tournament_leases(text, uuid[]);
DROP FUNCTION IF EXISTS public.release_tournament_leases(text, uuid[]);
DROP FUNCTION IF EXISTS public.fn_begin_tournament_launch_atomic(
  uuid, uuid, timestamptz
);
DROP FUNCTION IF EXISTS public.fn_complete_tournament_launch_atomic(uuid, uuid);
DROP FUNCTION IF EXISTS public.claim_table_lease(uuid, text, text, integer);
DROP FUNCTION IF EXISTS public.heartbeat_table_leases_v2(text, uuid[], integer);
DROP FUNCTION IF EXISTS public.heartbeat_table_leases(text, uuid[]);
DROP FUNCTION IF EXISTS public.release_table_leases(text, uuid[]);
DROP FUNCTION IF EXISTS public.fn_ca_commit_hand_settlement(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb
);
DROP FUNCTION IF EXISTS public.fn_ca_commit_hand_settlement(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb, text, uuid
);

/* Keep only the exact protocol-2 application doors. */
REVOKE ALL ON FUNCTION public.claim_tournament_lease_v2(
  uuid, text, text, uuid, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_tournament_lease_v2(
  uuid, text, text, uuid, integer
) TO service_role;
REVOKE ALL ON FUNCTION public.heartbeat_tournament_leases_v3(text, jsonb, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heartbeat_tournament_leases_v3(text, jsonb, integer)
  TO service_role;
REVOKE ALL ON FUNCTION public.release_tournament_leases_v2(text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_tournament_leases_v2(text, jsonb)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_begin_tournament_launch_atomic(
  uuid, uuid, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_begin_tournament_launch_atomic(
  uuid, uuid, timestamptz, uuid
) TO service_role;
REVOKE ALL ON FUNCTION public.fn_complete_tournament_launch_atomic(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_launch_atomic(uuid, uuid, uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.claim_table_lease_v2(
  uuid, text, text, uuid, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_table_lease_v2(
  uuid, text, text, uuid, integer
) TO service_role;
REVOKE ALL ON FUNCTION public.heartbeat_table_leases_v3(text, jsonb, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heartbeat_table_leases_v3(text, jsonb, integer)
  TO service_role;
REVOKE ALL ON FUNCTION public.release_table_leases_v2(text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_table_leases_v2(text, jsonb)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb, text, uuid,
  jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_commit_hand_settlement(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb, text, uuid,
  jsonb
) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_process_hand_post_commit_obligations(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_process_hand_post_commit_obligations(uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement_exact_before_obligations(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb, text, uuid
) FROM PUBLIC, anon, authenticated, service_role;


DO $assert_strict_manager_request_fence$
DECLARE
  v_legacy_roster_has_job boolean := false;
  v_hook_source text;
  v_scope_source text;
  v_row_guard_source text;
  v_single_obligation_source text;
  v_satellite_cash_source text;
BEGIN
  SELECT p.prosrc INTO STRICT v_hook_source
    FROM pg_proc p
   WHERE p.oid =
         'smarter_private.fn_smarter_data_api_pre_request()'::regprocedure
     AND p.prosecdef;
  SELECT p.prosrc INTO STRICT v_scope_source
    FROM pg_proc p
   WHERE p.oid =
         'public.fn_assert_tournament_manager_write_scope(uuid)'::regprocedure
     AND p.prosecdef;
  SELECT p.prosrc INTO STRICT v_row_guard_source
    FROM pg_proc p
   WHERE p.oid =
         'public.trg_tournament_manager_write_scope()'::regprocedure
     AND p.prosecdef;
  SELECT pg_get_functiondef(
           'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)'::regprocedure
         )
    INTO STRICT v_single_obligation_source;
  SELECT pg_get_functiondef(
           'public.fn_settle_satellite_cash_entitlement_exact(uuid,text,integer,uuid,numeric,text)'::regprocedure
         )
    INTO STRICT v_satellite_cash_source;

  IF position('TOURNAMENT_MANAGER_AUTHORITY_REQUIRED' IN v_hook_source) = 0
     OR position('ENGINE_DATA_AUTHORITY_REQUIRED' IN v_hook_source) = 0
     OR position($needle$'shared-estate-service'$needle$ IN v_hook_source) = 0
     OR position($needle$'browser'$needle$ IN v_hook_source) = 0
     OR position(E'     FOR KEY SHARE;\n  END IF;' IN v_hook_source) = 0
     OR md5((SELECT p.prosrc FROM pg_proc p WHERE p.oid='smarter_private.fn_smarter_data_api_pre_request()'::regprocedure)) <> 'c43a9c75d3d4c1e4945c908d16e3b5d6'
     OR position('l.lease_generation = v_lease_generation' IN v_hook_source) = 0
     OR position('app.smarter_manager_request_fenced' IN v_hook_source) = 0
     OR position('auth.role()' IN v_hook_source) = 0
     OR position('verified JWT role disagrees with request claims' IN v_hook_source) = 0
     OR position($needle$'rpc/fn_project_hand_side_effects'$needle$ IN v_hook_source) = 0
     OR position($needle$'rpc/fn_move_tournament_player'$needle$ IN v_hook_source) = 0
     OR position($needle$'rpc/fn_move_tournament_player_atomic'$needle$ IN v_hook_source) = 0
     OR position($needle$left(v_path, 8) = 'rest/v1/'$needle$ IN v_hook_source) = 0
     OR position($needle$'protocol-2'$needle$ IN v_scope_source) = 0
     OR position('p_tournament_id IS DISTINCT FROM v_tournament_id' IN v_scope_source) = 0
     OR position('app.smarter_manager_deleted_table_ids' IN v_row_guard_source) = 0
     OR position('OLD.table_id = ANY(v_deleted_table_ids)' IN v_row_guard_source) = 0
     OR position('pg_trigger_depth() > 1' IN v_row_guard_source) = 0 THEN
    RAISE EXCEPTION 'Stage-B route authority or manager row scope is incomplete';
  END IF;

  IF position('v_kind' IN v_single_obligation_source) = 0
     OR position('v_atomic_kinds' IN v_single_obligation_source) = 0
     OR position('v_kind = ANY(v_atomic_kinds)'
                 IN v_single_obligation_source) = 0
     OR position('FOR UPDATE' IN v_single_obligation_source) > 0
     OR position('v_is_satellite' IN v_single_obligation_source) > 0
     OR position('late_reg_adjustment' IN v_single_obligation_source) = 0
     OR position('bubble_protection' IN v_single_obligation_source) = 0
     OR position('final_table_deal' IN v_single_obligation_source) = 0
     OR position('satellite_remainder' IN v_single_obligation_source) = 0
     OR position($needle$'seat'$needle$ IN v_single_obligation_source) = 0
     OR position('atomic_batch_required' IN v_single_obligation_source) = 0
     OR position('fn_settle_tournament_obligation_before_atomic_batch_gate('
                 IN v_single_obligation_source) = 0
     OR has_function_privilege(
          'anon',
          'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)',
          'EXECUTE'
        )
     OR has_function_privilege(
          'authenticated',
          'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)',
          'EXECUTE'
        )
     OR NOT has_function_privilege(
          'service_role',
          'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)',
          'EXECUTE'
        ) THEN
    RAISE EXCEPTION 'Stage-B single-obligation settlement boundary is not strict';
  END IF;

  IF position('fn_settle_tournament_obligation_before_atomic_batch_gate('
              IN v_satellite_cash_source) = 0
     OR position('public.fn_settle_tournament_obligation('
                 IN v_satellite_cash_source) > 0 THEN
    RAISE EXCEPTION 'Stage-B atomic satellite payer does not use its private core';
  END IF;

  IF (
    SELECT count(*)
      FROM pg_trigger t
     WHERE t.tgrelid = 'public.tournaments'::regclass
       AND t.tgname IN (
         'aaa_guard_atomic_satellite_completion',
         'aa_guard_tournament_completing_claim',
         'zzzz_tournaments_atomic_place_completion_guard',
         'zzzzz_tournaments_atomic_final_table_deal_completion_guard',
         'zzzzzz_tournaments_financial_certificate',
         'zzzz_tournament_pool_finalization_window_guard',
         'zzzz_freeze_finalized_tournament_prize_pool'
       )
       AND NOT t.tgisinternal
       AND t.tgenabled <> 'D'
  ) <> 7 THEN
    RAISE EXCEPTION 'Stage-B finish, certificate or pool-lifecycle guard is not enabled';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'fn_tournament_payout_reconcile',
         'fn_pay_backed_payout_shortfalls',
         'fn_ca_backpay_guarantee_shortfalls',
         'fn_tournament_payout_sweep',
         'sp_ca_reconcile_backpaid_events',
         'fn_backpay_hu_winner_shortfalls'
       )
  ) THEN
    RAISE EXCEPTION 'a deferred tournament payout reconciliation routine remains installed';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.ca_money_rpc_registry
     WHERE proname IN (
       'fn_tournament_payout_reconcile',
       'fn_pay_backed_payout_shortfalls',
       'fn_ca_backpay_guarantee_shortfalls',
       'fn_tournament_payout_sweep',
       'sp_ca_reconcile_backpaid_events',
       'fn_backpay_hu_winner_shortfalls'
     )
  ) THEN
    RAISE EXCEPTION 'a retired tournament payout reconciliation route remains registered';
  END IF;

  /* Keep cron.job in a statement reached only when the cron extension exists. PostgreSQL
     resolves relations while preparing a statement, so a combined boolean
     expression still breaks a development database without that extension. */
  IF to_regnamespace('cron') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-payout-sweep-hourly') THEN
      RAISE EXCEPTION 'the applying payout repair cron is still scheduled';
    END IF;
    IF EXISTS (
      SELECT 1 FROM cron.job
       WHERE active
         AND command ~* '(fn_tournament_payout_sweep|fn_tournament_payout_reconcile|fn_pay_backed_payout_shortfalls|fn_ca_backpay_guarantee_shortfalls|sp_ca_reconcile_backpaid_events|fn_backpay_hu_winner_shortfalls)'
    ) THEN
      RAISE EXCEPTION 'a deferred tournament payout reconciliation command is still scheduled';
    END IF;
  END IF;
  IF to_regclass('public.ca_settle_sources') IS NOT NULL THEN
    EXECUTE
      'SELECT EXISTS (SELECT 1 FROM public.ca_settle_sources WHERE lower(source) = ANY($1))'
      INTO v_legacy_roster_has_job
      USING ARRAY[
        'reconcile',
        'fn_tournament_payout_reconcile',
        'fn_pay_backed_payout_shortfalls',
        'fn_ca_backpay_guarantee_shortfalls',
        'fn_tournament_payout_sweep',
        'sp_ca_reconcile_backpaid_events',
        'fn_backpay_hu_winner_shortfalls'
      ]::text[];
    IF v_legacy_roster_has_job THEN
      RAISE EXCEPTION 'retired reconcile sources can still settle obligations directly';
    END IF;
  END IF;
  IF to_regclass('public.ca_expected_cron_jobs') IS NOT NULL THEN
    EXECUTE
      'SELECT EXISTS (SELECT 1 FROM public.ca_expected_cron_jobs WHERE jobname = $1)'
      INTO v_legacy_roster_has_job
      USING 'ca-payout-sweep-hourly';
    IF v_legacy_roster_has_job THEN
      RAISE EXCEPTION 'the retired payout repair cron is still in the expected roster';
    END IF;
  END IF;


  IF to_regprocedure('public.claim_tournament_lease(uuid,text,text,integer)')
       IS NOT NULL
     OR to_regprocedure('public.heartbeat_tournament_leases_v2(text,uuid[],integer)')
       IS NOT NULL
     OR to_regprocedure('public.heartbeat_tournament_leases(text,uuid[])')
       IS NOT NULL
     OR to_regprocedure('public.release_tournament_leases(text,uuid[])')
       IS NOT NULL
     OR to_regprocedure(
          'public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamptz)'
        ) IS NOT NULL
     OR to_regprocedure(
          'public.fn_complete_tournament_launch_atomic(uuid,uuid)'
        ) IS NOT NULL
     OR to_regprocedure('public.claim_table_lease(uuid,text,text,integer)')
        IS NOT NULL
     OR to_regprocedure('public.heartbeat_table_leases_v2(text,uuid[],integer)')
        IS NOT NULL
     OR to_regprocedure('public.heartbeat_table_leases(text,uuid[])')
        IS NOT NULL
     OR to_regprocedure('public.release_table_leases(text,uuid[])')
        IS NOT NULL
     OR to_regprocedure(
          'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'
        ) IS NOT NULL
     OR to_regprocedure(
          'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'
        ) IS NOT NULL THEN
    RAISE EXCEPTION 'A legacy or superseded tournament/table authority door survived Stage B';
  END IF;

  IF has_table_privilege('service_role', 'public.engine_tournament_leases', 'SELECT')
     OR has_table_privilege('service_role', 'public.engine_tournament_leases', 'INSERT')
     OR has_table_privilege('service_role', 'public.engine_tournament_leases', 'UPDATE')
     OR has_table_privilege('service_role', 'public.engine_tournament_leases', 'DELETE') THEN
    RAISE EXCEPTION 'service_role can still edit tournament leases outside exact RPCs';
  END IF;

  IF has_table_privilege('service_role', 'public.engine_table_leases', 'SELECT')
     OR has_table_privilege('service_role', 'public.engine_table_leases', 'INSERT')
     OR has_table_privilege('service_role', 'public.engine_table_leases', 'UPDATE')
     OR has_table_privilege('service_role', 'public.engine_table_leases', 'DELETE') THEN
    RAISE EXCEPTION 'service_role can still edit table leases outside exact RPCs';
  END IF;

  IF NOT has_function_privilege(
       'service_role',
       'public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'::regprocedure,
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.claim_table_lease_v2(uuid,text,text,uuid,integer)'::regprocedure,
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure,
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_ca_process_hand_post_commit_obligations(uuid)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.claim_table_lease_v2(uuid,text,text,uuid,integer)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_ca_process_hand_post_commit_obligations(uuid)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'::regprocedure,
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Exact engine RPC grants or private settlement-core ACL are wrong';
  END IF;

  IF (SELECT count(*)
        FROM pg_trigger t
       WHERE t.tgname = 'a0_tournament_manager_write_scope'
         AND t.tgrelid IN (
           'public.tournaments'::regclass,
           'public.tournament_players'::regclass,
           'public.tables'::regclass,
           'public.table_seats'::regclass
         )
         AND NOT t.tgisinternal) <> 4 THEN
    RAISE EXCEPTION 'Every manager-owned row family is not scope guarded';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_db_role_setting s
      JOIN pg_roles r ON r.oid = s.setrole
      CROSS JOIN LATERAL unnest(COALESCE(s.setconfig, '{}'::text[])) setting(value)
     WHERE r.rolname = 'authenticator'
       AND setting.value =
           'pgrst.db_pre_request=smarter_private.fn_smarter_data_api_pre_request'
  ) THEN
    RAISE EXCEPTION 'PostgREST strict request hook setting is absent';
  END IF;

  IF to_regprocedure('public.fn_smarter_data_api_pre_request()') IS NOT NULL THEN
    RAISE EXCEPTION 'Strict request hook remains callable from the exposed public schema';
  END IF;

  IF NOT has_function_privilege(
       'service_role',
       'smarter_private.fn_smarter_data_api_pre_request()',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'anon',
       'smarter_private.fn_smarter_data_api_pre_request()',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'smarter_private.fn_smarter_data_api_pre_request()',
       'EXECUTE'
     )
     OR NOT has_schema_privilege('service_role', 'smarter_private', 'USAGE')
     OR NOT has_schema_privilege('anon', 'smarter_private', 'USAGE')
     OR NOT has_schema_privilege('authenticated', 'smarter_private', 'USAGE')
     OR has_schema_privilege('service_role', 'smarter_private', 'CREATE')
     OR has_schema_privilege('anon', 'smarter_private', 'CREATE')
     OR has_schema_privilege('authenticated', 'smarter_private', 'CREATE')
     OR has_function_privilege(
       'authenticator',
       'smarter_private.fn_smarter_data_api_pre_request()',
       'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
         FROM pg_proc p
         CROSS JOIN LATERAL aclexplode(p.proacl) acl
        WHERE p.oid =
              'smarter_private.fn_smarter_data_api_pre_request()'::regprocedure
          AND acl.grantee = 0
          AND acl.privilege_type = 'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
         FROM pg_namespace n
         CROSS JOIN LATERAL aclexplode(n.nspacl) acl
        WHERE n.nspname = 'smarter_private'
          AND acl.grantee = 0
          AND acl.privilege_type IN ('USAGE', 'CREATE')
     ) THEN
    RAISE EXCEPTION 'Private strict request hook ACL is not exact';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_db_role_setting s
      JOIN pg_roles r ON r.oid = s.setrole
      CROSS JOIN LATERAL unnest(COALESCE(s.setconfig, '{}'::text[])) AS setting(value)
      CROSS JOIN LATERAL regexp_split_to_table(
        split_part(setting.value, '=', 2),
        '[[:space:]]*,[[:space:]]*'
      ) AS exposed(schema_name)
     WHERE r.rolname = 'authenticator'
       AND setting.value LIKE 'pgrst.db_schemas=%'
       AND exposed.schema_name = 'smarter_private'
  ) THEN
    RAISE EXCEPTION 'smarter_private must not be a PostgREST exposed schema';
  END IF;
END;
$assert_strict_manager_request_fence$;

COMMENT ON FUNCTION public.fn_assert_tournament_manager_write_scope(uuid) IS
  'Private Stage-B row-scope proof. A manager write must consume the transaction marker set only after the request hook locks its exact fresh protocol-2 lease, then name that same tournament and generation.';
COMMENT ON FUNCTION public.trg_tournament_manager_write_scope() IS
  'Scopes marked tournament-manager writes on tournaments, tournament_players, tables and table_seats to the transaction authority established by the Data API request hook.';

NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';



/*
 * ROLLBACK ORDER (emergency forward migration, never an ad-hoc production
 * toggle): restore the Stage-A hook first; restore only the legacy tournament
 * overloads from the tournament-lease generation migration, table overloads
 * and superseded nine- and eleven-argument settlement from the table-lease
 * generation migration if an old engine is being deliberately reintroduced;
 * keep the obligations-aware twelve-argument core; then remove the four a0_
 * triggers and the two private scope functions.
 * Reopening any superseded engine door without also restoring Stage-A
 * compatibility is an invalid mixed protocol. Normal rollback is a new
 * audited migration.
 */

-- END ACTIVATION COMPONENT scripts/deploy/phase-three-strict-tournament-cutover.sql

COMMIT;
