-- ═══════════════════════════════════════════════════════════════════════════════
-- BLACKLISTS — club and union-level player bans
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Applied to production Supabase (kuklfnapbkmacvwxktbh) on 2026-04-23 via the
-- Supabase Management API — Phase U4 finding triage (see docs/U4-INVARIANT-FINDINGS.md).
--
-- Why this migration exists:
-- `src/pages/BlacklistManagerPage.tsx` is an active admin feature (routed at
-- `/clubs/:clubId/blacklist`) that performs full CRUD against a `blacklists`
-- table. The table was never created, so the page has been silently returning
-- empty lists and swallowing `42P01 undefined_table` errors on insert/delete.
-- This migration creates it with the shape the UI expects (matches
-- `BlacklistEntry` in `src/types/club.types.ts`) plus indexes + RLS.
--
-- History note: first apply attempted partial unique indexes with
-- `WHERE expires_at IS NULL OR expires_at > NOW()`; Postgres rejected because
-- NOW() is VOLATILE and cannot appear in index predicates. Simplified to
-- enforce uniqueness only on PERMANENT bans (expires_at IS NULL). App-level
-- validation in BlacklistManagerPage guards against overlapping temporary bans.

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
CREATE INDEX IF NOT EXISTS idx_blacklists_expires ON public.blacklists(expires_at)
    WHERE expires_at IS NOT NULL;

-- Uniqueness enforced only on PERMANENT bans (expires_at IS NULL). Postgres
-- forbids volatile functions (NOW()) in index predicates, so we can't express
-- "unique active ban" at the DB layer; app logic in BlacklistManagerPage must
-- reject overlapping temporary bans before insert.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_blacklists_club_user_permanent
    ON public.blacklists(club_id, user_id)
    WHERE club_id IS NOT NULL AND expires_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_blacklists_union_user_permanent
    ON public.blacklists(union_id, user_id)
    WHERE union_id IS NOT NULL AND expires_at IS NULL;

-- ─── RLS ───────────────────────────────────────────────────────────────────

ALTER TABLE public.blacklists ENABLE ROW LEVEL SECURITY;

-- Read: club admins/owners and active agents can see bans for their clubs.
-- Banned users themselves cannot see their entry (avoid leaking ban reasons).
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

-- Insert: only club owners/admins. `banned_by` must equal auth.uid().
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

-- Delete: only club owners/admins.
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
