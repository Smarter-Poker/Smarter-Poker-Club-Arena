-- ══════════════════════════════════════════════════════════════════════════════
-- CLUB INVITES TABLE
-- Tracks invitation links sent to potential members
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS club_invites (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    inviter_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    invitee_email TEXT,
    invite_code TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'expired')),
    email_sent_at TIMESTAMPTZ,
    accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_club_invites_club ON club_invites(club_id);
CREATE INDEX IF NOT EXISTS idx_club_invites_code ON club_invites(invite_code);
CREATE INDEX IF NOT EXISTS idx_club_invites_status ON club_invites(status);
CREATE INDEX IF NOT EXISTS idx_club_invites_expires ON club_invites(expires_at);

-- RLS
ALTER TABLE club_invites ENABLE ROW LEVEL SECURITY;

-- Club members can view invites for their club
DROP POLICY IF EXISTS club_invites_select ON club_invites;
CREATE POLICY club_invites_select ON club_invites 
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM club_members WHERE club_id = club_invites.club_id AND user_id = auth.uid())
    );

-- Club admins/owners can create invites
DROP POLICY IF EXISTS club_invites_insert ON club_invites;
CREATE POLICY club_invites_insert ON club_invites 
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM club_members 
            WHERE club_id = club_invites.club_id 
            AND user_id = auth.uid() 
            AND role IN ('owner', 'admin')
        )
    );

-- Valid pending invites can be read by anyone (for accepting)
DROP POLICY IF EXISTS club_invites_public_validate ON club_invites;
CREATE POLICY club_invites_public_validate ON club_invites 
    FOR SELECT USING (
        status = 'pending' AND expires_at > NOW()
    );

-- Club admins can update invites
DROP POLICY IF EXISTS club_invites_update ON club_invites;
CREATE POLICY club_invites_update ON club_invites 
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM club_members 
            WHERE club_id = club_invites.club_id 
            AND user_id = auth.uid() 
            AND role IN ('owner', 'admin')
        )
    );
