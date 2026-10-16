-- Owner direction 2026-10-15 supersedes forced agent-to-agent destinations.
-- Patch only the routing clauses of the installed retained cores. Preserve
-- locks, downline authorization, exact-intent wrapper, accounting and reversal.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
DO $wallet_choice$
DECLARE v_definition text; v_before text; v_after text;
BEGIN
  SELECT pg_get_functiondef('public.fn_agent_wallet_send_core_20260830(uuid,uuid,numeric,text,text,uuid)'::regprocedure) INTO v_definition;
  IF md5(v_definition) <> 'a0450017b41fa460fe53a91da29ee51e' THEN
    RAISE EXCEPTION 'Unexpected function preimage: fn_agent_wallet_send_core_20260830';
  END IF;
  v_before := $before$  if v_to_role in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    v_dest := 'agent_wallet';
  end if;$before$;
  v_after := $after$  if v_dest = 'player_wallet' and v_to_role = 'admin' then
    return jsonb_build_object('success', false,
      'error', 'An Admin Does Not Hold A Player Wallet');
  end if;$after$;
  IF strpos(v_definition, v_before) = 0 THEN RAISE EXCEPTION 'Missing routing clause'; END IF;
  EXECUTE replace(v_definition, v_before, v_after);
  SELECT pg_get_functiondef('public.fn_agent_wallet_send_phase2_core_20260831(uuid,uuid,numeric,text,text,uuid)'::regprocedure) INTO v_definition;
  IF md5(v_definition) <> 'e38f6f9239ec92717201736978896b27' THEN
    RAISE EXCEPTION 'Unexpected function preimage: fn_agent_wallet_send_phase2_core_20260831';
  END IF;
  v_before := $before$    v_replay_destination := case
      when coalesce(v_prior.metadata->>'recipient_role','') in
        ('owner','co_owner','admin','super_agent','agent','sub_agent')
      then 'agent_wallet' else v_destination end;$before$;
  IF strpos(v_definition, v_before) = 0 THEN RAISE EXCEPTION 'Missing replay clause'; END IF;
  v_definition := replace(v_definition, v_before, '    v_replay_destination := v_destination;');
  v_before := $before$  -- Agent recipients always receive agent float; bind the replay fingerprint
  -- to the effective destination, not a caller-controlled label.
  if v_target_role in ('owner','co_owner','admin','super_agent','agent','sub_agent') then
    v_destination:='agent_wallet';
  end if;$before$;
  IF strpos(v_definition, v_before) = 0 THEN RAISE EXCEPTION 'Missing destination clause'; END IF;
  EXECUTE replace(v_definition, v_before, '  -- The requested destination is validated by the retained core.');
END
$wallet_choice$;
DO $bank_lock_order$
DECLARE v_definition text;
BEGIN
 SELECT pg_get_functiondef('public.fn_club_bank_send(uuid,uuid,numeric,text,text,uuid)'::regprocedure) INTO v_definition;
 IF md5(v_definition) <> 'd858bb9dbc4c2657c940c99f0c03b015' THEN RAISE EXCEPTION 'Unexpected bank send wrapper preimage'; END IF;
 EXECUTE replace(v_definition,
   $before$  v_result := public.fn_club_bank_send_core_20261004$before$,
   $after$  IF p_club_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:' || p_club_id::text, 0));
  END IF;
  v_result := public.fn_club_bank_send_core_20261004$after$);
END
$bank_lock_order$;
COMMIT;
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_agent_wallet_send_core_20260830(uuid,uuid,numeric,text,text,uuid)'::regprocedure)) = '5a56023dc4b123775fa4fe7f7cb50cb8')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_agent_wallet_send_phase2_core_20260831(uuid,uuid,numeric,text,text,uuid)'::regprocedure)) = '3eeac7ee4ed90db3b5bd59052a21620e')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_club_bank_send(uuid,uuid,numeric,text,text,uuid)'::regprocedure)) = '08e0c75b5fb1f51fc8c31a8928271fb6')
