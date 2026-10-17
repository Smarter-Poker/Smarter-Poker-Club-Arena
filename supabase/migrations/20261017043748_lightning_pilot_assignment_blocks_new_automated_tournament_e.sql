-- Installation creates an INACTIVE exact owner-authorized pilot assignment.
-- Installation changes no seats, bookings or money. A later explicit authenticated
-- exact-zero withdrawal invokes the unchanged normal owner inside one transaction.
-- @live-proof: (SELECT EXISTS(SELECT 1 FROM public.lightning_pilot_assignment WHERE club_id='e14bc9f7-736d-425f-8f2c-e78305ebac1d' AND cardinality(player_ids)=72 AND manifest_sha256='121f80d2529012e532b4d3a702e2772cde9aa7778a82df26f5a02082d2b0ba8a') AND position('fn_lightning_pilot_assignment_blocks' IN pg_get_functiondef('public.fn_register_horse_for_tournament(uuid,uuid,boolean)'::regprocedure))>0 AND position('fn_lightning_pilot_assignment_blocks' IN pg_get_functiondef('public.fn_seat_horse_in_seat_first_game(uuid,uuid)'::regprocedure))>0)
-- @live-proof: (SELECT has_function_privilege('service_role','public.fn_lightning_pilot_assignment_status()','EXECUTE') AND has_function_privilege('service_role','public.fn_lightning_pilot_withdrawal_receipt(uuid,uuid,uuid,uuid)','EXECUTE') AND NOT has_function_privilege('service_role','public.fn_lightning_pilot_assignment_set(boolean,uuid,text,uuid[],text)','EXECUTE') AND NOT has_function_privilege('anon','public.fn_lightning_pilot_assignment_status()','EXECUTE') AND NOT has_table_privilege('service_role','public.lightning_pilot_assignment','UPDATE'))
-- @live-proof: (SELECT EXISTS(SELECT 1 FROM public.ca_money_rpc_registry WHERE proname='fn_lightning_pilot_withdraw_zero' AND status='approved') AND has_function_privilege('authenticated','public.fn_lightning_pilot_withdraw_zero(uuid,uuid,uuid)','EXECUTE') AND NOT has_function_privilege('service_role','public.fn_lightning_pilot_withdraw_zero(uuid,uuid,uuid)','EXECUTE') AND NOT has_function_privilege('anon','public.fn_lightning_pilot_withdraw_zero(uuid,uuid,uuid)','EXECUTE') AND position('fn_unregister_from_tournament(p_tournament_id,p_request_id)' IN pg_get_functiondef('public.fn_lightning_pilot_withdraw_zero(uuid,uuid,uuid)'::regprocedure))>0)
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='20s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_register_horse_for_tournament(uuid,uuid,boolean)'::regprocedure))<>'5137901ece1ed65009185aff44c8cb1e'
 OR md5(pg_get_functiondef('public.fn_seat_horse_in_seat_first_game(uuid,uuid)'::regprocedure))<>'3616e8963b43ac7bd2eb3d3dda6100f3' OR md5(pg_get_functiondef('public.fn_ca_lock_mtt_admission_contract()'::regprocedure))<>'10644d522bb50245f76942ecce735cbc'
 OR md5(pg_get_functiondef('public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)'::regprocedure))<>'9877846ffabee004690e6b24a3ddcee2'
 OR md5(pg_get_functiondef('public.fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid)'::regprocedure))<>'2d7adf316b2651ce9df7530a4008e8c0'
 OR md5(pg_get_functiondef('public.fn_poker_diamond_tournament_unregister(uuid,uuid,uuid)'::regprocedure))<>'88113c3aab85f3e48cfd8debf6e86de1'
 OR md5(pg_get_functiondef('public.fn_unregister_from_tournament(uuid,uuid)'::regprocedure))<>'c39310bcf1158d66bd0aced7bc0f9c73' THEN
 RAISE EXCEPTION 'pilot assignment predecessor mismatch; nothing changed'; END IF;
END $guard$;
CREATE FUNCTION public.fn_lightning_pilot_assignment_players() RETURNS uuid[]
LANGUAGE sql IMMUTABLE SET search_path TO public,pg_temp AS $players$ SELECT ARRAY['0097309f-2864-4d09-b02b-56bca012a9c3'::uuid,'00d92d99-be9f-4e63-8ab0-ec2d6d491bcc'::uuid,'01bd8786-371e-4ba2-85d6-baab469bba07'::uuid,'02c8d806-24c7-40bd-b5b5-30cf96811e3e'::uuid,'02f807c7-52a6-470b-a465-4a45b84a9143'::uuid,'032b7ef6-ef40-4eb7-9a44-21605be733c8'::uuid,'03951af5-7cf1-4164-aaf0-571b647d98d5'::uuid,'04910a99-8757-4581-8c84-12ba8a454a75'::uuid,'05835920-da9b-4739-8fa2-2901b844d11d'::uuid,'05a38e8e-ce5f-44fb-82de-782369bf9fab'::uuid,'060c946d-db8d-4d27-b1ec-a203435764f1'::uuid,'06f16138-70cd-49e5-89b3-aec698118b81'::uuid,'07534039-d056-45bb-adcd-1415ed6a8a08'::uuid,'07db1c71-d567-46dd-8f92-e922b6d470ae'::uuid,'085524dc-e663-4dad-abc5-8442450cc9f1'::uuid,'0860d731-0d86-409a-8384-41a17b99a1f4'::uuid,'096d7521-f924-461e-8c3d-5386a7770170'::uuid,'09dd202d-115b-49ae-afa8-cb528c7b8f72'::uuid,'09faf9f3-ed77-4582-9242-c464cb88fa93'::uuid,'0a1e9f3a-87c2-4a4b-b386-3b88de4ed054'::uuid,'0a558bc1-50c5-4201-b6ca-c7a1e7de1c22'::uuid,'0a714eff-ef23-4928-b2a7-addecc97b467'::uuid,'0a9625c9-f679-4d98-9ebe-d8bb005c45b6'::uuid,'0b1a64c2-8970-4f89-a396-9863e3aa2ccc'::uuid,'0bea449d-73af-4654-bf19-61db087d7d45'::uuid,'0c7ad36f-7ad2-4faa-963f-69ee2f9f5062'::uuid,'0f14f372-0c43-47ff-9257-1324a7e94488'::uuid,'0fdb265e-7a56-4ecf-8410-eecd49923e42'::uuid,'10d08b4f-f6da-41ea-a66c-e97a0d4930e0'::uuid,'1110a1ed-fcf2-423b-9d9a-bc615a16cbd5'::uuid,'1179f15e-dac7-4b7e-80df-5e525a498ddd'::uuid,'119d8e7f-1b09-4299-810e-89dc9a6a6277'::uuid,'127bff9a-8483-4018-80ac-21d7f76ce5c7'::uuid,'171038e5-f50e-4bdd-988f-621a7ce9479c'::uuid,'194e5206-bd4d-4ea5-ba2d-142c8bf8a258'::uuid,'19ab1b66-ddba-4b06-bea0-f55c9a3100c7'::uuid,'19de9af5-6576-4ebb-92c6-1fe53599f782'::uuid,'204a6a80-8b83-4cff-98ed-e89f4da7c4dc'::uuid,'2072ad2e-869c-4537-a3dd-0def0c889401'::uuid,'2143ec37-02ed-4712-9642-a56f1945c379'::uuid,'227ba92c-9b8c-4705-ba76-181f1f697638'::uuid,'22f02ebc-4757-4e06-99e6-f7e4a95720b4'::uuid,'24219aee-cce4-4660-9e80-fac05602aeae'::uuid,'24d7c0ff-1b60-453c-8095-836594f30125'::uuid,'2610f833-88cd-4a55-b255-75b75070b5da'::uuid,'26fc77c4-60fc-406b-bf17-5f4b35777ec7'::uuid,'285055c6-96a7-4a60-9033-51f83f49dbcb'::uuid,'2936c42b-ebe2-4fd8-bc70-eee5e263d014'::uuid,'2958f800-0cca-43a8-8486-08e524434199'::uuid,'3086452e-9b29-47eb-b6f8-5a9692889753'::uuid,'3c1d70c8-c46a-4e2c-bcc8-dbe53798799a'::uuid,'3e4ff3e2-f212-4966-abe7-4988e5a62704'::uuid,'3faa1e32-afb8-4b21-9530-2a9fd81c5766'::uuid,'47dd33b3-1bd6-41a7-951e-8582dae98c5a'::uuid,'4a686160-2102-4cba-b3e5-cfa3b1856602'::uuid,'4ce9fa05-703f-40e4-a14e-40cffc3ba305'::uuid,'4ed0fef4-d9fd-41d0-852d-4a52f4193dd2'::uuid,'4ffcc7ec-15a1-4c80-8309-e893ef9db022'::uuid,'6162b471-d011-41f7-ad89-9a8d856c9ffb'::uuid,'62f0d4da-b736-4629-ad14-894e432d0f04'::uuid,'697d34f5-fe65-422a-b624-5a4957ef4196'::uuid,'6d301010-3315-4694-b55d-812ae56110c5'::uuid,'778f8033-c9e2-45fa-98ca-935f38e2b8ca'::uuid,'78d65d90-7234-4d43-816e-9c29e81dd33d'::uuid,'7d1b678f-cea8-41fc-873e-2ec47ea5c318'::uuid,'7d7a80a2-092c-4338-878a-0416611b249c'::uuid,'82861181-5a96-4e7b-bfa4-b75ca2bd145f'::uuid,'84385ab0-d3ea-44c1-8e93-6fa6b1d25457'::uuid,'86468a23-14cb-4602-92f7-7e270197fc3c'::uuid,'8e5a0e02-7832-416d-970f-f6f74e181dcb'::uuid,'92cd4964-6206-4989-9730-b7959bae6dc5'::uuid,'a23ca5c9-b748-482f-9b59-9db35f7aa996'::uuid] $players$;
REVOKE ALL ON FUNCTION public.fn_lightning_pilot_assignment_players() FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE public.lightning_pilot_assignment (
 club_id uuid PRIMARY KEY CHECK(club_id='e14bc9f7-736d-425f-8f2c-e78305ebac1d'),
 active boolean NOT NULL DEFAULT false,
 player_ids uuid[] NOT NULL CHECK(player_ids=public.fn_lightning_pilot_assignment_players()),
 manifest_sha256 text NOT NULL CHECK(manifest_sha256='121f80d2529012e532b4d3a702e2772cde9aa7778a82df26f5a02082d2b0ba8a'),
 last_request_id uuid, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.lightning_pilot_assignment_receipts (
 request_id uuid PRIMARY KEY, actor_id uuid NOT NULL, active boolean NOT NULL,
 manifest_sha256 text NOT NULL, player_ids uuid[] NOT NULL, reason text NOT NULL,
 receipt jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.lightning_pilot_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lightning_pilot_assignment_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lightning_pilot_assignment,public.lightning_pilot_assignment_receipts FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO public.lightning_pilot_assignment(club_id,player_ids,manifest_sha256)
VALUES('e14bc9f7-736d-425f-8f2c-e78305ebac1d',public.fn_lightning_pilot_assignment_players(),'121f80d2529012e532b4d3a702e2772cde9aa7778a82df26f5a02082d2b0ba8a');

CREATE FUNCTION public.fn_lightning_pilot_assignment_status() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $status$
BEGIN
 IF coalesce(auth.role(),'')<>'service_role' AND (auth.uid() IS DISTINCT FROM '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid OR public.fn_caller_session_is_live() IS DISTINCT FROM true) THEN
 RAISE EXCEPTION 'pilot assignment not authorized' USING ERRCODE='42501'; END IF;
 RETURN (SELECT jsonb_build_object('club_id',club_id,'active',active,'player_ids',player_ids,'manifest_sha256',manifest_sha256,'last_request_id',last_request_id,'updated_at',updated_at) FROM public.lightning_pilot_assignment);
END $status$;
REVOKE ALL ON FUNCTION public.fn_lightning_pilot_assignment_status() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_lightning_pilot_assignment_status() TO authenticated,service_role;

CREATE FUNCTION public.fn_lightning_pilot_assignment_set(p_active boolean,p_request_id uuid,p_manifest_sha256 text,p_player_ids uuid[],p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp SET statement_timeout='15s' AS $control$
DECLARE prior public.lightning_pilot_assignment_receipts%ROWTYPE; v_players uuid[]; v_result jsonb;
BEGIN
 IF auth.uid() IS DISTINCT FROM '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid OR public.fn_caller_session_is_live() IS DISTINCT FROM true THEN
 RAISE EXCEPTION 'pilot assignment not authorized' USING ERRCODE='42501'; END IF;
 IF p_active IS NULL OR p_request_id IS NULL OR p_manifest_sha256 IS DISTINCT FROM '121f80d2529012e532b4d3a702e2772cde9aa7778a82df26f5a02082d2b0ba8a' OR length(btrim(coalesce(p_reason,'')))<12 THEN
 RAISE EXCEPTION 'pilot assignment input mismatch' USING ERRCODE='22023'; END IF;
 SELECT array_agg(x ORDER BY x) INTO v_players FROM unnest(p_player_ids) x;
 IF cardinality(v_players) IS DISTINCT FROM 72 OR v_players IS DISTINCT FROM public.fn_lightning_pilot_assignment_players() THEN
 RAISE EXCEPTION 'pilot assignment participant manifest mismatch' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(176217,72);
 SELECT * INTO prior FROM public.lightning_pilot_assignment_receipts WHERE request_id=p_request_id;
 IF FOUND THEN
  IF prior.actor_id IS DISTINCT FROM auth.uid() OR prior.active IS DISTINCT FROM p_active OR prior.manifest_sha256 IS DISTINCT FROM p_manifest_sha256 OR prior.player_ids IS DISTINCT FROM v_players OR prior.reason IS DISTINCT FROM btrim(p_reason) THEN
   RAISE EXCEPTION 'pilot assignment request intent mismatch' USING ERRCODE='22023'; END IF;
  RETURN prior.receipt;
 END IF;
 IF p_active THEN
  IF NOT EXISTS(SELECT 1 FROM public.clubs WHERE id='e14bc9f7-736d-425f-8f2c-e78305ebac1d' AND owner_id=auth.uid() AND is_public=false)
  OR EXISTS(SELECT 1 FROM unnest(v_players) x LEFT JOIN public.profiles p ON p.id=x LEFT JOIN public.club_members cm ON cm.user_id=x AND cm.club_id='e14bc9f7-736d-425f-8f2c-e78305ebac1d' WHERE p.is_horse IS DISTINCT FROM true OR p.status IS DISTINCT FROM 'active' OR cm.status IS NULL OR cm.status NOT IN('active','approved') OR cm.user_id IS NULL)
  OR (SELECT count(*) FROM public.cash_games WHERE (id='56d5d6f0-23e9-41b0-b407-852aa1026c2a' AND template_name='action' AND ruleset_snapshot->>'template'='action' OR id='0cdc133d-ad23-4ace-bb85-312d0f221edd' AND template_name='madness' AND ruleset_snapshot->>'template'='madness') AND club_id='e14bc9f7-736d-425f-8f2c-e78305ebac1d')<>2 THEN
   RAISE EXCEPTION 'pilot assignment current scope changed' USING ERRCODE='55000'; END IF;
 END IF;
 UPDATE public.lightning_pilot_assignment SET active=p_active,last_request_id=p_request_id,updated_at=clock_timestamp()
 WHERE club_id='e14bc9f7-736d-425f-8f2c-e78305ebac1d';
 IF NOT FOUND THEN RAISE EXCEPTION 'pilot assignment state missing' USING ERRCODE='55000'; END IF;
 v_result:=public.fn_lightning_pilot_assignment_status()||jsonb_build_object('ok',true);
 INSERT INTO public.lightning_pilot_assignment_receipts(request_id,actor_id,active,manifest_sha256,player_ids,reason,receipt) VALUES(p_request_id,auth.uid(),p_active,p_manifest_sha256,v_players,btrim(p_reason),v_result);
 RETURN v_result;
END $control$;
REVOKE ALL ON FUNCTION public.fn_lightning_pilot_assignment_set(boolean,uuid,text,uuid[],text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.fn_lightning_pilot_assignment_set(boolean,uuid,text,uuid[],text) TO authenticated;

-- The shared lock lasts through the caller's complete admission transaction.
-- Existing entries/chairs are commitments, not a new automatic admission.
CREATE FUNCTION public.fn_lightning_pilot_assignment_blocks(p_user_id uuid,p_tournament_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $blocks$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(176217,72);
 RETURN EXISTS(SELECT 1 FROM public.lightning_pilot_assignment a WHERE a.active AND p_user_id=ANY(a.player_ids))
 AND NOT EXISTS(SELECT 1 FROM public.tournament_players tp WHERE tp.user_id=p_user_id AND tp.tournament_id=p_tournament_id AND tp.status IN('registered','playing'))
 AND NOT EXISTS(SELECT 1 FROM public.table_seats ts JOIN public.tables t ON t.id=ts.table_id WHERE ts.user_id=p_user_id AND ts.left_at IS NULL AND t.tournament_id=p_tournament_id);
END $blocks$;
REVOKE ALL ON FUNCTION public.fn_lightning_pilot_assignment_blocks(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

DO $patch$
DECLARE d text; changed text; anchor text; inserted text;
BEGIN
 d:=pg_get_functiondef('public.fn_register_horse_for_tournament(uuid,uuid,boolean)'::regprocedure);
 anchor:='BEGIN'||chr(10)||'  -- 20261005224736';
 inserted:=$gate$BEGIN
  IF public.fn_lightning_pilot_assignment_blocks(p_user_id,p_tournament_id) THEN
    -- Genuine target-contract tickets retain their existing paid value.
    -- These are the maintained proof-bearing producer lookups, not bulk hints.
    v_result:=public.fn_ca_find_tournament_entry_ticket_for(p_tournament_id,p_user_id);
    IF coalesce((v_result->>'ok')::boolean,false) IS NOT TRUE THEN RETURN v_result; END IF;
    IF nullif(v_result->>'ticket_id','') IS NULL THEN
      v_result:=public.fn_ca_find_cashier_entry_ticket_for(p_tournament_id,p_user_id);
    END IF;
    IF coalesce((v_result->>'ok')::boolean,false) IS NOT TRUE OR nullif(v_result->>'ticket_id','') IS NULL OR coalesce((v_result->>'ticket_value')::numeric,0)<=0 THEN
      RETURN jsonb_build_object('ok',false,'reason','lightning_pilot_assigned');
    END IF;
    p_allow_wallet_charge:=false;
  END IF;
  -- 20261005224736$gate$;
 IF position(anchor IN d)=0 THEN RAISE EXCEPTION 'pilot assignment register anchor mismatch'; END IF;
 changed:=replace(d,anchor,inserted); EXECUTE changed;
 d:=pg_get_functiondef('public.fn_seat_horse_in_seat_first_game(uuid,uuid)'::regprocedure);
 anchor:='BEGIN'||chr(10)||'  v_gate:=';
 inserted:=$seat$BEGIN
  IF public.fn_lightning_pilot_assignment_blocks(p_user_id,p_tournament_id) THEN
    v_gate:=public.fn_ca_find_tournament_entry_ticket_for(p_tournament_id,p_user_id);
    IF coalesce((v_gate->>'ok')::boolean,false) IS NOT TRUE THEN RETURN v_gate; END IF;
    IF nullif(v_gate->>'ticket_id','') IS NULL THEN
      v_gate:=public.fn_ca_find_cashier_entry_ticket_for(p_tournament_id,p_user_id);
    END IF;
    IF coalesce((v_gate->>'ok')::boolean,false) IS NOT TRUE OR nullif(v_gate->>'ticket_id','') IS NULL OR coalesce((v_gate->>'ticket_value')::numeric,0)<=0 THEN
      RETURN jsonb_build_object('ok',false,'reason','lightning_pilot_assigned');
    END IF;
    -- The existing seat-first core registers through the guarded two-arg door.
    -- That delegates ticket-first with wallet fallback disabled above.
  END IF;
  v_gate:=$seat$;
 IF position(anchor IN d)=0 THEN RAISE EXCEPTION 'pilot assignment seat anchor mismatch'; END IF;
 EXECUTE replace(d,anchor,inserted);
END $patch$;

CREATE FUNCTION public.fn_lightning_pilot_withdrawal_receipt(p_player_id uuid,p_tournament_id uuid,p_registration_id uuid,p_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $receipt$
DECLARE r jsonb;
BEGIN
 IF coalesce(auth.role(),'')<>'service_role' AND (auth.uid() IS DISTINCT FROM '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid OR public.fn_caller_session_is_live() IS DISTINCT FROM true) THEN
 RAISE EXCEPTION 'pilot assignment not authorized' USING ERRCODE='42501'; END IF;
 IF p_player_id IS NULL OR p_tournament_id IS NULL OR p_registration_id IS NULL OR p_request_id IS NULL OR NOT (p_player_id=ANY(public.fn_lightning_pilot_assignment_players())) THEN
 RAISE EXCEPTION 'pilot withdrawal receipt scope mismatch' USING ERRCODE='22023'; END IF;
 r:=public.fn_ca_tournament_unregistration_receipt(p_tournament_id,p_player_id,NULL,p_request_id);
 IF r IS NULL OR r->>'registration_id' IS DISTINCT FROM p_registration_id::text OR r->>'request_id' IS DISTINCT FROM p_request_id::text THEN RETURN NULL; END IF;
 RETURN r;
END $receipt$;
REVOKE ALL ON FUNCTION public.fn_lightning_pilot_withdrawal_receipt(uuid,uuid,uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_lightning_pilot_withdrawal_receipt(uuid,uuid,uuid,uuid) TO authenticated,service_role;

-- This wrapper delegates the existing refund authority; registration in the
-- money RPC registry must precede CREATE, despite its required zero-value gate.
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
('fn_lightning_pilot_withdraw_zero','approved','Owner-authorized exact72 pilot-only withdrawal: lock exact expected registration, require active assignment, verified zero free pre-start unseated entry, call unchanged authenticated unregistration atomically; mismatch or paid obligation rolls back.') ON CONFLICT(proname) DO NOTHING;
CREATE FUNCTION public.fn_lightning_pilot_withdraw_zero(p_tournament_id uuid,p_registration_id uuid,p_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp SET statement_timeout='20s' AS $withdraw$
DECLARE uid uuid:=auth.uid(); t public.tournaments%ROWTYPE; r public.tournament_players%ROWTYPE; c public.poker_diamond_custody%ROWTYPE; result jsonb; diamond boolean;
BEGIN
 IF uid IS NULL OR public.fn_caller_session_is_live() IS DISTINCT FROM true OR NOT(uid=ANY(public.fn_lightning_pilot_assignment_players())) THEN
 RAISE EXCEPTION 'pilot withdrawal not authorized' USING ERRCODE='42501'; END IF;
 IF p_tournament_id IS NULL OR p_registration_id IS NULL OR p_request_id IS NULL THEN
 RAISE EXCEPTION 'pilot withdrawal exact intent required' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock_shared(176217,72);
 IF NOT EXISTS(SELECT 1 FROM public.lightning_pilot_assignment WHERE active AND uid=ANY(player_ids)) THEN
 RAISE EXCEPTION 'pilot withdrawal assignment inactive' USING ERRCODE='55000'; END IF;
 PERFORM public.fn_ca_lock_mtt_admission_contract();
 PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
 SELECT * INTO t FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
 SELECT * INTO r FROM public.tournament_players WHERE tournament_id=p_tournament_id AND user_id=uid FOR UPDATE;
 IF r.id IS DISTINCT FROM p_registration_id OR r.status IS DISTINCT FROM 'registered' OR r.table_id IS NOT NULL OR r.seat_number IS NOT NULL THEN
 RAISE EXCEPTION 'pilot withdrawal registration identity changed' USING ERRCODE='55000'; END IF;
 IF t.id IS NULL OR t.status NOT IN('ANNOUNCED','REGISTERING') OR t.status IS NULL OR t.started_at IS NOT NULL OR t.start_time IS NULL OR clock_timestamp()>=t.start_time
 OR t.buy_in_amount IS DISTINCT FROM 0 OR t.buy_in_fee IS DISTINCT FROM 0 OR t.bounty_amount IS DISTINCT FROM 0 THEN
 RAISE EXCEPTION 'pilot withdrawal requires zero pre-start entry' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM public.tables tb WHERE tb.tournament_id=p_tournament_id AND coalesce(tb.hands_dealt,0)<>0)
 OR EXISTS(SELECT 1 FROM public.hand_history h WHERE h.tournament_id=p_tournament_id)
 OR EXISTS(SELECT 1 FROM public.tables tb JOIN public.hand_history h ON h.table_id=tb.id WHERE tb.tournament_id=p_tournament_id)
 OR EXISTS(SELECT 1 FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id WHERE tb.tournament_id=p_tournament_id AND s.user_id=uid AND s.left_at IS NULL)
 OR EXISTS(SELECT 1 FROM public.wallet_transactions w WHERE w.user_id=uid AND w.related_entity_id=p_tournament_id AND w.type='debit' AND w.amount>0)
 OR EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.from_entity_id=uid AND l.tournament_id=p_tournament_id AND l.amount>0)
 OR EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts f WHERE f.user_id=uid AND f.tournament_id=p_tournament_id AND (f.amount IS DISTINCT FROM 0 OR f.registration_id IS DISTINCT FROM p_registration_id))
 OR EXISTS(SELECT 1 FROM public.tournament_refund_entitlements e WHERE e.user_id=uid AND e.tournament_id=p_tournament_id AND (e.registration_id IS DISTINCT FROM p_registration_id OR e.gross IS DISTINCT FROM 0 OR e.entitlement_kind IS DISTINCT FROM 'wallet_charge'))
 OR EXISTS(SELECT 1 FROM public.poker_diamond_tournament_ledger l WHERE l.user_id=uid AND l.tournament_id=p_tournament_id) THEN
 RAISE EXCEPTION 'pilot withdrawal existing obligation preserved' USING ERRCODE='55000'; END IF;
 diamond:=public.fn_poker_diamond_tournament(p_tournament_id);
 PERFORM 1 FROM public.poker_diamond_custody WHERE user_id=uid AND target_id=p_tournament_id AND purpose='tournament_entry' AND state<>'released' FOR UPDATE;
 IF diamond THEN
  IF (SELECT count(*) FROM public.poker_diamond_custody WHERE user_id=uid AND target_id=p_tournament_id AND purpose='tournament_entry' AND state<>'released')<>1 THEN
   RAISE EXCEPTION 'pilot withdrawal free custody missing' USING ERRCODE='55000'; END IF;
  SELECT * INTO c FROM public.poker_diamond_custody WHERE user_id=uid AND target_id=p_tournament_id AND purpose='tournament_entry' AND state<>'released';
  IF c.state IS DISTINCT FROM 'active' OR c.balance IS DISTINCT FROM 0 OR c.seat_id IS NOT NULL OR c.entry_key IS DISTINCT FROM 'entry:'||p_registration_id::text
  OR EXISTS(SELECT 1 FROM public.poker_diamond_tournament_ledger l WHERE l.custody_id=c.id) THEN
   RAISE EXCEPTION 'pilot withdrawal paid custody preserved' USING ERRCODE='55000'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM public.poker_diamond_custody WHERE user_id=uid AND target_id=p_tournament_id AND purpose='tournament_entry' AND state<>'released') THEN
   RAISE EXCEPTION 'pilot withdrawal unexpected custody' USING ERRCODE='55000'; END IF;
 END IF;
 -- Parent/registration locks remain held across the unchanged normal door.
 result:=public.fn_unregister_from_tournament(p_tournament_id,p_request_id);
 IF coalesce((result->>'ok')::boolean,false) IS NOT TRUE OR result->>'registration_id' IS DISTINCT FROM p_registration_id::text OR result->>'request_id' IS DISTINCT FROM p_request_id::text THEN
 RAISE EXCEPTION 'pilot withdrawal normal receipt changed' USING ERRCODE='P0404'; END IF;
 IF diamond THEN
  IF (result->>'refunded_diamonds')::numeric IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'pilot withdrawal nonzero refund' USING ERRCODE='P0404'; END IF;
 ELSE
  IF (result->>'refunded_chips')::numeric IS DISTINCT FROM 0 OR (result->>'returned_ticket_value')::numeric IS DISTINCT FROM 0 OR (result->>'fees_reversed')::numeric IS DISTINCT FROM 0 THEN
   RAISE EXCEPTION 'pilot withdrawal nonzero refund' USING ERRCODE='P0404'; END IF;
 END IF;
 RETURN result;
END $withdraw$;
REVOKE ALL ON FUNCTION public.fn_lightning_pilot_withdraw_zero(uuid,uuid,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.fn_lightning_pilot_withdraw_zero(uuid,uuid,uuid) TO authenticated;
COMMIT;
