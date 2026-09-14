-- The satellite authority and its broad DDL are installed during the quiet
-- maintenance freeze. The two audited historical events are adopted only
-- after that freeze opens, without carrying any of the schema migration's
-- relation locks. This closeout consumes both owner-only exact-event helpers
-- and removes them in the same transaction.

BEGIN;

SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '45s';
SET LOCAL transaction_timeout = '60s';

DO $complete_known_satellites_after_freeze$
DECLARE
  v_receipt jsonb;
BEGIN
  IF to_regclass('public.tournament_satellite_settlement_cutover') IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM public.tournament_satellite_settlement_cutover c
        WHERE c.authority = 'fn_settle_satellite_tournament:v2'
          AND c.migration_version = '20260909014421'
     ) THEN
    RAISE EXCEPTION
      'b066 closeout requires the committed satellite authority cutover first';
  END IF;

  IF to_regprocedure(
       'public.fn_ca_adopt_b066_satellite_remainder()') IS NULL
     OR to_regprocedure(
       'public.fn_ca_adopt_682_satellite_completion()') IS NULL THEN
    RAISE EXCEPTION
      'satellite closeout requires both owner-only exact-event helpers';
  END IF;

  -- Match the terminal writers' canonical order. The terminal boundary keeps
  -- another closeout from changing either event while this transaction makes
  -- its decision. The shared maintenance boundary makes the freeze check and
  -- every ensuing adoption one serialized unit: a maintenance owner cannot
  -- announce the next freeze until this transaction commits or rolls back.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM pg_advisory_xact_lock_shared(530090,1);

  IF public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION
      'satellite adoption closeout must run after the maintenance freeze'
      USING ERRCODE = '55006';
  END IF;

  IF EXISTS (
       SELECT 1 FROM public.tournaments t
        WHERE t.id = 'b066f432-2aae-4994-85c8-f9bfbfa4cd2f'::uuid
     ) AND NOT EXISTS (
       SELECT 1 FROM public.tournament_satellite_settlements s
        WHERE s.tournament_id =
              'b066f432-2aae-4994-85c8-f9bfbfa4cd2f'::uuid
     ) THEN
    v_receipt := public.fn_ca_adopt_b066_satellite_remainder();
  END IF;

  IF EXISTS (
       SELECT 1 FROM public.tournaments t
        WHERE t.id = '682045c5-cb07-47ed-ad0e-adbff9cb41af'::uuid
     ) AND NOT EXISTS (
       SELECT 1 FROM public.tournament_satellite_settlements s
        WHERE s.tournament_id =
              '682045c5-cb07-47ed-ad0e-adbff9cb41af'::uuid
     ) THEN
    PERFORM public.fn_ca_adopt_682_satellite_completion();
  END IF;

  IF EXISTS (
       SELECT 1 FROM public.tournaments t
        WHERE t.id = 'b066f432-2aae-4994-85c8-f9bfbfa4cd2f'::uuid
     ) THEN
    v_receipt := public.fn_ca_satellite_settlement_receipt(
      'b066f432-2aae-4994-85c8-f9bfbfa4cd2f'::uuid,
      '3d15bbe7-f752-4a49-be3a-079232d23b0f'::uuid);
    IF COALESCE((v_receipt->>'ok')::boolean, false) IS NOT TRUE
       OR COALESCE((v_receipt->>'fully_settled')::boolean, false) IS NOT TRUE
       OR (v_receipt->>'pool')::numeric IS DISTINCT FROM 285.00::numeric
       OR (v_receipt->>'ticket_award_count')::integer IS DISTINCT FROM 1
       OR (v_receipt->>'cash_ticket_count')::integer IS DISTINCT FROM 1
       OR (v_receipt->>'seat_count')::integer IS DISTINCT FROM 0
       OR (v_receipt->'remainder'->>'user_id')::uuid IS DISTINCT FROM
            'ed3f0662-8da7-4c24-b8d7-a1000d60cb1f'::uuid
       OR (v_receipt->'remainder'->>'position')::integer IS DISTINCT FROM 2
       OR (v_receipt->'remainder'->>'amount')::numeric IS DISTINCT FROM
            85.00::numeric THEN
      RAISE EXCEPTION
        'b066 closeout did not produce its exact immutable 285/200/85 receipt'
        USING ERRCODE = 'P0404';
    END IF;
  END IF;

  IF EXISTS (
       SELECT 1 FROM public.tournaments t
        WHERE t.id = '682045c5-cb07-47ed-ad0e-adbff9cb41af'::uuid
     ) THEN
    v_receipt := public.fn_ca_satellite_settlement_receipt(
      '682045c5-cb07-47ed-ad0e-adbff9cb41af'::uuid,
      '22af2652-f8ae-4b84-8f3d-d2894f435d79'::uuid);
    IF COALESCE((v_receipt->>'ok')::boolean, false) IS NOT TRUE
       OR COALESCE((v_receipt->>'fully_settled')::boolean, false) IS NOT TRUE
       OR (v_receipt->>'pool')::numeric IS DISTINCT FROM 285.00::numeric
       OR (v_receipt->>'ticket_award_count')::integer IS DISTINCT FROM 1
       OR (v_receipt->>'cash_ticket_count')::integer IS DISTINCT FROM 0
       OR (v_receipt->>'seat_count')::integer IS DISTINCT FROM 1
       OR (v_receipt->'remainder'->>'user_id')::uuid IS DISTINCT FROM
            '146cf7a5-7f99-4dd3-858d-26dae69d9c80'::uuid
       OR (v_receipt->'remainder'->>'position')::integer IS DISTINCT FROM 2
       OR (v_receipt->'remainder'->>'amount')::numeric IS DISTINCT FROM
            85.00::numeric THEN
      RAISE EXCEPTION
        '682 closeout did not produce its exact immutable 285/200/85 receipt'
        USING ERRCODE = 'P0404';
    END IF;
  END IF;
END;
$complete_known_satellites_after_freeze$;

DROP FUNCTION public.fn_ca_adopt_b066_satellite_remainder();
DROP FUNCTION public.fn_ca_adopt_682_satellite_completion();

DO $prove_satellite_adoption_helpers_retired$
BEGIN
  IF to_regprocedure(
       'public.fn_ca_adopt_b066_satellite_remainder()') IS NOT NULL
     OR to_regprocedure(
       'public.fn_ca_adopt_682_satellite_completion()') IS NOT NULL THEN
    RAISE EXCEPTION 'one-time satellite adoption helper survived closeout';
  END IF;
END;
$prove_satellite_adoption_helpers_retired$;

COMMIT;
