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
