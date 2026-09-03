-- ═══════════════════════════════════════════════════════════════════════════
-- profiles — restore the client read grants that ADD COLUMN never gave
-- ═══════════════════════════════════════════════════════════════════════════
--
-- APPLIED TO PRODUCTION 2026-08-22 via Supabase apply_migration
-- (migration name: profiles_restore_client_read_grants).
--
-- Same root cause as 20260822143000_arena_avatar_url_grants.sql, nine more
-- times over. public.profiles is granted per-column so that email / phone /
-- stripe_customer_id stay unreadable by the `authenticated` role. Column-level
-- grants do not extend to columns added later, so every column added after that
-- lockdown returns 42501 (PostgREST 403) to the browser — and supabase-js
-- RESOLVES on that, handing back { data: null, error }. Every one of these call
-- sites treats the null as "not set" and falls back to a default, so nine
-- features have been quietly running on defaults instead of on the player's own
-- data, with nothing in any log:
--
--   club_arena_tos_accepted_at    ProfileService.checkTosStatus — the Club
--                                 Arena seat gate. Every player read as
--                                 not-accepted regardless of the truth.
--   equipped_frame, equipped_aura AvatarContext / AvatarGallery cosmetics.
--                                 Frames and auras never rendered.
--   bankroll_preferences          src/services/bankrollPreferences.js
--   diamond_arena_preferences     src/services/diamondArenaPreferences.js
--   memory_games_preferences      src/services/memoryGamesPreferences.js
--   news_preferences              src/services/newsPreferences.js
--   video_library_preferences     src/services/videoLibraryPreferences.js
--                                 All five: saved settings appeared to reset
--                                 to defaults on every page load.
--   memory_elo                    src/games/ELOService.js — everyone displayed
--                                 the default rating.
--
-- SCOPE OF THE GRANT — deliberately narrower than "grant everything back"
--
--   SELECT for all nine. None is PII. Row visibility is unchanged and is still
--   decided by RLS (policy profiles_select = true).
--
--   UPDATE only for equipped_frame / equipped_aura. The client writes those two
--   directly; they are cosmetic and the profiles_update policy already limits
--   the write to auth.uid() = id.
--
--   The five *_preferences columns are written through the SECURITY DEFINER RPC
--   update_page_preferences, which needs no grant on the underlying column.
--
--   memory_elo gets SELECT ONLY, deliberately. ELOService.js updates it from
--   the browser; granting UPDATE would let any player set their own rating.
--   That write belongs server-side, and it is left failing until it moves
--   rather than opened up to make a broken feature look fixed.
--
-- STILL WITHHELD, deliberately: email, phone, stripe_customer_id (PII and
-- payment identifiers) and is_farming_flagged (an anti-fraud signal the player
-- must not be able to read about themselves).
--
-- ROLLBACK:
--   REVOKE SELECT (club_arena_tos_accepted_at, equipped_frame, equipped_aura,
--                  bankroll_preferences, diamond_arena_preferences,
--                  memory_games_preferences, news_preferences,
--                  video_library_preferences, memory_elo)
--     ON public.profiles FROM authenticated;
--   REVOKE UPDATE (equipped_frame, equipped_aura)
--     ON public.profiles FROM authenticated;

BEGIN;

GRANT SELECT (
    club_arena_tos_accepted_at,
    equipped_frame,
    equipped_aura,
    bankroll_preferences,
    diamond_arena_preferences,
    memory_games_preferences,
    news_preferences,
    video_library_preferences,
    memory_elo
) ON public.profiles TO authenticated;

GRANT UPDATE (equipped_frame, equipped_aura) ON public.profiles TO authenticated;

-- Post-apply assertions: fail rather than report a false success.
DO $$
DECLARE
    v_col  text;
    v_bad  text[] := '{}';
BEGIN
    FOREACH v_col IN ARRAY ARRAY[
        'club_arena_tos_accepted_at','equipped_frame','equipped_aura',
        'bankroll_preferences','diamond_arena_preferences',
        'memory_games_preferences','news_preferences',
        'video_library_preferences','memory_elo'
    ] LOOP
        IF NOT has_column_privilege('authenticated', 'public.profiles', v_col, 'SELECT') THEN
            v_bad := v_bad || v_col;
        END IF;
    END LOOP;

    IF array_length(v_bad, 1) IS NOT NULL THEN
        RAISE EXCEPTION 'SELECT grant did not take on: %', array_to_string(v_bad, ', ');
    END IF;

    -- The lockdown must stay locked down.
    FOREACH v_col IN ARRAY ARRAY['email','phone','stripe_customer_id','is_farming_flagged'] LOOP
        IF has_column_privilege('authenticated', 'public.profiles', v_col, 'SELECT') THEN
            RAISE EXCEPTION 'profiles.% became readable — this migration must not widen the lockdown', v_col;
        END IF;
    END LOOP;

    -- memory_elo must stay read-only for the browser.
    IF has_column_privilege('authenticated', 'public.profiles', 'memory_elo', 'UPDATE') THEN
        RAISE EXCEPTION 'profiles.memory_elo must not be client-writable';
    END IF;
END $$;

COMMIT;
