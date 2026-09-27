-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420004658 "phase4_idempotency_keys"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b2b131303427db2e9aced5d48b262ab1 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════════
--  PHASE 4.1.3 — IDEMPOTENCY KEYS ON EVERY BALANCE MUTATION
--  (SMARTER-POKER-LAUNCH-READINESS-PLAN.md § 7.1.3)
-- ═══════════════════════════════════════════════════════════════════════════════
--
--  Purpose: prevent duplicate-credit / double-debit when a client retries a
--  balance-mutation RPC (fast-click, webhook redelivery, network timeout).
--
--  Design:
--    1. public.idempotency_keys — (key TEXT PK, rpc_name, result JSONB, created_at).
--    2. public.claim_idempotency_key(p_key, p_rpc_name) → JSONB:
--       - If key exists: return the cached result (replay).
--       - If key does not exist: INSERT with NULL result, return NULL (caller runs RPC).
--       - Concurrency-safe via INSERT ... ON CONFLICT DO NOTHING RETURNING, then
--         a SELECT to fetch the winning row.
--    3. public.store_idempotency_result(p_key, p_result) — writes final result.
--    4. public.fn_idempotent_credit_wallet(p_key, ...p_args) — convenience wrapper
--       around atomic_credit_wallet_and_log that does all three steps in one RPC call.
--    5. public.fn_idempotent_wallet_transfer(p_key, ...p_args) — same for transfer.
--    6. Purge policy enforced by cron (separate file): DELETE rows > 7 days.
--
--  Contract for callers:
--    - Pass a stable, deterministic key. Good keys:
--        `tournament:${tid}:payout:${uid}`
--        `hand:${hid}:rake:${cid}`
--        `addon:${tid}:${uid}:${seq}`
--      Bad keys: random UUIDs, timestamps, anything that varies across retries.
--    - Keys > 128 chars rejected by CHECK. ASCII/UTF-8 text.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────────────────
-- 1. idempotency_keys table
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.idempotency_keys (
  key         TEXT PRIMARY KEY CHECK (char_length(key) BETWEEN 1 AND 128),
  rpc_name    TEXT NOT NULL,
  result      JSONB,                                 -- NULL while in-flight, populated on completion
  status      TEXT NOT NULL DEFAULT 'in_flight'      -- 'in_flight' | 'completed' | 'errored'
              CHECK (status IN ('in_flight','completed','errored')),
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_idempotency_created_at
  ON public.idempotency_keys(created_at);

CREATE INDEX IF NOT EXISTS idx_idempotency_rpc_name
  ON public.idempotency_keys(rpc_name, created_at DESC);

ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "idempotency_service_only" ON public.idempotency_keys;
CREATE POLICY "idempotency_service_only"
  ON public.idempotency_keys FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

COMMENT ON TABLE public.idempotency_keys
  IS 'Phase 4.1.3: deduplication layer for balance-mutation RPCs. Service-role only. Purged after 7 days by cron.';

-- ──────────────────────────────────────────────────────────────────────────────
-- 2. claim_idempotency_key — returns cached result or claims the key for this caller
-- ──────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.claim_idempotency_key(
  p_key       TEXT,
  p_rpc_name  TEXT
)
RETURNS TABLE (claimed BOOLEAN, cached_result JSONB, cached_status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.idempotency_keys%ROWTYPE;
BEGIN
  IF p_key IS NULL OR p_rpc_name IS NULL THEN
    RAISE EXCEPTION 'idempotency key and rpc_name required';
  END IF;

  -- Try to INSERT the key. If it already exists, we lose the race and fetch existing.
  INSERT INTO public.idempotency_keys (key, rpc_name, status)
  VALUES (p_key, p_rpc_name, 'in_flight')
  ON CONFLICT (key) DO NOTHING;

  SELECT * INTO v_existing FROM public.idempotency_keys WHERE key = p_key;

  IF v_existing.rpc_name IS DISTINCT FROM p_rpc_name THEN
    RAISE EXCEPTION 'idempotency key % already used with different rpc (%, tried: %)',
      p_key, v_existing.rpc_name, p_rpc_name;
  END IF;

  -- Claimed (just inserted) if created_at is very recent AND status is in_flight with no result
  claimed := (v_existing.status = 'in_flight' AND v_existing.result IS NULL
              AND v_existing.created_at >= NOW() - INTERVAL '500 milliseconds');
  cached_result := v_existing.result;
  cached_status := v_existing.status;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.claim_idempotency_key
  IS 'Phase 4.1.3: claim an idempotency key. If claimed=true, caller runs the RPC and calls store_idempotency_result. If claimed=false and cached_status=completed, caller returns cached_result directly.';

-- ──────────────────────────────────────────────────────────────────────────────
-- 3. store_idempotency_result — completes (or errors) an in-flight key
-- ──────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.store_idempotency_result(
  p_key     TEXT,
  p_result  JSONB,
  p_error   TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.idempotency_keys
  SET
    status       = CASE WHEN p_error IS NULL THEN 'completed' ELSE 'errored' END,
    result       = p_result,
    error        = p_error,
    completed_at = NOW()
  WHERE key = p_key AND status = 'in_flight';
END;
$$;

COMMENT ON FUNCTION public.store_idempotency_result
  IS 'Phase 4.1.3: persist final result for an in-flight idempotency key.';

-- ──────────────────────────────────────────────────────────────────────────────
-- 4. fn_idempotent_credit_wallet — one-shot wrapper around atomic_credit_wallet_and_log
-- ──────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_idempotent_credit_wallet(
  p_idempotency_key    TEXT,
  p_user_id            UUID,
  p_amount             NUMERIC,
  p_category           TEXT,
  p_description        TEXT,
  p_table_id           UUID DEFAULT NULL,
  p_hand_id            UUID DEFAULT NULL,
  p_related_entity_id  UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed BOOLEAN;
  v_cached  JSONB;
  v_status  TEXT;
  v_result  BOOLEAN;
BEGIN
  SELECT claimed, cached_result, cached_status
    INTO v_claimed, v_cached, v_status
    FROM public.claim_idempotency_key(p_idempotency_key, 'atomic_credit_wallet_and_log');

  IF NOT v_claimed THEN
    IF v_status = 'completed' THEN
      RETURN v_cached;
    ELSIF v_status = 'in_flight' THEN
      RAISE EXCEPTION 'idempotency key % already in flight (concurrent duplicate request)', p_idempotency_key;
    ELSE
      RETURN v_cached;  -- errored: return prior error payload
    END IF;
  END IF;

  BEGIN
    v_result := public.atomic_credit_wallet_and_log(
      p_user_id, p_amount, p_category, p_description,
      p_table_id, p_hand_id, p_related_entity_id
    );
    PERFORM public.store_idempotency_result(
      p_idempotency_key,
      jsonb_build_object('ok', v_result, 'rpc', 'atomic_credit_wallet_and_log')
    );
    RETURN jsonb_build_object('ok', v_result, 'rpc', 'atomic_credit_wallet_and_log');
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.store_idempotency_result(
      p_idempotency_key,
      jsonb_build_object('ok', false, 'rpc', 'atomic_credit_wallet_and_log'),
      SQLERRM
    );
    RAISE;
  END;
END;
$$;

COMMENT ON FUNCTION public.fn_idempotent_credit_wallet
  IS 'Phase 4.1.3: idempotent wrapper — retrying with the same p_idempotency_key returns the cached result.';

-- ──────────────────────────────────────────────────────────────────────────────
-- 5. fn_idempotent_wallet_transfer — same pattern around atomic_wallet_transfer
-- ──────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_idempotent_wallet_transfer(
  p_idempotency_key    TEXT,
  p_from_user_id       UUID,
  p_to_user_id         UUID,
  p_amount             NUMERIC,
  p_category           TEXT,
  p_debit_description  TEXT,
  p_credit_description TEXT,
  p_related_entity_id  UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed BOOLEAN;
  v_cached  JSONB;
  v_status  TEXT;
  v_result  BOOLEAN;
BEGIN
  SELECT claimed, cached_result, cached_status
    INTO v_claimed, v_cached, v_status
    FROM public.claim_idempotency_key(p_idempotency_key, 'atomic_wallet_transfer');

  IF NOT v_claimed THEN
    IF v_status = 'completed' THEN
      RETURN v_cached;
    ELSIF v_status = 'in_flight' THEN
      RAISE EXCEPTION 'idempotency key % already in flight (concurrent duplicate request)', p_idempotency_key;
    ELSE
      RETURN v_cached;
    END IF;
  END IF;

  BEGIN
    v_result := public.atomic_wallet_transfer(
      p_from_user_id, p_to_user_id, p_amount, p_category,
      p_debit_description, p_credit_description, p_related_entity_id
    );
    PERFORM public.store_idempotency_result(
      p_idempotency_key,
      jsonb_build_object('ok', v_result, 'rpc', 'atomic_wallet_transfer')
    );
    RETURN jsonb_build_object('ok', v_result, 'rpc', 'atomic_wallet_transfer');
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.store_idempotency_result(
      p_idempotency_key,
      jsonb_build_object('ok', false, 'rpc', 'atomic_wallet_transfer'),
      SQLERRM
    );
    RAISE;
  END;
END;
$$;

COMMENT ON FUNCTION public.fn_idempotent_wallet_transfer
  IS 'Phase 4.1.3: idempotent wrapper around atomic_wallet_transfer.';

-- ──────────────────────────────────────────────────────────────────────────────
-- 6. fn_idempotent_deduct_wallet — around atomic_deduct_wallet_and_log
-- ──────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_idempotent_deduct_wallet(
  p_idempotency_key    TEXT,
  p_user_id            UUID,
  p_amount             NUMERIC,
  p_category           TEXT,
  p_description        TEXT,
  p_table_id           UUID DEFAULT NULL,
  p_hand_id            UUID DEFAULT NULL,
  p_related_entity_id  UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed BOOLEAN;
  v_cached  JSONB;
  v_status  TEXT;
  v_result  BOOLEAN;
BEGIN
  SELECT claimed, cached_result, cached_status
    INTO v_claimed, v_cached, v_status
    FROM public.claim_idempotency_key(p_idempotency_key, 'atomic_deduct_wallet_and_log');

  IF NOT v_claimed THEN
    IF v_status = 'completed' THEN
      RETURN v_cached;
    ELSIF v_status = 'in_flight' THEN
      RAISE EXCEPTION 'idempotency key % already in flight', p_idempotency_key;
    ELSE
      RETURN v_cached;
    END IF;
  END IF;

  BEGIN
    v_result := public.atomic_deduct_wallet_and_log(
      p_user_id, p_amount, p_category, p_description,
      p_table_id, p_hand_id, p_related_entity_id
    );
    PERFORM public.store_idempotency_result(
      p_idempotency_key,
      jsonb_build_object('ok', v_result, 'rpc', 'atomic_deduct_wallet_and_log')
    );
    RETURN jsonb_build_object('ok', v_result, 'rpc', 'atomic_deduct_wallet_and_log');
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.store_idempotency_result(
      p_idempotency_key,
      jsonb_build_object('ok', false, 'rpc', 'atomic_deduct_wallet_and_log'),
      SQLERRM
    );
    RAISE;
  END;
END;
$$;

COMMENT ON FUNCTION public.fn_idempotent_deduct_wallet
  IS 'Phase 4.1.3: idempotent wrapper around atomic_deduct_wallet_and_log.';

-- ──────────────────────────────────────────────────────────────────────────────
-- 7. purge_idempotency_keys — removes rows > 7 days old
-- ──────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.purge_idempotency_keys()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted INT;
BEGIN
  DELETE FROM public.idempotency_keys
  WHERE created_at < NOW() - INTERVAL '7 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION public.purge_idempotency_keys
  IS 'Phase 4.1.3: nightly purge of idempotency keys older than 7 days. Called by /api/cron/purge-idempotency-keys.';

-- ──────────────────────────────────────────────────────────────────────────────
-- 8. Verification
-- ──────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='idempotency_keys') THEN
    RAISE EXCEPTION 'idempotency_keys not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='claim_idempotency_key') THEN
    RAISE EXCEPTION 'claim_idempotency_key not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='fn_idempotent_credit_wallet') THEN
    RAISE EXCEPTION 'fn_idempotent_credit_wallet not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='fn_idempotent_wallet_transfer') THEN
    RAISE EXCEPTION 'fn_idempotent_wallet_transfer not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='fn_idempotent_deduct_wallet') THEN
    RAISE EXCEPTION 'fn_idempotent_deduct_wallet not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='purge_idempotency_keys') THEN
    RAISE EXCEPTION 'purge_idempotency_keys not created';
  END IF;
END $$;
