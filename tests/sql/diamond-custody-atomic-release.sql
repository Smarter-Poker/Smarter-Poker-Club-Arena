\set ON_ERROR_STOP on

-- Isolated PostgreSQL regression fixture. This must never be run against live
-- data: it creates synthetic financial rows inside a transaction and rolls the
-- entire fixture back after proving both the commit and refusal paths.
BEGIN;
SET LOCAL session_replication_role = replica;

INSERT INTO auth.users(id)
VALUES
  ('d1a10000-0000-4000-8000-000000000001'),
  ('d1a10000-0000-4000-8000-000000000002');

INSERT INTO public.profiles(id, diamonds)
VALUES
  ('d1a10000-0000-4000-8000-000000000001', 0),
  ('d1a10000-0000-4000-8000-000000000002', 0);

INSERT INTO public.diamond_purchase_lots(
  id, user_id, purchase_id, issued, consumed, refunded, arena_reserved, created_at
) VALUES
  (
    'd1a20000-0000-4000-8000-000000000001',
    'd1a10000-0000-4000-8000-000000000001',
    'd1a30000-0000-4000-8000-000000000001',
    10, 0, 0, 10, now() - interval '30 days'
  ),
  (
    'd1a20000-0000-4000-8000-000000000002',
    'd1a10000-0000-4000-8000-000000000002',
    'd1a30000-0000-4000-8000-000000000002',
    10, 0, 0, 10, now() - interval '30 days'
  );

INSERT INTO public.poker_diamond_custody(
  id, user_id, arena_id, purpose, target_id, entry_key, balance, state
) SELECT
  fixture.custody_id,
  fixture.user_id,
  settings.club_id,
  'tournament_entry',
  fixture.target_id,
  fixture.entry_key,
  10,
  'reserved'
FROM public.ca_arena_settings settings
CROSS JOIN (VALUES
  (
    'd1a40000-0000-4000-8000-000000000001'::uuid,
    'd1a10000-0000-4000-8000-000000000001'::uuid,
    'd1a50000-0000-4000-8000-000000000001'::uuid,
    'atomic-success'
  ),
  (
    'd1a40000-0000-4000-8000-000000000002'::uuid,
    'd1a10000-0000-4000-8000-000000000002'::uuid,
    'd1a50000-0000-4000-8000-000000000002'::uuid,
    'atomic-refusal'
  )
) AS fixture(custody_id, user_id, target_id, entry_key)
WHERE settings.id = 1;

INSERT INTO public.poker_diamond_lot_reservations(custody_id, lot_id, amount)
VALUES
  (
    'd1a40000-0000-4000-8000-000000000001',
    'd1a20000-0000-4000-8000-000000000001',
    10
  ),
  (
    'd1a40000-0000-4000-8000-000000000002',
    'd1a20000-0000-4000-8000-000000000002',
    10
  );

-- Force add_diamonds_to_balance to return its duplicate-reference refusal
-- after the release has already touched its lot rows. The outer release must
-- raise, causing PostgreSQL to undo those preceding writes automatically.
INSERT INTO public.diamond_transactions(
  user_id, type, transaction_type, amount, balance_after, reference_id
) VALUES (
  'd1a10000-0000-4000-8000-000000000002',
  'test_fixture',
  'test_fixture',
  0,
  0,
  'poker-release:d1a40000-0000-4000-8000-000000000002:d1a60000-0000-4000-8000-000000000002'
);

SET LOCAL session_replication_role = origin;

DO $probe$
DECLARE
  v_receipt jsonb;
  v_refused boolean := false;
BEGIN
  v_receipt := public.fn_poker_diamond_release(
    'd1a40000-0000-4000-8000-000000000001',
    'd1a60000-0000-4000-8000-000000000001'
  );
  IF (v_receipt->>'success')::boolean IS DISTINCT FROM true
     OR (v_receipt->>'amount')::bigint <> 10 THEN
    RAISE EXCEPTION 'successful release returned the wrong receipt: %', v_receipt;
  END IF;

  IF (SELECT diamonds FROM public.profiles
       WHERE id = 'd1a10000-0000-4000-8000-000000000001') <> 10
     OR EXISTS (
       SELECT 1 FROM public.poker_diamond_custody
        WHERE id = 'd1a40000-0000-4000-8000-000000000001'
          AND (state <> 'released' OR balance <> 0 OR released_at IS NULL)
     )
     OR EXISTS (
       SELECT 1 FROM public.diamond_purchase_lots
        WHERE id = 'd1a20000-0000-4000-8000-000000000001'
          AND arena_reserved <> 0
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.poker_diamond_movements
        WHERE request_id = 'd1a60000-0000-4000-8000-000000000001'
          AND action = 'release'
          AND amount = 10
     ) THEN
    RAISE EXCEPTION 'successful release did not commit every custody rail';
  END IF;

  BEGIN
    PERFORM public.fn_poker_diamond_release(
      'd1a40000-0000-4000-8000-000000000002',
      'd1a60000-0000-4000-8000-000000000002'
    );
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'diamond_release_credit_failed:duplicate_reference%' THEN
        RAISE;
      END IF;
      v_refused := true;
  END;

  IF NOT v_refused
     OR (SELECT diamonds FROM public.profiles
         WHERE id = 'd1a10000-0000-4000-8000-000000000002') <> 0
     OR EXISTS (
       SELECT 1 FROM public.poker_diamond_custody
        WHERE id = 'd1a40000-0000-4000-8000-000000000002'
          AND (state <> 'reserved' OR balance <> 10 OR released_at IS NOT NULL)
     )
     OR EXISTS (
       SELECT 1 FROM public.diamond_purchase_lots
        WHERE id = 'd1a20000-0000-4000-8000-000000000002'
          AND arena_reserved <> 10
     )
     OR EXISTS (
       SELECT 1 FROM public.poker_diamond_lot_reservations
        WHERE custody_id = 'd1a40000-0000-4000-8000-000000000002'
          AND released_at IS NOT NULL
     )
     OR EXISTS (
       SELECT 1 FROM public.poker_diamond_movements
        WHERE request_id = 'd1a60000-0000-4000-8000-000000000002'
     ) THEN
    RAISE EXCEPTION 'refused release left a partial write behind';
  END IF;
END;
$probe$;

SELECT 'AUDIT_TEST_PASS: Diamond custody release commits every rail or none';
ROLLBACK;
