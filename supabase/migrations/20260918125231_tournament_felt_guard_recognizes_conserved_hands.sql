-- A conserved hand redistributes existing chips; it does not create supply.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='8s';
DO $preimage$ BEGIN
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_tournament_felt_may_not_exceed_supply()'::regprocedure AND md5(pg_get_functiondef(oid))='bcdc829c9f3f1a6b2f6ee44ad6122403' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'CONSERVED_HAND_PREIMAGE_CHANGED: %','fn_ca_tournament_felt_may_not_exceed_supply()'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_union_pnl_inventory_observe()'::regprocedure AND md5(pg_get_functiondef(oid))='11c7c788d943a11375a15819e78873ba' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'CONSERVED_HAND_PREIMAGE_CHANGED: %','fn_union_pnl_inventory_observe()'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_union_pnl_inventory_project(text,jsonb)'::regprocedure AND md5(pg_get_functiondef(oid))='cc819d2476a0252326e7bdd4e72d468f' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'CONSERVED_HAND_PREIMAGE_CHANGED: %','fn_union_pnl_inventory_project(text,jsonb)'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_union_pnl_inventory_immutable()'::regprocedure AND md5(pg_get_functiondef(oid))='307d83a1ee3d912bade24c48144aa801' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'CONSERVED_HAND_PREIMAGE_CHANGED: %','fn_union_pnl_inventory_immutable()'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_union_pnl_original_frame()'::regprocedure AND md5(pg_get_functiondef(oid))='9a6559774cc1ed4ed49b315a3428abdb' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'CONSERVED_HAND_PREIMAGE_CHANGED: %','fn_union_pnl_original_frame()'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.table_seats'::regclass AND tgname='zzzzzz_tournament_felt_may_not_exceed_supply' AND md5(pg_get_triggerdef(oid))='35a4f0762632e7d206142486dbb53338' AND tgenabled='O') THEN RAISE EXCEPTION 'CONSERVED_HAND_PREIMAGE_CHANGED: capture attachment'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.union_pnl_inventory_events'::regclass AND tgname='original_pnl_inventory_events_immutable' AND md5(pg_get_triggerdef(oid))='b385488b8ae465bcfea375cb8ca7b623' AND tgenabled='O') THEN RAISE EXCEPTION 'CONSERVED_HAND_PREIMAGE_CHANGED: capture attachment'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.table_seats'::regclass AND tgname='union_pnl_original_inventory' AND md5(pg_get_triggerdef(oid))='eaf43de5d9c9bd4459862856035ad8d3' AND tgenabled='O') THEN RAISE EXCEPTION 'CONSERVED_HAND_PREIMAGE_CHANGED: capture attachment'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.tables'::regclass AND tgname='union_pnl_original_inventory' AND md5(pg_get_triggerdef(oid))='5ea8f31d0e9ed1b4ed6502a7d14f34f2' AND tgenabled='O') THEN RAISE EXCEPTION 'CONSERVED_HAND_PREIMAGE_CHANGED: capture attachment'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.union_pnl_inventory_events'::regclass AND pg_get_userbyid(relowner)='postgres' AND relacl::text='{postgres=arwdDxtm/postgres}' AND relrowsecurity) OR NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.union_pnl_inventory_transaction'::regclass AND indisvalid AND indisready AND pg_get_indexdef(indexrelid)='CREATE INDEX union_pnl_inventory_transaction ON public.union_pnl_inventory_events USING btree (transaction_id, source_name)') THEN RAISE EXCEPTION 'CONSERVED_HAND_PREIMAGE_CHANGED: private indexed inventory'; END IF;
END $preimage$;
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
$function$
;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_felt_may_not_exceed_supply() FROM PUBLIC;
DO $postimage$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_tournament_felt_may_not_exceed_supply()'::regprocedure AND md5(pg_get_functiondef(oid))='81fda5e596905c96a07bebfcff7f32b3' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'CONSERVED_HAND_POSTIMAGE_CHANGED'; END IF; END $postimage$;
COMMIT;
