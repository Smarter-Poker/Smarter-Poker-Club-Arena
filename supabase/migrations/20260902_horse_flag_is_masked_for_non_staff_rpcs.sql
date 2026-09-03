-- ═══════════════════════════════════════════════════════════════════════════
--  THE SECURITY DEFINER RPCs WALKED AROUND THE COLUMN REVOKE
-- ═══════════════════════════════════════════════════════════════════════════
-- APPLIED TO PRODUCTION 2026-09-02. Door #2 of three; see
-- 20260902_horse_identity_is_not_readable_by_a_player.sql (direct reads) and
-- 20260902_realtime_does_not_broadcast_horse_identity.sql (the wire).
--
-- The column REVOKE closes DIRECT reads. It does nothing about SECURITY
-- DEFINER functions, which run as their OWNER and read the column happily -
-- then hand it to whoever called them.
--
-- MEASURED as a PLAIN CLUB MEMBER (role 'member' - not staff, not an agent):
--     ca_club_members(club)      200 rows, 200 flagged is_horse   LEAKED
--     ca_club_top_players(club)  100 rows, 100 flagged is_horse   LEAKED
-- AFTER, same probe:
--     ca_club_members(club)      200 rows,   0 flagged            MASKED
--     ca_club_top_players(club)  100 rows,   0 flagged            MASKED
--     ca_club_members as OWNER   200 rows, 200 flagged            staff intact
--
-- Both gate on `ca_can_view_club(p_club_id)`, which ANY member passes, so the
-- roster answer was one supabase.rpc() away for every member of every club.
--
-- Of the sixteen authenticated-callable SECURITY DEFINER functions mentioning
-- is_horse, exactly FOUR return it; the other twelve only use it internally
-- (filters, fleet logic), which discloses nothing. The dedicated horse
-- analytics RPCs (ca_horse_hand_reviews, ca_horse_league_card,
-- ca_horse_review_summary, ca_horse_tag_trends) were already correct - probed
-- as an ordinary player, each answered "admin only".
--
-- MASKED, not removed: signatures and column order are unchanged so no caller
-- breaks. Staff get the truth; everyone else gets a uniform `false` on every
-- row. Uniform matters - NULL on some rows and a value on others would itself
-- be the signal.
--
-- WHO IS STAFF, and why narrow: owner, co_owner, admin, plus platform admins.
-- NOT manager/agent/sub_agent/super_agent - those are ordinary human users and
-- there are many. 10.5 sanctions identification on STAFF surfaces; club
-- leadership is the narrowest reading that keeps the operator roster working.
-- Being too narrow fails benignly: a manager sees every player as human.
--
-- ROLLBACK: re-apply each function with `coalesce(pr.is_horse,false)` in place
-- of the masked expression, and DROP FUNCTION public.fn_can_see_horse_flag(uuid).

CREATE OR REPLACE FUNCTION public.fn_can_see_horse_flag(p_club_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(public.fn_is_platform_admin(), false)
      OR EXISTS (
        SELECT 1 FROM public.club_members cm
        WHERE cm.club_id = p_club_id
          AND cm.user_id = auth.uid()
          AND COALESCE(cm.status,'active') IN ('active','approved')
          AND cm.role IN ('owner','co_owner','admin')
      );
$$;

COMMENT ON FUNCTION public.fn_can_see_horse_flag(uuid) IS
  'May the CALLER be told which members of this club are horses? Club leadership (owner/co_owner/admin) and platform admins only - deliberately not manager/agent/super_agent, who are ordinary human users. Dan 2026-09-02: a human user can never know.';

REVOKE ALL ON FUNCTION public.fn_can_see_horse_flag(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_can_see_horse_flag(uuid) TO authenticated;

-- ── 1. ca_club_top_players ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ca_club_top_players(p_club_id uuid, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 50)
 RETURNS TABLE(user_id uuid, display_name text, avatar_url text, is_horse boolean, hands_played bigint, hands_attributed bigint, hands_won bigint, total_won numeric, profit numeric, biggest_pot_won numeric, win_rate numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_may_see boolean := public.fn_can_see_horse_flag(p_club_id);
BEGIN
  IF NOT ca_can_view_club(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    s.user_id,
    coalesce(pr.display_name, 'Player')      AS display_name,
    pr.avatar_url,
    -- MASKED: staff get the truth, everyone else gets a uniform false.
    (v_may_see AND coalesce(pr.is_horse, false)) AS is_horse,
    sum(s.hands_played)::bigint              AS hands_played,
    sum(s.hands_attributed)::bigint          AS hands_attributed,
    sum(s.hands_won)::bigint                 AS hands_won,
    sum(s.total_won)                         AS total_won,
    sum(s.profit)                            AS profit,
    max(s.biggest_pot_won)                   AS biggest_pot_won,
    round(100.0 * sum(s.hands_won) / nullif(sum(s.hands_played), 0), 1) AS win_rate
  FROM club_member_daily_stats s
  LEFT JOIN profiles pr ON pr.id = s.user_id
  WHERE s.club_id = p_club_id
    AND (p_since IS NULL OR s.stat_date >= (p_since AT TIME ZONE 'UTC')::date)
  GROUP BY s.user_id, pr.display_name, pr.avatar_url, pr.is_horse
  HAVING sum(s.hands_played) > 0
  ORDER BY sum(s.profit) DESC
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 200);
END;
$function$;

-- ── 2. ca_club_members ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ca_club_members(p_club_id uuid, p_search text DEFAULT NULL::text, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_sort text DEFAULT 'hands'::text, p_role text DEFAULT NULL::text)
 RETURNS TABLE(user_id uuid, display_name text, avatar_url text, is_horse boolean, is_online boolean, role text, status text, joined_at timestamp with time zone, last_active timestamp with time zone, chip_balance numeric, hands_played bigint, profit numeric, total_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_role   text := nullif(btrim(coalesce(p_role, '')), '');
  v_sort   text := lower(coalesce(p_sort, 'hands'));
  v_may_see boolean := public.fn_can_see_horse_flag(p_club_id);
BEGIN
  IF NOT ca_can_view_club(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH seated AS (
    SELECT DISTINCT ts.user_id
    FROM table_seats ts
    JOIN tables t ON t.id = ts.table_id
    WHERE t.club_id = p_club_id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
  ),
  roster AS (
    SELECT cm.user_id, cm.role, cm.status, cm.created_at AS joined_at,
           cm.last_active, cm.chip_balance::numeric AS chip_balance,
           coalesce(pr.display_name, cm.display_name, 'Player') AS display_name,
           pr.avatar_url,
           -- MASKED: staff get the truth, everyone else gets a uniform false.
           (v_may_see AND coalesce(pr.is_horse, false)) AS is_horse,
           (s.user_id IS NOT NULL
            OR cm.last_active > now() - interval '15 minutes') AS is_online
    FROM club_members cm
    LEFT JOIN profiles pr ON pr.id = cm.user_id
    LEFT JOIN seated s ON s.user_id = cm.user_id
    WHERE cm.club_id = p_club_id
      AND coalesce(cm.status, 'active') NOT IN ('banned')
      AND (v_search IS NULL
           OR coalesce(pr.display_name, cm.display_name, '') ILIKE '%' || v_search || '%')
      AND (v_role IS NULL OR coalesce(cm.role, 'member') = v_role)
  ),
  perf AS (
    SELECT s.user_id,
           sum(s.hands_played)::bigint AS hands_played,
           sum(s.profit)               AS profit
    FROM club_member_daily_stats s
    WHERE s.club_id = p_club_id
      AND (p_since IS NULL OR s.stat_date >= (p_since AT TIME ZONE 'UTC')::date)
    GROUP BY s.user_id
  ),
  counted AS (SELECT count(*) AS n FROM roster)
  SELECT
    r.user_id, r.display_name, r.avatar_url, r.is_horse, r.is_online,
    r.role, r.status, r.joined_at, r.last_active, r.chip_balance,
    coalesce(p.hands_played, 0)::bigint,
    coalesce(p.profit, 0),
    c.n
  FROM roster r
  LEFT JOIN perf p ON p.user_id = r.user_id
  CROSS JOIN counted c
  ORDER BY
    CASE WHEN v_sort = 'profit' THEN coalesce(p.profit, 0) END DESC NULLS LAST,
    CASE WHEN v_sort = 'hands'  THEN coalesce(p.hands_played, 0) END DESC NULLS LAST,
    CASE WHEN v_sort = 'joined' THEN r.joined_at END DESC NULLS LAST,
    CASE WHEN v_sort = 'last_active' THEN r.last_active END DESC NULLS LAST,
    CASE WHEN v_sort = 'name'   THEN lower(r.display_name) END ASC NULLS LAST,
    r.joined_at DESC NULLS LAST,
    r.user_id
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
  OFFSET greatest(coalesce(p_offset, 0), 0);
END;
$function$;

-- ── 3. fn_club_cashier_members_v2 ─────────────────────────────────────────
-- (fn_club_cashier_members_page_v3 pages over this one and inherits the mask.)
CREATE OR REPLACE FUNCTION public.fn_club_cashier_members_v2(p_club_id uuid)
 RETURNS TABLE(user_id uuid, role text, role_rank integer, depth integer, chip_balance numeric, name text, username text, player_number text, avatar_url text, is_horse boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select m.user_id, m.role, m.role_rank, m.depth, m.chip_balance,
         m.name, m.username, m.player_number, m.avatar_url,
         -- MASKED: staff get the truth, everyone else gets a uniform false.
         (public.fn_can_see_horse_flag(p_club_id) and coalesce(p.is_horse, false))
    from public.fn_club_cashier_members(p_club_id) m
    left join public.profiles p on p.id=m.user_id
   order by m.role_rank desc, m.user_id
$function$;

DO $$
DECLARE v_helper int; v_masked int;
BEGIN
  SELECT count(*) INTO v_helper
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='fn_can_see_horse_flag';
  IF v_helper <> 1 THEN
    RAISE EXCEPTION 'POST-APPLY: fn_can_see_horse_flag was not created.';
  END IF;

  SELECT count(*) INTO v_masked
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public'
    AND p.proname IN ('ca_club_members','ca_club_top_players','fn_club_cashier_members_v2')
    AND pg_get_functiondef(p.oid) ILIKE '%fn_can_see_horse_flag%';
  IF v_masked <> 3 THEN
    RAISE EXCEPTION 'POST-APPLY: only % of 3 flag-returning RPCs consult the mask.', v_masked;
  END IF;
END $$;

-- ── AUDIENCE, STATED EXPLICITLY ───────────────────────────────────────────
-- The estate's `check-definer-authorization` guard blocked this migration on
-- first push, correctly. Its point was not that these are reachable by `anon`
-- in PRODUCTION today - probed, all three already answer "permission denied
-- for function" to a logged-out caller. Its point is that THIS FILE never
-- said so.
--
-- `CREATE OR REPLACE FUNCTION` does not reset privileges on an existing
-- function, so the good grants already in place survived. Applied to a FRESH
-- database, the same file would create three SECURITY DEFINER functions
-- carrying PostgreSQL's default `EXECUTE TO PUBLIC` - and a club roster, with
-- chip balances, would be readable by anybody with no account. A migration
-- that is only correct because of state it did not create is a trap for
-- whoever rebuilds this schema.
--
-- PUBLIC is named as well as `anon`, because `anon` inherits whatever PUBLIC
-- holds and revoking `anon` alone reads as a fix while doing nothing.

REVOKE ALL ON FUNCTION public.ca_club_members(uuid, text, timestamptz, integer, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_members(uuid, text, timestamptz, integer, integer, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.ca_club_top_players(uuid, timestamptz, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_top_players(uuid, timestamptz, integer) TO authenticated;

REVOKE ALL ON FUNCTION public.fn_club_cashier_members_v2(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_cashier_members_v2(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.fn_can_see_horse_flag(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_can_see_horse_flag(uuid) TO authenticated;

DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public'
    AND p.proname IN ('ca_club_members','ca_club_top_players','fn_club_cashier_members_v2','fn_can_see_horse_flag')
    AND (has_function_privilege('anon', p.oid, 'EXECUTE')
         OR has_function_privilege('public', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POST-APPLY: still reachable without an account: %', v_bad;
  END IF;

  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public'
    AND p.proname IN ('ca_club_members','ca_club_top_players','fn_club_cashier_members_v2','fn_can_see_horse_flag')
    AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POST-APPLY: a signed-in player can no longer call: %', v_bad;
  END IF;
END $$;
