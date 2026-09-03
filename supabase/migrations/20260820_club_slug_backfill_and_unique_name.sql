-- ═══════════════════════════════════════════════════════════════════════════
-- CLUB SLUG BACKFILL + CASE-INSENSITIVE UNIQUE NAME (2026-08-20)
-- ═══════════════════════════════════════════════════════════════════════════
-- Audit round 2 of the club-creation flows found:
--   1. All 3 production clubs have NULL slugs — ClubsService.getClub() falls
--      back to slug lookup for non-UUID identifiers, so slug routing never
--      worked for them. Backfill from the name (same normalization as
--      src/utils/clubSlug.ts), appending -<club_id> on collision.
--   2. Duplicate club names were only guarded by a client-side ilike check —
--      two clients racing past the check could both insert. Add a unique
--      index on lower(name) so the DB is the last word. Verified 0 existing
--      case-insensitive duplicates before this migration.
-- Tier 2. Rollback: DROP INDEX idx_clubs_name_lower; (backfilled slugs are
-- data-only and harmless to keep).
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Backfill NULL/blank slugs (collision-proof via -<club_id> suffix)
UPDATE clubs c
SET slug = CASE
  WHEN nullif(regexp_replace(regexp_replace(lower(trim(c.name)), '[^a-z0-9]+', '-', 'g'), '(^-|-$)', '', 'g'), '') IS NULL
    THEN 'club-' || c.club_id
  WHEN EXISTS (
    SELECT 1 FROM clubs c2
    WHERE c2.id <> c.id
      AND c2.slug = nullif(regexp_replace(regexp_replace(lower(trim(c.name)), '[^a-z0-9]+', '-', 'g'), '(^-|-$)', '', 'g'), '')
  )
    THEN nullif(regexp_replace(regexp_replace(lower(trim(c.name)), '[^a-z0-9]+', '-', 'g'), '(^-|-$)', '', 'g'), '') || '-' || c.club_id
  ELSE nullif(regexp_replace(regexp_replace(lower(trim(c.name)), '[^a-z0-9]+', '-', 'g'), '(^-|-$)', '', 'g'), '')
END
WHERE c.slug IS NULL OR c.slug = '';

-- 2. Case-insensitive unique club names (server-side race closure)
CREATE UNIQUE INDEX IF NOT EXISTS idx_clubs_name_lower ON clubs (lower(name));

-- ── Post-apply assertions ────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM clubs WHERE slug IS NULL OR slug = '') THEN
    RAISE EXCEPTION 'ASSERTION FAILED: blank club slugs remain after backfill';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE tablename = 'clubs' AND indexname = 'idx_clubs_name_lower'
  ) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: idx_clubs_name_lower missing';
  END IF;
END $$;
