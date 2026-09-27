-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260813033605 "20260812234500_stop_pvp_trigger_clobbering_repurposed_session_link_columns"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 aa7d688e2b47f3cb4c16a1fd5fb90d47 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════
-- 20260812234500_stop_pvp_trigger_clobbering_repurposed_session_link_columns.sql
-- ═══════════════════════════════════════════════════════════════════════
-- TIER:        3   (trigger redefinition + data repair on a staked table)
-- AUTHOR:      Claude (Cowork session 2026-08-12)
-- AFFECTS:     public.fn_trivia_pvp_match_sync_columns (redefined)
--              public.trivia_pvp_matches (repair of corrupted link columns)
-- IRREVERSIBLE: no — see ROLLBACK.
--
-- WHY:
--   1v1 / PvP could never start, for anyone. Reproduced end to end on
--   production: creating a match then calling /api/trivia/session-start
--   returns 409 {"error":"session_link_invalid"} every single time.
--
--   Two designs collided on the same two columns:
--
--   (a) fn_trivia_pvp_match_sync_columns treats challenger_id / opponent_id
--       as LEGACY ALIASES of player1_id / player2_id and mirrors them:
--           NEW.challenger_id := COALESCE(NEW.challenger_id, NEW.player1_id);
--
--   (b) pages/api/trivia/session-start.js REPURPOSED those same columns as
--       SESSION LINKS — challenger_id holds player1's trivia_sessions.id,
--       opponent_id holds player2's (SESSION_LINK_COLUMNS). It branches on
--           if (match[linkCol]) -> servePvpSession(... match[linkCol] ...)
--       and servePvpSession looks the value up in trivia_sessions.
--
--   So the trigger stamps a USER id into the session-link column on every
--   INSERT, session-start sees a non-null link, takes the RESUME path,
--   looks for a trivia_sessions row whose id is a user id, finds nothing,
--   and 409s. There is no ordering of events that avoids this — PvP was
--   structurally unstartable.
--
--   The UPDATE half is worse and had not fired yet only because no match
--   ever got that far: when session-start writes the real session uuid into
--   challenger_id, the trigger mirrors it straight back into player1_id,
--   replacing the participant with a session id and corrupting settlement.
--
--   pvp-settle-match.js already documents the columns as session links
--   ("a random session uuid never equals a user id"), so the API layer is
--   the authority here and the trigger is the stale half.
--
-- HOW:
--   - Redefine the trigger function to mirror ONLY the score aliases, which
--     are still genuine aliases. It no longer reads or writes
--     challenger_id / opponent_id at all.
--   - Repair existing rows: NULL the link columns wherever they still hold
--     a user id (i.e. equal player1_id / player2_id), so previously stuck
--     matches can start instead of 409ing forever. Rows already holding a
--     real session uuid are left untouched.
--
-- SAFETY:
--   Nulling a link column only makes session-start take the CREATE path and
--   write a correct link. It cannot mint diamonds: the stake charge and the
--   payout both live in server routes under the service role, and
--   settlement reads graded trivia_sessions rows, never match-row columns.
--
-- ROLLBACK:
--   Restore the previous function body (it is quoted verbatim in the audit
--   .agent/audits/2026-08-12-pvp-unstartable.md) and re-create the trigger.
--   The data repair is not meaningfully reversible, but re-introducing user
--   ids into the session-link columns is exactly the bug, so it should not
--   be reversed.
--
-- See .agent/workflows/migration-safety.md for the full protocol.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. PRE-FLIGHT ASSERTIONS ─────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'public.trivia_pvp_matches'::regclass
          AND tgname = 'trg_trivia_pvp_match_sync'
          AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION 'pre-flight failed: trg_trivia_pvp_match_sync not found';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='trivia_pvp_matches'
          AND column_name IN ('challenger_score','opponent_score')
        HAVING count(*) = 2
    ) THEN
        RAISE EXCEPTION 'pre-flight failed: score alias columns missing';
    END IF;

    RAISE NOTICE 'pre-flight ok';
END $$;

-- ─── 2. THE ACTUAL CHANGES ────────────────────────────────────────────

-- 2a. Score aliases only. challenger_id / opponent_id are session links now
--     and this trigger must never touch them again.
CREATE OR REPLACE FUNCTION public.fn_trivia_pvp_match_sync_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
    -- NOTE (2026-08-12): challenger_id / opponent_id are NOT aliases of
    -- player1_id / player2_id. They were repurposed to hold each player's
    -- trivia_sessions.id (see SESSION_LINK_COLUMNS in
    -- pages/api/trivia/session-start.js and the header of
    -- pages/api/trivia/pvp-settle-match.js). Mirroring player ids into them
    -- made every match unstartable, and mirroring them back into player ids
    -- on UPDATE would have replaced a participant with a session uuid.
    -- Only the score columns are still true aliases.
    IF TG_OP = 'INSERT' THEN
        NEW.player1_score    := COALESCE(NEW.player1_score,    NEW.challenger_score);
        NEW.challenger_score := COALESCE(NEW.challenger_score, NEW.player1_score);
        NEW.player2_score    := COALESCE(NEW.player2_score,    NEW.opponent_score);
        NEW.opponent_score   := COALESCE(NEW.opponent_score,   NEW.player2_score);
        RETURN NEW;
    END IF;

    IF NEW.player1_score IS DISTINCT FROM OLD.player1_score THEN NEW.challenger_score := NEW.player1_score;
    ELSIF NEW.challenger_score IS DISTINCT FROM OLD.challenger_score THEN NEW.player1_score := NEW.challenger_score; END IF;

    IF NEW.player2_score IS DISTINCT FROM OLD.player2_score THEN NEW.opponent_score := NEW.player2_score;
    ELSIF NEW.opponent_score IS DISTINCT FROM OLD.opponent_score THEN NEW.player2_score := NEW.opponent_score; END IF;

    RETURN NEW;
END;
$function$;

-- 2b. Repair rows whose link columns still hold a user id.
UPDATE public.trivia_pvp_matches
   SET challenger_id = NULL
 WHERE challenger_id IS NOT NULL
   AND challenger_id = player1_id;

UPDATE public.trivia_pvp_matches
   SET opponent_id = NULL
 WHERE opponent_id IS NOT NULL
   AND opponent_id = player2_id;

-- ─── 3. POST-APPLY ASSERTIONS ─────────────────────────────────────────
DO $$
DECLARE
    v_src         text;
    v_still_bad   integer;
BEGIN
    SELECT pg_get_functiondef('public.fn_trivia_pvp_match_sync_columns'::regproc) INTO v_src;

    IF v_src LIKE '%NEW.challenger_id :=%' OR v_src LIKE '%NEW.opponent_id :=%' THEN
        RAISE EXCEPTION 'post-apply failed: trigger still assigns the session-link columns';
    END IF;
    IF v_src NOT LIKE '%challenger_score%' THEN
        RAISE EXCEPTION 'post-apply failed: score aliasing was lost';
    END IF;

    SELECT count(*) INTO v_still_bad
      FROM public.trivia_pvp_matches
     WHERE challenger_id = player1_id OR opponent_id = player2_id;
    IF v_still_bad <> 0 THEN
        RAISE EXCEPTION 'post-apply failed: % rows still carry user ids in link columns', v_still_bad;
    END IF;

    RAISE NOTICE 'post-apply ok: trigger no longer touches link columns, 0 corrupted rows';
END $$;

COMMIT;
