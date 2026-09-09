-- 20260909163827_diamond_custody_release_is_atomic_without_recovery.sql
--
-- Diamond custody release is one database transaction. A refused credit now
-- raises and rolls back the lot release, wallet journal, custody balance and
-- movement together. There is no pending state, watcher, reconciler, recovery
-- sweep or second writer. The first migration revoked every entry point; this
-- migration runs only after that boundary has drained and its zero-row proof
-- still holds.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

SELECT pg_advisory_xact_lock(
  hashtextextended('poker_diamond_custody_cutover', 0)
);

LOCK TABLE
  public.profiles,
  public.poker_diamond_custody,
  public.poker_diamond_movements,
  public.poker_diamond_lot_reservations,
  public.poker_diamond_obligations,
  public.diamond_purchase_lots,
  public.diamond_transactions,
  public.ca_mint_ledger
IN SHARE ROW EXCLUSIVE MODE;

DO $drained_preflight$
DECLARE
  v_proc regprocedure;
BEGIN
  FOREACH v_proc IN ARRAY ARRAY[
    'public.fn_poker_diamond_reserve(uuid,text,uuid,text,numeric,uuid)'::regprocedure,
    'public.fn_poker_diamond_release(uuid,uuid)'::regprocedure,
    'public.fn_poker_diamond_reconcile()'::regprocedure,
    'public.fn_poker_diamond_recover_releases()'::regprocedure
  ] LOOP
    IF has_function_privilege('service_role', v_proc, 'EXECUTE')
       OR has_function_privilege('authenticated', v_proc, 'EXECUTE')
       OR has_function_privilege('anon', v_proc, 'EXECUTE') THEN
      RAISE EXCEPTION '% was not sealed by 20260909163809', v_proc;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM public.poker_diamond_custody)
     OR EXISTS (SELECT 1 FROM public.poker_diamond_movements)
     OR EXISTS (SELECT 1 FROM public.poker_diamond_lot_reservations)
     OR EXISTS (SELECT 1 FROM public.poker_diamond_obligations) THEN
    RAISE EXCEPTION
      'Diamond custody changed during the drain boundary; stop and audit every row';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_stat_activity
     WHERE pid <> pg_backend_pid()
       AND state <> 'idle'
       AND (
         query ILIKE '%fn_poker_diamond_reserve%'
         OR query ILIKE '%fn_poker_diamond_release%'
         OR query ILIKE '%fn_poker_diamond_reconcile%'
         OR query ILIKE '%fn_poker_diamond_recover_releases%'
       )
  ) THEN
    RAISE EXCEPTION 'A Diamond custody caller is still active after the sealed drain boundary';
  END IF;
END;
$drained_preflight$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_release(
  p_custody_id uuid,
  p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_owner uuid;
  v_c public.poker_diamond_custody%ROWTYPE;
  v_prev public.poker_diamond_movements%ROWTYPE;
  v_request jsonb;
  v_credit jsonb;
  v_receipt jsonb;
  v_lot record;
  v_debt_journal uuid;
BEGIN
  IF p_custody_id IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'invalid_diamond_release' USING ERRCODE = '22023';
  END IF;

  SELECT user_id INTO v_owner
    FROM public.poker_diamond_custody
   WHERE id = p_custody_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'diamond_custody_not_found';
  END IF;

  -- The wallet always locks before its custody, exactly as reserve does.
  PERFORM id FROM public.profiles WHERE id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_not_found';
  END IF;
  SELECT * INTO v_c
    FROM public.poker_diamond_custody
   WHERE id = p_custody_id
   FOR UPDATE;

  v_request := jsonb_build_object(
    'action', 'release',
    'custody_id', p_custody_id,
    'user_id', v_owner
  );

  SELECT * INTO v_prev
    FROM public.poker_diamond_movements
   WHERE request_id = p_request_id;
  IF FOUND THEN
    IF v_prev.request <> v_request THEN
      RAISE EXCEPTION 'idempotency_payload_mismatch';
    END IF;
    RETURN v_prev.receipt;
  END IF;

  IF v_c.state = 'released' THEN
    RAISE EXCEPTION 'diamond_custody_already_released';
  END IF;
  IF v_c.state <> 'reserved' THEN
    RAISE EXCEPTION 'diamond_custody_requires_settlement';
  END IF;

  FOR v_lot IN
    SELECT l.id, r.amount
      FROM public.poker_diamond_lot_reservations r
      JOIN public.diamond_purchase_lots l ON l.id = r.lot_id
     WHERE r.custody_id = p_custody_id
       AND r.released_at IS NULL
     ORDER BY l.created_at, l.id
     FOR UPDATE OF l
  LOOP
    UPDATE public.diamond_purchase_lots
       SET arena_reserved = arena_reserved - v_lot.amount
     WHERE id = v_lot.id;
  END LOOP;

  UPDATE public.poker_diamond_lot_reservations
     SET released_at = now()
   WHERE custody_id = p_custody_id
     AND released_at IS NULL;

  v_credit := public.add_diamonds_to_balance(
    v_owner,
    v_c.balance::integer,
    'arena_withdraw',
    'Released Poker Arena reservation',
    'poker-release:' || p_custody_id || ':' || p_request_id
  );
  IF (v_credit->>'success')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'diamond_release_credit_failed:%', v_credit->>'error';
  END IF;

  IF COALESCE((v_credit->>'debt_settled')::bigint, 0) > 0 THEN
    SELECT id INTO v_debt_journal
      FROM public.diamond_transactions
     WHERE user_id = v_owner
       AND reference_id = 'debt-settlement:' || (v_credit->>'transaction_id')
       AND type = 'debt_settlement'
       AND amount = -(v_credit->>'debt_settled')::bigint;
    IF v_debt_journal IS NULL THEN
      RAISE EXCEPTION 'diamond_debt_journal_missing';
    END IF;

    PERFORM public.fn_ca_register_diamond_journal_row(v_debt_journal);
    IF NOT EXISTS (
      SELECT 1
        FROM public.ca_mint_ledger
       WHERE diamond_tx_id = v_debt_journal
         AND action = 'burn'
         AND asset = 'diamonds'
         AND holder_type = 'player'
         AND holder_id = v_owner
         AND amount = (v_credit->>'debt_settled')::bigint
    ) THEN
      RAISE EXCEPTION 'diamond_debt_retirement_missing';
    END IF;
  END IF;

  UPDATE public.poker_diamond_custody
     SET balance = 0,
         state = 'released',
         released_at = now()
   WHERE id = p_custody_id;

  v_receipt := jsonb_build_object(
    'success', true,
    'custody_id', p_custody_id,
    'request_id', p_request_id,
    'amount', v_c.balance,
    'available_balance', (v_credit->>'new_balance')::bigint,
    'custody_balance', 0,
    'debt_settled', (v_credit->>'debt_settled')::bigint,
    'journal_id', v_credit->>'transaction_id'
  );

  INSERT INTO public.poker_diamond_movements(
    request_id, custody_id, user_id, action, amount,
    source_account, destination_account, wallet_journal_id, request, receipt
  ) VALUES (
    p_request_id, p_custody_id, v_owner, 'release', v_c.balance,
    'arena_custody:' || p_custody_id, 'player:' || v_owner,
    (v_credit->>'transaction_id')::uuid, v_request, v_receipt
  );

  RETURN v_receipt;
END;
$fn$;

REVOKE ALL ON FUNCTION
  public.fn_poker_diamond_release(uuid,uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.fn_poker_diamond_release(uuid,uuid)
TO service_role;

-- Reserve was sealed only to create a real drain boundary. It is already one
-- atomic transaction and can reopen once release no longer owns a retry rail.
REVOKE ALL ON FUNCTION
  public.fn_poker_diamond_reserve(uuid,text,uuid,text,numeric,uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.fn_poker_diamond_reserve(uuid,text,uuid,text,numeric,uuid)
TO service_role;

DROP FUNCTION public.fn_poker_diamond_recover_releases();
DROP FUNCTION public.fn_poker_diamond_reconcile();
DROP TABLE public.poker_diamond_obligations;

-- These are operator and engine accounting reads. State their source-level
-- ACL explicitly so no historical CREATE OR REPLACE can rely on a preserved
-- live ACL that a branch gate cannot see.
REVOKE ALL ON FUNCTION public.fn_ca_arena_diamonds()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_arena_diamonds()
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_register_vs_supply()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_register_vs_supply()
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_trial_balance(timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_trial_balance(timestamptz)
  TO service_role;

UPDATE public.ca_money_rpc_registry
   SET status = 'approved',
       notes = 'Diamond Poker custody release is one strict transaction. A failure rolls every rail back; no obligation, watcher, reconciliation scan or recovery writer exists.'
 WHERE proname = 'fn_poker_diamond_release';
UPDATE public.ca_money_rpc_registry
   SET status = 'retired',
       notes = 'Removed after the zero-row Diamond custody cutover. Atomic reserve/release need no recovery fleet.'
 WHERE proname IN (
   'fn_poker_diamond_recover_releases',
   'fn_poker_diamond_reconcile'
 );

COMMENT ON FUNCTION public.fn_poker_diamond_release(uuid,uuid) IS
  'Service-only Diamond Poker custody release. Wallet, lot reservations, custody, movement and debt retirement commit together or all roll back. Request replay returns the immutable movement receipt.';

DO $postcondition$
DECLARE
  v_source text;
BEGIN
  IF to_regprocedure('public.fn_poker_diamond_recover_releases()') IS NOT NULL
     OR to_regprocedure('public.fn_poker_diamond_reconcile()') IS NOT NULL
     OR to_regclass('public.poker_diamond_obligations') IS NOT NULL THEN
    RAISE EXCEPTION 'Diamond retry or reconciliation machinery survived retirement';
  END IF;

  SELECT prosrc INTO v_source
    FROM pg_proc
   WHERE oid = 'public.fn_poker_diamond_release(uuid,uuid)'::regprocedure;
  IF v_source IS NULL
     OR v_source ~* 'obligation|pending|recover|reconcil'
     OR position('RAISE EXCEPTION ''diamond_release_credit_failed:' IN v_source) = 0
     OR position('INSERT INTO public.poker_diamond_movements' IN v_source) = 0 THEN
    RAISE EXCEPTION 'Atomic Diamond release body failed its root-cause proof';
  END IF;

  IF NOT has_function_privilege(
       'service_role',
       'public.fn_poker_diamond_release(uuid,uuid)',
       'EXECUTE')
     OR has_function_privilege(
       'authenticated',
       'public.fn_poker_diamond_release(uuid,uuid)',
       'EXECUTE')
     OR has_function_privilege(
       'anon',
       'public.fn_poker_diamond_release(uuid,uuid)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'Atomic Diamond release ACL is not service-only';
  END IF;
END;
$postcondition$;

COMMIT;
