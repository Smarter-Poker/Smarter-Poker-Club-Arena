-- DRAFT ONLY. NOT EXECUTED OR QUALIFIED AS A PRODUCTION PROBE.
-- Parent owns execution after exact protected delivery, installed-source/ACL
-- parity and unchanged original preimage/funding/lease readback.
-- ONE provider call containing BEGIN, SET LOCAL then ONE DO block, in the same
-- provider transaction. Never split these statements across calls. No DDL
-- and no full-production-table scans. The unhandled final exception aborts
-- every financial effect in this call; no COMMIT or caught success path.
-- A persistent rehearsal connection must drain PZ002 then ROLLBACK its aborted
-- transaction before independent durable readback; management calls must not
-- split BEGIN, timeout and DO into separate requests.
-- Expected PZ002 forces the entire call to abort. Any other error is failure.
-- Full native qualification and independent post-abort durable readback required.
-- Captures scoped table rows; does NOT promise rollback of sequence allocations.
BEGIN;
SET LOCAL statement_timeout='20s';
DO $probe$
DECLARE
 operation uuid := '341f02a3-4655-420c-b43b-3930b6d9ad8f';
 event uuid := '2aa4cba1-506f-426b-a1ba-d8e22e018533';
 winner uuid := 'aef849b8-2906-4dc0-b108-251710e76d3c';
 funding_club uuid := 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
 original_role text := current_user;
 source_sha text := '8a0eb326f88354ac1578729c5286615cfb1b7311c30e410c26e7f6ffb08aa3f5';
 queries jsonb := $queries${"public.tournament_players": "SELECT * FROM public.tournament_players WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533'::uuid", "public.tournament_escrow": "SELECT * FROM public.tournament_escrow WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533'::uuid", "public.tournament_terminal_settlements": "SELECT * FROM public.tournament_terminal_settlements WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533'::uuid", "public.engine_tournament_leases": "SELECT * FROM public.engine_tournament_leases WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533'::uuid", "public.accounting_tournament_fee_custody_obligations": "SELECT * FROM public.accounting_tournament_fee_custody_obligations WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533'::uuid", "public.accounting_tournament_fee_recognitions": "SELECT * FROM public.accounting_tournament_fee_recognitions WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533'::uuid", "public.accounting_tournament_recognized_sources": "SELECT * FROM public.accounting_tournament_recognized_sources WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533'::uuid", "public.tournament_rake_settlements": "SELECT * FROM public.tournament_rake_settlements WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533'::uuid", "public.tournament_payouts": "SELECT * FROM public.tournament_payouts WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533'::uuid", "public.spin_reserve_ledger": "SELECT * FROM public.spin_reserve_ledger WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533'::uuid", "public.chip_ledger": "SELECT * FROM public.chip_ledger WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533'::uuid", "smarter_private.spin_archived_first_admission": "SELECT * FROM smarter_private.spin_archived_first_admission WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533'::uuid", "public.tables": "SELECT * FROM public.tables WHERE id='6eaddeaf-1511-4265-bb38-37811ae82ad9'::uuid", "public.table_seats": "SELECT * FROM public.table_seats WHERE table_id='6eaddeaf-1511-4265-bb38-37811ae82ad9'::uuid", "public.club_members": "SELECT * FROM public.club_members WHERE (club_id='a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid AND user_id IN ('aef849b8-2906-4dc0-b108-251710e76d3c'::uuid,'036f0b55-c601-4d09-982a-5294cf4ea15d'::uuid,'72f2fedb-a5f9-4d10-b147-d92e18102d3f'::uuid)) OR (club_id='a0000000-0000-0000-0000-000000000001'::uuid AND user_id='aef849b8-2906-4dc0-b108-251710e76d3c'::uuid)", "public.clubs": "SELECT * FROM public.clubs WHERE id IN ('a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid,'fade0000-0000-0000-0000-000000000001'::uuid,'a0000000-0000-0000-0000-000000000001'::uuid)", "public.unions": "SELECT * FROM public.unions WHERE id='fade0000-0000-0000-0000-000000000001'::uuid", "public.union_wallets": "SELECT * FROM public.union_wallets WHERE union_id='fade0000-0000-0000-0000-000000000001'::uuid", "public.spin_bonus_pools": "SELECT * FROM public.spin_bonus_pools WHERE id='2d968239-acdd-4a2c-99f2-a369ff37ae31'::uuid", "public.wallet_credit_idempotency": "SELECT * FROM public.wallet_credit_idempotency WHERE key>='tourney:2aa4cba1-506f-426b-a1ba-d8e22e018533:' AND key<'tourney:2aa4cba1-506f-426b-a1ba-d8e22e018533;'", "public.tournaments": "SELECT * FROM public.tournaments WHERE id='2aa4cba1-506f-426b-a1ba-d8e22e018533'::uuid"}$queries$::jsonb;
 phase integer; name text; query text; part jsonb; snap jsonb;
 before_state jsonb; inside_state jsonb; response jsonb; replay jsonb;
 accounts jsonb; expected_accounts jsonb; row_before jsonb; row_after jsonb;
 terminal jsonb; escrow jsonb; custody jsonb; accounting jsonb; admission jsonb; lease jsonb;
 expected_amount numeric; added jsonb;
BEGIN
 PERFORM set_config('lock_timeout','3s',true);
 PERFORM set_config('TimeZone','UTC',true);
 IF transaction_timestamp()<'2026-09-21T07:00:00Z'::timestamptz
 OR transaction_timestamp()>='2026-09-28T07:00:00Z'::timestamptz THEN
  RAISE EXCEPTION 'PROBE_RECOGNITION_PERIOD_CAPTURE_EXPIRED'; END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RAISE EXCEPTION 'PROBE_FROZEN'; END IF;
 IF EXISTS(SELECT 1 FROM public.tournament_terminal_settlements WHERE tournament_id=event)
 OR EXISTS(SELECT 1 FROM smarter_private.spin_archived_first_admission WHERE tournament_id=event)
 OR EXISTS(SELECT 1 FROM public.engine_tournament_leases WHERE tournament_id=event) THEN
  RAISE EXCEPTION 'PROBE_PRIOR_AUTHORITY_REQUIRES_READBACK'; END IF;
 IF public.fn_ca_legacy_spin_original_fee_proof(event) IS DISTINCT FROM
    smarter_private.spin_archived_first_manifest()->'reviewed_fee_proof' THEN
  RAISE EXCEPTION 'PROBE_ORIGINAL_FUNDING_CHANGED'; END IF;
 FOR phase IN 0..2 LOOP
  snap:='{}'::jsonb;
  FOR name,query IN SELECT key,value FROM jsonb_each_text(queries) LOOP
   EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb) FROM ('||query||') r' INTO part;
   IF jsonb_array_length(part)>200 THEN RAISE EXCEPTION 'PROBE_SCOPE_BOUND: %',name; END IF;
   -- Retain only financial projections for shared account records; no contacts.
   IF name IN ('public.club_members','public.clubs','public.unions','public.union_wallets','public.spin_bonus_pools') THEN
    SELECT coalesce(jsonb_agg(projected ORDER BY projected::text),'[]'::jsonb) INTO part FROM (
     SELECT (SELECT jsonb_object_agg(k,v ORDER BY k) FROM jsonb_each(r) q(k,v)
      WHERE k IN ('id','user_id','club_id','union_id') OR
      k ~ '(balance|treasury|wallet|chip_pool|locked_chips|held_chips|credit_|diamonds|total_deposited|total_drawn|seeded_amount|surplus_returned|seed_returned_amount)') projected
     FROM jsonb_array_elements(part) r) projected_rows;
   END IF;
   snap:=snap||jsonb_build_object(name,part);
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.hand_history WHERE tournament_id=event)
   OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id='6eaddeaf-1511-4265-bb38-37811ae82ad9'::uuid)
   OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id='6eaddeaf-1511-4265-bb38-37811ae82ad9'::uuid) THEN
   RAISE EXCEPTION 'PROBE_HISTORY_AUTHORITY_CHANGED'; END IF;
  IF phase=0 THEN before_state:=snap;
  ELSIF phase=1 THEN inside_state:=snap;
  ELSE
   IF snap IS DISTINCT FROM inside_state OR replay IS DISTINCT FROM response THEN
    RAISE EXCEPTION 'PROBE_SAME_OPERATION_REPLAY_CHANGED'; END IF;
   EXIT;
  END IF;
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM set_config('request.headers','{"x-smarter-data-actor":"service","x-smarter-data-protocol":"1"}',true);
  PERFORM set_config('request.method','POST',true);
  PERFORM set_config('request.path','/rpc/fn_complete_first_archived_spin',true);
  EXECUTE 'SET LOCAL ROLE service_role';
  IF current_user<>'service_role' OR auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'PROBE_SERVICE_CONTEXT'; END IF;
  PERFORM smarter_private.fn_smarter_data_api_pre_request();
  IF phase=0 THEN response:=public.fn_complete_first_archived_spin(operation,source_sha);
  ELSE replay:=public.fn_complete_first_archived_spin(operation,source_sha); END IF;
  SET CONSTRAINTS ALL IMMEDIATE;
  EXECUTE format('SET LOCAL ROLE %I',original_role);
 END LOOP;
 IF response->'ok' IS DISTINCT FROM 'true'::jsonb OR response->>'status' IS DISTINCT FROM 'COMPLETED'
 OR response->'fully_settled' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'PROBE_TERMINAL_RESPONSE'; END IF;
 accounting:=response#>'{rake,accounting}';
 IF accounting->>'status' IS DISTINCT FROM 'fee_custody_unresolved'
 OR accounting->'accounting_complete' IS DISTINCT FROM 'false'::jsonb
 OR accounting->'payable' IS DISTINCT FROM 'false'::jsonb
 OR (accounting->>'held_amount')::numeric IS DISTINCT FROM 24
 OR (accounting->>'current_held_amount')::numeric IS DISTINCT FROM 24
 OR (accounting->>'bank_amount')::numeric IS DISTINCT FROM 0
 OR accounting->>'source_fingerprint' IS DISTINCT FROM 'bfb56dac635bc7a238383d785ea88f35' THEN RAISE EXCEPTION 'PROBE_FEE_CUSTODY'; END IF;
 IF jsonb_array_length(inside_state->'public.tournament_terminal_settlements')<>1
 OR jsonb_array_length(inside_state->'public.accounting_tournament_fee_custody_obligations')<>1
 OR jsonb_array_length(inside_state->'public.tournament_escrow')<>1 THEN RAISE EXCEPTION 'PROBE_RECEIPT_CARDINALITY'; END IF;
 IF jsonb_array_length(inside_state->'smarter_private.spin_archived_first_admission')<>1
 OR jsonb_array_length(inside_state->'public.engine_tournament_leases')<>1 THEN
  RAISE EXCEPTION 'PROBE_OPERATION_AUTHORITY_CARDINALITY'; END IF;
 admission:=inside_state->'smarter_private.spin_archived_first_admission'->0;
 lease:=inside_state->'public.engine_tournament_leases'->0;
 IF admission->>'tournament_id' IS DISTINCT FROM event::text
 OR admission->>'operation_id' IS DISTINCT FROM operation::text
 OR admission->>'lease_generation' IS DISTINCT FROM operation::text
 OR admission->>'source_sha256' IS DISTINCT FROM source_sha
 OR admission->>'owner_instance' IS DISTINCT FROM 'service:archived-spin-first:'||operation::text
 OR admission->'original_fee_proof' IS DISTINCT FROM smarter_private.spin_archived_first_manifest()->'reviewed_fee_proof'
 OR (admission->>'admitted_xid')::bigint IS DISTINCT FROM txid_current()
 OR (admission->>'admitted_at')::timestamptz IS DISTINCT FROM transaction_timestamp()
 OR lease->>'tournament_id' IS DISTINCT FROM event::text
 OR lease->>'lease_generation' IS DISTINCT FROM operation::text
 OR lease->>'instance_id' IS DISTINCT FROM admission->>'owner_instance'
 OR lease->>'engine_version' IS DISTINCT FROM 'archived-database-projection-v1'
 OR (lease->>'protocol_version')::integer IS DISTINCT FROM 2
 OR lease->>'acquired_at' IS NULL OR lease->'heartbeat_at' IS DISTINCT FROM lease->'acquired_at' THEN
  RAISE EXCEPTION 'PROBE_OPERATION_AUTHORITY_CHANGED'; END IF;
 terminal:=inside_state->'public.tournament_terminal_settlements'->0;
 custody:=inside_state->'public.accounting_tournament_fee_custody_obligations'->0;
 escrow:=inside_state->'public.tournament_escrow'->0;
 IF (custody->>'amount')::numeric IS DISTINCT FROM 24 OR custody->>'source_fingerprint' IS DISTINCT FROM accounting->>'source_fingerprint'
 OR custody->>'id' IS DISTINCT FROM accounting->>'obligation_id'
 OR (escrow->>'prize_balance')::numeric IS DISTINCT FROM 0 OR (escrow->>'bounty_balance')::numeric IS DISTINCT FROM 0
 OR (escrow->>'fee_balance')::numeric IS DISTINCT FROM 24 OR escrow->'closed_at' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'PROBE_STORED_FEE_CUSTODY'; END IF;
 FOREACH name IN ARRAY ARRAY['public.accounting_tournament_fee_recognitions','public.accounting_tournament_recognized_sources','public.tournament_rake_settlements'] LOOP
  IF inside_state->name IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'PROBE_FALSE_FEE_PAYMENT: %',name; END IF;
 END LOOP;
 IF jsonb_array_length(before_state->'public.club_members')<>4 THEN RAISE EXCEPTION 'PROBE_WALLET_CARDINALITY'; END IF;
 SELECT jsonb_agg(CASE WHEN r->>'user_id'=winner::text AND r->>'club_id'=funding_club::text
  THEN jsonb_set(r,'{chip_balance}',to_jsonb((r->>'chip_balance')::numeric+200)) ELSE r END ORDER BY
  (CASE WHEN r->>'user_id'=winner::text AND r->>'club_id'=funding_club::text THEN jsonb_set(r,'{chip_balance}',to_jsonb((r->>'chip_balance')::numeric+200)) ELSE r END)::text)
 INTO expected_accounts FROM jsonb_array_elements(before_state->'public.club_members') r;
 IF inside_state->'public.club_members' IS DISTINCT FROM expected_accounts THEN RAISE EXCEPTION 'PROBE_WALLET_DELTA'; END IF;
 FOREACH name IN ARRAY ARRAY['public.clubs','public.unions','public.union_wallets','public.spin_bonus_pools','public.spin_reserve_ledger'] LOOP
  IF inside_state->name IS DISTINCT FROM before_state->name THEN
   -- A shared wallet can change between READ COMMITTED observations. Retain
   -- the actual financial projections for attribution; never waive equality,
   -- infer a benign external writer, or change admission snapshot semantics.
   RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='PROBE_BANK_OR_RESERVE_CHANGED: '||name,
    DETAIL=jsonb_build_object('operation',operation,'event',event,
     'transaction_id',txid_current()::text,'isolation',current_setting('transaction_isolation'),
     'relation',name,'before',before_state->name,'inside',inside_state->name,
     'sequence_rollback_claimed',false,'production_settlement_complete',false)::text;
  END IF;
 END LOOP;
 FOR row_before IN SELECT value FROM jsonb_array_elements(before_state->'public.chip_ledger') LOOP
  SELECT value INTO row_after FROM jsonb_array_elements(inside_state->'public.chip_ledger') WHERE value->>'id'=row_before->>'id';
  IF row_after IS DISTINCT FROM row_before THEN RAISE EXCEPTION 'PROBE_ORIGINAL_JOURNAL_CHANGED'; END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(r),'[]'::jsonb) INTO added FROM jsonb_array_elements(inside_state->'public.chip_ledger') r
 WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(before_state->'public.chip_ledger') b WHERE b->>'id'=r->>'id');
 IF jsonb_array_length(added)<>1 OR added->0->>'from_type' IS DISTINCT FROM 'prize_liability'
 OR added->0->>'from_entity_id' IS DISTINCT FROM event::text OR added->0->>'category' IS DISTINCT FROM 'tournament_prize'
 OR added->0->>'to_type' IS DISTINCT FROM 'player_wallet' OR added->0->>'to_entity_id' IS DISTINCT FROM winner::text
 OR added->0->>'club_id' IS DISTINCT FROM funding_club::text OR (added->0->>'amount')::numeric IS DISTINCT FROM 200 THEN RAISE EXCEPTION 'PROBE_CANONICAL_PRIZE_JOURNAL'; END IF;
 IF jsonb_array_length(inside_state->'public.tournament_players')<>3 THEN RAISE EXCEPTION 'PROBE_ROSTER_CARDINALITY'; END IF;
 FOR row_after IN SELECT value FROM jsonb_array_elements(inside_state->'public.tournament_players') LOOP
  SELECT value INTO row_before FROM jsonb_array_elements(before_state->'public.tournament_players') WHERE value->>'id'=row_after->>'id';
  expected_amount:=CASE WHEN row_after->>'user_id'=winner::text THEN 200 ELSE 0 END;
  IF row_before IS NULL OR row_after->>'club_id' IS DISTINCT FROM funding_club::text
   OR (row_after->>'prize')::numeric IS DISTINCT FROM expected_amount
   OR row_after->>'status' IS DISTINCT FROM (CASE WHEN row_after->>'user_id'=winner::text THEN 'winner' ELSE 'eliminated' END)
   OR row_after->'terminal_closed_at' IS DISTINCT FROM terminal->'completed_at'
   OR (row_after->>'position')::integer IS DISTINCT FROM (CASE row_after->>'user_id'
    WHEN 'aef849b8-2906-4dc0-b108-251710e76d3c' THEN 1 WHEN '036f0b55-c601-4d09-982a-5294cf4ea15d' THEN 2 WHEN '72f2fedb-a5f9-4d10-b147-d92e18102d3f' THEN 3 END)
   OR (row_after-ARRAY['status','position','prize','terminal_closed_at']) IS DISTINCT FROM (row_before-ARRAY['status','position','prize','terminal_closed_at']) THEN RAISE EXCEPTION 'PROBE_ORIGINAL_PLACES_CHANGED'; END IF;
 END LOOP;
 IF jsonb_array_length(inside_state->'public.table_seats')<>3 THEN RAISE EXCEPTION 'PROBE_CHAIR_CARDINALITY'; END IF;
 FOR row_after IN SELECT value FROM jsonb_array_elements(inside_state->'public.table_seats') LOOP
  SELECT value INTO row_before FROM jsonb_array_elements(before_state->'public.table_seats') WHERE value->>'id'=row_after->>'id';
  IF row_before IS NULL OR row_after->>'status' IS DISTINCT FROM 'left'
   OR (row_after-ARRAY['left_at','status','leave_pending','is_sitting_out','is_away','sit_out_at','scheduled_leave_hands','updated_at','terminal_closed_at','active_game_scope','active_parent_key']) IS DISTINCT FROM (row_before-ARRAY['left_at','status','leave_pending','is_sitting_out','is_away','sit_out_at','scheduled_leave_hands','updated_at','terminal_closed_at','active_game_scope','active_parent_key'])
   OR row_after->'leave_pending' IS DISTINCT FROM 'false'::jsonb OR row_after->'is_sitting_out' IS DISTINCT FROM 'false'::jsonb
   OR row_after->'is_away' IS DISTINCT FROM 'false'::jsonb OR row_after->'sit_out_at' IS DISTINCT FROM 'null'::jsonb
   OR row_after->'scheduled_leave_hands' IS DISTINCT FROM 'null'::jsonb
   OR row_after->'terminal_closed_at' IS DISTINCT FROM terminal->'completed_at'
   OR row_after->'active_game_scope' IS DISTINCT FROM 'null'::jsonb OR row_after->'active_parent_key' IS DISTINCT FROM 'null'::jsonb
   OR row_after->'stack' IS DISTINCT FROM row_before->'stack'
   OR (row_before->>'left_at' IS NOT NULL AND row_after->'left_at' IS DISTINCT FROM row_before->'left_at')
   OR (row_before->>'left_at' IS NULL AND row_after->'left_at' IS DISTINCT FROM terminal->'completed_at') THEN RAISE EXCEPTION 'PROBE_CANONICAL_CHAIR_EXIT'; END IF;
 END LOOP;
 IF jsonb_array_length(inside_state->'public.tables')<>1 OR inside_state->'public.tables'->0->>'status' IS DISTINCT FROM 'closed'
 OR inside_state->'public.tables'->0->>'lifecycle' IS DISTINCT FROM 'closed'
 OR (inside_state->'public.tables'->0->>'current_players')::integer IS DISTINCT FROM 0
 OR inside_state->'public.tables'->0->'terminal_closed_at' IS DISTINCT FROM terminal->'completed_at'
 OR terminal->>'completed_at' IS NULL OR terminal->'settled_at' IS DISTINCT FROM terminal->'completed_at'
 OR (SELECT jsonb_agg(v ORDER BY v::text) FROM jsonb_array_elements(terminal->'source_seat_ids') v) IS DISTINCT FROM
    (SELECT jsonb_agg(r->'id' ORDER BY (r->'id')::text) FROM jsonb_array_elements(before_state->'public.table_seats') r)
 OR (terminal->>'source_seat_count')::integer IS DISTINCT FROM 3 OR (terminal->>'released_seat_count')::integer IS DISTINCT FROM 1
 OR terminal->'released_seat_ids' IS DISTINCT FROM '["fd0e0c3a-1efa-4262-8122-4c05e328f9ac"]'::jsonb THEN RAISE EXCEPTION 'PROBE_TERMINAL_CHAIR_RECEIPT'; END IF;
 RAISE EXCEPTION USING ERRCODE='PZ002', MESSAGE='FIRST_ARCHIVED_ROLLBACK_PROVED:'||operation::text,
 DETAIL=jsonb_build_object('operation',operation,'event',event,'response',response,'before',before_state,'inside',inside_state,
 'same_operation_replay_unchanged',true,'transaction_will_abort_now',true,'sequence_rollback_claimed',false,'production_settlement_complete',false)::text;
END
$probe$;
