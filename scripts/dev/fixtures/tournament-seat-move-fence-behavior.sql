CREATE FUNCTION public.probe_route(
  route text, headers jsonb, claim text, refusal text, actor text
) RETURNS void LANGUAGE plpgsql AS $probe$
DECLARE denied boolean := false;
BEGIN
  PERFORM set_config('request.headers',headers::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('role',claim)::text,true);
  PERFORM set_config('request.method','POST',true);
  PERFORM set_config('request.path',route,true);
  BEGIN
    PERFORM smarter_private.fn_smarter_data_api_pre_request();
  EXCEPTION WHEN OTHERS THEN
    IF refusal IS NULL OR SQLSTATE <> '42501' OR position(refusal IN SQLERRM)=0 THEN
      RAISE;
    END IF;
    denied := true;
  END;
  IF refusal IS NOT NULL AND NOT denied THEN
    RAISE EXCEPTION 'Route % admitted % without required manager authority',route,headers;
  END IF;
  IF refusal IS NULL AND (
    current_setting('app.smarter_data_actor',true) IS DISTINCT FROM actor
    OR (actor='tournament-manager' AND
        current_setting('app.smarter_manager_request_fenced',true) IS DISTINCT FROM 'protocol-2')
    OR (actor<>'tournament-manager' AND
        COALESCE(current_setting('app.smarter_manager_request_fenced',true),'')<>'')
  ) THEN
    RAISE EXCEPTION 'Route % returned incorrect request authority',route;
  END IF;
END;
$probe$;

SET LOCAL ROLE service_role;
DO $service_routes$
DECLARE
  prefix text;
  rpc text;
  route text;
  manager jsonb := '{"x-smarter-data-actor":"tournament-manager","x-smarter-data-protocol":"2","x-smarter-tournament-id":"10000000-0000-4000-8000-000000000001","x-smarter-tournament-lease-generation":"50000000-0000-4000-8000-000000000001"}';
  service jsonb := '{"x-smarter-data-actor":"service","x-smarter-data-protocol":"1"}';
BEGIN
  FOREACH prefix IN ARRAY ARRAY['/rpc/','/rest/v1/rpc/'] LOOP
    FOREACH rpc IN ARRAY ARRAY['fn_move_tournament_player','fn_move_tournament_player_atomic'] LOOP
      route:=prefix||rpc;
      PERFORM public.probe_route(route,'{}','service_role','TOURNAMENT_MANAGER_AUTHORITY_REQUIRED',NULL);
      PERFORM public.probe_route(route,service,'service_role','TOURNAMENT_MANAGER_AUTHORITY_REQUIRED',NULL);
      PERFORM public.probe_route(route,manager,'service_role',NULL,'tournament-manager');
      PERFORM public.probe_route(route,
        manager||'{"x-smarter-tournament-lease-generation":"50000000-0000-4000-8000-000000000099"}',
        'service_role','TOURNAMENT_MANAGER_FENCED',NULL);
      PERFORM public.probe_route(route,
        manager||'{"x-smarter-tournament-id":"10000000-0000-4000-8000-000000000002","x-smarter-tournament-lease-generation":"50000000-0000-4000-8000-000000000002"}',
        'service_role','TOURNAMENT_MANAGER_FENCED',NULL);
    END LOOP;
    -- Receipt recovery intentionally runs outside the lost manager context.
    PERFORM public.probe_route(prefix||'fn_resolve_committed_tournament_seat_move',
      service,'service_role',NULL,'service');
    PERFORM public.probe_route(prefix||'unrelated_shared_estate_operation',
      '{}','service_role',NULL,'shared-estate-service');
  END LOOP;
END;
$service_routes$;
RESET ROLE;

SET LOCAL ROLE authenticated;
DO $browser_routes$
DECLARE prefix text; rpc text;
BEGIN
  FOREACH prefix IN ARRAY ARRAY['/rpc/','/rest/v1/rpc/'] LOOP
    FOREACH rpc IN ARRAY ARRAY['fn_move_tournament_player','fn_move_tournament_player_atomic'] LOOP
      PERFORM public.probe_route(prefix||rpc,'{}','authenticated',
        'TOURNAMENT_MANAGER_AUTHORITY_REQUIRED',NULL);
    END LOOP;
    PERFORM public.probe_route(prefix||'process_tournament_rebuy','{}','authenticated',NULL,'browser');
    PERFORM public.probe_route(prefix||'fn_decline_tournament_rebuy','{}','authenticated',NULL,'browser');
  END LOOP;
END;
$browser_routes$;
RESET ROLE;
SELECT '32 request admission scenarios passed; full cutover and seat economics remain separate' AS result;
