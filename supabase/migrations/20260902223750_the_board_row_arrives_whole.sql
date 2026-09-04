-- The board row arrives whole.
--
-- Loading Table Management was five sequential round trips, measured at about
-- eleven seconds against production:
--
--   1  resolveClubUUID
--   2  fn_game_creation_access  +  clubs read        (parallel)
--   3  fn_list_managed_games
--   4  fn_get_managed_game_contracts        x2       (parallel, needs 3's ids)
--      fn_get_managed_game_command_receipts x2
--   5  fn_get_game_management_scale_health
--
-- Wave 4 exists only because the list returned an incomplete row. Every game
-- the board draws needs its published contract and its last command receipt,
-- so those belong to the row, exactly as pending_schedule already does. This
-- folds them in and wave 4 disappears.
--
-- It also removes work that was pure duplication. fn_get_managed_game_contracts
-- loops game by game and calls fn_can_create_games for EACH one; the receipts
-- query re-authorizes per row through a join. fn_list_managed_games has already
-- authorized the whole scope before it selects a single game - that is its
-- first act - so those were up to 200 redundant authorization checks per load.
-- Dropping them cannot widen access: a row only reaches this projection if the
-- caller was already allowed the scope it belongs to.
--
-- The standalone functions are NOT removed. ContractHistoryDialog and any other
-- caller still use them, and they remain the definition of the shape; what is
-- inlined here is the same projection over the same tables, so the two agree.
-- Verified by diffing this function's contract and receipt output against those
-- helpers for the same games before shipping.
--
-- Readiness is not reimplemented: tournaments call
-- fn_tournament_management_readiness, the same function the helper calls, and
-- tables get the same literal the helper builds.

BEGIN;

SET LOCAL lock_timeout = '30s';

DROP FUNCTION IF EXISTS public.fn_list_managed_games(text, uuid, timestamptz, text, uuid, integer, integer, integer);

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
      AND p.prosrc LIKE '%fn_tournament_management_readiness%'
  ) THEN
    RAISE EXCEPTION 'fn_list_managed_games lost the cursor recovery, the unfiltered counts, the folded contract, SECURITY DEFINER or STABLE';
  END IF;
  -- The helpers stay: the dialogs use them and they remain the shape's home.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='fn_get_managed_game_contracts')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='fn_get_managed_game_command_receipts') THEN
    RAISE EXCEPTION 'the standalone contract/receipt helpers must remain for the dialogs';
  END IF;
  IF has_function_privilege('anon',
      'public.fn_list_managed_games(text,uuid,timestamptz,text,uuid,integer,integer,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'fn_list_managed_games is reachable by anon';
  END IF;
END;
$assert$;

COMMIT;