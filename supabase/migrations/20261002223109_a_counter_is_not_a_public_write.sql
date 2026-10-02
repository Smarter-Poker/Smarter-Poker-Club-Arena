-- ============================================================================
-- A COUNTER IS NOT A PUBLIC WRITE
-- ============================================================================
--
-- Phase 3 of 9 (security sweep): the reel functions, and the functions and
-- tables any logged-in user could write. Every finding below was read from
-- production on 2026-10-02, and each one is closed at the line that caused it.
--
-- 1. ANY PLAYER COULD SET ANY REEL'S COUNTS
--
--    increment_reel_count / decrement_reel_count are SECURITY DEFINER, were
--    executable by every logged-in user, and never asked who was calling:
--
--        UPDATE public.social_reels SET %I = GREATEST(%I +/- 1, 0) WHERE id = $1
--
--    over like_count, comment_count, share_count and view_count. A loop in a
--    browser console could add a million views to one reel, or take every
--    like off a rival's. The daily definer-exposure audit raised it as
--    issue #5762. increment_post_count / decrement_post_count are the same
--    body over social_posts as SECURITY INVOKER, executable even by anon.
--
--    Who really needs them:
--      * the World Hub's own server routes (interactions, share-count,
--        share-to-feed) and the horse social engine, all on the service role;
--      * the browser, for exactly two things: a reel was VIEWED, and a reel
--        was SHARED. Like and comment counts are maintained by triggers on
--        social_likes and social_comments, so the browser never needs them.
--
--    So the four counters become service-role only, and the browser gets one
--    door that can only ever add ONE view or ONE share, for the caller, once a
--    day per piece of content: fn_count_content_engagement. The caller comes
--    from auth.uid(), never a parameter, and the once-a-day rule is a primary
--    key, not a client-side Set that a reload clears.
--
-- 2. ANY PLAYER COULD READ A VENUE CLAIM'S VERIFICATION CODE
--
--    venue_claims had `venue_claims_read ... USING (true)` for PUBLIC. The
--    table holds verification_code - the code /api/public/venue/verify
--    compares to prove the claimant owns the venue - plus the claimant's
--    email and phone. Reading the code is passing the check. No browser reads
--    this table (World Hub API routes on the service role, and SECURITY
--    DEFINER admin RPCs, are its only readers), so the policy is narrowed to
--    service_role and the browser grants go. Both existing claims are already
--    approved by an admin, so no pending claim was passable today.
--
--    page_claims had the same open read over contact_email / contact_phone.
--    page_notifications' read policy looks its claimant up in page_claims
--    under the caller's own rights, so page_claims keeps a read policy - the
--    claimant's own rows only, which is exactly what that lookup asks for.
--
-- 3. ANY PLAYER COULD REWRITE A VENUE'S SCHEDULE OR ADD A LEGACY TABLE
--
--    venue_game_schedules had INSERT and UPDATE policies of only
--    "auth.uid() IS NOT NULL": any account could rewrite any venue's posted
--    games. Its only writer is /api/poker/venue-schedules on the service role,
--    which checks the venue manager itself. poker_tables (4 legacy rows)
--    likewise let any account INSERT. Those write policies are narrowed to
--    service_role.
--
--    Narrowed, not dropped: a policy that names only service_role (which
--    bypasses RLS anyway) admits no browser role, and ALTER POLICY keeps this
--    migration free of DROP statements, which the Supabase MCP holds for an
--    interactive confirmation that an unattended apply never receives (two
--    applies timed out at 180 s without reaching the database).
--
-- 4. A PLAYER COULD MARK THEIR OWN PHONE AS VERIFIED
--
--    A rolled-back probe as an ordinary player (UPDATE on their own profile,
--    one column at a time) showed these change freely: email_verified,
--    phone_verified, access_tier, tier, skill_tier, level. phone_verified is
--    what /api/sms/verify-otp's duplicate-phone guard matches on - "one
--    handset, one account" - and what the phone-verified VIP path trusts, so
--    a self-set flag defeats both. No browser writes any of them (signup puts
--    phone_verified in auth metadata; ensure-profile copies it on the service
--    role). trg_guard_profile_trust_columns now refuses a browser change to
--    them, the way trg_guard_profile_privileged_columns already refuses one to
--    the diamond and VIP columns. That function is pinned by md5 in the diamond
--    concurrency harness, so it is left untouched and this is a second trigger.
--
-- 5. A LOG ROW COULD NAME SOMEBODY ELSE
--
--    commander_home_group_share_log, commander_home_group_view_log and
--    qr_code_scans accepted a direct browser INSERT whose WITH CHECK was only
--    "auth.uid() IS NOT NULL", so a row could carry another user's id. Their
--    real writers are SECURITY DEFINER RPCs and a service-role route, which
--    policies do not touch. The check now pins the row to the caller.
--
-- 6. EVERY BROWSER WRITE TO club_members WAS REFUSED
--
--    Found by the same probe: CHECK club_members_bot_house_only calls
--    fn_ca_house_board_allows_automation(club_id), and authenticated has no
--    EXECUTE on it. Postgres checks function privileges when it builds the
--    expression, before NOT is_bot can short-circuit it, so every UPDATE or
--    INSERT on club_members from a browser fails with "permission denied for
--    function fn_ca_house_board_allows_automation" - the club admin's agent
--    unassign in ClubsService.ts is one such write. The
--    function is a STABLE read of clubs.is_platform plus four ids; granting it
--    exposes nothing. It was the only constraint, default or policy on this
--    database calling a function its writer cannot execute.
--
-- WHAT IS DELIBERATELY NOT HERE
--
--   * recalculate_leaderboard_ranks stays in the reviewed baseline: it
--     recomputes dense_rank() over scores only the service role can write.
--   * The 19 "mutable search_path" functions are all SECURITY INVOKER, and no
--     browser role can create an object in public or extensions, so there is
--     nothing to hijack; several are md5-pinned by other harnesses.
--   * commander_tournament_entries.player_phone is readable, but holds no
--     value today and the Commander tablet reads that table with select('*')
--     and realtime; it needs a client change first and is recorded in the
--     changelog.
--
-- Nothing is backfilled and nothing is repaired (CLAUDE.md 10.12).
--
-- @live-proof: (SELECT NOT has_function_privilege('authenticated', 'public.increment_reel_count(uuid,text)', 'EXECUTE') AND has_function_privilege('authenticated', 'public.fn_count_content_engagement(uuid,text,text)', 'EXECUTE') AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND roles && ARRAY['public', 'anon', 'authenticated']::name[] AND ((tablename IN ('venue_game_schedules', 'poker_tables') AND cmd <> 'SELECT') OR tablename = 'venue_claims')) AND has_function_privilege('authenticated', 'public.fn_ca_house_board_allows_automation(uuid)', 'EXECUTE'))

BEGIN;
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. One view, one share, per player, per piece of content, per day.
-- ---------------------------------------------------------------------------

-- A statistic. No foreign key to the hot social tables (CLAUDE.md section 2
-- rule 7): an orphan receipt is harmless, a lock on social_reels is not.
CREATE TABLE public.content_engagement_receipts (
  content_id       uuid        NOT NULL,
  viewer_id        uuid        NOT NULL,
  kind             text        NOT NULL CHECK (kind IN ('view', 'share')),
  first_counted_at timestamptz NOT NULL DEFAULT now(),
  counted_at       timestamptz NOT NULL DEFAULT now(),
  times_counted    integer     NOT NULL DEFAULT 1,
  PRIMARY KEY (content_id, viewer_id, kind)
);

COMMENT ON TABLE public.content_engagement_receipts IS
  'One row per (content, player, view|share). fn_count_content_engagement counts again only when counted_at is a day old. Written only by that function.';

ALTER TABLE public.content_engagement_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.content_engagement_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.content_engagement_receipts TO service_role;

CREATE FUNCTION public.fn_count_content_engagement(
  p_content_id uuid,
  p_kind text,
  p_source text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  -- The counter's subject is the caller. Never a parameter.
  v_viewer  uuid := auth.uid();
  v_target  uuid;
  v_is_reel boolean := false;
  v_counted boolean;
BEGIN
  IF v_viewer IS NULL OR p_content_id IS NULL THEN
    RETURN false;
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('view', 'share') THEN
    RAISE EXCEPTION 'fn_count_content_engagement: invalid kind %', p_kind USING ERRCODE = '22023';
  END IF;
  IF p_source IS NOT NULL AND p_source NOT IN ('posts', 'reels') THEN
    RAISE EXCEPTION 'fn_count_content_engagement: invalid source %', p_source USING ERRCODE = '22023';
  END IF;

  -- A reel id may be an alias of a canonical reel (social_reel_aliases), the
  -- same resolution increment_reel_count made.
  IF p_source IS DISTINCT FROM 'posts' THEN
    SELECT COALESCE(a.canonical_reel_id, p_content_id) INTO v_target
      FROM (SELECT 1) seed
      LEFT JOIN public.social_reel_aliases a ON a.alias_reel_id = p_content_id;
    v_is_reel := EXISTS (SELECT 1 FROM public.social_reels r WHERE r.id = v_target);
  END IF;
  IF NOT v_is_reel THEN
    IF p_source = 'reels' THEN
      RETURN false;
    END IF;
    v_target := p_content_id;
    IF NOT EXISTS (SELECT 1 FROM public.social_posts p WHERE p.id = v_target) THEN
      RETURN false;
    END IF;
  END IF;

  -- The receipt decides. A first view inserts; a repeat inside the day matches
  -- the conflict, fails the WHERE, and returns no row.
  INSERT INTO public.content_engagement_receipts AS r (content_id, viewer_id, kind)
  VALUES (v_target, v_viewer, p_kind)
  ON CONFLICT (content_id, viewer_id, kind) DO UPDATE
     SET counted_at = now(),
         times_counted = r.times_counted + 1
   WHERE r.counted_at < now() - interval '24 hours'
  RETURNING true INTO v_counted;

  IF v_counted IS NOT TRUE THEN
    RETURN false;
  END IF;

  IF v_is_reel THEN
    IF p_kind = 'view' THEN
      UPDATE public.social_reels SET view_count = COALESCE(view_count, 0) + 1 WHERE id = v_target;
    ELSE
      UPDATE public.social_reels SET share_count = COALESCE(share_count, 0) + 1 WHERE id = v_target;
    END IF;
  ELSE
    IF p_kind = 'view' THEN
      UPDATE public.social_posts SET view_count = COALESCE(view_count, 0) + 1 WHERE id = v_target;
    ELSE
      UPDATE public.social_posts SET share_count = COALESCE(share_count, 0) + 1 WHERE id = v_target;
    END IF;
  END IF;
  RETURN true;
END;
$fn$;

COMMENT ON FUNCTION public.fn_count_content_engagement(uuid, text, text) IS
  'The browser''s only counter door: adds one view or one share of a reel or post for auth.uid(), at most once a day per content. Like and comment counts are trigger-maintained.';

REVOKE ALL ON FUNCTION public.fn_count_content_engagement(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_count_content_engagement(uuid, text, text) TO authenticated, service_role;

-- The raw counters: the server's, and nobody else's.
REVOKE ALL ON FUNCTION public.increment_reel_count(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.decrement_reel_count(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.increment_post_count(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.decrement_post_count(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_reel_count(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.decrement_reel_count(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_post_count(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.decrement_post_count(uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. A claim's verification code and contact details are not public.
-- ---------------------------------------------------------------------------

ALTER POLICY venue_claims_read ON public.venue_claims TO service_role;
REVOKE ALL ON TABLE public.venue_claims FROM PUBLIC, anon, authenticated;

ALTER POLICY page_claims_select ON public.page_claims
  TO authenticated
  USING (user_id = (SELECT auth.uid()));
REVOKE ALL ON TABLE public.page_claims FROM PUBLIC, anon;

-- ---------------------------------------------------------------------------
-- 3. A venue's schedule and the legacy tables are written by the server.
-- ---------------------------------------------------------------------------

ALTER POLICY vgs_insert_policy ON public.venue_game_schedules TO service_role;
ALTER POLICY vgs_update_policy ON public.venue_game_schedules TO service_role;
ALTER POLICY "Authenticated users can create tables" ON public.poker_tables TO service_role;

-- ---------------------------------------------------------------------------
-- 4. A player cannot verify themselves.
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.fn_guard_profile_trust_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_changed text;
BEGIN
  IF public.fn_is_service_context() THEN
    RETURN NEW;
  END IF;

  IF NEW.email_verified IS DISTINCT FROM OLD.email_verified THEN v_changed := 'email_verified';
  ELSIF NEW.phone_verified IS DISTINCT FROM OLD.phone_verified THEN v_changed := 'phone_verified';
  ELSIF NEW.access_tier IS DISTINCT FROM OLD.access_tier THEN v_changed := 'access_tier';
  ELSIF NEW.tier IS DISTINCT FROM OLD.tier THEN v_changed := 'tier';
  ELSIF NEW.skill_tier IS DISTINCT FROM OLD.skill_tier THEN v_changed := 'skill_tier';
  ELSIF NEW.level IS DISTINCT FROM OLD.level THEN v_changed := 'level';
  END IF;

  IF v_changed IS NOT NULL THEN
    RAISE EXCEPTION 'profiles.% is server-managed and cannot be modified by role %', v_changed, current_user
      USING ERRCODE = '42501',
            HINT = 'Verification and standing are set by the server, never by the player.';
  END IF;
  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_guard_profile_trust_columns() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_guard_profile_trust_columns
  BEFORE UPDATE OF email_verified, phone_verified, access_tier, tier, skill_tier, level
  ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_profile_trust_columns();

-- ---------------------------------------------------------------------------
-- 5. A log row names its caller.
-- ---------------------------------------------------------------------------

ALTER POLICY share_log_insert_authenticated ON public.commander_home_group_share_log
  WITH CHECK (caller_uid = (SELECT auth.uid()));
ALTER POLICY view_log_insert_authenticated ON public.commander_home_group_view_log
  WITH CHECK (caller_uid = (SELECT auth.uid()));
ALTER POLICY "Authenticated users can record scans" ON public.qr_code_scans
  WITH CHECK (scanned_by = (SELECT auth.uid()));

-- ---------------------------------------------------------------------------
-- 6. club_members' own CHECK can be evaluated by the people who write it.
-- ---------------------------------------------------------------------------

GRANT EXECUTE ON FUNCTION public.fn_ca_house_board_allows_automation(uuid) TO authenticated;

COMMIT;
