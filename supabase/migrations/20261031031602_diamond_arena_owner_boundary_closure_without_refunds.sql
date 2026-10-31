-- @live-proof: EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_launch_tournament_held(uuid,uuid)') AND md5(pg_get_functiondef(p.oid))='637b724bedd9591e36e04c711cff21fd' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public']) AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)') AND md5(pg_get_functiondef(p.oid))='2622a05f060e54b18204205fc08bc7e9' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp']) AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_operator_floor_entry_guard()') AND md5(pg_get_functiondef(p.oid))='132eaeef60af771e0a2cf1b2fb3ccec5' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp']) AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_operator_floor_state(uuid)') AND md5(pg_get_functiondef(p.oid))='c14df5ec0456971521c545859cf7bd48' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp']) AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)') AND md5(pg_get_functiondef(p.oid))='1469a8f499a4669d893863d129b1bb0d' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) AND EXISTS(SELECT 1 FROM public.ca_diamond_arena_owner_closure WHERE club_id='002c2d27-9584-4e52-835a-bb2be148fc81' AND operation_id='01a18fed-2211-7a62-9416-611dd6e4d96d' AND closed)
-- Owner October 30: close Diamond games at safe boundaries; no refunds.
-- Existing engine floor boundary consumes this record. Existing unfinished
-- originals retain recovery, settlement, and exact permit replay. No balances,
-- custody, seats, tournament outcomes or historical hands are rewritten.
-- No expiry, automatic reopening, cancellation, refund, cash-out or repair loop.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
CREATE TABLE public.ca_diamond_arena_owner_closure (
 club_id uuid PRIMARY KEY,
 operation_id uuid NOT NULL UNIQUE,
 closed boolean NOT NULL,
 reason text NOT NULL,
 requested_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
ALTER TABLE public.ca_diamond_arena_owner_closure ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_diamond_arena_owner_closure FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.ca_diamond_arena_owner_closure TO service_role;
INSERT INTO public.ca_diamond_arena_owner_closure VALUES('002c2d27-9584-4e52-835a-bb2be148fc81','01a18fed-2211-7a62-9416-611dd6e4d96d',true,'Diamond Arena Closed By Owner. Finish Existing Hands Safely. No Refunds.',transaction_timestamp());
DO $pin$ BEGIN IF NOT (EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_launch_tournament_held(uuid,uuid)') AND md5(pg_get_functiondef(p.oid))='f4a96975ae33551dcb9c5ae35aa5e5b2' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public'])) THEN RAISE EXCEPTION 'DIAMOND_CLOSURE_PREIMAGE_CHANGED: fn_ca_launch_tournament_held'; END IF; END $pin$;
CREATE OR REPLACE FUNCTION public.fn_ca_launch_tournament_held(p_club uuid, p_union uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
 -- Original global admission lane precedes the operator floor on direct and nested routes.
 PERFORM pg_advisory_xact_lock_shared(530090,1);
 PERFORM pg_advisory_xact_lock_shared(530093);
 -- VOLATILE: read a fresh snapshot after a competing exclusive park committed.
 IF EXISTS(SELECT 1 FROM public.ca_diamond_arena_owner_closure c WHERE c.club_id=p_club AND c.closed) THEN RETURN true; END IF;
 RETURN EXISTS(SELECT 1 FROM public.ca_operator_floor_hold h JOIN public.ca_launch_operator_scopes m ON m.operation_id=h.operation_id
  WHERE h.mode='park' AND (p_club=ANY(m.club_ids) OR p_union=ANY(m.club_ids)));
END $function$
;
DO $pin$ BEGIN IF NOT (EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)') AND md5(pg_get_functiondef(p.oid))='687c04cf8d272256e48eac35135a95ba' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp'])) THEN RAISE EXCEPTION 'DIAMOND_CLOSURE_PREIMAGE_CHANGED: fn_ca_lock_tournament_seat_acquisition'; END IF; END $pin$;
CREATE OR REPLACE FUNCTION public.fn_ca_lock_tournament_seat_acquisition(p_tournament_id uuid, p_table_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid:=p_tournament_id;
  v_table_tournament_id uuid;
  v_status text;
BEGIN
  IF EXISTS(SELECT 1 FROM public.ca_diamond_arena_owner_closure c JOIN public.tournaments t ON t.club_id=c.club_id
    WHERE t.id=COALESCE(p_tournament_id,(SELECT tournament_id FROM public.tables WHERE id=p_table_id)) AND c.closed
    AND NOT EXISTS(SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id=t.id AND tp.user_id=p_user_id)) THEN
    RETURN jsonb_build_object('ok',false,'reason','diamond_arena_closed');
  END IF;
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id, p_table_id);
  PERFORM pg_advisory_xact_lock_shared(530093);
  IF EXISTS(SELECT 1 FROM public.ca_operator_floor_hold h JOIN public.ca_launch_operator_scopes m ON m.operation_id=h.operation_id JOIN public.tournaments t ON t.id=COALESCE(p_tournament_id,(SELECT tournament_id FROM public.tables WHERE id=p_table_id)) WHERE h.mode='park' AND (t.club_id=ANY(m.club_ids) OR t.union_id=ANY(m.club_ids)) AND NOT EXISTS(SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id=t.id AND tp.user_id=p_user_id)) THEN
    RETURN jsonb_build_object('ok',false,'reason','operator_floor_parked');
  END IF;
  PERFORM pg_advisory_xact_lock_shared(530090,1);
  PERFORM public.fn_ca_lock_mtt_admission_contract();

  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok',false,'reason','platform_frozen');
  END IF;

  -- DIAMOND PHASE 11: every seat's player takes the table-cap lock before the
  -- Daily Missions lock, which locks the player's profile row. Every cash seat
  -- door, chip and Diamond, takes table_cap first; for a Diamond player the
  -- profile row is the wallet, and one player's chip entry, Diamond entry and
  -- Diamond cash seat meet on these two locks, so the order is one for every
  -- event whatever its asset. The roster trigger's own table_cap is re-entrant.
  IF p_user_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text, 0));
    PERFORM public.fn_lock_daily_mission_user(p_user_id);
  END IF;

  IF p_table_id IS NOT NULL THEN
    SELECT tb.tournament_id INTO v_table_tournament_id
      FROM public.tables tb
     WHERE tb.id=p_table_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok',false,'reason','table_not_found');
    END IF;
    IF v_table_tournament_id IS NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','not_a_tournament_table');
    END IF;
    IF v_tournament_id IS NOT NULL
       AND v_tournament_id IS DISTINCT FROM v_table_tournament_id THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','table_tournament_mismatch');
    END IF;
    v_tournament_id:=v_table_tournament_id;
  END IF;

  IF v_tournament_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_or_table_required');
  END IF;

  -- Launch completion already owns receipt -> tournament. Re-entering these
  -- locks from every seat root makes the historical aa_ launch-proof trigger
  -- a no-op lock acquisition rather than a late inversion.
  PERFORM r.tournament_id
    FROM public.tournament_launch_receipts r
   WHERE r.tournament_id=v_tournament_id
   ORDER BY r.tournament_id
   FOR UPDATE;

  SELECT upper(COALESCE(t.status::text,'')) INTO v_status
    FROM public.tournaments t
   WHERE t.id=v_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  IF v_status NOT IN ('ANNOUNCED','REGISTERING','RUNNING') THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_not_seatable','status',v_status);
  END IF;

  RETURN jsonb_build_object(
    'ok',true,'tournament_id',v_tournament_id,
    'table_id',p_table_id,'status',v_status);
END;
$function$
;
DO $pin$ BEGIN IF NOT (EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_operator_floor_entry_guard()') AND md5(pg_get_functiondef(p.oid))='a6b11771207759db94de57cdc72adfd2' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp'])) THEN RAISE EXCEPTION 'DIAMOND_CLOSURE_PREIMAGE_CHANGED: fn_ca_operator_floor_entry_guard'; END IF; END $pin$;
CREATE OR REPLACE FUNCTION public.fn_ca_operator_floor_entry_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 -- Seat admission and floor commands share the original transaction edge.
 PERFORM pg_advisory_xact_lock_shared(530093);
 IF NEW.left_at IS NULL AND (TG_OP='INSERT' OR OLD.left_at IS NOT NULL OR NEW.occupancy_id IS DISTINCT FROM OLD.occupancy_id) AND
 (EXISTS(SELECT 1 FROM public.ca_diamond_arena_owner_closure c JOIN public.tables t ON t.club_id=c.club_id WHERE t.id=NEW.table_id AND t.tournament_id IS NULL AND c.closed) OR EXISTS(SELECT 1 FROM public.ca_operator_floor_hold h WHERE h.mode='park' AND (NOT EXISTS(SELECT 1 FROM public.ca_launch_operator_scopes m WHERE m.operation_id=h.operation_id) OR EXISTS(SELECT 1 FROM public.ca_launch_operator_scopes m JOIN public.tables st ON st.id=NEW.table_id WHERE m.operation_id=h.operation_id AND st.tournament_id IS NULL AND (st.club_id=ANY(m.club_ids) OR st.union_id=ANY(m.club_ids))))) OR EXISTS(SELECT 1 FROM public.ca_operator_table_closes c WHERE c.table_id=NEW.table_id AND public.fn_ca_launch_cash_close_resumed(c.table_id,c.operation_id) IS NOT TRUE)) THEN
  RAISE EXCEPTION 'OPERATOR_FLOOR_PARKED' USING ERRCODE='55006';
 END IF;
 RETURN NEW;
END $function$
;
DO $pin$ BEGIN IF NOT (EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_operator_floor_state(uuid)') AND md5(pg_get_functiondef(p.oid))='af46361b46157eb951c485ea11696512' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp'])) THEN RAISE EXCEPTION 'DIAMOND_CLOSURE_PREIMAGE_CHANGED: fn_ca_operator_floor_state'; END IF; END $pin$;
CREATE OR REPLACE FUNCTION public.fn_ca_operator_floor_state(p_table_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT jsonb_build_object(
 'hold',coalesce(
  (SELECT jsonb_build_object('operation_id',c.operation_id,'mode','park','reason',c.reason)
   FROM public.ca_diamond_arena_owner_closure c JOIN public.tables t ON t.club_id=c.club_id
   WHERE t.id=p_table_id AND c.closed
    -- Existing original recovery must load and finish before its boundary parks.
    AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits p WHERE p.table_id=t.id AND p.state='reserved')
    AND NOT EXISTS(SELECT 1 FROM public.hand_state_snapshots s WHERE s.table_id=t.id AND NOT s.is_complete)),
  (SELECT to_jsonb(h) FROM public.ca_operator_floor_hold h WHERE NOT EXISTS(SELECT 1 FROM public.ca_launch_operator_scopes m WHERE m.operation_id=h.operation_id) OR EXISTS(SELECT 1 FROM public.ca_launch_operator_scopes m WHERE m.operation_id=h.operation_id AND EXISTS(SELECT 1 FROM public.tables st WHERE st.id=p_table_id AND st.tournament_id IS NULL AND (st.club_id=ANY(m.club_ids) OR st.union_id=ANY(m.club_ids))))),
  (SELECT jsonb_build_object('operation_id',a.operation_id,'mode','park','reason',op.reason,'tournament_abort',true,'tournament_id',a.tournament_id)
   FROM smarter_private.tournament_abort_targets a JOIN public.tables t ON t.tournament_id=a.tournament_id
   JOIN smarter_private.tournament_abort_operations op ON op.operation_id=a.operation_id
   WHERE t.id=p_table_id
    -- Startup asks before it restores an original hand. An unfinished original
    -- is allowed through this READ so its existing permit can finish; the new
    -- permit door above is already stopped. Never mistake this read for ACK.
    AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits h WHERE h.table_id=t.id AND h.state='reserved')
    AND NOT EXISTS(SELECT 1 FROM public.hand_state_snapshots s WHERE s.table_id=t.id AND NOT s.is_complete))),
 'close',(SELECT to_jsonb(c) FROM public.ca_operator_table_closes c WHERE c.table_id=p_table_id AND c.status='pending'));
$function$
;
DO $pin$ BEGIN IF NOT (EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)') AND md5(pg_get_functiondef(p.oid))='71f94455a73180259ac0543a25dd45ae' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private'])) THEN RAISE EXCEPTION 'DIAMOND_CLOSURE_PREIMAGE_CHANGED: fn_f06_begin_hand'; END IF; END $pin$;
CREATE OR REPLACE FUNCTION public.fn_f06_begin_hand(p_tournament_id uuid, p_lease_generation uuid, p_table_id uuid, p_lifecycle bigint, p_permit_id uuid, p_hand_number bigint, p_custody_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE h smarter_private.f06_hand_permits;
BEGIN
 /* A TABLE'S HAND DOES NOT WAIT FOR ITS SIBLING TABLES (2026-10-03): the
    tournament lane T(id) shared, then this table and its seats FOR
    UPDATE. See fn_ca_f06_share_table_lane. */
 PERFORM public.fn_ca_f06_share_table_lane(p_tournament_id,p_lease_generation,p_table_id);
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE permit_id=p_permit_id;
 IF FOUND THEN
 IF (h.tournament_id,h.table_id,h.lifecycle,h.hand_number,h.custody_id,h.generation) IS DISTINCT FROM(p_tournament_id,p_table_id,p_lifecycle,p_hand_number,p_custody_id,p_lease_generation) THEN
 RAISE EXCEPTION 'F06_CHANGED_HAND_PERMIT' USING ERRCODE='22023'; END IF;
 RETURN to_jsonb(h)||jsonb_build_object('ok',h.state='reserved','lifecycle',h.lifecycle::text,'hand_number',h.hand_number::text); END IF;
 -- Exact existing permit replay above stays lawful; only new hands stop.
 IF EXISTS(SELECT 1 FROM public.ca_diamond_arena_owner_closure c JOIN public.tables t ON t.club_id=c.club_id WHERE t.id=p_table_id AND c.closed) THEN
  RETURN jsonb_build_object('ok',false,'reason','diamond_arena_closed');
 END IF;
 -- A permit its engine attested absent (fn_park_stopped_time_bank_custody, 2026-09-27)
 -- can never be begun afterwards: the absence was recorded under this same lane.
 IF EXISTS(SELECT 1 FROM smarter_private.f06_absent_permit_releases WHERE permit_id=p_permit_id) THEN
 RETURN jsonb_build_object('ok',false,'reason','permit_released_absent'); END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id=p_table_id AND state NOT IN ('acknowledged','withdrawn_before_manifest')) THEN
 RETURN jsonb_build_object('ok',false,'reason','source_excluded'); END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tables tb JOIN public.tournaments t ON t.id=tb.tournament_id WHERE tb.id=p_table_id AND t.id=p_tournament_id AND upper(t.status)='RUNNING' AND tb.f06_lifecycle=p_lifecycle
 AND lower(tb.status)<>'closed' AND NOT COALESCE(tb.is_deleted,false)) THEN RAISE EXCEPTION 'F06_HAND_LIFECYCLE' USING ERRCODE='55000'; END IF;
 IF p_hand_number IS NULL OR p_hand_number<1 OR p_custody_id IS NULL THEN RAISE EXCEPTION 'F06_HAND_IDENTITY' USING ERRCODE='22023'; END IF;
 -- Hand numbers are permanently unique for the physical table, across every lifecycle.
 -- Exact permit replay above is lawful; a new permit cannot adopt historical evidence.
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=p_table_id AND hand_number=p_hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=p_table_id AND hand_number=p_hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=p_table_id AND hand_number=p_hand_number) THEN
 RETURN jsonb_build_object('ok',false,'reason','hand_number_already_used'); END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=p_table_id AND state='reserved') THEN
 RETURN jsonb_build_object('ok',false,'reason','hand_permit_unresolved'); END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.tournament_abort_targets a WHERE a.tournament_id=p_tournament_id) THEN
  RETURN jsonb_build_object('ok',false,'reason','operator_abort_stopped');
 END IF;
 INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation)
 VALUES(p_permit_id,p_tournament_id,p_table_id,p_lifecycle,p_hand_number,p_custody_id,p_lease_generation) RETURNING * INTO h;
 RETURN to_jsonb(h)||jsonb_build_object('ok',true,'lifecycle',h.lifecycle::text,'hand_number',h.hand_number::text);
END $function$
;
DO $post$ BEGIN IF NOT (EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_launch_tournament_held(uuid,uuid)') AND md5(pg_get_functiondef(p.oid))='637b724bedd9591e36e04c711cff21fd' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public']) AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)') AND md5(pg_get_functiondef(p.oid))='2622a05f060e54b18204205fc08bc7e9' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp']) AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_operator_floor_entry_guard()') AND md5(pg_get_functiondef(p.oid))='132eaeef60af771e0a2cf1b2fb3ccec5' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp']) AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_operator_floor_state(uuid)') AND md5(pg_get_functiondef(p.oid))='c14df5ec0456971521c545859cf7bd48' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp']) AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)') AND md5(pg_get_functiondef(p.oid))='1469a8f499a4669d893863d129b1bb0d' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) AND EXISTS(SELECT 1 FROM public.ca_diamond_arena_owner_closure WHERE club_id='002c2d27-9584-4e52-835a-bb2be148fc81' AND operation_id='01a18fed-2211-7a62-9416-611dd6e4d96d' AND closed)) THEN RAISE EXCEPTION 'DIAMOND_CLOSURE_POSTIMAGE_CHANGED'; END IF; IF clock_timestamp()-transaction_timestamp()>=interval '8 seconds' THEN RAISE EXCEPTION 'DIAMOND_CLOSURE_INSTALL_BUDGET'; END IF; END $post$;
COMMIT;
