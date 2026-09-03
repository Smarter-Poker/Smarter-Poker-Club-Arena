-- ============================================================================
-- 20260822210000_spin_reserve_wallet_fund_op.sql
-- TIER: 3  |  AFFECTS: money movement (union_wallets.spin_reserve_wallet)
--             NEW: public.fn_spin_reserve_wallet_fund_op
--             CHANGED: unique index uq_union_wallet_tx_op (tx_type list)
--
-- WHY
--
-- fn_spin_reserve_wallet_fund moves capital into the Spin reserve wallet and
-- has no replay protection at all. It is currently reachable only by someone
-- typing SQL, which is why that has not mattered. The union wallet UI is about
-- to put it behind a button, and a button is retried: by an impatient operator,
-- by a serverless cold start, by a browser that resent the POST. Each retry is
-- a second real credit and a second real debit of the source wallet.
--
-- Every other money action on /api/club-arena/union-wallet already defends
-- against this the same way: the caller supplies an op id, the RPC writes it to
-- union_wallet_transactions.period_id, and the partial unique index
-- uq_union_wallet_tx_op refuses the second write. That is the mechanism added
-- after the BBJ double-payout. This migration puts the Spin reserve fund on it
-- rather than inventing a second one.
--
-- WHAT
--
--   1. uq_union_wallet_tx_op gains 'spin_reserve_wallet_fund' in its tx_type
--      list. The index is partial on period_id IS NOT NULL, so every existing
--      row (all of which have period_id NULL for this tx_type) is unaffected
--      and no backfill is required.
--
--   2. fn_spin_reserve_wallet_fund_op wraps the existing function, claims the
--      op id on the ledger row it wrote, and returns a friendly
--      {ok:false, duplicate:true} on a replay.
--
--      Exactly ONE row claims the op id: the credit into the reserve, which is
--      the movement being made idempotent. The first version of this function
--      stamped both rows the inner call writes - the credit and the matching
--      debit out of the source wallet - and they collided with each other on
--      (union_id, tx_type, period_id) inside a single statement. Every genuine
--      fund tripped its own replay guard and reported itself a duplicate. The
--      behavioural check at the bottom of this file is what found it, before
--      any caller existed. The debit belongs to the same transaction and rolls
--      back with it, so it needs no claim of its own.
--
--      The row to stamp is found by excluding every unstamped row that existed
--      before the call, not by taking the most recent one: this wallet can
--      accumulate unstamped rows from operator SQL, and adopting one of those
--      would claim the op id against money this call never moved.
--
--      The whole body sits inside ONE exception block on purpose. A unique
--      violation raised from the stamping UPDATE aborts back to the start of
--      that block, which undoes the fund call as well - the money move and the
--      claim on the op id either both happen or neither does. Catching the
--      violation in a nested block AFTER calling the inner function would have
--      left the credit standing and reported a duplicate, which is the exact
--      failure this exists to prevent.
--
--      The inner fn_spin_reserve_wallet_fund is left untouched and keeps its
--      signature. Dropping and recreating it to add a parameter would have
--      changed a live money function's identity for no gain.
--
--   3. p_from_wallet is REQUIRED here. The inner function treats NULL as an
--      operator deposit, which mints chips into the reserve from nothing. That
--      is a legitimate platform-admin operation over SQL and is not something a
--      union lead should reach through an HTTP endpoint, so the op-scoped
--      wrapper the API calls refuses it.
--
-- ROLLBACK
--
--   DROP FUNCTION IF EXISTS public.fn_spin_reserve_wallet_fund_op(
--     uuid, numeric, text, text, uuid, uuid);
--
--   DROP INDEX IF EXISTS public.uq_union_wallet_tx_op;
--   CREATE UNIQUE INDEX uq_union_wallet_tx_op
--     ON public.union_wallet_transactions
--     USING btree (union_id, tx_type, period_id)
--     WHERE ((period_id IS NOT NULL) AND (tx_type = ANY (ARRAY[
--       'bbj_payout'::text, 'manual_transfer'::text, 'rake_to_chips'::text,
--       'owner_deposit'::text, 'clawback'::text, 'bbj_fund'::text])));
--
--   Rolling the index back is only safe while no spin_reserve_wallet_fund row
--   holds a non-null period_id, or after those rows are cleared.
-- ============================================================================

-- ── Pre-flight: the things this migration assumes ───────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_spin_reserve_wallet_fund'
  ) THEN
    RAISE EXCEPTION 'fn_spin_reserve_wallet_fund does not exist - nothing to wrap';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'union_wallets'
       AND column_name = 'spin_reserve_wallet'
  ) THEN
    RAISE EXCEPTION 'union_wallets.spin_reserve_wallet does not exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'uq_union_wallet_tx_op'
  ) THEN
    RAISE EXCEPTION 'uq_union_wallet_tx_op is missing - the replay guard this migration extends is gone';
  END IF;

  -- Extending a partial unique index can only fail on data that already
  -- violates it. Prove there is none before touching the index.
  IF EXISTS (
    SELECT 1 FROM public.union_wallet_transactions
     WHERE tx_type = 'spin_reserve_wallet_fund' AND period_id IS NOT NULL
     GROUP BY union_id, tx_type, period_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'existing spin_reserve_wallet_fund rows already collide on (union_id, period_id)';
  END IF;
END $$;

-- ── 1. The replay guard learns about this tx_type ───────────────────────────
DROP INDEX IF EXISTS public.uq_union_wallet_tx_op;

CREATE UNIQUE INDEX uq_union_wallet_tx_op
  ON public.union_wallet_transactions
  USING btree (union_id, tx_type, period_id)
  WHERE ((period_id IS NOT NULL) AND (tx_type = ANY (ARRAY[
    'bbj_payout'::text,
    'manual_transfer'::text,
    'rake_to_chips'::text,
    'owner_deposit'::text,
    'clawback'::text,
    'bbj_fund'::text,
    'spin_reserve_wallet_fund'::text])));

-- ── 2. The op-scoped wrapper ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_spin_reserve_wallet_fund_op(
  p_union_id   uuid,
  p_amount     numeric,
  p_from_wallet text,
  p_note       text,
  p_op_id      uuid,
  p_created_by uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_res     jsonb;
  v_before  uuid[];
  v_target  uuid;
  v_stamped int;
BEGIN
  IF p_op_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'op_id_required');
  END IF;

  -- The inner function accepts NULL as "mint it", which no HTTP caller may do.
  IF p_from_wallet IS NULL OR p_from_wallet NOT IN ('promo_wallet', 'rake_wallet', 'chip_balance') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'source_wallet_required',
      'allowed', jsonb_build_array('promo_wallet', 'rake_wallet', 'chip_balance'));
  END IF;

  BEGIN
    SELECT COALESCE(array_agg(id), '{}'::uuid[]) INTO v_before
      FROM public.union_wallet_transactions
     WHERE union_id = p_union_id
       AND tx_type  = 'spin_reserve_wallet_fund'
       AND wallet   = 'spin_reserve_wallet'
       AND period_id IS NULL;

    v_res := public.fn_spin_reserve_wallet_fund(p_union_id, p_amount, p_from_wallet, p_note);

    -- A business refusal (bad amount, insufficient funds) moved nothing and
    -- claims no op id, so it is returned as-is and may be retried.
    IF COALESCE((v_res ->> 'ok')::boolean, false) IS NOT TRUE THEN
      RETURN v_res;
    END IF;

    SELECT id INTO v_target
      FROM public.union_wallet_transactions
     WHERE union_id  = p_union_id
       AND tx_type   = 'spin_reserve_wallet_fund'
       AND wallet    = 'spin_reserve_wallet'
       AND direction = 'credit'
       AND period_id IS NULL
       AND NOT (id = ANY (v_before))
     ORDER BY created_at DESC, id DESC
     LIMIT 1;

    IF v_target IS NULL THEN
      RAISE EXCEPTION 'spin reserve fund wrote no credit row for op %', p_op_id;
    END IF;

    UPDATE public.union_wallet_transactions t
       SET period_id  = p_op_id,
           created_by = COALESCE(p_created_by, t.created_by)
     WHERE t.id = v_target;
    GET DIAGNOSTICS v_stamped = ROW_COUNT;

    RETURN v_res || jsonb_build_object('op_id', p_op_id, 'ledger_rows', v_stamped);
  EXCEPTION
    WHEN unique_violation THEN
      -- Everything above, credit and debit included, rolls back to the start
      -- of this block. The original operation still stands.
      RETURN jsonb_build_object('ok', false, 'duplicate', true,
        'reason', 'already_processed', 'op_id', p_op_id);
  END;
END;
$fn$;

COMMENT ON FUNCTION public.fn_spin_reserve_wallet_fund_op(uuid, numeric, text, text, uuid, uuid) IS
  'Replay-safe entry point for funding a union Spin reserve wallet. Wraps fn_spin_reserve_wallet_fund, claims the op id on the ledger rows via uq_union_wallet_tx_op, and rolls the whole move back on a duplicate. Requires a real source wallet - it will not mint.';

REVOKE ALL ON FUNCTION public.fn_spin_reserve_wallet_fund_op(uuid, numeric, text, text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_spin_reserve_wallet_fund_op(uuid, numeric, text, text, uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_reserve_wallet_fund_op(uuid, numeric, text, text, uuid, uuid) TO service_role;

-- ── 3. Post-apply assertions ────────────────────────────────────────────────
DO $$
DECLARE v_def text;
BEGIN
  SELECT indexdef INTO v_def FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'uq_union_wallet_tx_op';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'uq_union_wallet_tx_op was dropped and not recreated';
  END IF;
  IF v_def NOT LIKE '%spin_reserve_wallet_fund%' THEN
    RAISE EXCEPTION 'uq_union_wallet_tx_op does not cover spin_reserve_wallet_fund';
  END IF;
  IF v_def NOT LIKE '%bbj_payout%' OR v_def NOT LIKE '%clawback%' OR v_def NOT LIKE '%bbj_fund%'
     OR v_def NOT LIKE '%manual_transfer%' OR v_def NOT LIKE '%rake_to_chips%'
     OR v_def NOT LIKE '%owner_deposit%' THEN
    RAISE EXCEPTION 'uq_union_wallet_tx_op lost a tx_type it used to guard: %', v_def;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_spin_reserve_wallet_fund_op'
  ) THEN
    RAISE EXCEPTION 'fn_spin_reserve_wallet_fund_op was not created';
  END IF;

  -- anon and authenticated must not be able to move reserve capital.
  IF has_function_privilege('anon', 'public.fn_spin_reserve_wallet_fund_op(uuid, numeric, text, text, uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_spin_reserve_wallet_fund_op(uuid, numeric, text, text, uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_spin_reserve_wallet_fund_op is executable by a client role';
  END IF;
END $$;

-- ============================================================================
-- APPLY HISTORY
--
-- Applied to production 2026-08-22 in two steps, because the first was wrong:
--
--   spin_reserve_wallet_fund_op              the index + the first function
--   spin_reserve_wallet_fund_op_stamp_one_row  the corrected function body
--
-- This file carries the corrected version. Nothing was ever broken by the
-- first: fn_spin_reserve_wallet_fund_op had no caller in any repo at the time,
-- and union_wallet_transactions held zero spin_reserve_wallet_fund rows.
--
-- BEHAVIOURAL CHECK, run against production inside a transaction that was then
-- rolled back by RAISE. This is what caught the stamping collision, and what
-- proves the correction. Re-run it if you change anything above.
--
--   no op id                -> {ok:false, reason:op_id_required}
--   NULL source wallet      -> {ok:false, reason:source_wallet_required}
--   fund 100 from promo     -> {ok:true, ledger_rows:1, spin_reserve_wallet:100}
--                              1 row stamped with the op id, 1 debit row
--                              promo 20881.30 -> 20781.30, reserve 0 -> 100
--   SAME op id again        -> {ok:false, duplicate:true}
--                              promo 20781.30, reserve 100 - both UNCHANGED
--   fund 250, new op id     -> {ok:true}  reserve 100 -> 350
--   fund 999,999,999        -> {ok:false, reason:insufficient_union_funds,
--                                available:20531.30, requested:999999999}
--
-- The replay case is the one that matters: it returns a duplicate AND leaves
-- both balances where they were. A guard that reports a duplicate after the
-- money has moved is worse than no guard, because it reads as if it worked.
-- ============================================================================
