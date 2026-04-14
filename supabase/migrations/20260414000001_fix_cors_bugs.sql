-- Fix missing category for refunds
ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_category_check;
ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_category_check
    CHECK (category IN (
        'mint', 'transfer', 'buyin', 'cashout', 'rake', 'commission',
        'promo', 'settlement', 'TIP', 'INSURANCE', 'dispute_resolution',
        'credit_payment', 'credit_advance', 'bonus', 'rebuy', 'addon',
        'tournament_buyin', 'tournament_payout', 'tournament_rebuy', 'refund'
    ));

-- Fix missing table credit_invoices
CREATE TABLE IF NOT EXISTS credit_invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id UUID NOT NULL REFERENCES auth.users(id),
    agent_id UUID NOT NULL REFERENCES auth.users(id),
    club_id UUID NOT NULL REFERENCES clubs(id),
    amount DECIMAL(15, 2) NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    due_date TIMESTAMPTZ,
    paid_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Basic RLS
ALTER TABLE credit_invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own invoices" ON credit_invoices FOR SELECT USING (auth.uid() = player_id OR auth.uid() = agent_id);
