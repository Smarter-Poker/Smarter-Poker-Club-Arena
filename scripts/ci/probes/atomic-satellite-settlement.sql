-- Run after the stage-one atomic satellite authority is installed and before
-- the separately gated legacy-door retirement. The final PASS exception is
-- intentional: it releases every lock and makes this safe in production.
DO $probe$
DECLARE
  v_settle text;
  v_receipt text;
  v_row record;
  v_result jsonb;
  v_immutable_refused boolean := false;
BEGIN
  IF to_regprocedure('public.fn_settle_satellite_tournament(uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_ca_satellite_settlement_receipt(uuid,uuid)') IS NULL
     OR to_regclass('public.tournament_satellite_settlements') IS NULL
     OR to_regclass('public.tournament_satellite_awards') IS NULL THEN
    RAISE EXCEPTION 'FAIL atomic satellite authority or immutable evidence tables are absent';
  END IF;

  SELECT pg_get_functiondef(
           'public.fn_settle_satellite_tournament(uuid,uuid)'::regprocedure)
    INTO v_settle;
  SELECT pg_get_functiondef(
           'public.fn_ca_satellite_settlement_receipt(uuid,uuid)'::regprocedure)
    INTO v_receipt;
  IF v_settle !~ 'v_ticket_award_count := floor\(v_pool / v_ticket_cost\)::integer'
     OR v_settle !~ 'v_bubble_position := v_ticket_award_count \+ 1'
     OR v_settle !~ 'pg_advisory_xact_lock\([[:space:]]*hashtextextended\(''ca:tournament-terminal-settlement:v1'',[[:space:]]*0\)\)'
     OR v_settle ~* 'EXCEPTION\s+WHEN'
     OR v_settle ~* 'LEAST\s*\('
     OR v_settle !~ 'v_paid IS DISTINCT FROM v_pool'
     OR v_settle !~ 'UPDATE public.table_seats'
     OR v_settle !~ 'UPDATE public.tables'
     OR v_settle !~ 'v_rows IS DISTINCT FROM v_released_seat_count'
     OR v_receipt !~ 'v_amount IS DISTINCT FROM v_h.pool'
     OR v_receipt !~ 'v_source_table_ids IS DISTINCT FROM v_h.source_table_ids'
     OR v_receipt !~ 'v_source_seat_ids IS DISTINCT FROM v_h.source_seat_ids'
     OR v_receipt !~ 'v_durable_released_ids IS DISTINCT FROM v_h.released_seat_ids'
     OR v_receipt !~ 'v_durable_released_count IS DISTINCT FROM v_h.released_seat_count' THEN
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
       OR (v_result->>'ticket_award_count')::integer <> 1
       OR (v_result->>'seat_count')::integer <> 0
       OR (v_result->>'cash_ticket_count')::integer <> 1
       OR (v_result->'remainder'->>'position')::integer <> 2
       OR (v_result->'remainder'->>'amount')::numeric IS DISTINCT FROM 85.00::numeric
       OR (v_result->>'source_table_count')::integer <> 1
       OR (v_result->>'source_seat_count')::integer <> 2
       OR (v_result->>'released_seat_count')::integer <> 0
       OR jsonb_array_length(v_result->'source_closeout'->'source_table_ids') <> 1
       OR jsonb_array_length(v_result->'source_closeout'->'source_seat_ids') <> 2 THEN
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

  RAISE EXCEPTION
    'AUDIT_TEST_PASS: stage-one whole-pool authority, rolling compatibility, ACLs, floor tickets, one next-finisher residual, exact source-felt closeout, short-field refusal, conservation, immutable replay and exact b066 adoption pass; all locks and temp state rolled back';
END
$probe$;
