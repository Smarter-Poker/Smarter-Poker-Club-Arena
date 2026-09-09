-- 20260909062006_chips_are_two_decimals_on_the_addon_path
--
-- A CHIP IS TWO DECIMAL PLACES, EVERYWHERE IT IS STORED (#3358) - AND THE
-- ADD-ON PATH WAS THE ONE THAT NEVER GOT THE GUARD.
--
-- WHAT WAS WRONG. The client sizes a top-up as `Math.min(maxBuyIn - stack,
-- balance)` - a float subtraction, so `50 - 33.33` is 16.670000000000002 -
-- and that number went to `atomic_table_addon`, which stores it verbatim.
-- Measured on production 2026-09-09: 49 rows in `table_pending_addons` and
-- 62 in `table_addon_idempotency` carry a value where `amount <> round(
-- amount, 2)`, the most recent on 2026-09-07.
--
-- WHY IT MATTERS NOW. `fn_ca_process_hand_post_commit_obligations` (shipped
-- 2026-09-08) refuses a resolution receipt where
--
--     applied + refunded IS DISTINCT FROM amount
--
-- and `resolve_pending_addon` returns `ROUND(applied, 2)` with a `refunded`
-- derived from the UNROUNDED applied - so for a non-cent amount the two can
-- never sum back to it. **48 of those 49 rows fail that predicate today**,
-- across 10 distinct tables. All 49 are already resolved, so nothing is
-- wedged this minute; but if any hand's post-commit envelope ever names one,
-- that transaction raises deterministically, settlement retries it every few
-- seconds until the lease dies, and that table never deals another hand.
--
-- The engine's TypeScript now rounds (`ServerTableEngineSeating.addChips`),
-- and so do the three client callers and the `/addchips` handler. This is the
-- rest of the path: the two RPCs that accept the number, the function that
-- splits it, and the columns that store it. The guard already exists in 30+
-- money RPCs in this tree - `atomic_table_rebuy` got it on 2026-09-08 and its
-- two siblings did not, which is exactly how the class survived.
--
-- WHAT THIS CHANGES
--
--   1. `atomic_table_addon` and `atomic_table_buyin` refuse a non-cent amount
--      BEFORE claiming an idempotency receipt, so a rejected request does not
--      burn its key. Both are thin wrappers; the bodies are reproduced from
--      `pg_get_functiondef` as they stand on production today, with the guard
--      added as the first statement and nothing else touched.
--   2. `resolve_pending_addon` derives `refunded` from the stored amount and
--      the ROUNDED applied, so `applied + refunded = amount` by construction
--      for every input - including the historical dusty rows, which is what
--      makes the obligation check unable to wedge on one. The wallet credit
--      is rounded (the wallet column is numeric(20,2) and would round it
--      anyway); the receipt is exact.
--   3. NOT VALID CHECK constraints on the four unscaled columns, so a new bad
--      row cannot be written by any path, present or future. NOT VALID, and
--      deliberately not backfilled: those 111 rows are settled history, and
--      rewriting a settled record to make a number look tidy is forbidden
--      (CLAUDE.md 10.9).
--
-- ROLLBACK
--
--   ALTER TABLE public.table_pending_addons DROP CONSTRAINT table_pending_addons_amount_is_cents;
--   ALTER TABLE public.table_pending_addons DROP CONSTRAINT table_pending_addons_applied_is_cents;
--   ALTER TABLE public.table_pending_addons DROP CONSTRAINT table_pending_addons_refunded_is_cents;
--   ALTER TABLE public.table_addon_idempotency DROP CONSTRAINT table_addon_idempotency_amount_is_cents;
--   -- and re-apply the prior bodies from 20260904120000 / the live definitions.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The two doors that accept a chip amount
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.atomic_table_addon(
  p_user_id uuid,
  p_table_id uuid,
  p_amount numeric,
  p_apply_to_seat boolean DEFAULT true,
  p_idempotency_key text DEFAULT NULL::text
)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_request jsonb;
  v_response jsonb;
  v_balance numeric;
BEGIN
  -- A chip is two decimal places. Refused BEFORE the receipt claim, so a bad
  -- request cannot spend its idempotency key. See this migration's header.
  IF p_amount IS NULL OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'Chips Move In Hundredths At Most' USING ERRCODE = '22003';
  END IF;

  PERFORM pg_advisory_xact_lock_shared(530090, 1);

  v_request := jsonb_build_object(
    'door', 'atomic_table_addon',
    'user_id', p_user_id,
    'table_id', p_table_id,
    'amount', p_amount,
    'apply_to_seat', p_apply_to_seat
  );
  v_response := public.fn_claim_entry_purchase_receipt(
    'cash_addon', p_idempotency_key, v_request
  );
  IF NOT COALESCE((v_response->>'claimed')::boolean, false) THEN
    RETURN (v_response->'response'->>'balance')::numeric;
  END IF;
  IF p_idempotency_key IS NOT NULL AND length(btrim(p_idempotency_key)) > 0
     AND EXISTS (
       SELECT 1 FROM public.table_addon_idempotency k
        WHERE k.key = p_idempotency_key
     ) THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_RECEIPT_UNBOUND: this historical add-on key has no exact response receipt'
      USING ERRCODE = '55000';
  END IF;

  IF public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION
      'PLATFORM_FROZEN: scheduled maintenance has closed cash add-ons; no chips moved'
      USING ERRCODE = '55006', HINT = 'Retry after the maintenance break has ended.';
  END IF;
  PERFORM public.fn_assert_cash_chip_purchase_table(p_table_id);
  v_balance := public.atomic_table_addon_before_maintenance_announcement_gate(
    p_user_id, p_table_id, p_amount, p_apply_to_seat, p_idempotency_key
  );
  v_response := public.fn_record_entry_purchase_receipt(
    'cash_addon',
    p_idempotency_key,
    v_request,
    jsonb_build_object('balance', v_balance)
  );
  RETURN (v_response->>'balance')::numeric;
END;
$function$;

CREATE OR REPLACE FUNCTION public.atomic_table_buyin(
  p_user_id uuid,
  p_table_id uuid,
  p_seat_number integer,
  p_amount numeric,
  p_auto_rebuy boolean DEFAULT false,
  p_club_id uuid DEFAULT NULL::uuid,
  p_idempotency_key uuid DEFAULT NULL::uuid
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_request jsonb;
  v_replay jsonb;
BEGIN
  IF p_amount IS NULL OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'Chips Move In Hundredths At Most' USING ERRCODE = '22003';
  END IF;

  PERFORM pg_advisory_xact_lock_shared(530090, 1);

  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE = '28000';
  END IF;
  IF NOT public.fn_caller_is_engine()
     AND (auth.uid() IS NULL OR auth.uid() <> p_user_id) THEN
    RAISE EXCEPTION 'Cannot buy in for another user' USING ERRCODE = '42501';
  END IF;

  v_request := jsonb_build_object(
    'door', 'atomic_table_buyin',
    'user_id', p_user_id,
    'table_id', p_table_id,
    'seat_number', p_seat_number,
    'amount', p_amount,
    'auto_rebuy', p_auto_rebuy,
    'club_id', p_club_id
  );
  v_replay := public.fn_claim_entry_purchase_receipt(
    'cash_transaction', p_idempotency_key::text, v_request
  );
  IF NOT COALESCE((v_replay->>'claimed')::boolean, false) THEN
    RETURN;
  END IF;
  IF p_idempotency_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.transaction_idempotency_keys k
     WHERE k.key = p_idempotency_key
  ) THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_RECEIPT_UNBOUND: this historical cash key does not prove its table and seat'
      USING ERRCODE = '55000';
  END IF;

  IF public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION
      'PLATFORM_FROZEN: scheduled maintenance has closed cash buy-ins; no chips moved'
      USING ERRCODE = '55006', HINT = 'Retry after the maintenance break has ended.';
  END IF;
  PERFORM public.fn_assert_cash_chip_purchase_table(p_table_id);
  PERFORM public.atomic_table_buyin_before_maintenance_announcement_gate(
    p_user_id, p_table_id, p_seat_number, p_amount, p_auto_rebuy,
    p_club_id, p_idempotency_key
  );
  PERFORM public.fn_record_entry_purchase_receipt(
    'cash_transaction',
    p_idempotency_key::text,
    v_request,
    jsonb_build_object('completed', true)
  );
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The split that must always sum back to what was debited
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.resolve_pending_addon(
  p_pending_id uuid,
  p_max_buy_in numeric DEFAULT NULL::numeric
)
 RETURNS TABLE(applied numeric, refunded numeric, was_resolved boolean)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row        table_pending_addons%ROWTYPE;
  v_stack      numeric;
  v_headroom   numeric;
  v_applied    numeric := 0;
  v_refunded   numeric := 0;
  v_credit     numeric := 0;
BEGIN
  SELECT * INTO v_row
    FROM table_pending_addons
   WHERE id = p_pending_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending add-on % not found', p_pending_id;
  END IF;

  IF v_row.resolved_at IS NOT NULL THEN
    applied      := COALESCE(v_row.applied_to_stack, 0);
    refunded     := COALESCE(v_row.refunded, 0);
    was_resolved := false;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT stack INTO v_stack
    FROM table_seats
   WHERE table_id = v_row.table_id
     AND user_id  = v_row.user_id
     AND left_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    -- Seat vacated: the whole debit comes back. Exact, not rounded, so the
    -- receipt still sums to the stored amount for a historical dusty row.
    v_applied  := 0;
    v_refunded := v_row.amount;
  ELSE
    IF p_max_buy_in IS NULL THEN
      v_applied := v_row.amount;
    ELSE
      v_headroom := GREATEST(round(COALESCE(p_max_buy_in, 0), 2) - COALESCE(v_stack, 0), 0);
      v_applied  := LEAST(v_row.amount, v_headroom);
    END IF;

    -- ROUND THE APPLIED SIDE FIRST, THEN DERIVE THE REFUND FROM THE STORED
    -- AMOUNT. It used to be the other way round - `refunded := ROUND(amount -
    -- applied, 2)` against an UNROUNDED applied - so the two summed to the
    -- amount only when the amount was already 2 dp. That is what makes a
    -- non-cent row unresolvable against the post-commit obligation check,
    -- rather than merely untidy. This ordering holds for every input.
    v_applied  := round(v_applied, 2);
    IF v_applied > v_row.amount THEN
      v_applied := v_row.amount;   -- rounding up may never exceed the debit
    END IF;
    v_refunded := v_row.amount - v_applied;

    IF v_applied > 0 THEN
      UPDATE table_seats
         SET stack = COALESCE(stack, 0) + v_applied
       WHERE table_id = v_row.table_id
         AND user_id  = v_row.user_id
         AND left_at IS NULL;
      -- CHIP CONTINUITY (I10): a reload in place is not a leave; the baseline
      -- rises by what was delivered, never by what was refunded.
      PERFORM public.fn_cash_session_add_baseline(v_row.user_id, v_row.table_id, v_applied);
    END IF;
  END IF;

  -- The wallet moves in hundredths (its column is numeric(20,2) and would
  -- round this anyway); the RECEIPT below stays exact so the obligation
  -- check can always reconcile it against the stored amount.
  v_credit := round(v_refunded, 2);
  IF v_credit > 0 THEN
    PERFORM atomic_credit_wallet_and_log(
      v_row.user_id,
      v_credit,
      'addon_refund',
      'Add-on refund (exceeds max buy-in or seat vacated)',
      v_row.table_id,
      NULL::uuid,
      NULL::uuid,
      'addon_refund:' || v_row.id::text
    );
  END IF;

  UPDATE table_pending_addons
     SET resolved_at      = now(),
         applied_to_stack = v_applied,
         refunded         = v_refunded
   WHERE id = v_row.id;

  applied      := v_applied;
  refunded     := v_refunded;
  was_resolved := true;
  RETURN NEXT;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. The columns, so no future path can write a non-cent chip amount
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE public.table_pending_addons
  ADD CONSTRAINT table_pending_addons_amount_is_cents
  CHECK (amount IS NULL OR amount = round(amount, 2)) NOT VALID;

ALTER TABLE public.table_pending_addons
  ADD CONSTRAINT table_pending_addons_applied_is_cents
  CHECK (applied_to_stack IS NULL OR applied_to_stack = round(applied_to_stack, 2)) NOT VALID;

ALTER TABLE public.table_pending_addons
  ADD CONSTRAINT table_pending_addons_refunded_is_cents
  CHECK (refunded IS NULL OR refunded = round(refunded, 2)) NOT VALID;

ALTER TABLE public.table_addon_idempotency
  ADD CONSTRAINT table_addon_idempotency_amount_is_cents
  CHECK (amount IS NULL OR amount = round(amount, 2)) NOT VALID;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Say out loud who may call these, because the file is the only witness
--    on a replay
-- ─────────────────────────────────────────────────────────────────────────
--
-- `check-definer-authorization` blocked this migration, and it was right for
-- a reason that is NOT true of the live database: CREATE OR REPLACE keeps an
-- existing function's ACL, so replacing `atomic_table_addon` here changes
-- nothing about who can call it today (read from production 2026-09-09:
-- `postgres=X, service_role=X` — no anon, no authenticated, no PUBLIC, and
-- that is why it has never needed an `auth.uid()` check the way its two
-- siblings do). The hole is on REPLAY. Run this migration set against a fresh
-- database and every one of these functions is CREATED rather than replaced,
-- Postgres grants EXECUTE to PUBLIC by default on creation, and
-- `atomic_table_addon` — SECURITY DEFINER, moves chips, asks nobody who is
-- calling — becomes callable by `anon`.
--
-- So the grants are stated here. Each line reproduces the ACL production
-- carries right now, which makes all six a no-op against the live database
-- and makes the file self-sufficient anywhere else. PUBLIC is named as well
-- as the roles: `anon` inherits whatever PUBLIC holds, so revoking `anon`
-- alone reads as a fix and does nothing. None of the three backs an RLS
-- policy (checked: 0 policies reference any of them), so no SELECT anywhere
-- depends on a caller holding EXECUTE. GRANT/REVOKE is also outside
-- `pgrst_ddl_watch`, so this section costs no schema-cache reload
-- (CLAUDE.md section 2, rule 5).

REVOKE ALL ON FUNCTION public.atomic_table_addon(uuid, uuid, numeric, boolean, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_table_addon(uuid, uuid, numeric, boolean, text)
  TO service_role;

-- The buy-in IS a logged-in player's own call (the client seats itself), and
-- it does ask who is calling — `auth.uid() <> p_user_id` raises above. Keep
-- `authenticated`; close the pre-login roles.
REVOKE ALL ON FUNCTION public.atomic_table_buyin(uuid, uuid, integer, numeric, boolean, uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.atomic_table_buyin(uuid, uuid, integer, numeric, boolean, uuid, uuid)
  TO authenticated, service_role;

-- Engine-only: the settlement sweep resolves a queued add-on. No browser
-- calls it and none should.
REVOKE ALL ON FUNCTION public.resolve_pending_addon(uuid, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_pending_addon(uuid, numeric)
  TO service_role;

COMMIT;
