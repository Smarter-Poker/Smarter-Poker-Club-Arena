-- The board opens on the live floor, and "scheduled" means it has not started.
--
-- Two bugs, both measured on Deep Stack Society
-- (2a1132b9-5ba2-42e6-9f01-30a7fcffebe3) on 2026-09-02.
--
-- 1. THE SCHEDULED COUNTER READ ZERO WITH 36 TOURNAMENTS SCHEDULED.
--    `scheduled` was defined by exclusion: a tournament whose status is NOT in
--    the live list and NOT in the closed list. Every tournament in this system
--    is REGISTERING until it ends, and REGISTERING is in the LIVE list - so no
--    row could ever satisfy it. The counter was structurally zero, and the
--    "Scheduled" tab it feeds was a permanently empty view. The 36 events
--    starting between now and 2026-09-05 were all being counted as live.
--
--    Scheduled now means what an operator means by it: it has not started yet.
--    `start_time > now()`. A table has no start time and is never scheduled.
--
-- 2. THE FIRST PAGE HELD NO OPEN TABLE AND NO ACTIVE GAME.
--    Ordering was `sort_at ASC` across every game the club has ever had, and
--    sort_at is created_at. Deep Stack had 835 closed tables and 309 finished
--    tournaments against ~259 live games, so page 1 of 100 was 94 COMPLETED
--    and 6 CANCELLED tournaments from two days earlier - verified by calling
--    this function as the club owner. The live floor started around page 12.
--    A control surface that opens on two-day-old dead games is not a control
--    surface.
--
--    Rows now carry a priority bucket and order by it first:
--      0  live      - anything the operator can act on right now
--      1  scheduled - starts later
--      2  closed    - terminal, kept for history
--    Within a bucket the previous ordering is unchanged (sort_at, kind, id),
--    so scheduled events still read soonest-first.
--
-- An UNKNOWN status sorts into bucket 0, deliberately. The failure mode of
-- this whole function has been hiding things from the operator, so a status
-- nobody anticipated surfaces at the top rather than disappearing into
-- history.
--
-- The bucket joins the keyset cursor, which is why p_cursor_bucket is added.
-- It is defaulted, so the currently deployed frontend - which sends six named
-- arguments and knows nothing about buckets - keeps working unchanged; its
-- cursor simply coalesces to bucket 0. DROP and CREATE rather than CREATE OR
-- REPLACE because adding a defaulted argument makes a NEW signature, and
-- leaving both would give PostgREST an ambiguous overload to choose from.
--
-- Horses are counted and displayed exactly as any other player: nothing here
-- reads is_horse, and the buckets test status and start time only.

BEGIN;

SET LOCAL lock_timeout = '30s';

DROP FUNCTION IF EXISTS public.fn_list_managed_games(text, uuid, timestamptz, text, uuid, integer);

CREATE FUNCTION public.fn_list_managed_games(
  p_scope         text,
  p_scope_id      uuid,
  p_cursor        timestamptz DEFAULT NULL,
  p_cursor_kind   text        DEFAULT NULL,
  p_cursor_id     uuid        DEFAULT NULL,
  p_limit         integer     DEFAULT 100,
  p_cursor_bucket integer     DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_limit integer := LEAST(100, GREATEST(1, COALESCE(p_limit, 100)));
  v_items jsonb; v_counts jsonb; v_next jsonb; v_access jsonb; v_scope_clubs uuid[];
  v_cur_bucket integer := COALESCE(p_cursor_bucket, 0);
BEGIN
  IF p_scope NOT IN ('club','union') OR p_scope_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','not_authorized');
  END IF;
  IF p_scope='club' THEN
    v_access := public.fn_game_creation_access(p_scope_id);
    IF NOT COALESCE((v_access->>'allowed')::boolean,false)
       OR v_access->>'union_id' IS NOT NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','not_authorized');
    END IF;
  ELSIF NOT public.fn_is_union_operator(p_scope_id,auth.uid()) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_authorized');
  END IF;
  IF p_scope='union' THEN
    SELECT COALESCE(array_agg(x.club_id),'{}'::uuid[]) INTO v_scope_clubs
    FROM (
      SELECT p_scope_id AS club_id
      UNION SELECT uc.club_id FROM public.union_clubs uc WHERE uc.union_id=p_scope_id
      UNION SELECT c.id FROM public.clubs c WHERE c.union_id=p_scope_id
    ) x;
  END IF;

  WITH all_games AS (
    SELECT t.id,'table'::text kind,t.club_id,t.name,t.status,COALESCE(t.game_variant,'NLH') variant,
      COALESCE(t.current_players,0) players,COALESCE(t.max_players,0) max_players,
      NULL::timestamptz start_time,t.created_at sort_at,COALESCE(t.small_blind,0) small_blind,
      COALESCE(t.big_blind,0) big_blind,COALESCE(t.min_buy_in,0) min_buy_in,
      COALESCE(t.max_buy_in,0) max_buy_in,0::numeric buy_in,
      CASE WHEN lower(t.status) IN ('closed','completed','cancelled','canceled','deleted')
           THEN 2 ELSE 0 END AS bucket
    FROM public.tables t WHERE t.tournament_id IS NULL AND NOT COALESCE(t.is_deleted,false)
      AND ((p_scope='club' AND t.club_id=p_scope_id AND t.union_id IS NULL)
        OR (p_scope='union' AND (t.union_id=p_scope_id OR t.club_id=ANY(v_scope_clubs))))
    UNION ALL
    SELECT t.id,'tournament',t.club_id,t.name,t.status,COALESCE(t.game_type,t.variant,'MTT'),
      COALESCE(t.current_players,0),COALESCE(t.max_players,0),t.start_time,
      COALESCE(t.start_time,t.created_at),0::numeric,0::numeric,0::numeric,0::numeric,
      COALESCE(t.buy_in_amount,0),
      CASE WHEN lower(t.status) IN ('closed','completed','cancelled','canceled','deleted') THEN 2
           WHEN t.start_time > now() THEN 1
           ELSE 0 END
    FROM public.tournaments t WHERE
      (p_scope='club' AND t.club_id=p_scope_id AND t.union_id IS NULL)
      OR (p_scope='union' AND (t.union_id=p_scope_id OR t.club_id=ANY(v_scope_clubs)))
  ), page AS (
    SELECT g.* FROM all_games g
    WHERE p_cursor IS NULL
       OR (g.bucket,g.sort_at,g.kind,g.id)>(v_cur_bucket,p_cursor,p_cursor_kind,p_cursor_id)
    ORDER BY g.bucket,g.sort_at,g.kind,g.id LIMIT v_limit
  ), enriched AS (
    SELECT p.*,(SELECT to_jsonb(s) FROM (
      SELECT ms.schedule_id,ms.execute_at,ms.status FROM public.managed_game_schedules ms
      WHERE ms.game_kind=p.kind AND ms.game_id=p.id AND ms.status='scheduled'
      ORDER BY ms.created_at DESC LIMIT 1) s) pending_schedule
    FROM page p ORDER BY p.bucket,p.sort_at,p.kind,p.id
  ) SELECT COALESCE(jsonb_agg(to_jsonb(enriched) ORDER BY bucket,sort_at,kind,id),'[]'::jsonb)
    INTO v_items FROM enriched;

  WITH scoped AS (
    SELECT status,'table'::text kind,NULL::timestamptz start_time FROM public.tables t
    WHERE t.tournament_id IS NULL AND NOT COALESCE(t.is_deleted,false)
      AND ((p_scope='club' AND t.club_id=p_scope_id AND t.union_id IS NULL)
        OR (p_scope='union' AND (t.union_id=p_scope_id OR t.club_id=ANY(v_scope_clubs))))
    UNION ALL SELECT status,'tournament',t.start_time FROM public.tournaments t WHERE
      (p_scope='club' AND t.club_id=p_scope_id AND t.union_id IS NULL)
      OR (p_scope='union' AND (t.union_id=p_scope_id OR t.club_id=ANY(v_scope_clubs)))
  ), bucketed AS (
    SELECT CASE
      WHEN lower(status) IN ('closed','completed','cancelled','canceled','deleted') THEN 2
      WHEN kind='tournament' AND start_time > now() THEN 1
      ELSE 0 END AS bucket
    FROM scoped
  ) SELECT jsonb_build_object(
      'total',count(*),
      'live',count(*) FILTER (WHERE bucket=0),
      'scheduled',count(*) FILTER (WHERE bucket=1),
      'closed',count(*) FILTER (WHERE bucket=2))
  INTO v_counts FROM bucketed;

  WITH all_games AS (
    SELECT t.id,'table'::text kind,t.created_at sort_at,
      CASE WHEN lower(t.status) IN ('closed','completed','cancelled','canceled','deleted')
           THEN 2 ELSE 0 END AS bucket
    FROM public.tables t
    WHERE t.tournament_id IS NULL AND NOT COALESCE(t.is_deleted,false)
      AND ((p_scope='club' AND t.club_id=p_scope_id AND t.union_id IS NULL)
        OR (p_scope='union' AND (t.union_id=p_scope_id OR t.club_id=ANY(v_scope_clubs))))
    UNION ALL SELECT t.id,'tournament',COALESCE(t.start_time,t.created_at),
      CASE WHEN lower(t.status) IN ('closed','completed','cancelled','canceled','deleted') THEN 2
           WHEN t.start_time > now() THEN 1
           ELSE 0 END
    FROM public.tournaments t WHERE (p_scope='club' AND t.club_id=p_scope_id AND t.union_id IS NULL)
      OR (p_scope='union' AND (t.union_id=p_scope_id OR t.club_id=ANY(v_scope_clubs)))
  ), remaining AS (
    SELECT * FROM all_games
    WHERE p_cursor IS NULL OR (bucket,sort_at,kind,id)>(v_cur_bucket,p_cursor,p_cursor_kind,p_cursor_id)
    ORDER BY bucket,sort_at,kind,id OFFSET v_limit LIMIT 1
  ), last_item AS (
    SELECT * FROM all_games
    WHERE p_cursor IS NULL OR (bucket,sort_at,kind,id)>(v_cur_bucket,p_cursor,p_cursor_kind,p_cursor_id)
    ORDER BY bucket,sort_at,kind,id OFFSET GREATEST(v_limit-1,0) LIMIT 1
  ) SELECT CASE WHEN EXISTS(SELECT 1 FROM remaining) THEN
    (SELECT jsonb_build_object('sort_at',sort_at,'kind',kind,'id',id,'bucket',bucket) FROM last_item)
    ELSE NULL END INTO v_next;

  RETURN jsonb_build_object('ok',true,'items',v_items,'counts',v_counts,'next_cursor',v_next);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_list_managed_games(text,uuid,timestamptz,text,uuid,integer,integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_list_managed_games(text,uuid,timestamptz,text,uuid,integer,integer) TO authenticated, service_role;

DO $assert$
DECLARE v_n integer;
BEGIN
  -- Exactly one overload, or PostgREST has a choice to make and will make it badly.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_list_managed_games';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'expected exactly one fn_list_managed_games, found %', v_n;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='fn_list_managed_games'
      AND p.prosecdef AND p.provolatile='s'
  ) THEN
    RAISE EXCEPTION 'fn_list_managed_games lost SECURITY DEFINER or STABLE';
  END IF;

  IF has_function_privilege('anon',
      'public.fn_list_managed_games(text,uuid,timestamptz,text,uuid,integer,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'fn_list_managed_games is reachable by anon';
  END IF;
END;
$assert$;

COMMIT;
