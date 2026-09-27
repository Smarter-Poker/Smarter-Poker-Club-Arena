-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260720033242 "rakeback_settler_stop_commission_double_book_20260719"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 82cb751f141780cf0432d0325a48545b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- FIX C-LEDGER 2026-07-19 (Dan: weekly settle-period is the AUTHORITATIVE agent
-- commission mechanism). The per-hand RakebackSettler path
-- (credit_agent_commission_from_rake) was double-booking the commission expense:
-- it DEBITED club_wallets.chip_balance (rake-income wallet) and accumulated
-- agents.pending_commission for a commission that is never paid from there —
-- while settle-period separately pays agents from commission_records
-- (computed from agents.weekly_rake_generated). Net: the club's chip position
-- was double-counted DOWN by the commission amount.
--
-- Fix: make the per-hand path PURE rake ATTRIBUTION + idempotent audit accrual.
-- Keep weekly_rake_generated / lifetime_rake_generated (settle-period needs
-- weekly_rake_generated) and the idempotent agent_commissions accrual row, but
-- REMOVE the club_wallets.chip_balance debit, the club_wallet_transactions
-- 'commission_out' row, and the pending_commission accumulation. settle-period
-- remains the sole payer (commission_records -> fn_credit_chips). No money moves
-- here anymore; this can only STOP an erroneous debit, never create a drain.
CREATE OR REPLACE FUNCTION public.credit_agent_commission_from_rake(
  p_agent_user_id uuid, p_club_id uuid, p_rake_credit numeric,
  p_source_type text DEFAULT 'rake_settlement'::text,
  p_source_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text
)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_agent_id          UUID;
  v_agent_user_id     UUID;
  v_commission_rate   NUMERIC;
  v_parent_agent_id   UUID;
  v_parent_user_id    UUID;
  v_parent_rate       NUMERIC;
  v_direct_commission NUMERIC;
  v_parent_commission NUMERIC;
  v_remaining         NUMERIC;
  v_inserted_direct   INTEGER := 0;
  v_inserted_parent   INTEGER := 0;
BEGIN
  -- Idempotency short-circuit (same as before).
  IF p_source_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM agent_commissions
     WHERE source_id = p_source_id AND source_type = p_source_type AND club_id = p_club_id
     LIMIT 1
  ) THEN
    RETURN;
  END IF;

  SELECT a.id, a.user_id, a.commission_rate, a.parent_agent_id
    INTO v_agent_id, v_agent_user_id, v_commission_rate, v_parent_agent_id
    FROM club_members cm
    JOIN agents a ON a.user_id = cm.agent_id AND a.club_id = cm.club_id AND a.status = 'active'
   WHERE cm.user_id = p_agent_user_id AND cm.club_id = p_club_id
   LIMIT 1;

  IF v_agent_id IS NULL THEN
    SELECT id, user_id, commission_rate, parent_agent_id
      INTO v_agent_id, v_agent_user_id, v_commission_rate, v_parent_agent_id
      FROM agents WHERE user_id = p_agent_user_id AND club_id = p_club_id AND status = 'active'
     LIMIT 1;
  END IF;

  IF v_agent_id IS NULL THEN RETURN; END IF;

  v_direct_commission := ROUND(p_rake_credit * COALESCE(v_commission_rate, 0), 2);
  v_remaining         := p_rake_credit - v_direct_commission;

  -- Direct agent ACCRUAL (audit + idempotency marker; NOT a payment). Tracks
  -- weekly_rake_generated so settle-period can compute + pay the commission.
  IF v_direct_commission > 0 THEN
    INSERT INTO agent_commissions (
      club_id, user_id, amount, commission_rate, source_type, source_id, notes
    ) VALUES (
      p_club_id, v_agent_user_id, v_direct_commission, v_commission_rate,
      p_source_type, p_source_id, COALESCE(p_notes, 'agent slice (accrual)')
    )
    ON CONFLICT (user_id, source_id, source_type) WHERE source_id IS NOT NULL
    DO NOTHING;
    GET DIAGNOSTICS v_inserted_direct = ROW_COUNT;

    IF v_inserted_direct > 0 THEN
      UPDATE agents SET
        weekly_rake_generated   = COALESCE(weekly_rake_generated, 0)   + p_rake_credit,
        lifetime_rake_generated = COALESCE(lifetime_rake_generated, 0) + p_rake_credit,
        last_active_at          = NOW(),
        updated_at              = NOW()
      WHERE id = v_agent_id;
      -- NOTE: no pending_commission bump, no club_wallets debit — settle-period pays.
    END IF;
  END IF;

  -- Super-agent (parent) accrual — audit only, same treatment.
  IF v_parent_agent_id IS NOT NULL AND v_remaining > 0 THEN
    SELECT id, user_id, commission_rate
      INTO v_parent_agent_id, v_parent_user_id, v_parent_rate
      FROM agents WHERE id = v_parent_agent_id AND club_id = p_club_id AND status = 'active'
     LIMIT 1;

    IF v_parent_agent_id IS NOT NULL AND v_parent_rate IS NOT NULL THEN
      v_parent_commission := ROUND(v_remaining * v_parent_rate, 2);
      IF v_parent_commission > 0 THEN
        INSERT INTO agent_commissions (
          club_id, user_id, amount, commission_rate, source_type, source_id, notes
        ) VALUES (
          p_club_id, v_parent_user_id, v_parent_commission, v_parent_rate,
          p_source_type, p_source_id, 'super-agent slice (accrual)'
        )
        ON CONFLICT (user_id, source_id, source_type) WHERE source_id IS NOT NULL
        DO NOTHING;
        GET DIAGNOSTICS v_inserted_parent = ROW_COUNT;
        -- parent rake attribution is captured via the direct agent's weekly total;
        -- no separate balance movement here.
      END IF;
    END IF;
  END IF;
END;
$function$;
