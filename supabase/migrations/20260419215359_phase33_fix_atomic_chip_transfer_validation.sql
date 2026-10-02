-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260419215359 as "phase33_fix_atomic_chip_transfer_validation"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- ══════════════════════════════════════════════════════════════════════════
-- PHASE 33 — FIX atomic_chip_transfer (6 real bugs in one function)
--
-- Bugs found:
--   1. No auth check — caller identity unverifiable
--   2. No amount validation — negative amounts invert transfer direction 
--      (attacker calls with p_amount = -100 → debits receiver by -100 
--       → INCREMENTS receiver; credits sender by -100 → DECREMENTS sender)
--   3. No self-transfer check — p_from = p_to corrupts audit trail
--   4. No NULL user check — NULL params would pass and no-op silently
--   5. No upper-bound check — numeric overflow risk
--   6. No category validation — required for audit trail integrity
--
-- Preserved: the atomic UPDATE...WHERE balance >= p_amount pattern is 
-- race-safe because Postgres takes a row lock on UPDATE. That part was fine.
-- ══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.atomic_chip_transfer(
    p_from_user_id uuid,
    p_to_user_id uuid,
    p_amount numeric,
    p_category text,
    p_description text,
    p_related_entity_id uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
BEGIN
    -- ── AUTH: caller must be the sender themselves OR service_role ────────
    IF auth.role() <> 'service_role' 
       AND (auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_from_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED' 
              USING HINT = 'Caller must be the sender or service_role';
    END IF;

    -- ── ARGUMENT VALIDATION ───────────────────────────────────────────────
    IF p_from_user_id IS NULL OR p_to_user_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_USER_ID' USING HINT = 'from/to are required';
    END IF;
    IF p_from_user_id = p_to_user_id THEN
        RAISE EXCEPTION 'SELF_TRANSFER_FORBIDDEN' 
              USING HINT = 'sender and receiver must differ';
    END IF;
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'INVALID_AMOUNT' 
              USING HINT = format('amount must be positive (got %s)', p_amount);
    END IF;
    IF p_amount > 1e12 THEN
        RAISE EXCEPTION 'AMOUNT_EXCEEDS_LIMIT' 
              USING HINT = 'max 1 trillion per single transfer';
    END IF;
    IF p_category IS NULL OR length(trim(p_category)) = 0 THEN
        RAISE EXCEPTION 'CATEGORY_REQUIRED' 
              USING HINT = 'audit trail requires a category';
    END IF;

    -- ── 1. Deduct from sender (row-lock on UPDATE guarantees atomicity) ───
    UPDATE wallets
       SET balance = balance - p_amount, updated_at = NOW()
     WHERE user_id = p_from_user_id 
       AND wallet_type = 'PLAYER' 
       AND balance >= p_amount;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'INSUFFICIENT_BALANCE';
    END IF;

    -- ── 2. Credit receiver (upsert) ───────────────────────────────────────
    INSERT INTO wallets (user_id, wallet_type, balance)
    VALUES (p_to_user_id, 'PLAYER', p_amount)
    ON CONFLICT (user_id, wallet_type)
    DO UPDATE SET balance = wallets.balance + p_amount, updated_at = NOW();

    -- ── 3-4. Audit trail ──────────────────────────────────────────────────
    PERFORM log_wallet_transaction(
        p_from_user_id, 'PLAYER', -p_amount, 'debit', p_category,
        p_description, NULL, NULL, p_related_entity_id
    );
    PERFORM log_wallet_transaction(
        p_to_user_id, 'PLAYER', p_amount, 'credit', p_category,
        p_description, NULL, NULL, p_related_entity_id
    );
END;
$fn$;

-- Keep service-role-only grant from Phase 32
REVOKE EXECUTE ON FUNCTION public.atomic_chip_transfer(uuid, uuid, numeric, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.atomic_chip_transfer(uuid, uuid, numeric, text, text, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.atomic_chip_transfer(uuid, uuid, numeric, text, text, uuid) IS
  'Phase 33: Hardened with auth check (sender or service_role), positive-amount validation, upper bound, self-transfer block, null/category validation. Race-safe via row-lock on sender UPDATE.';
