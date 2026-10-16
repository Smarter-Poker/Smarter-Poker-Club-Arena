-- 20261016040136_club_invite_deep_sweep_hardening.sql
--
-- Version reserved by scripts/new-migration.mjs.
--
-- WHAT THIS CHANGES, AND WHY (second audit of Share & Invite, 2026-10-16):
--
-- fn_club_invite_resolve
--   Only the landing page's server request (service role, auth.uid() NULL)
--   counts an open. Any signed-in caller could previously inflate a link's
--   "opened" figure by calling it in a loop.
--
-- fn_club_invite_claim
--   * The client-reported first click can no longer predate the link, and a
--     FRESH signup must also postdate the link. Before, an account under 30
--     days old could send an early timestamp and create a referral to any
--     inviter it chose.
--   * An unjoined attribution older than 30 days lapses and gives way to the
--     new link (first wins inside the window, as designed).
--   * The insert returns its id; a concurrent claim that lost the race answers
--     with the winning attribution and credits nobody, so attribution and the
--     platform referral can never split between two inviters.
--
-- fn_club_invite_pending
--   Any club_members row (whatever its status) ends the forward: a refused
--   member is no longer sent back to the join page every session.
--
-- fn_redeem_club_invite_code
--   * An unjoined attribution older than 30 days lapses here too.
--   * A self-referral block binds only the inviter it was raised against; a
--     different inviter's code places the player normally.
--   * A joining member with status 'automatic' is placed like any member.
--   * Only a call that admitted a pending member or placed one with no upline
--     records a join and notifies the inviter. Re-running an invite for a
--     settled member no longer inflates "joined" or sends a false message.
--
-- Function bodies only. One transaction (club-arena CLAUDE.md, production DDL
-- policy).

BEGIN;

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

  SELECT id, COALESCE(NULLIF(btrim(alias), ''), username) AS username, player_number INTO v_inviter FROM public.profiles WHERE id = v_link.inviter_id;

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

  -- Only the landing page's server request (service role, no auth.uid()) counts
  -- an open; it skips link-preview bots and repeat opens from the same browser.
  -- A signed-in caller can no longer inflate the count.
  IF p_count_click AND v_uid IS NULL THEN
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
  v_inserted uuid;
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

  -- The first click is client-reported: it can never predate the link itself.
  v_clicked := GREATEST(v_clicked, v_link.created_at);

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

  -- First link wins, per club, for 30 days. An attribution that never reached
  -- the join inside its window has lapsed and gives way to the new link.
  DELETE FROM public.club_invite_attributions
   WHERE user_id = v_uid AND club_id = v_link.club_id
     AND status IN ('signed_up', 'verified')
     AND claimed_at <= now() - interval '30 days';
  SELECT * INTO v_existing FROM public.club_invite_attributions
   WHERE user_id = v_uid AND club_id = v_link.club_id;
  IF FOUND THEN
    RETURN jsonb_build_object('success', true, 'status', v_existing.status, 'first_wins', v_existing.code IS DISTINCT FROM v_code,
      'club', jsonb_build_object('id', v_club.id, 'club_id', v_club.club_id, 'slug', v_club.slug, 'name', v_club.name),
      'join_path', public.fn_club_invite_join_path(v_existing.club_id, v_existing.inviter_id, v_existing.code));
  END IF;

  SELECT id, COALESCE(NULLIF(btrim(alias), ''), username) AS username, created_at, phone_verified, referred_by INTO v_me FROM public.profiles WHERE id = v_uid;

  -- A FRESH signup is an account created after the link was first opened
  -- (an hour of slack for clock skew). Only a fresh signup earns the inviter
  -- platform referral credit; an existing account joining through a link is
  -- still placed in the inviter's downline when it joins.
  v_fresh := v_me.created_at IS NOT NULL
         AND v_me.created_at >= v_clicked - interval '1 hour'
         AND v_me.created_at >= v_link.created_at;

  v_exempt := public.fn_club_invite_is_exempt(v_uid) OR public.fn_club_invite_is_exempt(v_link.inviter_id);
  IF NOT v_exempt AND v_device IS NOT NULL AND v_device = v_link.inviter_device_id THEN
    v_status := 'blocked';
    v_reason := 'same_device';
  END IF;

  INSERT INTO public.club_invite_attributions
    (code, club_id, inviter_id, user_id, status, block_reason, fresh_signup, first_clicked_at, device_id)
  VALUES
    (v_code, v_link.club_id, v_link.inviter_id, v_uid, v_status, v_reason, v_fresh, v_clicked, v_device)
  ON CONFLICT (user_id, club_id) DO NOTHING
  RETURNING id INTO v_inserted;

  -- A concurrent claim won the row: answer with ITS attribution and credit
  -- nobody from this call, so attribution and referral can never split.
  IF v_inserted IS NULL THEN
    SELECT * INTO v_existing FROM public.club_invite_attributions
     WHERE user_id = v_uid AND club_id = v_link.club_id;
    RETURN jsonb_build_object('success', true, 'status', v_existing.status, 'first_wins', v_existing.code IS DISTINCT FROM v_code,
      'club', jsonb_build_object('id', v_club.id, 'club_id', v_club.club_id, 'slug', v_club.slug, 'name', v_club.name),
      'join_path', public.fn_club_invite_join_path(v_existing.club_id, v_existing.inviter_id, v_existing.code));
  END IF;

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
         COALESCE(c.logo_url, c.avatar_url) AS logo_url, COALESCE(NULLIF(btrim(p.alias), ''), p.username) AS inviter_alias
    INTO v_row
    FROM public.club_invite_attributions a
    JOIN public.clubs c ON c.id = a.club_id AND COALESCE(c.lifecycle_status, 'active') = 'active'
    LEFT JOIN public.profiles p ON p.id = a.inviter_id
   WHERE a.user_id = v_uid
     AND a.status IN ('signed_up', 'verified')
     AND a.claimed_at > now() - interval '30 days'
     -- Any membership row, whatever its status, means the join page has
     -- nothing to offer: a member is in, a pending one waits for the owner,
     -- and a refused one must not be sent back every session.
     AND NOT EXISTS (
       SELECT 1 FROM public.club_members cm
        WHERE cm.club_id = a.club_id AND cm.user_id = v_uid
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
  v_code_inviter      uuid;
  v_prev_status       text;
  v_prev_agent        uuid;
  v_changed           boolean;
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
  SELECT p.id INTO v_code_inviter
    FROM profiles p
   WHERE p.player_number = v_code
      OR (v_code ~ '^[0-9]+$' AND p.player_number ~ '^[0-9]+$'
          AND p.player_number::bigint = v_code::bigint)
      OR (v_code ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND p.id = v_code::uuid)
   LIMIT 1;

  -- An unjoined attribution lapses after 30 days, as it does everywhere else.
  DELETE FROM club_invite_attributions
   WHERE user_id = p_user_id AND club_id = p_club_id
     AND status IN ('signed_up', 'verified')
     AND claimed_at <= now() - interval '30 days';

  SELECT * INTO v_attr FROM club_invite_attributions
   WHERE user_id = p_user_id AND club_id = p_club_id
   FOR UPDATE;

  -- A self-referral block binds only the inviter it was raised against. A
  -- different inviter's code places the player normally.
  IF v_attr.id IS NOT NULL AND v_attr.status = 'blocked'
     AND v_code_inviter IS NOT NULL AND v_code_inviter <> v_attr.inviter_id THEN
    DELETE FROM club_invite_attributions WHERE id = v_attr.id;
    SELECT * INTO v_attr FROM club_invite_attributions
     WHERE user_id = p_user_id AND club_id = p_club_id;
  END IF;

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
    SELECT p.id, p.username, p.player_number INTO v_inviter FROM profiles p WHERE p.id = v_code_inviter;
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

  IF v_member.status NOT IN ('active', 'approved', 'automatic', 'pending') THEN
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

  v_prev_status := v_member.status;
  v_prev_agent  := v_member.agent_id;

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
  -- Only a call that actually did something is a join: admitted a pending
  -- member, or placed one who had no upline. Re-running an invite for a
  -- settled member records nothing and notifies nobody.
  v_changed := (v_prev_status = 'pending' AND v_member.status <> 'pending')
               OR (v_prev_agent IS NULL AND v_member.agent_id IS NOT NULL)
               OR v_attr.id IS NOT NULL;
  SELECT code INTO v_link_code FROM club_invite_links
   WHERE club_id = p_club_id AND inviter_id = v_inviter.id;

  IF v_attr.id IS NOT NULL THEN
    UPDATE club_invite_attributions
       SET status = 'joined', joined_at = COALESCE(joined_at, now())
     WHERE id = v_attr.id AND status IN ('signed_up', 'verified');
  ELSIF v_changed THEN
    INSERT INTO club_invite_attributions (code, club_id, inviter_id, user_id, status, joined_at)
    VALUES (v_link_code, p_club_id, v_inviter.id, p_user_id, 'joined', now())
    ON CONFLICT (user_id, club_id) DO NOTHING;
  END IF;

  IF v_changed AND (v_attr.id IS NULL OR v_attr.status IN ('signed_up', 'verified')) THEN
    SELECT name INTO v_club_name FROM clubs WHERE id = p_club_id;
    SELECT COALESCE(NULLIF(btrim(alias), ''), NULLIF(btrim(username), ''), 'A New Player') INTO v_joiner_alias FROM profiles WHERE id = p_user_id;
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

COMMIT;
