-- A tab is a query, not a filter over whatever page happens to be loaded.
--
-- The board's four tabs (All / Running / Scheduled / Closed) filtered the rows
-- ALREADY LOADED - `games.filter(...)` over one page of 100 - while the list
-- itself is server-paginated. That was survivable only while the ordering was
-- chronological and every page held a mixture. the_board_opens_on_the_live_floor
-- made the ordering bucketed, which is right for the default view and turned
-- the other two tabs into liars:
--
--   Deep Stack Society, measured page by page after that change:
--     p1 live=100  p2 live=100  p3 live=75 sched=25  p4 sched=11 closed=89
--
-- So on first load the Scheduled tab had nothing to show though the counter
-- beside it read 36, and Closed had nothing though 1,144 exist. The operator
-- would have had to press Load More twice to see a scheduled game and three
-- times to see a closed one, with the empty state claiming "No Games In This
-- View" the whole way. A counter and a tab that disagree are worse than either
-- being wrong alone.
--
-- p_bucket makes the tab a real query. The counts are deliberately NOT filtered
-- with it: the header summarises the whole club (live / scheduled / closed /
-- total) whichever tab is open, which is the only reading under which the
-- counter and the tab can never contradict each other again.
--
-- The cursor is unchanged in shape. Within a filtered view the bucket is
-- constant, so (bucket, sort_at, kind, id) still totally orders the page and
-- keyset paging works exactly as it does unfiltered.
--
-- DROP and CREATE rather than CREATE OR REPLACE, again because a new defaulted
-- argument is a NEW signature and leaving both would hand PostgREST an
-- ambiguous overload. Every argument after p_scope_id is defaulted, so a caller
-- that knows nothing of p_bucket - including the frontend deployed right now -
-- keeps getting the unfiltered board.

BEGIN;

SET LOCAL lock_timeout = '30s';

DROP FUNCTION IF EXISTS public.fn_list_managed_games(text, uuid, timestamptz, text, uuid, integer, integer);

CREATE FUNCTION public.fn_list_managed_games(
  p_scope         text,
  p_scope_id      uuid,
  p_cursor        timestamptz DEFAULT NULL,
  p_cursor_kind   text        DEFAULT NULL,
  p_cursor_id     uuid        DEFAULT NULL,
  p_limit         integer     DEFAULT 100,
  p_cursor_bucket integer     DEFAULT NULL,
  p_bucket        integer     DEFAULT NULL
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
  v_cur_bucket integer;
  v_bucket integer := CASE WHEN p_bucket IN (0,1,2) THEN p_bucket ELSE NULL END;
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

  -- Recover the cursor's bucket from its own row when the caller did not send
  -- one. Same expression as the ordering below; keep the three in step.
  v_cur_bucket := p_cursor_bucket;
  IF v_cur_bucket IS NULL AND p_cursor IS NOT NULL AND p_cursor_id IS NOT NULL THEN
    IF p_cursor_kind = 'table' THEN
      SELECT CASE WHEN lower(t.status) IN ('closed','completed','cancelled','canceled','deleted')
                  THEN 2 ELSE 0 END
        INTO v_cur_bucket FROM public.tables t WHERE t.id = p_cursor_id;
    ELSE
      SELECT CASE WHEN lower(t.status) IN ('closed','completed','cancelled','canceled','deleted') THEN 2
                  WHEN t.start_time > now() THEN 1
                  ELSE 0 END
        INTO v_cur_bucket FROM public.tournaments t WHERE t.id = p_cursor_id;
    END IF;
  END IF;
  v_cur_bucket := COALESCE(v_cur_bucket, COALESCE(v_bucket, 0));

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
    WHERE (v_bucket IS NULL OR g.bucket = v_bucket)
      AND (p_cursor IS NULL
           OR (g.bucket,g.sort_at,g.kind,g.id)>(v_cur_bucket,p_cursor,p_cursor_kind,p_cursor_id))
    ORDER BY g.bucket,g.sort_at,g.kind,g.id LIMIT v_limit
  ), enriched AS (
    SELECT p.*,(SELECT to_jsonb(s) FROM (
      SELECT ms.schedule_id,ms.execute_at,ms.status FROM public.managed_game_schedules ms
      WHERE ms.game_kind=p.kind AND ms.game_id=p.id AND ms.status='scheduled'
      ORDER BY ms.created_at DESC LIMIT 1) s) pending_schedule
    FROM page p ORDER BY p.bucket,p.sort_at,p.kind,p.id
  ) SELECT COALESCE(jsonb_agg(to_jsonb(enriched) ORDER BY bucket,sort_at,kind,id),'[]'::jsonb)
    INTO v_items FROM enriched;

  -- Counts summarise the WHOLE scope regardless of the open tab. Filtering
  -- these by p_bucket is what would let the counter and the tab disagree again.
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
  ), eligible AS (
    SELECT * FROM all_games
    WHERE (v_bucket IS NULL OR bucket = v_bucket)
      AND (p_cursor IS NULL
           OR (bucket,sort_at,kind,id)>(v_cur_bucket,p_cursor,p_cursor_kind,p_cursor_id))
  ), remaining AS (
    SELECT * FROM eligible ORDER BY bucket,sort_at,kind,id OFFSET v_limit LIMIT 1
  ), last_item AS (
    SELECT * FROM eligible ORDER BY bucket,sort_at,kind,id OFFSET GREATEST(v_limit-1,0) LIMIT 1
  ) SELECT CASE WHEN EXISTS(SELECT 1 FROM remaining) THEN
    (SELECT jsonb_build_object('sort_at',sort_at,'kind',kind,'id',id,'bucket',bucket) FROM last_item)
    ELSE NULL END INTO v_next;

  RETURN jsonb_build_object('ok',true,'items',v_items,'counts',v_counts,'next_cursor',v_next);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_list_managed_games(text,uuid,timestamptz,text,uuid,integer,integer,integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_list_managed_games(text,uuid,timestamptz,text,uuid,integer,integer,integer) TO authenticated, service_role;

DO $assert$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_list_managed_games';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'expected exactly one fn_list_managed_games, found %', v_n;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='fn_list_managed_games'
      AND p.prosecdef AND p.provolatile='s'
      AND p.prosrc LIKE '%Recover the cursor%'
      AND p.prosrc LIKE '%Counts summarise the WHOLE scope%'
  ) THEN
    RAISE EXCEPTION 'fn_list_managed_games lost the cursor recovery, the unfiltered counts, SECURITY DEFINER or STABLE';
  END IF;
  IF has_function_privilege('anon',
      'public.fn_list_managed_games(text,uuid,timestamptz,text,uuid,integer,integer,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'fn_list_managed_games is reachable by anon';
  END IF;
END;
$assert$;

COMMIT;