-- 20260927150009_stranded_player_audit_examines_history_only_after_excluding_.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- The natural conservation run 695609 timed out after 120s in this read.
-- Exclude occupied players before historical reads; financial predicates and
-- persisted rows do not change.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
DO $migration$
DECLARE
  v_oid oid := 'public.fn_ca_stranded_tournament_players()'::regprocedure;
  v_source text := pg_get_functiondef(v_oid);
  v_metadata jsonb;
  v_after jsonb;
  v_next text;
BEGIN
  IF md5(v_source) <> '5dc2f495fb115311c61fbf057456c225' THEN
    RAISE EXCEPTION 'STRANDED_PLAYER_READ_SOURCE_CHANGED';
  END IF;
  SELECT jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,
      'config',proconfig,'security',prosecdef,'volatility',provolatile)
    INTO v_metadata FROM pg_proc WHERE oid=v_oid;
  IF (SELECT proowner <> 'postgres'::regrole OR NOT prosecdef OR provolatile <> 's'
      OR proconfig IS DISTINCT FROM ARRAY['search_path=public']
      FROM pg_proc WHERE oid=v_oid) THEN
    RAISE EXCEPTION 'STRANDED_PLAYER_READ_AUTHORITY_CHANGED';
  END IF;
  v_next := replace(v_source, $old$  WITH stranded AS (
    SELECT t.id, t.name, p.user_id,
           (SELECT s.stack
              FROM public.table_seats s
              JOIN public.tables tb ON tb.id = s.table_id
             WHERE tb.tournament_id = t.id AND s.user_id = p.user_id
             ORDER BY s.left_at DESC NULLS FIRST
             LIMIT 1) AS last_stack
      FROM public.tournaments t
      JOIN public.tournament_players p ON p.tournament_id = t.id
     WHERE t.status = 'RUNNING'
       AND p.status <> 'eliminated'
       AND NOT EXISTS (
             SELECT 1 FROM public.table_seats s
               JOIN public.tables tb ON tb.id = s.table_id
              WHERE tb.tournament_id = t.id AND s.user_id = p.user_id
                AND s.left_at IS NULL)
  )
  SELECT s.id, s.name, count(*), round(sum(s.last_stack), 2),
         count(*) || ' player(s) are still in this event holding '
           || round(sum(s.last_stack), 2) || ' chips and are seated at no table, so they '
           || 'cannot be dealt a hand and their chips are outside every reader that '
           || 'counts open seats' AS detail
    FROM stranded s
   WHERE COALESCE(s.last_stack, 0) > 0
   GROUP BY s.id, s.name
   ORDER BY 4 DESC$old$, $new$  WITH unseated AS MATERIALIZED (
    SELECT t.id, t.name, p.user_id
      FROM public.tournaments t
      JOIN public.tournament_players p ON p.tournament_id = t.id
     WHERE t.status = 'RUNNING'
       AND p.status <> 'eliminated'
       AND NOT EXISTS (
             SELECT 1 FROM public.table_seats s
               JOIN public.tables tb ON tb.id = s.table_id
              WHERE tb.tournament_id = t.id AND s.user_id = p.user_id
                AND s.left_at IS NULL)
  ), stranded AS MATERIALIZED (
    SELECT t.id, t.name, t.user_id,
           (SELECT s.stack
              FROM public.table_seats s
              JOIN public.tables tb ON tb.id = s.table_id
             WHERE tb.tournament_id = t.id AND s.user_id = t.user_id
             ORDER BY s.left_at DESC NULLS FIRST
             LIMIT 1) AS last_stack
      FROM unseated t
  )
  SELECT s.id, s.name, count(*), round(sum(s.last_stack), 2),
         count(*) || ' player(s) are still in this event holding '
           || round(sum(s.last_stack), 2) || ' chips and are seated at no table, so they '
           || 'cannot be dealt a hand and their chips are outside every reader that '
           || 'counts open seats' AS detail
    FROM stranded s
   WHERE COALESCE(s.last_stack, 0) > 0
   GROUP BY s.id, s.name
   ORDER BY 4 DESC$new$);
  IF v_next = v_source THEN RAISE EXCEPTION 'STRANDED_PLAYER_READ_REWRITE_MISSING'; END IF;
  EXECUTE v_next;
  SELECT jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,
      'config',proconfig,'security',prosecdef,'volatility',provolatile)
    INTO v_after FROM pg_proc WHERE oid=v_oid;
  IF v_after IS DISTINCT FROM v_metadata OR pg_get_functiondef(v_oid) <> v_next THEN
    RAISE EXCEPTION 'STRANDED_PLAYER_READ_POSTIMAGE_CHANGED';
  END IF;
END
$migration$;

COMMIT;
