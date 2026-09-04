-- A PLAYER RECORD SAYS WHAT IT MEASURED.
--
-- Phase 5 of Dan's Club Operations upgrade: the Players pages
-- (/clubs/:id/members, /members/:userId, /members/:userId/statistics).
-- Measured against Deep Stack Society (2a1132b9) on 2026-09-04.
--
-- 1. THE 3-BET PERCENTAGE IS NOT A PERCENTAGE OF ANYTHING. ca_club_member_
--    statistics divides count(three_bet) by count(faced_three_bet). In the
--    engine (server/src/services/supabase/handFacts.ts) faced_three_bet means
--    "we OPENED and were 3-bet" - the denominator of fold-to-3-bet, and a set
--    that has nothing to do with the hands in which this player could 3-bet.
--    Over the club's five most active players the page shows 65.2%, 75.9%,
--    233.3%, 316.7% and 130.8%. Three of five are over one hundred percent.
--    ca_hand_facts carries no "had a 3-bet opportunity" flag (that is engine
--    work, noted for that programme), so the honest figure available today
--    is 3-bets per hand dealt - 2.4%, 2.0%, 4.5%, 4.3%, 4.0% for the same
--    five - and it is labelled as such. Fold To 3-Bet, which the two flags DO
--    measure exactly, is added: 73.9%, 48.3%, 72.2%, 58.3%, 57.7%.
--
-- 2. THE SAME NUMBER UNDER TWO LABELS. total_games and total_hands are both
--    a.hands; winner and wins are both a.wins. The page drew "Total Games",
--    "Total Hands" and "Winner" as three figures. The payload now names
--    hands, hands_won and win_rate; the old keys ride along for one release.
--
-- 3. "NOT FOUND" WAS UNREACHABLE. For a userId that is not a member the
--    access check answers 'none' and the page told an owner "Your Club Role
--    Does Not Permit Access". A viewer who is themselves a member of the club
--    is now told reason = 'not_member' when the target has no membership;
--    a viewer who is not a member learns nothing more than before.
--
-- 4. ca_can_view_club AND ca_can_view_club_finances RETURN TRUE FOR NO
--    ACCOUNT. Both open with `auth.uid() IS NULL OR ...`, the shortcut that
--    lets internal callers through. Latent today (anon holds no EXECUTE on
--    anything that calls them), but one GRANT away from publishing a club's
--    roster, and phase 1's overview already showed the shape: name the
--    internal callers (postgres, supabase_admin, service_role) instead of
--    treating the absence of a person as a person with every right.
--
-- Signatures unchanged; CREATE OR REPLACE keeps grants, restated below for
-- the definer gate. Horses are counted like every other player.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
--  4. The two membership gates name their internal callers
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ca_can_view_club(p_club_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    session_user IN ('postgres', 'supabase_admin')
    OR coalesce(auth.role(), '') = 'service_role'
    OR (
      auth.uid() IS NOT NULL
      AND (
        EXISTS (
          SELECT 1 FROM club_members cm
          WHERE cm.club_id = p_club_id
            AND cm.user_id = auth.uid()
            AND coalesce(cm.status, 'active') NOT IN ('banned', 'suspended')
        )
        OR EXISTS (
          SELECT 1 FROM clubs c WHERE c.id = p_club_id AND c.owner_id = auth.uid()
        )
        OR EXISTS (
          SELECT 1 FROM profiles pr
          WHERE pr.id = auth.uid() AND coalesce(pr.is_admin, false)
        )
      )
    );
$function$;

CREATE OR REPLACE FUNCTION public.ca_can_view_club_finances(p_club_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    session_user IN ('postgres', 'supabase_admin')
    OR coalesce(auth.role(), '') = 'service_role'
    OR (
      auth.uid() IS NOT NULL
      AND (
        EXISTS (
          SELECT 1 FROM club_members cm
           WHERE cm.club_id = p_club_id
             AND cm.user_id = auth.uid()
             AND coalesce(cm.status, 'active') NOT IN ('banned', 'suspended')
             AND cm.role IN ('owner', 'co_owner', 'admin', 'super_agent')
        )
        OR EXISTS (SELECT 1 FROM clubs c WHERE c.id = p_club_id AND c.owner_id = auth.uid())
        OR EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = auth.uid() AND coalesce(pr.is_admin, false))
      )
    );
$function$;

REVOKE ALL ON FUNCTION public.ca_can_view_club(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_can_view_club(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.ca_can_view_club_finances(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_can_view_club_finances(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.ca_can_view_club(uuid) IS
  'May the caller read this club? Internal callers (postgres, supabase_admin, service_role) yes; otherwise a signed-in non-banned member, the club owner, or a platform admin. Since 2026-09-04 a caller with no account is refused rather than admitted.';
COMMENT ON FUNCTION public.ca_can_view_club_finances(uuid) IS
  'May the caller read this club''s money? Internal callers yes; otherwise a signed-in owner / co_owner / admin / super_agent, the club owner, or a platform admin. Since 2026-09-04 a caller with no account is refused rather than admitted.';

-- ─────────────────────────────────────────────────────────────────────────
--  1-3. The statistics read
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ca_club_member_statistics(
  p_club_id uuid, p_user_id uuid, p_variant text DEFAULT NULL::text,
  p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_access text := public.ca_club_roster_access(p_club_id, p_user_id);
  v_variant text := NULLIF(lower(btrim(COALESCE(p_variant, ''))), '');
  v_from timestamptz := CASE WHEN p_from IS NULL THEN NULL ELSE p_from::timestamp AT TIME ZONE 'UTC' END;
  v_to timestamptz := CASE WHEN p_to IS NULL THEN NULL ELSE (p_to + 1)::timestamp AT TIME ZONE 'UTC' END;
  v_viewer_is_member boolean;
  v_target_is_member boolean;
  v_out jsonb;
BEGIN
  IF v_access NOT IN ('staff','downline','service') THEN
    -- A member of the club asking about somebody who is not one is told so;
    -- anyone else is told only that they may not look.
    v_viewer_is_member := auth.uid() IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.club_members cm
       WHERE cm.club_id = p_club_id AND cm.user_id = auth.uid()
         AND coalesce(cm.status, 'approved') IN ('active', 'approved'));
    v_target_is_member := EXISTS (
      SELECT 1 FROM public.club_members cm
       WHERE cm.club_id = p_club_id AND cm.user_id = p_user_id
         AND coalesce(cm.status, 'approved') IN ('active', 'approved'));
    RETURN jsonb_build_object(
      'authorized', false,
      'reason', CASE WHEN v_viewer_is_member AND NOT v_target_is_member
                     THEN 'not_member' ELSE 'restricted' END);
  END IF;

  WITH agg AS (
    SELECT count(DISTINCT f.hand_id)::bigint hands,
           count(DISTINCT f.hand_id) FILTER (WHERE f.net > 0)::bigint wins,
           count(*) FILTER (WHERE f.vpip)::bigint vpip_hands,
           count(*) FILTER (WHERE f.pfr)::bigint pfr_hands,
           count(*) FILTER (WHERE f.three_bet)::bigint tb_hands,
           -- faced_three_bet: this player OPENED and was 3-bet. The
           -- denominator of fold-to-3-bet, never of 3-bet.
           count(*) FILTER (WHERE f.faced_three_bet)::bigint faced_tb,
           count(*) FILTER (WHERE f.folded_to_three_bet)::bigint folded_tb,
           count(*) FILTER (WHERE f.cbet_flop)::bigint cb_hands,
           count(*) FILTER (WHERE f.had_cbet_flop_opp)::bigint cb_opps,
           COALESCE(sum(f.net),0) net, COALESCE(sum(f.rake_paid),0) fees
      FROM public.ca_hand_facts f
     WHERE f.club_id = p_club_id AND f.user_id = p_user_id
       AND (v_variant IS NULL OR v_variant = 'all' OR lower(f.game_variant) = v_variant)
       AND (v_from IS NULL OR f.played_at >= v_from) AND (v_to IS NULL OR f.played_at < v_to)
  ), vars AS (
    SELECT COALESCE(jsonb_agg(v.game_variant ORDER BY v.game_variant), '[]'::jsonb) list
      FROM (SELECT DISTINCT lower(f.game_variant) game_variant FROM public.ca_hand_facts f
             WHERE f.club_id = p_club_id AND f.user_id = p_user_id
               AND f.game_variant IS NOT NULL) v
  )
  SELECT jsonb_build_object(
    'authorized', true, 'variant', COALESCE(v_variant,'all'), 'variants', vars.list,
    'hands', a.hands,
    'hands_won', a.wins,
    'win_rate', COALESCE(round(100.0*a.wins/NULLIF(a.hands,0),2),0),
    -- LEGACY, one release: the bundle serving while this applies reads these.
    'total_games', a.hands, 'total_hands', a.hands, 'wins', a.wins, 'winner', a.wins,
    'vpip', COALESCE(round(100.0*a.vpip_hands/NULLIF(a.hands,0),2),0),
    'pfr',  COALESCE(round(100.0*a.pfr_hands/NULLIF(a.hands,0),2),0),
    -- 3-bets per hand dealt. Not per opportunity: the facts table does not
    -- record whether this player faced an open they could have 3-bet.
    'three_bet', COALESCE(round(100.0*a.tb_hands/NULLIF(a.hands,0),2),0),
    'three_bet_basis', 'hands',
    'three_bets', a.tb_hands,
    'fold_to_three_bet', COALESCE(round(100.0*a.folded_tb/NULLIF(a.faced_tb,0),2),0),
    'faced_three_bets', a.faced_tb,
    'cbet', COALESCE(round(100.0*a.cb_hands/NULLIF(a.cb_opps,0),2),0),
    'cbet_opportunities', a.cb_opps,
    'net', round(a.net,2), 'fees', round(a.fees,2),
    'from', p_from, 'to', p_to, 'is_overall', p_from IS NULL AND p_to IS NULL
  ) INTO v_out FROM agg a CROSS JOIN vars;
  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_club_member_statistics(uuid, uuid, text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_member_statistics(uuid, uuid, text, date, date) TO authenticated, service_role;

COMMENT ON FUNCTION public.ca_club_member_statistics(uuid, uuid, text, date, date) IS
  'Poker statistics for one member of a club. three_bet is 3-bets per hand dealt (three_bet_basis says so); fold_to_three_bet is folds per open that was 3-bet. hands / hands_won / win_rate replace total_games / total_hands / winner, kept one release. authorized=false carries reason not_member or restricted.';

-- ─────────────────────────────────────────────────────────────────────────
--  Assertions
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public'
     AND p.proname IN ('ca_can_view_club', 'ca_can_view_club_finances', 'ca_club_member_statistics')
     AND p.prosecdef
     AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF n <> 3 THEN RAISE EXCEPTION 'expected 3 gated definer functions, found %', n; END IF;

  -- The two gates no longer admit a caller with no account.
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'ca_can_view_club') LIKE '%auth.uid() IS NULL%' THEN
    RAISE EXCEPTION 'ca_can_view_club still admits a caller with no account';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'ca_can_view_club_finances') LIKE '%auth.uid() IS NULL%' THEN
    RAISE EXCEPTION 'ca_can_view_club_finances still admits a caller with no account';
  END IF;
END $$;

COMMIT;
