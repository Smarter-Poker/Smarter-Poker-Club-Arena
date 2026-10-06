\set ON_ERROR_STOP on

CREATE FUNCTION public.fixture_expect_refusal(p_sql text, p_state text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = p_state THEN RETURN; END IF;
    RAISE EXCEPTION 'expected state %, got %: %', p_state, SQLSTATE, SQLERRM;
  END;
  RAISE EXCEPTION 'expected state %, call succeeded', p_state;
END $$;
GRANT EXECUTE ON FUNCTION public.fixture_expect_refusal(text,text) TO authenticated;

INSERT INTO public.ca_hand_facts(hand_id,user_id) VALUES
  ('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001'),
  ('30000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002');

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000001',false);

DO $$
DECLARE first_id uuid; replay_id uuid; saved_goal_id uuid; saved_collection_id uuid; saved_alert_id uuid;
BEGIN
  first_id := public.fn_ca_stats_workspace_report_save(
    'range-30-v1','Opening Review','rule_derived','rules-v1',
    '{"summary":"tighten blind defense"}','[{"hand_id":"30000000-0000-0000-0000-000000000001"}]');
  replay_id := public.fn_ca_stats_workspace_report_save(
    'range-30-v1','Opening Review','rule_derived','rules-v1',
    '{"summary":"tighten blind defense"}','[{"hand_id":"30000000-0000-0000-0000-000000000001"}]');
  IF first_id <> replay_id OR (SELECT count(*) FROM public.ca_stats_workspace_reports) <> 1 THEN
    RAISE EXCEPTION 'exact report replay was not idempotent';
  END IF;
  PERFORM public.fn_ca_stats_workspace_leak_save(
    'blind-defense','Blind Defense','medium','open','{}',
    ARRAY['30000000-0000-0000-0000-000000000001']::uuid[],first_id);

  saved_goal_id := public.fn_ca_stats_workspace_goal_save(NULL,'Lower Rake Drag','rake_per_100','decrease',12,9);
  PERFORM public.fn_ca_stats_workspace_goal_progress_add(saved_goal_id,10.5,'{"range_days":30}');
  saved_collection_id := public.fn_ca_stats_workspace_collection_save(NULL,'Blind Defense','Own Reviewed Hands');
  PERFORM public.fn_ca_stats_workspace_study_add(saved_collection_id,'30000000-0000-0000-0000-000000000001');
  PERFORM public.fn_ca_stats_workspace_preferences_save('["overview","rake"]',true);
  saved_alert_id := public.fn_ca_stats_workspace_alert_rule_save(NULL,'Rake Threshold','rake_per_100','gt',12,true,1440);
  IF public.fn_ca_stats_workspace_alerts_evaluate('{"rake_per_100":15}') <> 1 THEN
    RAISE EXCEPTION 'enabled refresh alert was not evaluated';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.ca_stats_workspace_collection_hands WHERE collection_id = saved_collection_id)
     OR NOT EXISTS (SELECT 1 FROM public.ca_stats_workspace_preferences WHERE privacy_presentation_mode)
     OR NOT EXISTS (SELECT 1 FROM public.ca_stats_workspace_alert_rules WHERE id = saved_alert_id AND evaluation_mode = 'on_stats_refresh' AND last_value = 15 AND last_triggered_at IS NOT NULL) THEN
    RAISE EXCEPTION 'workspace persistence failed';
  END IF;
END $$;

SELECT public.fixture_expect_refusal($q$SELECT public.fn_ca_stats_workspace_report_save(
  'range-30-v1','Changed Report','rule_derived','rules-v1','{"summary":"different"}','[]')$q$,'23505');
SELECT public.fixture_expect_refusal($q$SELECT public.fn_ca_stats_workspace_study_add(
  (SELECT id FROM public.ca_stats_workspace_collections LIMIT 1),
  '30000000-0000-0000-0000-000000000002')$q$,'42501');
SELECT public.fixture_expect_refusal($q$SELECT public.fn_ca_stats_workspace_leak_save(
  'foreign-hand','Foreign Hand','medium','open','{}',
  ARRAY['30000000-0000-0000-0000-000000000002']::uuid[],NULL)$q$,'42501');

RESET ROLE;

INSERT INTO public.ca_stats_workspace_goals(id,user_id,title,metric_key,direction,baseline,target)
VALUES ('40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002','Other Goal','vpip','decrease',40,30);

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000001',false);
SELECT public.fixture_expect_refusal($q$SELECT public.fn_ca_stats_workspace_goal_save(
  '40000000-0000-0000-0000-000000000001','Stolen Goal','vpip','increase',1,2)$q$,'42501');

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_stats_workspace_goals WHERE id='40000000-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION 'RLS exposed another owner goal';
  END IF;
  IF has_table_privilege('anon','public.ca_stats_workspace_reports','SELECT')
     OR has_function_privilege('anon','public.fn_ca_stats_workspace_report_save(text,text,text,text,jsonb,jsonb,uuid,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'anonymous workspace privilege leaked';
  END IF;
END $$;
RESET ROLE;
