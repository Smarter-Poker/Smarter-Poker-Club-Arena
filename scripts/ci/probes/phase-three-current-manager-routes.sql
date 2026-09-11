-- Exercise the actual shared request hook for every newly classified route.
DO $current_engine_routes$
DECLARE
 r record; refused boolean; manager_headers text:=current_setting('request.headers',true);
BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('fn_assign_tournament_player_seat_atomic',true),
  ('fn_ca_reprice_unpaid_tournament_place',true),
  ('fn_complete_tournament_terminal',true),
  ('fn_settle_satellite_tournament',true),
  ('fn_get_tournament_deal_consensus',false),
  ('fn_prove_played_spin_launch_recovery',false),
  ('fn_resolve_satellite_settlement_outcome',false),
  ('fn_resolve_tournament_terminal_outcome',false),
  ('fn_resolve_tournament_terminal_proposal_outcome',false)
 ) routes(name,manager_only) LOOP
  PERFORM set_config('request.method','POST',true);
  PERFORM set_config('request.path','rest/v1/rpc/'||r.name,true);
  PERFORM set_config('request.headers','{}',true);
  refused:=false;
  BEGIN PERFORM smarter_private.fn_smarter_data_api_pre_request();
  EXCEPTION WHEN insufficient_privilege THEN
   IF position('AUTHORITY_REQUIRED' IN SQLERRM)=0 THEN RAISE; END IF;
   refused:=true;
  END;
  PERFORM pg_temp.whole_stage_assert(refused,'unmarked engine request refused for '||r.name);
  PERFORM set_config('request.headers','{"x-smarter-data-actor":"service","x-smarter-data-protocol":"1"}',true);
  refused:=false;
  BEGIN PERFORM smarter_private.fn_smarter_data_api_pre_request();
  EXCEPTION WHEN insufficient_privilege THEN
   IF position('TOURNAMENT_MANAGER_AUTHORITY_REQUIRED' IN SQLERRM)=0 THEN RAISE; END IF;
   refused:=true;
  END;
  PERFORM pg_temp.whole_stage_assert(refused=r.manager_only,
   'identified service authority is classified correctly for '||r.name);
  PERFORM set_config('request.headers',manager_headers,true);
  PERFORM smarter_private.fn_smarter_data_api_pre_request();
  PERFORM pg_temp.whole_stage_assert(current_setting('app.smarter_manager_request_fenced',true)='protocol-2',
   'exact current manager is admitted for '||r.name);
 END LOOP;
 -- These are the authenticated human proposal/voting doors, separate from the
 -- engine-only consensus RPC. The hook must keep their ordinary browser shape.
 PERFORM set_config('request.headers','{}',true);
 PERFORM set_config('request.jwt.claims','{"role":"authenticated"}',true);
 PERFORM set_config('request.jwt.claim.role','authenticated',true);
 FOR r IN SELECT name FROM (VALUES ('fn_get_tournament_deal_proposal'),('fn_cast_tournament_deal_vote')) x(name) LOOP
  PERFORM set_config('request.path','rpc/'||r.name,true);
  PERFORM smarter_private.fn_smarter_data_api_pre_request();
  PERFORM pg_temp.whole_stage_assert(current_setting('app.smarter_data_actor',true)='browser',
   'authenticated human deal route retains its browser envelope: '||r.name);
 END LOOP;
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 PERFORM set_config('request.jwt.claim.role','service_role',true);
 PERFORM set_config('request.headers',manager_headers,true);
 PERFORM set_config('request.path','tournaments',true);
 PERFORM set_config('request.method','PATCH',true);
 PERFORM smarter_private.fn_smarter_data_api_pre_request();
END $current_engine_routes$;

