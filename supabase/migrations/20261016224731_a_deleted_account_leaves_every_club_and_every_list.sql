-- 20261016224731_a_deleted_account_leaves_every_club_and_every_list.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- OWNER INSTRUCTION (Dan, 2026-10-16, with a screenshot of the Midway Union
-- player directory listing "Deleted-217ac35a5922 / Club JAQK / AGENT" seven
-- times): "remove any and all deleted player from appearing inside of any
-- searches or cashier pages or anywhere for that matter. for all clubs and
-- unions. once they are deleted, they should be removed for good, not linger
-- as a deleted stat. if they still have chips, those chips get recorded in the
-- ledger and sent back to the main bank."
--
-- WHAT WAS WRONG, READ FROM ROWS (2026-10-16, before this migration):
--
--   * 1,323 profiles hold status 'deleted'. 1,261 closed through Close Account
--     and hold no club rows. The other 62 are the patterned-id identities the
--     2026-10-06 retirement tombstoned (scripts/admin/retire-patterned-
--     identities.sql). That retirement set profiles.status = 'deleted' and
--     never touched club_members or agents, so all 62 still held 186 ACTIVE
--     memberships (Club JAQK, SHARK CLUB, Midway Union) and 25 agent rows (24
--     active), and 245 live members plus 17 live agent rows still pointed at
--     them as their upline.
--   * Nothing makes a deletion end a membership. fn_close_account departs its
--     own clubs first, but any other path that sets status 'deleted' (a staff
--     tool, the retirement, a service job) left the person a full member and,
--     where they were one, an active agent. The October 10 work hid deleted
--     profiles from the cashier and a few rosters one list at a time
--     (fn_cashier_member_is_active, ca_club_roster_rows); every list that reads
--     club_members directly still showed them.
--   * Measured with the owner's identity in a self-aborting probe: the union
--     player directory returned 62 deleted accounts (372 tombstone names),
--     ca_club_members returned 17 (JAQK) and 20 (SHARK), ca_club_members_page
--     carried 9 and 14 deleted upline ids, and the all-time club leaderboard
--     ranked 16 deleted accounts.
--   * Chips: every deleted account's club wallet, agent wallet, promo, credit
--     and held/locked balances are already 0 - the October 10 return
--     (20261010191226, 20261010192048, 20261010192114) moved them to each
--     club's main bank through ledgered receipts, and zzzz_deleted_*_credit
--     returns any later credit inside its own transaction.
--
-- WHAT THIS DOES - THE ROOT, NOT A NET:
--
--   1. fn_ca_deleted_account_leaves_every_club(user): for a deleted profile,
--      in every active club, (a) returns any free club chips to the main bank
--      through the existing ledgered fn_ca_deleted_wallet_bank_return, (b)
--      refuses (aborting the deletion) if any balance, promo, credit or
--      diamond custody would otherwise be stranded, (c) re-homes every live
--      member whose upline is the deleted account to the nearest live upline
--      (or none), (d) re-parents every live agent row under the deleted
--      agent's row the same way, (e) suspends the deleted account's agent
--      rows, and (f) departs every membership exactly as fn_close_account
--      does, with an audit_trail row. Idempotent: a second call moves nothing.
--   2. zzzzz_deleted_profile_leaves_every_club: AFTER UPDATE OF status on
--      profiles, the moment status becomes 'deleted', in the SAME
--      transaction, after zzzz_deleted_profile_bank_return (trigger names
--      fire in order). Every deletion path now ends every membership; there
--      is no sweep and no cron (CLAUDE.md 10.12).
--   3. The lists that read club_members or player_stats without asking the
--      profile's status now exclude status 'deleted': the union player
--      directory, ca_club_members, and the six leaderboard rankings
--      (club/union/global/diamond period and by-dates). The leaderboard
--      filter sits in the ranking CTE, so ranks and totals are computed over
--      live accounts only. fn_payout_leaderboard reads the same ranking
--      owner, so a deleted account is never paid a leaderboard place and the
--      live player displayed in that place receives it.
--   4. Settles the 62 existing accounts through function (1).
--
-- This is the authoritative profile status, never player type or name: no
-- player-type test anywhere (CLAUDE.md 10.5). No balance column is written except
-- through fn_ca_deleted_wallet_bank_return; no ledger, hand, seat, ticket or
-- settled record is touched or deleted. Balances are asserted to be zero
-- afterwards and the bank movement is asserted equal to what left the wallets.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
--
-- @live-proof: to_regprocedure('public.fn_ca_deleted_account_leaves_every_club(uuid)') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.profiles'::regclass AND tgname='zzzzz_deleted_profile_leaves_every_club' AND tgenabled='O') AND NOT EXISTS (SELECT 1 FROM public.club_members m JOIN public.profiles p ON p.id=m.user_id JOIN public.clubs c ON c.id=m.club_id WHERE p.status='deleted' AND m.membership_lifecycle_status='active' AND c.lifecycle_status='active') AND NOT EXISTS (SELECT 1 FROM public.agents a JOIN public.profiles p ON p.id=a.user_id WHERE p.status='deleted' AND a.status='active') AND position('deleted' in pg_get_functiondef('public.fn_union_player_directory(uuid)'::regprocedure))>0

BEGIN;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '120s';

-- -----------------------------------------------------------------------------
-- Preimages: a list function changed since it was read on 2026-10-16 is a
-- different decision. Refuse rather than overwrite someone else's change.
-- -----------------------------------------------------------------------------
DO $preimage$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.fn_union_player_directory(uuid)', 'd7cae706425a055f9039ba2b9535da48'),
    ('public.ca_club_members(uuid,text,timestamp with time zone,integer,integer,text,text)', '34ba796d5b2cb037a751b105085611cd'),
    ('public.fn_club_leaderboard_by_dates(uuid,text,date,date,integer,integer)', 'e272588c84b4f4e6b3b093972ef174ee'),
    ('public.fn_club_leaderboard_period_v2(uuid,text,text,integer,integer)', 'b44ad44876dbf9bb20b85193ae794013'),
    ('public.fn_diamond_arena_leaderboard_period(text,integer,integer)', '3f70efb5114ad9a9d6cc50dfd114ac7b'),
    ('public.fn_global_leaderboard_by_dates(text,date,date,integer,integer)', 'da702a5278d7550b57db392c201427f0'),
    ('public.fn_global_leaderboard_period(text,text,integer,integer)', '65d5c18899d4242adca6cbd54939763a'),
    ('public.fn_union_leaderboard_period_v2(uuid,text,text,integer,integer)', '4aa4adcfad1b38f61543f2647a549850')
  ) AS v(sig, digest) LOOP
    IF md5(pg_get_functiondef(r.sig::regprocedure)) <> r.digest THEN
      RAISE EXCEPTION 'DELETED_LISTS_PREIMAGE_CHANGED: %', r.sig;
    END IF;
  END LOOP;
END
$preimage$;

-- The money guard sees the balance column names this function reads. It writes
-- no balance itself: the only chip movement is fn_ca_deleted_wallet_bank_return.
INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_ca_deleted_account_leaves_every_club', 'system',
   'Owner October 16: a deleted account leaves every club. Returns free club chips to the main bank only through fn_ca_deleted_wallet_bank_return (ledgered), refuses while any other custody remains, re-homes downline and agent children to the nearest live upline, suspends the account''s agent rows and departs its memberships through the lifecycle columns. Writes no balance column itself. Service and trigger only.')
ON CONFLICT (proname) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 1. The lifecycle step every deletion takes.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_deleted_account_leaves_every_club(p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET lock_timeout TO '4s'
AS $function$
DECLARE
  v_club uuid;
  v_ret jsonb;
  v_returned numeric := 0;
  v_rehomed integer := 0;
  v_reparented integer := 0;
  v_suspended integer := 0;
  v_departed integer := 0;
  v_n integer;
  r record;
  v_cursor uuid;
  v_target uuid;
  v_hops integer;
BEGIN
  IF p_user IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_user');
  END IF;
  PERFORM 1 FROM public.profiles p WHERE p.id = p_user AND p.status = 'deleted';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'account_not_deleted');
  END IF;

  -- Serialise with every cashier writer the way fn_close_account does: the
  -- hierarchy lock of each club involved, in one order.
  FOR v_club IN
    SELECT s.club_id FROM (
      SELECT m.club_id FROM public.club_members m
       WHERE m.user_id = p_user OR m.agent_id = p_user OR m.parent_agent_id = p_user
      UNION
      SELECT a.club_id FROM public.agents a WHERE a.user_id = p_user
    ) s
    JOIN public.clubs c ON c.id = s.club_id AND c.lifecycle_status = 'active'
    ORDER BY s.club_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:' || v_club::text, 0));
  END LOOP;

  -- (a) Free club chips go to the main bank through the recorded movement.
  -- On the deletion path zzzz_deleted_profile_bank_return has already done
  -- this; only a wallet still holding free chips is visited, so an empty one
  -- never takes its club's bank row lock a second time.
  FOR v_club IN
    SELECT s.club_id FROM (
      SELECT m.club_id FROM public.club_members m
       WHERE m.user_id = p_user
         AND coalesce(m.chip_balance, 0) - coalesce(m.held_chips, 0) - coalesce(m.locked_chips, 0) > 0
      UNION
      SELECT a.club_id FROM public.agents a
       WHERE a.user_id = p_user AND coalesce(a.agent_wallet_balance, 0) > 0
    ) s
    JOIN public.clubs c ON c.id = s.club_id
     AND c.lifecycle_status = 'active' AND c.asset = 'chips'
    ORDER BY s.club_id
  LOOP
    v_ret := public.fn_ca_deleted_wallet_bank_return(v_club, p_user, 'wallets');
    IF coalesce(v_ret ->> 'success', 'false') <> 'true' THEN
      RAISE EXCEPTION 'ACCOUNT_CUSTODY_UNSETTLED: bank_return %', v_ret USING ERRCODE = '23514';
    END IF;
    v_returned := v_returned + coalesce((v_ret ->> 'amount')::numeric, 0);
  END LOOP;

  -- (b) Nothing else may be stranded by the departure. Close Account refuses
  -- the same custody; any other deletion path is refused here, atomically.
  IF EXISTS (
    SELECT 1 FROM public.club_members m
      JOIN public.clubs c ON c.id = m.club_id AND c.lifecycle_status = 'active'
     WHERE m.user_id = p_user
       AND m.membership_lifecycle_status = 'active'
       AND abs(coalesce(m.chip_balance, 0)) + abs(coalesce(m.held_chips, 0))
         + abs(coalesce(m.locked_chips, 0)) + abs(coalesce(m.promo_balance, 0))
         + abs(coalesce(m.credit_used, 0)) + abs(coalesce(m.diamonds, 0)) <> 0
  ) THEN
    RAISE EXCEPTION 'ACCOUNT_CUSTODY_UNSETTLED: club_balance' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.agents a
      JOIN public.clubs c ON c.id = a.club_id AND c.lifecycle_status = 'active'
     WHERE a.user_id = p_user
       AND abs(coalesce(a.agent_wallet_balance, 0)) + abs(coalesce(a.promo_wallet_balance, 0))
         + abs(coalesce(a.credit_used, 0)) <> 0
  ) THEN
    RAISE EXCEPTION 'ACCOUNT_CUSTODY_UNSETTLED: agent_wallet' USING ERRCODE = '23514';
  END IF;

  -- (c) Live members under the deleted account move to the nearest live
  -- upline above it: a member that is not deleted, holds an active membership
  -- and is either an active agent or club staff. None found -> club direct.
  FOR r IN
    SELECT m.club_id, m.user_id, (m.agent_id = p_user) AS via_agent,
           (m.parent_agent_id = p_user) AS via_parent
      FROM public.club_members m
      JOIN public.clubs c ON c.id = m.club_id AND c.lifecycle_status = 'active'
     WHERE (m.agent_id = p_user OR m.parent_agent_id = p_user)
       AND m.user_id <> p_user
       AND m.membership_lifecycle_status = 'active'
       AND NOT EXISTS (SELECT 1 FROM public.profiles dp WHERE dp.id = m.user_id AND dp.status = 'deleted')
     ORDER BY m.club_id, m.user_id
  LOOP
    v_target := NULL;
    v_cursor := p_user;
    v_hops := 0;
    WHILE v_hops < 64 LOOP
      SELECT up.agent_id INTO v_cursor
        FROM public.club_members up
       WHERE up.club_id = r.club_id AND up.user_id = v_cursor;
      EXIT WHEN NOT FOUND OR v_cursor IS NULL OR v_cursor = r.user_id;
      IF NOT EXISTS (SELECT 1 FROM public.profiles dp WHERE dp.id = v_cursor AND dp.status = 'deleted')
         AND EXISTS (
           SELECT 1 FROM public.club_members live
            WHERE live.club_id = r.club_id AND live.user_id = v_cursor
              AND live.membership_lifecycle_status = 'active'
              AND coalesce(live.status, 'active') IN ('active', 'approved')
              AND (live.role IN ('owner', 'club_owner', 'co_owner', 'admin', 'club_admin')
                   OR EXISTS (SELECT 1 FROM public.agents la
                               WHERE la.club_id = r.club_id AND la.user_id = v_cursor
                                 AND la.status = 'active'))) THEN
        v_target := v_cursor;
        EXIT;
      END IF;
      v_hops := v_hops + 1;
    END LOOP;

    UPDATE public.club_members m
       SET agent_id = CASE WHEN r.via_agent THEN v_target ELSE m.agent_id END,
           parent_agent_id = CASE WHEN r.via_parent THEN v_target ELSE m.parent_agent_id END,
           updated_at = clock_timestamp()
     WHERE m.club_id = r.club_id AND m.user_id = r.user_id;
    v_rehomed := v_rehomed + 1;
  END LOOP;

  -- (d) Live agent rows under the deleted account's agent rows move to the
  -- nearest live agent row above it (active, not a sub-agent), else none.
  FOR r IN
    SELECT ch.id, ch.club_id, da.parent_agent_id AS start_parent
      FROM public.agents da
      JOIN public.clubs c ON c.id = da.club_id AND c.lifecycle_status = 'active'
      JOIN public.agents ch ON ch.parent_agent_id = da.id AND ch.club_id = da.club_id
     WHERE da.user_id = p_user
       AND ch.user_id <> p_user
       AND NOT EXISTS (SELECT 1 FROM public.profiles dp WHERE dp.id = ch.user_id AND dp.status = 'deleted')
     ORDER BY ch.club_id, ch.id
  LOOP
    v_target := NULL;
    v_cursor := r.start_parent;
    v_hops := 0;
    WHILE v_cursor IS NOT NULL AND v_hops < 64 LOOP
      IF EXISTS (
        SELECT 1 FROM public.agents pa
          JOIN public.profiles pp ON pp.id = pa.user_id
         WHERE pa.id = v_cursor AND pa.club_id = r.club_id
           AND pa.status = 'active' AND pa.role <> 'sub_agent'
           AND pp.status IS DISTINCT FROM 'deleted') THEN
        v_target := v_cursor;
        EXIT;
      END IF;
      SELECT pa.parent_agent_id INTO v_cursor
        FROM public.agents pa WHERE pa.id = v_cursor AND pa.club_id = r.club_id;
      IF NOT FOUND THEN v_cursor := NULL; END IF;
      v_hops := v_hops + 1;
    END LOOP;

    UPDATE public.agents a
       SET parent_agent_id = v_target, updated_at = clock_timestamp()
     WHERE a.id = r.id AND a.club_id = r.club_id;
    v_reparented := v_reparented + 1;
  END LOOP;

  -- (e) The deleted account holds no agent authority anywhere.
  UPDATE public.agents a
     SET status = 'suspended', updated_at = clock_timestamp()
    FROM public.clubs c
   WHERE c.id = a.club_id AND c.lifecycle_status = 'active'
     AND a.user_id = p_user AND a.status <> 'suspended';
  GET DIAGNOSTICS v_suspended = ROW_COUNT;

  -- (f) Depart every membership exactly as Close Account does. The row stays
  -- for the journals; it is no longer a member of anything.
  INSERT INTO public.audit_trail(
    actor_id, actor_role, action, target_type, target_id, club_id,
    before_state, after_state, reason
  )
  SELECT p_user, 'system', 'depart_club_member', 'membership', m.user_id, m.club_id,
         jsonb_build_object('user_id', m.user_id, 'role', m.role,
                            'status', m.status::text,
                            'membership_lifecycle_status', m.membership_lifecycle_status),
         jsonb_build_object('departed', true, 'is_active', false,
                            'membership_lifecycle_status', 'departed',
                            'user_id', m.user_id),
         'Account Deleted'
    FROM public.club_members m
    JOIN public.clubs c ON c.id = m.club_id
   WHERE m.user_id = p_user
     AND m.membership_lifecycle_status = 'active'
     AND c.lifecycle_status = 'active';

  PERFORM set_config('app.club_membership_lifecycle_write', 'depart', true);
  UPDATE public.club_members m
     SET status = CASE WHEN c.asset = 'diamonds' THEN m.status ELSE 'suspended' END,
         is_active = false,
         membership_lifecycle_status = 'departed',
         departed_at = clock_timestamp(),
         departed_by = p_user,
         departure_reason = 'Account Deleted',
         display_name = NULL,
         updated_at = clock_timestamp()
    FROM public.clubs c
   WHERE c.id = m.club_id
     AND m.user_id = p_user
     AND m.membership_lifecycle_status = 'active'
     AND c.lifecycle_status = 'active';
  GET DIAGNOSTICS v_departed = ROW_COUNT;
  PERFORM set_config('app.club_membership_lifecycle_write', '', true);

  RETURN jsonb_build_object(
    'success', true,
    'user_id', p_user,
    'returned_to_bank', v_returned,
    'downline_rehomed', v_rehomed,
    'agents_reparented', v_reparented,
    'agent_rows_suspended', v_suspended,
    'memberships_departed', v_departed
  );
END;
$function$;

COMMENT ON FUNCTION public.fn_ca_deleted_account_leaves_every_club(uuid) IS
  'Owner October 16: a deleted account leaves every club in the transaction that deletes it. Free club chips return to the main bank through fn_ca_deleted_wallet_bank_return; any other remaining custody refuses the deletion; downline and agent children move to the nearest live upline; agent rows are suspended; memberships depart with an audit_trail row. Idempotent. Service and trigger only.';

REVOKE ALL ON FUNCTION public.fn_ca_deleted_account_leaves_every_club(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_deleted_account_leaves_every_club(uuid) TO service_role;

-- -----------------------------------------------------------------------------
-- 2. Every deletion path takes that step, in its own transaction.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_deleted_profile_leaves_every_club()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.fn_ca_deleted_account_leaves_every_club(NEW.id);
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_deleted_profile_leaves_every_club() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.fn_ca_deleted_profile_leaves_every_club() IS
  'AFTER UPDATE OF status on profiles when status becomes deleted: runs fn_ca_deleted_account_leaves_every_club in the same transaction, after zzzz_deleted_profile_bank_return.';

-- Named to fire after zzzz_deleted_profile_bank_return (same timing, name order).
CREATE TRIGGER zzzzz_deleted_profile_leaves_every_club
AFTER UPDATE OF status ON public.profiles
FOR EACH ROW
WHEN (NEW.status = 'deleted' AND OLD.status IS DISTINCT FROM 'deleted')
EXECUTE FUNCTION public.fn_ca_deleted_profile_leaves_every_club();

-- -----------------------------------------------------------------------------
-- 3. Lists that never asked the profile's status now do.
-- -----------------------------------------------------------------------------
DO $lists$
DECLARE
  v_def text;
  v_new text;
  r record;
  v_uid_anchor text := E'FROM scored s\n     WHERE (s.d_hands > 0';
  v_uid_patch text := E'FROM scored s\n     WHERE NOT EXISTS (SELECT 1 FROM public.profiles dp WHERE dp.id = s.uid AND dp.status = ''deleted'')\n       AND (s.d_hands > 0';
  v_basis_anchor text := 'FROM scored s WHERE (s.hands_played>0';
  v_basis_patch text := 'FROM scored s WHERE NOT EXISTS (SELECT 1 FROM public.profiles dp WHERE dp.id = s.user_id AND dp.status = ''deleted'') AND (s.hands_played>0';
BEGIN
  -- The union player directory (the screen in Dan's screenshot).
  v_def := pg_get_functiondef('public.fn_union_player_directory(uuid)'::regprocedure);
  v_new := replace(v_def,
    E'    LEFT JOIN profiles pr ON pr.id = cm.user_id\n   ORDER BY',
    E'    LEFT JOIN profiles pr ON pr.id = cm.user_id\n   WHERE pr.status IS DISTINCT FROM ''deleted''\n   ORDER BY');
  IF v_new = v_def THEN RAISE EXCEPTION 'DELETED_LISTS_ANCHOR_MISSING: fn_union_player_directory'; END IF;
  EXECUTE v_new;

  -- The club members roster.
  v_def := pg_get_functiondef('public.ca_club_members(uuid,text,timestamp with time zone,integer,integer,text,text)'::regprocedure);
  v_new := replace(v_def,
    E'    WHERE cm.club_id = p_club_id\n      AND coalesce(cm.status, ''active'') NOT IN (''banned'')',
    E'    WHERE cm.club_id = p_club_id\n      AND coalesce(cm.status, ''active'') NOT IN (''banned'')\n      AND pr.status IS DISTINCT FROM ''deleted''');
  IF v_new = v_def THEN RAISE EXCEPTION 'DELETED_LISTS_ANCHOR_MISSING: ca_club_members'; END IF;
  EXECUTE v_new;

  -- Every leaderboard ranking owner: the filter sits before the rank, so ranks
  -- and totals are computed over live accounts only.
  FOR r IN SELECT * FROM (VALUES
    ('public.fn_club_leaderboard_by_dates(uuid,text,date,date,integer,integer)', 1, 1),
    ('public.fn_club_leaderboard_period_v2(uuid,text,text,integer,integer)', 1, 0),
    ('public.fn_diamond_arena_leaderboard_period(text,integer,integer)', 1, 0),
    ('public.fn_global_leaderboard_by_dates(text,date,date,integer,integer)', 1, 0),
    ('public.fn_global_leaderboard_period(text,text,integer,integer)', 1, 0),
    ('public.fn_union_leaderboard_period_v2(uuid,text,text,integer,integer)', 1, 0)
  ) AS v(sig, uid_hits, basis_hits) LOOP
    v_def := pg_get_functiondef(r.sig::regprocedure);
    IF (length(v_def) - length(replace(v_def, v_uid_anchor, ''))) / length(v_uid_anchor) <> r.uid_hits
       OR (length(v_def) - length(replace(v_def, v_basis_anchor, ''))) / length(v_basis_anchor) <> r.basis_hits THEN
      RAISE EXCEPTION 'DELETED_LISTS_ANCHOR_MISSING: %', r.sig;
    END IF;
    v_new := replace(replace(v_def, v_uid_anchor, v_uid_patch), v_basis_anchor, v_basis_patch);
    EXECUTE v_new;
  END LOOP;
END
$lists$;

-- -----------------------------------------------------------------------------
-- 4. Settle the accounts already deleted: every one still holding an active
-- membership or an active agent row. Exact board asserted; conservation and
-- the end state asserted; the record is part of the fix (CLAUDE.md 10.9).
-- -----------------------------------------------------------------------------
DO $settle$
DECLARE
  r record;
  v_res jsonb;
  v_board jsonb;
  v_accounts integer := 0;
  v_returned numeric := 0;
  v_rehomed integer := 0;
  v_reparented integer := 0;
  v_suspended integer := 0;
  v_departed integer := 0;
  v_wallets_before numeric;
  v_wallets_after numeric;
  v_receipts numeric;
  v_repeat numeric := 0;
BEGIN
  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'platform_is_frozen';
  END IF;

  SELECT jsonb_build_object(
           'accounts', count(DISTINCT p.id),
           'memberships', (SELECT count(*) FROM public.club_members m JOIN public.profiles dp ON dp.id = m.user_id
                             JOIN public.clubs c ON c.id = m.club_id
                            WHERE dp.status = 'deleted' AND m.membership_lifecycle_status = 'active'
                              AND c.lifecycle_status = 'active'),
           'agent_rows', (SELECT count(*) FROM public.agents a JOIN public.profiles dp ON dp.id = a.user_id
                           WHERE dp.status = 'deleted' AND a.status = 'active'))
    INTO v_board
    FROM public.profiles p
   WHERE p.status = 'deleted'
     AND (EXISTS (SELECT 1 FROM public.club_members m JOIN public.clubs c ON c.id = m.club_id
                   WHERE m.user_id = p.id AND m.membership_lifecycle_status = 'active'
                     AND c.lifecycle_status = 'active')
          OR EXISTS (SELECT 1 FROM public.agents a WHERE a.user_id = p.id AND a.status = 'active'));

  -- Free club chips still held by deleted accounts (live play moves the banks
  -- concurrently, so conservation is read from the accounts and from this
  -- transaction's own receipts, never from a bank total).
  SELECT coalesce(sum(greatest(coalesce(m.chip_balance, 0) - coalesce(m.held_chips, 0)
                              - coalesce(m.locked_chips, 0), 0)), 0)
       + coalesce((SELECT sum(greatest(coalesce(a.agent_wallet_balance, 0), 0))
                     FROM public.agents a JOIN public.profiles dp ON dp.id = a.user_id
                     JOIN public.clubs c ON c.id = a.club_id
                    WHERE dp.status = 'deleted' AND c.asset = 'chips' AND c.lifecycle_status = 'active'), 0)
    INTO v_wallets_before
    FROM public.club_members m JOIN public.profiles dp ON dp.id = m.user_id
    JOIN public.clubs c ON c.id = m.club_id
   WHERE dp.status = 'deleted' AND c.asset = 'chips' AND c.lifecycle_status = 'active';

  FOR r IN
    SELECT p.id FROM public.profiles p
     WHERE p.status = 'deleted'
       AND (EXISTS (SELECT 1 FROM public.club_members m JOIN public.clubs c ON c.id = m.club_id
                     WHERE (m.user_id = p.id OR m.agent_id = p.id OR m.parent_agent_id = p.id)
                       AND m.membership_lifecycle_status = 'active'
                       AND c.lifecycle_status = 'active')
            OR EXISTS (SELECT 1 FROM public.agents a WHERE a.user_id = p.id AND a.status = 'active'))
     ORDER BY p.id
  LOOP
    v_res := public.fn_ca_deleted_account_leaves_every_club(r.id);
    IF coalesce(v_res ->> 'success', 'false') <> 'true' THEN
      RAISE EXCEPTION 'DELETED_ACCOUNT_SETTLEMENT_REFUSED %', v_res;
    END IF;
    v_accounts := v_accounts + 1;
    v_returned := v_returned + (v_res ->> 'returned_to_bank')::numeric;
    v_rehomed := v_rehomed + (v_res ->> 'downline_rehomed')::integer;
    v_reparented := v_reparented + (v_res ->> 'agents_reparented')::integer;
    v_suspended := v_suspended + (v_res ->> 'agent_rows_suspended')::integer;
    v_departed := v_departed + (v_res ->> 'memberships_departed')::integer;
  END LOOP;

  -- Repeat moves nothing.
  FOR r IN SELECT p.id FROM public.profiles p WHERE p.status = 'deleted'
             AND EXISTS (SELECT 1 FROM public.club_members m WHERE m.user_id = p.id
                          AND m.departure_reason = 'Account Deleted') ORDER BY p.id
  LOOP
    v_res := public.fn_ca_deleted_account_leaves_every_club(r.id);
    v_repeat := v_repeat + (v_res ->> 'returned_to_bank')::numeric
      + (v_res ->> 'memberships_departed')::numeric + (v_res ->> 'agent_rows_suspended')::numeric
      + (v_res ->> 'downline_rehomed')::numeric + (v_res ->> 'agents_reparented')::numeric;
  END LOOP;

  SELECT coalesce(sum(greatest(coalesce(m.chip_balance, 0) - coalesce(m.held_chips, 0)
                              - coalesce(m.locked_chips, 0), 0)), 0)
       + coalesce((SELECT sum(greatest(coalesce(a.agent_wallet_balance, 0), 0))
                     FROM public.agents a JOIN public.profiles dp ON dp.id = a.user_id
                     JOIN public.clubs c ON c.id = a.club_id
                    WHERE dp.status = 'deleted' AND c.asset = 'chips' AND c.lifecycle_status = 'active'), 0)
    INTO v_wallets_after
    FROM public.club_members m JOIN public.profiles dp ON dp.id = m.user_id
    JOIN public.clubs c ON c.id = m.club_id
   WHERE dp.status = 'deleted' AND c.asset = 'chips' AND c.lifecycle_status = 'active';
  SELECT coalesce(sum(t.amount), 0) INTO v_receipts
    FROM public.chip_transactions t
   WHERE t.created_at >= transaction_timestamp()
     AND t.xmin = txid_current()::text::xid
     AND t.metadata ->> 'reason' = 'deleted_account';

  -- The 2026-10-16 board (measured before this migration): 62 accounts, 186
  -- active memberships, 24 active agent rows, 245 live downline members, 17
  -- live agent children, 0.00 club chips left to return.
  IF (v_board ->> 'accounts')::integer <> 62
     OR (v_board ->> 'memberships')::integer <> 186
     OR (v_board ->> 'agent_rows')::integer <> 24
     OR v_accounts <> 62 OR v_departed <> 186 OR v_suspended <> 24
     OR v_rehomed <> 245 OR v_reparented <> 17 THEN
    RAISE EXCEPTION 'DELETED_ACCOUNT_BOARD_CHANGED board=% accounts=% departed=% suspended=% rehomed=% reparented=%',
      v_board, v_accounts, v_departed, v_suspended, v_rehomed, v_reparented;
  END IF;
  IF v_returned <> v_wallets_before OR v_wallets_after <> 0
     OR v_receipts <> v_returned OR v_repeat <> 0 THEN
    RAISE EXCEPTION 'DELETED_ACCOUNT_CONSERVATION_FAILED returned=% before=% after=% receipts=% repeat=%',
      v_returned, v_wallets_before, v_wallets_after, v_receipts, v_repeat;
  END IF;

  -- End state: no deleted account is a member, agent or upline of anything live.
  IF EXISTS (SELECT 1 FROM public.club_members m JOIN public.profiles p ON p.id = m.user_id
               JOIN public.clubs c ON c.id = m.club_id
              WHERE p.status = 'deleted' AND m.membership_lifecycle_status = 'active'
                AND c.lifecycle_status = 'active')
     OR EXISTS (SELECT 1 FROM public.agents a JOIN public.profiles p ON p.id = a.user_id
                 WHERE p.status = 'deleted' AND a.status = 'active')
     OR EXISTS (SELECT 1 FROM public.club_members m JOIN public.profiles up ON up.id = m.agent_id
                  JOIN public.clubs c ON c.id = m.club_id
                 WHERE up.status = 'deleted' AND m.membership_lifecycle_status = 'active'
                   AND c.lifecycle_status = 'active')
     OR EXISTS (SELECT 1 FROM public.agents ch JOIN public.agents pa ON pa.id = ch.parent_agent_id
                  JOIN public.profiles pp ON pp.id = pa.user_id
                  JOIN public.profiles cp ON cp.id = ch.user_id
                 WHERE pp.status = 'deleted' AND cp.status IS DISTINCT FROM 'deleted') THEN
    RAISE EXCEPTION 'DELETED_ACCOUNT_END_STATE_FAILED';
  END IF;

  SET CONSTRAINTS ALL IMMEDIATE;

  INSERT INTO public.financial_alerts(severity, source, message, context, resolved, resolved_at, resolution)
  VALUES ('warning', 'deleted_accounts_leave_every_club_20261016',
    'Deleted Accounts Removed From Every Club, Union And List',
    jsonb_build_object('board', v_board, 'accounts', v_accounts,
                       'memberships_departed', v_departed, 'agent_rows_suspended', v_suspended,
                       'downline_rehomed', v_rehomed, 'agents_reparented', v_reparented,
                       'returned_to_bank', v_returned, 'free_chips_before', v_wallets_before,
                       'free_chips_after', v_wallets_after, 'bank_receipts', v_receipts,
                       'repeat', v_repeat),
    true, now(),
    'Owner October 16 Instruction: Deleted Players Are Removed For Good. Every Deleted Account Left Every Club, Its Agent Rows Were Suspended, Its Downline Moved To The Nearest Live Upline, And Any Free Club Chips Returned To The Main Bank Through The Ledgered Return (Zero Remained After October 10). Future Deletions Do The Same In Their Own Transaction.');
END
$settle$;

COMMIT;
