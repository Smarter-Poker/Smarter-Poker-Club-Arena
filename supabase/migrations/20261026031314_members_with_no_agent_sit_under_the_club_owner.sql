-- 20261026031314_members_with_no_agent_sit_under_the_club_owner.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Dan, 2026-10-25: "ANY 'ORPHANED' PLAYERS, OR PLAYERS WITH NO AGENTS, GET
-- ASSIGNED TO THE CLUB OWNER. 'KINGFISH' FOR KINGS CLUB PLAYERS." and
-- "ASSIGN ALL ORPHANED PLAYERS TO THEIR CLUB OWNER AND FIX THE JOIN PATH".
--
-- WHAT WAS WRONG (read from production 2026-10-26)
--
-- fn_join_club_membership_impl, the one door that creates a membership
-- (fn_require_explicit_club_membership_source), inserted every new member with
-- agent_id NULL. fn_redeem_club_invite_code then placed an invited player
-- under the inviting agent, but a player who joined with no code, or whose
-- inviter had left or was not an agent with an upline, stayed with no agent.
-- fn_ca_deleted_account_leaves_every_club did the same to a deleted agent's
-- downline when nobody live sat above it ("None found -> club direct").
-- 170 live members of chip clubs had no agent: KINGS CLUB 16, Midway Union 6,
-- Deep Stack Society 1, The Felt Society 1, Club Savage 1, Lightning Internal
-- Pilot 145. New ones were still arriving at the time of reading.
--
-- THE FIX
--
-- 1. fn_join_club_membership_impl inserts a non-owner member with
--    agent_id = the club owner.
-- 2. fn_redeem_club_invite_code treats that owner placement as "no upline":
--    while invited_by is NULL (no invite has ever placed the member) the first
--    invite still places them under the inviting agent, and an invite that
--    routes to the owner leaves them under the owner. A placement an invite
--    made (invited_by set) is never moved, exactly as before. The "placement"
--    test in its join record counts a move to a real agent, as before.
-- 3. fn_agent_attach_player lets an agent add a member whose only upline is
--    that unchosen owner placement, as it could when the upline was NULL.
-- 4. fn_ca_deleted_account_leaves_every_club re-homes a deleted agent's
--    downline to the club owner when no live upline is found.
--
-- Accounting already reads the owner as a direct upline
-- (fn_accounting_earning_contract: an owner with no agent terms earns no agent
-- commission; an owner with active agent terms, as KingFish holds in KINGS
-- CLUB, earns as their agent, the same as the 552 members already under him).
--
-- THE MEMBERS ALREADY WITHOUT AN AGENT
--
-- Moved under their club owner in this transaction: live (lifecycle active,
-- status active/approved/pending) members of active chip clubs who are not the
-- owner, not staff (co_owner/admin hold no player wallet and are not players),
-- and not deleted. Horses are players and move like anyone (CLAUDE.md 10.5).
-- The Diamond Arena is excluded: its memberships have no hierarchy by rule
-- (fn_poker_guard_arena_structure). Departed rows are history and stay as
-- they are. Probed in a rolled-back transaction on 2026-10-26: 170 rows, none
-- refused, zero left unassigned afterwards.
--
-- The agent change re-arms club_messenger_admissions for each moved member,
-- which would re-send the owner's welcome text to people who joined long ago.
-- This is a reassignment, not a join, so the moved members' admissions are
-- detached from this transaction (transaction_id 0) before COMMIT, and the
-- deferred welcome trigger finds nothing to deliver. Messenger access is
-- unchanged (the admission stays active).
--
-- Function text is patched by exact substitution and pinned by md5 before and
-- after, so a live definition that has moved aborts the whole migration.
-- No table lock beyond the moved rows; one transaction, one schema reload.

-- @live-proof: md5(pg_get_functiondef(to_regprocedure('public.fn_join_club_membership_impl(uuid)'))) = 'b31effd0156fd162f2420bdf7b4560a7'
-- @live-proof: md5(pg_get_functiondef(to_regprocedure('public.fn_redeem_club_invite_code(uuid,uuid,text)'))) = '16f8badbcc4ebf359bbfe478ab3bca83'
-- @live-proof: md5(pg_get_functiondef(to_regprocedure('public.fn_agent_attach_player(uuid,uuid,uuid)'))) = '7b43bce74a6fc615eab7f95c70a81186'
-- @live-proof: md5(pg_get_functiondef(to_regprocedure('public.fn_ca_deleted_account_leaves_every_club(uuid)'))) = 'a7a76c3874187748e30f32f509a45233'
-- @live-proof: NOT EXISTS (SELECT 1 FROM public.club_members m JOIN public.clubs c ON c.id = m.club_id WHERE m.agent_id IS NULL AND c.asset = 'chips' AND c.lifecycle_status = 'active' AND m.user_id <> c.owner_id AND m.role NOT IN ('owner','club_owner','co_owner','admin','club_admin') AND m.status IN ('active','approved','pending') AND m.membership_lifecycle_status = 'active' AND m.created_at < '2026-10-26 03:13:14+00')

BEGIN;

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

DO $members_with_no_agent_sit_under_the_club_owner$
DECLARE
  v_fn regprocedure;
  v_new text;
  v_moved integer;
  v_left integer;
BEGIN

  -- public.fn_join_club_membership_impl(uuid)
  v_fn := to_regprocedure('public.fn_join_club_membership_impl(uuid)');
  IF v_fn IS NULL OR md5(pg_get_functiondef(v_fn)) <> 'dc9908bbe4447d2a455039efd2ff0137' THEN
    RAISE EXCEPTION 'OWNER_UPLINE_PREIMAGE_CHANGED: %', 'public.fn_join_club_membership_impl(uuid)' USING ERRCODE = '55000';
  END IF;
  v_new := replace(pg_get_functiondef(v_fn),
$join_impl_old0$  INSERT INTO club_members (club_id, user_id, role, status, tier, rank_level, orange_ball_status, chip_balance)
  VALUES (p_club_id, v_uid, v_role, v_status, 'bronze', 0, 'cold', 0)
$join_impl_old0$,
$join_impl_new0$  -- Dan, 2026-10-25: a member with no agent sits under the club owner.
  INSERT INTO club_members (club_id, user_id, role, status, tier, rank_level, orange_ball_status, chip_balance, agent_id)
  VALUES (p_club_id, v_uid, v_role, v_status, 'bronze', 0, 'cold', 0,
          CASE WHEN v_uid = v_owner THEN NULL ELSE v_owner END)
$join_impl_new0$);
  IF md5(v_new) <> 'b31effd0156fd162f2420bdf7b4560a7' THEN
    RAISE EXCEPTION 'OWNER_UPLINE_PATCH_MISMATCH: %', 'public.fn_join_club_membership_impl(uuid)' USING ERRCODE = '55000';
  END IF;
  EXECUTE v_new;
  IF md5(pg_get_functiondef(v_fn)) <> 'b31effd0156fd162f2420bdf7b4560a7' THEN
    RAISE EXCEPTION 'OWNER_UPLINE_INSTALL_MISMATCH: %', 'public.fn_join_club_membership_impl(uuid)' USING ERRCODE = '55000';
  END IF;

  -- public.fn_redeem_club_invite_code(uuid,uuid,text)
  v_fn := to_regprocedure('public.fn_redeem_club_invite_code(uuid,uuid,text)');
  IF v_fn IS NULL OR md5(pg_get_functiondef(v_fn)) <> 'd078d9104c84ba04de15eea10e7b33c0' THEN
    RAISE EXCEPTION 'OWNER_UPLINE_PREIMAGE_CHANGED: %', 'public.fn_redeem_club_invite_code(uuid,uuid,text)' USING ERRCODE = '55000';
  END IF;
  v_new := replace(replace(pg_get_functiondef(v_fn),
$redeem_old0$     SET agent_id   = coalesce(agent_id, v_effective_agent),
$redeem_old0$,
$redeem_new0$     SET agent_id   = CASE
                        -- An owner placement nobody chose (made at join, Dan
                        -- 2026-10-25) yields to the first invite, as no upline did.
                        WHEN agent_id IS NULL
                          OR (agent_id = (SELECT c.owner_id FROM clubs c WHERE c.id = p_club_id)
                              AND invited_by IS NULL)
                        THEN coalesce(v_effective_agent,
                                      (SELECT c.owner_id FROM clubs c
                                        WHERE c.id = p_club_id AND c.owner_id <> p_user_id))
                        ELSE agent_id
                      END,
$redeem_new0$),
$redeem_old1$               OR (v_prev_agent IS NULL AND v_member.agent_id IS NOT NULL)
$redeem_old1$,
$redeem_new1$               OR (v_member.agent_id IS DISTINCT FROM v_prev_agent
                   AND v_member.agent_id IS DISTINCT FROM
                       (SELECT c.owner_id FROM clubs c WHERE c.id = p_club_id))
$redeem_new1$);
  IF md5(v_new) <> '16f8badbcc4ebf359bbfe478ab3bca83' THEN
    RAISE EXCEPTION 'OWNER_UPLINE_PATCH_MISMATCH: %', 'public.fn_redeem_club_invite_code(uuid,uuid,text)' USING ERRCODE = '55000';
  END IF;
  EXECUTE v_new;
  IF md5(pg_get_functiondef(v_fn)) <> '16f8badbcc4ebf359bbfe478ab3bca83' THEN
    RAISE EXCEPTION 'OWNER_UPLINE_INSTALL_MISMATCH: %', 'public.fn_redeem_club_invite_code(uuid,uuid,text)' USING ERRCODE = '55000';
  END IF;

  -- public.fn_agent_attach_player(uuid,uuid,uuid)
  v_fn := to_regprocedure('public.fn_agent_attach_player(uuid,uuid,uuid)');
  IF v_fn IS NULL OR md5(pg_get_functiondef(v_fn)) <> '946b15ae3b5f9ab0e0f55a85cd8c6201' THEN
    RAISE EXCEPTION 'OWNER_UPLINE_PREIMAGE_CHANGED: %', 'public.fn_agent_attach_player(uuid,uuid,uuid)' USING ERRCODE = '55000';
  END IF;
  v_new := replace(pg_get_functiondef(v_fn),
$attach_old0$    IF v_member.agent_id IS NOT NULL
       AND v_member.agent_id <> p_agent_user_id
       AND NOT v_is_staff THEN
$attach_old0$,
$attach_new0$    IF v_member.agent_id IS NOT NULL
       AND v_member.agent_id <> p_agent_user_id
       -- An owner placement nobody chose (made at join) is not a downline.
       AND NOT (v_member.agent_id = (SELECT c.owner_id FROM clubs c WHERE c.id = p_club_id)
                AND v_member.invited_by IS NULL)
       AND NOT v_is_staff THEN
$attach_new0$);
  IF md5(v_new) <> '7b43bce74a6fc615eab7f95c70a81186' THEN
    RAISE EXCEPTION 'OWNER_UPLINE_PATCH_MISMATCH: %', 'public.fn_agent_attach_player(uuid,uuid,uuid)' USING ERRCODE = '55000';
  END IF;
  EXECUTE v_new;
  IF md5(pg_get_functiondef(v_fn)) <> '7b43bce74a6fc615eab7f95c70a81186' THEN
    RAISE EXCEPTION 'OWNER_UPLINE_INSTALL_MISMATCH: %', 'public.fn_agent_attach_player(uuid,uuid,uuid)' USING ERRCODE = '55000';
  END IF;

  -- public.fn_ca_deleted_account_leaves_every_club(uuid)
  v_fn := to_regprocedure('public.fn_ca_deleted_account_leaves_every_club(uuid)');
  IF v_fn IS NULL OR md5(pg_get_functiondef(v_fn)) <> '1f24fe3d72d7daf89148819af8f60d12' THEN
    RAISE EXCEPTION 'OWNER_UPLINE_PREIMAGE_CHANGED: %', 'public.fn_ca_deleted_account_leaves_every_club(uuid)' USING ERRCODE = '55000';
  END IF;
  v_new := replace(pg_get_functiondef(v_fn),
$departed_old0$       SET agent_id = CASE WHEN r.via_agent THEN v_target ELSE m.agent_id END,
$departed_old0$,
$departed_new0$       SET agent_id = CASE WHEN r.via_agent THEN coalesce(v_target,
             (SELECT c2.owner_id FROM public.clubs c2
               WHERE c2.id = r.club_id AND c2.asset = 'chips' AND c2.owner_id <> r.user_id))
           ELSE m.agent_id END,
$departed_new0$);
  IF md5(v_new) <> 'a7a76c3874187748e30f32f509a45233' THEN
    RAISE EXCEPTION 'OWNER_UPLINE_PATCH_MISMATCH: %', 'public.fn_ca_deleted_account_leaves_every_club(uuid)' USING ERRCODE = '55000';
  END IF;
  EXECUTE v_new;
  IF md5(pg_get_functiondef(v_fn)) <> 'a7a76c3874187748e30f32f509a45233' THEN
    RAISE EXCEPTION 'OWNER_UPLINE_INSTALL_MISMATCH: %', 'public.fn_ca_deleted_account_leaves_every_club(uuid)' USING ERRCODE = '55000';
  END IF;

  -- The members who already have no agent go under their club owner.
  UPDATE public.club_members m
     SET agent_id = c.owner_id, updated_at = now()
    FROM public.clubs c
   WHERE c.id = m.club_id
     AND m.agent_id IS NULL
     AND c.asset = 'chips' AND c.lifecycle_status = 'active' AND c.owner_id IS NOT NULL
     AND m.user_id <> c.owner_id
     AND m.role NOT IN ('owner', 'club_owner', 'co_owner', 'admin', 'club_admin')
     AND m.status IN ('active', 'approved', 'pending')
     AND m.membership_lifecycle_status = 'active'
     AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = m.user_id AND p.status = 'deleted');
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  -- 170 at the probe; new joins between the probe and this install add to it.
  IF v_moved < 150 OR v_moved > 400 THEN
    RAISE EXCEPTION 'OWNER_UPLINE_BACKFILL_UNEXPECTED: % rows', v_moved USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO v_left
    FROM public.club_members m JOIN public.clubs c ON c.id = m.club_id
   WHERE m.agent_id IS NULL AND c.asset = 'chips' AND c.lifecycle_status = 'active'
     AND m.user_id <> c.owner_id
     AND m.role NOT IN ('owner', 'club_owner', 'co_owner', 'admin', 'club_admin')
     AND m.status IN ('active', 'approved', 'pending')
     AND m.membership_lifecycle_status = 'active'
     AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = m.user_id AND p.status = 'deleted');
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'OWNER_UPLINE_BACKFILL_INCOMPLETE: % rows', v_left USING ERRCODE = '55000';
  END IF;

  -- A reassignment is not a join: no welcome text for the moved members.
  UPDATE public.club_messenger_admissions
     SET transaction_id = 0
   WHERE transaction_id = txid_current();

  RAISE NOTICE 'members_with_no_agent_sit_under_the_club_owner: % members moved', v_moved;
END
$members_with_no_agent_sit_under_the_club_owner$;

COMMIT;
