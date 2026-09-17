-- Prospective original cash participant funding and dealt-hand provenance.
-- No historical rewrite, new payer, inference from membership, or financial gate removal.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL search_path=public,pg_temp;

-- Forward evidence only. These records never move money or infer old ownership.
CREATE TABLE public.cash_participant_funding_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 operation_kind text NOT NULL CHECK(operation_kind IN ('buyin','rebuy','addon','horse_funding')),
 operation_key text,
 user_id uuid NOT NULL, table_id uuid NOT NULL, seat_id uuid NOT NULL,
 occupancy_id uuid NOT NULL, seat_joined_at timestamptz NOT NULL,
 source_ledger_id uuid NOT NULL UNIQUE,
 wallet_transaction_id uuid,
 account_type text NOT NULL CHECK(account_type IN ('player_wallet','club_treasury')),
 account_entity_id uuid NOT NULL, funding_club_id uuid NOT NULL,
 funding_union_id uuid, asset text NOT NULL CHECK(asset='chips'),
 unit_scale integer NOT NULL DEFAULT 2 CHECK(unit_scale=2),
 amount numeric NOT NULL CHECK(amount>0 AND amount=round(amount,2) AND amount::text NOT IN ('NaN','Infinity','-Infinity')),
 balance_before numeric NOT NULL, balance_after numeric NOT NULL,
 pending_addon_id uuid UNIQUE,
 CHECK(balance_before-balance_after=amount),
 UNIQUE(operation_kind,operation_key)
);
CREATE INDEX cash_participant_funding_occupancy ON public.cash_participant_funding_receipts(occupancy_id,recorded_at,id);
CREATE TABLE public.cash_funding_application_receipts (
 pending_addon_id uuid PRIMARY KEY, funding_receipt_id uuid NOT NULL UNIQUE,
 applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 original_occupancy_id uuid NOT NULL, applied_occupancy_id uuid,
 applied numeric NOT NULL CHECK(applied>=0), refunded numeric NOT NULL CHECK(refunded>=0)
);
CREATE TABLE public.cash_hand_participant_manifests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), table_id uuid NOT NULL,
 hand_number bigint NOT NULL, captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease_instance_id text NOT NULL, lease_generation uuid NOT NULL,
 request jsonb NOT NULL, game_scope jsonb NOT NULL, participants jsonb NOT NULL,
 issues jsonb NOT NULL, funding_provenance_complete boolean NOT NULL,
 UNIQUE(table_id,hand_number)
);
CREATE TABLE public.cash_hand_provenance_receipts (
 table_id uuid NOT NULL, hand_number bigint NOT NULL, hand_id uuid NOT NULL,
 accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 payload_hash text NOT NULL, accepted_request jsonb NOT NULL, manifest_id uuid,
 version integer NOT NULL DEFAULT 1 CHECK(version=1),
 status text NOT NULL CHECK(status IN ('captured','uncertified')),
 game_scope jsonb, participants jsonb NOT NULL,
 signed_external_net numeric, rake numeric, bbj numeric,
 all_players_included boolean NOT NULL, funding_provenance_complete boolean NOT NULL,
 issues jsonb NOT NULL,
 PRIMARY KEY(table_id,hand_number), UNIQUE(hand_id)
);
CREATE INDEX cash_hand_provenance_time ON public.cash_hand_provenance_receipts(accepted_at,table_id,hand_number);

CREATE FUNCTION public.fn_cash_provenance_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Original cash provenance is immutable' USING ERRCODE='55000'; END $$;
CREATE TRIGGER cash_funding_immutable BEFORE UPDATE OR DELETE ON public.cash_participant_funding_receipts
 FOR EACH ROW EXECUTE FUNCTION public.fn_cash_provenance_immutable();
CREATE TRIGGER cash_manifest_immutable BEFORE UPDATE OR DELETE ON public.cash_hand_participant_manifests
 FOR EACH ROW EXECUTE FUNCTION public.fn_cash_provenance_immutable();
CREATE TRIGGER cash_hand_provenance_immutable BEFORE UPDATE OR DELETE ON public.cash_hand_provenance_receipts
 FOR EACH ROW EXECUTE FUNCTION public.fn_cash_provenance_immutable();
CREATE TRIGGER cash_application_immutable BEFORE UPDATE OR DELETE ON public.cash_funding_application_receipts
 FOR EACH ROW EXECUTE FUNCTION public.fn_cash_provenance_immutable();
CREATE TRIGGER cash_participant_funding_receipts_no_truncate BEFORE TRUNCATE ON public.cash_participant_funding_receipts
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_cash_provenance_immutable();
CREATE TRIGGER cash_funding_application_receipts_no_truncate BEFORE TRUNCATE ON public.cash_funding_application_receipts
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_cash_provenance_immutable();
CREATE TRIGGER cash_hand_participant_manifests_no_truncate BEFORE TRUNCATE ON public.cash_hand_participant_manifests
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_cash_provenance_immutable();
CREATE TRIGGER cash_hand_provenance_receipts_no_truncate BEFORE TRUNCATE ON public.cash_hand_provenance_receipts
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_cash_provenance_immutable();
ALTER TABLE public.cash_funding_application_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cash_funding_application_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.cash_funding_application_receipts TO service_role;
ALTER TABLE public.cash_participant_funding_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_hand_participant_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_hand_provenance_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cash_participant_funding_receipts,public.cash_hand_participant_manifests,public.cash_hand_provenance_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.cash_participant_funding_receipts,public.cash_hand_participant_manifests,public.cash_hand_provenance_receipts TO service_role;
REVOKE ALL ON FUNCTION public.fn_cash_provenance_immutable() FROM PUBLIC,anon,authenticated,service_role;

-- Invoked only by the original private funding cores, after their debit and
-- ledger insert. The row comes from RETURNING, never a proximity search.
CREATE FUNCTION public.fn_cash_record_original_funding(
 p_kind text,p_key text,p_user uuid,p_table uuid,p_ledger uuid,p_wallet uuid,
 p_club uuid,p_amount numeric,p_after numeric,p_pending uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.table_seats%ROWTYPE; l public.chip_ledger%ROWTYPE;
 c public.clubs%ROWTYPE; v_id uuid;
BEGIN
 SELECT * INTO STRICT l FROM public.chip_ledger WHERE id=p_ledger;
 SELECT * INTO STRICT s FROM public.table_seats WHERE table_id=p_table AND user_id=p_user AND left_at IS NULL FOR SHARE;
 SELECT * INTO STRICT c FROM public.clubs WHERE id=p_club;
 IF s.occupancy_id IS NULL OR s.joined_at IS NULL
  OR c.asset IS DISTINCT FROM 'chips' OR l.club_id IS DISTINCT FROM p_club
  OR l.amount IS DISTINCT FROM p_amount OR l.to_type IS DISTINCT FROM 'table_stack'
  OR l.to_entity_id IS DISTINCT FROM p_table OR l.category IS DISTINCT FROM p_kind
  OR l.from_type IS DISTINCT FROM (CASE WHEN p_kind='horse_funding' THEN 'club_treasury' ELSE 'player_wallet' END)
  OR l.from_entity_id IS DISTINCT FROM (CASE WHEN p_kind='horse_funding' THEN p_club ELSE p_user END)
 THEN RAISE EXCEPTION 'Original cash funding debit identity mismatch' USING ERRCODE='23514'; END IF;
 IF p_kind<>'horse_funding' AND NOT EXISTS(SELECT 1 FROM public.wallet_transactions w
  WHERE w.id=p_wallet AND w.user_id=p_user AND w.table_id=p_table AND w.type='debit'
    AND w.category=p_kind AND w.amount=p_amount AND w.balance_after=p_after) THEN
  RAISE EXCEPTION 'Original cash funding wallet journal mismatch' USING ERRCODE='23514';
 END IF;
 INSERT INTO public.cash_participant_funding_receipts(operation_kind,operation_key,user_id,table_id,
  seat_id,occupancy_id,seat_joined_at,source_ledger_id,wallet_transaction_id,account_type,
  account_entity_id,funding_club_id,funding_union_id,asset,amount,balance_before,balance_after,pending_addon_id)
 VALUES(p_kind,p_key,p_user,p_table,s.id,s.occupancy_id,s.joined_at,l.id,p_wallet,l.from_type,
  l.from_entity_id,p_club,c.union_id,c.asset,p_amount,p_after+p_amount,p_after,p_pending) RETURNING id INTO v_id;
 RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.fn_cash_record_original_funding(text,text,uuid,uuid,uuid,uuid,uuid,numeric,numeric,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Resolution records the exact original funding operation and the seat actually
-- credited. Old pending rows stay unbound; a replaced occupancy is never guessed.
CREATE FUNCTION public.fn_cash_record_funding_application(p_pending uuid,p_applied numeric,p_refunded numeric,p_occupancy uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f public.cash_participant_funding_receipts%ROWTYPE;
BEGIN
 SELECT * INTO f FROM public.cash_participant_funding_receipts WHERE pending_addon_id=p_pending;
 IF NOT FOUND THEN RETURN; END IF;
 IF p_applied+p_refunded IS DISTINCT FROM f.amount OR (p_applied>0 AND p_occupancy IS NULL) THEN
  RAISE EXCEPTION 'Original cash funding application mismatch' USING ERRCODE='23514'; END IF;
 INSERT INTO public.cash_funding_application_receipts(pending_addon_id,funding_receipt_id,
  original_occupancy_id,applied_occupancy_id,applied,refunded)
 VALUES(p_pending,f.id,f.occupancy_id,p_occupancy,p_applied,p_refunded);
END $$;
REVOKE ALL ON FUNCTION public.fn_cash_record_funding_application(uuid,numeric,numeric,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- This is a prospective game/roster snapshot, not current-membership inference.
-- The original controller roster is frozen before dealing, under its exact lease.
CREATE FUNCTION public.fn_cash_capture_hand_manifest(
 p_table_id uuid,p_hand_number bigint,p_participants jsonb,p_instance_id text,p_lease_generation uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t public.tables%ROWTYPE; h public.clubs%ROWTYPE; s public.table_seats%ROWTYPE;
 prior public.cash_hand_participant_manifests%ROWTYPE;
 x jsonb; v_users uuid[]:=ARRAY[]::uuid[]; v_occupancies uuid[]:=ARRAY[]::uuid[];
 v_roster jsonb:='[]'; v_request jsonb; v_scope jsonb; v_issues jsonb:='[]';
 v_funding jsonb; v_initial integer; v_accounts integer; v_id uuid; v_user uuid;
 v_seat uuid; v_occupancy uuid; v_join timestamptz; v_before numeric; v_complete boolean:=true;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'Engine authority required' USING ERRCODE='42501'; END IF;
 IF p_table_id IS NULL OR p_hand_number IS NULL OR p_hand_number<1000000
 OR jsonb_typeof(p_participants) IS DISTINCT FROM 'array' OR jsonb_array_length(p_participants)<2
 OR jsonb_array_length(p_participants)>10 OR p_instance_id IS NULL OR p_lease_generation IS NULL THEN
  RAISE EXCEPTION 'Invalid original cash manifest' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM public.engine_table_leases l WHERE l.table_id=p_table_id
  AND l.instance_id=p_instance_id AND l.lease_generation=p_lease_generation AND l.protocol_version=2
  AND l.heartbeat_at>=clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds()) FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original cash manifest lease stale' USING ERRCODE='55000'; END IF;
 SELECT jsonb_agg(value ORDER BY value->>'user_id') INTO v_request FROM jsonb_array_elements(p_participants);
 SELECT * INTO prior FROM public.cash_hand_participant_manifests WHERE table_id=p_table_id AND hand_number=p_hand_number;
 IF FOUND THEN
  IF prior.request IS DISTINCT FROM v_request OR prior.lease_instance_id IS DISTINCT FROM p_instance_id
   OR prior.lease_generation IS DISTINCT FROM p_lease_generation THEN
   RAISE EXCEPTION 'Original cash manifest identity reused' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('version',1,'manifest_id',prior.id,'funding_provenance_complete',prior.funding_provenance_complete,'issues',prior.issues);
 END IF;
 SELECT * INTO STRICT t FROM public.tables WHERE id=p_table_id FOR SHARE;
 IF t.tournament_id IS NOT NULL THEN RAISE EXCEPTION 'Tournament chips are not cash provenance' USING ERRCODE='22023'; END IF;
 SELECT * INTO h FROM public.clubs WHERE id=t.club_id;
 v_scope:=jsonb_build_object('host_club_id',t.club_id,'game_union_id',CASE WHEN t.is_private THEN NULL ELSE t.union_id END,
  'is_private',t.is_private,'tournament_id',t.tournament_id,'asset',h.asset,'unit_scale',2);
 IF h.id IS NULL OR h.asset IS DISTINCT FROM 'chips' OR t.is_private IS NULL
  OR (NOT t.is_private AND t.union_id IS NULL) THEN
  v_issues:=v_issues||'"game_asset_or_union_scope_unproven"'::jsonb; v_complete:=false; END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(v_request) LOOP
  v_user:=(x->>'user_id')::uuid; v_seat:=(x->>'seat_id')::uuid;
  v_occupancy:=(x->>'occupancy_id')::uuid; v_join:=(x->>'seat_joined_at')::timestamptz;
  v_before:=(x->>'stack_before')::numeric;
  IF v_user IS NULL OR v_seat IS NULL OR v_occupancy IS NULL OR v_join IS NULL
   OR NOT isfinite(v_join) OR v_user=ANY(v_users) OR v_occupancy=ANY(v_occupancies)
   OR jsonb_typeof(x->'is_horse') IS DISTINCT FROM 'boolean' OR jsonb_typeof(x->'stack_before') IS DISTINCT FROM 'number'
   OR v_before IS NULL OR v_before<0 OR v_before<>round(v_before,2)
   OR v_before::text IN ('NaN','Infinity','-Infinity') THEN
   RAISE EXCEPTION 'Invalid or duplicate cash participant' USING ERRCODE='22023'; END IF;
  v_users:=array_append(v_users,v_user); v_occupancies:=array_append(v_occupancies,v_occupancy);
  SELECT * INTO s FROM public.table_seats WHERE id=v_seat AND table_id=p_table_id AND user_id=v_user
   AND occupancy_id=v_occupancy AND joined_at=v_join AND left_at IS NULL FOR SHARE;
  IF NOT FOUND OR s.stack IS DISTINCT FROM v_before THEN
   v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','original_seat_or_starting_stack_unproven','user_id',v_user));
   v_complete:=false;
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',f.id,'account_type',f.account_type,'account_entity_id',f.account_entity_id,'funding_club_id',f.funding_club_id,'funding_union_id',f.funding_union_id,'pending_addon_id',f.pending_addon_id) ORDER BY f.recorded_at,f.id),'[]'),
   count(*) FILTER(WHERE operation_kind='buyin'),
   count(DISTINCT (account_type,account_entity_id,funding_club_id,asset))
   INTO v_funding,v_initial,v_accounts FROM public.cash_participant_funding_receipts f
   WHERE f.occupancy_id=v_occupancy AND f.seat_id=v_seat AND f.seat_joined_at=v_join
     AND f.table_id=p_table_id AND f.user_id=v_user;
  IF v_initial<>1 OR v_accounts<>1 THEN
   v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason',CASE WHEN v_initial<>1 THEN 'original_admission_funding_missing' ELSE 'mixed_funding_account_ownership_unproven' END,'user_id',v_user));
   v_complete:=false;
  END IF;
  IF EXISTS(SELECT 1 FROM public.cash_participant_funding_receipts f
    LEFT JOIN public.cash_funding_application_receipts a ON a.funding_receipt_id=f.id
    WHERE f.occupancy_id=v_occupancy AND f.pending_addon_id IS NOT NULL
     AND (a.pending_addon_id IS NULL OR (a.applied>0 AND a.applied_occupancy_id IS DISTINCT FROM f.occupancy_id))) THEN
   v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','pending_funding_application_unproven','user_id',v_user));
   v_complete:=false;
  END IF;
  v_roster:=v_roster||jsonb_build_array(jsonb_build_object('user_id',v_user,'seat_id',v_seat,
   'seat_joined_at',x->>'seat_joined_at','occupancy_id',v_occupancy,'stack_before',v_before,
   'is_horse',(x->>'is_horse')::boolean,'funding_receipts',v_funding));
 END LOOP;
 INSERT INTO public.cash_hand_participant_manifests(table_id,hand_number,lease_instance_id,lease_generation,
  request,game_scope,participants,issues,funding_provenance_complete)
 VALUES(p_table_id,p_hand_number,p_instance_id,p_lease_generation,v_request,v_scope,v_roster,v_issues,v_complete)
 RETURNING id INTO v_id;
 RETURN jsonb_build_object('version',1,'manifest_id',v_id,'funding_provenance_complete',v_complete,'issues',v_issues);
END $$;
REVOKE ALL ON FUNCTION public.fn_cash_capture_hand_manifest(uuid,bigint,jsonb,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_capture_hand_manifest(uuid,bigint,jsonb,text,uuid) TO service_role;

-- Called inside the existing accepted-hand subtransaction. Old engines remain
-- playable and explicitly uncertified. A claimed new manifest must match exactly.
CREATE FUNCTION public.fn_cash_accept_hand_provenance(p_table uuid,p_number bigint,p_hand uuid,
 p_stacks jsonb,p_rake numeric,p_bbj numeric,p_inflow numeric,p_hash text,p_request jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE m public.cash_hand_participant_manifests%ROWTYPE; x jsonb; y jsonb; v_id uuid;
 v_n integer; v_count integer; v_delta numeric:=0; v_people jsonb:='[]'; v_issues jsonb:='[]'; v_tournament uuid;
BEGIN
 IF p_request IS NULL OR p_request->'stacks' IS DISTINCT FROM p_stacks
  OR p_request->>'table_id' IS DISTINCT FROM p_table::text
  OR p_request->>'hand_number' IS DISTINCT FROM p_number::text
  OR encode(extensions.digest(convert_to(p_request::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM p_hash THEN
  RAISE EXCEPTION 'Original cash accepted request hash mismatch' USING ERRCODE='23514'; END IF;
 SELECT tournament_id INTO v_tournament FROM public.tables WHERE id=p_table;
 IF v_tournament IS NOT NULL THEN RETURN; END IF;
 SELECT count(DISTINCT value->>'funding_manifest_id'),count(*) FILTER(WHERE value->>'funding_manifest_id' IS NOT NULL)
 INTO v_n,v_count FROM jsonb_array_elements(p_stacks);
 IF v_count=0 THEN
  INSERT INTO public.cash_hand_provenance_receipts(table_id,hand_number,hand_id,payload_hash,accepted_request,status,participants,
   signed_external_net,rake,bbj,all_players_included,funding_provenance_complete,issues)
  VALUES(p_table,p_number,p_hand,p_hash,p_request,'uncertified',p_stacks,p_inflow,p_rake,p_bbj,false,false,
   '["original_dealt_manifest_missing"]');
  RETURN;
 END IF;
 IF v_n<>1 OR v_count<>jsonb_array_length(p_stacks) THEN
  RAISE EXCEPTION 'Incomplete or conflicting cash manifest references' USING ERRCODE='23514'; END IF;
 v_id:=(p_stacks->0->>'funding_manifest_id')::uuid;
 SELECT * INTO STRICT m FROM public.cash_hand_participant_manifests WHERE id=v_id AND table_id=p_table AND hand_number=p_number;
 IF jsonb_array_length(m.participants)<>jsonb_array_length(p_stacks) THEN
  RAISE EXCEPTION 'Cash manifest participant set mismatch' USING ERRCODE='23514'; END IF;
 IF (SELECT count(DISTINCT value->>'user_id') FROM jsonb_array_elements(p_stacks))<>jsonb_array_length(p_stacks) THEN
  RAISE EXCEPTION 'Duplicate cash manifest participant' USING ERRCODE='23514'; END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(m.participants) LOOP
  SELECT value INTO y FROM jsonb_array_elements(p_stacks) WHERE value->>'user_id'=x->>'user_id';
  IF y IS NULL OR y->>'seat_id' IS DISTINCT FROM x->>'seat_id'
   OR (y->>'seat_joined_at')::timestamptz IS DISTINCT FROM (x->>'seat_joined_at')::timestamptz
   OR y->>'occupancy_id' IS DISTINCT FROM x->>'occupancy_id'
   OR (y->>'stack_before')::numeric IS DISTINCT FROM (x->>'stack_before')::numeric
   OR jsonb_typeof(y->'stack') IS DISTINCT FROM 'number'
   OR (y->>'stack')::numeric<0 OR (y->>'stack')::numeric<>round((y->>'stack')::numeric,2)
   OR y->>'stack' IN ('NaN','Infinity','-Infinity') THEN
   RAISE EXCEPTION 'Cash manifest original participant mismatch' USING ERRCODE='23514'; END IF;
  v_delta:=v_delta+(y->>'stack')::numeric-(x->>'stack_before')::numeric;
  v_people:=v_people||jsonb_build_array(x||jsonb_build_object('stack_after',y->'stack',
   'poker_delta',(y->>'stack')::numeric-(x->>'stack_before')::numeric));
 END LOOP;
 IF coalesce(p_rake,0)::text IN ('NaN','Infinity','-Infinity')
  OR coalesce(p_bbj,0)::text IN ('NaN','Infinity','-Infinity')
  OR coalesce(p_inflow,0)::text IN ('NaN','Infinity','-Infinity')
  OR coalesce(p_rake,0)<>round(coalesce(p_rake,0),2)
  OR coalesce(p_bbj,0)<>round(coalesce(p_bbj,0),2)
  OR coalesce(p_inflow,0)<>round(coalesce(p_inflow,0),2)
  OR coalesce(p_rake,0)<0 OR coalesce(p_bbj,0)<0
  OR v_delta+coalesce(p_rake,0)+coalesce(p_bbj,0) IS DISTINCT FROM coalesce(p_inflow,0) THEN
  RAISE EXCEPTION 'Cash manifest signed conservation mismatch' USING ERRCODE='23514'; END IF;
 v_issues:=m.issues;
 -- A signed net is conserved, but external-bank linkage and commercial terms
 -- must still be proven separately. Captured funding is not whole-period PNL.
 IF coalesce(p_inflow,0)<>0 THEN v_issues:=v_issues||'"external_bank_receipt_not_certified"'::jsonb; END IF;
 INSERT INTO public.cash_hand_provenance_receipts(table_id,hand_number,hand_id,payload_hash,accepted_request,manifest_id,status,
  game_scope,participants,signed_external_net,rake,bbj,all_players_included,funding_provenance_complete,issues)
 VALUES(p_table,p_number,p_hand,p_hash,p_request,v_id,CASE WHEN jsonb_array_length(v_issues)=0 THEN 'captured' ELSE 'uncertified' END,
  m.game_scope,v_people,coalesce(p_inflow,0),coalesce(p_rake,0),coalesce(p_bbj,0),true,m.funding_provenance_complete,v_issues);
END $$;
REVOKE ALL ON FUNCTION public.fn_cash_accept_hand_provenance(uuid,bigint,uuid,jsonb,numeric,numeric,numeric,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

DO $precondition$
BEGIN
 IF md5(pg_get_functiondef('public.atomic_table_addon_before_maintenance_announcement_gate(uuid,uuid,numeric,boolean,text)'::regprocedure)) IS DISTINCT FROM '24ba3517dc15db92ba4d8fae175f839b'
 OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.atomic_table_addon_before_maintenance_announcement_gate(uuid,uuid,numeric,boolean,text)'::regprocedure) IS DISTINCT FROM 'postgres'
 OR (SELECT proacl::text FROM pg_proc WHERE oid='public.atomic_table_addon_before_maintenance_announcement_gate(uuid,uuid,numeric,boolean,text)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' THEN
  RAISE EXCEPTION 'Original funding prerequisite changed: atomic_table_addon_before_maintenance_announcement_gate(uuid,uuid,numeric,boolean,text)';
 END IF;
END $precondition$;

CREATE OR REPLACE FUNCTION public.atomic_table_addon_before_maintenance_announcement_gate(p_user_id uuid, p_table_id uuid, p_amount numeric, p_apply_to_seat boolean DEFAULT true, p_idempotency_key text DEFAULT NULL::text)
 RETURNS numeric
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_original_ledger uuid; v_original_wallet uuid; v_original_pending uuid; v_new_balance numeric; v_claimed integer; v_seat_club uuid; v_seat_rows integer;
        v_stack numeric; v_max numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Add-on amount must be positive';
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Cannot add on for another user';
  END IF;

  PERFORM set_config('app.ledger_category', 'addon', true);
  PERFORM set_config('app.ledger_counterparty', 'table_stack', true);
  PERFORM set_config('app.ledger_counterparty_entity', COALESCE(p_table_id::text, ''), true);

  SELECT ts.club_id, ts.stack INTO v_seat_club, v_stack
    FROM table_seats ts
   WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id AND ts.left_at IS NULL
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Player not seated at this table'; END IF;

  /* CHIP CONTINUITY (A0.17, I2): the table maximum is a hard ceiling in the
     database as well as in the engine. Between hands the chips land on the
     seat here; mid-hand resolve_pending_addon already caps at delivery. */
  IF p_apply_to_seat THEN
    SELECT t.max_buy_in INTO v_max FROM tables t WHERE t.id = p_table_id;
    IF v_max IS NOT NULL AND v_max > 0 AND COALESCE(v_stack, 0) + p_amount > v_max THEN
      RAISE EXCEPTION 'BUYIN_ABOVE_MAX: add-on of % would take the stack above the table maximum (%)', p_amount, v_max;
    END IF;
  END IF;

  IF v_seat_club IS NULL THEN
    v_seat_club := public.fn_seat_club_for_user(p_user_id, p_table_id, NULL);
  END IF;
  IF v_seat_club IS NULL THEN
    RAISE EXCEPTION 'No club wallet resolves for this add-on';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO table_addon_idempotency (key, user_id, table_id, amount, applied_to_seat)
    VALUES (p_idempotency_key, p_user_id, p_table_id, p_amount, p_apply_to_seat)
    ON CONFLICT (key) DO NOTHING;
    GET DIAGNOSTICS v_claimed = ROW_COUNT;
    IF v_claimed = 0 THEN
      SELECT chip_balance INTO v_new_balance FROM club_members
       WHERE user_id = p_user_id AND club_id = v_seat_club;
      RETURN v_new_balance;
    END IF;
  END IF;

  PERFORM public.fn_ensure_club_wallet(p_user_id, v_seat_club);

  PERFORM set_config('app.cash_original_debit_ledger','',true);
  UPDATE club_members
     SET chip_balance = chip_balance - p_amount, updated_at = NOW()
   WHERE user_id = p_user_id AND club_id = v_seat_club AND chip_balance >= p_amount
   RETURNING chip_balance INTO v_new_balance;
  v_original_ledger:=NULLIF(current_setting('app.cash_original_debit_ledger',true),'')::uuid;
  IF v_new_balance IS NULL THEN
    RAISE EXCEPTION 'Insufficient club chips for add-on (club %)', v_seat_club;
  END IF;

  IF p_apply_to_seat THEN
    UPDATE table_seats SET stack = stack + p_amount
     WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;
    GET DIAGNOSTICS v_seat_rows = ROW_COUNT;
    IF v_seat_rows = 0 THEN
      RAISE EXCEPTION
        'Add-on of % could not be applied: seat vacated mid-add-on (table %, player %)',
        p_amount, p_table_id, p_user_id;
    END IF;
    -- CHIP CONTINUITY: chips landed on the seat -> baseline rises with them.
    PERFORM public.fn_cash_session_add_baseline(p_user_id, p_table_id, p_amount);
  ELSE
    INSERT INTO table_pending_addons (table_id, user_id, amount)
    VALUES (p_table_id, p_user_id, p_amount) RETURNING id INTO v_original_pending;
  END IF;

  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'debit', p_amount, 'addon',
            'Table add-on (club wallet)', p_table_id, v_new_balance) RETURNING id INTO v_original_wallet;

  PERFORM public.fn_cash_record_original_funding('addon',p_idempotency_key::text,p_user_id,p_table_id,
    v_original_ledger,v_original_wallet,v_seat_club,p_amount,v_new_balance,v_original_pending);

  RETURN v_new_balance;
END;
$function$
;

DO $precondition$
BEGIN
 IF md5(pg_get_functiondef('public.atomic_table_buyin_before_maintenance_announcement_gate(uuid,uuid,integer,numeric,boolean,uuid,uuid)'::regprocedure)) IS DISTINCT FROM '4cbe24de1feec2406956b7b3ff042ef6'
 OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.atomic_table_buyin_before_maintenance_announcement_gate(uuid,uuid,integer,numeric,boolean,uuid,uuid)'::regprocedure) IS DISTINCT FROM 'postgres'
 OR (SELECT proacl::text FROM pg_proc WHERE oid='public.atomic_table_buyin_before_maintenance_announcement_gate(uuid,uuid,integer,numeric,boolean,uuid,uuid)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' THEN
  RAISE EXCEPTION 'Original funding prerequisite changed: atomic_table_buyin_before_maintenance_announcement_gate(uuid,uuid,integer,numeric,boolean,uuid,uuid)';
 END IF;
END $precondition$;

CREATE OR REPLACE FUNCTION public.atomic_table_buyin_before_maintenance_announcement_gate(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_amount numeric, p_auto_rebuy boolean DEFAULT false, p_club_id uuid DEFAULT NULL::uuid, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_original_ledger uuid; v_original_wallet uuid; v_original_pending uuid;
  v_is_template boolean;
  v_vip_only boolean;
  v_is_vip boolean;
  v_staff boolean;
  v_floor numeric;
  v_effective_min numeric;
  v_max_players integer;
  v_seats_taken integer;
  v_holds integer := 0;
  v_moves integer := 0;
  v_new_balance NUMERIC;
  v_club_id UUID;
  v_union_id UUID;
  v_ban_id UUID;
  v_min_buy_in NUMERIC;
  v_max_buy_in NUMERIC;
  v_tournament_id UUID;
  v_active_tables INT;
  v_seat_club UUID;
  v_max_tables CONSTANT INT := 4;
BEGIN
  PERFORM set_config('app.money_path', 'atomic_table_buyin', true); -- CHIP STANDARD C2: sanctioned seat creator (trg_ca_guard_seat_creation)
    -- THE ONLY IDEMPOTENCY GUARD IN THIS FUNCTION. Do not add a second one.
    IF p_idempotency_key IS NOT NULL THEN
        INSERT INTO public.transaction_idempotency_keys (key, user_id, action, amount)
        VALUES (p_idempotency_key, p_user_id, 'atomic_table_buyin', p_amount) ON CONFLICT (key) DO NOTHING;
        IF NOT FOUND THEN
            RETURN;
        END IF;
    END IF;
  -- ── A DEAD SESSION MOVES NO MONEY (Dan 2026-09-03) ────────────────────
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE = '28000';
  END IF;
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( auth.uid() <> p_user_id)) THEN
    RAISE EXCEPTION 'Cannot buy in for another user';
  END IF;

  /* ZERO-DRIFT (2026-08-31): declare the ledger context so the wallet debit
     journals as a buy-in against the table, not an anonymous adjustment. */
  PERFORM set_config('app.ledger_category', 'buyin', true);
  PERFORM set_config('app.ledger_counterparty', 'table_stack', true);
  PERFORM set_config('app.ledger_counterparty_entity', COALESCE(p_table_id::text, ''), true);

  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text, 0));

  SELECT t.club_id, c.union_id, t.min_buy_in, t.max_buy_in, COALESCE(t.max_players, 0),
         COALESCE(t.is_vip_only, false), COALESCE(t.is_template, false), t.tournament_id
    INTO v_club_id, v_union_id, v_min_buy_in, v_max_buy_in, v_max_players,
         v_vip_only, v_is_template, v_tournament_id
    FROM tables t LEFT JOIN clubs c ON c.id = t.club_id
   WHERE t.id = p_table_id LIMIT 1;

  IF v_is_template THEN
    RAISE EXCEPTION 'IS_TEMPLATE: this is a saved table template, not a live game';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Invalid buy-in amount';
  END IF;
  IF v_min_buy_in IS NOT NULL AND v_min_buy_in > 0 AND p_amount < v_min_buy_in THEN
    RAISE EXCEPTION 'Buy-in below table minimum (min %)', v_min_buy_in;
  END IF;
  IF v_max_buy_in IS NOT NULL AND v_max_buy_in > 0 AND p_amount > v_max_buy_in THEN
    RAISE EXCEPTION 'Buy-in above table maximum (max %)', v_max_buy_in;
  END IF;

  /* CHIP CONTINUITY (2026-09-04, I7): the rejoin floor. Keyed on club +
     variant + sb + bb, never on this table, so it follows the player to any
     table of the same game in this club and to no other game (A0.7-A0.10).
     effective_min = min(table.max, max(table.min, required)). This replaces
     the per-table opt-in column block that stood here. */
  IF v_tournament_id IS NULL THEN
    v_floor := public.fn_cash_rejoin_floor(p_user_id, p_table_id);
    IF v_floor IS NOT NULL THEN
      v_effective_min := GREATEST(COALESCE(v_min_buy_in, 0), v_floor);
      IF v_max_buy_in IS NOT NULL AND v_max_buy_in > 0 THEN
        v_effective_min := LEAST(v_effective_min, v_max_buy_in);
      END IF;
      IF p_amount < v_effective_min THEN
        RAISE EXCEPTION 'BUYIN_BELOW_FLOOR: minimum buy-in for this game right now is %', v_effective_min
          USING HINT = 'The minimum for this game is higher for you at the moment.';
      END IF;
    END IF;
  END IF;

  IF v_club_id IS NOT NULL THEN
    SELECT id INTO v_ban_id FROM blacklists
     WHERE user_id = p_user_id
       AND (expires_at IS NULL OR expires_at > now())
       AND (club_id = v_club_id OR (v_union_id IS NOT NULL AND union_id = v_union_id))
     LIMIT 1;
    IF v_ban_id IS NOT NULL THEN
      RAISE EXCEPTION 'Banned from this club';
    END IF;
  END IF;

  IF v_vip_only THEN
    SELECT COALESCE(p.is_vip, false)
           AND (p.vip_expires_at IS NULL OR p.vip_expires_at > now())
      INTO v_is_vip
      FROM profiles p WHERE p.id = p_user_id LIMIT 1;

    IF NOT COALESCE(v_is_vip, false) AND v_club_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM club_members cm
         WHERE cm.club_id = v_club_id AND cm.user_id = p_user_id
           AND cm.role IN ('owner', 'co_owner', 'admin', 'manager', 'agent')
      ) OR EXISTS (
        SELECT 1 FROM clubs c WHERE c.id = v_club_id AND c.owner_id = p_user_id
      ) INTO v_staff;
    END IF;

    IF NOT COALESCE(v_is_vip, false) AND NOT COALESCE(v_staff, false) THEN
      RAISE EXCEPTION 'VIP_ONLY: this table is open to VIP members only'
        USING HINT = 'VIP membership is required to take a seat at this table.';
    END IF;
  END IF;

  DECLARE v_nit jsonb;
  BEGIN
    v_nit := public.fn_nit_check(p_table_id, p_user_id, NULL);
    IF (v_nit->>'ok')::boolean = false AND v_nit->>'reason' = 'career_vpip' THEN
      RAISE EXCEPTION 'NIT_GAME: this table needs a career VPIP of at least %, and yours is % over % hands',
        v_nit->>'required', v_nit->>'vpip', v_nit->>'hands'
        USING HINT = 'The host has set a minimum voluntarily-put-in-pot rate for this game.';
    END IF;
  END;

  IF EXISTS (SELECT 1 FROM table_seats
              WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL) THEN
    RAISE EXCEPTION 'Player already seated at this table';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('table_seat:' || p_table_id::text, 0));

  IF v_max_players > 0 AND p_seat_number > v_max_players THEN
    RAISE EXCEPTION 'TABLE_SIZE: seat % does not exist at this table (% max)',
      p_seat_number, v_max_players;
  END IF;

  IF v_max_players > 0 THEN
    SELECT COUNT(*) INTO v_seats_taken
      FROM table_seats
     WHERE table_id = p_table_id AND left_at IS NULL;
    IF v_seats_taken >= v_max_players THEN
      RAISE EXCEPTION 'TABLE_SIZE: table is full (% of % seats taken)',
        v_seats_taken, v_max_players;
    END IF;

    SELECT COUNT(*) INTO v_holds
      FROM public.table_waitlist w
     WHERE w.table_id = p_table_id
       AND w.status = 'notified'
       AND w.user_id <> p_user_id
       AND COALESCE(w.hold_expires_at, w.notified_at + interval '60 seconds') > now();
    -- THE DOOR HONOURS THE CHAIR THE GAME PROMISED (2026-09-10). A pending
    -- must-move / break / balance / seat-change plan into this table is a
    -- reservation everywhere else (fn_cash_game_open_seats, the planner, the
    -- lobby); a linked swap row is not (both chairs are occupied). Counted
    -- here exactly as fn_cash_game_open_seats counts it, never against the
    -- player it is for.
    SELECT COUNT(*) INTO v_moves
      FROM public.cash_seat_moves m
     WHERE m.to_table_id = p_table_id
       AND m.state = 'pending'
       AND m.swap_move_id IS NULL
       AND m.player_id <> p_user_id;
    IF v_seats_taken + v_holds >= v_max_players THEN
      RAISE EXCEPTION 'SEAT_RESERVED: the open seat is held for the next player on the waiting list'
        USING HINT = 'Join the waitlist to get the next seat in order.';
    END IF;
    IF v_seats_taken + v_holds + v_moves >= v_max_players THEN
      RAISE EXCEPTION 'SEAT_RESERVED: the open seat is held for a player the game is moving here'
        USING HINT = 'Tap Join Game for the next open chair.';
    END IF;
  END IF;

  SELECT COUNT(*) INTO v_active_tables
    FROM table_seats ts JOIN tables t ON t.id = ts.table_id
   WHERE ts.user_id = p_user_id AND ts.left_at IS NULL
     AND t.tournament_id IS NULL AND t.status NOT IN ('closed','deleted');
  IF v_active_tables >= v_max_tables THEN
    RAISE EXCEPTION 'TABLE_CAP_REACHED: already seated at % cash tables (max %)', v_active_tables, v_max_tables;
  END IF;

  v_seat_club := public.fn_seat_club_for_user(p_user_id, p_table_id, p_club_id);
  IF v_seat_club IS NULL THEN
    RAISE EXCEPTION 'No club wallet resolves for this player at this table'
      USING HINT = 'The player must hold a membership in a club that belongs to this game''s union.';
  END IF;

  PERFORM public.fn_ensure_club_wallet(p_user_id, v_seat_club);

  PERFORM set_config('app.cash_original_debit_ledger','',true);
  UPDATE club_members
     SET chip_balance = chip_balance - p_amount, updated_at = NOW()
   WHERE user_id = p_user_id AND club_id = v_seat_club AND chip_balance >= p_amount
   RETURNING chip_balance INTO v_new_balance;
  v_original_ledger:=NULLIF(current_setting('app.cash_original_debit_ledger',true),'')::uuid;

  IF v_new_balance IS NULL THEN
    RAISE EXCEPTION 'Insufficient club chips for buy-in (club %)', v_seat_club;
  END IF;

  DELETE FROM table_seats
   WHERE table_id = p_table_id AND seat_number = p_seat_number AND left_at IS NOT NULL;

  INSERT INTO table_seats (table_id, seat_number, user_id, stack, status, auto_rebuy, club_id)
       VALUES (p_table_id, p_seat_number, p_user_id, p_amount, 'active', p_auto_rebuy, v_seat_club);

  -- CHIP CONTINUITY: the session opens with the seat. baseline = this buy-in.
  PERFORM public.fn_cash_session_open(p_user_id, p_table_id, p_amount);

  UPDATE public.table_waitlist
     SET status = 'seated'
   WHERE table_id = p_table_id
     AND user_id = p_user_id
     AND status IN ('waiting', 'notified');

  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'debit', p_amount, 'buyin',
            'Cash game buy-in (club wallet)', p_table_id, v_new_balance) RETURNING id INTO v_original_wallet;

  PERFORM public.fn_cash_record_original_funding('buyin',p_idempotency_key::text,p_user_id,p_table_id,
    v_original_ledger,v_original_wallet,v_seat_club,p_amount,v_new_balance,v_original_pending);

  UPDATE tables
     SET current_players = (SELECT COUNT(*) FROM table_seats
                             WHERE table_id = p_table_id AND left_at IS NULL)
   WHERE id = p_table_id;
END;
$function$
;

DO $precondition$
BEGIN
 IF md5(pg_get_functiondef('public.atomic_table_rebuy_before_maintenance_announcement_gate(uuid,uuid,numeric,uuid)'::regprocedure)) IS DISTINCT FROM '7b987a8d9bc21645b5bf7ba1bde36f85'
 OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.atomic_table_rebuy_before_maintenance_announcement_gate(uuid,uuid,numeric,uuid)'::regprocedure) IS DISTINCT FROM 'postgres'
 OR (SELECT proacl::text FROM pg_proc WHERE oid='public.atomic_table_rebuy_before_maintenance_announcement_gate(uuid,uuid,numeric,uuid)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' THEN
  RAISE EXCEPTION 'Original funding prerequisite changed: atomic_table_rebuy_before_maintenance_announcement_gate(uuid,uuid,numeric,uuid)';
 END IF;
END $precondition$;

CREATE OR REPLACE FUNCTION public.atomic_table_rebuy_before_maintenance_announcement_gate(p_user_id uuid, p_table_id uuid, p_amount numeric, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_original_ledger uuid; v_original_wallet uuid; v_original_pending uuid;
  v_new_balance numeric; v_club_id uuid; v_union_id uuid; v_ban_id uuid; v_seat_club uuid;
  v_seat_id uuid; v_pending uuid;
  v_context jsonb; v_setting text;
BEGIN
  -- ── A DEAD SESSION MOVES NO MONEY (Dan 2026-09-03) ────────────────────
  -- "I WAS LOGGED OUT, BUT SOMEHOW ABLE TO SIT DOWN AND BUY CHIPS AND GET
  -- DEALT A HAND. THAT CAN NEVER HAPPEN." It could, because this project
  -- issues SEVEN-DAY access tokens and PostgREST verifies a JWT locally -
  -- signature and exp only. It never asks GoTrue whether the session behind
  -- that token still exists, so signing out left a bearer token that kept
  -- spending real chips as its owner for the rest of the week. The engine
  -- was never fooled (it verifies through auth.getUser, which checks the
  -- session), only the database was. fn_caller_session_is_live closes that
  -- gap at the money door itself.
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE = '28000';
  END IF;
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( auth.uid() <> p_user_id)) THEN
    RAISE EXCEPTION 'Cannot rebuy for another player';
  END IF;

  IF p_user_id IS NULL OR p_table_id IS NULL OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'Rebuy requires a player, table and purchase key' USING ERRCODE='22023';
  END IF;
  IF p_amount IS NULL OR p_amount::text IN ('NaN','Infinity','-Infinity')
     OR p_amount<=0 OR p_amount<>round(p_amount,2) THEN
    RAISE EXCEPTION 'Rebuy amount must be positive whole cents' USING ERRCODE='22023';
  END IF;

  INSERT INTO public.transaction_idempotency_keys(key,user_id,action,amount)
  VALUES(p_idempotency_key,p_user_id,'atomic_table_rebuy',p_amount) ON CONFLICT(key) DO NOTHING;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unbound rebuy key must be resolved by the shared purchase receipt' USING ERRCODE='55000';
  END IF;

  /* ZERO-DRIFT (2026-08-31): lock the seat so it cannot vacate between this
     check and the debit below. */
  SELECT ts.id, ts.club_id INTO v_seat_id, v_seat_club
    FROM table_seats ts
   WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id AND ts.left_at IS NULL
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Player not seated at this table (cannot rebuy a vacated seat)';
  END IF;

  SELECT t.club_id, c.union_id INTO v_club_id, v_union_id
    FROM tables t LEFT JOIN clubs c ON c.id = t.club_id WHERE t.id = p_table_id LIMIT 1;
  IF v_club_id IS NOT NULL THEN
    SELECT id INTO v_ban_id FROM blacklists
     WHERE user_id = p_user_id AND (expires_at IS NULL OR expires_at > now())
       AND (club_id = v_club_id OR (v_union_id IS NOT NULL AND union_id = v_union_id))
     LIMIT 1;
    IF v_ban_id IS NOT NULL THEN RAISE EXCEPTION 'Banned from this club'; END IF;
  END IF;

  IF v_seat_club IS NULL THEN
    v_seat_club := public.fn_seat_club_for_user(p_user_id, p_table_id, NULL);
  END IF;
  IF v_seat_club IS NULL THEN
    RAISE EXCEPTION 'No club wallet resolves for this rebuy';
  END IF;

  SELECT jsonb_object_agg(k,coalesce(current_setting(k,true),'')) INTO v_context
   FROM unnest(array['app.money_path','app.ledger_category','app.ledger_counterparty','app.ledger_counterparty_entity','app.ledger_tournament']) settings(k);
  PERFORM set_config('app.money_path','atomic_table_rebuy',true);
  PERFORM set_config('app.ledger_category','rebuy',true);
  PERFORM set_config('app.ledger_counterparty','table_stack',true);
  PERFORM set_config('app.ledger_counterparty_entity',p_table_id::text,true);
  PERFORM set_config('app.ledger_tournament','',true);
  PERFORM public.fn_ensure_club_wallet(p_user_id, v_seat_club);

  PERFORM set_config('app.cash_original_debit_ledger','',true);
  UPDATE club_members
     SET chip_balance = chip_balance - p_amount, updated_at = NOW()
   WHERE user_id = p_user_id AND club_id = v_seat_club AND chip_balance >= p_amount
   RETURNING chip_balance INTO v_new_balance;
  v_original_ledger:=NULLIF(current_setting('app.cash_original_debit_ledger',true),'')::uuid;
  IF v_new_balance IS NULL THEN
    RAISE EXCEPTION 'Insufficient club chips for rebuy (club %)', v_seat_club;
  END IF;

  /* CHIP STANDARD C3 (2026-09-02): the chips do NOT go onto the seat here.
     This used to be a relative `stack + p_amount` UPDATE on table_seats,
     racing the engine's absolute writes: a rebuy committing after
     loadSeatedPlayers and before the next syncStacks was erased from the felt
     while the wallet stayed debited. The debit and this row land in ONE
     transaction; the engine's resolve_pending_addon delivers the chips into its
     own memory first and only then persists, so nothing can overwrite them. */
  INSERT INTO public.table_pending_addons (table_id, user_id, amount, kind)
  VALUES (p_table_id, p_user_id, p_amount, 'rebuy')
  RETURNING id INTO v_pending;

  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'debit', p_amount, 'rebuy',
            'Cash game rebuy (club wallet)', p_table_id, v_new_balance) RETURNING id INTO v_original_wallet;

  PERFORM public.fn_cash_record_original_funding('rebuy',p_idempotency_key::text,p_user_id,p_table_id,
    v_original_ledger,v_original_wallet,v_seat_club,p_amount,v_new_balance,v_pending);

  FOR v_setting IN SELECT jsonb_object_keys(v_context) LOOP
    PERFORM set_config(v_setting,v_context->>v_setting,true);
  END LOOP;
  RETURN v_new_balance;
END;
$function$
;

DO $precondition$
BEGIN
 IF md5(pg_get_functiondef('public.fn_club_members_ledger_writer()'::regprocedure)) IS DISTINCT FROM '1f8bc3e17233defa23ebfda4e30015db'
 OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_club_members_ledger_writer()'::regprocedure) IS DISTINCT FROM 'postgres'
 OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_club_members_ledger_writer()'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
  RAISE EXCEPTION 'Original funding prerequisite changed: fn_club_members_ledger_writer()';
 END IF;
END $precondition$;

CREATE OR REPLACE FUNCTION public.fn_club_members_ledger_writer()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_original_ledger uuid;
  d     numeric;
  actor uuid;
  cat   text;
  tid   uuid;
  st    text;
  msg   text;
  cp    text;
  cpid  uuid;
BEGIN
  /* THE AUTOSKIP CONTRACT IS ONE CONTRACT (2026-09-09). Every other journal
     writer on this platform stands down when the caller sets
     app.ledger_autoskip_<table>, because the caller is writing the leg itself
     with the period, the key and the metadata that only it knows. This writer
     never learned that clause. So a settlement that suppressed the clubs
     trigger and wrote its own named leg still got an anonymous twin from this
     side, and the movement reached the journal twice: on 2026-09-09 round 2
     moved 20,377.49 of commission and recorded 40,754.98 of legs. Standing
     down here is what makes one movement, one leg true for the busiest
     balance column on the platform. */
  IF current_setting('app.ledger_autoskip_club_members', true) = '1' THEN
    RETURN NEW;
  END IF;

  d := COALESCE(NEW.chip_balance, 0) - COALESCE(OLD.chip_balance, 0);

  IF d = 0 THEN
    RETURN NEW;
  END IF;

  actor := COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);

  cat := COALESCE(NULLIF(current_setting('app.ledger_category', true), ''), 'adjustment');

  BEGIN
    tid := NULLIF(current_setting('app.ledger_tournament', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    tid := NULL;
  END;

  /* THE COUNTERPARTY IS DECLARED, NEVER INFERRED (2026-08-31). */
  cp := COALESCE(NULLIF(current_setting('app.ledger_counterparty', true), ''), 'settlement_suspense');
  BEGIN
    cpid := NULLIF(current_setting('app.ledger_counterparty_entity', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    cpid := NULL;
  END;

  BEGIN
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, tournament_id, description)
    VALUES (
      actor,
      CASE WHEN d > 0 THEN cp              ELSE 'player_wallet' END,
      CASE WHEN d > 0 THEN cpid            ELSE NEW.user_id     END,
      CASE WHEN d > 0 THEN 'player_wallet' ELSE cp              END,
      CASE WHEN d > 0 THEN NEW.user_id     ELSE cpid            END,
      abs(d), cat, NEW.club_id, tid,
      'auto-audited club_members.chip_balance delta ' || d::text)
    RETURNING id INTO v_original_ledger;
    -- Private original-debit callers read this immediately after their UPDATE.
    PERFORM set_config('app.cash_original_debit_ledger',v_original_ledger::text,true);

  EXCEPTION WHEN OTHERS THEN
      -- A journal failure must abort the enclosing chip movement.
      -- Preserve SQLSTATE so the existing caller can retry the whole operation.
      RAISE;
    END;

  RETURN NEW;
END;
$function$
;

DO $precondition$
BEGIN
 IF md5(pg_get_functiondef('public.fn_horse_fund_from_treasury_before_maintenance_gate(uuid,uuid,numeric,uuid)'::regprocedure)) IS DISTINCT FROM '0319e207986e5f10c7dcfb2ce2080cef'
 OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_horse_fund_from_treasury_before_maintenance_gate(uuid,uuid,numeric,uuid)'::regprocedure) IS DISTINCT FROM 'postgres'
 OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_horse_fund_from_treasury_before_maintenance_gate(uuid,uuid,numeric,uuid)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' THEN
  RAISE EXCEPTION 'Original funding prerequisite changed: fn_horse_fund_from_treasury_before_maintenance_gate(uuid,uuid,numeric,uuid)';
 END IF;
END $precondition$;

CREATE OR REPLACE FUNCTION public.fn_horse_fund_from_treasury_before_maintenance_gate(p_table_id uuid, p_user_id uuid, p_amount numeric, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_original_ledger uuid;
  v_club_id uuid;
  v_fund_club uuid;
  v_treasury numeric;
  v_new_stack numeric;
  v_prior public.chip_ledger;
  v_skip text := COALESCE(current_setting('app.ledger_autoskip_clubs', true), '');
BEGIN
  IF p_table_id IS NULL OR p_user_id IS NULL OR p_amount IS NULL OR p_amount <= 0
     OR p_amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_amount <> round(p_amount, 2) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'table, user and positive amount required'
    );
  END IF;

  SELECT club_id
    INTO v_club_id
    FROM public.tables
   WHERE id = p_table_id;
  IF v_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'table has no club');
  END IF;

  -- THE CLUB THE SEAT REPRESENTS PAYS (lane E, 2026-09-11). A union table's
  -- tables.club_id is the union row, which holds no treasury (0.50 on Midway
  -- after 09-02); the seat was bought from a member club's wallet
  -- (table_seats.club_id, stamped by fn_seat_club_for_user) and that club's
  -- treasury is the one that reloads it - the same club the cash-out credits.
  -- A seat with no club stamp (none live today) keeps the table's club.
  SELECT ts.club_id
    INTO v_fund_club
    FROM public.table_seats ts
   WHERE ts.table_id = p_table_id
     AND ts.user_id = p_user_id
     AND ts.left_at IS NULL
   ORDER BY ts.joined_at DESC
   LIMIT 1;
  v_fund_club := COALESCE(v_fund_club, v_club_id);

  IF NOT public.fn_actor_can_manage_club_treasury(v_fund_club) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'not authorized to fund from club treasury'
    );
  END IF;

  IF p_op_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('horse_fund:' || p_op_id::text, 0)
    );
    SELECT *
      INTO v_prior
      FROM public.chip_ledger
     WHERE idempotency_key = 'horse_fund:' || p_op_id::text;
    IF FOUND THEN
      IF v_prior.table_id IS DISTINCT FROM p_table_id
         OR v_prior.club_id IS DISTINCT FROM v_fund_club
         OR v_prior.amount IS DISTINCT FROM p_amount
         OR v_prior.metadata->>'user_id' IS DISTINCT FROM p_user_id::text
         OR v_prior.category IS DISTINCT FROM 'horse_funding'
         OR v_prior.from_type IS DISTINCT FROM 'club_treasury'
         OR v_prior.to_type IS DISTINCT FROM 'table_stack' THEN
        RAISE EXCEPTION 'Horse funding identity reused with different payload'
          USING ERRCODE = '22023';
      END IF;
      RETURN jsonb_build_object(
        'success', true,
        'replayed', true,
        'op_id', p_op_id,
        'table_id', p_table_id,
        'user_id', p_user_id,
        'club_id', v_club_id,
        'treasury_club_id', v_fund_club,
        'amount', p_amount,
        'new_stack', v_prior.metadata->'new_stack',
        'treasury_after', v_prior.metadata->'treasury_after'
      );
    END IF;
  END IF;

  SELECT COALESCE(chip_treasury, 0)
    INTO v_treasury
    FROM public.clubs
   WHERE id = v_fund_club
   FOR UPDATE;
  IF v_treasury IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'club not found');
  END IF;
  IF v_treasury < p_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'insufficient club treasury',
      'treasury', v_treasury,
      'needed', p_amount,
      'treasury_club_id', v_fund_club
    );
  END IF;

  UPDATE public.table_seats
     SET stack = COALESCE(stack, 0) + p_amount
   WHERE table_id = p_table_id
     AND user_id = p_user_id
     AND left_at IS NULL
  RETURNING stack INTO v_new_stack;

  IF v_new_stack IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'no active seat for user at table'
    );
  END IF;

  PERFORM public.fn_cash_session_add_baseline(p_user_id, p_table_id, p_amount);

  PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
  UPDATE public.clubs
     SET chip_treasury = COALESCE(chip_treasury, 0) - p_amount,
         updated_at = NOW()
   WHERE id = v_fund_club;
  PERFORM set_config('app.ledger_autoskip_clubs', v_skip, true);

  INSERT INTO public.chip_transactions (
    id,
    club_id,
    from_user_id,
    to_user_id,
    amount,
    transaction_type,
    notes,
    balance_after,
    created_at
  ) VALUES (
    gen_random_uuid(),
    v_fund_club,
    NULL,
    p_user_id,
    p_amount,
    'horse_treasury_funding',
    'Horse buy-in/rebuy funded from club treasury',
    v_treasury - p_amount,
    NOW()
  );

  BEGIN
    INSERT INTO public.chip_ledger (
      performed_by,
      from_type,
      from_entity_id,
      to_type,
      to_entity_id,
      amount,
      category,
      club_id,
      table_id,
      description,
      idempotency_key,
      metadata
    ) VALUES (
      COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
      'club_treasury',
      v_fund_club,
      'table_stack',
      p_table_id,
      p_amount,
      'horse_funding',
      v_fund_club,
      p_table_id,
      'Buy-in/rebuy funded from club treasury (fn_horse_fund_from_treasury) for '
        || p_user_id::text,
      CASE
        WHEN p_op_id IS NULL THEN NULL
        ELSE 'horse_fund:' || p_op_id::text
      END,
      jsonb_build_object(
        'user_id', p_user_id,
        'op_id', p_op_id,
        'door', 'fn_horse_fund_from_treasury',
        'table_club_id', v_club_id,
        'new_stack', v_new_stack,
        'treasury_after', v_treasury - p_amount
      )
    ) RETURNING id INTO v_original_ledger;
    PERFORM public.fn_cash_record_original_funding('horse_funding',p_op_id::text,p_user_id,p_table_id,
      v_original_ledger,NULL,v_fund_club,p_amount,v_treasury-p_amount,NULL);
  EXCEPTION WHEN OTHERS THEN
    -- A journal failure aborts the entire chip movement. Bare RAISE preserves
    -- the original SQLSTATE, DETAIL, HINT and context for the caller's retry.
    RAISE;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'new_stack', v_new_stack,
    'treasury_after', v_treasury - p_amount,
    'op_id', p_op_id,
    'table_id', p_table_id,
    'user_id', p_user_id,
    'club_id', v_club_id,
    'treasury_club_id', v_fund_club,
    'amount', p_amount
  );
END;
$function$
;

DO $precondition$
BEGIN
 IF md5(pg_get_functiondef('public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'::regprocedure)) IS DISTINCT FROM '7d47c01ec2c1b38f3cf9faeeb686514b'
 OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'::regprocedure) IS DISTINCT FROM 'postgres'
 OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' THEN
  RAISE EXCEPTION 'Original funding prerequisite changed: fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)';
 END IF;
END $precondition$;

CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement_before_lease_generation(p_table_id uuid, p_hand_number bigint, p_stacks jsonb, p_rake numeric, p_bbj numeric, p_ref text, p_inflow numeric, p_hand_row jsonb, p_units jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_stack_result jsonb;
  v_hand_id uuid;
  v_existing public.hand_history%ROWTYPE;
  v_prior public.hand_atomic_commits%ROWTYPE;
  v_commit_hash text;
  v_normalized_stacks jsonb;
  v_normalized_units jsonb;
  v_stack jsonb;
  v_uid uuid;
  v_written numeric;
  v_before numeric;
  v_seat record;
  v_zero_generation jsonb;
  v_zero_generation_count integer;
  v_prompt_until timestamptz;
  v_rebuy_window jsonb;
  v_rebuy_offer_available boolean;
  v_n integer;
  v_distinct integer;
  v_changed integer;
  v_candidate_id uuid;
BEGIN
  -- External authority is the EXECUTE ACL on the lease-fenced public wrapper.
  -- This nested SECURITY DEFINER core is owner-only and must remain callable
  -- when its preserved production owner is neither postgres nor service_role.
  IF p_table_id IS NULL OR p_hand_number IS NULL OR p_hand_number<1000000
     OR jsonb_typeof(p_stacks)<>'array' OR jsonb_array_length(p_stacks)=0
     OR jsonb_typeof(p_hand_row)<>'object'
     OR jsonb_typeof(coalesce(p_units,'[]'::jsonb))<>'array'
     OR coalesce(p_hand_row->>'table_id','')<>p_table_id::text
     OR coalesce(p_hand_row->>'hand_number','')<>p_hand_number::text THEN
    RETURN jsonb_build_object('success',false,'reason','invalid_atomic_hand_payload');
  END IF;

  SELECT count(*), count(DISTINCT x->>'user_id')
    INTO v_n, v_distinct
    FROM jsonb_array_elements(p_stacks) x
   WHERE jsonb_typeof(x)='object'
     AND coalesce(x->>'user_id','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND jsonb_typeof(x->'stack')='number'
     AND jsonb_typeof(x->'stack_before')='number'
     AND (x->>'stack')::numeric>=0
     AND (x->>'stack_before')::numeric>=0;
  IF v_n<>jsonb_array_length(p_stacks) OR v_distinct<>v_n THEN
    RETURN jsonb_build_object('success',false,'reason','invalid_or_duplicate_stack_rows');
  END IF;

  SELECT jsonb_agg(x ORDER BY x->>'user_id') INTO v_normalized_stacks
    FROM jsonb_array_elements(p_stacks) x;
  SELECT coalesce(jsonb_agg(x ORDER BY x::text),'[]'::jsonb) INTO v_normalized_units
    FROM jsonb_array_elements(coalesce(p_units,'[]'::jsonb)) x;
  v_commit_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'table_id',p_table_id,'hand_number',p_hand_number,
    'stacks',v_normalized_stacks,'rake',p_rake,'bbj',p_bbj,
    'ref',p_ref,'inflow',p_inflow,'hand_row',p_hand_row,
    'units',v_normalized_units)::text,'UTF8'),'sha256'),'hex');

  -- Lock order is global tournament lifecycle -> table -> exact table hand.
  -- Paid admissions take the global root exclusively before the same table
  -- lock; unrelated hands share the lifecycle root and remain concurrent.
  PERFORM public.fn_ca_share_settlement_lane_for_table(p_table_id);
  PERFORM pg_advisory_xact_lock(
    hashtextextended('atomic-table:'||p_table_id::text,0));
  PERFORM pg_advisory_xact_lock(
    hashtextextended('atomic-hand:'||p_hand_number::text,0));

  SELECT * INTO v_prior
    FROM public.hand_atomic_commits c
   WHERE c.table_id=p_table_id
     AND c.hand_number=p_hand_number
   FOR UPDATE;
  IF FOUND THEN
    IF v_prior.payload_hash IS DISTINCT FROM v_commit_hash THEN
      RETURN jsonb_build_object(
        'success',false,'reason','atomic_hand_payload_conflict',
        'hand_number',p_hand_number,'existing_table_id',v_prior.table_id);
    END IF;
    RETURN v_prior.stack_result || jsonb_build_object(
      'success',true,'atomic_hand_commit',true,'replay',true,
      'history_id',v_prior.hand_id,'commit_hash',v_prior.payload_hash);
  END IF;

  SELECT t.tournament_id INTO v_tournament_id
    FROM public.tables t WHERE t.id=p_table_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success',false,'reason','table_not_found');
  END IF;

  IF (p_hand_row->>'tournament_id') IS DISTINCT FROM v_tournament_id::text THEN
    RETURN jsonb_build_object(
      'success',false,'reason','hand_tournament_mismatch',
      'table_tournament_id',v_tournament_id,
      'row_tournament_id',p_hand_row->>'tournament_id');
  END IF;

  BEGIN
    IF v_tournament_id IS NOT NULL THEN
      PERFORM 1 FROM public.tournaments t WHERE t.id=v_tournament_id FOR SHARE;
      PERFORM 1
        FROM public.tournament_players tp
       WHERE tp.tournament_id=v_tournament_id
         AND tp.user_id IN (
           SELECT (x->>'user_id')::uuid FROM jsonb_array_elements(p_stacks) x)
       ORDER BY tp.user_id
       FOR UPDATE;
    END IF;

    v_stack_result := public.fn_ca_settle_hand_stacks_absolute(
      p_table_id,p_hand_number,v_normalized_stacks,p_rake,p_bbj,p_ref,p_inflow);
    IF coalesce((v_stack_result->>'success')::boolean,false) IS NOT TRUE THEN
      RETURN v_stack_result || jsonb_build_object('atomic_hand_commit',false);
    END IF;
    IF coalesce((v_stack_result->>'replay')::boolean,false) IS TRUE THEN
      RAISE EXCEPTION 'legacy stack settlement exists for hand % without an atomic receipt',
        p_hand_number USING ERRCODE='integrity_constraint_violation';
    END IF;

    SELECT * INTO v_existing
      FROM public.hand_history h
     WHERE h.table_id=p_table_id AND h.hand_number=p_hand_number;
    IF FOUND THEN
      RAISE EXCEPTION 'hand % already exists without an atomic commit receipt',p_hand_number
        USING ERRCODE='integrity_constraint_violation';
    ELSE
      PERFORM set_config('app.atomic_hand_commit','on',true);
      v_hand_id := public.fn_ca_insert_hand_with_awards(p_hand_row,p_units);
    END IF;

    IF v_tournament_id IS NOT NULL THEN
      IF jsonb_typeof(
           v_stack_result->'tournament_zero_stack_seat_generations')
             IS DISTINCT FROM 'array'
         OR jsonb_array_length(
              v_stack_result->'tournament_zero_stack_seat_generations')
              IS DISTINCT FROM
              COALESCE(
                (v_stack_result->>'tournament_zero_stack_seat_count')::integer,-1)
         OR (
              COALESCE(
                (v_stack_result->>'tournament_zero_stack_seat_count')::integer,-1) > 0
              AND (v_stack_result->>'tournament_zero_stack_vacated_at') IS NULL
            ) THEN
        RAISE EXCEPTION
          'accepted tournament hand omitted exact zero-seat generation evidence';
      END IF;

      FOR v_stack IN SELECT value FROM jsonb_array_elements(p_stacks)
      LOOP
        v_uid := (v_stack->>'user_id')::uuid;
        v_before := round((v_stack->>'stack_before')::numeric,2);
        v_written := round((v_stack_result->'written'->>v_uid::text)::numeric,2);
        IF v_written IS NULL THEN
          RAISE EXCEPTION 'accepted tournament hand omitted written stack for %',v_uid;
        END IF;
        IF v_written<>trunc(v_written) THEN
          RAISE EXCEPTION 'accepted tournament hand produced fractional stack % for %',v_written,v_uid;
        END IF;

        IF v_written=0 THEN
          SELECT count(*) INTO v_zero_generation_count
            FROM jsonb_array_elements(
                   v_stack_result->'tournament_zero_stack_seat_generations') g(value)
           WHERE g.value->>'user_id'=v_uid::text;
          IF v_zero_generation_count<>1 THEN
            RAISE EXCEPTION
              'accepted tournament hand has % zero-seat generations for %',
              v_zero_generation_count,v_uid USING ERRCODE='P0404';
          END IF;
          SELECT g.value INTO v_zero_generation
            FROM jsonb_array_elements(
                   v_stack_result->'tournament_zero_stack_seat_generations') g(value)
           WHERE g.value->>'user_id'=v_uid::text;
          SELECT s.id,s.joined_at,s.seat_number
            INTO v_seat
            FROM public.table_seats s
           WHERE s.id=(v_zero_generation->>'seat_id')::uuid
             AND s.table_id=p_table_id
             AND s.user_id=v_uid
             AND s.seat_number=(v_zero_generation->>'seat_number')::integer
             AND s.joined_at=(v_zero_generation->>'joined_at')::timestamptz
             AND s.stack=0
             AND s.left_at=
                   (v_stack_result->>'tournament_zero_stack_vacated_at')::timestamptz
             AND lower(COALESCE(s.status,''))='left'
           FOR UPDATE;
          IF NOT FOUND THEN
            RAISE EXCEPTION
              'accepted tournament hand lost exact closed seat generation for %',v_uid
              USING ERRCODE='P0404';
          END IF;
        ELSE
          SELECT s.id,s.joined_at,s.seat_number
            INTO v_seat
            FROM public.table_seats s
           WHERE s.table_id=p_table_id AND s.user_id=v_uid AND s.left_at IS NULL
           FOR UPDATE;
          IF NOT FOUND THEN
            RAISE EXCEPTION
              'accepted tournament hand lost active seat for % before generation capture',v_uid;
          END IF;
        END IF;

        UPDATE public.tournament_players tp
           SET chips=greatest(v_written,0)::integer,
               table_id=p_table_id,
               seat_number=v_seat.seat_number
         WHERE tp.tournament_id=v_tournament_id AND tp.user_id=v_uid
           AND tp.status='playing';
        GET DIAGNOSTICS v_changed=ROW_COUNT;
        IF v_changed<>1 AND NOT EXISTS (
          SELECT 1 FROM public.tournament_players tp
           WHERE tp.tournament_id=v_tournament_id AND tp.user_id=v_uid
             AND tp.status='playing'
             AND tp.chips=greatest(v_written,0)::integer
             AND tp.table_id=p_table_id
             AND tp.seat_number=v_seat.seat_number) THEN
          RAISE EXCEPTION
            'accepted tournament hand could not mirror playing roster row for %',v_uid;
        END IF;

        IF v_before>0 AND v_written=0 THEN
          SELECT
            (coalesce(t.is_rebuy,false)
               AND (t.max_rebuys IS NULL OR coalesce(tp.rebuys,0)<t.max_rebuys))
            OR
            (coalesce(t.is_reentry,false)
               AND (t.max_reentries IS NULL OR coalesce(tp.rebuys,0)<t.max_reentries)),
            public.fn_ca_tournament_rebuy_window(v_tournament_id)
            INTO v_rebuy_offer_available,v_rebuy_window
            FROM public.tournaments t
            JOIN public.tournament_players tp
              ON tp.tournament_id=t.id AND tp.user_id=v_uid
           WHERE t.id=v_tournament_id;
          v_prompt_until:=CASE
            WHEN v_rebuy_offer_available
             AND coalesce((v_rebuy_window->>'open')::boolean,false)
            THEN (v_rebuy_window->>'prompt_until')::timestamptz
            ELSE NULL END;
          IF v_prompt_until IS NOT NULL
             AND v_prompt_until<=clock_timestamp() THEN
            RAISE EXCEPTION
              'authoritative rebuy window returned an expired prompt for tournament %',
              v_tournament_id USING ERRCODE='P0404';
          END IF;

          v_candidate_id := NULL;
          INSERT INTO public.tournament_knockout_candidates(
            tournament_id,eliminated_user_id,table_id,seat_id,seat_joined_at,
            hand_id,hand_number,stack_before,stack_after,rebuy_prompt_until)
          VALUES (
            v_tournament_id,v_uid,p_table_id,v_seat.id,v_seat.joined_at,
            v_hand_id,p_hand_number,v_before,0,v_prompt_until)
          -- One accepted hand is one immutable knockout generation. A rebuy can
          -- bust again in the same physical chair, so chair identity must never
          -- absorb that later hand.
          ON CONFLICT (tournament_id,hand_number,eliminated_user_id) DO NOTHING
          RETURNING id INTO v_candidate_id;
          IF v_candidate_id IS NULL AND NOT EXISTS (
            SELECT 1 FROM public.tournament_knockout_candidates c
             WHERE c.tournament_id=v_tournament_id
               AND c.hand_number=p_hand_number
               AND c.eliminated_user_id=v_uid
               AND c.table_id=p_table_id
               AND c.seat_id=v_seat.id
               AND c.seat_joined_at=v_seat.joined_at
               AND c.hand_id=v_hand_id
               AND c.stack_before=v_before
               AND c.stack_after=0) THEN
            RAISE EXCEPTION
              'knockout candidate identity conflict for tournament %, hand %, user %',
              v_tournament_id,p_hand_number,v_uid;
          END IF;

          UPDATE public.tournament_players tp
             SET rebuy_prompt_until=v_prompt_until
           WHERE tp.tournament_id=v_tournament_id AND tp.user_id=v_uid
             AND tp.status='playing';
        END IF;
      END LOOP;
    END IF;

    INSERT INTO public.hand_projection_outbox(hand_id,table_id,hand_number)
    VALUES (v_hand_id,p_table_id,p_hand_number);

    INSERT INTO public.hand_atomic_commits(
      table_id,hand_number,hand_id,payload_hash,stack_result)
    VALUES (p_table_id,p_hand_number,v_hand_id,v_commit_hash,v_stack_result);

    PERFORM public.fn_cash_accept_hand_provenance(p_table_id,p_hand_number,v_hand_id,
      v_normalized_stacks,p_rake,p_bbj,p_inflow,v_commit_hash,
      jsonb_build_object(
        'table_id',p_table_id,'hand_number',p_hand_number,
        'stacks',v_normalized_stacks,'rake',p_rake,'bbj',p_bbj,
        'ref',p_ref,'inflow',p_inflow,'hand_row',p_hand_row,
        'units',v_normalized_units));

    RETURN v_stack_result || jsonb_build_object(
      'success',true,
      'atomic_hand_commit',true,
      'history_id',v_hand_id,
      'tournament_id',v_tournament_id,
      'commit_hash',v_commit_hash);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success',false,'atomic_hand_commit',false,'reason','atomic_hand_rolled_back',
      'error',SQLERRM,'sqlstate',SQLSTATE,'table_id',p_table_id,
      'hand_number',p_hand_number,'commit_hash',v_commit_hash);
  END;
END;
$function$
;

DO $precondition$
BEGIN
 IF md5(pg_get_functiondef('public.resolve_pending_addon(uuid,numeric)'::regprocedure)) IS DISTINCT FROM '4e80f2eb738493201ed63838abd00b7d'
 OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.resolve_pending_addon(uuid,numeric)'::regprocedure) IS DISTINCT FROM 'postgres'
 OR (SELECT proacl::text FROM pg_proc WHERE oid='public.resolve_pending_addon(uuid,numeric)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
  RAISE EXCEPTION 'Original funding prerequisite changed: resolve_pending_addon(uuid,numeric)';
 END IF;
END $precondition$;

CREATE OR REPLACE FUNCTION public.resolve_pending_addon(p_pending_id uuid, p_max_buy_in numeric DEFAULT NULL::numeric)
 RETURNS TABLE(applied numeric, refunded numeric, was_resolved boolean)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_original_occupancy uuid;
  v_row        table_pending_addons%ROWTYPE;
  v_stack      numeric;
  v_headroom   numeric;
  v_applied    numeric := 0;
  v_refunded   numeric := 0;
  v_credit     numeric := 0;
BEGIN
  SELECT * INTO v_row
    FROM table_pending_addons
   WHERE id = p_pending_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending add-on % not found', p_pending_id;
  END IF;

  IF v_row.resolved_at IS NOT NULL THEN
    applied      := COALESCE(v_row.applied_to_stack, 0);
    refunded     := COALESCE(v_row.refunded, 0);
    was_resolved := false;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT stack INTO v_stack
    FROM table_seats
   WHERE table_id = v_row.table_id
     AND user_id  = v_row.user_id
     AND left_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    -- Seat vacated: the whole debit comes back. Exact, not rounded, so the
    -- receipt still sums to the stored amount for a historical dusty row.
    v_applied  := 0;
    v_refunded := v_row.amount;
  ELSE
    IF p_max_buy_in IS NULL THEN
      v_applied := v_row.amount;
    ELSE
      v_headroom := GREATEST(round(COALESCE(p_max_buy_in, 0), 2) - COALESCE(v_stack, 0), 0);
      v_applied  := LEAST(v_row.amount, v_headroom);
    END IF;

    -- ROUND THE APPLIED SIDE FIRST, THEN DERIVE THE REFUND FROM THE STORED
    -- AMOUNT. It used to be the other way round - `refunded := ROUND(amount -
    -- applied, 2)` against an UNROUNDED applied - so the two summed to the
    -- amount only when the amount was already 2 dp. That is what makes a
    -- non-cent row unresolvable against the post-commit obligation check,
    -- rather than merely untidy. This ordering holds for every input.
    v_applied  := round(v_applied, 2);
    IF v_applied > v_row.amount THEN
      v_applied := v_row.amount;   -- rounding up may never exceed the debit
    END IF;
    v_refunded := v_row.amount - v_applied;

    IF v_applied > 0 THEN
      UPDATE table_seats
         SET stack = COALESCE(stack, 0) + v_applied
       WHERE table_id = v_row.table_id
         AND user_id  = v_row.user_id
         AND left_at IS NULL RETURNING occupancy_id INTO v_original_occupancy;
      -- CHIP CONTINUITY (I10): a reload in place is not a leave; the baseline
      -- rises by what was delivered, never by what was refunded.
      PERFORM public.fn_cash_session_add_baseline(v_row.user_id, v_row.table_id, v_applied);
    END IF;
  END IF;

  -- The wallet moves in hundredths (its column is numeric(20,2) and would
  -- round this anyway); the RECEIPT below stays exact so the obligation
  -- check can always reconcile it against the stored amount.
  v_credit := round(v_refunded, 2);
  IF v_credit > 0 THEN
    PERFORM atomic_credit_wallet_and_log(
      v_row.user_id,
      v_credit,
      'addon_refund',
      'Add-on refund (exceeds max buy-in or seat vacated)',
      v_row.table_id,
      NULL::uuid,
      NULL::uuid,
      'addon_refund:' || v_row.id::text
    );
  END IF;

  UPDATE table_pending_addons
     SET resolved_at      = now(),
         applied_to_stack = v_applied,
         refunded         = v_refunded
   WHERE id = v_row.id;
  PERFORM public.fn_cash_record_funding_application(v_row.id,v_applied,v_refunded,v_original_occupancy);

  applied      := v_applied;
  refunded     := v_refunded;
  was_resolved := true;
  RETURN NEXT;
END;
$function$
;

COMMIT;
