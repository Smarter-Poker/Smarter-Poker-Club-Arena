-- ═══════════════════════════════════════════════════════════════════════════
-- PRESERVE USERNAME CASING (2026-08-28)
-- ═══════════════════════════════════════════════════════════════════════════
-- Users should be able to capitalize their display username however they wish.
-- The unique constraint `idx_profiles_username_lower` already guarantees
-- uniqueness on `lower(username)`. Therefore, overwriting their input
-- with `LOWER(username)` in the normalize trigger is unnecessary and destructive.

CREATE OR REPLACE FUNCTION public.fn_normalize_username()
RETURNS TRIGGER AS $$
BEGIN
    -- We removed LOWER(NEW.username) to preserve user casing preference.
    -- The unique constraint idx_profiles_username_lower will still block
    -- case-insensitive duplicates from being registered.
    IF NEW.username IS NOT NULL THEN
        -- Optionally trim whitespace to ensure clean usernames
        NEW.username := TRIM(NEW.username);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
