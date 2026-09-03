-- ══════════════════════════════════════════════════════════════════════════════
-- CREDIT REQUESTS TABLE
-- Allows agents to request credit increases from their upline
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS credit_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    approver_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    club_id UUID REFERENCES clubs(id) ON DELETE SET NULL,
    requested_amount DECIMAL(15,2) NOT NULL,
    approved_amount DECIMAL(15,2),
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'cancelled')),
    reviewer_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ,
    reviewed_by UUID REFERENCES profiles(id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_credit_requests_requester ON credit_requests(requester_id);
CREATE INDEX IF NOT EXISTS idx_credit_requests_approver ON credit_requests(approver_id);
CREATE INDEX IF NOT EXISTS idx_credit_requests_status ON credit_requests(status);

-- RLS
ALTER TABLE credit_requests ENABLE ROW LEVEL SECURITY;

-- Requesters can view their own requests
DROP POLICY IF EXISTS credit_requests_requester_select ON credit_requests;
CREATE POLICY credit_requests_requester_select ON credit_requests 
    FOR SELECT USING (requester_id = auth.uid());

-- Approvers can view requests they need to approve
DROP POLICY IF EXISTS credit_requests_approver_select ON credit_requests;
CREATE POLICY credit_requests_approver_select ON credit_requests 
    FOR SELECT USING (approver_id = auth.uid());

-- Requesters can insert their own requests
DROP POLICY IF EXISTS credit_requests_insert ON credit_requests;
CREATE POLICY credit_requests_insert ON credit_requests 
    FOR INSERT WITH CHECK (requester_id = auth.uid());

-- Approvers can update (approve/deny) requests
DROP POLICY IF EXISTS credit_requests_approver_update ON credit_requests;
CREATE POLICY credit_requests_approver_update ON credit_requests 
    FOR UPDATE USING (approver_id = auth.uid());

-- Requesters can delete/cancel their pending requests
DROP POLICY IF EXISTS credit_requests_requester_delete ON credit_requests;
CREATE POLICY credit_requests_requester_delete ON credit_requests 
    FOR DELETE USING (requester_id = auth.uid() AND status = 'pending');
