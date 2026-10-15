-- 20261015181214_club_invite_links_and_attribution.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (Dan 2026-10-15, Share & Invite):
--
--   "THE SHARE AND INVITE LINK NEEDS TO BE HARD CODED TO THE PERSON WHO
--    SPECIFICALLY SENDS IT ... CREATE AN ACCOUNT FIRST, THEN AFTER THE PERSON
--    HAS CREATED THE ACCOUNT, VERIFIED THEIR NUMBER, IT SHOULD OPEN DIRECTLY UP
--    TO THAT CLUB TO JOIN ... COOKIES SHOULD BE ADDED ... THE PERSON WHO
--    REFERRED THE USER GETS CREDITED FOR THE SIGN UP, AND THEY ARE ADDED UNDER
--    THEM IN THEIR DOWNLINES INSIDE THE CLUB."
--
-- Before this, the share button built /invite/<club>?ref=<player number>. Three
-- things broke between that link and the downline:
--   1. A signed-out recipient was sent to LOGIN, not signup, and the club
--      context died at the login page: nothing carried it through signup,
--      email confirmation (often another device) or phone verification.
--   2. The signup page parked the referral in localStorage and the callback
--      posted it to /api/rewards/referral, which only PAYS a referral that a
--      `referrals` row already records. No path wrote that row, so a signup
--      from a link was never credited to anyone.
--   3. fn_redeem_club_invite_code failed the WHOLE join when the inviter had
--      left the club or been deactivated, so an old link was a dead end.
--
-- This adds:
--   club_invite_links         one short code per (club, inviter): smarter.poker/i/<code>
--   club_invite_attributions  first-wins record of who brought whom, per club,
--                             with its funnel: signed_up -> verified -> joined
--   fn_club_invite_link       get-or-create the caller's code for a club
--   fn_club_invite_resolve    landing page / link preview read (server-side
--                             service role, or a signed-in player in the app)
--   fn_club_invite_claim      attach the signed-in account to the link it came from
--   fn_club_invite_pending    the club a new player still has to join
--   fn_club_invite_my_stats / fn_club_invite_club_stats
--   trigger on profiles.phone_verified: credit only after phone verification,
--   and refuse it when the referee's phone is the inviter's own
--   fn_redeem_club_invite_code: first-wins inviter, a departed or deactivated
--   inviter routes the player to the club owner instead of failing the join,
--   a blocked self-referral never admits, every join is recorded and the
--   inviter is notified.
--
-- No foreign keys: both tables are scan/record tables that reference hot
-- relations (club_members, profiles, clubs). CLAUDE.md production DDL rule 7.
-- The owner's beta accounts (KingFish, Danimal) are exempt from the
-- self-referral checks through the existing anti_cheat_exemptions rows
-- (flag_type 'multi_account'), the same list anti-cheat already honours.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ─────────────────────────────────────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.club_invite_links (
  code              text PRIMARY KEY CHECK (code ~ '^[A-HJ-NP-Z2-9]{7}$'),
  club_id           uuid NOT NULL,
  inviter_id        uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  click_count       integer NOT NULL DEFAULT 0,
  last_clicked_at   timestamptz,
  inviter_device_id text,
  CONSTRAINT club_invite_links_one_per_inviter UNIQUE (club_id, inviter_id)
);

COMMENT ON TABLE public.club_invite_links IS
  'One short invite code per (club, inviter). smarter.poker/i/<code>. 2026-10-15.';

CREATE TABLE IF NOT EXISTS public.club_invite_attributions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text,
  club_id          uuid NOT NULL,
  inviter_id       uuid NOT NULL,
  user_id          uuid NOT NULL,
  status           text NOT NULL DEFAULT 'signed_up'
                   CHECK (status IN ('signed_up','verified','joined','blocked')),
  block_reason     text,
  fresh_signup     boolean NOT NULL DEFAULT false,
  first_clicked_at timestamptz,
  claimed_at       timestamptz NOT NULL DEFAULT now(),
  verified_at      timestamptz,
  joined_at        timestamptz,
  device_id        text,
  CONSTRAINT club_invite_attributions_first_wins UNIQUE (user_id, club_id)
);

COMMENT ON TABLE public.club_invite_attributions IS
  'First-wins record of which invite brought which player to which club. 2026-10-15.';

CREATE INDEX IF NOT EXISTS club_invite_attributions_inviter_idx
  ON public.club_invite_attributions (club_id, inviter_id);
CREATE INDEX IF NOT EXISTS club_invite_attributions_user_open_idx
  ON public.club_invite_attributions (user_id, claimed_at DESC)
  WHERE status IN ('signed_up','verified');

ALTER TABLE public.club_invite_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_invite_attributions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS club_invite_links_own_read ON public.club_invite_links;
CREATE POLICY club_invite_links_own_read ON public.club_invite_links
  FOR SELECT TO authenticated USING (inviter_id = auth.uid());

DROP POLICY IF EXISTS club_invite_attributions_party_read ON public.club_invite_attributions;
CREATE POLICY club_invite_attributions_party_read ON public.club_invite_attributions
  FOR SELECT TO authenticated USING (inviter_id = auth.uid() OR user_id = auth.uid());

REVOKE ALL ON public.club_invite_links FROM anon, authenticated;
REVOKE ALL ON public.club_invite_attributions FROM anon, authenticated;
GRANT SELECT ON public.club_invite_links TO authenticated;
GRANT SELECT ON public.club_invite_attributions TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Helpers
-- ─────────────────────────────────────────────────────────────────────────────

-- The owner's beta accounts are never treated as one person's second account.
CREATE OR REPLACE FUNCTION public.fn_club_invite_is_exempt(p_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.anti_cheat_exemptions e
     WHERE e.player_id = p_user_id AND e.flag_type = 'multi_account'
  );
$$;

-- The path a player is sent to in order to join through an invite.
CREATE OR REPLACE FUNCTION public.fn_club_invite_join_path(p_club_id uuid, p_inviter_id uuid, p_code text)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT '/hub/club-arena/invite/' || p_club_id::text
         || COALESCE('?ref=' || NULLIF(btrim(p.player_number), ''), '?ref=' || p_inviter_id::text)
         || CASE WHEN p_code IS NULL THEN '' ELSE '&i=' || p_code END
    FROM (SELECT 1) one
    LEFT JOIN public.profiles p ON p.id = p_inviter_id;
$$;

CREATE OR REPLACE FUNCTION public.fn_club_invite_notify(
  p_user_id uuid, p_type text, p_title text, p_message text, p_action_url text, p_data jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF p_user_id IS NULL THEN RETURN; END IF;
  INSERT INTO public.notifications (user_id, type, title, message, data, action_url, read, is_read)
  VALUES (p_user_id, p_type, p_title, p_message, COALESCE(p_data, '{}'::jsonb), p_action_url, false, false);
EXCEPTION WHEN OTHERS THEN
  -- A notification is never allowed to undo a signup, a verification or a join.
  RAISE WARNING 'fn_club_invite_notify(%) failed: %', p_type, SQLERRM;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- fn_club_invite_link: the caller's own code for a club
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_club_invite_link(p_club_id uuid, p_device_id text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_member record;
  v_club   record;
  v_code   text;
  v_alpha  constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_try    integer := 0;
  v_device text := NULLIF(left(btrim(COALESCE(p_device_id, '')), 128), '');
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;

  SELECT id, club_id, name, slug INTO v_club FROM public.clubs WHERE id = p_club_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_found', 'error', 'Club not found');
  END IF;

  SELECT status, role INTO v_member FROM public.club_members
   WHERE club_id = p_club_id AND user_id = v_uid;
  IF NOT FOUND OR v_member.status NOT IN ('active', 'approved', 'automatic') THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_a_member',
                              'error', 'Only club members can invite players.');
  END IF;

  SELECT code INTO v_code FROM public.club_invite_links
   WHERE club_id = p_club_id AND inviter_id = v_uid;

  IF v_code IS NULL THEN
    LOOP
      v_try := v_try + 1;
      SELECT string_agg(substr(v_alpha, 1 + floor(random() * length(v_alpha))::int, 1), '')
        INTO v_code FROM generate_series(1, 7);
      BEGIN
        INSERT INTO public.club_invite_links (code, club_id, inviter_id, inviter_device_id)
        VALUES (v_code, p_club_id, v_uid, v_device);
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        -- Either the random code was taken, or a concurrent call created this
        -- inviter's row first. Prefer the existing row.
        SELECT code INTO v_code FROM public.club_invite_links
         WHERE club_id = p_club_id AND inviter_id = v_uid;
        EXIT WHEN v_code IS NOT NULL;
        IF v_try >= 8 THEN RAISE EXCEPTION 'Could not allocate an invite code'; END IF;
      END;
    END LOOP;
  ELSIF v_device IS NOT NULL THEN
    UPDATE public.club_invite_links SET inviter_device_id = v_device
     WHERE code = v_code AND inviter_device_id IS DISTINCT FROM v_device;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'code', v_code,
    'short_path', '/i/' || v_code,
    'join_path', public.fn_club_invite_join_path(p_club_id, v_uid, v_code),
    'club', jsonb_build_object('id', v_club.id, 'club_id', v_club.club_id, 'name', v_club.name, 'slug', v_club.slug)
  );
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- fn_club_invite_resolve: the landing page and the link preview read it through
-- the World Hub SERVER (service role), never anon from a browser; a signed-in
-- player may resolve a code in the app. The inviter opening their own link is
-- not counted as an open.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_club_invite_resolve(p_code text, p_count_click boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_code     text := upper(btrim(COALESCE(p_code, '')));
  v_link     record;
  v_club     record;
  v_inviter  record;
  v_active   boolean;
  v_playing  integer;
BEGIN
  IF v_code !~ '^[A-HJ-NP-Z2-9]{7}$' THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT * INTO v_link FROM public.club_invite_links WHERE code = v_code;
  IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;

  SELECT id, club_id, slug, name, description, logo_url, avatar_url, member_count, lifecycle_status, asset
    INTO v_club FROM public.clubs WHERE id = v_link.club_id;
  IF NOT FOUND OR COALESCE(v_club.lifecycle_status, 'active') <> 'active' THEN
    RETURN jsonb_build_object('found', false, 'code', v_code, 'reason', 'club_unavailable');
  END IF;

  SELECT id, username, player_number INTO v_inviter FROM public.profiles WHERE id = v_link.inviter_id;

  SELECT EXISTS (
    SELECT 1 FROM public.club_members cm
     WHERE cm.club_id = v_link.club_id AND cm.user_id = v_link.inviter_id
       AND cm.status IN ('active', 'approved', 'automatic')
  ) INTO v_active;

  BEGIN
    v_playing := public.get_club_players_playing(v_club.club_id::text);
  EXCEPTION WHEN OTHERS THEN
    v_playing := NULL;
  END;

  IF p_count_click AND v_uid IS DISTINCT FROM v_link.inviter_id THEN
    UPDATE public.club_invite_links
       SET click_count = click_count + 1, last_clicked_at = now()
     WHERE code = v_code;
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'code', v_code,
    'club', jsonb_build_object(
      'id', v_club.id, 'club_id', v_club.club_id, 'slug', v_club.slug, 'name', v_club.name,
      'description', v_club.description,
      'logo_url', COALESCE(v_club.logo_url, v_club.avatar_url),
      'member_count', COALESCE(v_club.member_count, 0),
      'players_playing', v_playing
    ),
    'inviter', jsonb_build_object(
      'alias', COALESCE(NULLIF(btrim(v_inviter.username), ''), 'A Club Member'),
      'player_number', v_inviter.player_number,
      'active', v_active
    ),
    'join_path', public.fn_club_invite_join_path(v_link.club_id, v_link.inviter_id, v_code),
    'expires_after_days', 30
  );
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Credit a referral once the referee's phone is verified
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_club_invite_mark_verified(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_me        record;
  v_row       record;
  v_inv_phone text;
  v_my_phone  text;
  v_alias     text;
  v_club_name text;
  v_count     integer := 0;
BEGIN
  SELECT id, username, phone, phone_verified INTO v_me FROM public.profiles WHERE id = p_user_id;
  IF NOT FOUND OR v_me.phone_verified IS NOT TRUE THEN RETURN 0; END IF;

  v_my_phone := right(regexp_replace(COALESCE(v_me.phone, ''), '\D', '', 'g'), 10);
  v_alias := COALESCE(NULLIF(btrim(v_me.username), ''), 'A New Player');

  FOR v_row IN
    SELECT a.* FROM public.club_invite_attributions a
     WHERE a.user_id = p_user_id AND a.status = 'signed_up'
     FOR UPDATE
  LOOP
    SELECT right(regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g'), 10)
      INTO v_inv_phone FROM public.profiles p WHERE p.id = v_row.inviter_id;

    IF length(v_my_phone) = 10 AND v_my_phone = v_inv_phone
       AND NOT public.fn_club_invite_is_exempt(p_user_id)
       AND NOT public.fn_club_invite_is_exempt(v_row.inviter_id) THEN
      UPDATE public.club_invite_attributions
         SET status = 'blocked', block_reason = 'same_phone'
       WHERE id = v_row.id;
      DELETE FROM public.referrals
       WHERE referee_id = p_user_id AND referrer_id = v_row.inviter_id AND status = 'pending';
      UPDATE public.profiles SET referred_by = NULL
       WHERE id = p_user_id AND referred_by = v_row.inviter_id;
      CONTINUE;
    END IF;

    UPDATE public.club_invite_attributions
       SET status = 'verified', verified_at = now()
     WHERE id = v_row.id;
    v_count := v_count + 1;

    IF v_row.fresh_signup THEN
      UPDATE public.referrals SET status = 'completed', completed_at = COALESCE(completed_at, now())
       WHERE referee_id = p_user_id AND referrer_id = v_row.inviter_id;
    END IF;

    SELECT name INTO v_club_name FROM public.clubs WHERE id = v_row.club_id;
    PERFORM public.fn_club_invite_notify(
      v_row.inviter_id, 'club_invite_verified',
      'Your Invite Verified Their Phone',
      v_alias || ' Verified Their Phone And Is Ready To Join ' || COALESCE(v_club_name, 'Your Club') || '.',
      '/hub/club-arena/clubs/' || v_row.club_id::text,
      jsonb_build_object('club_id', v_row.club_id, 'referee_id', p_user_id, 'code', v_row.code)
    );
  END LOOP;

  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION public.trg_club_invite_phone_verified()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  BEGIN
    PERFORM public.fn_club_invite_mark_verified(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    -- Crediting an invite must never be able to undo a phone verification.
    RAISE WARNING 'fn_club_invite_mark_verified(%) failed: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END $$;

-- CREATE OR REPLACE, not DROP + CREATE: DROP TRIGGER takes ACCESS EXCLUSIVE on
-- profiles, which queues behind every reader (a 30-second prune job holding an
-- ACCESS SHARE lock refused the first apply at lock_timeout) and blocks every
-- read while it waits. CREATE TRIGGER takes SHARE ROW EXCLUSIVE, which readers
-- never conflict with.
CREATE OR REPLACE TRIGGER trg_club_invite_phone_verified
  AFTER UPDATE OF phone_verified ON public.profiles
  FOR EACH ROW
  WHEN (NEW.phone_verified IS TRUE AND OLD.phone_verified IS DISTINCT FROM TRUE)
  EXECUTE FUNCTION public.trg_club_invite_phone_verified();

-- ─────────────────────────────────────────────────────────────────────────────
-- fn_club_invite_claim: attach the signed-in account to the link it came from
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_club_invite_claim(
  p_code text,
  p_device_id text DEFAULT NULL,
  p_first_clicked_at timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_code     text := upper(btrim(COALESCE(p_code, '')));
  v_device   text := NULLIF(left(btrim(COALESCE(p_device_id, '')), 128), '');
  v_clicked  timestamptz := LEAST(COALESCE(p_first_clicked_at, now()), now());
  v_link     record;
  v_club     record;
  v_me       record;
  v_existing record;
  v_member   text;
  v_fresh    boolean := false;
  v_status   text := 'signed_up';
  v_reason   text;
  v_exempt   boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;

  IF v_code !~ '^[A-HJ-NP-Z2-9]{7}$' THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_code', 'error', 'That Invite Link Is Not Valid.');
  END IF;

  SELECT * INTO v_link FROM public.club_invite_links WHERE code = v_code;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_code', 'error', 'That Invite Link Is Not Valid.');
  END IF;

  SELECT id, club_id, slug, name, lifecycle_status INTO v_club FROM public.clubs WHERE id = v_link.club_id;
  IF NOT FOUND OR COALESCE(v_club.lifecycle_status, 'active') <> 'active' THEN
    RETURN jsonb_build_object('success', false, 'code', 'club_unavailable', 'error', 'That Club Is No Longer Available.');
  END IF;

  -- Attribution lasts 30 days from the first click.
  IF v_clicked < now() - interval '30 days' THEN
    RETURN jsonb_build_object('success', false, 'code', 'expired', 'error', 'That Invite Has Expired.');
  END IF;

  IF v_link.inviter_id = v_uid THEN
    RETURN jsonb_build_object('success', false, 'code', 'self_referral', 'error', 'You Cannot Invite Yourself.',
                              'club', jsonb_build_object('id', v_club.id, 'slug', v_club.slug, 'name', v_club.name));
  END IF;

  SELECT status INTO v_member FROM public.club_members WHERE club_id = v_link.club_id AND user_id = v_uid;
  IF v_member IN ('active', 'approved', 'automatic') THEN
    RETURN jsonb_build_object('success', true, 'status', 'already_member',
      'club', jsonb_build_object('id', v_club.id, 'club_id', v_club.club_id, 'slug', v_club.slug, 'name', v_club.name),
      'join_path', '/hub/club-arena/clubs/' || COALESCE(v_club.slug, v_club.id::text));
  END IF;

  -- First link wins, per club.
  SELECT * INTO v_existing FROM public.club_invite_attributions
   WHERE user_id = v_uid AND club_id = v_link.club_id;
  IF FOUND THEN
    RETURN jsonb_build_object('success', true, 'status', v_existing.status, 'first_wins', v_existing.code IS DISTINCT FROM v_code,
      'club', jsonb_build_object('id', v_club.id, 'club_id', v_club.club_id, 'slug', v_club.slug, 'name', v_club.name),
      'join_path', public.fn_club_invite_join_path(v_existing.club_id, v_existing.inviter_id, v_existing.code));
  END IF;

  SELECT id, username, created_at, phone_verified, referred_by INTO v_me FROM public.profiles WHERE id = v_uid;

  -- A FRESH signup is an account created after the link was first opened
  -- (an hour of slack for clock skew). Only a fresh signup earns the inviter
  -- platform referral credit; an existing account joining through a link is
  -- still placed in the inviter's downline when it joins.
  v_fresh := v_me.created_at IS NOT NULL AND v_me.created_at >= v_clicked - interval '1 hour';

  v_exempt := public.fn_club_invite_is_exempt(v_uid) OR public.fn_club_invite_is_exempt(v_link.inviter_id);
  IF NOT v_exempt AND v_device IS NOT NULL AND v_device = v_link.inviter_device_id THEN
    v_status := 'blocked';
    v_reason := 'same_device';
  END IF;

  INSERT INTO public.club_invite_attributions
    (code, club_id, inviter_id, user_id, status, block_reason, fresh_signup, first_clicked_at, device_id)
  VALUES
    (v_code, v_link.club_id, v_link.inviter_id, v_uid, v_status, v_reason, v_fresh, v_clicked, v_device)
  ON CONFLICT (user_id, club_id) DO NOTHING;

  IF v_status <> 'blocked' AND v_fresh THEN
    INSERT INTO public.referrals (referrer_id, referee_id, referral_code_used, status)
    VALUES (v_link.inviter_id, v_uid,
            COALESCE((SELECT player_number FROM public.profiles WHERE id = v_link.inviter_id), v_code),
            'pending')
    ON CONFLICT (referee_id) DO NOTHING;

    UPDATE public.profiles SET referred_by = v_link.inviter_id
     WHERE id = v_uid AND referred_by IS NULL
       AND EXISTS (SELECT 1 FROM public.referrals r WHERE r.referee_id = v_uid AND r.referrer_id = v_link.inviter_id);

    PERFORM public.fn_club_invite_notify(
      v_link.inviter_id, 'club_invite_signup',
      'New Signup From Your Invite',
      COALESCE(NULLIF(btrim(v_me.username), ''), 'A New Player') || ' Created An Account From Your Invite To ' || v_club.name || '.',
      '/hub/club-arena/clubs/' || v_club.id::text,
      jsonb_build_object('club_id', v_club.id, 'referee_id', v_uid, 'code', v_code)
    );
  END IF;

  -- Already verified (an existing account, or verification raced the claim).
  IF v_status <> 'blocked' AND v_me.phone_verified IS TRUE THEN
    PERFORM public.fn_club_invite_mark_verified(v_uid);
  END IF;

  SELECT status INTO v_status FROM public.club_invite_attributions WHERE user_id = v_uid AND club_id = v_link.club_id;

  RETURN jsonb_build_object(
    'success', true,
    'status', v_status,
    'fresh_signup', v_fresh,
    'club', jsonb_build_object('id', v_club.id, 'club_id', v_club.club_id, 'slug', v_club.slug, 'name', v_club.name),
    'join_path', public.fn_club_invite_join_path(v_link.club_id, v_link.inviter_id, v_code)
  );
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- fn_club_invite_pending: the club this player still has to join
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_club_invite_pending()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row record;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('pending', false); END IF;

  SELECT a.club_id, a.inviter_id, a.code, a.status, c.name, c.slug, c.club_id AS club_number,
         COALESCE(c.logo_url, c.avatar_url) AS logo_url, p.username AS inviter_alias
    INTO v_row
    FROM public.club_invite_attributions a
    JOIN public.clubs c ON c.id = a.club_id AND COALESCE(c.lifecycle_status, 'active') = 'active'
    LEFT JOIN public.profiles p ON p.id = a.inviter_id
   WHERE a.user_id = v_uid
     AND a.status IN ('signed_up', 'verified')
     AND a.claimed_at > now() - interval '30 days'
     AND NOT EXISTS (
       SELECT 1 FROM public.club_members cm
        WHERE cm.club_id = a.club_id AND cm.user_id = v_uid
          AND cm.status IN ('active', 'approved', 'automatic', 'pending')
     )
   ORDER BY a.claimed_at ASC
   LIMIT 1;

  IF NOT FOUND THEN RETURN jsonb_build_object('pending', false); END IF;

  RETURN jsonb_build_object(
    'pending', true,
    'status', v_row.status,
    'club', jsonb_build_object('id', v_row.club_id, 'club_id', v_row.club_number, 'slug', v_row.slug,
                               'name', v_row.name, 'logo_url', v_row.logo_url),
    'inviter_alias', COALESCE(NULLIF(btrim(v_row.inviter_alias), ''), 'A Club Member'),
    'join_path', public.fn_club_invite_join_path(v_row.club_id, v_row.inviter_id, v_row.code)
  );
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Stats
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_club_invite_my_stats(p_club_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT jsonb_build_object(
    'code', (SELECT code FROM public.club_invite_links WHERE club_id = p_club_id AND inviter_id = auth.uid()),
    'opened', COALESCE((SELECT click_count FROM public.club_invite_links WHERE club_id = p_club_id AND inviter_id = auth.uid()), 0),
    'signed_up', (SELECT count(*) FROM public.club_invite_attributions a
                   WHERE a.club_id = p_club_id AND a.inviter_id = auth.uid() AND a.fresh_signup AND a.status <> 'blocked'),
    'verified', (SELECT count(*) FROM public.club_invite_attributions a
                  WHERE a.club_id = p_club_id AND a.inviter_id = auth.uid() AND a.status IN ('verified','joined') AND a.verified_at IS NOT NULL),
    'joined', (SELECT count(*) FROM public.club_invite_attributions a
                WHERE a.club_id = p_club_id AND a.inviter_id = auth.uid() AND a.status = 'joined')
  ) WHERE auth.uid() IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.fn_club_invite_club_stats(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_role text;
  v_rows jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;

  SELECT role INTO v_role FROM public.club_members
   WHERE club_id = p_club_id AND user_id = v_uid AND status IN ('active','approved');
  IF v_role IS NULL AND EXISTS (SELECT 1 FROM public.clubs WHERE id = p_club_id AND owner_id = v_uid) THEN
    v_role := 'owner';
  END IF;
  IF v_role IS NULL OR v_role NOT IN ('owner','co_owner','admin','super_agent','agent','sub_agent') THEN
    RETURN jsonb_build_object('allowed', false, 'rows', '[]'::jsonb);
  END IF;

  WITH inviters AS (
    SELECT l.inviter_id, l.click_count FROM public.club_invite_links l WHERE l.club_id = p_club_id
    UNION
    SELECT a.inviter_id, 0 FROM public.club_invite_attributions a
     WHERE a.club_id = p_club_id
       AND NOT EXISTS (SELECT 1 FROM public.club_invite_links l2 WHERE l2.club_id = p_club_id AND l2.inviter_id = a.inviter_id)
  ), scoped AS (
    -- Owners, co-owners and admins see the whole club. An agent sees their own
    -- invites and those of the players directly under them.
    SELECT i.* FROM inviters i
     WHERE v_role IN ('owner','co_owner','admin')
        OR i.inviter_id = v_uid
        OR EXISTS (SELECT 1 FROM public.club_members cm
                    WHERE cm.club_id = p_club_id AND cm.user_id = i.inviter_id AND cm.agent_id = v_uid)
  )
  SELECT COALESCE(jsonb_agg(row_to_json(r)::jsonb ORDER BY r.joined DESC, r.signed_up DESC, r.opened DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT s.inviter_id,
             COALESCE(NULLIF(btrim(p.username), ''), 'Unknown Player') AS alias,
             p.player_number,
             max(s.click_count) AS opened,
             (SELECT count(*) FROM public.club_invite_attributions a WHERE a.club_id = p_club_id AND a.inviter_id = s.inviter_id AND a.fresh_signup AND a.status <> 'blocked') AS signed_up,
             (SELECT count(*) FROM public.club_invite_attributions a WHERE a.club_id = p_club_id AND a.inviter_id = s.inviter_id AND a.verified_at IS NOT NULL AND a.status IN ('verified','joined')) AS verified,
             (SELECT count(*) FROM public.club_invite_attributions a WHERE a.club_id = p_club_id AND a.inviter_id = s.inviter_id AND a.status = 'joined') AS joined,
             (SELECT count(*) FROM public.club_invite_attributions a WHERE a.club_id = p_club_id AND a.inviter_id = s.inviter_id AND a.status = 'blocked') AS blocked
        FROM scoped s
        LEFT JOIN public.profiles p ON p.id = s.inviter_id
       GROUP BY s.inviter_id, p.username, p.player_number
    ) r;

  RETURN jsonb_build_object('allowed', true, 'scope', CASE WHEN v_role IN ('owner','co_owner','admin') THEN 'club' ELSE 'downline' END, 'rows', v_rows);
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- fn_redeem_club_invite_code: first-wins inviter, departed inviter routes to
-- the owner, blocked self-referrals never admit, every join is recorded.
-- Everything not named here is the previous body unchanged.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_redeem_club_invite_code(p_club_id uuid, p_user_id uuid, p_referral_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_caller            uuid := auth.uid();
  v_code              text := btrim(coalesce(p_referral_code, ''));
  v_inviter           record;
  v_inviter_member    record;
  v_member            record;
  v_effective_agent   uuid;
  v_is_agent          boolean;
  v_agent_name        text;
  v_new_status        text;
  v_attr              record;
  v_inviter_settled   boolean;
  v_club_name         text;
  v_link_code         text;
  v_joiner_alias      text;
BEGIN
  -- ── Authorization ────────────────────────────────────────────────────────
  IF v_caller IS NOT NULL AND v_caller <> p_user_id THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_your_membership',
                              'error', 'You can only redeem an invite for yourself.');
  END IF;

  IF v_code = '' THEN
    RETURN jsonb_build_object('success', false, 'code', 'empty_code',
                              'error', 'No referral code supplied.');
  END IF;

  -- ── 0. First link wins ───────────────────────────────────────────────────
  -- A player who arrived through an attributed invite belongs to THAT inviter,
  -- whatever ?ref= a later link carries.
  SELECT * INTO v_attr FROM club_invite_attributions
   WHERE user_id = p_user_id AND club_id = p_club_id
   FOR UPDATE;

  IF v_attr.id IS NOT NULL AND v_attr.status = 'blocked' THEN
    -- A refused self-referral neither admits nor places. The player keeps the
    -- membership exactly as fn_join_club made it (pending clubs stay pending
    -- for the owner).
    SELECT * INTO v_member FROM club_members WHERE club_id = p_club_id AND user_id = p_user_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'code', 'not_a_member',
                                'error', 'User is not a member of this club.');
    END IF;
    RETURN jsonb_build_object('success', true, 'status', v_member.status,
                              'agent_id', v_member.agent_id, 'referral_skipped', v_attr.block_reason);
  END IF;

  -- ── 1. Resolve the inviter ───────────────────────────────────────────────
  IF v_attr.id IS NOT NULL THEN
    SELECT p.id, p.username, p.player_number INTO v_inviter FROM profiles p WHERE p.id = v_attr.inviter_id;
  ELSE
    SELECT p.id, p.username, p.player_number
      INTO v_inviter
      FROM profiles p
     WHERE p.player_number = v_code
        OR (v_code ~ '^[0-9]+$' AND p.player_number ~ '^[0-9]+$'
            AND p.player_number::bigint = v_code::bigint)
        OR (v_code ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            AND p.id = v_code::uuid)
     LIMIT 1;
  END IF;

  IF v_inviter.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'unknown_inviter',
                              'error', 'Invalid referral code.');
  END IF;

  IF v_inviter.id = p_user_id THEN
    RETURN jsonb_build_object('success', false, 'code', 'self_referral',
                              'error', 'You cannot invite yourself.');
  END IF;

  -- ── 2. Inviter standing ──────────────────────────────────────────────────
  -- An inviter who has left the club or been suspended no longer fails the
  -- join (Dan 2026-10-15): the player is routed to the club owner instead. Such
  -- an invite does not ADMIT on its own, though - the owner approves.
  SELECT * INTO v_inviter_member
    FROM club_members
   WHERE club_id = p_club_id AND user_id = v_inviter.id;

  v_inviter_settled := FOUND AND v_inviter_member.status IN ('active', 'approved', 'automatic');

  -- ── 3. Effective upline ──────────────────────────────────────────────────
  IF v_inviter_settled THEN
    SELECT true INTO v_is_agent
      FROM agents
     WHERE club_id = p_club_id AND user_id = v_inviter.id AND status = 'active';

    IF coalesce(v_is_agent, false) THEN
      v_effective_agent := v_inviter.id;
    ELSE
      v_effective_agent := v_inviter_member.agent_id;
    END IF;
  ELSE
    v_effective_agent := NULL;   -- directly under the club owner
  END IF;

  -- ── 4. The joining user must already have a membership row ───────────────
  SELECT * INTO v_member
    FROM club_members
   WHERE club_id = p_club_id AND user_id = p_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_a_member',
                              'error', 'User is not a member of this club.');
  END IF;

  IF v_member.status NOT IN ('active', 'approved', 'pending') THEN
    RETURN jsonb_build_object('success', false, 'code', 'membership_blocked',
                              'error', 'This membership cannot be activated.');
  END IF;

  -- ── 5. Attach and admit ──────────────────────────────────────────────────
  v_new_status := CASE WHEN v_member.status = 'pending' AND v_inviter_settled THEN 'active' ELSE v_member.status END;
  -- ca-commerce-admission: an invite admitting a PENDING member makes a NEW
  -- approved member (R2 4.3, D22). Shadow records and proceeds; enforced
  -- keeps the member pending for the owner instead.
  IF v_member.status = 'pending' AND v_new_status = 'active' THEN
    PERFORM public.fn_club_membership_lock(p_user_id);
    DECLARE
      v_ca_admission jsonb := public.fn_ca_commerce_admit('club', p_club_id, 'join_member', 'fn_redeem_club_invite_code', p_user_id);
    BEGIN
      IF NOT COALESCE((v_ca_admission->>'allowed')::boolean, true) THEN
        v_new_status := 'pending';
      END IF;
    END;
  END IF;

  UPDATE club_members
     SET agent_id   = coalesce(agent_id, v_effective_agent),
         invited_by = coalesce(invited_by, v_inviter.id),
         status     = v_new_status,
         updated_at = now()
   WHERE club_id = p_club_id AND user_id = p_user_id
  RETURNING * INTO v_member;

  -- ── 6. Re-derive the upline's player counts ──────────────────────────────
  IF v_member.agent_id IS NOT NULL THEN
    UPDATE agents
       SET total_players = (SELECT count(*) FROM club_members
                             WHERE agent_id = v_member.agent_id AND club_id = p_club_id),
           active_player_count = (SELECT count(*) FROM club_members
                                   WHERE agent_id = v_member.agent_id AND club_id = p_club_id
                                     AND status IN ('active', 'approved')),
           updated_at = now()
     WHERE club_id = p_club_id AND user_id = v_member.agent_id;
  END IF;

  -- ── 7. Record the join against the invite and tell the inviter ───────────
  SELECT code INTO v_link_code FROM club_invite_links
   WHERE club_id = p_club_id AND inviter_id = v_inviter.id;

  IF v_attr.id IS NOT NULL THEN
    UPDATE club_invite_attributions
       SET status = 'joined', joined_at = COALESCE(joined_at, now())
     WHERE id = v_attr.id AND status IN ('signed_up', 'verified');
  ELSE
    INSERT INTO club_invite_attributions (code, club_id, inviter_id, user_id, status, joined_at)
    VALUES (v_link_code, p_club_id, v_inviter.id, p_user_id, 'joined', now())
    ON CONFLICT (user_id, club_id) DO NOTHING;
  END IF;

  IF v_attr.id IS NULL OR v_attr.status IN ('signed_up', 'verified') THEN
    SELECT name INTO v_club_name FROM clubs WHERE id = p_club_id;
    SELECT COALESCE(NULLIF(btrim(username), ''), 'A New Player') INTO v_joiner_alias FROM profiles WHERE id = p_user_id;
    PERFORM public.fn_club_invite_notify(
      v_inviter.id, 'club_invite_joined',
      CASE WHEN v_member.status = 'pending' THEN 'Your Invite Requested To Join' ELSE 'Your Invite Joined The Club' END,
      COALESCE(v_joiner_alias, 'A New Player')
        || CASE WHEN v_member.status = 'pending' THEN ' Requested To Join ' ELSE ' Joined ' END
        || COALESCE(v_club_name, 'Your Club') || ' From Your Invite.',
      '/hub/club-arena/clubs/' || p_club_id::text,
      jsonb_build_object('club_id', p_club_id, 'referee_id', p_user_id, 'agent_id', v_member.agent_id)
    );
  END IF;

  SELECT username INTO v_agent_name FROM profiles WHERE id = v_member.agent_id;

  RETURN jsonb_build_object(
    'success',     true,
    'status',      v_member.status,
    'agent_id',    v_member.agent_id,
    'agent_name',  v_agent_name,
    'inviter_id',  v_inviter.id,
    'inviter_name', v_inviter.username,
    'routed_to_owner', NOT v_inviter_settled
  );
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.fn_club_invite_is_exempt(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_club_invite_join_path(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_club_invite_notify(uuid, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_club_invite_mark_verified(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_club_invite_phone_verified() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.fn_club_invite_link(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_invite_link(uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.fn_club_invite_resolve(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_invite_resolve(text, boolean) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.fn_club_invite_claim(text, text, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_invite_claim(text, text, timestamptz) TO authenticated;

REVOKE ALL ON FUNCTION public.fn_club_invite_pending() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_invite_pending() TO authenticated;

REVOKE ALL ON FUNCTION public.fn_club_invite_my_stats(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_invite_my_stats(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.fn_club_invite_club_stats(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_invite_club_stats(uuid) TO authenticated;

GRANT ALL ON public.club_invite_links TO service_role;
GRANT ALL ON public.club_invite_attributions TO service_role;

COMMIT;
