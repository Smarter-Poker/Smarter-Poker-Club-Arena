-- =============================================
-- Credit Invoices & Payments tables
-- Required by CreditService for weekly settlement
-- DEPLOYED TO SUPABASE: 2026-03-07
-- =============================================

-- 0. Add business_balance column to agents (needed by RPCs below)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS business_balance NUMERIC NOT NULL DEFAULT 0;

-- 1. Credit Invoices — weekly settlement invoices for agents
DROP TABLE IF EXISTS credit_payments CASCADE;
DROP TABLE IF EXISTS credit_invoices CASCADE;

CREATE TABLE credit_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  debt_owed DECIMAL(15,2) NOT NULL DEFAULT 0,
  amount_paid DECIMAL(15,2) NOT NULL DEFAULT 0,
  amount_remaining DECIMAL(15,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'partial', 'paid', 'overdue', 'disputed')),
  due_date TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);

CREATE INDEX idx_credit_invoices_agent ON credit_invoices(agent_id);
CREATE INDEX idx_credit_invoices_status ON credit_invoices(status);
CREATE INDEX idx_credit_invoices_due ON credit_invoices(due_date);

-- 2. Credit Payments — payment records per invoice
CREATE TABLE credit_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES credit_invoices(id) ON DELETE CASCADE,
  amount DECIMAL(15,2) NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('wallet', 'diamonds', 'external')),
  transaction_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_credit_payments_invoice ON credit_payments(invoice_id);

-- 3. RPC: Deduct from agent balance (for invoice payments)
DROP FUNCTION IF EXISTS wallet_user_transfer(uuid,uuid,numeric,text);

CREATE OR REPLACE FUNCTION deduct_agent_balance(
  p_agent_id UUID,
  p_amount NUMERIC
) RETURNS VOID AS $$
BEGIN
  UPDATE agents
  SET business_balance = business_balance - p_amount,
      updated_at = NOW()
  WHERE id = p_agent_id AND business_balance >= p_amount;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient agent balance or agent not found';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. RPC: Credit agent commission
CREATE OR REPLACE FUNCTION credit_agent_commission(
  p_agent_id UUID,
  p_amount NUMERIC,
  p_period_id UUID DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
  UPDATE agents
  SET business_balance = business_balance + p_amount,
      updated_at = NOW()
  WHERE id = p_agent_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. RPC: Transfer chips between users
CREATE OR REPLACE FUNCTION wallet_user_transfer(
  p_from_user_id UUID,
  p_to_user_id UUID,
  p_amount NUMERIC,
  p_reference_id TEXT DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
  -- Deduct from sender
  UPDATE wallets
  SET balance = balance - p_amount
  WHERE user_id = p_from_user_id AND wallet_type = 'PLAYER' AND balance >= p_amount;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient balance for transfer';
  END IF;

  -- Credit to receiver
  UPDATE wallets
  SET balance = balance + p_amount
  WHERE user_id = p_to_user_id AND wallet_type = 'PLAYER';

  -- Log both sides
  INSERT INTO wallet_transactions (user_id, wallet_type, amount, type, category, description)
  VALUES
    (p_from_user_id, 'PLAYER', p_amount, 'debit', 'transfer', 'Transfer to player: ' || p_amount || ' chips'),
    (p_to_user_id, 'PLAYER', p_amount, 'credit', 'transfer', 'Transfer from player: ' || p_amount || ' chips');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
