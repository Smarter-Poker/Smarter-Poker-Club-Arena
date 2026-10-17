\set ON_ERROR_STOP on
-- Full actual two production predecessors. Money/ticket/lease delegates are
-- named metadata boundaries; counters detect whether they were reached.
CREATE SCHEMA auth;
CREATE SCHEMA witness;
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claim.role',true),''),'authenticated') $$;
GRANT USAGE ON SCHEMA auth TO authenticated,service_role;
CREATE FUNCTION fn_caller_session_is_live() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('witness.live',true)='true' $$;
CREATE TABLE clubs(id uuid PRIMARY KEY,owner_id uuid,is_public boolean);
CREATE TABLE profiles(id uuid PRIMARY KEY,is_horse boolean,status text);
CREATE TABLE club_members(club_id uuid,user_id uuid,status text);
CREATE TABLE cash_games(id uuid PRIMARY KEY,club_id uuid,template_name text,ruleset_snapshot jsonb);
CREATE TABLE tournament_players(id uuid DEFAULT gen_random_uuid(),tournament_id uuid,user_id uuid,status text);
CREATE TABLE tables(id uuid PRIMARY KEY,tournament_id uuid);
CREATE TABLE table_seats(id uuid DEFAULT gen_random_uuid(),table_id uuid,user_id uuid,left_at timestamptz);
CREATE TABLE tournaments(id uuid PRIMARY KEY,status text,prize_pool_finalized boolean);
CREATE TABLE witness.ticket(event_id uuid,user_id uuid,valid boolean,cashier boolean DEFAULT false);
CREATE TABLE witness.calls(kind text,wallet_allowed boolean);
CREATE FUNCTION fn_poker_diamond_tournament(uuid) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE FUNCTION fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT '{"ok":true}'::jsonb$$;
CREATE FUNCTION fn_ca_entry_paying_club(uuid,uuid) RETURNS uuid LANGUAGE sql AS $$SELECT NULL::uuid$$;
CREATE FUNCTION fn_register_horse_for_tournament_before_terminal_gate(uuid,uuid,boolean) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN INSERT INTO witness.calls VALUES('register',$3); RETURN jsonb_build_object('ok',true,'wallet_allowed',$3); END$$;
CREATE FUNCTION fn_tournament_primary_table(uuid) RETURNS uuid LANGUAGE sql AS $$SELECT id FROM tables WHERE tournament_id=$1 LIMIT 1$$;
CREATE FUNCTION fn_seat_horse_in_seat_first_game_before_terminal_seat_gate(uuid,uuid) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN INSERT INTO witness.calls VALUES('seat',false); RETURN '{"ok":true}'::jsonb; END$$;
-- Actual maintained producer response shape. A valid paid ticket is a target,
-- holder and positive-price proof; invalid/foreign hints return no ticket.
CREATE FUNCTION fn_ca_find_tournament_entry_ticket_for(uuid,uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('ok',true,'ticket_id',CASE WHEN EXISTS(SELECT 1 FROM witness.ticket WHERE event_id=$1 AND user_id=$2 AND valid AND NOT cashier) THEN '90000000-0000-0000-0000-000000000001' ELSE NULL END,'ticket_value',10)$$;
CREATE FUNCTION fn_ca_find_cashier_entry_ticket_for(uuid,uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('ok',true,'ticket_id',CASE WHEN EXISTS(SELECT 1 FROM witness.ticket WHERE event_id=$1 AND user_id=$2 AND valid AND cashier) THEN '90000000-0000-0000-0000-000000000002' ELSE NULL END,'ticket_value',10)$$;
CREATE OR REPLACE FUNCTION public.fn_seat_horse_in_seat_first_game(p_tournament_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_gate jsonb;
  v_status text;
  v_finalized boolean;
BEGIN
  v_gate:=public.fn_ca_lock_tournament_seat_acquisition(
    p_tournament_id,NULL,p_user_id);
  IF COALESCE((v_gate->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_gate;
  END IF;

  -- The canonical parent lock serializes this decision with launch/finalization.
  -- Existing live-chair replay still reaches the original read-only delegate.
  -- Like the human door, only ANNOUNCED/REGISTERING may acquire a fresh chair;
  -- launch need not have finalized the entry pool. NULL/unknown status refuses.
  SELECT t.status,t.prize_pool_finalized INTO v_status,v_finalized
    FROM public.tournaments t WHERE t.id=p_tournament_id;
  IF NOT EXISTS (
       SELECT 1 FROM public.table_seats s
        WHERE s.table_id=public.fn_tournament_primary_table(p_tournament_id)
          AND s.user_id=p_user_id AND s.left_at IS NULL
     ) THEN
    IF (v_status IN ('ANNOUNCED','REGISTERING')) IS NOT TRUE THEN
      RETURN jsonb_build_object('ok',false,'reason','game_already_started');
    END IF;
    IF v_finalized IS TRUE THEN
      RETURN jsonb_build_object('ok',false,'reason','registration_closed');
    END IF;
  END IF;

  RETURN public.fn_seat_horse_in_seat_first_game_before_terminal_seat_gate(
    p_tournament_id,p_user_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_register_horse_for_tournament(p_tournament_id uuid, p_user_id uuid, p_allow_wallet_charge boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_gate jsonb;
  v_paying uuid;
  v_result jsonb;
BEGIN
  -- 20261005224736 / A18 (horse_entry_funding, recorded 2026-10-05) and
  -- CLAUDE.md 10.5 (HORSES ARE PLAYERS - NO EXCEPTIONS). The owner's answer
  -- reads: "a horse funds its Diamond entry from its own balance, through the
  -- ordinary Diamond registration door a person uses." So this is no longer a
  -- blanket refusal resting on a Phase-9 assumption; it is that answer, READ
  -- AT CALL TIME. Changing the answer is one INSERT into ca_diamond_economics
  -- and no code change - 'own_balance' is never hard-coded as the decision.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    DECLARE
      v_horse_entry_funding text;
    BEGIN
      BEGIN
        v_horse_entry_funding :=
          public.fn_ca_diamond_economic_text('horse_entry_funding','all');
      EXCEPTION WHEN SQLSTATE 'P0D01' THEN
        -- No answer recorded. Refuse by name below rather than guess which
        -- funding the owner meant.
        v_horse_entry_funding := NULL;
      END;
      IF v_horse_entry_funding = 'funding_account' THEN
        -- House money, and there is no funding path for it yet. Refused by
        -- name, and the reason names the setting that produced the refusal.
        RETURN jsonb_build_object('ok',false,
          'reason','diamond_horse_funding_account_not_open',
          'horse_entry_funding',v_horse_entry_funding);
      ELSIF v_horse_entry_funding IS DISTINCT FROM 'own_balance' THEN
        RETURN jsonb_build_object('ok',false,
          'reason','diamond_horse_entry_funding_unrecognised',
          'horse_entry_funding',v_horse_entry_funding);
      END IF;
      -- 'own_balance': fall through. The horse takes the same seat-acquisition
      -- lock and the same registration chain a person takes, and pays from its
      -- own profiles.diamonds through the same Diamond door (10.5).
    END;
  END IF;
  v_gate:=public.fn_ca_lock_tournament_seat_acquisition(
    p_tournament_id,NULL,p_user_id);
  IF COALESCE((v_gate->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_gate;
  END IF;
  /* THE WALLET THAT CAN PAY (2026-10-12), exactly as the person's door
     (fn_register_for_tournament) does it - CLAUDE.md 10.5, a horse is
     charged by the same rule. Only when this entry is paid from a wallet. */
  IF COALESCE(p_allow_wallet_charge, false) THEN
    v_paying := public.fn_ca_entry_paying_club(p_user_id, p_tournament_id);
    IF v_paying IS NOT NULL THEN
      PERFORM set_config('app.ca_entry_paying_club',
        p_tournament_id::text || ':' || p_user_id::text || ':' || v_paying::text, true);
    END IF;
  END IF;
  v_result := public.fn_register_horse_for_tournament_before_terminal_gate(
    p_tournament_id,p_user_id,p_allow_wallet_charge);
  PERFORM set_config('app.ca_entry_paying_club', '', true);
  RETURN v_result;
END;
$function$;

CREATE FUNCTION fn_register_horse_for_tournament(uuid,uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO public,pg_temp AS $$SELECT fn_register_horse_for_tournament($1,$2,true)$$;
REVOKE ALL ON FUNCTION fn_register_horse_for_tournament(uuid,uuid,boolean),fn_register_horse_for_tournament(uuid,uuid),fn_seat_horse_in_seat_first_game(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION fn_register_horse_for_tournament(uuid,uuid,boolean),fn_register_horse_for_tournament(uuid,uuid),fn_seat_horse_in_seat_first_game(uuid,uuid) TO service_role;
INSERT INTO clubs VALUES('e14bc9f7-736d-425f-8f2c-e78305ebac1d','2d1cd6c3-5700-4af9-a271-d4863fdab20d',false);
INSERT INTO profiles SELECT x,true,'active' FROM unnest(ARRAY['0097309f-2864-4d09-b02b-56bca012a9c3'::uuid,'00d92d99-be9f-4e63-8ab0-ec2d6d491bcc'::uuid,'01bd8786-371e-4ba2-85d6-baab469bba07'::uuid,'02c8d806-24c7-40bd-b5b5-30cf96811e3e'::uuid,'02f807c7-52a6-470b-a465-4a45b84a9143'::uuid,'032b7ef6-ef40-4eb7-9a44-21605be733c8'::uuid,'03951af5-7cf1-4164-aaf0-571b647d98d5'::uuid,'04910a99-8757-4581-8c84-12ba8a454a75'::uuid,'05835920-da9b-4739-8fa2-2901b844d11d'::uuid,'05a38e8e-ce5f-44fb-82de-782369bf9fab'::uuid,'060c946d-db8d-4d27-b1ec-a203435764f1'::uuid,'06f16138-70cd-49e5-89b3-aec698118b81'::uuid,'07534039-d056-45bb-adcd-1415ed6a8a08'::uuid,'07db1c71-d567-46dd-8f92-e922b6d470ae'::uuid,'085524dc-e663-4dad-abc5-8442450cc9f1'::uuid,'0860d731-0d86-409a-8384-41a17b99a1f4'::uuid,'096d7521-f924-461e-8c3d-5386a7770170'::uuid,'09dd202d-115b-49ae-afa8-cb528c7b8f72'::uuid,'09faf9f3-ed77-4582-9242-c464cb88fa93'::uuid,'0a1e9f3a-87c2-4a4b-b386-3b88de4ed054'::uuid,'0a558bc1-50c5-4201-b6ca-c7a1e7de1c22'::uuid,'0a714eff-ef23-4928-b2a7-addecc97b467'::uuid,'0a9625c9-f679-4d98-9ebe-d8bb005c45b6'::uuid,'0b1a64c2-8970-4f89-a396-9863e3aa2ccc'::uuid,'0bea449d-73af-4654-bf19-61db087d7d45'::uuid,'0c7ad36f-7ad2-4faa-963f-69ee2f9f5062'::uuid,'0f14f372-0c43-47ff-9257-1324a7e94488'::uuid,'0fdb265e-7a56-4ecf-8410-eecd49923e42'::uuid,'10d08b4f-f6da-41ea-a66c-e97a0d4930e0'::uuid,'1110a1ed-fcf2-423b-9d9a-bc615a16cbd5'::uuid,'1179f15e-dac7-4b7e-80df-5e525a498ddd'::uuid,'119d8e7f-1b09-4299-810e-89dc9a6a6277'::uuid,'127bff9a-8483-4018-80ac-21d7f76ce5c7'::uuid,'171038e5-f50e-4bdd-988f-621a7ce9479c'::uuid,'194e5206-bd4d-4ea5-ba2d-142c8bf8a258'::uuid,'19ab1b66-ddba-4b06-bea0-f55c9a3100c7'::uuid,'19de9af5-6576-4ebb-92c6-1fe53599f782'::uuid,'204a6a80-8b83-4cff-98ed-e89f4da7c4dc'::uuid,'2072ad2e-869c-4537-a3dd-0def0c889401'::uuid,'2143ec37-02ed-4712-9642-a56f1945c379'::uuid,'227ba92c-9b8c-4705-ba76-181f1f697638'::uuid,'22f02ebc-4757-4e06-99e6-f7e4a95720b4'::uuid,'24219aee-cce4-4660-9e80-fac05602aeae'::uuid,'24d7c0ff-1b60-453c-8095-836594f30125'::uuid,'2610f833-88cd-4a55-b255-75b75070b5da'::uuid,'26fc77c4-60fc-406b-bf17-5f4b35777ec7'::uuid,'285055c6-96a7-4a60-9033-51f83f49dbcb'::uuid,'2936c42b-ebe2-4fd8-bc70-eee5e263d014'::uuid,'2958f800-0cca-43a8-8486-08e524434199'::uuid,'3086452e-9b29-47eb-b6f8-5a9692889753'::uuid,'3c1d70c8-c46a-4e2c-bcc8-dbe53798799a'::uuid,'3e4ff3e2-f212-4966-abe7-4988e5a62704'::uuid,'3faa1e32-afb8-4b21-9530-2a9fd81c5766'::uuid,'47dd33b3-1bd6-41a7-951e-8582dae98c5a'::uuid,'4a686160-2102-4cba-b3e5-cfa3b1856602'::uuid,'4ce9fa05-703f-40e4-a14e-40cffc3ba305'::uuid,'4ed0fef4-d9fd-41d0-852d-4a52f4193dd2'::uuid,'4ffcc7ec-15a1-4c80-8309-e893ef9db022'::uuid,'6162b471-d011-41f7-ad89-9a8d856c9ffb'::uuid,'62f0d4da-b736-4629-ad14-894e432d0f04'::uuid,'697d34f5-fe65-422a-b624-5a4957ef4196'::uuid,'6d301010-3315-4694-b55d-812ae56110c5'::uuid,'778f8033-c9e2-45fa-98ca-935f38e2b8ca'::uuid,'78d65d90-7234-4d43-816e-9c29e81dd33d'::uuid,'7d1b678f-cea8-41fc-873e-2ec47ea5c318'::uuid,'7d7a80a2-092c-4338-878a-0416611b249c'::uuid,'82861181-5a96-4e7b-bfa4-b75ca2bd145f'::uuid,'84385ab0-d3ea-44c1-8e93-6fa6b1d25457'::uuid,'86468a23-14cb-4602-92f7-7e270197fc3c'::uuid,'8e5a0e02-7832-416d-970f-f6f74e181dcb'::uuid,'92cd4964-6206-4989-9730-b7959bae6dc5'::uuid,'a23ca5c9-b748-482f-9b59-9db35f7aa996'::uuid])x;
INSERT INTO club_members SELECT 'e14bc9f7-736d-425f-8f2c-e78305ebac1d',id,'active' FROM profiles;
INSERT INTO cash_games VALUES('56d5d6f0-23e9-41b0-b407-852aa1026c2a','e14bc9f7-736d-425f-8f2c-e78305ebac1d','action','{"template":"action"}'),('0cdc133d-ad23-4ace-bb85-312d0f221edd','e14bc9f7-736d-425f-8f2c-e78305ebac1d','madness','{"template":"madness"}');
INSERT INTO tournaments VALUES('80000000-0000-0000-0000-000000000001','REGISTERING',false);
CREATE TABLE witness.catalog_before AS SELECT oid::regprocedure::text signature,proowner,proacl,prosecdef,provolatile,proconfig FROM pg_proc WHERE oid IN('fn_register_horse_for_tournament(uuid,uuid,boolean)'::regprocedure,'fn_seat_horse_in_seat_first_game(uuid,uuid)'::regprocedure);
CREATE FUNCTION witness.assert_refused() RETURNS void LANGUAGE plpgsql AS $$BEGIN
 IF fn_register_horse_for_tournament('80000000-0000-0000-0000-000000000001','0097309f-2864-4d09-b02b-56bca012a9c3')->>'reason' IS DISTINCT FROM 'lightning_pilot_assigned' THEN RAISE EXCEPTION 'ASSIGNED_HORSE_ADMITTED'; END IF;
 IF fn_seat_horse_in_seat_first_game('80000000-0000-0000-0000-000000000001','0097309f-2864-4d09-b02b-56bca012a9c3')->>'reason' IS DISTINCT FROM 'lightning_pilot_assigned' THEN RAISE EXCEPTION 'ASSIGNED_SEAT_ADMITTED'; END IF;
END$$;


-- Immutable normal-receipt producer boundary; the new accessor must preserve it.
CREATE TABLE witness.refund_receipt(event_id uuid,user_id uuid,request_id uuid,receipt jsonb);
CREATE FUNCTION fn_ca_tournament_unregistration_receipt(uuid,uuid,uuid,uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT receipt FROM witness.refund_receipt WHERE event_id=$1 AND user_id=$2 AND request_id=$4 AND $3 IS NULL $$;
REVOKE ALL ON FUNCTION fn_ca_tournament_unregistration_receipt(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE ca_money_rpc_registry(proname text PRIMARY KEY,status text,notes text);
ALTER TABLE tournaments ADD COLUMN start_time timestamptz DEFAULT now()+interval '1 hour', ADD COLUMN started_at timestamptz, ADD COLUMN buy_in_amount numeric DEFAULT 0, ADD COLUMN buy_in_fee numeric DEFAULT 0, ADD COLUMN bounty_amount numeric DEFAULT 0;
ALTER TABLE tournament_players ADD COLUMN table_id uuid, ADD COLUMN seat_number integer;
ALTER TABLE tables ADD COLUMN hands_dealt integer DEFAULT 0;
CREATE TABLE hand_history(table_id uuid,tournament_id uuid);
CREATE TABLE wallet_transactions(user_id uuid,related_entity_id uuid,type text,amount numeric);
CREATE TABLE chip_ledger(from_entity_id uuid,tournament_id uuid,amount numeric);
CREATE TABLE tournament_participant_funding_receipts(user_id uuid,tournament_id uuid,registration_id uuid,amount numeric);
CREATE TABLE tournament_refund_entitlements(user_id uuid,tournament_id uuid,registration_id uuid,gross numeric,entitlement_kind text);
CREATE TABLE poker_diamond_custody(id uuid,user_id uuid,target_id uuid,purpose text,state text,balance bigint,seat_id uuid,entry_key text);
CREATE TABLE poker_diamond_tournament_ledger(user_id uuid,tournament_id uuid,custody_id uuid);
CREATE FUNCTION fn_ca_lock_mtt_admission_contract() RETURNS void LANGUAGE sql AS $$SELECT pg_advisory_xact_lock_shared(10001,1)$$;
CREATE FUNCTION fn_ca_lock_settlement_lane_for_tournament(uuid) RETURNS void LANGUAGE sql AS $$SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))$$;
-- The normal door deliberately acts on the current lifecycle, as production
-- does. The wrapper must bind expected identity before invoking this boundary.
CREATE FUNCTION fn_unregister_from_tournament(uuid,uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r tournament_players%ROWTYPE;
BEGIN
 SELECT * INTO r FROM tournament_players WHERE tournament_id=$1 AND user_id=auth.uid() FOR UPDATE;
 DELETE FROM tournament_players WHERE id=r.id;
 INSERT INTO witness.calls VALUES('withdraw',false);
 RETURN jsonb_build_object('ok',true,'registration_id',r.id,'request_id',$2,'refunded_chips',0,'returned_ticket_value',0,'fees_reversed',0);
END$$;
CREATE FUNCTION witness.unsafe_lifecycle_withdrawal() RETURNS void LANGUAGE plpgsql AS $$
DECLARE result jsonb;
BEGIN
 PERFORM set_config('request.jwt.claim.sub','0097309f-2864-4d09-b02b-56bca012a9c3',true);
 INSERT INTO tournament_players(id,tournament_id,user_id,status) VALUES('50000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000001',auth.uid(),'registered');
 -- Free A was checked by the caller, then another normal lifecycle replaced it.
 DELETE FROM tournament_players WHERE id='50000000-0000-0000-0000-000000000001';
 INSERT INTO tournament_players(id,tournament_id,user_id,status) VALUES('50000000-0000-0000-0000-000000000002','80000000-0000-0000-0000-000000000001',auth.uid(),'registered');
 result:=fn_unregister_from_tournament('80000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000040');
 IF result->>'registration_id'<>'50000000-0000-0000-0000-000000000001' THEN RAISE EXCEPTION 'WRONG_LIFECYCLE_WITHDRAWN'; END IF;
END$$;

-- Additional exact current normal withdrawal/lock owner preimages.
CREATE TABLE ca_mtt_admission_contract(singleton boolean,abi text);
INSERT INTO ca_mtt_admission_contract VALUES(true,'unlimited-mtt-v2');
CREATE TABLE tournament_escrow(tournament_id uuid);
DROP FUNCTION fn_ca_lock_mtt_admission_contract();
DROP FUNCTION fn_ca_lock_settlement_lane_for_tournament(uuid);
CREATE OR REPLACE FUNCTION public.fn_ca_lock_mtt_admission_contract()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_abi text;
BEGIN
  SELECT abi INTO v_abi FROM public.ca_mtt_admission_contract WHERE singleton FOR SHARE;
  IF NOT FOUND OR v_abi NOT IN ('legacy-capacity-v1','unlimited-mtt-v2') THEN
    RAISE EXCEPTION 'MTT_ADMISSION_CONTRACT_MISSING_OR_UNKNOWN' USING ERRCODE='55000';
  END IF;
  RETURN v_abi;
END $function$
;
CREATE OR REPLACE FUNCTION public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id uuid, p_table_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid := p_tournament_id;
BEGIN
  -- Resolve the tournament before any lock, so G's mode can depend on it.
  -- tables.tournament_id is fixed for the life of a table: reading it here
  -- gives the answer reading it under G did.
  IF v_tournament_id IS NULL AND p_table_id IS NOT NULL THEN
    SELECT tb.tournament_id INTO v_tournament_id
    FROM public.tables tb
    WHERE tb.id = p_table_id;
  END IF;

  IF v_tournament_id IS NULL THEN
    -- Nothing to scope to: the whole lane, as it always was - G exclusive,
    -- then B exclusive (the shape of fn_ca_lock_settlement_lane_global).
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ca:tournament-terminal-settlement:v1', 0));
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ca:hand-settlement-barrier:v1', 0));
    RETURN;
  END IF;

  -- G SHARED: waits for, and excludes, terminal authorities (G exclusive)
  -- and nothing else. Rolling authorities of different tournaments run side
  -- by side; the trigger guards take T(id) held exclusively as their proof.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-terminal-settlement:v1', 0));

  -- T(id) EXCLUSIVE: one rolling authority per tournament at a time, and
  -- this tournament's hand settlements (T(id) shared) wait for it.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1:' || v_tournament_id::text, 0));
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_ca_unregister_tournament_player_exact(p_tournament_id uuid, p_user_id uuid, p_expected_table_id uuid DEFAULT NULL::uuid, p_description text DEFAULT NULL::text, p_request_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_reg public.tournament_players%ROWTYPE;
  v_ent record;
  v_fee_group record;
  v_settle jsonb;
  v_receipt jsonb;
  v_escrow_before public.tournament_escrow%ROWTYPE;
  v_escrow_after public.tournament_escrow%ROWTYPE;
  v_players_before integer;
  v_rows integer;
  v_seat_number integer;
  v_seats_taken integer;
  v_non_cash_count integer;
  v_wallet_debits numeric:=0;
  v_wallet_refunds_before numeric:=0;
  v_wallet_refunds_after numeric:=0;
  v_entitled_wallet_total numeric:=0;
  v_tranche_total numeric:=0;
  v_refund_prize numeric:=0;
  v_refund_bounty numeric:=0;
  v_refund_fee numeric:=0;
  v_refund_total numeric:=0;
  v_wallet_amount numeric:=0;
  v_ticket_amount numeric:=0;
  v_running_owed numeric:=0;
  v_rake_before numeric:=0;
  v_rake_after numeric:=0;
  v_fees_reversed numeric:=0;
  v_entitlement_ids uuid[]:='{}'::uuid[];
  v_ticket_ids uuid[]:='{}'::uuid[];
  v_credit_ledger_ids uuid[]:='{}'::uuid[];
  v_wallet_transaction_ids uuid[]:='{}'::uuid[];
  v_source_wallet_club_ids uuid[]:='{}'::uuid[];
  v_fee_reversal_ids uuid[]:='{}'::uuid[];
  v_fee_source_rake_record_ids uuid[]:='{}'::uuid[];
  v_fee_entitlement_ids uuid[]:='{}'::uuid[];
  v_fee_reversal_id uuid;
  v_fee_source_count integer:=0;
  v_fee_source_entitlement_count integer:=0;
  v_fee_source_amount numeric:=0;
  v_request_id uuid:=COALESCE(p_request_id,gen_random_uuid());
  v_start_authority text:='scheduled_clock';
  v_launch_completed_at timestamptz;
  v_persisted_hand_exists boolean:=false;
  v_actual_status text;
  v_actual_started_at timestamptz;
  v_unregistered_at timestamptz;
  v_description text:=COALESCE(
    NULLIF(btrim(p_description),''),'Tournament unregistration refund');
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'tournament and player ids are required'
      USING ERRCODE='22004';
  END IF;
  PERFORM public.fn_ca_lock_mtt_admission_contract();
  -- DIAMOND PHASE 8: a Diamond entry never rode the chip rails. Every
  -- caller of this authority (the lobby, the seat, the administrator, the
  -- launch) sends it home through its own door before a chip rail is
  -- touched. A caller that named no request id is given one exactly as
  -- this authority mints its own. A seat exit naming a table the player
  -- does not sit at answers not_seated unless its request id is already
  -- settled, in which case the door replays that receipt.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    IF p_expected_table_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.table_seats s
                        WHERE s.table_id=p_expected_table_id AND s.user_id=p_user_id AND s.left_at IS NULL)
       AND NOT (p_request_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM public.poker_diamond_tournament_ledger l
                   WHERE l.tournament_id=p_tournament_id AND l.user_id=p_user_id AND l.kind='refund'
                     AND l.request->>'request_id'=p_request_id::text)) THEN
      RETURN jsonb_build_object('ok',false,'reason','not_seated');
    END IF;
    RETURN public.fn_poker_diamond_tournament_unregister(
      p_tournament_id, p_user_id, COALESCE(p_request_id, gen_random_uuid()));
  END IF;
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF v_t.id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;

  -- Spins and Heads-Up Sit & Gos are separate products, but both are
  -- seat-first: start_time is only their human fill-window deadline. Neither
  -- product has a scheduled start. Satellite feeders remain outside this
  -- change and retain the existing scheduled-clock contract.
  IF v_t.format_contract='spin-v1' THEN
    v_start_authority:='spin_actual_start';
  ELSIF v_t.format_contract='sng-v1'
     AND COALESCE(v_t.max_players,0)=2 THEN
    v_start_authority:='heads_up_sng_actual_start';
  END IF;
  /* A release performed by the launch that holds this event's INCOMPLETE
     launch receipt has its own start authority. The clock has passed
     start_time, but no hand has been dealt (checked below, fails closed)
     and the receipt has not been completed, so the seat-first proofs -
     started_at unset, launch not completed - are the right ones and the
     receipt records launch_release. The launch names its receipt through
     the transaction-local app.ca_launch_release_launch_id, set only by
     fn_ca_release_unseatable_registrant_at_launch. */
  IF v_start_authority='scheduled_clock' AND EXISTS (
       SELECT 1 FROM public.tournament_launch_receipts r
        WHERE r.tournament_id=p_tournament_id
          AND r.completed_at IS NULL
          AND r.launch_id::text=NULLIF(
            current_setting('app.ca_launch_release_launch_id',true),'')) THEN
    v_start_authority:='launch_release';
  END IF;

  -- A caller-supplied request id is a durable operation identity. It may only
  -- name this exact player/event/endpoint scope. If its pre-start outcome is
  -- already committed, replay that immutable outcome even when the wall clock
  -- is now past the start; this branch performs no new unregistration writes.
  IF p_request_id IS NOT NULL THEN
    IF EXISTS(
      SELECT 1 FROM public.tournament_unregistration_receipts r
       WHERE r.request_id=p_request_id
         AND (r.tournament_id IS DISTINCT FROM p_tournament_id
           OR r.user_id IS DISTINCT FROM p_user_id
           OR r.source_table_id IS DISTINCT FROM p_expected_table_id)) THEN
      RAISE EXCEPTION 'unregistration request id belongs to another intent'
        USING ERRCODE='22023';
    END IF;
    IF EXISTS(
      SELECT 1 FROM public.tournament_unregistration_receipts r
       WHERE r.request_id=p_request_id) THEN
      v_receipt:=public.fn_ca_tournament_unregistration_receipt(
        p_tournament_id,p_user_id,p_expected_table_id,p_request_id);
      IF v_receipt IS NOT NULL THEN
        RETURN v_receipt||jsonb_build_object('replayed',true);
      END IF;
      RAISE EXCEPTION
        'unregistration request id belongs to a prior registration lifecycle'
        USING ERRCODE='P0404';
    END IF;
  END IF;

  SELECT * INTO v_reg FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
     AND tp.status::text IN ('registered','playing')
   ORDER BY tp.id LIMIT 1 FOR UPDATE;
  IF upper(COALESCE(v_t.status::text,'')) NOT IN ('ANNOUNCED','REGISTERING') THEN
    RETURN jsonb_build_object('ok',false,'reason','registration_closed');
  END IF;
  PERFORM public.fn_ca_tournament_recorded_format(p_tournament_id);

  -- A persisted hand is stronger actual-start evidence than either a mutable
  -- parent status or a launch receipt that an interrupted launcher failed to
  -- complete. Canonical accepted-hand commits carry tournament_id; the
  -- table-linked branch also fails closed for older rows that omitted it. The
  -- exclusive lifecycle advisory lock above serializes this read against the
  -- shared lock held by every canonical accepted-hand commit.
  SELECT EXISTS (
           SELECT 1
             FROM public.hand_history hh
            WHERE hh.tournament_id=p_tournament_id
         ) OR EXISTS (
           SELECT 1
             FROM public.tables hand_table
             JOIN public.hand_history hh ON hh.table_id=hand_table.id
            WHERE hand_table.tournament_id=p_tournament_id
         )
    INTO v_persisted_hand_exists;
  IF v_persisted_hand_exists THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_started');
  END IF;
  IF v_start_authority='scheduled_clock' THEN
    IF v_t.start_time IS NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','registration_schedule_unset');
    END IF;
    IF clock_timestamp()>=v_t.start_time THEN
      RETURN jsonb_build_object('ok',false,'reason','tournament_started');
    END IF;
  ELSE
    SELECT r.completed_at INTO v_launch_completed_at
      FROM public.tournament_launch_receipts r
     WHERE r.tournament_id=p_tournament_id;
    IF v_t.started_at IS NOT NULL OR v_launch_completed_at IS NOT NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','tournament_started');
    END IF;
  END IF;
  IF v_reg.id IS NULL THEN
    -- Rolling clients without a request id may recover a just-lost response
    -- only while registration remains open. They can never turn an old receipt
    -- into a successful post-start response.
    IF p_request_id IS NULL THEN
      v_receipt:=public.fn_ca_tournament_unregistration_receipt(
        p_tournament_id,p_user_id,p_expected_table_id,NULL);
      IF v_receipt IS NOT NULL THEN
        RETURN v_receipt||jsonb_build_object('replayed',true);
      END IF;
    END IF;
    RETURN jsonb_build_object('ok',false,'reason','not_registered');
  END IF;
  IF p_expected_table_id IS NOT NULL THEN
    SELECT s.seat_number INTO v_seat_number
      FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
     WHERE s.table_id=p_expected_table_id AND s.user_id=p_user_id
       AND s.left_at IS NULL AND tb.tournament_id=p_tournament_id
     ORDER BY s.id LIMIT 1 FOR UPDATE OF s;
    IF v_seat_number IS NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','not_seated');
    END IF;
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.spin_reserve_ledger r
     WHERE r.tournament_id=p_tournament_id
       AND r.kind IN ('contribution','jackpot_draw')) THEN
    RETURN jsonb_build_object('ok',false,'reason','spin_entry_already_booked');
  END IF;

  PERFORM 1 FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
   ORDER BY e.entitlement_kind,e.id FOR UPDATE;
  SELECT count(*) INTO v_non_cash_count
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND e.registration_id=v_reg.id
     AND e.entitlement_kind IN ('satellite_seat','tournament_ticket')
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.source_refund_entitlement_id=e.id)
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.entitlement_id=e.id);
  IF COALESCE(v_reg.is_satellite_qualifier,false)
     AND v_non_cash_count<>1 THEN
    RAISE EXCEPTION
      'satellite-funded registration % requires one unspent ticket entitlement',
      v_reg.id USING ERRCODE='P0404';
  END IF;
  IF NOT COALESCE(v_reg.is_satellite_qualifier,false)
     AND v_non_cash_count<>0 THEN
    RAISE EXCEPTION
      'cash registration % cannot own a satellite ticket entitlement',v_reg.id
      USING ERRCODE='P0404';
  END IF;

  SELECT round(COALESCE(sum(e.refund_prize),0),2),
         round(COALESCE(sum(e.refund_bounty),0),2),
         round(COALESCE(sum(e.refund_fee),0),2),
         round(COALESCE(sum(e.gross),0),2),
         round(COALESCE(sum(e.gross),0),2),
         0::numeric
    INTO v_refund_prize,v_refund_bounty,v_refund_fee,v_refund_total,
         v_wallet_amount,v_ticket_amount
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND (e.entitlement_kind='wallet_charge' OR e.registration_id=v_reg.id)
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.entitlement_id=e.id)
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.source_refund_entitlement_id=e.id);
  IF v_refund_total IS DISTINCT FROM
       round(v_refund_prize+v_refund_bounty+v_refund_fee,2)
     OR v_refund_total IS DISTINCT FROM
       round(v_wallet_amount+v_ticket_amount,2) THEN
    RAISE EXCEPTION 'registration % has invalid entitlement totals',v_reg.id
      USING ERRCODE='P0404';
  END IF;
  -- A funded satellite entry does not invent a player-wallet debit.
  -- It returns the same escrow value in cash through its exact source proof.
  IF COALESCE(v_reg.is_satellite_qualifier,false)
     AND EXISTS (
       SELECT 1 FROM public.tournament_refund_entitlements e
        WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
          AND e.entitlement_kind='wallet_charge'
          AND NOT EXISTS (
            SELECT 1 FROM public.tournament_refund_tranches tr
             WHERE tr.entitlement_id=e.id)) THEN
    RAISE EXCEPTION
      'satellite-funded registration % has an unexpected wallet charge',
      v_reg.id USING ERRCODE='P0404';
  END IF;

  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_wallet_debits
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=p_user_id
     AND w.type='debit'
     AND lower(w.category) IN ('tournament_buyin','rebuy','addon');
  SELECT round(COALESCE(sum(e.gross),0),2) INTO v_entitled_wallet_total
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND e.entitlement_kind='wallet_charge';
  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_wallet_refunds_before
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=p_user_id
     AND w.type='credit'
     AND lower(w.category) IN ('refund','tournament_refund');
  SELECT round(COALESCE(sum(tr.amount_paid_now),0),2) INTO v_tranche_total
    FROM public.tournament_refund_tranches tr
   WHERE tr.tournament_id=p_tournament_id AND tr.user_id=p_user_id;
  IF v_wallet_debits IS DISTINCT FROM v_entitled_wallet_total
     OR v_wallet_refunds_before IS DISTINCT FROM v_tranche_total
     OR v_wallet_refunds_before>(
       SELECT COALESCE(sum(e.gross),0)
         FROM public.tournament_refund_entitlements e
        WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
          AND NOT EXISTS (
            SELECT 1 FROM public.tournament_tickets tk
             WHERE tk.source_refund_entitlement_id=e.id)) THEN
    RAISE EXCEPTION 'registration % wallet and entitlement journals disagree',v_reg.id
      USING ERRCODE='P0404';
  END IF;
  v_running_owed:=v_tranche_total;

  SELECT round(COALESCE(sum(r.rake_amount),0),2) INTO v_rake_before
    FROM public.rake_records r
   WHERE r.tournament_id=p_tournament_id AND r.is_tournament;
  SELECT COALESCE(array_agg(e.id ORDER BY e.id),ARRAY[]::uuid[])
    INTO v_fee_entitlement_ids
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND (e.entitlement_kind='wallet_charge' OR e.registration_id=v_reg.id)
     AND e.refund_fee>0
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.entitlement_id=e.id)
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.source_refund_entitlement_id=e.id);

  -- Bind every fee-bearing entitlement to its actual same-transaction rake
  -- journal. The refund wallet club is deliberately absent from this match:
  -- it identifies the payer, while rake_records.club_id identifies the fee
  -- recipient and can be a different club.
  WITH fee_sources AS MATERIALIZED (
    SELECT e.id AS entitlement_id,r.id AS rake_record_id,
           r.club_id,r.rake_amount
      FROM public.tournament_refund_entitlements e
      JOIN public.chip_ledger l ON l.id=e.source_ledger_id
      JOIN public.rake_records r
        ON r.tournament_id=e.tournament_id
       AND r.is_tournament IS TRUE
       AND r.club_id IS NOT NULL
       AND r.rake_amount=e.refund_fee
       AND r.created_at=l.created_at
       AND r.metadata->>'user_id'=e.user_id::text
       AND (
         (e.entitlement_kind='wallet_charge'
          AND e.charge_category='tournament_buyin'
          AND r.source IN (
            'fn_register_for_tournament','fn_register_horse_for_tournament')
          AND r.metadata->>'kind'='tournament_entry_fee'
          AND r.metadata->>'registration_id'=v_reg.id::text)
         OR (e.entitlement_kind='wallet_charge'
          AND e.charge_category='rebuy'
          AND r.source='process_tournament_rebuy'
          AND r.metadata->>'kind' IN (
            'tournament_rebuy_fee','tournament_reentry_fee'))
         OR (e.entitlement_kind='satellite_seat'
          AND r.source='fn_award_satellite_seat'
          AND r.metadata->>'kind'='satellite_seat_entry_fee'
          AND r.metadata->>'registration_id'=e.registration_id::text)
         OR (e.entitlement_kind='tournament_ticket'
          AND r.source='fn_register_for_tournament_with_ticket'
          AND r.metadata->>'kind'='tournament_ticket_entry_fee'
          AND r.metadata->>'registration_id'=e.registration_id::text))
     WHERE e.id=ANY(v_fee_entitlement_ids)
  )
  SELECT count(*),count(DISTINCT entitlement_id),
         round(COALESCE(sum(rake_amount),0),2),
         COALESCE(array_agg(rake_record_id ORDER BY rake_record_id),
                  ARRAY[]::uuid[])
    INTO v_fee_source_count,v_fee_source_entitlement_count,
         v_fee_source_amount,v_fee_source_rake_record_ids
    FROM fee_sources;
  IF v_fee_source_count<>cardinality(v_fee_entitlement_ids)
     OR v_fee_source_entitlement_count<>cardinality(v_fee_entitlement_ids)
     OR v_fee_source_count<>(
       SELECT count(DISTINCT id)
         FROM unnest(v_fee_source_rake_record_ids) source(id))
     OR v_fee_source_amount IS DISTINCT FROM v_refund_fee THEN
    RAISE EXCEPTION
      'registration % fee entitlements do not map one-to-one to exact rake evidence',
      v_reg.id USING ERRCODE='P0404';
  END IF;
  PERFORM 1 FROM public.rake_records r
   WHERE r.id=ANY(v_fee_source_rake_record_ids)
   ORDER BY r.club_id,r.id FOR UPDATE;

  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id,'unregister entitlement escrow prelock');
  SELECT * INTO v_escrow_before FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id FOR UPDATE;
  SELECT count(*) INTO v_players_before FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.status::text IN ('registered','playing');
  IF v_escrow_before.tournament_id IS NULL
     OR v_escrow_before.enforced IS DISTINCT FROM true
     OR v_players_before<=0
     OR v_t.current_players IS DISTINCT FROM v_players_before
     OR v_t.prize_pool IS DISTINCT FROM v_escrow_before.prize_balance
     OR v_t.bounty_pool IS DISTINCT FROM v_escrow_before.bounty_balance
     OR v_t.total_rake IS DISTINCT FROM v_escrow_before.fee_balance
     OR v_t.total_rake IS DISTINCT FROM v_rake_before
     OR v_t.prize_pool<v_refund_prize
     OR v_t.bounty_pool<v_refund_bounty
     OR v_t.total_rake<v_refund_fee THEN
    RAISE EXCEPTION 'registration % cannot leave divergent tournament state',v_reg.id
      USING ERRCODE='P0404';
  END IF;

  FOR v_ent IN
    SELECT e.* FROM public.tournament_refund_entitlements e
     WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
       AND (e.entitlement_kind='wallet_charge' OR e.registration_id=v_reg.id)
       AND NOT EXISTS(
         SELECT 1 FROM public.tournament_refund_tranches tr
          WHERE tr.entitlement_id=e.id)
       AND NOT EXISTS(
         SELECT 1 FROM public.tournament_tickets tk
          WHERE tk.source_refund_entitlement_id=e.id)
     ORDER BY e.entitlement_kind,e.id
  LOOP
    v_running_owed:=round(v_running_owed+v_ent.gross,2);
    v_settle:=public.fn_settle_tournament_refund_exact(
      p_tournament_id,p_user_id,v_ent.refund_wallet_club_id,v_running_owed,
      v_ent.refund_prize,v_ent.refund_bounty,v_ent.refund_fee,
      'fn_unregister_from_tournament',v_description);
    IF COALESCE((v_settle->>'ok')::boolean,false) IS NOT TRUE
       OR (v_settle->>'entitlement_id')::uuid IS DISTINCT FROM v_ent.id
       OR (v_settle->>'paid')::numeric IS DISTINCT FROM v_ent.gross
       OR (v_settle->>'amount_paid')::numeric IS DISTINCT FROM v_running_owed
       OR (v_settle->>'source_wallet_club_id')::uuid
            IS DISTINCT FROM v_ent.refund_wallet_club_id THEN
      RAISE EXCEPTION 'registration % exact wallet refund failed',v_reg.id
        USING ERRCODE='P0404';
    END IF;
    v_entitlement_ids:=array_append(v_entitlement_ids,v_ent.id);
    v_source_wallet_club_ids:=array_append(
      v_source_wallet_club_ids,v_ent.refund_wallet_club_id);
    v_credit_ledger_ids:=array_append(
      v_credit_ledger_ids,(v_settle->>'credit_ledger_id')::uuid);
    v_wallet_transaction_ids:=array_append(
      v_wallet_transaction_ids,(v_settle->>'wallet_transaction_id')::uuid);
  END LOOP;

  FOR v_fee_group IN
    SELECT r.club_id,round(sum(r.rake_amount),2) AS fee,
           array_agg(r.id ORDER BY r.id) AS source_rake_record_ids,
           array_agg(e.id ORDER BY e.id) AS entitlement_ids
      FROM public.rake_records r
      JOIN public.tournament_refund_entitlements e
        ON e.id=ANY(v_fee_entitlement_ids)
       AND e.refund_fee=r.rake_amount
       AND e.tournament_id=r.tournament_id
       AND e.user_id=p_user_id
       AND r.metadata->>'user_id'=e.user_id::text
       AND (
         (e.entitlement_kind='wallet_charge'
          AND e.charge_category='tournament_buyin'
          AND r.source IN (
            'fn_register_for_tournament','fn_register_horse_for_tournament')
          AND r.metadata->>'kind'='tournament_entry_fee'
          AND r.metadata->>'registration_id'=v_reg.id::text)
         OR (e.entitlement_kind='wallet_charge'
          AND e.charge_category='rebuy'
          AND r.source='process_tournament_rebuy'
          AND r.metadata->>'kind' IN (
            'tournament_rebuy_fee','tournament_reentry_fee'))
         OR (e.entitlement_kind='satellite_seat'
          AND r.source='fn_award_satellite_seat'
          AND r.metadata->>'kind'='satellite_seat_entry_fee'
          AND r.metadata->>'registration_id'=e.registration_id::text)
         OR (e.entitlement_kind='tournament_ticket'
          AND r.source='fn_register_for_tournament_with_ticket'
          AND r.metadata->>'kind'='tournament_ticket_entry_fee'
          AND r.metadata->>'registration_id'=e.registration_id::text))
      JOIN public.chip_ledger l
        ON l.id=e.source_ledger_id AND l.created_at=r.created_at
     WHERE r.id=ANY(v_fee_source_rake_record_ids)
     GROUP BY r.club_id ORDER BY r.club_id
  LOOP
    IF v_fee_group.fee>0 THEN
      INSERT INTO public.rake_records(
        hand_id,table_id,club_id,rake_amount,pot_size,num_players,
        bbj_contribution,is_tournament,tournament_id,source,metadata)
      VALUES(
        NULL,NULL,v_fee_group.club_id,-v_fee_group.fee,v_fee_group.fee,1,
        0,true,p_tournament_id,'fn_unregister_from_tournament',
        jsonb_build_object(
          'kind','tournament_fee_refund','user_id',p_user_id,
          'registration_id',v_reg.id,
          'fee_recipient_club_id',v_fee_group.club_id,
          'entitlement_ids',to_jsonb(v_fee_group.entitlement_ids),
          'original_rake_record_ids',
            to_jsonb(v_fee_group.source_rake_record_ids)))
      RETURNING id INTO v_fee_reversal_id;
      v_fee_reversal_ids:=array_append(
        v_fee_reversal_ids,v_fee_reversal_id);
      v_fees_reversed:=round(v_fees_reversed+v_fee_group.fee,2);
    END IF;
  END LOOP;
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_fee_reversal_ids
    FROM unnest(v_fee_reversal_ids) reversal(id);
  IF v_fees_reversed IS DISTINCT FROM v_refund_fee THEN
    RAISE EXCEPTION
      'registration % reversed % in exact fee rows but owes %',
      v_reg.id,v_fees_reversed,v_refund_fee USING ERRCODE='P0404';
  END IF;

  UPDATE public.tournaments
     SET current_players=v_players_before-1,
         prize_pool=round(v_t.prize_pool-v_refund_prize,2),
         bounty_pool=round(v_t.bounty_pool-v_refund_bounty,2),
         total_rake=round(v_t.total_rake-v_refund_fee,2),updated_at=now()
   WHERE id=p_tournament_id
     AND current_players IS NOT DISTINCT FROM v_players_before
     AND prize_pool IS NOT DISTINCT FROM v_t.prize_pool
     AND bounty_pool IS NOT DISTINCT FROM v_t.bounty_pool
     AND total_rake IS NOT DISTINCT FROM v_t.total_rake;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'registration % tournament cache changed',v_reg.id
      USING ERRCODE='55000';
  END IF;

  UPDATE public.table_seats s
     SET left_at=transaction_timestamp(),status='left',leave_pending=false,
         is_sitting_out=false,is_away=false,sit_out_at=NULL,
         scheduled_leave_hands=NULL
   WHERE s.user_id=p_user_id AND s.left_at IS NULL
     AND EXISTS(SELECT 1 FROM public.tables tb
                 WHERE tb.id=s.table_id AND tb.tournament_id=p_tournament_id);
  UPDATE public.tables tb
     SET current_players=(SELECT count(*) FROM public.table_seats s
                           WHERE s.table_id=tb.id AND s.left_at IS NULL),
         updated_at=now()
   WHERE tb.tournament_id=p_tournament_id;
  DELETE FROM public.tournament_players tp WHERE tp.id=v_reg.id;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'registration % was not deleted after settlement',v_reg.id
      USING ERRCODE='55000';
  END IF;

  SELECT * INTO v_escrow_after FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id;
  SELECT round(COALESCE(sum(r.rake_amount),0),2) INTO v_rake_after
    FROM public.rake_records r
   WHERE r.tournament_id=p_tournament_id AND r.is_tournament;
  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_wallet_refunds_after
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=p_user_id
     AND w.type='credit'
     AND lower(w.category) IN ('refund','tournament_refund');
  IF (SELECT count(*) FROM public.tournament_players tp
       WHERE tp.tournament_id=p_tournament_id
         AND tp.status::text IN ('registered','playing'))<>v_players_before-1
     OR v_wallet_refunds_after IS DISTINCT FROM
          round(v_wallet_refunds_before+v_wallet_amount,2)
     OR v_escrow_after.prize_balance IS DISTINCT FROM
          round(v_escrow_before.prize_balance-v_refund_prize,2)
     OR v_escrow_after.bounty_balance IS DISTINCT FROM
          round(v_escrow_before.bounty_balance-v_refund_bounty,2)
     OR v_escrow_after.fee_balance IS DISTINCT FROM
          round(v_escrow_before.fee_balance-v_refund_fee,2)
     OR v_rake_after IS DISTINCT FROM round(v_rake_before-v_refund_fee,2)
     OR NOT EXISTS(
       SELECT 1 FROM public.tournaments t
        WHERE t.id=p_tournament_id
          AND t.current_players=v_players_before-1
          AND t.prize_pool=v_escrow_after.prize_balance
          AND t.bounty_pool=v_escrow_after.bounty_balance
          AND t.total_rake=v_rake_after) THEN
    RAISE EXCEPTION 'registration % did not leave exact final state',v_reg.id
      USING ERRCODE='P0404';
  END IF;
  IF p_expected_table_id IS NOT NULL THEN
    SELECT count(*) INTO v_seats_taken FROM public.table_seats s
     WHERE s.table_id=p_expected_table_id AND s.left_at IS NULL;
  END IF;

  -- Re-prove the chosen start authority after all money and seat work. Timed
  -- events still use the locked schedule cutoff; every product also treats a
  -- persisted hand as irreversible start truth; seat-first products further
  -- use status, started_at and completed launch truth. Any loss of the race
  -- rolls every preceding write back atomically.
  v_unregistered_at:=clock_timestamp();
  SELECT EXISTS (
           SELECT 1
             FROM public.hand_history hh
            WHERE hh.tournament_id=p_tournament_id
         ) OR EXISTS (
           SELECT 1
             FROM public.tables hand_table
             JOIN public.hand_history hh ON hh.table_id=hand_table.id
            WHERE hand_table.tournament_id=p_tournament_id
         )
    INTO v_persisted_hand_exists;
  IF v_persisted_hand_exists THEN
    RAISE EXCEPTION
      'tournament hand persisted before unregistration could commit'
      USING ERRCODE='55000';
  END IF;
  IF v_start_authority='scheduled_clock' THEN
    IF v_unregistered_at>=v_t.start_time THEN
      RAISE EXCEPTION 'tournament started before unregistration could commit'
        USING ERRCODE='55000';
    END IF;
  ELSE
    SELECT t.status::text,t.started_at,launch.completed_at
      INTO v_actual_status,v_actual_started_at,v_launch_completed_at
      FROM public.tournaments t
      LEFT JOIN public.tournament_launch_receipts launch
        ON launch.tournament_id=t.id
     WHERE t.id=p_tournament_id;
    IF upper(COALESCE(v_actual_status,'')) NOT IN ('ANNOUNCED','REGISTERING')
       OR v_actual_started_at IS NOT NULL
       OR v_launch_completed_at IS NOT NULL THEN
      RAISE EXCEPTION
        'seat-first tournament started before unregistration could commit'
        USING ERRCODE='55000';
    END IF;
  END IF;

  INSERT INTO public.tournament_unregistration_receipts(
    registration_id,request_id,tournament_id,user_id,source_table_id,
    refunded_chips,returned_ticket_value,entitlement_ids,ticket_ids,
    source_wallet_club_ids,credit_ledger_ids,wallet_transaction_ids,
    fees_reversed,fee_reversal_ids,fee_source_rake_record_ids,
    seat_number,seats_taken,scheduled_start_at,start_authority,settled_at)
  VALUES(
    v_reg.id,v_request_id,p_tournament_id,p_user_id,p_expected_table_id,
    v_wallet_amount,v_ticket_amount,v_entitlement_ids,v_ticket_ids,
    v_source_wallet_club_ids,v_credit_ledger_ids,v_wallet_transaction_ids,
    v_fees_reversed,v_fee_reversal_ids,v_fee_source_rake_record_ids,
    v_seat_number,v_seats_taken,v_t.start_time,v_start_authority,v_unregistered_at);
  v_receipt:=public.fn_ca_tournament_unregistration_receipt(
    p_tournament_id,p_user_id,p_expected_table_id,v_request_id);
  IF v_receipt IS NULL
     OR (v_receipt->>'registration_id')::uuid IS DISTINCT FROM v_reg.id THEN
    RAISE EXCEPTION 'registration % has no exact unregistration receipt',v_reg.id
      USING ERRCODE='P0404';
  END IF;
  RETURN v_receipt||jsonb_build_object('replayed',false);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_unregister(p_tournament_id uuid, p_user_id uuid, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE; v_reg public.tournament_players%ROWTYPE;
  v_refund jsonb; v_players_before integer; v_rows integer;
  v_prior public.poker_diamond_tournament_ledger%ROWTYPE; v_prior_reg uuid; v_prior_after bigint;
  v_authority text := 'scheduled_clock';
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'tournament, player and request ids are required' USING ERRCODE='22004';
  END IF;
  PERFORM public.fn_ca_lock_mtt_admission_contract();
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  SELECT * INTO v_t FROM public.tournaments t WHERE t.id=p_tournament_id FOR UPDATE;
  IF v_t.id IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','tournament_not_found'); END IF;
  IF NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514';
  END IF;

  -- A withdrawal that already happened answers with what it did: the same
  -- receipt the first answer carried, rebuilt from the refund ledger row
  -- (its registration id from the entry row of the same custody), so the
  -- client's one exact replay after a lost response is a receipt. The chip
  -- authority replays its stored receipt the same way, past the clock too.
  -- DIAMOND PHASE 11: word for word - no replay marker, and the balance it
  -- reports is the one the refund left, read from the release's own
  -- immutable receipt (keyed by this request id), never the wallet as it
  -- stands at the retry.
  SELECT l.* INTO v_prior FROM public.poker_diamond_tournament_ledger l
   WHERE l.tournament_id=p_tournament_id AND l.user_id=p_user_id AND l.kind='refund'
     AND l.request->>'request_id'=p_request_id::text
   ORDER BY l.id LIMIT 1;
  IF FOUND THEN
    SELECT e.registration_id INTO v_prior_reg FROM public.poker_diamond_tournament_ledger e
     WHERE e.custody_id=v_prior.custody_id AND e.kind='entry'
     ORDER BY e.id LIMIT 1;
    SELECT (m.receipt->>'available_balance')::bigint INTO v_prior_after
      FROM public.poker_diamond_movements m
     WHERE m.request_id=p_request_id AND m.custody_id=v_prior.custody_id AND m.action='release';
    IF v_prior_after IS NULL THEN
      RAISE EXCEPTION 'diamond_tournament_refund_receipt_missing' USING ERRCODE='P0404';
    END IF;
    RETURN jsonb_build_object('ok',true,'fully_settled',true,'remaining',0,
      'request_id',p_request_id,
      'refunded_diamonds',v_prior.amount,'refund_prize',v_prior.prize_part,
      'refund_bounty',v_prior.bounty_part,'refund_fee',v_prior.fee_part,
      'registration_id',v_prior_reg,'custody_id',v_prior.custody_id,'obligation_id',v_prior.obligation_id,
      'asset','diamonds','diamonds_after',v_prior_after);
  END IF;

  -- The start authority is the chip authority's. A scheduled event closes at
  -- its clock. A spin or a heads-up sit-and-go is seat-first: start_time is
  -- only its fill-window deadline, and it closes when it actually starts. A
  -- launch releasing a registrant it could not seat names its incomplete
  -- receipt through app.ca_launch_release_launch_id; it is past the clock by
  -- design and is held to the seat-first proofs instead. A persisted hand
  -- closes every product.
  IF v_t.format_contract='spin-v1' THEN
    v_authority := 'spin_actual_start';
  ELSIF v_t.format_contract='sng-v1'
     AND COALESCE(v_t.max_players,0)=2 THEN
    v_authority := 'heads_up_sng_actual_start';
  END IF;
  IF v_authority='scheduled_clock' AND EXISTS (
       SELECT 1 FROM public.tournament_launch_receipts r
        WHERE r.tournament_id=p_tournament_id
          AND r.completed_at IS NULL
          AND r.launch_id::text=NULLIF(current_setting('app.ca_launch_release_launch_id',true),'')) THEN
    v_authority := 'launch_release';
  END IF;
  IF upper(COALESCE(v_t.status,'')) NOT IN ('ANNOUNCED','REGISTERING') OR v_t.started_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_started');
  END IF;
  PERFORM public.fn_ca_tournament_recorded_format(p_tournament_id);
  IF EXISTS (SELECT 1 FROM public.hand_history hh WHERE hh.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tables ht JOIN public.hand_history hh ON hh.table_id=ht.id
                 WHERE ht.tournament_id=p_tournament_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_started');
  END IF;
  IF v_authority='scheduled_clock' THEN
    IF v_t.start_time IS NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','registration_schedule_unset');
    END IF;
    IF clock_timestamp()>=v_t.start_time THEN
      RETURN jsonb_build_object('ok',false,'reason','tournament_started');
    END IF;
  ELSIF EXISTS (SELECT 1 FROM public.tournament_launch_receipts r
                 WHERE r.tournament_id=p_tournament_id AND r.completed_at IS NOT NULL) THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_started');
  END IF;

  SELECT * INTO v_reg FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id FOR UPDATE;
  IF v_reg.id IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','not_registered'); END IF;
  IF v_reg.status::text NOT IN ('registered','playing') THEN
    RETURN jsonb_build_object('ok',false,'reason','not_registered');
  END IF;
  SELECT count(*)::integer INTO v_players_before FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.status::text IN ('registered','playing');

  -- Money first: the release is the part that can refuse.
  v_refund := public.fn_poker_diamond_tournament_refund(
    p_tournament_id, p_user_id, 'unregister', 'fn_unregister_from_tournament', p_request_id);

  -- The same roster effects the chip authority produces, in the same order.
  UPDATE public.table_seats s
     SET left_at=transaction_timestamp(),status='left',leave_pending=false,
         is_sitting_out=false,is_away=false,sit_out_at=NULL,scheduled_leave_hands=NULL
   WHERE s.user_id=p_user_id AND s.left_at IS NULL
     AND EXISTS(SELECT 1 FROM public.tables tb WHERE tb.id=s.table_id AND tb.tournament_id=p_tournament_id);
  UPDATE public.tables tb
     SET current_players=(SELECT count(*) FROM public.table_seats s WHERE s.table_id=tb.id AND s.left_at IS NULL),
         updated_at=now()
   WHERE tb.tournament_id=p_tournament_id;
  DELETE FROM public.tournament_players tp WHERE tp.id=v_reg.id;
  UPDATE public.tournaments
     SET current_players=v_players_before-1,
         prize_pool=round(COALESCE(prize_pool,0)-(v_refund->>'refund_prize')::numeric,2),
         bounty_pool=round(COALESCE(bounty_pool,0)-(v_refund->>'refund_bounty')::numeric,2),
         total_rake=round(COALESCE(total_rake,0)-(v_refund->>'refund_fee')::numeric,2),
         updated_at=now()
   WHERE id=p_tournament_id;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN RAISE EXCEPTION 'tournament vanished during unregistration' USING ERRCODE='55000'; END IF;
  RETURN jsonb_build_object('ok',true,'fully_settled',true,'remaining',0,'request_id',p_request_id,
    'refunded_diamonds',(v_refund->>'paid')::numeric,'refund_prize',(v_refund->>'refund_prize')::numeric,
    'refund_bounty',(v_refund->>'refund_bounty')::numeric,'refund_fee',(v_refund->>'refund_fee')::numeric,
    'registration_id',v_reg.id,'custody_id',v_refund->>'custody_id','obligation_id',v_refund->>'obligation_id',
    'asset','diamonds','diamonds_after',(v_refund->>'available_balance')::bigint);
END $function$
;
CREATE OR REPLACE FUNCTION public.fn_unregister_from_tournament(p_tournament_id uuid, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid:=auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_unregister_from_tournament requires an authenticated caller'
      USING ERRCODE='28000';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'fn_unregister_from_tournament requires a live session'
      USING ERRCODE='28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'fn_unregister_from_tournament requires a request id'
      USING ERRCODE='22004';
  END IF;
  -- DIAMOND PHASE 8: a Diamond entry goes home through its own authority.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RETURN public.fn_poker_diamond_tournament_unregister(p_tournament_id,v_uid,p_request_id);
  END IF;
  RETURN public.fn_ca_unregister_tournament_player_exact(
    p_tournament_id,v_uid,NULL,'Tournament unregistration refund',p_request_id);
END;
$function$
;
