-- ═══════════════════════════════════════════════════════════════════════════════
-- Tournament Waitlists — Phase 13 Fix
-- table_waitlists has FK to tables(id), so tournament UUIDs fail.
-- This creates a dedicated tournament_waitlists table.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tournament_waitlists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    status TEXT DEFAULT 'waiting' CHECK (status IN ('waiting', 'called', 'seated', 'expired', 'cancelled')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(tournament_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_tournament_waitlist_tournament ON tournament_waitlists(tournament_id);
CREATE INDEX IF NOT EXISTS idx_tournament_waitlist_user ON tournament_waitlists(user_id);
CREATE INDEX IF NOT EXISTS idx_tournament_waitlist_status ON tournament_waitlists(status);

-- RLS: Players can see and manage their own waitlist entries
ALTER TABLE tournament_waitlists ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own waitlist entries"
    ON tournament_waitlists FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own waitlist entries"
    ON tournament_waitlists FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own waitlist entries"
    ON tournament_waitlists FOR DELETE
    USING (auth.uid() = user_id);

-- Admins can view all waitlist entries for their clubs
CREATE POLICY "Club admins can view all waitlist entries"
    ON tournament_waitlists FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM tournaments t
            JOIN club_members cm ON cm.club_id = t.club_id
            WHERE t.id = tournament_waitlists.tournament_id
            AND cm.user_id = auth.uid()
            AND cm.role IN ('owner', 'admin', 'agent')
        )
    );
