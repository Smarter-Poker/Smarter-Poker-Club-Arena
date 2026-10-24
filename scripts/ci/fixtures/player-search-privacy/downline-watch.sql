-- Isolated fixtures only. The actual migration supplies every permission body.


INSERT INTO public.club_members (club_id,user_id,status,role,agent_id) VALUES
('a0000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','active','agent',NULL),
('a0000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000003','active','sub_agent','20000000-0000-0000-0000-000000000001');
UPDATE public.club_members SET agent_id='20000000-0000-0000-0000-000000000003'
 WHERE club_id='a0000000-0000-0000-0000-000000000001' AND user_id='20000000-0000-0000-0000-000000000002';
UPDATE public.tables SET restrict_observers=true, is_anonymous=true
 WHERE id='30000000-0000-0000-0000-000000000004';
-- Viewer does not belong to the table owner's club.
DELETE FROM public.club_members WHERE club_id='a0000000-0000-0000-0000-000000000004' AND user_id='20000000-0000-0000-0000-000000000001';
-- BEGIN DOWNLINE ASSERTIONS
CREATE FUNCTION pg_temp.assert_watch(ok boolean, message text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION '%', message; END IF; END $$;
SELECT set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000001',false);
SELECT set_config('request.jwt.claim.role','authenticated',false);

SELECT pg_temp.assert_watch(public.fn_agent_can_watch_table('30000000-0000-0000-0000-000000000004'), 'recursive other-club tournament watch refused');
SELECT pg_temp.assert_watch(public.fn_get_table_watch_access('30000000-0000-0000-0000-000000000004','20000000-0000-0000-0000-000000000002')->>'action'='watch', 'click-time restricted table watch refused');
SELECT pg_temp.assert_watch(NOT public.fn_agent_can_watch_table('30000000-0000-0000-0000-000000000004','20000000-0000-0000-0000-000000000003'), 'viewer identity spoof granted');
SELECT pg_temp.assert_watch(NOT public.fn_agent_can_watch_table('30000000-0000-0000-0000-000000000005'), 'ended tournament stale seat granted');

UPDATE public.player_search_preferences SET show_current_table=false WHERE user_id='20000000-0000-0000-0000-000000000002';
SELECT pg_temp.assert_watch(public.fn_search_players('kingfish')->'items'->0->'tables'->0->>'can_watch'='true', 'search did not expose downline live table');
SELECT pg_temp.assert_watch(public.fn_search_players('kingfish')->'items'->0->'tables'->0->>'access_action'='watch', 'search and click-time access disagree');

ALTER TABLE public.tables ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.tables TO authenticated;
SET ROLE authenticated;
SELECT pg_temp.assert_watch((SELECT count(*) FROM public.tables WHERE id='30000000-0000-0000-0000-000000000004')=1, 'private downline table metadata hidden by RLS');
SELECT pg_temp.assert_watch((SELECT count(*) FROM public.tables WHERE id='30000000-0000-0000-0000-000000000005')=0, 'unrelated stale table metadata exposed by RLS');
RESET ROLE;

-- Each supported agent role owns the same exception.
UPDATE public.club_members SET role='super_agent' WHERE user_id='20000000-0000-0000-0000-000000000001';
SELECT pg_temp.assert_watch(public.fn_agent_can_watch_table('30000000-0000-0000-0000-000000000004'), 'super-agent refused');
UPDATE public.club_members SET role='sub_agent' WHERE user_id='20000000-0000-0000-0000-000000000001';
SELECT pg_temp.assert_watch(public.fn_agent_can_watch_table('30000000-0000-0000-0000-000000000004'), 'sub-agent refused');
UPDATE public.club_members SET role='player' WHERE user_id='20000000-0000-0000-0000-000000000001';
SELECT pg_temp.assert_watch(NOT public.fn_agent_can_watch_table('30000000-0000-0000-0000-000000000004'), 'non-agent granted');
UPDATE public.club_members SET role='agent',status='suspended' WHERE user_id='20000000-0000-0000-0000-000000000001';
SELECT pg_temp.assert_watch(NOT public.fn_agent_can_watch_table('30000000-0000-0000-0000-000000000004'), 'suspended agent granted');
UPDATE public.club_members SET status='active' WHERE user_id='20000000-0000-0000-0000-000000000001';
UPDATE public.club_members SET status='left' WHERE user_id='20000000-0000-0000-0000-000000000003';
SELECT pg_temp.assert_watch(NOT public.fn_agent_can_watch_table('30000000-0000-0000-0000-000000000004'), 'removed intermediate relationship granted');
UPDATE public.club_members SET status='active' WHERE user_id='20000000-0000-0000-0000-000000000003';

-- Cycle safety without dropping valid descendants or imposing a depth ceiling.
UPDATE public.club_members SET agent_id='20000000-0000-0000-0000-000000000002' WHERE user_id='20000000-0000-0000-0000-000000000001';
SELECT pg_temp.assert_watch(public.fn_agent_can_watch_table('30000000-0000-0000-0000-000000000004'), 'cycle lost valid descendant');
INSERT INTO public.club_members (club_id,user_id,status,role,agent_id)
SELECT 'a0000000-0000-0000-0000-000000000001',('50000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,'active','agent',
 CASE WHEN i=1 THEN '20000000-0000-0000-0000-000000000001'::uuid ELSE ('50000000-0000-0000-0000-'||lpad((i-1)::text,12,'0'))::uuid END
FROM generate_series(1,30) i;
UPDATE public.club_members SET agent_id='50000000-0000-0000-0000-000000000030' WHERE user_id='20000000-0000-0000-0000-000000000002' AND club_id='a0000000-0000-0000-0000-000000000001';
SELECT pg_temp.assert_watch(public.fn_agent_can_watch_table('30000000-0000-0000-0000-000000000004'), 'deep descendant refused');
SELECT pg_temp.assert_watch(public.fn_search_players('kingfish',20,0,'managed','playing')->'items'->0->'tables'->0->>'can_watch'='true', 'deep downline missing from managed/playing search');

INSERT INTO public.tables (id,club_id,name,status,is_deleted,is_anonymous,restrict_observers)
VALUES ('30000000-0000-0000-0000-000000000006','a0000000-0000-0000-0000-000000000004','Restricted Cash','running',false,true,true);
INSERT INTO public.table_seats(table_id,user_id) VALUES ('30000000-0000-0000-0000-000000000006','20000000-0000-0000-0000-000000000002');
SELECT pg_temp.assert_watch(public.fn_agent_can_watch_table('30000000-0000-0000-0000-000000000006'), 'cash downline refused');
UPDATE public.tables SET club_id=NULL,union_id='a0000000-0000-0000-0000-000000000004' WHERE id='30000000-0000-0000-0000-000000000006';
SELECT pg_temp.assert_watch(public.fn_get_table_watch_access('30000000-0000-0000-0000-000000000006','20000000-0000-0000-0000-000000000002')->>'can_watch'='true', 'union-only table refused');
SELECT pg_temp.assert_watch(jsonb_array_length(public.fn_search_players('kingfish')->'items'->0->'tables')=2, 'union-only cash table missing from search');
UPDATE public.table_seats SET left_at=now() WHERE table_id='30000000-0000-0000-0000-000000000006';
SELECT pg_temp.assert_watch(NOT public.fn_agent_can_watch_table('30000000-0000-0000-0000-000000000006'), 'departed cash downline granted');
UPDATE public.tournament_players SET status='eliminated' WHERE table_id='30000000-0000-0000-0000-000000000004';
INSERT INTO public.table_seats(table_id,user_id) VALUES ('30000000-0000-0000-0000-000000000004','20000000-0000-0000-0000-000000000002');
SELECT pg_temp.assert_watch(NOT public.fn_agent_can_watch_table('30000000-0000-0000-0000-000000000004'), 'departed tournament downline granted');
SELECT pg_temp.assert_watch(public.fn_get_table_watch_access('30000000-0000-0000-0000-000000000004','20000000-0000-0000-0000-000000000002')->>'action'='unavailable', 'stale target click granted');

SELECT pg_temp.assert_watch(NOT has_function_privilege('anon','public.fn_agent_can_watch_table(uuid,uuid)','EXECUTE'), 'anonymous helper access granted');
UPDATE public.tournament_players SET status='playing' WHERE table_id='30000000-0000-0000-0000-000000000004';
SELECT set_config('request.jwt.claim.role','service_role',false);
SELECT set_config('request.jwt.claim.sub','',false);
SELECT pg_temp.assert_watch(public.fn_agent_can_watch_table('30000000-0000-0000-0000-000000000004','20000000-0000-0000-0000-000000000001'), 'engine service-role observer refused');
SELECT set_config('request.jwt.claim.role','authenticated',false);
SELECT set_config('request.jwt.claim.sub','',false);
SELECT pg_temp.assert_watch(NOT public.fn_agent_can_watch_table('30000000-0000-0000-0000-000000000004','20000000-0000-0000-0000-000000000001'), 'missing identity granted');
