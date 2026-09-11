#!/usr/bin/env python3
"""Compose the existing full satellite proof under real Stage B manager requests.

Only a test wrapper selects service_role and invokes the installed pre-request;
no manager proof, lease row, source money or production function is synthesized.
The caller composes current request dependencies and full Stage B beforehand.
"""
from pathlib import Path

MANAGER_SETUP = r"""
-- Same live lease admission envelope as REQUEST_PROBE in the whole Stage B runner.
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true),
 set_config('request.jwt.claim.role','service_role',true),
 set_config('request.headers','{"x-smarter-data-actor":"service","x-smarter-data-protocol":"1"}',true),
 set_config('request.method','POST',true),set_config('request.path','rpc/claim_tournament_lease_v2',true);
SELECT smarter_private.fn_smarter_data_api_pre_request();
SELECT pg_temp.satellite_full_assert(granted,'actual lease authority grants the satellite source manager')
 FROM public.claim_tournament_lease_v2('d3000000-0000-4000-8000-000000000001',
 'native-satellite-stage-b','native-reviewed-source','d7000000-0000-4000-8000-000000000001',30);
RESET ROLE;

CREATE FUNCTION pg_temp.satellite_manager_request(p_path text) RETURNS void
LANGUAGE plpgsql AS $manager_request$
BEGIN
 IF current_user<>'service_role' THEN RAISE EXCEPTION 'native manager request must use service_role'; END IF;
 IF p_path NOT IN ('rpc/fn_settle_satellite_tournament','rpc/fn_resolve_satellite_settlement_outcome') THEN
  RAISE EXCEPTION 'native manager probe path differs'; END IF;
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 PERFORM set_config('request.jwt.claim.role','service_role',true);
 PERFORM set_config('request.method','POST',true);
 PERFORM set_config('request.path',p_path,true);
 PERFORM set_config('request.headers',
  '{"x-smarter-data-actor":"tournament-manager","x-smarter-data-protocol":"2","x-smarter-tournament-id":"d3000000-0000-4000-8000-000000000001","x-smarter-tournament-lease-generation":"d7000000-0000-4000-8000-000000000001"}',true);
 -- This is the real request hook. It must read and hold the actual fresh lease.
 PERFORM smarter_private.fn_smarter_data_api_pre_request();
 IF current_setting('app.smarter_data_actor',true) IS DISTINCT FROM 'tournament-manager'
  OR current_setting('app.smarter_manager_request_fenced',true) IS DISTINCT FROM 'protocol-2'
  OR current_setting('app.smarter_tournament_id',true) IS DISTINCT FROM 'd3000000-0000-4000-8000-000000000001'
  OR current_setting('app.smarter_tournament_lease_generation',true) IS DISTINCT FROM 'd7000000-0000-4000-8000-000000000001' THEN
  RAISE EXCEPTION 'native manager pre-request did not install exact lease proof'; END IF;
END $manager_request$;

CREATE FUNCTION pg_temp.manager_satellite_settle(p_source uuid,p_winner uuid) RETURNS jsonb
LANGUAGE plpgsql AS $manager_settle$
DECLARE prior_role text:=current_setting('role'); result jsonb;
BEGIN
 PERFORM set_config('role','service_role',true);
 BEGIN
  PERFORM pg_temp.satellite_manager_request('rpc/fn_settle_satellite_tournament');
  result:=public.fn_settle_satellite_tournament(p_source,p_winner);
 EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('role',prior_role,true); RAISE;
 END;
 PERFORM set_config('role',prior_role,true);
 RETURN result;
END $manager_settle$;

CREATE FUNCTION pg_temp.manager_satellite_outcome(p_source uuid,p_winner uuid) RETURNS jsonb
LANGUAGE plpgsql AS $manager_outcome$
DECLARE prior_role text:=current_setting('role'); result jsonb;
BEGIN
 PERFORM set_config('role','service_role',true);
 BEGIN
  PERFORM pg_temp.satellite_manager_request('rpc/fn_resolve_satellite_settlement_outcome');
  result:=public.fn_resolve_satellite_settlement_outcome(p_source,p_winner);
 EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('role',prior_role,true); RAISE;
 END;
 PERFORM set_config('role',prior_role,true);
 RETURN result;
END $manager_outcome$;

CREATE FUNCTION pg_temp.satellite_manager_outside_scope(p_label text) RETURNS void
LANGUAGE plpgsql AS $outside_scope$
DECLARE prior_role text:=current_setting('role'); refused boolean:=false;
BEGIN
 IF EXISTS(SELECT 1 FROM public.tournament_satellite_terminal_authorizations) THEN
  RAISE EXCEPTION 'outside-scope proof found a surviving satellite capability'; END IF;
 PERFORM set_config('role','service_role',true);
 BEGIN
  PERFORM pg_temp.satellite_manager_request('rpc/fn_settle_satellite_tournament');
  BEGIN
   UPDATE public.tournaments SET name=name WHERE id='d3000000-0000-4000-8000-000000000002';
  EXCEPTION WHEN insufficient_privilege THEN
   IF position('TOURNAMENT_MANAGER_SCOPE' IN SQLERRM)=0 THEN RAISE; END IF;
   refused:=true;
  END;
 EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('role',prior_role,true); RAISE;
 END;
 PERFORM set_config('role',prior_role,true);
 PERFORM pg_temp.satellite_full_assert(refused,p_label);
END $outside_scope$;
SELECT pg_temp.satellite_manager_outside_scope('before source RPC the source manager cannot write the target without a capability');
"""


def compose_manager_probe(root):
    probe=(Path(root)/"scripts/ci/probes/satellite-full-terminal-native.sql").read_text()
    anchor="END $assert$;"
    if probe.count(anchor)!=1:
        raise ValueError("satellite assertion injection anchor differs")
    # Replace only the existing literal fixture RPC calls, never prerequisites
    # or signatures. The wrappers still call the same real public authorities.
    calls=[("public.fn_settle_satellite_tournament('d300", "pg_temp.manager_satellite_settle('d300",3),
           ("public.fn_resolve_satellite_settlement_outcome('d300", "pg_temp.manager_satellite_outcome('d300",1)]
    for old,new,count in calls:
        if probe.count(old)!=count:
            raise ValueError("satellite manager RPC call set differs: "+old)
        probe=probe.replace(old,new)
    probe=probe.replace(anchor,anchor+"\n"+MANAGER_SETUP,1)
    anchor="SET CONSTRAINTS ALL IMMEDIATE;"
    if probe.count(anchor)!=1:
        raise ValueError("satellite final manager denial anchor differs")
    probe=probe.replace(anchor,"SELECT pg_temp.satellite_manager_outside_scope('after source completion and replay the source manager still cannot write the target without a capability');\n"+anchor,1)
    return probe
