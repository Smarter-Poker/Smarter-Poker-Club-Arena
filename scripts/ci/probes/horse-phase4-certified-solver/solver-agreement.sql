\set ON_ERROR_STOP on
BEGIN;
DO $probe$
DECLARE
  v_rows jsonb;
  v_result integer;
  v_summary record;
  v_details integer;
  v_top record;
  v_audit jsonb;
BEGIN
  v_rows := jsonb_build_array(jsonb_build_object(
    'run_date','2026-09-08',
    'reference','gto_charts',
    'spots',2,
    'eligible_spots',2,
    'reconciled_spots',2,
    'agreement',0.55,
    'pure_misses',1,
    'action_regret_bb',0.6,
    'regret_eligible_spots',1,
    'decision_checksum',repeat('f',64),
    'decisions',jsonb_build_array(
      jsonb_build_object(
        'state_key','Cash|open_jam|BTN|8|AA',
        'decision_state',jsonb_build_object(
          'schema_version',1,'stage','preflop','game_variant','nlh','game_type','Cash',
          'format','cash','kind','open_jam','position','BTN','stack_bb',8,'hand','AA',
          'chart','Cash|fold_to_hero|BTN|8','villain_action','fold_to_hero',
          'legal_actions',jsonb_build_array('push','fold')),
        'kind','open_jam','game_type','Cash','position','BTN','stack_bb',8,'hand','AA',
        'final_action','push','reference_distribution',jsonb_build_object('push',0.9,'fold',0.1),
        'chosen_probability',0.9,'action_regret_bb',0.6,'regret_eligible',true,'pure_miss',false,
        'source_seal',jsonb_build_object(
          'quality_seal','CHART_AUDITED','policy_version','1.0.1','policy_checksum',repeat('a',64),
          'system','memory_charts_gold','artifact_id','one','scenario_hash','hash-one',
          'source_artifact_checksum',repeat('b',64),'provenance_complete',true,
          'audited_at','2026-09-08T00:00:00Z')),
      jsonb_build_object(
        'state_key','Tournament|bb_defend|BB|12|T9s',
        'decision_state',jsonb_build_object(
          'schema_version',1,'stage','preflop','game_variant','nlh','game_type','Tournament',
          'format','mtt','kind','bb_defend','position','BB','stack_bb',12,'hand','T9s',
          'chart','Tournament|sb_push|BB|12','villain_action','sb_push',
          'legal_actions',jsonb_build_array('call','fold')),
        'kind','bb_defend','game_type','Tournament','position','BB','stack_bb',12,'hand','T9s',
        'final_action','fold','reference_distribution',jsonb_build_object('call',0.8,'fold',0.2),
        'chosen_probability',0.2,'action_regret_bb',NULL,'regret_eligible',false,'pure_miss',true,
        'source_seal',jsonb_build_object(
          'quality_seal','CHART_AUDITED','policy_version','1.0.1','policy_checksum',repeat('c',64),
          'system','memory_charts_gold','artifact_id','two','scenario_hash','hash-two',
          'source_artifact_checksum',repeat('d',64),'provenance_complete',true,
          'audited_at','2026-09-08T00:00:00Z'))
    )
  ));
  SELECT public.fn_horse_solver_agreement_add(v_rows) INTO v_result;
  IF v_result <> 1 THEN RAISE EXCEPTION 'expected one written row, got %',v_result; END IF;
  SELECT * INTO v_summary FROM public.horse_solver_agreement WHERE run_date='2026-09-08' AND reference='gto_charts';
  IF v_summary.spots<>2 OR v_summary.eligible_spots<>2 OR v_summary.reconciled_spots<>2
     OR v_summary.pure_misses<>1 OR v_summary.regret_eligible_spots<>1
     OR abs(v_summary.agreement-0.55)>0.000001 OR abs(v_summary.action_regret_bb-0.6)>0.000001
     OR v_summary.decision_checksum !~ '^[0-9a-f]{64}$' OR v_summary.decision_checksum=repeat('f',64)
  THEN RAISE EXCEPTION 'summary not recomputed: %',row_to_json(v_summary); END IF;
  SELECT count(*) INTO v_details FROM public.horse_solver_agreement_decisions WHERE run_date='2026-09-08';
  IF v_details<>2 THEN RAISE EXCEPTION 'expected two details, got %',v_details; END IF;
  SELECT * INTO v_top FROM public.ca_horse_solver_agreement_decisions('2026-09-08','gto_charts',100) LIMIT 1;
  IF v_top.state_key<>'Tournament|bb_defend|BB|12|T9s' OR NOT v_top.pure_miss
     OR v_top.decision_state->>'chart'<>'Tournament|sb_push|BB|12'
  THEN RAISE EXCEPTION 'detail ordering wrong: %',row_to_json(v_top); END IF;
  v_audit := public.fn_audit_solver_agreement('2026-09-08');
  IF v_audit::text LIKE '%solver_agreement_unreconciled%' OR v_audit::text NOT LIKE '%solver_agreement_thin%'
  THEN RAISE EXCEPTION 'audit result wrong: %',v_audit; END IF;

  BEGIN
    PERFORM public.fn_horse_solver_agreement_add(
      jsonb_set(v_rows,'{0,agreement}','0.99'::jsonb)
    );
    RAISE EXCEPTION 'tampered summary was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='tampered summary was accepted' THEN RAISE; END IF;
  END;
  IF (SELECT agreement FROM public.horse_solver_agreement WHERE run_date='2026-09-08')<>0.55
     OR (SELECT count(*) FROM public.horse_solver_agreement_decisions WHERE run_date='2026-09-08')<>2
  THEN RAISE EXCEPTION 'failed replacement damaged last good row'; END IF;

  BEGIN
    PERFORM public.fn_horse_solver_agreement_add(
      jsonb_set(v_rows,'{0,decisions,0,decision_state,chart}',to_jsonb('Cash|sb_push|BTN|8'::text))
    );
    RAISE EXCEPTION 'forged decision state was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='forged decision state was accepted' THEN RAISE; END IF;
  END;
END
$probe$;
ROLLBACK;
SELECT 'SOLVER_AGREEMENT_BEHAVIOR_OK' AS result;
