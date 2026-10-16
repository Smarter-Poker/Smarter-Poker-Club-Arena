-- 20261016004124_club_invite_stats_admit_automatic_members.sql
--
-- Version reserved by scripts/new-migration.mjs.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- fn_club_invite_club_stats looked up the caller's club role only among
-- members with status 'active' or 'approved'. A staff member or agent whose
-- membership status is 'automatic' (admitted by the club's automatic approval)
-- was therefore refused the Invite Stats table and shown "No Invites Yet",
-- although fn_club_invite_link, fn_redeem_club_invite_code and the club page
-- all treat 'automatic' as a settled member. The role lookup now accepts the
-- same three statuses. Function body only; nothing else changes, and the body
-- is otherwise identical to 20261015223818_club_invite_names_use_the_poker_alias.sql.
--
-- One transaction: one PostgREST schema reload (club-arena CLAUDE.md,
-- production DDL policy).

BEGIN;

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
   WHERE club_id = p_club_id AND user_id = v_uid AND status IN ('active','approved','automatic');
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
             COALESCE(NULLIF(btrim(p.alias), ''), NULLIF(btrim(p.username), ''), 'Unknown Player') AS alias,
             p.player_number,
             max(s.click_count) AS opened,
             (SELECT count(*) FROM public.club_invite_attributions a WHERE a.club_id = p_club_id AND a.inviter_id = s.inviter_id AND a.fresh_signup AND a.status <> 'blocked') AS signed_up,
             (SELECT count(*) FROM public.club_invite_attributions a WHERE a.club_id = p_club_id AND a.inviter_id = s.inviter_id AND a.verified_at IS NOT NULL AND a.status IN ('verified','joined')) AS verified,
             (SELECT count(*) FROM public.club_invite_attributions a WHERE a.club_id = p_club_id AND a.inviter_id = s.inviter_id AND a.status = 'joined') AS joined,
             (SELECT count(*) FROM public.club_invite_attributions a WHERE a.club_id = p_club_id AND a.inviter_id = s.inviter_id AND a.status = 'blocked') AS blocked
        FROM scoped s
        LEFT JOIN public.profiles p ON p.id = s.inviter_id
       GROUP BY s.inviter_id, p.alias, p.username, p.player_number
    ) r;

  RETURN jsonb_build_object('allowed', true, 'scope', CASE WHEN v_role IN ('owner','co_owner','admin') THEN 'club' ELSE 'downline' END, 'rows', v_rows);
END $$;

COMMIT;
