-- 20261025214230_horse_own_public_history_read.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- @live-proof: to_regprocedure('public.fn_horse_own_public_history_read(uuid,text,text,integer,timestamp with time zone)') IS NOT NULL AND (SELECT md5(pg_get_functiondef('public.fn_horse_own_public_history_read(uuid,text,text,integer,timestamp with time zone)'::regprocedure))='9106fc84c02669f38f554af45db6d867') AND NOT has_function_privilege('authenticated','public.fn_horse_own_public_history_read(uuid,text,text,integer,timestamp with time zone)','EXECUTE') AND NOT has_function_privilege('anon','public.fn_horse_own_public_history_read(uuid,text,text,integer,timestamp with time zone)','EXECUTE') AND has_function_privilege('service_role','public.fn_horse_own_public_history_read(uuid,text,text,integer,timestamp with time zone)','EXECUTE')
-- Read-only rehydration of one horse's own bounded public history. The
-- original dealt fact (seat and known position) proves participation; the
-- wider hand_history.players RLS roster is never used to infer it. No card
-- column, pooled profile, new table/index, financial write or backfill.
-- Availability is stamped by the caller AFTER this read completes. Database
-- created_at is not a claim that the row was visible at an older snapshot.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE FUNCTION public.fn_horse_own_public_history_read(
  p_observer uuid, p_variant text, p_format text,
  p_dealt_count integer, p_before timestamptz
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_window jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  IF p_observer IS NULL OR p_variant NOT IN
    ('nlh','plo4','plo5','plo6','plo8','flh','flo8','short_deck','pineapple')
    OR p_variant IS NULL OR p_format NOT IN ('cash','mtt','sng','spin','hu_sng')
    OR p_format IS NULL OR p_dealt_count NOT BETWEEN 2 AND 10
    OR p_dealt_count IS NULL OR p_before IS NULL OR NOT isfinite(p_before)
  THEN RAISE EXCEPTION 'invalid individual history context' USING ERRCODE='22023'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    JOIN public.ca_horse_fleet_register r ON r.horse_id=p.id
    WHERE p.id=p_observer AND p.is_horse IS TRUE
      AND p.status IS DISTINCT FROM 'deleted'
      AND p.horse_status IS DISTINCT FROM 'disabled' AND r.retired_at IS NULL
  ) THEN RETURN NULL; END IF;

  WITH candidates AS MATERIALIZED (
    SELECT f.hand_id,f.user_id,f.table_id,f.tournament_id,f.played_at,
           f.game_variant,f.seat,f.position,f.players_dealt
    FROM public.ca_hand_facts f
    WHERE f.user_id=p_observer AND f.played_at<=p_before
      AND f.played_at>=p_before-interval '8 days'
    ORDER BY f.played_at DESC,f.hand_id DESC LIMIT 512
  ), matched AS MATERIALIZED (
    SELECT f.*,h.hand_number,h.big_blind,h.actions
    FROM candidates f JOIN public.hand_history h ON h.id=f.hand_id
    LEFT JOIN public.tournaments t ON t.id=h.tournament_id
    WHERE f.table_id=h.table_id AND f.game_variant=h.game_variant
      AND f.tournament_id IS NOT DISTINCT FROM h.tournament_id
      AND f.played_at=h.ended_at AND h.ended_at<=p_before
      AND f.game_variant=p_variant AND f.players_dealt=p_dealt_count
      AND f.seat BETWEEN 1 AND 10
      AND f.position IN ('BTN','SB','BB','UTG','UTG+1','UTG+2','UTG+3','MP','LJ','HJ','CO')
      AND h.hand_number>=1000000 AND h.big_blind>0 AND jsonb_typeof(h.actions)='array'
      AND jsonb_array_length(h.actions)<=256
      AND CASE
        WHEN h.tournament_id IS NULL THEN 'cash'
        WHEN t.format_contract IN ('mtt-v1','mtt-v2') THEN 'mtt'
        WHEN t.format_contract='spin-v1' THEN 'spin'
        WHEN t.format_contract='seat-first-satellite-v1' THEN 'hu_sng'
        WHEN t.format_contract='sng-v1' AND least(
          CASE WHEN t.table_size>0 THEN t.table_size ELSE 9 END,
          CASE WHEN t.max_players>0 THEN t.max_players ELSE 9 END)<=2 THEN 'hu_sng'
        WHEN t.format_contract='sng-v1' THEN 'sng'
        ELSE NULL END=p_format
  ), selected AS MATERIALIZED (
    SELECT * FROM matched ORDER BY played_at DESC,hand_id DESC LIMIT 64
  ), public_rows AS MATERIALIZED (
    SELECT s.played_at,s.hand_id, jsonb_build_object(
      'handId',s.hand_id,'tableId',s.table_id,'handNumber',s.hand_number,
      'observerId',p_observer,'observerSeat',s.seat,'position',s.position,
      'playersDealt',s.players_dealt,'variant',p_variant,'format',p_format,
      'playedAtMs',floor(extract(epoch FROM s.played_at)*1000),
      'bigBlind',s.big_blind,
      'actions',(
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'seat',a.value->'seat','userId',a.value->'userId',
          'action',a.value->'action','amount',a.value->'amount',
          'stage',a.value->'stage','timestamp',a.value->'timestamp'
        ) || CASE WHEN a.value ? 'isFullRaise'
          THEN jsonb_build_object('isFullRaise',a.value->'isFullRaise')
          ELSE '{}'::jsonb END ORDER BY a.ordinality),'[]'::jsonb)
        FROM jsonb_array_elements(s.actions) WITH ORDINALITY a(value,ordinality)
        WHERE a.value->>'action' IN
          ('fold','check','call','bet','raise','all_in','sb','bb','blind','ante','straddle','post','kill_blind','return')
          AND a.value->>'stage' IN ('preflop','flop','turn','river')
      ),
      'results',(
        SELECT CASE WHEN count(*)=p_dealt_count
          AND count(DISTINCT f2.user_id)=p_dealt_count
          AND bool_and(f2.net IS NOT NULL)
          THEN jsonb_agg(jsonb_build_object('user_id',f2.user_id,'net',f2.net) ORDER BY f2.user_id)
          ELSE NULL END
        FROM public.ca_hand_facts f2
        WHERE f2.hand_id=s.hand_id AND f2.table_id=s.table_id
          AND f2.game_variant=p_variant AND f2.players_dealt=p_dealt_count
          AND f2.seat BETWEEN 1 AND 10
          AND f2.position IN ('BTN','SB','BB','UTG','UTG+1','UTG+2','UTG+3','MP','LJ','HJ','CO')
      )
    ) AS body
    FROM selected s
  ), sized AS (
    SELECT *,sum(octet_length(body::text)+1) OVER (ORDER BY played_at DESC,hand_id DESC) AS cumulative_bytes
    FROM public_rows
  ), bounded AS (
    -- Complete hands only. Leave 64 KiB for context/digest/transport within
    -- the caller's 256 KiB history limit and half-record journal budget.
    SELECT * FROM sized WHERE cumulative_bytes<=196608
  )
  SELECT jsonb_build_object(
    'version',1,'source','original_dealt_public_v1',
    'context',jsonb_build_object('version',1,'observerId',p_observer,
      'variant',p_variant,'format',p_format,'dealtCount',p_dealt_count),
    'capped',(SELECT count(*) FROM candidates)>(SELECT count(*) FROM bounded),
    'hands',coalesce(jsonb_agg(b.body ORDER BY b.played_at,b.hand_id),'[]'::jsonb)
  ) INTO v_window FROM bounded b;

  RETURN jsonb_build_object(
    'definitionMd5',md5(pg_get_functiondef(
      'public.fn_horse_own_public_history_read(uuid,text,text,integer,timestamp with time zone)'::regprocedure)),
    'window',v_window
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_horse_own_public_history_read(uuid,text,text,integer,timestamptz)
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_own_public_history_read(uuid,text,text,integer,timestamptz)
TO service_role;

COMMIT;
