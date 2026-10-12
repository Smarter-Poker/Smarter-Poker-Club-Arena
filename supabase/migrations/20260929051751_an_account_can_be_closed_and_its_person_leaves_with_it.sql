-- 20260929051751_an_account_can_be_closed_and_its_person_leaves_with_it
--
-- WHAT WAS WRONG (found 2026-09-29 from the Club Arena app on the Android
-- emulator: Settings, Close Account, Close My Account -> HTTP 500)
--
-- Nobody could delete their account - not from the app, not from the World
-- Hub's settings page; both call the World Hub's DELETE
-- /api/auth/delete-account. That endpoint hard-deleted rows with the service
-- role and then hard-deleted the Auth user, and the database has since made
-- two things true that it was never taught:
--   1. service_role holds no write privilege on cashout_requests (money moves
--      only through the cashier's definer functions), so its first write -
--      "cancel pending cashouts" - failed with 42501 for EVERY account;
--   2. financial journals are append-only (trg_ca_append_only), and every
--      account is born with one: The Mint's signup grant in
--      diamond_transactions. diamond_transactions references profiles AND
--      auth.users ON DELETE CASCADE, so deleting either cascades into the
--      journal and is refused (P0403). No account can be hard-deleted.
-- Apple (App Review 5.1.1(v)) and Google Play both require that an account
-- created in the app can be deleted from the app. This is that path.
--
-- WHAT THIS DOES
--
-- fn_close_account(p_user_id) closes the account in ONE transaction.
--
-- It refuses, changing nothing, while the player still holds money or
-- authority. The rules are the club's own - the settlement checks the staff
-- departure path (fn_remove_settled_club_member) applies to one club, applied
-- to every club - and then the platform's financial closure precheck
-- (fn_ca_gdpr_financial_precheck) has the last word, so a blocker added there
-- later is honoured here without an edit. Reasons, in the order asked:
--   seated            a seat not yet left
--   tournament_entry  registered or playing in a tournament that is neither
--                     completed nor cancelled (a finished tournament cannot
--                     hold an entry; 49 such stale rows exist and must not
--                     trap their players forever)
--   pending_cashout   pending, approved, cancelling or completing - as the
--                     player or as the agent
--   escrow            chips in an unreleased escrow or a held escrow hold
--   chip_request      a pending chip request, either side
--   club_chips        chips, held, locked, promo, credit used or club
--                     diamonds in any membership
--   wallet_balance    any wallet balance or locked balance
--   open_ticket       an issued tournament ticket
--   club_agent        any agent row, in any status
--   downline          an active member whose agent is this player
--   club_owner        owner of an active club
--   club_staff        co-owner or admin of a club
--   union_owner       owner of a union
--   financial         anything else the precheck lists (blockers attached)
--
-- Then it:
--   * leaves every club the way the club's departure path does: membership
--     'departed', inactive, departed_at/by, departure_reason 'Account Closed',
--     an audit_trail row per club. The membership row is kept - a membership
--     is part of the club's operating record. A Diamond Arena membership
--     keeps its 'automatic' status (the arena's guard requires it). The name
--     the club shows for the member is removed. A retired club is read-only
--     and is left as it is;
--   * deletes the personal, non-financial rows: friendships and friend
--     requests (both ways), sessions, MFA factors, push subscriptions,
--     notification preferences, and notifications - except any an invoice
--     delivery or an accounting push points at, which are accounting records;
--   * scrubs the person from the profile - every name, contact, location,
--     social link, avatar, bio, date of birth and saved preference - leaving
--     a tombstone username and status 'deleted', and does the same to the
--     legacy public.users mirror;
--   * records the closure in gdpr_deletion_requests (status 'anonymized');
--     the World Hub marks it 'completed' once the Auth user is gone.
-- Financial journals are KEPT, keyed only by the account's id, which after
-- this and the Auth soft-delete (the World Hub calls
-- auth.admin.deleteUser(id, true): email and phone obfuscated, identities and
-- sessions removed, the row kept so nothing cascades) points at nobody.
--
-- Callable by service_role only; the World Hub endpoint authenticates the
-- player and passes their own id. Idempotent: a closed account answers
-- already_closed with its open request id, so a retry can finish the Auth
-- step.
--
-- MEASURED FIRST: see the changelog entry of the same name.

BEGIN;

-- The money guard (fn_ca_money_rpc_registry_guard) sees UPDATE club_members
-- beside the balance column names this function reads. It moves no money: it
-- reads balances only to refuse, and writes only lifecycle and name columns.
INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_close_account', 'system',
   'Closes an account (App Review 5.1.1(v)). Moves no money: it reads every balance, credit line, escrow, ticket, seat and tournament entry only to refuse while one remains, then departs memberships through the lifecycle columns (membership_lifecycle_status, status, is_active, departed_*, display_name) and scrubs personal data from profiles and users. No balance column is written and no journal row is touched. Service-role only.')
ON CONFLICT (proname) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_close_account(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_status text;
  v_club uuid;
  v_precheck jsonb;
  v_tombstone text;
  v_departed integer := 0;
  v_n integer;
  v_deleted jsonb := '{}'::jsonb;
  v_request_id uuid;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_user');
  END IF;

  SELECT p.status INTO v_status FROM public.profiles p WHERE p.id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'profile_not_found');
  END IF;
  IF v_status = 'deleted' THEN
    SELECT g.id INTO v_request_id
      FROM public.gdpr_deletion_requests g
     WHERE g.user_id = p_user_id AND g.status = 'anonymized'
     ORDER BY g.created_at DESC
     LIMIT 1;
    RETURN jsonb_build_object('ok', true, 'already_closed', true, 'request_id', v_request_id);
  END IF;

  -- Serialise with every cashier writer the way the club's departure path
  -- does: the hierarchy lock of each club (in one order), then the rows.
  FOR v_club IN
    SELECT DISTINCT cm.club_id FROM public.club_members cm
     WHERE cm.user_id = p_user_id
     ORDER BY cm.club_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:' || v_club::text, 0));
  END LOOP;
  PERFORM 1 FROM public.club_members cm
   WHERE cm.user_id = p_user_id
   ORDER BY cm.club_id
   FOR UPDATE;

  -- Money and authority first: the player settles, then closes.
  IF EXISTS (SELECT 1 FROM public.table_seats ts
              WHERE ts.user_id = p_user_id AND ts.left_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'seated');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_players tp
               JOIN public.tournaments tr ON tr.id = tp.tournament_id
              WHERE tp.user_id = p_user_id
                AND tp.status IN ('registered', 'playing')
                AND tr.status NOT IN ('COMPLETED', 'CANCELLED')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_entry');
  END IF;
  IF EXISTS (SELECT 1 FROM public.cashout_requests cr
              WHERE (cr.player_id = p_user_id OR cr.agent_id = p_user_id)
                AND cr.status IN ('pending', 'approved', 'cancelling', 'completing')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pending_cashout');
  END IF;
  IF EXISTS (SELECT 1 FROM public.chip_escrow ce
              WHERE ce.player_id = p_user_id AND ce.released_at IS NULL)
     OR EXISTS (SELECT 1 FROM public.chip_escrow_holds h
                 WHERE h.user_id = p_user_id AND h.status = 'held') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'escrow');
  END IF;
  IF EXISTS (SELECT 1 FROM public.chip_requests r
              WHERE (r.requester_id = p_user_id OR r.approver_id = p_user_id)
                AND r.status = 'pending') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'chip_request');
  END IF;
  IF EXISTS (SELECT 1 FROM public.club_members cm
              WHERE cm.user_id = p_user_id
                AND abs(COALESCE(cm.chip_balance, 0)) + abs(COALESCE(cm.held_chips, 0))
                  + abs(COALESCE(cm.locked_chips, 0)) + abs(COALESCE(cm.promo_balance, 0))
                  + abs(COALESCE(cm.credit_used, 0)) + abs(COALESCE(cm.diamonds, 0)) <> 0) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'club_chips');
  END IF;
  IF EXISTS (SELECT 1 FROM public.wallets w
              WHERE w.user_id = p_user_id
                AND (COALESCE(w.balance, 0) <> 0 OR COALESCE(w.locked_balance, 0) <> 0)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'wallet_balance');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_tickets t
              WHERE t.holder_id = p_user_id AND t.status = 'issued') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'open_ticket');
  END IF;
  IF EXISTS (SELECT 1 FROM public.agents a WHERE a.user_id = p_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'club_agent');
  END IF;
  IF EXISTS (SELECT 1 FROM public.club_members cm
              WHERE cm.user_id <> p_user_id
                AND cm.membership_lifecycle_status = 'active'
                AND (cm.agent_id = p_user_id OR cm.parent_agent_id = p_user_id)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'downline');
  END IF;
  IF EXISTS (SELECT 1 FROM public.clubs c
              WHERE c.owner_id = p_user_id AND c.lifecycle_status = 'active') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'club_owner');
  END IF;
  IF EXISTS (SELECT 1 FROM public.club_members cm
               JOIN public.clubs c ON c.id = cm.club_id
              WHERE cm.user_id = p_user_id
                AND cm.membership_lifecycle_status = 'active'
                AND c.lifecycle_status = 'active'
                AND cm.role IN ('owner', 'club_owner', 'co_owner', 'admin', 'club_admin')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'club_staff');
  END IF;
  IF EXISTS (SELECT 1 FROM public.unions u WHERE u.owner_id = p_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'union_owner');
  END IF;
  v_precheck := public.fn_ca_gdpr_financial_precheck(p_user_id);
  IF NOT COALESCE((v_precheck ->> 'clear')::boolean, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'financial',
                              'blockers', v_precheck -> 'blockers');
  END IF;

  -- Leave every club the way the club's departure path does. The row stays.
  INSERT INTO public.audit_trail(
    actor_id, actor_role, action, target_type, target_id, club_id,
    before_state, after_state, reason
  )
  SELECT p_user_id, 'player', 'depart_club_member', 'membership', cm.user_id, cm.club_id,
         jsonb_build_object('user_id', cm.user_id, 'role', cm.role,
                            'status', cm.status::text,
                            'membership_lifecycle_status', cm.membership_lifecycle_status),
         jsonb_build_object('departed', true, 'is_active', false,
                            'membership_lifecycle_status', 'departed',
                            'user_id', cm.user_id),
         'Account Closed'
    FROM public.club_members cm
    JOIN public.clubs c ON c.id = cm.club_id
   WHERE cm.user_id = p_user_id
     AND cm.membership_lifecycle_status = 'active'
     AND c.lifecycle_status = 'active';

  PERFORM set_config('app.club_membership_lifecycle_write', 'depart', true);
  UPDATE public.club_members cm
     SET status = CASE WHEN c.asset = 'diamonds' THEN cm.status ELSE 'suspended' END,
         is_active = false,
         membership_lifecycle_status = 'departed',
         departed_at = clock_timestamp(),
         departed_by = p_user_id,
         departure_reason = 'Account Closed',
         display_name = NULL,
         updated_at = clock_timestamp()
    FROM public.clubs c
   WHERE c.id = cm.club_id
     AND cm.user_id = p_user_id
     AND cm.membership_lifecycle_status = 'active'
     AND c.lifecycle_status = 'active';
  GET DIAGNOSTICS v_departed = ROW_COUNT;
  -- A membership that had already ended keeps its history, not the name.
  UPDATE public.club_members cm
     SET display_name = NULL, updated_at = clock_timestamp()
    FROM public.clubs c
   WHERE c.id = cm.club_id
     AND cm.user_id = p_user_id
     AND cm.display_name IS NOT NULL
     AND c.lifecycle_status = 'active';
  PERFORM set_config('app.club_membership_lifecycle_write', '', true);

  -- The personal, non-financial rows go.
  DELETE FROM public.friendships f WHERE f.user_id = p_user_id OR f.friend_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('friendships', v_n);
  DELETE FROM public.friend_requests fr WHERE fr.sender_id = p_user_id OR fr.recipient_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('friend_requests', v_n);
  DELETE FROM public.user_sessions s WHERE s.user_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('user_sessions', v_n);
  DELETE FROM public.user_mfa_factors m WHERE m.user_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('user_mfa_factors', v_n);
  DELETE FROM public.push_subscriptions ps WHERE ps.user_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('push_subscriptions', v_n);
  DELETE FROM public.user_notification_preferences np WHERE np.user_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('user_notification_preferences', v_n);
  DELETE FROM public.notifications n
   WHERE n.user_id = p_user_id
     AND NOT EXISTS (SELECT 1 FROM public.accounting_invoice_deliveries d
                      WHERE d.notification_id = n.id)
     AND NOT EXISTS (SELECT 1 FROM public.push_outbox o
                      WHERE o.accounting_notification_id = n.id);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('notifications', v_n);

  -- The person leaves the profile; the id stays for the journals.
  v_tombstone := 'deleted-' || left(replace(p_user_id::text, '-', ''), 12);
  UPDATE public.profiles SET
    username = v_tombstone,
    full_name = NULL, display_name = NULL, first_name = NULL, last_name = NULL,
    alias = NULL, status_text = NULL, bio = NULL,
    email = NULL, phone = NULL,
    city = NULL, state = NULL, country = NULL,
    home_casino = NULL, favorite_venue = NULL, home_poker_club = NULL,
    avatar_url = NULL, cover_photo_url = NULL, arena_avatar_url = NULL,
    website = NULL, twitter = NULL, instagram = NULL, tiktok = NULL,
    telegram = NULL, hendon_url = NULL,
    favorite_game = NULL, favorite_hand = NULL, favorite_hand_plo = NULL,
    favorite_hand_type = NULL,
    birthday = NULL, birth_year = NULL,
    notification_token = NULL, referral_code = NULL, player_tags = '{}',
    settings = '{}'::jsonb, preferences = '{}'::jsonb, app_settings = '{}'::jsonb,
    hub_preferences = '{}'::jsonb, friend_preferences = '{}'::jsonb,
    store_preferences = '{}'::jsonb, messenger_preferences = '{}'::jsonb,
    reels_preferences = '{}'::jsonb, poker_near_me_preferences = '{}'::jsonb,
    bankroll_preferences = '{}'::jsonb, diamond_arena_preferences = '{}'::jsonb,
    memory_games_preferences = '{}'::jsonb, news_preferences = '{}'::jsonb,
    video_library_preferences = '{}'::jsonb,
    is_online = false, status = 'deleted', updated_at = now()
   WHERE id = p_user_id;

  UPDATE public.users SET
    username = v_tombstone, email = NULL, avatar_url = NULL, updated_at = now()
   WHERE id = p_user_id;

  INSERT INTO public.gdpr_deletion_requests (
    user_id, requested_by, reason, status, anonymized_at, summary
  ) VALUES (
    p_user_id, p_user_id, 'Closed by its owner (fn_close_account)', 'anonymized', now(),
    jsonb_build_object('user_id', p_user_id, 'departed_memberships', v_departed,
                       'deleted', v_deleted)
  )
  RETURNING id INTO v_request_id;

  RETURN jsonb_build_object('ok', true, 'already_closed', false,
                            'request_id', v_request_id,
                            'departed_memberships', v_departed);
END;
$function$;

COMMENT ON FUNCTION public.fn_close_account(uuid) IS
  'Closes an account (App Review 5.1.1(v)): refuses while money or authority remains (the club departure rules, then fn_ca_gdpr_financial_precheck), departs every club, deletes personal non-financial rows, scrubs the person from profiles and users, records gdpr_deletion_requests, keeps financial journals keyed by id. service_role only; the World Hub delete-account endpoint then soft-deletes the Auth user.';

REVOKE ALL ON FUNCTION public.fn_close_account(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_close_account(uuid) TO service_role;

COMMIT;
