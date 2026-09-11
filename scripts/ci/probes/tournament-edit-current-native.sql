BEGIN;
CREATE OR REPLACE FUNCTION public.fn_execute_managed_game_command(
  p_command_id uuid,
  p_kind text,
  p_game_id uuid,
  p_action text,
  p_expected_version integer,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $managed_command$
DECLARE
  v_uid uuid := auth.uid();
  v_club uuid;
  v_request_hash text;
  v_existing public.managed_game_command_receipts%ROWTYPE;
  v_before integer;
  v_after integer;
  v_action_result jsonb;
  v_result jsonb;
  v_status text;
  v_reason text;
  v_message text;
  v_sqlstate text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  -- auth.uid() proves only that the JWT once named an account. A signed-out
  -- browser can retain that old subject claim, so refuse it before hashing a
  -- request, taking a lock, reading a game, or writing a command receipt.
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE = '28000';
  END IF;

  IF p_command_id IS NULL
     OR p_game_id IS NULL
     OR p_kind NOT IN ('table', 'tournament')
     OR p_action NOT IN ('update', 'close')
     OR p_expected_version IS NULL
     OR p_expected_version < 1
     OR jsonb_typeof(COALESCE(p_payload, '{}'::jsonb)) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  v_request_hash := public.fn_managed_game_command_hash(
    p_command_id, p_kind, p_game_id, p_action, p_expected_version, p_payload
  );

  PERFORM pg_advisory_xact_lock(
    hashtextextended('managed-game-command:' || p_command_id::text, 0)
  );

  SELECT * INTO v_existing
    FROM public.managed_game_command_receipts
   WHERE command_id = p_command_id;
  IF FOUND THEN
    IF v_existing.actor_id <> v_uid OR v_existing.request_hash <> v_request_hash THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'idempotency_conflict');
    END IF;
    RETURN v_existing.result || jsonb_build_object('replayed', true);
  END IF;

  IF p_kind = 'tournament' AND p_action = 'close' THEN
    PERFORM public.fn_ca_lock_settlement_lane_global();
  END IF;

  IF p_kind = 'table' THEN
    SELECT club_id INTO v_club
      FROM public.tables
     WHERE id = p_game_id
     FOR UPDATE;
  ELSE
    SELECT club_id INTO v_club
      FROM public.tournaments
     WHERE id = p_game_id
     FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'game_not_found');
  END IF;
  IF NOT public.fn_can_create_games(v_club, v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  SELECT version INTO v_before
    FROM public.managed_game_contract_versions
   WHERE game_kind = p_kind AND game_id = p_game_id
   ORDER BY version DESC
   LIMIT 1;

  IF v_before IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'contract_not_found');
  END IF;

  INSERT INTO public.managed_game_command_receipts (
    command_id, actor_id, game_kind, game_id, command_action,
    expected_version, request_hash, status, contract_version_before
  ) VALUES (
    p_command_id, v_uid, p_kind, p_game_id, p_action,
    p_expected_version, v_request_hash, 'processing', v_before
  );

  IF p_expected_version <> v_before THEN
    v_result := jsonb_build_object(
      'ok', false,
      'reason', 'stale_contract_version',
      'command_id', p_command_id,
      'command_status', 'rejected',
      'expected_version', p_expected_version,
      'current_version', v_before,
      'version_before', v_before,
      'version_after', v_before,
      'replayed', false
    );
    UPDATE public.managed_game_command_receipts
       SET status = 'rejected', result = v_result,
           contract_version_after = v_before, completed_at = now()
     WHERE command_id = p_command_id;
    RETURN v_result;
  END IF;

  BEGIN
    IF p_action = 'update' THEN
      v_action_result := public.fn_update_managed_game(p_kind, p_game_id, p_payload);
    ELSE
      v_action_result := public.fn_close_managed_game(p_kind, p_game_id);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    v_reason := CASE
      WHEN v_sqlstate IN ('22P02', '22003', '23514') THEN 'invalid_payload'
      WHEN v_sqlstate = '42501' THEN 'not_authorized'
      WHEN v_sqlstate = '55000' THEN 'contract_rule_blocked'
      ELSE 'command_failed'
    END;
    v_action_result := jsonb_build_object(
      'ok', false,
      'reason', v_reason,
      'message', CASE
        WHEN v_sqlstate = '55000' THEN v_message
        ELSE NULL
      END
    );
  END;

  SELECT version INTO v_after
    FROM public.managed_game_contract_versions
   WHERE game_kind = p_kind AND game_id = p_game_id
   ORDER BY version DESC
   LIMIT 1;
  v_after := COALESCE(v_after, v_before);
  v_status := CASE WHEN COALESCE((v_action_result ->> 'ok')::boolean, false)
    THEN 'succeeded' ELSE 'rejected' END;

  v_result := COALESCE(v_action_result, jsonb_build_object(
    'ok', false, 'reason', 'command_failed'
  )) || jsonb_build_object(
    'command_id', p_command_id,
    'command_status', v_status,
    'expected_version', p_expected_version,
    'current_version', v_after,
    'version_before', v_before,
    'version_after', v_after,
    'replayed', false
  );

  UPDATE public.managed_game_command_receipts
     SET status = v_status, result = v_result,
         contract_version_after = v_after, completed_at = now()
   WHERE command_id = p_command_id;

  RETURN v_result;
END;
$managed_command$;
CREATE OR REPLACE FUNCTION public.fn_update_managed_game(
  p_kind text,
  p_game_id uuid,
  p_patch jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_club uuid;
  v_players integer;
  v_status text;
  v_name text;
  v_sb numeric;
  v_bb numeric;
  v_min numeric;
  v_max numeric;
  v_seats integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF p_kind = 'table' THEN
    SELECT club_id, current_players, status
      INTO v_club, v_players, v_status
      FROM public.tables
     WHERE id = p_game_id
     FOR UPDATE;
  ELSIF p_kind = 'tournament' THEN
    SELECT club_id, current_players, status
      INTO v_club, v_players, v_status
      FROM public.tournaments
     WHERE id = p_game_id
     FOR UPDATE;
  ELSE
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_game_kind');
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'game_not_found');
  END IF;
  IF NOT public.fn_can_create_games(v_club, v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  v_name := left(regexp_replace(COALESCE(p_patch ->> 'name', ''), '\s+', ' ', 'g'), 80);
  IF length(trim(v_name)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'name_required');
  END IF;

  IF p_kind = 'table' THEN
    IF v_players > 0 OR lower(v_status) IN ('running', 'active') THEN
      UPDATE public.tables
         SET name = v_name, updated_at = now()
       WHERE id = p_game_id;
    ELSE
      SELECT COALESCE((p_patch ->> 'small_blind')::numeric, t.small_blind),
             COALESCE((p_patch ->> 'big_blind')::numeric, t.big_blind),
             COALESCE((p_patch ->> 'min_buy_in')::numeric, t.min_buy_in),
             COALESCE((p_patch ->> 'max_buy_in')::numeric, t.max_buy_in),
             COALESCE((p_patch ->> 'max_players')::integer, t.max_players)
        INTO v_sb, v_bb, v_min, v_max, v_seats
        FROM public.tables t
       WHERE t.id = p_game_id;

      IF v_sb IS NULL OR v_bb IS NULL OR v_min IS NULL OR v_max IS NULL OR v_seats IS NULL
         OR v_sb <= 0 OR v_bb < v_sb OR v_min <= 0 OR v_max < v_min THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'invalid_table_limits');
      END IF;

      UPDATE public.tables
         SET name = v_name,
             small_blind = v_sb,
             big_blind = v_bb,
             min_buy_in = v_min,
             max_buy_in = v_max,
             max_players = LEAST(10, GREATEST(2, v_seats)),
             updated_at = now()
       WHERE id = p_game_id;
    END IF;
  ELSE
    PERFORM 1
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_game_id
     FOR UPDATE;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'players_registered');
    END IF;
    IF upper(v_status) NOT IN ('ANNOUNCED', 'REGISTERING', 'SCHEDULED') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'already_started');
    END IF;

    UPDATE public.tournaments
       SET name = v_name,
           max_players = GREATEST(
             2,
             COALESCE((p_patch ->> 'max_players')::integer, max_players)
           ),
           start_time = COALESCE((p_patch ->> 'start_time')::timestamptz, start_time),
           updated_at = now()
     WHERE id = p_game_id;
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_execute_managed_game_command(uuid,text,uuid,text,integer,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_execute_managed_game_command(uuid,text,uuid,text,integer,jsonb) TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_update_managed_game(text,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_update_managed_game(text,uuid,jsonb) TO service_role;

SET LOCAL statement_timeout='30s';
SET LOCAL lock_timeout='5s';
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) VALUES ('f8100000-0000-4000-8000-000000000001'),('f8100000-0000-4000-8000-000000000002');
INSERT INTO public.users(id,username) VALUES ('f8100000-0000-4000-8000-000000000001','phase3_creator'),('f8100000-0000-4000-8000-000000000002','phase3_member');
INSERT INTO public.profiles(id,username,display_name) VALUES ('f8100000-0000-4000-8000-000000000001','phase3_creator','Phase3 Creator'),('f8100000-0000-4000-8000-000000000002','phase3_member','Phase3 Member');
INSERT INTO public.clubs(id,club_id,name) VALUES ('f8200000-0000-4000-8000-000000000001',993301,'Phase3 Creation Club');
INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance,joined_at) VALUES
 ('f8200000-0000-4000-8000-000000000001','f8100000-0000-4000-8000-000000000001','owner','active',0,now()),
 ('f8200000-0000-4000-8000-000000000001','f8100000-0000-4000-8000-000000000002','player','active',0,now());
INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES
 ('f8300000-0000-4000-8000-000000000001','f8100000-0000-4000-8000-000000000001',now(),now()),
 ('f8300000-0000-4000-8000-000000000002','f8100000-0000-4000-8000-000000000002',now(),now());
SET LOCAL session_replication_role=origin;
CREATE TEMP TABLE phase3_creation_results(name text PRIMARY KEY,value jsonb) ON COMMIT DROP;
GRANT SELECT,INSERT ON phase3_creation_results TO authenticated;
SELECT set_config('request.jwt.claims','{"sub":"f8100000-0000-4000-8000-000000000001","role":"authenticated","session_id":"f8300000-0000-4000-8000-000000000001"}',true);
SET LOCAL ROLE authenticated;
INSERT INTO phase3_creation_results VALUES ('access',public.fn_game_creation_access('f8200000-0000-4000-8000-000000000001'));
INSERT INTO phase3_creation_results VALUES ('mtt',public.fn_create_tournament('f8200000-0000-4000-8000-000000000001',$client${"name":"Friday Major","type":"mtt","gameVariant":"NLH","buyIn":50,"startingStack":10000,"maxPlayers":100,"minPlayers":10,"blindStructure":[{"level":1,"smallBlind":10,"bigBlind":20,"ante":0,"durationMinutes":8},{"level":2,"smallBlind":15,"bigBlind":30,"ante":0,"durationMinutes":8},{"level":3,"smallBlind":20,"bigBlind":40,"ante":0,"durationMinutes":8},{"level":4,"smallBlind":25,"bigBlind":50,"ante":0,"durationMinutes":8},{"level":5,"smallBlind":50,"bigBlind":100,"ante":10,"durationMinutes":8},{"level":6,"smallBlind":75,"bigBlind":150,"ante":15,"durationMinutes":8},{"level":7,"smallBlind":100,"bigBlind":200,"ante":25,"durationMinutes":8},{"level":8,"smallBlind":0,"bigBlind":0,"ante":0,"durationMinutes":5,"isBreak":true},{"level":9,"smallBlind":150,"bigBlind":300,"ante":40,"durationMinutes":8},{"level":10,"smallBlind":200,"bigBlind":400,"ante":50,"durationMinutes":8},{"level":11,"smallBlind":300,"bigBlind":600,"ante":75,"durationMinutes":8},{"level":12,"smallBlind":400,"bigBlind":800,"ante":100,"durationMinutes":8},{"level":13,"smallBlind":500,"bigBlind":1000,"ante":150,"durationMinutes":8},{"level":14,"smallBlind":0,"bigBlind":0,"ante":0,"durationMinutes":5,"isBreak":true},{"level":15,"smallBlind":600,"bigBlind":1200,"ante":200,"durationMinutes":8},{"level":16,"smallBlind":800,"bigBlind":1600,"ante":250,"durationMinutes":8},{"level":17,"smallBlind":1000,"bigBlind":2000,"ante":300,"durationMinutes":8},{"level":18,"smallBlind":1200,"bigBlind":2400,"ante":400,"durationMinutes":8},{"level":19,"smallBlind":1500,"bigBlind":3000,"ante":500,"durationMinutes":8},{"level":20,"smallBlind":0,"bigBlind":0,"ante":0,"durationMinutes":5,"isBreak":true},{"level":21,"smallBlind":2000,"bigBlind":4000,"ante":600,"durationMinutes":8},{"level":22,"smallBlind":2500,"bigBlind":5000,"ante":750,"durationMinutes":8},{"level":23,"smallBlind":3000,"bigBlind":6000,"ante":1000,"durationMinutes":8},{"level":24,"smallBlind":4000,"bigBlind":8000,"ante":1200,"durationMinutes":8},{"level":25,"smallBlind":5000,"bigBlind":10000,"ante":1500,"durationMinutes":8},{"level":26,"smallBlind":0,"bigBlind":0,"ante":0,"durationMinutes":5,"isBreak":true},{"level":27,"smallBlind":6000,"bigBlind":12000,"ante":2000,"durationMinutes":8},{"level":28,"smallBlind":8000,"bigBlind":16000,"ante":2500,"durationMinutes":8},{"level":29,"smallBlind":10000,"bigBlind":20000,"ante":3000,"durationMinutes":8},{"level":30,"smallBlind":12000,"bigBlind":24000,"ante":3500,"durationMinutes":8}],"payoutStructure":[{"place":1,"percentage":50.13},{"place":2,"percentage":17.72},{"place":3,"percentage":9.64},{"place":4,"percentage":6.26},{"place":5,"percentage":4.48},{"place":6,"percentage":3.41},{"place":7,"percentage":2.71},{"place":8,"percentage":2.21},{"place":9,"percentage":1.86},{"place":10,"percentage":1.58}],"guaranteedPrize":0,"lateRegistrationLevels":6,"startTime":null,"isRebuy":false,"isReentry":false,"rebuyCost":50,"rebuyChips":10000,"addOnAvailable":false,"addOnCost":50,"addOnChips":10000,"addOnLevels":1,"freeBuy":false,"addOnFromStart":false,"bountyAmount":0,"spinType":null,"satelliteTargetId":null,"isXmtt":false,"isPrivate":false,"isVipOnly":false,"banChat":false,"allInOrFold":false,"labelAsNew":false,"hideClubName":false,"actionTimeSeconds":15,"tableSize":9,"acceleratedMtt":false,"bigBlindAnte":false,"authorizedToRegister":false,"earlyBirdEnabled":false,"bubbleProtection":false,"finalTableDealEnabled":false,"synchronizedBreaks":true,"isMultiDay":false,"isFeatured":false}$client$::jsonb || jsonb_build_object('name','Phase3 Native MTT','startTime',transaction_timestamp()+interval '1 day')));
INSERT INTO phase3_creation_results VALUES ('sng',public.fn_create_tournament('f8200000-0000-4000-8000-000000000001',$client${"name":"Friday Major","type":"sng","gameVariant":"NLH","buyIn":50,"startingStack":10000,"maxPlayers":18,"minPlayers":18,"blindStructure":[{"level":1,"smallBlind":10,"bigBlind":20,"ante":0,"durationMinutes":8},{"level":2,"smallBlind":15,"bigBlind":30,"ante":0,"durationMinutes":8},{"level":3,"smallBlind":20,"bigBlind":40,"ante":0,"durationMinutes":8},{"level":4,"smallBlind":25,"bigBlind":50,"ante":0,"durationMinutes":8},{"level":5,"smallBlind":50,"bigBlind":100,"ante":10,"durationMinutes":8},{"level":6,"smallBlind":75,"bigBlind":150,"ante":15,"durationMinutes":8},{"level":7,"smallBlind":100,"bigBlind":200,"ante":25,"durationMinutes":8},{"level":8,"smallBlind":0,"bigBlind":0,"ante":0,"durationMinutes":5,"isBreak":true},{"level":9,"smallBlind":150,"bigBlind":300,"ante":40,"durationMinutes":8},{"level":10,"smallBlind":200,"bigBlind":400,"ante":50,"durationMinutes":8},{"level":11,"smallBlind":300,"bigBlind":600,"ante":75,"durationMinutes":8},{"level":12,"smallBlind":400,"bigBlind":800,"ante":100,"durationMinutes":8},{"level":13,"smallBlind":500,"bigBlind":1000,"ante":150,"durationMinutes":8},{"level":14,"smallBlind":0,"bigBlind":0,"ante":0,"durationMinutes":5,"isBreak":true},{"level":15,"smallBlind":600,"bigBlind":1200,"ante":200,"durationMinutes":8},{"level":16,"smallBlind":800,"bigBlind":1600,"ante":250,"durationMinutes":8},{"level":17,"smallBlind":1000,"bigBlind":2000,"ante":300,"durationMinutes":8},{"level":18,"smallBlind":1200,"bigBlind":2400,"ante":400,"durationMinutes":8},{"level":19,"smallBlind":1500,"bigBlind":3000,"ante":500,"durationMinutes":8},{"level":20,"smallBlind":0,"bigBlind":0,"ante":0,"durationMinutes":5,"isBreak":true},{"level":21,"smallBlind":2000,"bigBlind":4000,"ante":600,"durationMinutes":8},{"level":22,"smallBlind":2500,"bigBlind":5000,"ante":750,"durationMinutes":8},{"level":23,"smallBlind":3000,"bigBlind":6000,"ante":1000,"durationMinutes":8},{"level":24,"smallBlind":4000,"bigBlind":8000,"ante":1200,"durationMinutes":8},{"level":25,"smallBlind":5000,"bigBlind":10000,"ante":1500,"durationMinutes":8},{"level":26,"smallBlind":0,"bigBlind":0,"ante":0,"durationMinutes":5,"isBreak":true},{"level":27,"smallBlind":6000,"bigBlind":12000,"ante":2000,"durationMinutes":8},{"level":28,"smallBlind":8000,"bigBlind":16000,"ante":2500,"durationMinutes":8},{"level":29,"smallBlind":10000,"bigBlind":20000,"ante":3000,"durationMinutes":8},{"level":30,"smallBlind":12000,"bigBlind":24000,"ante":3500,"durationMinutes":8}],"payoutStructure":[{"place":1,"percentage":65},{"place":2,"percentage":35}],"guaranteedPrize":0,"lateRegistrationLevels":0,"startTime":null,"isRebuy":false,"isReentry":false,"rebuyCost":50,"rebuyChips":10000,"addOnAvailable":false,"addOnCost":50,"addOnChips":10000,"addOnLevels":1,"freeBuy":false,"addOnFromStart":false,"bountyAmount":0,"spinType":null,"satelliteTargetId":null,"isXmtt":false,"isPrivate":false,"isVipOnly":false,"banChat":false,"allInOrFold":false,"labelAsNew":false,"hideClubName":false,"actionTimeSeconds":15,"tableSize":9,"acceleratedMtt":false,"bigBlindAnte":false,"authorizedToRegister":false,"earlyBirdEnabled":false,"bubbleProtection":false,"finalTableDealEnabled":false,"synchronizedBreaks":true,"isMultiDay":false,"isFeatured":false}$client$::jsonb || jsonb_build_object('name','Phase3 Native SNG','startTime',transaction_timestamp()+interval '1 day')));
INSERT INTO phase3_creation_results VALUES ('spin',public.fn_create_tournament('f8200000-0000-4000-8000-000000000001',$client${"name":"Friday Major","type":"spin","gameVariant":"NLH","buyIn":50,"startingStack":10000,"maxPlayers":3,"minPlayers":3,"blindStructure":[{"level":1,"smallBlind":10,"bigBlind":20,"ante":0,"durationMinutes":8},{"level":2,"smallBlind":15,"bigBlind":30,"ante":0,"durationMinutes":8},{"level":3,"smallBlind":20,"bigBlind":40,"ante":0,"durationMinutes":8},{"level":4,"smallBlind":30,"bigBlind":60,"ante":0,"durationMinutes":8},{"level":5,"smallBlind":40,"bigBlind":80,"ante":0,"durationMinutes":8},{"level":6,"smallBlind":50,"bigBlind":100,"ante":0,"durationMinutes":8},{"level":7,"smallBlind":60,"bigBlind":120,"ante":0,"durationMinutes":8},{"level":8,"smallBlind":75,"bigBlind":150,"ante":0,"durationMinutes":8},{"level":9,"smallBlind":90,"bigBlind":180,"ante":0,"durationMinutes":8},{"level":10,"smallBlind":105,"bigBlind":210,"ante":0,"durationMinutes":8}],"payoutStructure":[{"place":1,"percentage":100}],"guaranteedPrize":0,"lateRegistrationLevels":0,"startTime":null,"isRebuy":false,"isReentry":false,"rebuyCost":50,"rebuyChips":10000,"addOnAvailable":false,"addOnCost":50,"addOnChips":10000,"addOnLevels":1,"freeBuy":false,"addOnFromStart":false,"bountyAmount":0,"spinType":"standard","satelliteTargetId":null,"isXmtt":false,"isPrivate":false,"isVipOnly":false,"banChat":false,"allInOrFold":false,"labelAsNew":false,"hideClubName":false,"actionTimeSeconds":15,"tableSize":3,"acceleratedMtt":false,"bigBlindAnte":false,"authorizedToRegister":false,"earlyBirdEnabled":false,"bubbleProtection":false,"finalTableDealEnabled":false,"synchronizedBreaks":true,"isMultiDay":false,"isFeatured":false}$client$::jsonb || jsonb_build_object('name','Phase3 Native SPIN','startTime',transaction_timestamp()+interval '1 day')));
RESET ROLE;
SELECT 'CREATION_DISCOVERY='||jsonb_object_agg(name,value)::text FROM phase3_creation_results;
SELECT 'CREATION_READBACK='||jsonb_agg(jsonb_build_object('id',id,'type',tournament_type,'name',name,'buy_in_amount',buy_in_amount,'buy_in_fee',buy_in_fee,'starting_chips',starting_chips,'max_players',max_players,'min_players',min_players,'status',status))::text FROM public.tournaments WHERE club_id='f8200000-0000-4000-8000-000000000001';

CREATE TEMP TABLE phase3_creation_configs(name text PRIMARY KEY,value jsonb NOT NULL) ON COMMIT DROP;
INSERT INTO phase3_creation_configs VALUES ('mtt',$client${"name":"Friday Major","type":"mtt","gameVariant":"NLH","buyIn":50,"startingStack":10000,"maxPlayers":100,"minPlayers":10,"blindStructure":[{"level":1,"smallBlind":10,"bigBlind":20,"ante":0,"durationMinutes":8},{"level":2,"smallBlind":15,"bigBlind":30,"ante":0,"durationMinutes":8},{"level":3,"smallBlind":20,"bigBlind":40,"ante":0,"durationMinutes":8},{"level":4,"smallBlind":25,"bigBlind":50,"ante":0,"durationMinutes":8},{"level":5,"smallBlind":50,"bigBlind":100,"ante":10,"durationMinutes":8},{"level":6,"smallBlind":75,"bigBlind":150,"ante":15,"durationMinutes":8},{"level":7,"smallBlind":100,"bigBlind":200,"ante":25,"durationMinutes":8},{"level":8,"smallBlind":0,"bigBlind":0,"ante":0,"durationMinutes":5,"isBreak":true},{"level":9,"smallBlind":150,"bigBlind":300,"ante":40,"durationMinutes":8},{"level":10,"smallBlind":200,"bigBlind":400,"ante":50,"durationMinutes":8},{"level":11,"smallBlind":300,"bigBlind":600,"ante":75,"durationMinutes":8},{"level":12,"smallBlind":400,"bigBlind":800,"ante":100,"durationMinutes":8},{"level":13,"smallBlind":500,"bigBlind":1000,"ante":150,"durationMinutes":8},{"level":14,"smallBlind":0,"bigBlind":0,"ante":0,"durationMinutes":5,"isBreak":true},{"level":15,"smallBlind":600,"bigBlind":1200,"ante":200,"durationMinutes":8},{"level":16,"smallBlind":800,"bigBlind":1600,"ante":250,"durationMinutes":8},{"level":17,"smallBlind":1000,"bigBlind":2000,"ante":300,"durationMinutes":8},{"level":18,"smallBlind":1200,"bigBlind":2400,"ante":400,"durationMinutes":8},{"level":19,"smallBlind":1500,"bigBlind":3000,"ante":500,"durationMinutes":8},{"level":20,"smallBlind":0,"bigBlind":0,"ante":0,"durationMinutes":5,"isBreak":true},{"level":21,"smallBlind":2000,"bigBlind":4000,"ante":600,"durationMinutes":8},{"level":22,"smallBlind":2500,"bigBlind":5000,"ante":750,"durationMinutes":8},{"level":23,"smallBlind":3000,"bigBlind":6000,"ante":1000,"durationMinutes":8},{"level":24,"smallBlind":4000,"bigBlind":8000,"ante":1200,"durationMinutes":8},{"level":25,"smallBlind":5000,"bigBlind":10000,"ante":1500,"durationMinutes":8},{"level":26,"smallBlind":0,"bigBlind":0,"ante":0,"durationMinutes":5,"isBreak":true},{"level":27,"smallBlind":6000,"bigBlind":12000,"ante":2000,"durationMinutes":8},{"level":28,"smallBlind":8000,"bigBlind":16000,"ante":2500,"durationMinutes":8},{"level":29,"smallBlind":10000,"bigBlind":20000,"ante":3000,"durationMinutes":8},{"level":30,"smallBlind":12000,"bigBlind":24000,"ante":3500,"durationMinutes":8}],"payoutStructure":[{"place":1,"percentage":50.13},{"place":2,"percentage":17.72},{"place":3,"percentage":9.64},{"place":4,"percentage":6.26},{"place":5,"percentage":4.48},{"place":6,"percentage":3.41},{"place":7,"percentage":2.71},{"place":8,"percentage":2.21},{"place":9,"percentage":1.86},{"place":10,"percentage":1.58}],"guaranteedPrize":0,"lateRegistrationLevels":6,"startTime":null,"isRebuy":false,"isReentry":false,"rebuyCost":50,"rebuyChips":10000,"addOnAvailable":false,"addOnCost":50,"addOnChips":10000,"addOnLevels":1,"freeBuy":false,"addOnFromStart":false,"bountyAmount":0,"spinType":null,"satelliteTargetId":null,"isXmtt":false,"isPrivate":false,"isVipOnly":false,"banChat":false,"allInOrFold":false,"labelAsNew":false,"hideClubName":false,"actionTimeSeconds":15,"tableSize":9,"acceleratedMtt":false,"bigBlindAnte":false,"authorizedToRegister":false,"earlyBirdEnabled":false,"bubbleProtection":false,"finalTableDealEnabled":false,"synchronizedBreaks":true,"isMultiDay":false,"isFeatured":false}$client$::jsonb),
('sng',$client${"name":"Friday Major","type":"sng","gameVariant":"NLH","buyIn":50,"startingStack":10000,"maxPlayers":18,"minPlayers":18,"blindStructure":[{"level":1,"smallBlind":10,"bigBlind":20,"ante":0,"durationMinutes":8},{"level":2,"smallBlind":15,"bigBlind":30,"ante":0,"durationMinutes":8},{"level":3,"smallBlind":20,"bigBlind":40,"ante":0,"durationMinutes":8},{"level":4,"smallBlind":25,"bigBlind":50,"ante":0,"durationMinutes":8},{"level":5,"smallBlind":50,"bigBlind":100,"ante":10,"durationMinutes":8},{"level":6,"smallBlind":75,"bigBlind":150,"ante":15,"durationMinutes":8},{"level":7,"smallBlind":100,"bigBlind":200,"ante":25,"durationMinutes":8},{"level":8,"smallBlind":0,"bigBlind":0,"ante":0,"durationMinutes":5,"isBreak":true},{"level":9,"smallBlind":150,"bigBlind":300,"ante":40,"durationMinutes":8},{"level":10,"smallBlind":200,"bigBlind":400,"ante":50,"durationMinutes":8},{"level":11,"smallBlind":300,"bigBlind":600,"ante":75,"durationMinutes":8},{"level":12,"smallBlind":400,"bigBlind":800,"ante":100,"durationMinutes":8},{"level":13,"smallBlind":500,"bigBlind":1000,"ante":150,"durationMinutes":8},{"level":14,"smallBlind":0,"bigBlind":0,"ante":0,"durationMinutes":5,"isBreak":true},{"level":15,"smallBlind":600,"bigBlind":1200,"ante":200,"durationMinutes":8},{"level":16,"smallBlind":800,"bigBlind":1600,"ante":250,"durationMinutes":8},{"level":17,"smallBlind":1000,"bigBlind":2000,"ante":300,"durationMinutes":8},{"level":18,"smallBlind":1200,"bigBlind":2400,"ante":400,"durationMinutes":8},{"level":19,"smallBlind":1500,"bigBlind":3000,"ante":500,"durationMinutes":8},{"level":20,"smallBlind":0,"bigBlind":0,"ante":0,"durationMinutes":5,"isBreak":true},{"level":21,"smallBlind":2000,"bigBlind":4000,"ante":600,"durationMinutes":8},{"level":22,"smallBlind":2500,"bigBlind":5000,"ante":750,"durationMinutes":8},{"level":23,"smallBlind":3000,"bigBlind":6000,"ante":1000,"durationMinutes":8},{"level":24,"smallBlind":4000,"bigBlind":8000,"ante":1200,"durationMinutes":8},{"level":25,"smallBlind":5000,"bigBlind":10000,"ante":1500,"durationMinutes":8},{"level":26,"smallBlind":0,"bigBlind":0,"ante":0,"durationMinutes":5,"isBreak":true},{"level":27,"smallBlind":6000,"bigBlind":12000,"ante":2000,"durationMinutes":8},{"level":28,"smallBlind":8000,"bigBlind":16000,"ante":2500,"durationMinutes":8},{"level":29,"smallBlind":10000,"bigBlind":20000,"ante":3000,"durationMinutes":8},{"level":30,"smallBlind":12000,"bigBlind":24000,"ante":3500,"durationMinutes":8}],"payoutStructure":[{"place":1,"percentage":65},{"place":2,"percentage":35}],"guaranteedPrize":0,"lateRegistrationLevels":0,"startTime":null,"isRebuy":false,"isReentry":false,"rebuyCost":50,"rebuyChips":10000,"addOnAvailable":false,"addOnCost":50,"addOnChips":10000,"addOnLevels":1,"freeBuy":false,"addOnFromStart":false,"bountyAmount":0,"spinType":null,"satelliteTargetId":null,"isXmtt":false,"isPrivate":false,"isVipOnly":false,"banChat":false,"allInOrFold":false,"labelAsNew":false,"hideClubName":false,"actionTimeSeconds":15,"tableSize":9,"acceleratedMtt":false,"bigBlindAnte":false,"authorizedToRegister":false,"earlyBirdEnabled":false,"bubbleProtection":false,"finalTableDealEnabled":false,"synchronizedBreaks":true,"isMultiDay":false,"isFeatured":false}$client$::jsonb),
('spin',$client${"name":"Friday Major","type":"spin","gameVariant":"NLH","buyIn":50,"startingStack":10000,"maxPlayers":3,"minPlayers":3,"blindStructure":[{"level":1,"smallBlind":10,"bigBlind":20,"ante":0,"durationMinutes":8},{"level":2,"smallBlind":15,"bigBlind":30,"ante":0,"durationMinutes":8},{"level":3,"smallBlind":20,"bigBlind":40,"ante":0,"durationMinutes":8},{"level":4,"smallBlind":30,"bigBlind":60,"ante":0,"durationMinutes":8},{"level":5,"smallBlind":40,"bigBlind":80,"ante":0,"durationMinutes":8},{"level":6,"smallBlind":50,"bigBlind":100,"ante":0,"durationMinutes":8},{"level":7,"smallBlind":60,"bigBlind":120,"ante":0,"durationMinutes":8},{"level":8,"smallBlind":75,"bigBlind":150,"ante":0,"durationMinutes":8},{"level":9,"smallBlind":90,"bigBlind":180,"ante":0,"durationMinutes":8},{"level":10,"smallBlind":105,"bigBlind":210,"ante":0,"durationMinutes":8}],"payoutStructure":[{"place":1,"percentage":100}],"guaranteedPrize":0,"lateRegistrationLevels":0,"startTime":null,"isRebuy":false,"isReentry":false,"rebuyCost":50,"rebuyChips":10000,"addOnAvailable":false,"addOnCost":50,"addOnChips":10000,"addOnLevels":1,"freeBuy":false,"addOnFromStart":false,"bountyAmount":0,"spinType":"standard","satelliteTargetId":null,"isXmtt":false,"isPrivate":false,"isVipOnly":false,"banChat":false,"allInOrFold":false,"labelAsNew":false,"hideClubName":false,"actionTimeSeconds":15,"tableSize":3,"acceleratedMtt":false,"bigBlindAnte":false,"authorizedToRegister":false,"earlyBirdEnabled":false,"bubbleProtection":false,"finalTableDealEnabled":false,"synchronizedBreaks":true,"isMultiDay":false,"isFeatured":false}$client$::jsonb);
GRANT SELECT ON phase3_creation_configs TO authenticated;
CREATE FUNCTION pg_temp.creation_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $a$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label; END IF; RAISE NOTICE 'CREATION_PASS: %',label; END $a$;
CREATE FUNCTION pg_temp.creation_state() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $s$
DECLARE r record; v text; result jsonb:='{}'::jsonb;
BEGIN
 FOR r IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','auth','smarter_private','cron') AND c.relkind IN ('r','p') ORDER BY n.nspname,c.relname LOOP
 EXECUTE format($q$SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY to_jsonb(t)::text),'')) FROM %I.%I t$q$,r.nspname,r.relname) INTO v;
 result:=result||jsonb_build_object(r.nspname||'.'||r.relname,v);
 END LOOP; RETURN result;
END $s$;
SELECT pg_temp.creation_assert((value->>'allowed')::boolean,'actual authenticated owner may create in own club') FROM phase3_creation_results WHERE name='access';
DO $created$ DECLARE r record; t public.tournaments%ROWTYPE; BEGIN
 FOR r IN SELECT c.name,c.value config,p.value receipt FROM phase3_creation_configs c JOIN phase3_creation_results p USING(name) ORDER BY c.name LOOP
 PERFORM pg_temp.creation_assert((r.receipt->>'success')::boolean,r.name||' actual client payload accepted');
 SELECT * INTO STRICT t FROM public.tournaments WHERE id=(r.receipt->>'tournament_id')::uuid;
 PERFORM pg_temp.creation_assert(t.club_id='f8200000-0000-4000-8000-000000000001' AND t.name='Phase3 Native '||upper(r.name) AND t.tournament_type=upper(r.name) AND t.status='REGISTERING' AND t.max_players=(r.config->>'maxPlayers')::integer AND t.min_players=(r.config->>'minPlayers')::integer AND t.starting_chips=(r.config->>'startingStack')::integer,r.name||' stored identity, format, limits and stack match client');
 PERFORM pg_temp.creation_assert(t.buy_in_amount+t.buy_in_fee=(r.config->>'buyIn')::numeric AND t.buy_in_fee=(r.receipt->>'buy_in_fee')::numeric AND t.prize_pool=0 AND t.bounty_pool=0 AND t.total_rake=0 AND t.current_players=0 AND NOT t.entry_contract_locked,r.name||' creation preserves fee split without inventing funded liabilities');
 END LOOP;
 PERFORM pg_temp.creation_assert((SELECT count(*)=3 FROM public.tournaments WHERE club_id='f8200000-0000-4000-8000-000000000001'),'three calls create exactly three bound events');
END $created$;
SELECT set_config('request.jwt.claims','{"sub":"f8100000-0000-4000-8000-000000000002","role":"authenticated","session_id":"f8300000-0000-4000-8000-000000000002"}',true);
SET LOCAL ROLE authenticated;
DO $member$ DECLARE before_state jsonb; response jsonb; refused boolean:=false; BEGIN
 PERFORM pg_temp.creation_assert((public.fn_game_creation_access('f8200000-0000-4000-8000-000000000001')->>'allowed')::boolean IS FALSE,'active player sees creation denied');
 before_state:=pg_temp.creation_state();
 BEGIN SELECT public.fn_create_tournament('f8200000-0000-4000-8000-000000000001',value) INTO response FROM phase3_creation_configs WHERE name='mtt'; refused:=COALESCE((response->>'success')::boolean,false) IS FALSE;
 EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
 PERFORM pg_temp.creation_assert(refused AND before_state=pg_temp.creation_state(),'member cannot create and all business relations stay exact');
END $member$;
RESET ROLE;
SELECT set_config('request.jwt.claims','{}',true),set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claim.role','anon',true);
SET LOCAL ROLE anon;
DO $anonymous$ DECLARE before_state jsonb; response jsonb; refused boolean:=false; BEGIN
 before_state:=pg_temp.creation_state();
 BEGIN response:=public.fn_create_tournament('f8200000-0000-4000-8000-000000000001','{}'::jsonb); refused:=COALESCE((response->>'success')::boolean,false) IS FALSE;
 EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
 PERFORM pg_temp.creation_assert(refused AND before_state=pg_temp.creation_state(),'anonymous direct creation refuses without effects');
END $anonymous$;
RESET ROLE;
SELECT set_config('request.jwt.claim.role','',true),set_config('request.jwt.claims','{"sub":"f8100000-0000-4000-8000-000000000001","role":"authenticated","session_id":"f8300000-0000-4000-8000-000000000001"}',true);
CREATE FUNCTION pg_temp.fail_created_event() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
 IF NEW.club_id='f8200000-0000-4000-8000-000000000001' THEN RAISE EXCEPTION 'injected final tournament insertion fault' USING ERRCODE='PZ031'; END IF; RETURN NEW; END $f$;
CREATE TRIGGER zzz_phase3_create_fault AFTER INSERT ON public.tournaments FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_created_event();
SET LOCAL ROLE authenticated;
DO $fault$ DECLARE before_state jsonb; response jsonb; reached boolean:=false; BEGIN
 before_state:=pg_temp.creation_state();
 BEGIN SELECT public.fn_create_tournament('f8200000-0000-4000-8000-000000000001',value) INTO response FROM phase3_creation_configs WHERE name='mtt'; reached:=COALESCE((response->>'success')::boolean,false) IS FALSE AND response::text LIKE '%injected final tournament insertion fault%';
 EXCEPTION WHEN SQLSTATE 'PZ031' THEN reached:=true; END;
 PERFORM pg_temp.creation_assert(reached AND before_state=pg_temp.creation_state(),'actual insertion fault rolls back every business relation');
END $fault$;
RESET ROLE;
DROP TRIGGER zzz_phase3_create_fault ON public.tournaments;
SELECT 'CREATION_NATIVE_EVIDENCE='||jsonb_build_object('formats',(SELECT jsonb_object_agg(name,value) FROM phase3_creation_results),'created_events',(SELECT count(*) FROM public.tournaments WHERE club_id='f8200000-0000-4000-8000-000000000001'),'opening_wallets_preserved',(SELECT bool_and(chip_balance=0) FROM public.club_members WHERE club_id='f8200000-0000-4000-8000-000000000001'))::text;

SET CONSTRAINTS ALL IMMEDIATE;

DO $initial_modes$ DECLARE r record; BEGIN FOR r IN SELECT DISTINCT n.nspname,c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND c.condeferrable AND c.condeferred LOOP EXECUTE format('SET CONSTRAINTS %I.%I DEFERRED',r.nspname,r.conname); END LOOP; END $initial_modes$;
CREATE TEMP TABLE phase3_edit_requests AS SELECT p.name,(p.value->>'tournament_id')::uuid game_id,COALESCE((SELECT max(v.version) FROM public.managed_game_contract_versions v WHERE v.game_kind='tournament' AND v.game_id=(p.value->>'tournament_id')::uuid),0) expected_version,('f8400000-0000-4000-8000-'||lpad(row_number() OVER(ORDER BY p.name)::text,12,'0'))::uuid command_id,jsonb_build_object('name','Phase3 Edited '||upper(p.name)) patch FROM phase3_creation_results p WHERE name IN ('mtt','sng','spin');
CREATE TEMP TABLE phase3_edit_results(name text PRIMARY KEY,value jsonb) ON COMMIT DROP;
GRANT SELECT ON phase3_edit_requests TO authenticated;
GRANT SELECT,INSERT ON phase3_edit_results TO authenticated;
SELECT set_config('request.jwt.claim.role','',true),set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{"sub":"f8100000-0000-4000-8000-000000000001","role":"authenticated","session_id":"f8300000-0000-4000-8000-000000000001"}',true);
SET LOCAL ROLE authenticated;
INSERT INTO phase3_edit_results SELECT name,public.fn_execute_managed_game_command(command_id,'tournament',game_id,'update',expected_version,patch) FROM phase3_edit_requests ORDER BY name;
RESET ROLE;
SELECT 'EDIT_DISCOVERY='||jsonb_build_object('requests',(SELECT jsonb_agg(to_jsonb(r)) FROM phase3_edit_requests r),'results',(SELECT jsonb_object_agg(name,value) FROM phase3_edit_results),'stored',(SELECT jsonb_agg(jsonb_build_object('name',t.name,'id',t.id,'buy_in_amount',t.buy_in_amount,'buy_in_fee',t.buy_in_fee,'prize_pool',t.prize_pool,'version',(SELECT max(v.version) FROM public.managed_game_contract_versions v WHERE v.game_kind='tournament' AND v.game_id=t.id))) FROM public.tournaments t WHERE t.club_id='f8200000-0000-4000-8000-000000000001'))::text;

CREATE FUNCTION pg_temp.edit_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $a$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label; END IF; RAISE NOTICE 'EDIT_PASS: %',label; END $a$;

CREATE FUNCTION pg_temp.edit_rejection_exact(before_state jsonb,response jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $f$
DECLARE after_state jsonb:=pg_temp.creation_state(); cmd uuid:=(response->>'command_id')::uuid; v text; BEGIN
 SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY to_jsonb(t)::text),'')) INTO v FROM public.managed_game_command_receipts t WHERE command_id<>cmd;
 after_state:=jsonb_set(after_state,ARRAY['public.managed_game_command_receipts'],to_jsonb(v));
 SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY to_jsonb(t)::text),'')) INTO v FROM public.game_management_events t WHERE command_id IS DISTINCT FROM cmd;
 after_state:=jsonb_set(after_state,ARRAY['public.game_management_events'],to_jsonb(v));
 SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY to_jsonb(t)::text),'')) INTO v FROM public.audit_trail t WHERE request_id IS DISTINCT FROM cmd::text;
 after_state:=jsonb_set(after_state,ARRAY['public.audit_trail'],to_jsonb(v));
 RETURN before_state=after_state AND (response->>'ok')::boolean IS FALSE
  AND (SELECT count(*)=1 AND bool_and(status='rejected' AND result=response AND actor_id='f8100000-0000-4000-8000-000000000001' AND contract_version_after=contract_version_before) FROM public.managed_game_command_receipts WHERE command_id=cmd)
  AND (SELECT count(*)=1 AND bool_and(event_type='game_command_rejected' AND actor_id='f8100000-0000-4000-8000-000000000001' AND payload=jsonb_build_object('action','update','status','rejected')) FROM public.game_management_events WHERE command_id=cmd)
  AND (SELECT count(*)=1 AND bool_and(action='managed_game_update_rejected' AND actor_id='f8100000-0000-4000-8000-000000000001' AND a.after_state->'result'=response AND reason=response->>'reason' AND amount IS NULL) FROM public.audit_trail a WHERE request_id=cmd::text);
END $f$;
SELECT pg_temp.edit_assert(md5(prosrc)='a5aa98c192ec5be6f73a21fd71b855ff','current managed command source matches live') FROM pg_proc WHERE oid='public.fn_execute_managed_game_command(uuid,text,uuid,text,integer,jsonb)'::regprocedure;
SELECT pg_temp.edit_assert(md5(prosrc)='d85ca8d75218cdc0911c2fbdb1e73ff9','current private update source matches live') FROM pg_proc WHERE oid='public.fn_update_managed_game(text,uuid,jsonb)'::regprocedure;
DO $stored$ DECLARE r record; t public.tournaments%ROWTYPE; BEGIN
 FOR r IN SELECT q.*,p.value FROM phase3_edit_requests q JOIN phase3_edit_results p USING(name) LOOP
  SELECT * INTO STRICT t FROM public.tournaments WHERE id=r.game_id;
  PERFORM pg_temp.edit_assert((r.value->>'ok')::boolean AND r.value->>'command_status'='succeeded' AND (r.value->>'version_before')::integer=r.expected_version AND (r.value->>'version_after')::integer=r.expected_version+1 AND t.name=r.patch->>'name',r.name||' authenticated edit persists exactly one new contract version');
  PERFORM pg_temp.edit_assert((SELECT count(*)=1 AND bool_and(actor_id='f8100000-0000-4000-8000-000000000001' AND result=r.value AND status='succeeded' AND contract_version_after=r.expected_version+1) FROM public.managed_game_command_receipts WHERE command_id=r.command_id),r.name||' successful command has exact immutable receipt');
  PERFORM pg_temp.edit_assert(t.buy_in_amount+t.buy_in_fee=50 AND t.prize_pool=0 AND t.total_rake=0 AND t.bounty_pool=0 AND t.current_players=0,r.name||' edit creates no financial or player liabilities');
 END LOOP;
END $stored$;
SET LOCAL ROLE authenticated;
DO $replay$ DECLARE r record; before_state jsonb; response jsonb; BEGIN
 FOR r IN SELECT q.*,p.value FROM phase3_edit_requests q JOIN phase3_edit_results p USING(name) LOOP
  before_state:=pg_temp.creation_state(); response:=public.fn_execute_managed_game_command(r.command_id,'tournament',r.game_id,'update',r.expected_version,r.patch);
  PERFORM pg_temp.edit_assert(response=(r.value||jsonb_build_object('replayed',true)) AND before_state=pg_temp.creation_state(),r.name||' lost-response replay returns stored result without effects');
 END LOOP;
 SELECT * INTO r FROM phase3_edit_requests WHERE name='mtt'; before_state:=pg_temp.creation_state();
 response:=public.fn_execute_managed_game_command(r.command_id,'tournament',r.game_id,'update',r.expected_version,r.patch||'{"name":"conflicting request"}'::jsonb);
 PERFORM pg_temp.edit_assert(response->>'reason'='idempotency_conflict' AND before_state=pg_temp.creation_state(),'same command id refuses altered payload without effects');
END $replay$;
RESET ROLE;
SELECT set_config('request.jwt.claims','{"sub":"f8100000-0000-4000-8000-000000000002","role":"authenticated","session_id":"f8300000-0000-4000-8000-000000000002"}',true);
SET LOCAL ROLE authenticated;
DO $member$ DECLARE r record; before_state jsonb; response jsonb; BEGIN
 SELECT * INTO r FROM phase3_edit_requests WHERE name='mtt';before_state:=pg_temp.creation_state();
 response:=public.fn_execute_managed_game_command(r.command_id,'tournament',r.game_id,'update',r.expected_version,r.patch);
 PERFORM pg_temp.edit_assert(response->>'reason'='idempotency_conflict' AND before_state=pg_temp.creation_state(),'another actor cannot replay an owner receipt');
 response:=public.fn_execute_managed_game_command('f8400000-0000-4000-8000-000000000101','tournament',r.game_id,'update',r.expected_version+1,r.patch);
 PERFORM pg_temp.edit_assert(response->>'reason'='not_authorized' AND before_state=pg_temp.creation_state(),'member cannot edit or append a command receipt');
END $member$;
RESET ROLE;
SELECT set_config('request.jwt.claims','{}',true),set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claim.role','anon',true);
SET LOCAL ROLE anon;
DO $anon$ DECLARE before_state jsonb; refused boolean:=false; BEGIN
 before_state:=pg_temp.creation_state();
 BEGIN PERFORM public.fn_execute_managed_game_command('f8400000-0000-4000-8000-000000000102','tournament','f8200000-0000-4000-8000-000000000001','update',1,'{}'); EXCEPTION WHEN insufficient_privilege OR invalid_authorization_specification THEN refused:=true; END;
 PERFORM pg_temp.edit_assert(refused AND before_state=pg_temp.creation_state(),'anonymous command door refuses without effects');
END $anon$;
RESET ROLE;
SELECT set_config('request.jwt.claim.role','',true),set_config('request.jwt.claims','{"sub":"f8100000-0000-4000-8000-000000000001","role":"authenticated","session_id":"f8300000-0000-4000-8000-000000000099"}',true);
SET LOCAL ROLE authenticated;
DO $revoked$ DECLARE r record; before_state jsonb; refused boolean:=false; BEGIN
 SELECT * INTO r FROM phase3_edit_requests WHERE name='mtt';before_state:=pg_temp.creation_state();
 BEGIN PERFORM public.fn_execute_managed_game_command(r.command_id,'tournament',r.game_id,'update',r.expected_version,r.patch); EXCEPTION WHEN invalid_authorization_specification THEN refused:=true; END;
 PERFORM pg_temp.edit_assert(refused AND before_state=pg_temp.creation_state(),'revoked session cannot replay a previous successful receipt');
END $revoked$;
RESET ROLE;
SELECT set_config('request.jwt.claims','{"sub":"f8100000-0000-4000-8000-000000000001","role":"authenticated","session_id":"f8300000-0000-4000-8000-000000000001"}',true);
SET LOCAL ROLE authenticated;
DO $private$ DECLARE r record; before_state jsonb; refused boolean:=false; BEGIN
 SELECT * INTO r FROM phase3_edit_requests WHERE name='mtt';before_state:=pg_temp.creation_state();
 BEGIN PERFORM public.fn_update_managed_game('tournament',r.game_id,r.patch); EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
 PERFORM pg_temp.edit_assert(refused AND before_state=pg_temp.creation_state(),'authenticated owner cannot bypass versioned command through private updater');
END $private$;
DO $stale$ DECLARE r record; before_state jsonb; after_state jsonb; response jsonb; replay jsonb; BEGIN
 SELECT * INTO r FROM phase3_edit_requests WHERE name='mtt';before_state:=pg_temp.creation_state();
 response:=public.fn_execute_managed_game_command('f8400000-0000-4000-8000-000000000103','tournament',r.game_id,'update',r.expected_version,r.patch);
 after_state:=pg_temp.creation_state(); RAISE NOTICE 'EDIT_STALE_DIAGNOSTIC response=% changed_relations=%',response,(SELECT jsonb_agg(k) FROM jsonb_object_keys(before_state) k WHERE before_state->k IS DISTINCT FROM after_state->k);
 PERFORM pg_temp.edit_assert(response->>'reason'='stale_contract_version' AND response->>'command_status'='rejected' AND pg_temp.edit_rejection_exact(before_state,response),'stale form stores rejection and writes only its exact command, management event and audit receipt');
 before_state:=pg_temp.creation_state();replay:=public.fn_execute_managed_game_command('f8400000-0000-4000-8000-000000000103','tournament',r.game_id,'update',r.expected_version,r.patch);
 PERFORM pg_temp.edit_assert(replay=(response||'{"replayed":true}'::jsonb) AND before_state=pg_temp.creation_state(),'stale rejection replays exactly without effects');
END $stale$;
RESET ROLE;
CREATE TEMP TABLE phase3_edit_before AS SELECT id,to_jsonb(t) value FROM public.tournaments t WHERE id=(SELECT game_id FROM phase3_edit_requests WHERE name='mtt');
SET LOCAL ROLE authenticated;
INSERT INTO phase3_edit_results SELECT 'limits',public.fn_execute_managed_game_command('f8400000-0000-4000-8000-000000000104','tournament',game_id,'update',expected_version+1,jsonb_build_object('name','Phase3 Rescheduled MTT','max_players',120,'start_time',transaction_timestamp()+interval '2 days')) FROM phase3_edit_requests WHERE name='mtt';
RESET ROLE;
SELECT pg_temp.edit_assert((SELECT (value->>'ok')::boolean AND (value->>'version_after')::integer=3 FROM phase3_edit_results WHERE name='limits') AND t.name='Phase3 Rescheduled MTT' AND t.max_players=120 AND t.start_time=transaction_timestamp()+interval '2 days' AND (to_jsonb(t)-ARRAY['name','max_players','start_time','updated_at'])=(b.value-ARRAY['name','max_players','start_time','updated_at']),'allowed empty-event limits and schedule change only their declared columns') FROM phase3_edit_before b JOIN public.tournaments t USING(id);
SET LOCAL ROLE authenticated;
DO $invalid$ DECLARE r record; before_state jsonb; response jsonb; BEGIN
 SELECT * INTO r FROM phase3_edit_requests WHERE name='mtt';before_state:=pg_temp.creation_state();
 response:=public.fn_execute_managed_game_command('f8400000-0000-4000-8000-000000000105','tournament',r.game_id,'update',3,'{"name":"bad limit","max_players":"not an integer"}');
 PERFORM pg_temp.edit_assert(response->>'reason'='invalid_payload' AND response->>'command_status'='rejected' AND pg_temp.edit_rejection_exact(before_state,response),'malformed limit rejects with no event or financial changes');
 before_state:=pg_temp.creation_state();
 response:=public.fn_execute_managed_game_command('f8400000-0000-4000-8000-000000000106','tournament',r.game_id,'update',3,'{"name":"   "}');
 PERFORM pg_temp.edit_assert(response->>'reason'='name_required' AND response->>'command_status'='rejected' AND pg_temp.edit_rejection_exact(before_state,response),'blank name rejects with no event or financial changes');
END $invalid$;
RESET ROLE;
CREATE FUNCTION pg_temp.fail_edited_event() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
 IF NEW.club_id='f8200000-0000-4000-8000-000000000001' THEN RAISE EXCEPTION 'injected final tournament edit fault' USING ERRCODE='PZ032'; END IF; RETURN NEW; END $f$;
CREATE TRIGGER zzz_phase3_edit_fault AFTER UPDATE ON public.tournaments FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_edited_event();
SET LOCAL ROLE authenticated;
DO $fault$ DECLARE r record; before_state jsonb; response jsonb; BEGIN
 SELECT * INTO r FROM phase3_edit_requests WHERE name='mtt';before_state:=pg_temp.creation_state();
 response:=public.fn_execute_managed_game_command('f8400000-0000-4000-8000-000000000107','tournament',r.game_id,'update',3,'{"name":"injected failure"}');
 PERFORM pg_temp.edit_assert(response->>'reason'='command_failed' AND response->>'command_status'='rejected' AND pg_temp.edit_rejection_exact(before_state,response),'late update fault rolls back event and contract writes before recording the exact rejection audit trail');
END $fault$;
RESET ROLE;
DROP TRIGGER zzz_phase3_edit_fault ON public.tournaments;
SELECT pg_temp.edit_assert((SELECT count(*)=4 FROM public.managed_game_command_receipts WHERE actor_id='f8100000-0000-4000-8000-000000000001' AND status='succeeded') AND (SELECT count(*)=4 FROM public.managed_game_command_receipts WHERE actor_id='f8100000-0000-4000-8000-000000000001' AND status='rejected'),'exact four accepted and four rejected command receipts persist in rehearsal');
SELECT 'EDIT_NATIVE_EVIDENCE='||jsonb_build_object('formats',(SELECT jsonb_object_agg(name,value) FROM phase3_edit_results),'receipt_statuses',(SELECT jsonb_object_agg(status,n) FROM (SELECT status,count(*) n FROM public.managed_game_command_receipts GROUP BY status) x),'all_wallets_unchanged',(SELECT bool_and(chip_balance=0) FROM public.club_members WHERE club_id='f8200000-0000-4000-8000-000000000001'))::text;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
