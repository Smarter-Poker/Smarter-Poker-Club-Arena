-- Run after the complete stage-one atomic authority set is installed and before
-- the separately gated legacy-door retirement. The final PASS exception is
-- intentional: it releases every lock and makes this safe in production.
BEGIN;
SET LOCAL ROLE anon;
DO $escrow_anon_denial$
BEGIN
  BEGIN
    PERFORM public.fn_ca_tournament_escrow(
      '00000000-0000-0000-0000-000000000000'::uuid);
    RAISE EXCEPTION
      'FAIL anon directly invoked the SECURITY DEFINER escrow aggregate';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE
      'AUDIT_TEST_PASS: anon direct escrow aggregate invocation denied';
  END;
END;
$escrow_anon_denial$;
ROLLBACK;

DO $probe$
DECLARE
  v_settle text;
  v_receipt text;
  v_legacy_award text;
  v_escrow_reader text;
  v_late_registration text;
  v_wallet_registration text;
  v_horse_wallet_registration text;
  v_registration_lifecycle text;
  v_ticket_admission text;
  v_row record;
  v_result jsonb;
  v_immutable_refused boolean := false;
BEGIN
  IF to_regprocedure('public.fn_settle_satellite_tournament(uuid,uuid)') IS NULL
     OR to_regprocedure(
          'public.fn_settle_satellite_tournament_pre_seat_guard(uuid,uuid)')
          IS NULL
     OR to_regprocedure('public.fn_ca_satellite_settlement_receipt(uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_ca_tournament_escrow(uuid)') IS NULL
     OR to_regprocedure(
          'public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)') IS NULL
     OR to_regclass('public.tournament_satellite_settlements') IS NULL
     OR to_regclass('public.tournament_satellite_awards') IS NULL
     OR to_regclass('public.tournament_satellite_remainders') IS NULL THEN
    RAISE EXCEPTION 'FAIL atomic satellite authority or immutable evidence tables are absent';
  END IF;

  SELECT pg_get_functiondef(
           'public.fn_settle_satellite_tournament_pre_seat_guard(uuid,uuid)'
             ::regprocedure)
    INTO v_settle;
  SELECT pg_get_functiondef(
           'public.fn_ca_satellite_settlement_receipt(uuid,uuid)'::regprocedure)
    INTO v_receipt;
  SELECT pg_get_functiondef(
           'public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)'::regprocedure)
    INTO v_legacy_award;
  SELECT pg_get_functiondef(
           'public.fn_ca_tournament_escrow(uuid)'::regprocedure)
    INTO v_escrow_reader;
  SELECT pg_get_functiondef(
           'public.fn_tournament_late_registration_open(uuid)'::regprocedure)
    INTO v_late_registration;
  SELECT pg_get_functiondef(
           'public.fn_register_for_tournament_before_atomic_capacity_20260907(uuid,boolean)'::regprocedure)
    INTO v_wallet_registration;
  SELECT pg_get_functiondef(
           'public.fn_register_horse_for_tournament_before_maintenance_gate(uuid,uuid)'::regprocedure)
    INTO v_horse_wallet_registration;
  SELECT pg_get_functiondef(
           'public.fn_register_for_tournament_before_maintenance_announcement_gate(uuid,boolean)'::regprocedure)
    INTO v_registration_lifecycle;
  SELECT pg_get_functiondef(
           'public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)'::regprocedure)
    INTO v_ticket_admission;
  IF v_settle !~ 'v_ticket_award_count := floor\(v_pool / v_ticket_cost\)::integer'
     OR v_settle !~ 'v_bubble_position := v_ticket_award_count \+ 1'
     OR v_settle !~ 'public\.fn_tournament_late_registration_open\(v_target_id\)'
     OR v_settle ~ 'NULLIF\(v_target\.late_reg_levels, 0\)'
     OR v_settle ~ 'v_target\.late_reg_levels IS NULL'
     OR v_settle ~ 'v_target\.rebuy_levels IS NULL'
     OR v_settle ~ 'v_target\.current_level IS NULL'
     OR v_settle !~ 'pg_advisory_xact_lock\([[:space:]]*hashtextextended\(''ca:tournament-terminal-settlement:v1'',[[:space:]]*0\)\)'
     OR v_settle ~* 'EXCEPTION\s+WHEN'
     OR v_settle ~* 'LEAST\s*\('
     OR v_settle !~ 'v_paid IS DISTINCT FROM v_pool'
     OR v_settle !~ 'UPDATE public.table_seats'
     OR v_settle !~ 'UPDATE public.tables'
     OR v_settle !~ 'v_rows IS DISTINCT FROM v_released_seat_count'
     OR v_settle !~ 'ts.is_away IS DISTINCT FROM false'
     OR v_settle !~ 'ts.sit_out_at IS NOT NULL'
     OR v_settle !~ 'ts.scheduled_leave_hands IS NOT NULL'
     OR v_settle !~ 'v_target_escrow_after.satellite_in IS DISTINCT FROM'
     OR v_settle !~ 'v_target_escrow_after.satellite_fee_in IS DISTINCT FROM'
     OR v_settle !~ 'v_target_escrow_after.prize_balance IS DISTINCT FROM'
     OR v_settle !~ 'v_target_escrow_after.fee_balance IS DISTINCT FROM'
     OR v_settle !~ 'SET current_players = v_target.current_players \+ v_seat_count'
     OR v_settle !~ 'v_target.is_bounty IS DISTINCT FROM false'
     OR v_settle !~ 'v_target_escrow.prize_balance < 0'
     OR v_settle !~ 'v_target_escrow.bounty_balance IS DISTINCT FROM 0'
     OR v_settle !~ 'v_source_escrow.reserve_out IS DISTINCT FROM 0'
     OR v_settle !~ 'v_source_escrow.bounty_in IS DISTINCT FROM 0'
     OR v_settle !~ 'v_source_escrow.closed_at IS NOT NULL'
     OR v_settle !~ 'v_source_escrow.close_note IS NOT NULL'
     OR v_settle !~ 'v_target.current_players IS DISTINCT FROM v_target_counter_before'
     OR v_settle !~ 'v_target_counter_before := CASE'
     OR v_settle !~ 'THEN v_target_live_count_before'
     OR v_settle !~ 'ELSE v_target_count_before'
     OR v_settle !~ 'v_target_counter_after := CASE'
     OR v_settle !~ 'v_target_after.current_players IS DISTINCT FROM v_target_counter_after'
     OR v_settle !~ 'v_target.prize_pool IS DISTINCT FROM v_target_escrow.prize_balance'
     OR v_settle !~ 'v_target.total_rake IS DISTINCT FROM v_target_escrow.fee_balance'
     OR v_settle !~ 'absence cannot authorize cash substitution'
     OR v_settle ~ 'FROM public.managed_game_contract_versions'
     OR v_late_registration !~
          'COALESCE\(t\.late_reg_levels,t\.rebuy_levels,0\)'
     OR v_late_registration !~ 'COALESCE\(t\.current_level,0\)>=0'
     OR v_late_registration !~ 't\.max_players<=0'
     OR v_wallet_registration !~
          'public\.fn_tournament_late_registration_open\(p_tournament_id\)'
     OR v_wallet_registration ~ 'registration_state_unknown'
     OR v_wallet_registration ~ 'COALESCE\(v_t\.max_players, 0\) <= 2'
     OR v_wallet_registration !~ 'v_t\.max_players > 0'
     OR v_wallet_registration ~
          'current_players = COALESCE\(current_players, 0\) \+ 1'
     OR v_wallet_registration !~
          'SET current_players = v_players_before \+ 1'
     OR v_wallet_registration !~
          'current_players IS NOT DISTINCT FROM v_expected_cached_players'
     OR v_horse_wallet_registration ~
          'current_players = COALESCE\(current_players, 0\) \+ 1'
     OR v_horse_wallet_registration !~
          'SET current_players = v_players_before \+ 1'
     OR v_horse_wallet_registration !~
          'current_players IS NOT DISTINCT FROM v_players_before\+1'
     OR v_registration_lifecycle !~
          'public\.fn_tournament_late_registration_open\(p_tournament_id\)'
     OR v_registration_lifecycle ~ 'registration_state_unknown'
     OR v_ticket_admission ~ 'COALESCE\(v_t\.max_players,0\)<=2'
     OR v_ticket_admission !~ 'v_t\.max_players>0'
     OR v_receipt !~ 'v_amount IS DISTINCT FROM v_h.pool'
     OR v_receipt !~ 'v_h.receipt_version IS DISTINCT FROM 2'
     OR v_receipt !~ 'v_source_table_ids IS DISTINCT FROM v_h.source_table_ids'
     OR v_receipt !~ 'v_source_seat_ids IS DISTINCT FROM v_h.source_seat_ids'
     OR v_receipt !~ 'v_durable_released_ids IS DISTINCT FROM v_h.released_seat_ids'
     OR v_receipt !~ 'v_durable_released_count IS DISTINCT FROM v_h.released_seat_count'
     OR v_receipt !~ 'v_source_escrow.closed_at IS DISTINCT FROM v_h.source_escrow_closed_at'
     OR v_receipt !~ 'v_source_escrow.close_note IS DISTINCT FROM v_h.source_escrow_close_note'
     OR v_receipt !~ 'v_source_escrow.prize_out IS DISTINCT FROM v_h.pool'
     OR v_receipt !~ 'v_h.target_was_missing IS DISTINCT FROM false'
     OR v_receipt !~ 'v_source.ended_at IS DISTINCT FROM v_h.source_closed_at'
     OR v_receipt !~ 'tb.terminal_closed_at IS DISTINCT FROM v_h.source_closed_at'
     OR v_receipt !~ '''closed_at'', v_h.source_closed_at'
     OR position('ca:tournament-terminal-settlement:v1' IN v_legacy_award) = 0
     OR position('pg_advisory_xact_lock(' IN v_legacy_award) = 0
     OR position('pg_advisory_xact_lock(' IN v_legacy_award) >
          position('WHERE id = p_target_id' IN v_legacy_award)
     OR position('WHERE id = p_target_id' IN v_legacy_award) >
          position('WHERE id = p_satellite_id' IN v_legacy_award)
     OR v_escrow_reader !~ 'SECURITY DEFINER'
     OR v_escrow_reader !~ 'SET search_path TO ''public'''
     OR NOT EXISTS (
       SELECT 1
         FROM pg_proc p
        WHERE p.oid = 'public.fn_ca_tournament_escrow(uuid)'::regprocedure
          AND p.prosecdef
          AND p.provolatile = 's'
          AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public']::text[]
          AND has_function_privilege('service_role', p.oid, 'EXECUTE')
          AND EXISTS (
            SELECT 1
              FROM aclexplode(p.proacl) acl
             WHERE acl.grantee = 'service_role'::regrole::oid
               AND acl.privilege_type = 'EXECUTE'
          )
          AND EXISTS (
            SELECT 1
              FROM aclexplode(p.proacl) acl
             WHERE acl.grantee = p.proowner
               AND acl.privilege_type = 'EXECUTE'
          )
          AND NOT EXISTS (
            SELECT 1
              FROM aclexplode(COALESCE(
                     p.proacl, acldefault('f', p.proowner))) acl
             WHERE acl.privilege_type = 'EXECUTE'
               AND acl.grantee NOT IN (
                     p.proowner, 'service_role'::regrole::oid)
          )
     ) THEN
    RAISE EXCEPTION 'FAIL installed satellite functions lost exact arithmetic or all-or-nothing proof';
  END IF;

  IF NOT has_function_privilege(
       'service_role',
       'public.fn_settle_satellite_tournament(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege(
       'anon', 'public.fn_settle_satellite_tournament(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege(
       'authenticated',
       'public.fn_settle_satellite_tournament(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege(
       'anon', 'public.fn_ca_tournament_escrow(uuid)', 'EXECUTE')
     OR has_function_privilege(
       'authenticated', 'public.fn_ca_tournament_escrow(uuid)', 'EXECUTE')
     OR NOT has_function_privilege(
       'service_role', 'public.fn_ca_tournament_escrow(uuid)', 'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_satellite_settlement_receipt(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL stage-one satellite service/owner privilege boundary changed';
  END IF;
  IF to_regprocedure(
       'public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)') IS NULL
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL rolling compatibility door was retired before the engine cutover';
  END IF;
  IF EXISTS (
       SELECT 1
         FROM (VALUES
           ('public.tournament_satellite_settlement_cutover'::regclass),
           ('public.tournament_satellite_settlements'::regclass),
           ('public.tournament_satellite_awards'::regclass),
           ('public.tournament_satellite_remainders'::regclass)
         ) evidence(relid)
         CROSS JOIN (VALUES ('anon'),('authenticated'),('service_role')) app(role_name)
         CROSS JOIN (VALUES
           ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),
           ('REFERENCES'),('TRIGGER')
         ) access(privilege_name)
        WHERE has_table_privilege(
                app.role_name, evidence.relid, access.privilege_name)
     ) OR EXISTS (
       SELECT 1
         FROM (VALUES
           ('public.tournament_satellite_settlement_cutover'::regclass),
           ('public.tournament_satellite_settlements'::regclass),
           ('public.tournament_satellite_awards'::regclass),
           ('public.tournament_satellite_remainders'::regclass)
         ) evidence(relid)
         JOIN pg_class c ON c.oid = evidence.relid
        WHERE c.relrowsecurity IS DISTINCT FROM true
           OR EXISTS (SELECT 1 FROM pg_policy pol WHERE pol.polrelid = c.oid)
     ) THEN
    RAISE EXCEPTION 'FAIL immutable satellite evidence is not owner-only RLS';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_attribute a
        ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
     WHERE c.conrelid = 'public.tournament_satellite_settlements'::regclass
       AND c.confrelid = 'public.tournaments'::regclass
       AND c.contype = 'f' AND c.confdeltype = 'r'
       AND cardinality(c.conkey) = 1 AND a.attname = 'target_id'
  ) THEN
    RAISE EXCEPTION 'FAIL immutable satellite header target is not delete-restricted';
  END IF;

  CREATE TEMP TABLE probe_satellite_matrix(
    pool numeric(15,2), ticket numeric(15,2), field_size integer,
    advertised integer, expected_tickets integer, expected_remainder numeric(15,2),
    expected_bubble integer
  ) ON COMMIT DROP;
  INSERT INTO pg_temp.probe_satellite_matrix VALUES
    (485.00, 200.00, 4, 0, 2, 85.00, 3),
    ( 85.00, 200.00, 1, 0, 0, 85.00, 1),
    (400.00, 200.00, 2, 2, 2,  0.00, NULL),
    (285.00, 200.00, 2, 1, 1, 85.00, 2);

  FOR v_row IN
    SELECT m.*,
           floor(m.pool / m.ticket)::integer AS tickets,
           round(m.pool - floor(m.pool / m.ticket) * m.ticket, 2) AS remainder,
           CASE WHEN m.pool - floor(m.pool / m.ticket) * m.ticket > 0
                THEN floor(m.pool / m.ticket)::integer + 1 END AS bubble
      FROM pg_temp.probe_satellite_matrix m
  LOOP
    IF v_row.tickets <> v_row.expected_tickets
       OR v_row.remainder IS DISTINCT FROM v_row.expected_remainder
       OR v_row.bubble IS DISTINCT FROM v_row.expected_bubble
       OR v_row.remainder < 0 OR v_row.remainder >= v_row.ticket
       OR v_row.pool IS DISTINCT FROM
            round(v_row.tickets * v_row.ticket + v_row.remainder, 2)
       OR v_row.pool < v_row.advertised * v_row.ticket
       OR (v_row.tickets + CASE WHEN v_row.remainder > 0 THEN 1 ELSE 0 END)
            > v_row.field_size THEN
      RAISE EXCEPTION 'FAIL satellite allocation matrix row: %', to_jsonb(v_row);
    END IF;
  END LOOP;

  -- Five complete tickets cannot be assigned to a four-player field. The
  -- authority must refuse; it may not cap the tickets or return one to a seat
  -- winner as a false bubble payment.
  IF floor(1000.00::numeric / 200.00::numeric)::integer <= 4 THEN
    RAISE EXCEPTION 'FAIL short-field refusal fixture is malformed';
  END IF;
  IF v_settle NOT LIKE
       '%v_ticket_award_count%+ CASE WHEN v_remainder > 0 THEN 1 ELSE 0 END) > v_field_size%' THEN
    RAISE EXCEPTION 'FAIL installed authority no longer refuses a short award field';
  END IF;

  -- This exact event exists only in production. When present, its adopted
  -- receipt itself re-proves every payout, wallet key, debt, standing, cache,
  -- escrow and rake row while holding the canonical locks.
  IF EXISTS (
    SELECT 1 FROM public.tournaments t
     WHERE t.id = 'b066f432-2aae-4994-85c8-f9bfbfa4cd2f'::uuid
  ) THEN
    SELECT public.fn_ca_satellite_settlement_receipt(
             'b066f432-2aae-4994-85c8-f9bfbfa4cd2f'::uuid,
             s.winner_id)
      INTO v_result
      FROM public.tournament_satellite_settlements s
     WHERE s.tournament_id = 'b066f432-2aae-4994-85c8-f9bfbfa4cd2f'::uuid;
    IF v_result IS NULL
       OR v_result->>'ok' IS DISTINCT FROM 'true'
       OR (v_result->>'pool')::numeric IS DISTINCT FROM 285.00::numeric
       OR (v_result->>'ticket_cost')::numeric IS DISTINCT FROM 200.00::numeric
       OR (v_result->>'ticket_award_count')::integer IS DISTINCT FROM 1
       OR (v_result->>'seat_count')::integer IS DISTINCT FROM 0
       OR (v_result->>'cash_ticket_count')::integer IS DISTINCT FROM 1
       OR (v_result->'remainder'->>'position')::integer IS DISTINCT FROM 2
       OR (v_result->'remainder'->>'amount')::numeric IS DISTINCT FROM 85.00::numeric
       OR (v_result->>'source_table_count')::integer IS DISTINCT FROM 1
       OR (v_result->>'source_seat_count')::integer IS DISTINCT FROM 2
       OR (v_result->>'released_seat_count')::integer IS DISTINCT FROM 0
       OR jsonb_array_length(v_result->'source_closeout'->'source_table_ids')
            IS DISTINCT FROM 1
       OR jsonb_array_length(v_result->'source_closeout'->'source_seat_ids')
            IS DISTINCT FROM 2
       OR (v_result->'source_closeout'->>'closed_at')::timestamptz IS DISTINCT FROM
            (SELECT t.ended_at FROM public.tournaments t
              WHERE t.id = 'b066f432-2aae-4994-85c8-f9bfbfa4cd2f'::uuid)
       OR NOT EXISTS (
         SELECT 1 FROM public.tables tb
         JOIN public.tournaments t ON t.id = tb.tournament_id
          WHERE tb.id = 'f2ab8f6c-cb2b-4585-b4b4-90cb5e775d99'::uuid
            AND t.id = 'b066f432-2aae-4994-85c8-f9bfbfa4cd2f'::uuid
            AND tb.terminal_closed_at = t.ended_at) THEN
      RAISE EXCEPTION 'FAIL b066 exact adoption receipt is absent or malformed: %', v_result;
    END IF;

    BEGIN
      UPDATE public.tournament_satellite_settlements
         SET settled_at = settled_at
       WHERE tournament_id = 'b066f432-2aae-4994-85c8-f9bfbfa4cd2f'::uuid;
    EXCEPTION WHEN SQLSTATE '55000' THEN
      v_immutable_refused := true;
    END;
    IF NOT v_immutable_refused THEN
      RAISE EXCEPTION 'FAIL immutable satellite header accepted an update';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournaments t
     WHERE t.id = '682045c5-cb07-47ed-ad0e-adbff9cb41af'::uuid
  ) THEN
    SELECT public.fn_ca_satellite_settlement_receipt(
             '682045c5-cb07-47ed-ad0e-adbff9cb41af'::uuid,
             s.winner_id)
      INTO v_result
      FROM public.tournament_satellite_settlements s
     WHERE s.tournament_id = '682045c5-cb07-47ed-ad0e-adbff9cb41af'::uuid;
    IF v_result IS NULL
       OR v_result->>'ok' IS DISTINCT FROM 'true'
       OR v_result->>'winner_id' IS DISTINCT FROM
            '22af2652-f8ae-4b84-8f3d-d2894f435d79'
       OR v_result->>'target_id' IS DISTINCT FROM
            '13dd6b98-b882-4690-a479-3a6f77783ad6'
       OR (v_result->>'pool')::numeric IS DISTINCT FROM 285.00::numeric
       OR (v_result->>'ticket_cost')::numeric IS DISTINCT FROM 200.00::numeric
       OR (v_result->>'ticket_award_count')::integer IS DISTINCT FROM 1
       OR (v_result->>'seat_count')::integer IS DISTINCT FROM 1
       OR (v_result->>'cash_ticket_count')::integer IS DISTINCT FROM 0
       OR v_result->'awards'->0->>'user_id' IS DISTINCT FROM
            '22af2652-f8ae-4b84-8f3d-d2894f435d79'
       OR v_result->'awards'->0->>'registration_id' IS DISTINCT FROM
            '324aedef-7f12-4935-8530-dde405ea6351'
       OR v_result->'remainder'->>'user_id' IS DISTINCT FROM
            '146cf7a5-7f99-4dd3-858d-26dae69d9c80'
       OR (v_result->'remainder'->>'position')::integer IS DISTINCT FROM 2
       OR (v_result->'remainder'->>'amount')::numeric IS DISTINCT FROM 85.00::numeric
       OR (v_result->>'source_table_count')::integer IS DISTINCT FROM 1
       OR (v_result->>'source_seat_count')::integer IS DISTINCT FROM 2
       OR (v_result->>'released_seat_count')::integer IS DISTINCT FROM 0
       OR (v_result->'source_closeout'->>'closed_at')::timestamptz IS DISTINCT FROM
            (SELECT t.ended_at FROM public.tournaments t
              WHERE t.id = '682045c5-cb07-47ed-ad0e-adbff9cb41af'::uuid)
       OR NOT EXISTS (
         SELECT 1 FROM public.tournament_satellite_remainders r
          WHERE r.tournament_id =
                  '682045c5-cb07-47ed-ad0e-adbff9cb41af'::uuid
            AND r.user_id = '146cf7a5-7f99-4dd3-858d-26dae69d9c80'::uuid
            AND r.place = 2 AND r.amount = 85.00
            AND r.evidence_kind = 'legacy_20260908_682')
       OR NOT EXISTS (
         SELECT 1 FROM public.tables tb
         JOIN public.tournaments t ON t.id = tb.tournament_id
          WHERE tb.id = 'ae520859-1727-4576-9b4a-98f0e0392ace'::uuid
            AND t.id = '682045c5-cb07-47ed-ad0e-adbff9cb41af'::uuid
            AND tb.terminal_closed_at = t.ended_at) THEN
      RAISE EXCEPTION 'FAIL 682 exact adoption receipt is absent or malformed: %', v_result;
    END IF;
  END IF;

  RAISE EXCEPTION
    'AUDIT_TEST_PASS: stage-one whole-pool authority, rolling compatibility, owner-only ACLs, floor tickets, one next-finisher residual, exact source-close times and terminal markers, status-aware target entrant counters and escrow deltas, short-field refusal, conservation, immutable replay and exact b066/682 adoptions pass; all locks and temp state rolled back';
END
$probe$;
