-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902211809; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- A cursor that omits its bucket is still a cursor.
--
-- the_board_opens_on_the_live_floor made the priority bucket the first key of
-- both the ordering and the keyset cursor, and added p_cursor_bucket to carry
-- it. The argument is defaulted so the deployed frontend keeps working while
-- the matching client ships - but "keeps working" was asserted rather than
-- measured, and it was wrong.
--
-- A caller that omits the bucket had it coalesced to 0. The comparison is
--   (bucket, sort_at, kind, id) > (0, cursor_sort_at, cursor_kind, cursor_id)
-- so once the cursor row itself sits in bucket 1 or 2, EVERY row in buckets 1
-- and 2 compares greater regardless of its sort_at - including every row the
-- caller has already been given. Paging stops converging.
--
-- Measured against Deep Stack Society by paging exactly as the deployed client
-- does: 26 pages, 2,600 rows returned for a 1,514 row club, 2,200 of them
-- duplicates, and the walk never terminated - it hit the loop guard. The board
-- opens on the live floor either way, so an operator only reaches this by
-- pressing Load More about four times, but "only after four clicks" is not a
-- defence.
--
-- The bucket is not really optional information: it is a property of the
-- cursor ROW, so it can be recovered from the row. When a caller supplies a
-- cursor without a bucket, look the row up and compute the same expression the
-- ordering uses. An explicit p_cursor_bucket still wins - it costs nothing and
-- saves the lookup - so the new client is unaffected.
--
-- This makes the argument a genuine optimisation rather than a requirement the
-- signature quietly depends on, which is what it should have been.

BEGIN;

SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.fn_list_managed_games(
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
  v_cur_bucket integer;
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
  -- The cursor row is gone (closed and pruned between pages). Bucket 0 is the
  -- old behaviour and is the safe direction: it can only re-show rows, never
  -- skip them, and the caller stops when a page comes back short.
  v_cur_bucket := COALESCE(v_cur_bucket, 0);

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
      AND p.prosecdef AND p.provolatile='s' AND p.prosrc LIKE '%Recover the cursor%'
  ) THEN
    RAISE EXCEPTION 'fn_list_managed_games lost the cursor-bucket recovery, SECURITY DEFINER or STABLE';
  END IF;
  IF has_function_privilege('anon',
      'public.fn_list_managed_games(text,uuid,timestamptz,text,uuid,integer,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'fn_list_managed_games is reachable by anon';
  END IF;
END;
$assert$;

COMMIT;
