-- 20261012191403_the_finished_diamond_session_recap_follows_its_exact_custody.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

-- Final Diamond recaps read one exact custody, including must-move segments.
-- Client mount counters cannot establish the server's snapshot boundary.
-- A top-up between hands is not a win, and the final hand needs no successor.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $guard$
BEGIN
 IF to_regprocedure('public.fn_my_diamond_cash_session_recap(uuid,uuid)') IS NOT NULL THEN
   RAISE EXCEPTION 'diamond_final_recap_migration_already_installed';
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.fn_my_table_session_facts(uuid)'))
    IS DISTINCT FROM '2d544bf1d32c7fea07481ea7202f17cd' THEN
   RAISE EXCEPTION 'session_facts_source_changed';
 END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.fn_my_table_session_facts(p_table_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
 WITH opened AS (
   SELECT COALESCE(
     (SELECT opened_at FROM cash_player_session
       WHERE player_id=auth.uid() AND scope_type='table' AND scope_id=p_table_id
         AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1),
     (SELECT created_at FROM poker_diamond_custody
       WHERE user_id=auth.uid() AND purpose='cash_seat' AND target_id=p_table_id
         AND state='active' ORDER BY created_at DESC LIMIT 1)) AS started_at
 ), mine AS (
   SELECT h.id,h.players FROM hand_history h,opened o
    WHERE o.started_at IS NOT NULL AND h.table_id=p_table_id AND h.created_at>=o.started_at
      AND h.players @> jsonb_build_array(jsonb_build_object('userId',auth.uid()::text))
 ), facts AS (
   SELECT f.* FROM ca_hand_facts f JOIN mine h ON h.id=f.hand_id
    WHERE f.user_id=auth.uid() AND f.table_id=p_table_id
 ), coverage AS (
   SELECT (SELECT count(*) FROM mine)=(SELECT count(*) FROM facts) AS complete
 )
 SELECT CASE WHEN o.started_at IS NULL THEN NULL ELSE jsonb_build_object(
   'started_at',o.started_at,
   'hands_played',(SELECT count(*) FROM mine),
   'hands_won',CASE WHEN c.complete THEN (SELECT count(*) FROM facts WHERE returned>0) END,
   'peak_stack',(SELECT max((p->>'stack')::numeric) FROM mine h,
      LATERAL jsonb_array_elements(h.players) p
     WHERE p->>'userId'=auth.uid()::text AND (p->>'stack') ~ '^[0-9]+(\.[0-9]+)?$')
 ) END FROM opened o,coverage c;
$fn$;
REVOKE ALL ON FUNCTION public.fn_my_table_session_facts(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_my_table_session_facts(uuid) TO authenticated,service_role;

CREATE FUNCTION public.fn_my_diamond_cash_session_recap(p_table_id uuid,p_occupancy_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
 WITH RECURSIVE owned AS (
   SELECT c.* FROM poker_diamond_custody c
    WHERE c.user_id=auth.uid() AND c.purpose='cash_seat'
      AND c.target_id=p_table_id AND c.occupancy_id=p_occupancy_id
      AND c.state IN('active','released')
 ), lineage AS (
   SELECT c.target_id AS table_id,c.occupancy_id,
     COALESCE(c.released_at,statement_timestamp()) AS through_at,
     ARRAY[c.occupancy_id] AS visited FROM owned c
   UNION ALL
   SELECT r.from_table_id,r.source_occupancy_id,r.created_at,l.visited||r.source_occupancy_id
    FROM lineage l JOIN cash_seat_move_receipts r
      ON r.destination_occupancy_id=l.occupancy_id AND r.to_table_id=l.table_id
    JOIN owned c ON r.player_id=c.user_id AND r.club_id=c.arena_id
    WHERE NOT r.source_occupancy_id=ANY(l.visited)
 ), segments AS (
   SELECT l.*,COALESCE((SELECT min(r.created_at) FROM cash_seat_move_receipts r,owned c
      WHERE r.player_id=c.user_id AND r.club_id=c.arena_id
        AND r.destination_occupancy_id=l.occupancy_id AND r.to_table_id=l.table_id),
      (SELECT created_at FROM owned)) AS from_at FROM lineage l
 ), session_hands AS (
   SELECT DISTINCT ON(h.id) h.* FROM hand_history h JOIN segments s
     ON h.table_id=s.table_id AND h.created_at>=s.from_at AND h.created_at<=s.through_at
    ORDER BY h.id
 ), mine AS (
   SELECT h.* FROM session_hands h,owned c
    WHERE h.players @> jsonb_build_array(jsonb_build_object('userId',c.user_id::text))
 ), facts AS (
   SELECT f.* FROM ca_hand_facts f JOIN mine h ON h.id=f.hand_id AND h.table_id=f.table_id
    JOIN owned c ON f.user_id=c.user_id
 ), money AS (
   SELECT COALESCE(sum(m.amount) FILTER(WHERE m.action='reserve'),0)::bigint AS bought,
     COALESCE(sum(m.amount) FILTER(WHERE m.action='release'),0)::bigint AS returned,
     greatest(count(*) FILTER(WHERE m.action='reserve')-1,0) AS rebuys,
     max(CASE WHEN (m.receipt->>'stack') ~ '^[0-9]+$' THEN (m.receipt->>'stack')::bigint
       WHEN (m.receipt->>'custody_balance') ~ '^[0-9]+$' THEN (m.receipt->>'custody_balance')::bigint
       WHEN m.action='reserve' THEN m.amount END) AS funded_peak
    FROM poker_diamond_movements m JOIN owned c ON m.custody_id=c.id AND m.user_id=c.user_id
 ), awards AS (
   SELECT COALESCE(sum(-j.amount),0)::bigint AS paid FROM poker_diamond_jackpot_ledger j
    JOIN session_hands h ON h.table_id=j.table_id AND h.hand_number=j.hand_number
    JOIN owned c ON j.recipient_user_id=c.user_id
    WHERE j.kind='payout' AND j.amount<0 AND j.wallet_journal_id IS NOT NULL
 ), coverage AS (
   SELECT (SELECT count(*) FROM mine)=(SELECT count(*) FROM facts) AS complete,
     (SELECT count(*) FROM mine) AS played
 ), peak AS (
   SELECT max((p->>'stack')::bigint) AS held FROM mine h,owned c,
     LATERAL jsonb_array_elements(h.players) p
    WHERE p->>'userId'=c.user_id::text AND (p->>'stack') ~ '^[0-9]+$'
 )
 SELECT jsonb_build_object(
   'asset','diamonds','custody_id',c.id,'user_id',c.user_id,'table_id',p_table_id,
   'occupancy_id',p_occupancy_id,'status',CASE WHEN c.state='released' THEN 'settled' ELSE 'pending' END,
   'started_at',c.created_at,'released_at',c.released_at,
   'total_buy_in',m.bought,'chips_returned',m.returned,'jackpot_awards',a.paid,
   'profit_loss',CASE WHEN c.state='released' THEN m.returned+a.paid-m.bought END,
   'total_rebuys',m.rebuys,'facts_complete',v.complete,
   'hands_played',v.played,
   'hands_won',CASE WHEN v.complete THEN (SELECT count(*) FROM facts WHERE returned>0) END,
   'vpip_percent',CASE WHEN v.complete THEN CASE WHEN v.played=0 THEN 0
     ELSE round(100.0*(SELECT count(*) FROM facts WHERE vpip)/v.played)::integer END END,
   'peak_stack',greatest(m.funded_peak,p.held,c.balance)
 ) FROM owned c,money m,awards a,coverage v,peak p;
$fn$;
REVOKE ALL ON FUNCTION public.fn_my_diamond_cash_session_recap(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_my_diamond_cash_session_recap(uuid,uuid) TO authenticated,service_role;

CREATE FUNCTION public.fn_notify_my_diamond_cash_session_recap(p_table_id uuid,p_occupancy_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE r jsonb; v_id uuid; v_message text; v_hands text;
BEGIN
 r := public.fn_my_diamond_cash_session_recap(p_table_id,p_occupancy_id);
 IF r IS NULL OR r->>'status'<>'settled' THEN RETURN r; END IF;
 v_id := (r->>'custody_id')::uuid;
 v_hands := CASE WHEN r->'hands_played'='null'::jsonb THEN 'Hand Count Unavailable'
   ELSE format('Over %s Hands',r->>'hands_played') END;
 v_message := format('Session Ended. P/L: %s%s Diamonds. %s.',
   CASE WHEN (r->>'profit_loss')::numeric>=0 THEN '+' ELSE '' END,
   to_char((r->>'profit_loss')::numeric,'FM999,999,999,999,999,990'),v_hands);
 INSERT INTO public.notifications(id,user_id,type,title,message,metadata,read)
 VALUES(v_id,auth.uid(),'system','Session Complete',v_message,
   jsonb_build_object('tableId',p_table_id,'custodyId',v_id,'occupancyId',p_occupancy_id,
     'asset','diamonds','plDiamonds',r->'profit_loss','hands',r->'hands_played'),false)
 ON CONFLICT(id) DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM public.notifications n WHERE n.id=v_id AND n.user_id=auth.uid()
    AND n.metadata->>'custodyId'=v_id::text
    AND n.metadata->'plDiamonds'=r->'profit_loss'
    AND n.metadata->'hands'=r->'hands_played') THEN
   RAISE EXCEPTION 'recap_notification_identity_mismatch';
 END IF;
 RETURN r||jsonb_build_object('notification_id',v_id);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_notify_my_diamond_cash_session_recap(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_notify_my_diamond_cash_session_recap(uuid,uuid) TO authenticated,service_role;
-- @live-proof: has_function_privilege('authenticated','public.fn_my_diamond_cash_session_recap(uuid,uuid)','EXECUTE') AND NOT has_function_privilege('anon','public.fn_my_diamond_cash_session_recap(uuid,uuid)','EXECUTE') AND has_function_privilege('authenticated','public.fn_notify_my_diamond_cash_session_recap(uuid,uuid)','EXECUTE') AND NOT has_function_privilege('anon','public.fn_notify_my_diamond_cash_session_recap(uuid,uuid)','EXECUTE')
COMMIT;
