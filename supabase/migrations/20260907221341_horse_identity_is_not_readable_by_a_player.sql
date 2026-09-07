-- ═══════════════════════════════════════════════════════════════════════════
--  A PLAYER CANNOT ASK THE DATABASE WHO IS A HORSE
-- ═══════════════════════════════════════════════════════════════════════════
-- APPLIED TO PRODUCTION 2026-09-02 via Supabase apply_migration.
--
-- Dan, 2026-09-02: "YOU NEED TO 100% FIX, CORRECT AND UPDATE THIS SO THERE IS
-- ZERO DIFFERENCE BETWEEN A HORSE AND A REAL PLAYER, NOBODY SHOULD EVER EVER
-- EVER BE ABLE TO LOOK AT OUR CODE OR USE A DEVELOPER TOOL AND FIND THIS OUT."
--
-- The client-side sweep that preceded this was necessary and NOT sufficient.
-- Cleaning our own queries only stops OUR code asking. Anyone can open a
-- console on smarter.poker and write their own:
--
--     supabase.from('profiles').select('id,is_horse').eq('is_horse', true)
--
-- MEASURED as an ordinary non-staff logged-in player, BEFORE:
--     profiles.is_horse = true      1000 rows   <- the entire roster
--     profiles.horse_profile        1308 rows   <- and the playing style
--     ai_horses                      100 rows   <- readable LOGGED OUT
-- AFTER (same probe):
--     profiles.is_horse             DENIED (42501)
--     profiles.horse_profile        DENIED (42501)
--     ai_horses                     0 rows
--     profiles.username             1192 rows   <- control, unaffected
--
-- WHY COLUMN-LEVEL REVOKE IS SAFE ON profiles:
--   * `authenticated` holds NO table-level SELECT on profiles - only column
--     grants, 102 of 120 columns. Eighteen are already withheld this way (see
--     20260822150000_profiles_restore_client_read_grants.sql).
--   * With no table-level grant, `SELECT *` on profiles ALREADY fails for a
--     browser, so every client query names its columns, and no `select('*')`
--     on profiles exists in the client. Nothing breaks.
--   * Staff surfaces read through ca_club_top_players, ca_club_members,
--     ca_club_data_snapshot, ca_club_player_page, ca_club_player_breakdown and
--     ca_club_dashboard_stats. All six are SECURITY DEFINER (asserted below),
--     so 10.5's sanctioned staff identification is untouched - verified after
--     applying: a club owner's roster returned 200 members, 200 flagged
--     is_horse=true.
--   * The engine uses service_role, which keeps every grant.
--
-- ai_horses was the same hole in a different shape: RLS on, but its only
-- policy was `USING (true)` for role `public` - readable with no login at all.
-- Nothing in src/ or server/src/ reads it.
--
-- ── DELIBERATELY NOT HERE: table_seats.horse_id ───────────────────────────
-- Granted to authenticated and anon, but table_seats carries a TABLE-level
-- SELECT grant, so a column REVOKE is a NO-OP - the first attempt at this
-- migration tried exactly that and its own post-apply assertion caught it and
-- rolled everything back. The honest fixes are to drop the column or convert
-- that table to column grants, and neither may land until PR #2743 stops the
-- felt selecting `horse_id` (doing it sooner 42703s the table for every
-- player). The leak it represents is ZERO ROWS today: horse_id has never been
-- populated, and nothing in the repo writes it.
--
-- WHAT THIS DOES NOT CLAIM: it does not make horses undetectable by PLAY.
-- Timing, sizing and rhythm are the engine's problem, and 10.5 already
-- requires identical treatment there. This closes the direct read.
--
-- DDL FOOTPRINT: REVOKEs trigger no PostgREST reload (not in pgrst_ddl_watch).
-- The policy swap is one DDL statement = one reload.
--
-- ROLLBACK:
--   GRANT SELECT (is_horse, horse_profile, horse_status) ON public.profiles TO authenticated;
--   DROP POLICY IF EXISTS deny_all_ai_horses ON public.ai_horses;
--   CREATE POLICY "Anyone can view horses" ON public.ai_horses FOR SELECT USING (true);

DO $$
DECLARE v_table_level int; v_secdef int;
BEGIN
  SELECT count(*) INTO v_table_level
  FROM information_schema.role_table_grants
  WHERE table_schema='public' AND table_name='profiles'
    AND grantee='authenticated' AND privilege_type='SELECT';
  IF v_table_level <> 0 THEN
    RAISE EXCEPTION 'PRE-FLIGHT: authenticated holds table-level SELECT on profiles; a column REVOKE would not close anything.';
  END IF;

  SELECT count(*) INTO v_secdef
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prosecdef
    AND p.proname IN ('ca_club_top_players','ca_club_members','ca_club_data_snapshot',
                      'ca_club_player_page','ca_club_player_breakdown','ca_club_dashboard_stats');
  IF v_secdef < 6 THEN
    RAISE EXCEPTION 'PRE-FLIGHT: expected 6 SECURITY DEFINER club RPCs, found % - staff surfaces would lose horse identification.', v_secdef;
  END IF;
END $$;

REVOKE SELECT (is_horse, horse_profile, horse_status) ON public.profiles FROM authenticated;
REVOKE SELECT (is_horse, horse_profile, horse_status) ON public.profiles FROM anon;

DROP POLICY IF EXISTS "Anyone can view horses" ON public.ai_horses;
CREATE POLICY deny_all_ai_horses ON public.ai_horses
  AS PERMISSIVE FOR ALL TO authenticated, anon
  USING (false) WITH CHECK (false);

COMMENT ON POLICY deny_all_ai_horses ON public.ai_horses IS
  'Replaces "Anyone can view horses" (USING true, role public), which let a logged-out visitor list 100 horses. Nothing in src/ or server/src/ reads this table; the engine uses service_role, which bypasses RLS.';

DO $$
DECLARE v_left int; v_pol int;
BEGIN
  SELECT count(*) INTO v_left
  FROM information_schema.column_privileges
  WHERE table_schema='public' AND privilege_type='SELECT'
    AND grantee IN ('authenticated','anon')
    AND table_name='profiles' AND column_name IN ('is_horse','horse_profile','horse_status');
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'POST-APPLY: % horse-identity column grant(s) on profiles still held by a browser role.', v_left;
  END IF;

  SELECT count(*) INTO v_pol FROM pg_policies
  WHERE schemaname='public' AND tablename='ai_horses' AND policyname='Anyone can view horses';
  IF v_pol <> 0 THEN
    RAISE EXCEPTION 'POST-APPLY: the public ai_horses read policy is still present.';
  END IF;
END $$;
