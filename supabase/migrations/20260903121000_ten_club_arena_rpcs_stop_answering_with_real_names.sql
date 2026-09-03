-- ============================================================================
-- TEN CLUB ARENA RPCs STOP ANSWERING WITH REAL NAMES
--
-- Dan, 2026-09-02: "THE CLUB ARENA SHOULD ALWAYS 100% OF THE TIME USE THE
-- POKER ALIAS AND NOT THE REAL NAME, THE REAL NAME IS USED IN THE WORLD HUB."
--
-- 20260903120000 gave Postgres one resolver (public.fn_arena_name) and fixed
-- the three legacy name functions plus fn_search_players. It did not fix the
-- RPCs that reach into `profiles` and select a name themselves. A survey of
-- every public function that joins profiles and emits display_name found 76;
-- 20 of them are called from THIS repo, and the rest are the home_game /
-- home_group family, which this repo never calls - those are World Hub
-- surfaces, where Dan says the real name belongs. That is the boundary, and
-- it is why they are left alone rather than swept up.
--
-- This migration does the first ten. Each one is byte-identical to the
-- definition that was live, EXCEPT for the expression that produces a person's
-- name. Nothing else moved: no signature, no volatility, no search_path, no
-- authorisation check, no money arithmetic.
--
-- WHAT EACH WAS DOING WRONG
--
--   ca_club_activity            emitted pr.display_name raw
--   ca_club_top_players         coalesce(pr.display_name, 'Player')
--   fn_list_pending_members     emitted p.display_name raw
--   fn_union_player_directory   emitted pr.display_name raw
--   get_top_mission_completers  emitted p.display_name raw
--   fn_cashout_queue            display_name FIRST, alias second
--   fn_club_cashier_members     display_name FIRST, alias second
--   ca_promo_vault_records      alias first, but fell to display_name
--   ca_club_member_downline     alias first, but fell to display_name
--   fn_my_wallet_ledger         coalesce(display_name, username, FULL_NAME)
--
-- The last one is the plainest: a player's wallet ledger named `full_name` as
-- an explicit fallback, so every chip transfer they had ever received could be
-- captioned with the counterparty's legal name.
--
-- ca_club_top_players needed one further change: its GROUP BY listed
-- pr.display_name, so the new expression's inputs had to join it. The grouping
-- is already one row per s.user_id, so adding them changes no result.
--
-- DDL POLICY (CLAUDE.md, 2026-08-31): one transaction, so PostgREST rebuilds
-- its schema cache once (~28s) rather than ten times.
--
-- ROLLBACK: function bodies only; nothing dropped, no signature or column
-- changed. Each previous definition differs from the text below ONLY in the
-- name expression described above, so reverting is a matter of putting the
-- original coalesce back.
-- ============================================================================

BEGIN;

-- 1. Club activity feed ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ca_club_activity(p_club_id uuid, p_limit integer DEFAULT 20)
 RETURNS TABLE(id text, activity_type text, message text, created_at timestamp with time zone, user_id uuid, display_name text, avatar_url text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT ca_can_view_club(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH events AS (
    (SELECT
       'join-' || cm.user_id::text AS id,
       'member_join'::text         AS activity_type,
       'joined the club'::text     AS message,
       cm.created_at               AS created_at,
       cm.user_id                  AS user_id
     FROM club_members cm
     WHERE cm.club_id = p_club_id
       AND cm.created_at > now() - interval '30 days'
     ORDER BY cm.created_at DESC
     LIMIT 50)
    UNION ALL
    (SELECT
       'ann-' || an.id::text,
       'announcement',
       coalesce(nullif(an.title, ''), left(coalesce(an.content, an.message, 'New announcement'), 120)),
       an.created_at,
       coalesce(an.author_id, an.created_by)
     FROM club_announcements an
     WHERE an.club_id = p_club_id
       AND an.created_at > now() - interval '30 days'
       AND coalesce(an.is_active, true)
     ORDER BY an.created_at DESC
     LIMIT 20)
    UNION ALL
    (SELECT
       'hand-' || hh.id::text,
       'big_hand',
       'won a ' || to_char(coalesce(hh.pot_size, 0), 'FM999,999,990.00') || ' pot'
         || CASE WHEN hh.hand_name IS NOT NULL THEN ' with ' || hh.hand_name ELSE '' END,
       hh.created_at,
       CASE
         WHEN (hh.winners->0->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         THEN (hh.winners->0->>'userId')::uuid
         ELSE NULL
       END
     FROM hand_history hh
     JOIN tables t ON t.id = hh.table_id
     WHERE t.club_id = p_club_id
       AND hh.created_at > now() - interval '48 hours'
       AND coalesce(hh.pot_size, 0) >= 40 * greatest(coalesce(hh.big_blind, 0.02), 0.02)
     ORDER BY hh.created_at DESC
     LIMIT 30)
    UNION ALL
    (SELECT
       'table-' || t.id::text,
       'table_start',
       'Table "' || coalesce(t.name, 'Unnamed') || '" was created',
       t.created_at,
       t.created_by
     FROM tables t
     WHERE t.club_id = p_club_id
       AND t.created_at > now() - interval '7 days'
       AND coalesce(t.is_deleted, false) = false
     ORDER BY t.created_at DESC
     LIMIT 10)
  )
  SELECT
    e.id, e.activity_type, e.message, e.created_at, e.user_id,
    public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                         pr.first_name, pr.last_name, pr.full_name),
    pr.avatar_url
  FROM events e
  LEFT JOIN profiles pr ON pr.id = e.user_id
  WHERE e.created_at IS NOT NULL
  ORDER BY e.created_at DESC
  LIMIT least(greatest(coalesce(p_limit, 20), 1), 100);
END;
$function$;

-- 2. Club leaderboard --------------------------------------------------------
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
    public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                         pr.first_name, pr.last_name, pr.full_name) AS display_name,
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
  GROUP BY s.user_id, pr.alias, pr.username, pr.display_name,
           pr.first_name, pr.last_name, pr.full_name, pr.avatar_url, pr.is_horse
  HAVING sum(s.hands_played) > 0
  ORDER BY sum(s.profit) DESC
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 200);
END;
$function$;

-- 3. Pending member approvals ------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_list_pending_members(p_club_id uuid)
 RETURNS TABLE(user_id uuid, role text, status text, created_at timestamp with time zone, username text, display_name text, avatar_url text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF NOT is_club_admin(p_club_id, auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
    SELECT cm.user_id,
           cm.role::text,
           cm.status,
           cm.created_at,
           p.username,
           public.fn_arena_name(p.alias, p.username, p.display_name,
                                p.first_name, p.last_name, p.full_name),
           p.avatar_url
    FROM club_members cm
    LEFT JOIN profiles p ON p.id = cm.user_id
    WHERE cm.club_id = p_club_id AND cm.status = 'pending'
    ORDER BY cm.created_at DESC;
END;
$function$;

-- 4. Union player directory --------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_union_player_directory(p_union_id uuid)
 RETURNS TABLE(user_id uuid, username text, display_name text, avatar_url text, club_id uuid, club_name text, member_role text, member_status text, joined_at timestamp with time zone, currently_seated boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.fn_is_union_overseer(p_union_id, auth.uid()) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  RETURN QUERY
  WITH union_scope AS (
    SELECT uc.club_id AS id FROM union_clubs uc WHERE uc.union_id = p_union_id
    UNION
    SELECT c.id FROM clubs c WHERE c.id = p_union_id AND COALESCE(c.is_union, false)
  )
  SELECT cm.user_id,
         pr.username,
         public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                              pr.first_name, pr.last_name, pr.full_name),
         pr.avatar_url,
         cm.club_id,
         c.name,
         cm.role,
         cm.status,
         cm.joined_at,
         EXISTS (
           SELECT 1 FROM table_seats ts
             JOIN tables t ON t.id = ts.table_id
            WHERE ts.user_id = cm.user_id AND ts.left_at IS NULL
              AND t.union_id = p_union_id
         )
    FROM club_members cm
    JOIN union_scope us ON us.id = cm.club_id
    JOIN clubs c ON c.id = cm.club_id
    LEFT JOIN profiles pr ON pr.id = cm.user_id
   ORDER BY c.name, pr.username NULLS LAST;
END $function$;

-- 5. Mission leaderboard -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_top_mission_completers(p_club_id uuid, p_limit integer DEFAULT 10)
 RETURNS json
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$ BEGIN RETURN (SELECT COALESCE(json_agg(row_to_json(t)), '[]'::JSON) FROM (SELECT cm.user_id, public.fn_arena_name(p.alias, p.username, p.display_name, p.first_name, p.last_name, p.full_name) AS display_name, p.avatar_url, COALESCE(cm.missions_completed, 0) AS missions_completed FROM club_members cm LEFT JOIN profiles p ON cm.user_id = p.id WHERE cm.club_id = p_club_id ORDER BY cm.missions_completed DESC NULLS LAST LIMIT p_limit) t); END; $function$;

-- 6. Cashout queue -----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_cashout_queue(p_club_id uuid DEFAULT NULL::uuid, p_status text DEFAULT 'pending'::text)
 RETURNS TABLE(id uuid, club_id uuid, player_id uuid, player_name text, player_avatar text, agent_id uuid, amount numeric, status text, player_note text, agent_note text, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select cr.id, cr.club_id, cr.player_id,
         public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                              pr.first_name, pr.last_name, pr.full_name)::text,
         coalesce(nullif(btrim(pr.arena_avatar_url), ''), nullif(btrim(pr.avatar_url), ''), '')::text,
         cr.agent_id, cr.amount, cr.status, cr.player_note, cr.agent_note, cr.created_at
    from cashout_requests cr
    left join profiles pr on pr.id = cr.player_id
   where auth.uid() is not null
     and (p_club_id is null or cr.club_id = p_club_id)
     and (p_status is null or cr.status = p_status)
     and (
       cr.agent_id = auth.uid()
       or public.fn_club_bank_role(cr.club_id) in ('owner', 'co_owner', 'admin')
       or public.fn_club_is_in_downline(cr.club_id, auth.uid(), cr.player_id)
     )
   order by cr.created_at desc
   limit 200;
$function$;

-- 7. Cashier member picker ---------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_club_cashier_members(p_club_id uuid)
 RETURNS TABLE(user_id uuid, role text, role_rank integer, depth integer, chip_balance numeric, name text, username text, player_number text, avatar_url text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_scope text;
begin
  if v_actor is null or p_club_id is null then
    return;
  end if;

  v_scope := public.fn_club_cashier_scope(p_club_id, v_actor);
  if v_scope = 'none' then
    return;
  end if;

  return query
  with recursive
  edges as (
    select cm.user_id as child, cm.agent_id as parent
      from club_members cm
     where cm.club_id = p_club_id
       and coalesce(cm.status, 'active') in ('active', 'approved')
       and cm.agent_id is not null
       and cm.agent_id <> cm.user_id
  ),
  tree as (
    select e.child, array[e.child] as path, 1 as depth
      from edges e
     where e.parent = v_actor
    union all
    select e.child, t.path || e.child, t.depth + 1
      from tree t
      join edges e on e.parent = t.child
     where not (e.child = any (t.path))
       and t.depth < 20
  ),
  flat as (
    select t.child as uid, min(t.depth)::int as d
      from tree t
     group by t.child
  ),
  scoped as (
    select cm.user_id as uid,
           coalesce(cm.role, 'player') as r,
           coalesce(cm.chip_balance, 0)::numeric as bal,
           coalesce(f.d, 0) as d
      from club_members cm
      left join flat f on f.uid = cm.user_id
     where cm.club_id = p_club_id
       and coalesce(cm.status, 'active') in ('active', 'approved')
       and (v_scope = 'all' or f.uid is not null)
  )
  select s.uid,
         s.r,
         (case s.r
            when 'owner' then 100 when 'co_owner' then 90 when 'admin' then 80
            when 'super_agent' then 60 when 'agent' then 40 when 'sub_agent' then 20
            else 0 end)::int,
         s.d,
         s.bal,
         public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                              pr.first_name, pr.last_name, pr.full_name)::text,
         coalesce(pr.username, '')::text,
         coalesce(pr.player_number, '')::text,
         coalesce(nullif(btrim(pr.avatar_url), ''), nullif(btrim(pr.arena_avatar_url), ''), '')::text
    from scoped s
    left join profiles pr on pr.id = s.uid
   order by s.d asc,
            (case s.r
               when 'owner' then 100 when 'co_owner' then 90 when 'admin' then 80
               when 'super_agent' then 60 when 'agent' then 40 when 'sub_agent' then 20
               else 0 end) desc,
            lower(public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                                       pr.first_name, pr.last_name, pr.full_name));
end
$function$;

-- 8. Promo vault records -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.ca_promo_vault_records(p_club_id uuid, p_limit integer DEFAULT 100)
 RETURNS TABLE(id uuid, created_at timestamp with time zone, action text, item_key text, item_label text, item_category text, item_duration_days integer, quantity integer, diamonds_spent integer, actor_user_id uuid, actor_name text, recipient_user_id uuid, recipient_name text, recipient_player_number text, note text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    r.id,
    r.created_at,
    r.action,
    r.item_key,
    coalesce(c.label, r.item_key)::text,
    coalesce(c.category, 'feature')::text,
    c.duration_days,
    r.quantity,
    r.diamonds_spent,
    r.actor_user_id,
    public.fn_arena_name(ap.alias, ap.username, ap.display_name,
                         ap.first_name, ap.last_name, ap.full_name)::text,
    r.recipient_user_id,
    public.fn_arena_name(rp.alias, rp.username, rp.display_name,
                         rp.first_name, rp.last_name, rp.full_name)::text,
    rp.player_number::text,
    r.note
  FROM public.promo_vault_records r
  LEFT JOIN public.promo_vault_catalog c ON c.item_key = r.item_key
  LEFT JOIN public.profiles ap ON ap.id = r.actor_user_id
  LEFT JOIN public.profiles rp ON rp.id = r.recipient_user_id
  WHERE r.club_id = p_club_id
  ORDER BY r.created_at DESC
  LIMIT greatest(1, least(coalesce(p_limit, 100), 500));
$function$;

-- 9. Agent downline roster ---------------------------------------------------
CREATE OR REPLACE FUNCTION public.ca_club_member_downline(p_club_id uuid, p_user_id uuid)
 RETURNS TABLE(user_id uuid, player_number text, alias text, username text, role text, role_rank integer, depth integer, chip_balance numeric, total_fees numeric, is_online boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_scope uuid[] := public.fn_club_scope_ids(p_club_id);
  v_access text := public.ca_club_roster_access(p_club_id, p_user_id);
BEGIN
  IF v_access NOT IN ('staff', 'downline', 'service') OR v_scope IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH RECURSIVE edges AS MATERIALIZED (
    SELECT DISTINCT cm.user_id AS child, cm.agent_id AS parent
      FROM public.club_members cm
     WHERE cm.club_id = p_club_id AND cm.agent_id IS NOT NULL AND cm.agent_id <> cm.user_id
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
  ), tree AS (
    SELECT e.child, 1 AS depth FROM edges e WHERE e.parent = p_user_id
    UNION ALL
    SELECT e.child, t.depth + 1 FROM tree t JOIN edges e ON e.parent = t.child WHERE t.depth < 20
  ), flat AS MATERIALIZED (
    SELECT t.child AS uid, min(t.depth)::int AS depth FROM tree t GROUP BY t.child
  ), mem AS MATERIALIZED (
    SELECT DISTINCT ON (cm.user_id) cm.user_id AS uid, cm.role, cm.chip_balance,
           public.fn_club_role_rank(cm.role) AS role_rank
      FROM public.club_members cm
     WHERE cm.club_id = p_club_id AND cm.user_id IN (SELECT f.uid FROM flat f)
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
     ORDER BY cm.user_id, public.fn_club_role_rank(cm.role) DESC, cm.joined_at ASC
  ), seated AS MATERIALIZED (
    SELECT DISTINCT ts.user_id AS uid FROM public.table_seats ts
      JOIN public.tables t ON t.id = ts.table_id
     WHERE ts.left_at IS NULL AND ts.user_id IN (SELECT f.uid FROM flat f)
       AND t.status IN ('waiting', 'running')
       AND (ts.club_id = p_club_id OR t.club_id = p_club_id)
  ), fees AS MATERIALIZED (
    SELECT r.user_id AS uid, sum(COALESCE(r.rake_paid, 0)) AS fee_total
      FROM public.ca_hand_facts r
     WHERE r.club_id = p_club_id AND r.user_id IN (SELECT f.uid FROM flat f)
     GROUP BY r.user_id
  )
  SELECT f.uid, pr.player_number::text,
         public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                              pr.first_name, pr.last_name, pr.full_name)::text,
         coalesce(pr.username, '')::text, coalesce(m.role, 'player')::text,
         coalesce(m.role_rank, 0), f.depth, coalesce(m.chip_balance, 0)::numeric,
         round(coalesce(fe.fee_total, 0), 2)::numeric,
         s.uid IS NOT NULL OR (coalesce(pr.is_online, false) AND pr.last_seen > now() - interval '5 minutes')
    FROM flat f LEFT JOIN mem m ON m.uid = f.uid LEFT JOIN public.profiles pr ON pr.id = f.uid
    LEFT JOIN seated s ON s.uid = f.uid LEFT JOIN fees fe ON fe.uid = f.uid
   ORDER BY f.depth, coalesce(m.role_rank, 0) DESC,
            lower(public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                                       pr.first_name, pr.last_name, pr.full_name));
END;
$function$;

-- 10. Player wallet ledger ---------------------------------------------------
-- This one named full_name outright, so every chip transfer a player had ever
-- received could be captioned with the counterparty's legal name.
CREATE OR REPLACE FUNCTION public.fn_my_wallet_ledger(p_club_id uuid, p_limit integer DEFAULT 40, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor   uuid := auth.uid();
  v_limit   int := least(greatest(coalesce(p_limit, 40), 1), 200);
  v_offset  int := greatest(coalesce(p_offset, 0), 0);
  v_role    text;
  v_chips   numeric := 0;
  v_agent_wallet numeric := 0;
  v_promo_wallet numeric := 0;
  v_total   bigint;
  v_in      numeric;
  v_out     numeric;
  v_rows    jsonb;
begin
  if v_actor is null then
    return jsonb_build_object('authorized', false, 'error', 'Not Authenticated');
  end if;

  select cm.role, coalesce(cm.chip_balance, 0) into v_role, v_chips
    from club_members cm
   where cm.club_id = p_club_id
     and cm.user_id = v_actor
     and coalesce(cm.status, 'active') in ('active', 'approved')
   limit 1;
  if v_role is null then
    if exists (select 1 from clubs c where c.id = p_club_id and c.owner_id = v_actor) then
      v_role := 'owner';
    else
      return jsonb_build_object('authorized', false,
        'error', 'You Are Not An Active Member Of This Club');
    end if;
  end if;

  select coalesce(a.agent_wallet_balance, 0), coalesce(a.promo_wallet_balance, 0)
    into v_agent_wallet, v_promo_wallet
    from agents a
   where a.club_id = p_club_id and a.user_id = v_actor;

  select count(*),
         coalesce(sum(t.amount) filter (where t.to_user_id = v_actor), 0),
         coalesce(sum(t.amount) filter (where t.from_user_id = v_actor), 0)
    into v_total, v_in, v_out
    from chip_transactions t
   where t.club_id = p_club_id
     and (t.from_user_id = v_actor or t.to_user_id = v_actor);

  select coalesce(jsonb_agg(r order by r->>'created_at' desc), '[]'::jsonb) into v_rows
  from (
    select jsonb_build_object(
             'id', t.id,
             'created_at', t.created_at,
             'amount', round(coalesce(t.amount, 0), 2),
             'transaction_type', t.transaction_type,
             'notes', t.notes,
             'metadata', coalesce(t.metadata, '{}'::jsonb),
             'is_reversed', coalesce(t.is_reversed, false),
             'direction', case when t.to_user_id = v_actor then 'in' else 'out' end,
             'from_name', public.fn_arena_name(pf.alias, pf.username, pf.display_name,
                                               pf.first_name, pf.last_name, pf.full_name),
             'to_name', public.fn_arena_name(pt.alias, pt.username, pt.display_name,
                                             pt.first_name, pt.last_name, pt.full_name)
           ) as r
      from chip_transactions t
      left join profiles pf on pf.id = t.from_user_id
      left join profiles pt on pt.id = t.to_user_id
     where t.club_id = p_club_id
       and (t.from_user_id = v_actor or t.to_user_id = v_actor)
     order by t.created_at desc
     limit v_limit offset v_offset
  ) s;

  return jsonb_build_object(
    'authorized', true,
    'role', v_role,
    'total', v_total,
    'limit', v_limit,
    'offset', v_offset,
    'balances', jsonb_build_object(
      'player_wallet', round(v_chips, 2),
      'agent_wallet', round(v_agent_wallet, 2),
      'promo_wallet', round(v_promo_wallet, 2)),
    'totals', jsonb_build_object(
      'received', round(v_in, 2),
      'sent', round(v_out, 2),
      'net', round(v_in - v_out, 2)),
    'rows', v_rows);
end
$function$;

-- ---------------------------------------------------------------------------
-- Assertion: all ten must now go through the resolver. Checked against the
-- catalog, so it cannot drift from the text above.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('ca_club_activity','ca_club_top_players','fn_list_pending_members',
                       'fn_union_player_directory','get_top_mission_completers','fn_cashout_queue',
                       'fn_club_cashier_members','ca_promo_vault_records','ca_club_member_downline',
                       'fn_my_wallet_ledger')
     AND pg_get_functiondef(p.oid) NOT ILIKE '%fn_arena_name%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'these functions did not pick up the arena resolver: %', v_bad;
  END IF;
END $$;

COMMIT;
