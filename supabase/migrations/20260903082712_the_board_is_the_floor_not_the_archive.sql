-- The board is the floor, not the archive.
--
-- Table Management carried every game a club had ever run. Measured:
--   Deep Stack Society     1,205 of 1,516 games finished  (79%)
--   Midway Union          66,888 of 67,171 games finished (99.6%)
-- The union board was 672 pages of Closed, and the counting scan crossed all
-- 67,171 rows on every single load - 700 to 1,142 ms against 16 ms for a club,
-- with an 8 second ceiling on the `authenticated` role waiting at the end of
-- that trend line.
--
-- Dan chose a seven day horizon. Closed games older than that are no longer
-- listed by default; the horizon is a parameter, so "show older" is a wider
-- window rather than a different code path, and passing 0 means everything.
--
-- WHAT THE HORIZON DOES NOT TOUCH:
--   - Live and scheduled games. A game you can still act on is never hidden by
--     an age rule, however old it is. Only bucket 2 is filtered.
--   - The counters. total/live/scheduled/closed still describe the WHOLE
--     scope, exactly as they did when the tabs became real queries. A board
--     that hides history must still be able to say how much history there is,
--     or the operator cannot tell the difference between "nothing here" and
--     "nothing recent here". closed_within_horizon is added beside them so the
--     Closed tab can say which of the two it is showing.
--   - Any other reader. This is the board's list, not a retention policy: no
--     row is deleted and nothing else that queries these tables is affected.
--
-- Ordering within the closed bucket is unchanged (sort_at ascending), so the
-- keyset cursor and every paging guarantee carry over untouched.

BEGIN;

SET LOCAL lock_timeout = '30s';

DROP FUNCTION IF EXISTS public.fn_list_managed_games(text, uuid, timestamptz, text, uuid, integer, integer, integer, text, uuid);

CREATE FUNCTION public.fn_list_managed_games(
  p_scope           text,
  p_scope_id        uuid,
  p_cursor          timestamptz DEFAULT NULL,
  p_cursor_kind     text        DEFAULT NULL,
  p_cursor_id       uuid        DEFAULT NULL,
  p_limit           integer     DEFAULT 100,
  p_cursor_bucket   integer     DEFAULT NULL,
  p_bucket          integer     DEFAULT NULL,
  p_game_kind       text        DEFAULT NULL,
  p_game_id         uuid        DEFAULT NULL,
  p_closed_days     integer     DEFAULT 7
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
  v_one boolean := (p_game_id IS NOT NULL AND p_game_kind IN ('table','tournament'));
  -- NULL means no horizon: 0 or a negative value asks for the whole archive.
  v_since timestamptz := CASE
    WHEN COALESCE(p_closed_days, 7) <= 0 THEN NULL
    ELSE now() - make_interval(days => COALESCE(p_closed_days, 7))
  END;
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
           THEN 2 ELSE 0 END AS bucket,
      GREATEST(t.created_at, COALESCE(t.updated_at, t.created_at)) AS touched_at
    FROM public.tables t WHERE t.tournament_id IS NULL AND NOT COALESCE(t.is_deleted,false)
      AND (NOT v_one OR (p_game_kind='table' AND t.id=p_game_id))
      AND ((p_scope='club' AND t.club_id=p_scope_id AND t.union_id IS NULL)
        OR (p_scope='union' AND (t.union_id=p_scope_id OR t.club_id=ANY(v_scope_clubs))))
    UNION ALL
    SELECT t.id,'tournament',t.club_id,t.name,t.status,COALESCE(t.game_type,t.variant,'MTT'),
      COALESCE(t.current_players,0),COALESCE(t.max_players,0),t.start_time,
      COALESCE(t.start_time,t.created_at),0::numeric,0::numeric,0::numeric,0::numeric,
      COALESCE(t.buy_in_amount,0),
      CASE WHEN lower(t.status) IN ('closed','completed','cancelled','canceled','deleted') THEN 2
           WHEN t.start_time > now() THEN 1
           ELSE 0 END,
      GREATEST(COALESCE(t.start_time, t.created_at), COALESCE(t.updated_at, t.created_at))
    FROM public.tournaments t WHERE
      (NOT v_one OR (p_game_kind='tournament' AND t.id=p_game_id))
      AND ((p_scope='club' AND t.club_id=p_scope_id AND t.union_id IS NULL)
        OR (p_scope='union' AND (t.union_id=p_scope_id OR t.club_id=ANY(v_scope_clubs))))
  ), visible AS (
    -- The horizon applies ONLY to finished games. A live or scheduled game is
    -- never hidden by age; it is still the operator's problem however old it is.
    SELECT * FROM all_games g
    WHERE v_one OR v_since IS NULL OR g.bucket <> 2 OR g.touched_at >= v_since
  ), page AS (
    SELECT v.* FROM visible v
    WHERE (v_one OR v_bucket IS NULL OR v.bucket = v_bucket)
      AND (v_one OR p_cursor IS NULL
           OR (v.bucket,v.sort_at,v.kind,v.id)>(v_cur_bucket,p_cursor,p_cursor_kind,p_cursor_id))
    ORDER BY v.bucket,v.sort_at,v.kind,v.id LIMIT CASE WHEN v_one THEN 1 ELSE v_limit END
  ), enriched AS (
    SELECT p.*,
      (SELECT to_jsonb(s) FROM (
        SELECT ms.schedule_id,ms.execute_at,ms.status FROM public.managed_game_schedules ms
        WHERE ms.game_kind=p.kind AND ms.game_id=p.id AND ms.status='scheduled'
        ORDER BY ms.created_at DESC LIMIT 1) s) pending_schedule,
      -- The published contract, same projection as fn_get_managed_game_contracts.
      (SELECT jsonb_build_object(
                'game_id', p.id,
                'version', v.version,
                'contract_hash', v.contract_hash,
                'published_at', v.published_at,
                'published_by', v.published_by,
                'change_reason', v.change_reason,
                'contract_locked', r.locked,
                'readiness', r.readiness)
         FROM public.managed_game_contract_versions v
         CROSS JOIN LATERAL (
           SELECT CASE WHEN p.kind='tournament'
                       THEN public.fn_tournament_management_readiness(p.id)
                       ELSE jsonb_build_object('state','ready','can_start',true,
                              'contract_locked', EXISTS (
                                SELECT 1 FROM public.table_seats ts
                                 WHERE ts.table_id=p.id AND ts.left_at IS NULL))
                  END AS readiness
         ) rr
         CROSS JOIN LATERAL (
           SELECT rr.readiness AS readiness,
                  COALESCE((rr.readiness ->> 'contract_locked')::boolean,false) AS locked
         ) r
        WHERE v.game_kind=p.kind AND v.game_id=p.id
        ORDER BY v.version DESC LIMIT 1) contract,
      -- The latest command receipt, same projection and reconciliation rule as
      -- fn_get_managed_game_command_receipts.
      (SELECT to_jsonb(x) FROM (
         SELECT rc.game_id, rc.command_id, rc.command_action, rc.status,
                rc.contract_version_before, rc.contract_version_after,
                CASE WHEN rc.status='processing' THEN 'processing'
                     WHEN av.version IS NULL THEN 'version_drift'
                     ELSE 'confirmed' END AS reconciliation_state,
                rc.created_at, rc.completed_at
           FROM public.managed_game_command_receipts rc
           JOIN public.managed_game_contract_versions bv
             ON bv.game_kind=rc.game_kind AND bv.game_id=rc.game_id
            AND bv.version=rc.contract_version_before
           LEFT JOIN public.managed_game_contract_versions av
             ON av.game_kind=rc.game_kind AND av.game_id=rc.game_id
            AND av.version=rc.contract_version_after
          WHERE rc.game_kind=p.kind AND rc.game_id=p.id
          ORDER BY rc.created_at DESC LIMIT 1) x) last_command
    FROM page p ORDER BY p.bucket,p.sort_at,p.kind,p.id
  ) SELECT COALESCE(jsonb_agg(to_jsonb(enriched) ORDER BY bucket,sort_at,kind,id),'[]'::jsonb)
    INTO v_items FROM enriched;

  -- A single-game read skips both scans. That IS the saving, and it is why
  -- counts and next_cursor come back null: "unchanged", never zero.
  IF v_one THEN
    RETURN jsonb_build_object('ok',true,'items',v_items,'counts',NULL,'next_cursor',NULL);
  END IF;

  -- Counts summarise the WHOLE scope regardless of the open tab, and regardless
  -- of the horizon. closed_within_horizon is what the Closed tab is actually
  -- showing, so the board can tell "no games" from "none this recent".
  WITH scoped AS (
    SELECT status,'table'::text kind,NULL::timestamptz start_time,
           GREATEST(t.created_at, COALESCE(t.updated_at, t.created_at)) AS touched_at
      FROM public.tables t
    WHERE t.tournament_id IS NULL AND NOT COALESCE(t.is_deleted,false)
      AND ((p_scope='club' AND t.club_id=p_scope_id AND t.union_id IS NULL)
        OR (p_scope='union' AND (t.union_id=p_scope_id OR t.club_id=ANY(v_scope_clubs))))
    UNION ALL SELECT status,'tournament',t.start_time,
           GREATEST(COALESCE(t.start_time, t.created_at), COALESCE(t.updated_at, t.created_at))
      FROM public.tournaments t WHERE
      (p_scope='club' AND t.club_id=p_scope_id AND t.union_id IS NULL)
      OR (p_scope='union' AND (t.union_id=p_scope_id OR t.club_id=ANY(v_scope_clubs)))
  ), bucketed AS (
    SELECT CASE
      WHEN lower(status) IN ('closed','completed','cancelled','canceled','deleted') THEN 2
      WHEN kind='tournament' AND start_time > now() THEN 1
      ELSE 0 END AS bucket,
      touched_at
    FROM scoped
  ) SELECT jsonb_build_object(
      'total',count(*),
      'live',count(*) FILTER (WHERE bucket=0),
      'scheduled',count(*) FILTER (WHERE bucket=1),
      'closed',count(*) FILTER (WHERE bucket=2),
      'closed_within_horizon',
        count(*) FILTER (WHERE bucket=2 AND (v_since IS NULL OR touched_at >= v_since)),
      'closed_horizon_days', COALESCE(p_closed_days, 7))
  INTO v_counts FROM bucketed;

  WITH all_games AS (
    SELECT t.id,'table'::text kind,t.created_at sort_at,
      CASE WHEN lower(t.status) IN ('closed','completed','cancelled','canceled','deleted')
           THEN 2 ELSE 0 END AS bucket,
      GREATEST(t.created_at, COALESCE(t.updated_at, t.created_at)) AS touched_at
    FROM public.tables t
    WHERE t.tournament_id IS NULL AND NOT COALESCE(t.is_deleted,false)
      AND ((p_scope='club' AND t.club_id=p_scope_id AND t.union_id IS NULL)
        OR (p_scope='union' AND (t.union_id=p_scope_id OR t.club_id=ANY(v_scope_clubs))))
    UNION ALL SELECT t.id,'tournament',COALESCE(t.start_time,t.created_at),
      CASE WHEN lower(t.status) IN ('closed','completed','cancelled','canceled','deleted') THEN 2
           WHEN t.start_time > now() THEN 1
           ELSE 0 END,
      GREATEST(COALESCE(t.start_time, t.created_at), COALESCE(t.updated_at, t.created_at))
    FROM public.tournaments t WHERE (p_scope='club' AND t.club_id=p_scope_id AND t.union_id IS NULL)
      OR (p_scope='union' AND (t.union_id=p_scope_id OR t.club_id=ANY(v_scope_clubs)))
  ), eligible AS (
    SELECT * FROM all_games
    WHERE (v_since IS NULL OR bucket <> 2 OR touched_at >= v_since)
      AND (v_bucket IS NULL OR bucket = v_bucket)
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

REVOKE ALL ON FUNCTION public.fn_list_managed_games(text,uuid,timestamptz,text,uuid,integer,integer,integer,text,uuid,integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_list_managed_games(text,uuid,timestamptz,text,uuid,integer,integer,integer,text,uuid,integer) TO authenticated, service_role;

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
      AND p.prosrc LIKE '%fn_tournament_management_readiness%'
      AND p.prosrc LIKE '%A single-game read skips both scans%'
      AND p.prosrc LIKE '%The horizon applies ONLY to finished games%'
  ) THEN
    RAISE EXCEPTION 'fn_list_managed_games lost one of its guarantees';
  END IF;
  IF has_function_privilege('anon',
      'public.fn_list_managed_games(text,uuid,timestamptz,text,uuid,integer,integer,integer,text,uuid,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'fn_list_managed_games is reachable by anon';
  END IF;
END;
$assert$;

COMMIT;