-- Counting the whole scope is a first-page job.
--
-- fn_list_managed_games recomputed total/live/scheduled/closed on EVERY page.
-- The counters describe the whole scope, so that scan crosses every game the
-- scope has - and it was being paid again for page 2, page 3, page 300.
--
-- Measured this morning on Midway Union, now 73,797 games: 5.2 seconds for a
-- page. The `authenticated` role has an 8 second statement timeout, so Load
-- More was spending most of a page's budget recounting numbers the caller
-- already had on screen and which had not changed on its account.
--
-- A paged read now returns counts as null, meaning "unchanged" - exactly the
-- contract a single-game read already uses. The first page of any tab still
-- counts, because that is when the numbers are actually needed.
--
-- This does NOT make the first page fast. Midway's first page is still around
-- five seconds and the cost is this scan; bounding the list with a horizon
-- cannot help, because the counters deliberately describe everything rather
-- than the window. Making that first count cheap needs a cached or
-- incrementally-maintained per-scope summary, which is a larger change than
-- this one and is not attempted here. What this removes is paying for it
-- repeatedly.

BEGIN;

SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.fn_list_managed_games(
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
  --
  -- Only on the FIRST page. Paging cannot change a whole-scope total, and on
  -- Midway Union this scan is 5 of the page's 8 second budget. A paged read
  -- returns counts null, meaning unchanged.
  IF p_cursor IS NULL THEN
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
  END IF;

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

DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='fn_list_managed_games'
      AND p.prosecdef AND p.provolatile='s'
      AND p.prosrc LIKE '%Only on the FIRST page%'
      AND p.prosrc LIKE '%The horizon applies ONLY to finished games%'
  ) THEN
    RAISE EXCEPTION 'fn_list_managed_games lost the first-page counting rule or the horizon';
  END IF;
END;
$assert$;

COMMIT;