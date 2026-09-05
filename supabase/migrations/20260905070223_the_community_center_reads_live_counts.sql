-- 20260905070223_the_community_center_reads_live_counts.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- /community was a menu with no numbers on it. Seven links, each a static
-- label and a sentence; nothing on the page knew whether the player had two
-- friends or two thousand, or whether a connection request was waiting. Dan
-- 2026-09-05 asked for the sub pages to be done, and the Community Center's
-- job is to be the map of the section - a map with no readings is a list.
--
-- One RPC rather than six client round trips, and server-side rather than
-- client-side because "online" is a join the browser should not be paying for:
-- with 2,618 accepted friendship rows on the founder's account, counting
-- online friends in the client means pulling every profile to count a handful.
--
-- Every count is scoped to auth.uid() and the function takes no argument, so a
-- browser cannot ask about somebody else's community.
--
-- Deliberately absent: unread messages. /messages is a redirect out of Club
-- Arena into the World Hub messenger (NavigateToMessenger), whose conversation
-- tables this app does not own. A number invented from the wrong table would
-- be worse than no number.
--
-- The union count answers only for an account on the union_creators allowlist
-- (Dan 2026-09-05, "hidden to everyone except me"); everyone else reads null
-- and the Community Center renders no union entry at all.
--
-- Measured on production after apply: 156ms for the founder's account -
-- friends 1,309, online 1, clubs 4, unions 1.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_community_overview()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_union_ok boolean;
  v_out jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  v_union_ok := EXISTS (SELECT 1 FROM public.union_creators uc WHERE uc.user_id = v_uid);

  WITH edges AS MATERIALIZED (
    -- One row per counterparty, whichever side of the pair this account is on.
    -- DISTINCT because a reciprocal pair (a row each way) is one friendship,
    -- not two - the /friends list already dedupes this way. Every friendship
    -- on this platform is in fact stored both ways, so the raw row count is
    -- exactly double the number of people.
    SELECT DISTINCT f.friend_id AS other
      FROM public.friendships f
     WHERE f.user_id = v_uid AND f.status = 'accepted'
    UNION
    SELECT DISTINCT f.user_id
      FROM public.friendships f
     WHERE f.friend_id = v_uid AND f.status = 'accepted'
  ), presence AS MATERIALIZED (
    -- Same rule the client uses in utils/socialGraph.ts: the flag alone is not
    -- enough, because a crashed tab never clears it.
    SELECT count(*)::int AS online
      FROM edges e JOIN public.profiles p ON p.id = e.other
     WHERE coalesce(p.is_online, false)
       AND p.last_seen > now() - interval '5 minutes'
  ), requests AS MATERIALIZED (
    SELECT count(*)::int AS pending
      FROM public.friendships f
     WHERE f.friend_id = v_uid AND f.status = 'pending'
  ), challenges AS MATERIALIZED (
    SELECT count(*)::int AS incoming
      FROM public.friend_challenges fc
     WHERE fc.challengee_id = v_uid
       AND lower(coalesce(fc.status, '')) = 'pending'
       AND (fc.expires_at IS NULL OR fc.expires_at > now())
  ), clubs AS MATERIALIZED (
    SELECT count(DISTINCT cm.club_id)::int AS joined
      FROM public.club_members cm
     WHERE cm.user_id = v_uid
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
  ), unions AS MATERIALIZED (
    SELECT count(*)::int AS operated
      FROM public.unions u
     WHERE v_union_ok AND u.owner_id = v_uid
  )
  SELECT jsonb_build_object(
    'friends', (SELECT count(*)::int FROM edges),
    'online', (SELECT online FROM presence),
    'requests', (SELECT pending FROM requests),
    'challenges', (SELECT incoming FROM challenges),
    'clubs', (SELECT joined FROM clubs),
    -- null, not 0, so the client can tell "not allowed to see this" apart from
    -- "allowed, and the answer is none".
    'unions', CASE WHEN v_union_ok THEN (SELECT operated FROM unions) ELSE NULL END,
    'can_operate_union_network', v_union_ok
  ) INTO v_out;

  RETURN v_out;
END;
$function$;

COMMENT ON FUNCTION public.fn_community_overview() IS
  'Live readings for the Community Center (/community). Scoped to auth.uid(); takes no argument so a browser cannot ask about another account. Unread messages are deliberately absent - /messages leaves Club Arena for the World Hub messenger.';

REVOKE ALL ON FUNCTION public.fn_community_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_community_overview() TO authenticated, service_role;

-- It must answer for a real account, and it must refuse an anonymous one.
DO $$
DECLARE
  v_prev text := current_setting('request.jwt.claims', true);
  v_out jsonb;
  v_refused boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claims',
    '{"sub":"47965354-0e56-43ef-931c-ddaab82af765","role":"authenticated"}', true);
  v_out := public.fn_community_overview();

  IF (v_out->>'friends')::int IS NULL OR (v_out->>'friends')::int < 0 THEN
    RAISE EXCEPTION 'fn_community_overview: friends did not resolve (%)', v_out;
  END IF;
  IF (v_out->>'can_operate_union_network')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'fn_community_overview: the allowlisted founder was not recognised';
  END IF;
  IF v_out->>'unions' IS NULL THEN
    RAISE EXCEPTION 'fn_community_overview: an allowlisted account read a null union count';
  END IF;

  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    v_out := public.fn_community_overview();
  EXCEPTION WHEN OTHERS THEN
    v_refused := true;
  END;
  PERFORM set_config('request.jwt.claims', coalesce(v_prev, ''), true);

  IF NOT v_refused THEN
    RAISE EXCEPTION 'fn_community_overview: an unauthenticated caller was answered';
  END IF;
END $$;

COMMIT;
