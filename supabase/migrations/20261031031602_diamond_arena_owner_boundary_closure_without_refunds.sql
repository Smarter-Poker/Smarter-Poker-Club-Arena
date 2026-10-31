-- @live-proof: EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_launch_tournament_held(uuid,uuid)') AND md5(pg_get_functiondef(p.oid))='637b724bedd9591e36e04c711cff21fd' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public']) AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)') AND md5(pg_get_functiondef(p.oid))='2622a05f060e54b18204205fc08bc7e9' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp']) AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_operator_floor_entry_guard()') AND md5(pg_get_functiondef(p.oid))='132eaeef60af771e0a2cf1b2fb3ccec5' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp']) AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_operator_floor_state(uuid)') AND md5(pg_get_functiondef(p.oid))='c14df5ec0456971521c545859cf7bd48' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp']) AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)') AND md5(pg_get_functiondef(p.oid))='1469a8f499a4669d893863d129b1bb0d' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_poker_diamond_reserve(uuid,text,uuid,text,numeric,uuid)') AND md5(pg_get_functiondef(p.oid))='ddc874678ad33fdd51d589e744e5b588' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp']) AND EXISTS(SELECT 1 FROM public.ca_diamond_arena_owner_closure WHERE club_id='002c2d27-9584-4e52-835a-bb2be148fc81' AND operation_id='01a18fed-2211-7a62-9416-611dd6e4d96d' AND closed)
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
DO $pin$ BEGIN IF NOT (EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_poker_diamond_reserve(uuid,text,uuid,text,numeric,uuid)') AND md5(pg_get_functiondef(p.oid))='99fb5f4f483710c49e1a2ee8824b0992' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp'])) THEN RAISE EXCEPTION 'DIAMOND_CLOSURE_PREIMAGE_CHANGED: fn_poker_diamond_reserve'; END IF; END $pin$;
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_reserve(p_user_id uuid, p_purpose text, p_target_id uuid, p_entry_key text, p_amount numeric, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
 v_request jsonb; v_previous public.poker_diamond_movements%ROWTYPE;
 v_wallet bigint; v_arena uuid; v_asset text; v_platform boolean; v_union uuid;
 v_min numeric; v_max numeric; v_status text; v_custody uuid; v_journal uuid;
 v_locked bigint; v_days integer; v_left bigint; v_take bigint; v_lot record; v_receipt jsonb;
BEGIN
 IF p_user_id IS NULL OR p_target_id IS NULL OR p_request_id IS NULL
    OR p_purpose IS NULL OR p_purpose NOT IN ('cash_seat','tournament_entry')
    OR p_entry_key IS NULL OR length(p_entry_key) NOT BETWEEN 1 AND 160
    OR p_amount IS NULL OR p_amount <= 0 OR p_amount > 2147483647 OR p_amount <> trunc(p_amount) THEN
   RAISE EXCEPTION 'invalid_diamond_reservation' USING ERRCODE = '22023';
 END IF;
 v_request := jsonb_build_object('user_id',p_user_id,'purpose',p_purpose,'target_id',p_target_id,
   'entry_key',p_entry_key,'amount',p_amount,'action','reserve');
 -- All operations for one wallet serialize on that profile, including shop spend/refunds.
 -- NO KEY UPDATE, not UPDATE (20261021234940): it still serializes every
 -- writer of this wallet (FOR UPDATE, NO KEY UPDATE and UPDATE all
 -- refuse it), and it no longer refuses the FOR KEY SHARE that a
 -- foreign-key check from a row pointing at this profile takes.
 SELECT diamonds INTO v_wallet FROM public.profiles WHERE id=p_user_id FOR NO KEY UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'profile_not_found'; END IF;
 SELECT * INTO v_previous FROM public.poker_diamond_movements WHERE request_id=p_request_id;
 IF FOUND THEN
   IF v_previous.request <> v_request THEN RAISE EXCEPTION 'idempotency_payload_mismatch'; END IF;
   RETURN v_previous.receipt;
 END IF;
 IF p_purpose='cash_seat' THEN
   SELECT t.club_id,t.min_buy_in,t.max_buy_in,t.status INTO v_arena,v_min,v_max,v_status
   FROM public.tables t WHERE t.id=p_target_id FOR SHARE;
   IF NOT FOUND OR v_min IS NULL OR v_max IS NULL OR p_amount<v_min OR p_amount>v_max THEN
     RAISE EXCEPTION 'invalid_diamond_table_buy_in';
   END IF;
 ELSE
   SELECT t.club_id,t.buy_in_amount+COALESCE(t.buy_in_fee,0),t.status
   INTO v_arena,v_min,v_status FROM public.tournaments t
     JOIN public.clubs c ON c.id=t.club_id
     JOIN public.ca_arena_settings a ON a.id=1 AND a.club_id=c.id
   WHERE t.id=p_target_id AND c.asset='diamonds' AND c.is_platform IS TRUE
     AND c.union_id IS NULL AND t.union_id IS NULL AND a.tournaments_enabled
   FOR SHARE OF t;
   IF NOT FOUND THEN
     RAISE EXCEPTION 'diamond_tournaments_not_open' USING ERRCODE='55000';
   END IF;
   IF v_min IS NULL OR p_amount<>v_min THEN RAISE EXCEPTION 'invalid_diamond_entry_price'; END IF; END IF;
 SELECT asset,is_platform,union_id INTO v_asset,v_platform,v_union FROM public.clubs WHERE id=v_arena FOR SHARE;
 IF v_asset IS DISTINCT FROM 'diamonds' OR v_platform IS DISTINCT FROM true OR v_union IS NOT NULL THEN
   RAISE EXCEPTION 'diamond_asset_required';
 END IF;
 -- Committed request replay above remains available. Refuse new funding
 -- before any lot, custody, journal or wallet mutation.
 IF EXISTS(SELECT 1 FROM public.ca_diamond_arena_owner_closure c WHERE c.club_id=v_arena AND c.closed) THEN
   RAISE EXCEPTION 'diamond_arena_closed' USING ERRCODE='55000';
 END IF;
 IF v_status IS NULL OR v_status IN ('completed','cancelled','closed','archived') THEN
   RAISE EXCEPTION 'diamond_target_closed';
 END IF;
 SELECT settlement_window_days INTO v_days FROM public.ca_arena_settings WHERE id=1 AND club_id=v_arena;
 IF v_days IS NULL THEN RAISE EXCEPTION 'diamond_arena_policy_missing'; END IF;
 IF EXISTS(SELECT 1 FROM public.diamond_debts WHERE user_id=p_user_id AND settled_at IS NULL AND amount>0) THEN
   RAISE EXCEPTION 'diamond_debt_requires_settlement';
 END IF;
 -- Lock lots before evaluating age/freeze, so a concurrent dispute cannot slip through.
 PERFORM id FROM public.diamond_purchase_lots WHERE user_id=p_user_id ORDER BY created_at,id FOR UPDATE;
 SELECT COALESCE(sum(GREATEST(issued-consumed-refunded-arena_reserved,0)),0) INTO v_locked
 FROM public.diamond_purchase_lots WHERE user_id=p_user_id
 AND (frozen_at IS NOT NULL OR created_at>now()-make_interval(days=>v_days));
 IF v_wallet IS NULL OR v_wallet-v_locked<p_amount THEN
   -- RULING 14 / DR16. A lot frozen or younger than the settlement window is not depositable,
   -- and this door has refused it by this name since Phase 3. The rule mode is READ here so
   -- DR16 has a consumer and a flip means something (the DR15 shape, 20260908041432). The
   -- refusal stands in both modes: the lot reservation below draws only on settled lots, so
   -- an unsettled lot admitted here would sit in custody with nothing for a chargeback to
   -- find. Armed, the same refusal is raised under the rule's own code with the numbers in
   -- its DETAIL; a raise cannot file an incident that survives it (20260906102549), so the
   -- evidence rides in the error, where the Postgres log counts it. The leading token is
   -- what the engine and the client match on and does not change.
   IF v_locked>0 AND v_wallet IS NOT NULL AND v_wallet>=p_amount
      AND public.fn_ca_diamond_rule_mode('DR16:deposit_inside_settlement_window')='refuse' THEN
     RAISE EXCEPTION 'insufficient_settled_diamonds' USING ERRCODE='P0416',
       DETAIL=format('DR16:deposit_inside_settlement_window refused %s: %s purchased diamond(s) frozen or inside the %s-day settlement window; %s settled',
                     p_amount, v_locked, v_days, v_wallet-v_locked);
   END IF;
   RAISE EXCEPTION 'insufficient_settled_diamonds';
 END IF;
 INSERT INTO public.poker_diamond_custody(user_id,arena_id,purpose,target_id,entry_key,balance)
 VALUES(p_user_id,v_arena,p_purpose,p_target_id,p_entry_key,p_amount) RETURNING id INTO v_custody;
 v_left:=p_amount;
 FOR v_lot IN SELECT id,GREATEST(issued-consumed-refunded-arena_reserved,0) available
 FROM public.diamond_purchase_lots WHERE user_id=p_user_id AND frozen_at IS NULL
 AND created_at<=now()-make_interval(days=>v_days) ORDER BY created_at,id LOOP
   EXIT WHEN v_left=0;
   v_take:=LEAST(v_left,v_lot.available);
   IF v_take>0 THEN
     UPDATE public.diamond_purchase_lots SET arena_reserved=arena_reserved+v_take WHERE id=v_lot.id;
     INSERT INTO public.poker_diamond_lot_reservations(custody_id,lot_id,amount) VALUES(v_custody,v_lot.id,v_take);
     v_left:=v_left-v_take;
   END IF;
 END LOOP;
 -- Journal the transfer before the balance update so the existing DR6 audit
 -- sees its evidence inside this same atomic transaction.
 INSERT INTO public.diamond_transactions(user_id,type,transaction_type,amount,balance_after,reference_id,
 description,source,issuance_class,counterparty,metadata)
 VALUES(p_user_id,'arena_deposit','arena_deposit',-p_amount::integer,v_wallet-p_amount,
 'poker-reserve:'||p_request_id,'Reserved diamonds for Poker Arena','poker_arena','arena',
 'arena_custody:'||v_custody,jsonb_build_object('custody_id',v_custody,'request_id',p_request_id,
 'purpose',p_purpose,'target_id',p_target_id,'purchased_reserved',p_amount-v_left)) RETURNING id INTO v_journal;
 UPDATE public.profiles SET diamonds=diamonds-p_amount::integer,updated_at=now() WHERE id=p_user_id;
 v_receipt:=jsonb_build_object('success',true,'custody_id',v_custody,'request_id',p_request_id,
 'amount',p_amount,'available_balance',v_wallet-p_amount,'custody_balance',p_amount,'journal_id',v_journal);
 INSERT INTO public.poker_diamond_movements(request_id,custody_id,user_id,action,amount,source_account,
 destination_account,wallet_journal_id,request,receipt)
 VALUES(p_request_id,v_custody,p_user_id,'reserve',p_amount,'player:'||p_user_id,
 'arena_custody:'||v_custody,v_journal,v_request,v_receipt);
 RETURN v_receipt;
END $function$
;
DO $post$ BEGIN IF NOT (EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_launch_tournament_held(uuid,uuid)') AND md5(pg_get_functiondef(p.oid))='637b724bedd9591e36e04c711cff21fd' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public']) AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)') AND md5(pg_get_functiondef(p.oid))='2622a05f060e54b18204205fc08bc7e9' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp']) AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_operator_floor_entry_guard()') AND md5(pg_get_functiondef(p.oid))='132eaeef60af771e0a2cf1b2fb3ccec5' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp']) AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_operator_floor_state(uuid)') AND md5(pg_get_functiondef(p.oid))='c14df5ec0456971521c545859cf7bd48' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp']) AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)') AND md5(pg_get_functiondef(p.oid))='1469a8f499a4669d893863d129b1bb0d' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_poker_diamond_reserve(uuid,text,uuid,text,numeric,uuid)') AND md5(pg_get_functiondef(p.oid))='ddc874678ad33fdd51d589e744e5b588' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp']) AND EXISTS(SELECT 1 FROM public.ca_diamond_arena_owner_closure WHERE club_id='002c2d27-9584-4e52-835a-bb2be148fc81' AND operation_id='01a18fed-2211-7a62-9416-611dd6e4d96d' AND closed)) THEN RAISE EXCEPTION 'DIAMOND_CLOSURE_POSTIMAGE_CHANGED'; END IF; IF clock_timestamp()-transaction_timestamp()>=interval '8 seconds' THEN RAISE EXCEPTION 'DIAMOND_CLOSURE_INSTALL_BUDGET'; END IF; END $post$;
COMMIT;
