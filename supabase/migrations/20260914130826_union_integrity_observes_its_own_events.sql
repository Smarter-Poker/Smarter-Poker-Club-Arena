-- BACKFILLED 2026-09-21 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260914130826; the .sql file was never committed at the
-- time (union integrity sweep scoping; found by the two-way migration diff of
-- 2026-09-21). Content is byte-exact to what ran. Do NOT re-apply; it is already
-- live.
--
-- VERIFIED LIVE 2026-09-21 07:06:55 UTC: md5(pg_get_functiondef(
-- 'public.fn_union_integrity_sweep(uuid,integer)')) =
-- 24d4f8cf076499a6e90f5c221a135c4a, the later of the two hashes this migration's
-- own preflight accepts and therefore its postimage, with ACL
-- {postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres} and anon
-- revoked, as the GRANT at the end of the file states.
--
-- WHY IT MATTERS TO THE UNION BOOKS. The sweep is the reader that files agent
-- roster, direct chip transfer and co-seating signals against a union. Unscoped,
-- one union's sweep could observe and suppress another union's events, so the
-- incident a union accountant reads would not be that union's.
--
-- @live-proof: md5(pg_get_functiondef('public.fn_union_integrity_sweep(uuid,integer)'::regprocedure)) = '24d4f8cf076499a6e90f5c221a135c4a'

-- Scope integrity observations and incident suppression to the requested union.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';
DO $preflight$
DECLARE v_hash text;
BEGIN
  SELECT md5(pg_get_functiondef('public.fn_union_integrity_sweep(uuid,integer)'::regprocedure)) INTO v_hash;
  IF v_hash NOT IN ('4d64aa69476db5aa5ae5c5695dcb7b18','24d4f8cf076499a6e90f5c221a135c4a') THEN
    RAISE EXCEPTION 'union integrity definition drift: %',v_hash;
  END IF;
  IF md5(pg_get_functiondef('public.fn_caller_is_engine()'::regprocedure))
       IS DISTINCT FROM 'd9a70f1d932538025e656bfe2b4d091d'
     OR md5(pg_get_functiondef('public.fn_is_union_overseer(uuid,uuid)'::regprocedure))
       IS DISTINCT FROM '5c1b25662b9751fc4152dac8e8b5e6f2' THEN
    RAISE EXCEPTION 'union integrity caller authority drift';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.fn_union_integrity_sweep(p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001'::uuid, p_hours integer DEFAULT 24)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_from timestamptz := now() - make_interval(hours => GREATEST(p_hours,1));
  v_agent_flags jsonb := '[]'::jsonb;
  v_dump_flags jsonb := '[]'::jsonb;
  v_coseat_flags jsonb := '[]'::jsonb;
  v_total int := 0;
BEGIN
  IF p_union_id IS NULL THEN
    RAISE EXCEPTION 'union identity is required' USING ERRCODE='22004';
  END IF;
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_union_overseer(p_union_id, auth.uid()))) THEN RAISE EXCEPTION 'not_authorised'; END IF;
  WITH scope_clubs AS MATERIALIZED (
    SELECT uc.club_id FROM public.union_clubs uc WHERE uc.union_id=p_union_id
    UNION
    SELECT c.id FROM public.clubs c WHERE c.id=p_union_id AND c.is_union IS TRUE
  ),
  roster AS (
    SELECT DISTINCT m.agent_id, m.user_id AS player_id
      FROM public.club_members m
      JOIN scope_clubs sc ON sc.club_id=m.club_id
     WHERE m.agent_id IS NOT NULL
  ),
  net AS (
    SELECT r.agent_id,
           SUM(CASE WHEN wt.type='credit' AND wt.category IN ('cashout','prize','bounty') THEN wt.amount ELSE 0 END)
         - SUM(CASE WHEN wt.type='debit'  AND wt.category IN ('buyin','rebuy','addon','tournament_buyin') THEN wt.amount ELSE 0 END) AS player_net,
           COUNT(DISTINCT r.player_id) AS players
      FROM roster r
      JOIN wallet_transactions wt ON wt.user_id = r.player_id AND wt.created_at >= v_from
     WHERE EXISTS (
       SELECT 1 FROM public.tables t WHERE t.id=wt.table_id
         AND (t.union_id=p_union_id OR (t.union_id IS NULL AND t.club_id IN (SELECT club_id FROM scope_clubs))))
        OR (wt.table_id IS NULL AND EXISTS (
          SELECT 1 FROM public.tournaments t WHERE t.id=wt.related_entity_id
            AND (t.union_id=p_union_id OR (t.union_id IS NULL AND t.club_id IN (SELECT club_id FROM scope_clubs)))))
     GROUP BY r.agent_id
  ),
  rake AS (
    SELECT r.agent_id,
           SUM(rr.rake_amount * (e.value::numeric) / NULLIF(c.total,0)) AS rake
      FROM rake_records rr
      CROSS JOIN LATERAL (SELECT SUM(t.value::numeric) AS total
                            FROM jsonb_each_text(rr.player_contributions) t(key,value)) c
      CROSS JOIN LATERAL jsonb_each_text(rr.player_contributions) e(key,value)
      JOIN roster r ON r.player_id = (e.key)::uuid
     WHERE rr.created_at >= v_from AND rr.player_contributions IS NOT NULL AND c.total > 0
       AND (
         EXISTS (SELECT 1 FROM public.tables t WHERE t.id=rr.table_id
           AND (t.union_id=p_union_id OR (t.union_id IS NULL AND t.club_id IN (SELECT club_id FROM scope_clubs))))
         OR (rr.table_id IS NULL AND EXISTS (
           SELECT 1 FROM public.tournaments t WHERE t.id=rr.tournament_id
             AND (t.union_id=p_union_id OR (t.union_id IS NULL AND t.club_id IN (SELECT club_id FROM scope_clubs)))))
         OR (rr.table_id IS NULL AND rr.tournament_id IS NULL
           AND rr.club_id IN (SELECT club_id FROM scope_clubs))
       )
     GROUP BY r.agent_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'agent_user_id', n.agent_id, 'players', n.players,
           'player_net', round(n.player_net,2), 'rake_generated', round(COALESCE(k.rake,0),2),
           'win_to_rake_ratio', round(n.player_net / NULLIF(COALESCE(k.rake,0),0), 2))), '[]'::jsonb)
    INTO v_agent_flags
    FROM net n LEFT JOIN rake k ON k.agent_id = n.agent_id
   WHERE n.player_net > 0
     AND n.player_net > 10 * GREATEST(COALESCE(k.rake,0), 1);

  SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) INTO v_dump_flags FROM (
    SELECT jsonb_build_object(
             'from_user', ct.from_user_id, 'to_user', ct.to_user_id,
             'transfers', count(*), 'total', round(sum(ct.amount),2)) AS x
      FROM chip_transactions ct
     WHERE ct.created_at >= v_from
       AND (EXISTS (SELECT 1 FROM public.union_clubs uc
              WHERE uc.union_id=p_union_id AND uc.club_id=ct.club_id)
         OR EXISTS (SELECT 1 FROM public.clubs c
              WHERE c.id=p_union_id AND c.is_union IS TRUE AND c.id=ct.club_id))
       AND ct.from_user_id IS NOT NULL AND ct.to_user_id IS NOT NULL
       AND ct.transaction_type NOT IN ('agent_to_player_transfer','rakeback','buyin','cashout')
       AND NOT EXISTS (SELECT 1 FROM agents a
         WHERE a.user_id=ct.from_user_id AND a.club_id=ct.club_id)
     GROUP BY ct.from_user_id, ct.to_user_id
    HAVING sum(ct.amount) > 0
  ) s;

  -- Co-seating, excluding horse-vs-horse (simulated players always co-seat).
  SELECT COALESCE(jsonb_agg(y), '[]'::jsonb) INTO v_coseat_flags FROM (
    SELECT jsonb_build_object('player_a', a.user_id, 'player_b', b.user_id,
                              'shared_tables', count(DISTINCT a.table_id)) AS y
      FROM table_seats a
      JOIN table_seats b ON b.table_id = a.table_id AND b.user_id > a.user_id
      JOIN tables t ON t.id = a.table_id AND t.union_id = p_union_id
      LEFT JOIN profiles pa ON pa.id = a.user_id
      LEFT JOIN profiles pb ON pb.id = b.user_id
     WHERE a.joined_at >= v_from AND b.joined_at >= v_from
       AND NOT (COALESCE(pa.is_horse,false) AND COALESCE(pb.is_horse,false))
     GROUP BY a.user_id, b.user_id
    HAVING count(DISTINCT a.table_id) >= 8
     ORDER BY count(DISTINCT a.table_id) DESC
     LIMIT 20
  ) s2;

  v_total := jsonb_array_length(v_agent_flags)
           + jsonb_array_length(v_dump_flags)
           + jsonb_array_length(v_coseat_flags);

  IF v_total > 0 THEN
    -- Each union owns its incident window; serialize concurrent reporters.
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'union_integrity_alert:' || p_union_id::text, 0));
    IF NOT EXISTS (SELECT 1 FROM financial_alerts
                     WHERE source = 'fn_union_integrity_sweep'
                       AND context->>'union_id'=p_union_id::text
                       AND created_at > now() - interval '20 hours') THEN
    INSERT INTO financial_alerts (severity, source, message, context)
    VALUES ('warning', 'fn_union_integrity_sweep',
            'Union integrity sweep raised ' || v_total || ' signal(s) - review by agent',
            jsonb_build_object('union_id', p_union_id, 'window_hours', p_hours,
                               'agent_roster_winning', v_agent_flags,
                               'direct_chip_transfer', v_dump_flags,
                               'co_seating', v_coseat_flags));
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'union_id', p_union_id, 'window_hours', p_hours, 'signals', v_total,
    'agent_roster_winning', v_agent_flags,
    'direct_chip_transfer', v_dump_flags,
    'co_seating', v_coseat_flags);
END $function$
;

REVOKE ALL ON FUNCTION public.fn_union_integrity_sweep(uuid,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_union_integrity_sweep(uuid,integer) TO authenticated,service_role;
COMMIT;
