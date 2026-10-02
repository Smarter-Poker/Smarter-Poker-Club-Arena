-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260813033352 "20260812232000_restore_authenticated_insert_update_on_trivia_pvp_matches"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d10600189ff36093d55589e59d0dc0f3 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════
-- 20260812232000_restore_authenticated_insert_update_on_trivia_pvp_matches.sql
-- ═══════════════════════════════════════════════════════════════════════
-- TIER:        3                       (grant change on a staked-diamond table)
-- AUTHOR:      Claude (Cowork session 2026-08-12)
-- AFFECTS:     grants: public.trivia_pvp_matches (authenticated)
-- IRREVERSIBLE: no  — see ROLLBACK.
--
-- WHY:
--   1v1 / PvP was completely unplayable. Reproduced on production in a real
--   signed-in browser: selecting a stake produced
--     [PVP] handleHorseMatch failed (nothing charged):
--     {code: 42501, message: permission denied for table trivia_pvp_matches}
--   and the UI showed "Could not start a match right now."  No PvP API call
--   ever fired.
--
--   public.trivia_pvp_matches has RLS enabled with 5 policies, and two of
--   them are written specifically for client access:
--     "Users can insert matches"      INSERT  with_check
--         auth.uid() = player1_id OR auth.uid() = player2_id
--     "Users can update their matches" UPDATE  using
--         auth.uid() = player1_id OR auth.uid() = player2_id
--   But `authenticated` held only SELECT at the table level. An RLS policy
--   is dead weight without the underlying GRANT, so both policies were
--   unreachable and every client insert failed with 42501.
--
--   It is the only table in the PvP path in this state — trivia_pvp_queue,
--   trivia_sessions and trivia_scores all carry SELECT/INSERT/UPDATE/DELETE
--   for authenticated. This looks like collateral damage from a blanket
--   hardening pass rather than a deliberate lockdown of this one table.
--
-- WHY THIS IS SAFE FOR THE DIAMOND ECONOMY:
--   Settlement does NOT trust anything the client writes to this table.
--   pages/api/trivia/pvp-settle-match.js reads BOTH players' graded
--   correct-counts off their trivia_sessions rows, decides the winner, and
--   moves diamonds with the service role. Its own header documents the old
--   client-reported-score flow as "a standing mint invitation" that was
--   removed. The session links (challenger_id / opponent_id) are written
--   server-side by session-start, and the stake charge is server-side too.
--   The match row is coordination state, not a payout input.
--
--   RLS still constrains the client: you may only insert a match you are a
--   participant in, and only update a match you are a participant in.
--
-- SCOPE:
--   INSERT + UPDATE only, to `authenticated` only. DELETE is deliberately
--   NOT granted (no DELETE policy exists and no client path needs it), and
--   `anon` gets nothing — PvP requires a signed-in user.
--
-- ROLLBACK:
--   REVOKE INSERT, UPDATE ON public.trivia_pvp_matches FROM authenticated;
--   (This restores the broken state; PvP will 42501 again.)
--
-- See .agent/workflows/migration-safety.md for the full protocol.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. PRE-FLIGHT ASSERTIONS ─────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_class
        WHERE oid = 'public.trivia_pvp_matches'::regclass AND relrowsecurity
    ) THEN
        RAISE EXCEPTION
            'pre-flight failed: RLS is NOT enabled on trivia_pvp_matches — '
            'granting INSERT/UPDATE without RLS would expose every row';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname='public' AND tablename='trivia_pvp_matches'
          AND cmd='INSERT' AND with_check IS NOT NULL
    ) THEN
        RAISE EXCEPTION
            'pre-flight failed: no INSERT policy with a WITH CHECK on '
            'trivia_pvp_matches — refusing to grant unconstrained INSERT';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname='public' AND tablename='trivia_pvp_matches'
          AND cmd='UPDATE' AND qual IS NOT NULL
    ) THEN
        RAISE EXCEPTION
            'pre-flight failed: no UPDATE policy with a USING clause on '
            'trivia_pvp_matches — refusing to grant unconstrained UPDATE';
    END IF;

    RAISE NOTICE 'pre-flight ok: RLS on, INSERT+UPDATE policies present';
END $$;

-- ─── 2. THE ACTUAL CHANGE ─────────────────────────────────────────────
GRANT INSERT, UPDATE ON public.trivia_pvp_matches TO authenticated;

-- ─── 3. POST-APPLY ASSERTIONS ─────────────────────────────────────────
DO $$
DECLARE
    v_grants text;
    v_anon   integer;
BEGIN
    SELECT string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type)
      INTO v_grants
      FROM information_schema.role_table_grants
     WHERE table_schema='public' AND table_name='trivia_pvp_matches'
       AND grantee='authenticated'
       AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE');

    IF v_grants IS DISTINCT FROM 'INSERT,SELECT,UPDATE' THEN
        RAISE EXCEPTION
            'post-apply failed: authenticated grants are "%", expected "INSERT,SELECT,UPDATE"', v_grants;
    END IF;

    SELECT count(*) INTO v_anon
      FROM information_schema.role_table_grants
     WHERE table_schema='public' AND table_name='trivia_pvp_matches'
       AND grantee='anon' AND privilege_type IN ('INSERT','UPDATE','DELETE');
    IF v_anon <> 0 THEN
        RAISE EXCEPTION 'post-apply failed: anon gained % write grants', v_anon;
    END IF;

    RAISE NOTICE 'post-apply ok: authenticated = %, anon writes = 0', v_grants;
END $$;

COMMIT;
