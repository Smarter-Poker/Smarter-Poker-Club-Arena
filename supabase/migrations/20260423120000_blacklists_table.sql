-- ═══════════════════════════════════════════════════════════════════════════════
-- BLACKLISTS — club and union-level player bans
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Created 2026-04-23 (Phase U4 finding triage — see docs/U4-INVARIANT-FINDINGS.md)
--
-- Why this migration exists:
-- `src/pages/BlacklistManagerPage.tsx` is an active admin feature (routed at
-- `/clubs/:clubId/blacklist`) that performs full CRUD against a `blacklists`
-- table. The table was never created, so the page has been silently returning
-- empty lists and swallowing `42P01 undefined_table` errors on insert/delete.
-- This migration creates the table with the shape the UI expects (matches
-- `BlacklistEntry` in `src/types/club.types.ts`) plus indexes + RLS.
--
-- The invariant CI gate (`scripts/ci/check-phantom-tables.mjs`) surfaced this.

-- ─── Table ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.blacklists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    club_id UUID REFERENCES public.clubs(id) ON DELETE CASCADE,    -- NULL = union-wide ban
    union_id UUID,                                                 -- optional union ref
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    banned_by UUID NOT NULL REFERENCES auth.users(id),
    banned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,                                        -- NULL = permanent
    CONSTRAINT blacklists_scope_check CHECK (club_id IS NOT NULL OR union_id IS NOT NULL)
);

COMMENT ON TABLE public.blacklists IS
  'Club- and union-level player bans. Either club_id or union_id must be set.';

-- ─── Indexes ───────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_blacklists_club ON public.blacklists(club_id)
    WHERE club_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_blacklists_union ON public.blacklists(union_id)
    WHERE union_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_blacklists_user ON public.blacklists(user_id);
CREATE INDEX IF NOT EXISTS idx_blacklists_active ON public.blacklists(user_id, club_id)
    WHERE expires_at IS NULL OR expires_at > NOW();

-- Prevent duplicate active bans for the same (club, user) or (union, user).
-- Allow repeated entries only if prior ones have expired.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_blacklists_club_user_active
    ON public.blacklists(club_id, user_id)
    WHERE club_id IS NOT NULL AND (expires_at IS NULL OR expires_at > NOW());
CREATE UNIQUE INDEX IF NOT EXISTS uniq_blacklists_union_user_active
    ON public.blacklists(union_id, user_id)
    WHERE union_id IS NOT NULL AND (expires_at IS NULL OR expires_at > NOW());

-- ─── RLS ───────────────────────────────────────────────────────────────────

ALTER TABLE public.blacklists ENABLE ROW LEVEL SECURITY;

-- Read: club admins/owners and agents with manage_players permission can see
-- bans for their clubs. Banned users themselves cannot see their entry (avoid
-- leaking ban reasons or who banned them).
DROP POLICY IF EXISTS blacklists_select ON public.blacklists;
CREATE POLICY blacklists_select ON public.blacklists
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.club_members cm
            WHERE cm.club_id = blacklists.club_id
              AND cm.user_id = auth.uid()
              AND cm.role IN ('owner', 'admin')
        )
        OR EXISTS (
            SELECT 1 FROM public.agents a
            WHERE a.club_id = blacklists.club_id
              AND a.user_id = auth.uid()
              AND a.status = 'active'
        )
    );

-- Insert: only club owners/admins can ban. Inserted row must have
-- banned_by = auth.uid().
DROP POLICY IF EXISTS blacklists_insert ON public.blacklists;
CREATE POLICY blacklists_insert ON public.blacklists
    FOR INSERT
    WITH CHECK (
        banned_by = auth.uid()
        AND EXISTS (
            SELECT 1 FROM public.club_members cm
            WHERE cm.club_id = blacklists.club_id
              AND cm.user_id = auth.uid()
              AND cm.role IN ('owner', 'admin')
        )
    );

-- Delete: only club owners/admins can unban.
DROP POLICY IF EXISTS blacklists_delete ON public.blacklists;
CREATE POLICY blacklists_delete ON public.blacklists
    FOR DELETE
    USING (
        EXISTS (
            SELECT 1 FROM public.club_members cm
            WHERE cm.club_id = blacklists.club_id
              AND cm.user_id = auth.uid()
              AND cm.role IN ('owner', 'admin')
        )
    );

-- No UPDATE policy — bans are immutable; to change terms, delete and re-insert.

-- ─── Grants ────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, DELETE ON public.blacklists TO authenticated;
