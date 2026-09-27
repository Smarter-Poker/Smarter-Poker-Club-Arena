-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819233248 "chip_transactions_table_id_attribution"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 41bcd03855ee3467f66caea1ca0eaf04 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- chip_transactions.table_id (2026-08-19)
--
-- WHY: the union player-P&L has to scope table cash-outs to UNION tables. The
-- wallet ledger can do that (wallet_transactions.table_id), but the chip ledger
-- could not — chip_transactions had no table_id at all, so cash-outs could only
-- be scoped by club_id. That meant a PRIVATE club game's cash-out inside a union
-- club fell into the union settlement scope. Harmless while zero private games
-- existed; wrong the moment they are used, which this project just enabled.
--
-- The fix is small because atomic_credit_wallet_and_log ALREADY receives
-- p_table_id (it uses it to resolve club_id) and simply threw it away when
-- writing the chip row.
--
-- ALSO FIXED HERE: that function falls back to a HARDCODED club id
-- ('a41434bb-…' = SHARK CLUB) whenever it cannot resolve a club. Every
-- unattributable credit on the platform was therefore being booked against one
-- real club's ledger, silently inflating it. club_id is NOT NULL so the
-- fallback has to stay, but it is now flagged in metadata so those rows can be
-- found and excluded instead of blending in as if they were Shark's.
-- ============================================================================

ALTER TABLE chip_transactions ADD COLUMN IF NOT EXISTS table_id uuid;

-- Partial index: starts empty and only grows with newly-stamped rows, so this
-- does not rewrite the existing ledger.
CREATE INDEX IF NOT EXISTS idx_chip_tx_table_id
  ON chip_transactions (table_id, created_at)
  WHERE table_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.atomic_credit_wallet_and_log(
  p_user_id uuid,
  p_amount numeric,
  p_category text DEFAULT 'credit'::text,
  p_description text DEFAULT ''::text,
  p_table_id uuid DEFAULT NULL::uuid,
  p_hand_id uuid DEFAULT NULL::uuid,
  p_related_entity_id uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
) RETURNS boolean
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_club_id uuid;
  v_inserted integer;
  v_fallback boolean := false;
BEGIN
  -- Idempotency gate (only when a key is supplied). First caller for a key wins;
  -- a committed-but-timed-out retry finds ROW_COUNT=0 and no-ops, so the credit
  -- + log below never runs twice. If the credit fails the whole function txn
  -- (incl. this INSERT) rolls back, so a genuine retry is still allowed.
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO wallet_credit_idempotency (key, user_id, amount)
    VALUES (p_idempotency_key, p_user_id, p_amount)
    ON CONFLICT (key) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted = 0 THEN
      RETURN true;  -- already credited under this key: idempotent no-op
    END IF;
  END IF;

  UPDATE wallets SET balance = COALESCE(balance, 0) + p_amount, updated_at = now()
  WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
  IF NOT FOUND THEN
    INSERT INTO wallets (user_id, wallet_type, balance, locked_balance)
    VALUES (p_user_id, 'PLAYER', p_amount, 0)
    ON CONFLICT (user_id, wallet_type) DO UPDATE
      SET balance = wallets.balance + p_amount, updated_at = now();
  END IF;

  IF p_table_id IS NOT NULL THEN
    SELECT club_id INTO v_club_id FROM tables WHERE id = p_table_id;
  END IF;
  IF v_club_id IS NULL THEN
    SELECT club_id INTO v_club_id FROM club_members WHERE user_id = p_user_id LIMIT 1;
  END IF;
  IF v_club_id IS NULL THEN
    -- Last-resort attribution. Kept because club_id is NOT NULL, but marked so
    -- these rows are identifiable rather than silently booked to a real club.
    v_club_id := 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid;
    v_fallback := true;
  END IF;

  INSERT INTO chip_transactions (club_id, to_user_id, amount, transaction_type,
                                 notes, table_id, metadata)
  VALUES (v_club_id, p_user_id, p_amount, p_category,
          COALESCE(NULLIF(p_description, ''), 'Wallet credit'),
          p_table_id,
          CASE WHEN v_fallback
               THEN jsonb_build_object('club_attribution', 'fallback_unresolved')
               ELSE '{}'::jsonb END);
  RETURN true;
END; $function$;

-- Assertions
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='chip_transactions'
                    AND column_name='table_id') THEN
    RAISE EXCEPTION 'ASSERTION FAILED: chip_transactions.table_id missing';
  END IF;
  IF (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
        JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='atomic_credit_wallet_and_log'
         AND p.pronargs=8) NOT LIKE '%table_id%' THEN
    RAISE EXCEPTION 'ASSERTION FAILED: credit function does not stamp table_id';
  END IF;
END $$;
