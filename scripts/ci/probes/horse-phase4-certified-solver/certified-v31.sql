\set ON_ERROR_STOP on
BEGIN;
DO $probe$
DECLARE
  roles text[]:=ARRAY['open','cbet','probe','delayed_cbet','barrel','facing_bet','facing_raise','check_raise','bet_raise','all_in',
    'open','open','open','open','open','open','open','open'];
  families text[]:=ARRAY['cash','tourney_ev','spin','spin','tourney_icm','tourney_icm','tourney_icm','tourney_icm','tourney_icm','cash',
    'cash','cash','tourney_ev','tourney_ev','spin','spin','spin','spin'];
  objectives text[]:=ARRAY['cash_ev','chip_ev','chip_ev','icm','icm','icm','icm','icm','icm','cash_ev',
    'cash_ev','cash_ev','chip_ev','chip_ev','chip_ev','chip_ev','icm','icm'];
  utilities text[]:=ARRAY['cash_ev','chip_ev','chip_ev','spin_ladder','satellite','bubble','final_table','in_money','ladder','cash_ev',
    'cash_ev','cash_ev','chip_ev','chip_ev','chip_ev','chip_ev','spin_ladder','spin_ladder'];
  streets text[]:=ARRAY['flop','flop','turn','turn','turn','river','flop','flop','flop','flop',
    'turn','river','turn','river','flop','river','flop','river'];
  nodes text[]:=ARRAY[
    'r:0','r:0','r:0:c:c:2h','r:0:c:c:2h','r:0:b75:c:2h',
    'r:0:b75:c:2h:b200:c:3s:b500','r:0:b75:b225:b500',
    'r:0:c:b75:b225','r:0:b75:b225','r:0:b8000',
    'r:0:c:c:2h','r:0:c:c:2h:c:c:3s','r:0:c:c:2h',
    'r:0:c:c:2h:c:c:3s','r:0','r:0:c:c:2h:c:c:3s','r:0',
    'r:0:c:c:2h:c:c:3s'];
  coverage jsonb:='[]'::jsonb; cov jsonb; dataset uuid; bundle uuid; bundle_checksum text;
  i integer; role text; facing text; bucket text; board text; specs jsonb; context jsonb;
  preflop_aggressor integer; hero_solver_player integer; line_proof jsonb; derived_line jsonb;
  node_raw jsonb; node jsonb; forged jsonb; matrix jsonb; live jsonb; zeros jsonb; nulls jsonb;
  train_id uuid; holdout_id uuid; train_art jsonb; holdout_art jsonb; result_checksum text;
  failed boolean; kind text; family text; result_id bigint; eval_id uuid; status jsonb;
  eval_scenarios text[]; eval_roles text[]:=ARRAY['all_in','barrel','bet_raise','cbet',
    'check_raise','delayed_cbet','facing_bet','facing_raise','open','probe'];
  components jsonb; scenario_hands integer; component_stderr numeric;
BEGIN
  CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $auth$ SELECT 'authenticated'::text $auth$;
  bundle:=public.ca_gto_v31_approve_input_bundle(jsonb_build_object(
    'bundle_key','phase4.behavior.inputs','bundle_version','1',
    'range_bundle_checksum',repeat('e',64),'source_combo_order_checksum',repeat('d',64),
    'icm_model_checksum',repeat('f',64),'approval_note','behavior probe fixture only',
    'files',jsonb_build_array(
      jsonb_build_object('kind','range','path','ranges/test.txt','checksum',repeat('e',64)),
      jsonb_build_object('kind','combo_order','path','combo/order.txt','checksum',repeat('d',64)),
      jsonb_build_object('kind','icm_model','path','icm/model.json','checksum',repeat('f',64)),
      jsonb_build_object('kind','scenario_manifest','path','manifests/phase4.json','checksum',repeat('c',64))
    )));
  SELECT b.bundle_checksum INTO bundle_checksum FROM public.gto_v31_input_bundles b WHERE b.input_bundle_id=bundle;
  CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $auth$ SELECT 'service_role'::text $auth$;

  FOR i IN 1..array_length(roles,1) LOOP
    role:=roles[i];
    facing:=CASE WHEN role='all_in' THEN 'all_in' WHEN role='facing_bet' THEN 'bet'
      WHEN role IN ('facing_raise','check_raise','bet_raise') THEN 'raise' ELSE 'none' END;
    bucket:=CASE WHEN role='all_in' THEN 'all_in' WHEN facing='none' THEN 'none'
      ELSE 'small' END;
    board:=CASE streets[i] WHEN 'flop' THEN 'AsKd7c' WHEN 'turn' THEN 'AsKd7c2h' ELSE 'AsKd7c2h3s' END;
    cov:=jsonb_build_object('street',streets[i],'game_family',families[i],
      'objective',objectives[i],'utility_context',utilities[i],
      'table_size',CASE WHEN i<=9 THEN i+1 ELSE 10 END,
      'pot_type',CASE WHEN i>10 THEN 'limped'
        ELSE (ARRAY['limped','srp','3bet','4bet_plus'])[((i-1)%4)+1] END,
      'hero_position','SB','opponent_position','BB','depth_bucket',80,
      'texture_class',public.fn_gto_texture_class_any(board),'node_role',role,
      'facing_kind',facing,'facing_size_bucket',bucket);
    coverage:=coverage||jsonb_build_array(cov);
  END LOOP;

  dataset:=public.fn_gto_v31_register_dataset(jsonb_build_object(
    'dataset_key','phase4.behavior.probe','solver_version','PioSOLVER-edge',
    'solver_binary_checksum',repeat('a',64),'pipeline_commit',repeat('b',40),
    'pipeline_bundle_checksum',repeat('8',64),
    'manifest_version','5','manifest_checksum',repeat('c',64),
    'source_combo_order_checksum',repeat('d',64),'range_bundle_checksum',repeat('e',64),
    'icm_model_checksum',repeat('f',64),'input_bundle_id',bundle,
    'input_bundle_checksum',bundle_checksum,'machine_ids',jsonb_build_array('M1','M2'),
    'declared_coverage',coverage,'quality_gates',jsonb_build_object(
      'max_frequency_mae',0.10,'max_sizing_mae',0.10,'max_policy_ev_mae_bb',0.20,
      'max_action_regret_bb',0.10,'min_regret_coverage',0.80)));

  FOR i IN 1..array_length(roles,1) LOOP
    role:=roles[i]; facing:=coverage->(i-1)->>'facing_kind'; bucket:=coverage->(i-1)->>'facing_size_bucket';
    board:=CASE streets[i] WHEN 'flop' THEN 'AsKd7c' WHEN 'turn' THEN 'AsKd7c2h' ELSE 'AsKd7c2h3s' END;
    preflop_aggressor:=CASE
      WHEN role='open' THEN NULL
      WHEN role='cbet' THEN 0
      WHEN role='probe' THEN 1
      WHEN role='delayed_cbet' THEN 0
      WHEN coverage->(i-1)->>'pot_type'='limped' THEN NULL
      ELSE 0 END;
    derived_line:=public.fn_gto_v31_node_line_proof(nodes[i],preflop_aggressor,1000,8000);
    hero_solver_player:=(derived_line->>'current_actor_solver_player')::integer;
    IF derived_line IS NULL OR derived_line->>'street'<>streets[i]
       OR derived_line->>'derived_node_role'<>role
       OR derived_line->>'derived_facing_kind'<>facing
       OR derived_line->>'derived_facing_size_bucket'<>bucket THEN
      RAISE EXCEPTION 'line proof fixture % does not derive its declared role',i;
    END IF;
    line_proof:=jsonb_build_object(
      'schema','smarter-poker.pio-line-proof.v1',
      'manifest_checksum',repeat('c',64),
      'hero_solver_player',hero_solver_player,
      'preflop_aggressor_solver_player',preflop_aggressor,
      'root_pot_chips',1000,
      'effective_stack_chips',8000,
      'chips_per_bb',100);
    SELECT jsonb_agg(to_jsonb(CASE WHEN EXISTS (
             SELECT 1 FROM unnest(public.fn_gto_v31_combo_cards(n)) c(card)
              WHERE position(c.card IN board)>0) THEN 0.0 ELSE 1.0 END) ORDER BY n),
           jsonb_agg(to_jsonb(0.0::numeric) ORDER BY n),
           jsonb_agg(CASE WHEN EXISTS (
             SELECT 1 FROM unnest(public.fn_gto_v31_combo_cards(n)) c(card)
              WHERE position(c.card IN board)>0) THEN 'null'::jsonb ELSE to_jsonb(1.0::numeric) END ORDER BY n)
      INTO live,zeros,nulls FROM generate_series(0,1325) n;
    context:=(coverage->(i-1))||jsonb_build_object(
      'board',board,
      'facing_target_chips',CASE WHEN facing='none' THEN NULL
        ELSE (derived_line->>'facing_target_chips')::numeric END,
      'facing_actor_total_chips',CASE WHEN facing='none' THEN NULL
        ELSE (derived_line->>'facing_actor_total_chips')::numeric END);
    IF facing='none' THEN
      specs:=jsonb_build_object(
        'check',jsonb_build_object('family','check','size_unit','none','size_value',NULL,'all_in',false),
        'bet75',jsonb_build_object('family','bet','size_unit','pot_fraction','size_value',0.75,'all_in',false));
      node_raw:=jsonb_build_object('schema','smarter-poker.pio-policy.v3','node',nodes[i],
        'node_context',context,'line_proof',line_proof,'action_specs',specs,
        'frequencies',jsonb_build_object('check',zeros,'bet75',live),'policy_evs_bb',nulls,
        'action_evs_bb',jsonb_build_object('check',nulls,'bet75',nulls),'matchups',live,
        'source_combo_order_checksum',repeat('d',64),'range_bundle_checksum',repeat('e',64));
    ELSIF role='all_in' THEN
      specs:=jsonb_build_object(
        'fold',jsonb_build_object('family','fold','size_unit','none','size_value',NULL,'all_in',false),
        'call',jsonb_build_object('family','call','size_unit','none','size_value',NULL,'all_in',false));
      node_raw:=jsonb_build_object('schema','smarter-poker.pio-policy.v3','node',nodes[i],
        'node_context',context,'line_proof',line_proof,'action_specs',specs,
        'frequencies',jsonb_build_object('fold',zeros,'call',live),'policy_evs_bb',nulls,
        'action_evs_bb',jsonb_build_object('fold',nulls,'call',nulls),'matchups',live,
        'source_combo_order_checksum',repeat('d',64),'range_bundle_checksum',repeat('e',64));
    ELSE
      specs:=jsonb_build_object(
        'fold',jsonb_build_object('family','fold','size_unit','none','size_value',NULL,'all_in',false),
        'call',jsonb_build_object('family','call','size_unit','none','size_value',NULL,'all_in',false),
        'raise75',jsonb_build_object('family','raise','size_unit','pot_after_call_fraction','size_value',0.75,'all_in',false));
      node_raw:=jsonb_build_object('schema','smarter-poker.pio-policy.v3','node',nodes[i],
        'node_context',context,'line_proof',line_proof,'action_specs',specs,
        'frequencies',jsonb_build_object('fold',zeros,'call',live,'raise75',zeros),'policy_evs_bb',nulls,
        'action_evs_bb',jsonb_build_object('fold',nulls,'call',nulls,'raise75',nulls),'matchups',live,
        'source_combo_order_checksum',repeat('d',64),'range_bundle_checksum',repeat('e',64));
    END IF;
    node:=node_raw||jsonb_build_object('node_checksum',public.fn_gto_v31_node_checksum(node_raw));
    IF NOT public.fn_gto_v31_source_node_valid(node) THEN RAISE EXCEPTION 'source node % rejected',i; END IF;
    IF role='cbet' THEN
      forged:=jsonb_set(node_raw,'{node_context,node_role}','"open"'::jsonb);
      forged:=forged||jsonb_build_object('node_checksum',public.fn_gto_v31_node_checksum(forged));
      IF public.fn_gto_v31_source_node_valid(forged) THEN
        RAISE EXCEPTION 'semantic open-role forgery was accepted';
      END IF;
    END IF;
    IF role='facing_bet' THEN
      forged:=jsonb_set(node_raw,'{node_context,facing_size_bucket}','"big"'::jsonb);
      forged:=forged||jsonb_build_object('node_checksum',public.fn_gto_v31_node_checksum(forged));
      IF public.fn_gto_v31_source_node_valid(forged) THEN
        RAISE EXCEPTION 'forged facing-size bucket was accepted';
      END IF;
    END IF;
    IF role='all_in' THEN
      node_raw:=jsonb_set(node_raw,'{node_context,facing_actor_total_chips}',
        to_jsonb((context->>'facing_actor_total_chips')::numeric+1));
      node_raw:=node_raw||jsonb_build_object('node_checksum',public.fn_gto_v31_node_checksum(node_raw));
      IF public.fn_gto_v31_source_node_valid(node_raw) THEN
        RAISE EXCEPTION 'false all-in source node was accepted';
      END IF;
    END IF;
    matrix:=jsonb_build_object('schema','smarter-poker.pio-artifact.v31.1',
      'combo_order','card=rank*4+suit; combo=b*(b-1)/2+a; 2c2d=0..AhAs=1325',
      'nodes',jsonb_build_array(CASE WHEN i=1 THEN node_raw ELSE node END));
    train_id:=gen_random_uuid();
    holdout_id:=gen_random_uuid();
    train_art:=jsonb_build_object('id',train_id,'scenario_hash','phase4.'||i||'.m1',
      'game_family',families[i],'stack_depth',80,'street',streets[i],
      'solved_at',now(),'strategy_matrix_v2',matrix);
    holdout_art:=jsonb_build_object('id',holdout_id,'scenario_hash','phase4.'||i||'.m2',
      'game_family',families[i],'stack_depth',80,'street',streets[i],
      'solved_at',now(),'strategy_matrix_v2',matrix);
    IF i=1 THEN
      failed:=false;
      BEGIN
        PERFORM public.fn_gto_v31_ingest_source_artifact(dataset,'M1',
          jsonb_set(train_art,'{strategy_matrix_v2,nodes,0,frequencies,bet75,0}','0.5'::jsonb));
      EXCEPTION WHEN OTHERS THEN failed:=true; END;
      IF NOT failed THEN RAISE EXCEPTION 'unnormalized source was accepted'; END IF;
    END IF;
    PERFORM public.fn_gto_v31_ingest_source_artifact(dataset,'M1',train_art);
    IF i=1 AND NOT EXISTS (
      SELECT 1 FROM public.solved_spots_gold s
       WHERE s.id=train_id
         AND s.strategy_matrix_v2#>>'{nodes,0,node_checksum}'~'^[0-9a-f]{64}$'
         AND public.fn_gto_v31_source_node_valid(s.strategy_matrix_v2#>'{nodes,0}')
    ) THEN
      RAISE EXCEPTION 'database did not seal the checksum-less worker node';
    END IF;
    PERFORM public.fn_gto_v31_ingest_source_artifact(dataset,'M2',holdout_art);
    PERFORM public.fn_gto_v31_build_cell(dataset,coverage->(i-1));
  END LOOP;

  result_checksum:=public.fn_gto_v31_seal_build(dataset);
  IF result_checksum!~'^[0-9a-f]{64}$' OR (SELECT state FROM public.gto_v31_datasets WHERE dataset_id=dataset)<>'evaluating'
     OR (SELECT heldout_metrics->>'validated' FROM public.gto_v31_datasets WHERE dataset_id=dataset)<>'true'
  THEN RAISE EXCEPTION 'build did not seal for evaluation'; END IF;

  FOR kind IN SELECT unnest(ARRAY['paired_replay','league']) LOOP
    FOREACH family IN ARRAY ARRAY['cash','spin','tourney_ev','tourney_icm'] LOOP
      eval_scenarios:=CASE family
        WHEN 'cash' THEN ARRAY['cash_ev']::text[]
        WHEN 'spin' THEN ARRAY['chip_ev','spin_ladder']::text[]
        WHEN 'tourney_ev' THEN ARRAY['chip_ev']::text[]
        ELSE ARRAY['satellite','bubble','final_table','in_money','ladder']::text[]
      END;
      scenario_hands:=10000/array_length(eval_scenarios,1);
      component_stderr:=sqrt(array_length(eval_scenarios,1)::numeric*
        scenario_hands::numeric*scenario_hands::numeric)/10000;
      components:='[]'::jsonb;
      FOR i IN 1..array_length(eval_scenarios,1) LOOP
        components:=components||jsonb_build_array(jsonb_build_object(
          'scenario',eval_scenarios[i],'hands',scenario_hands,'bb100',0,
          'stderr',1,'duration_ms',1,'illegal_actions',0,'truncated_streets',0,
          'candidate_policy_hits',2,'candidate_node_roles',to_jsonb(eval_roles)));
      END LOOP;
      IF kind='paired_replay' AND family='cash' THEN
        INSERT INTO public.horse_league_results(
          run_date,matchup,hands,bb100,stderr,config_a,config_b,duration_ms,
          illegal_actions,truncated_streets,candidate_policy_hits,candidate_node_roles,
          candidate_benchmark_components)
        VALUES(current_date,'gto_v31_'||kind||'_'||family||'_'||left(result_checksum,12),
          10000,0,component_stderr,
          jsonb_build_object('evaluation_contract','gto_v31_candidate.v1','evaluation_kind',kind,
            'game_family',family,'dataset_checksum',result_checksum,'candidate','v31_certified',
            'evaluation_profile','policy_only_duplicate_deals','scenarios',to_jsonb(eval_scenarios)),
          jsonb_build_object('incumbent_dataset_checksum','legacy_v30','candidate','incumbent'),
          2,0,0,2,eval_roles,components)
        RETURNING id INTO result_id;
        failed:=false;
        BEGIN PERFORM public.fn_gto_v31_record_evaluation(dataset,kind,family,result_id);
        EXCEPTION WHEN OTHERS THEN failed:=true; END;
        IF NOT failed THEN RAISE EXCEPTION 'unreconciled component duration was accepted'; END IF;
        DELETE FROM public.horse_league_results WHERE id=result_id;
      END IF;
      INSERT INTO public.horse_league_results(
        run_date,matchup,hands,bb100,stderr,config_a,config_b,duration_ms,
        illegal_actions,truncated_streets,candidate_policy_hits,candidate_node_roles,
        candidate_benchmark_components)
      VALUES(current_date,'gto_v31_'||kind||'_'||family||'_'||left(result_checksum,12),
        10000,0,component_stderr,
        jsonb_build_object('evaluation_contract','gto_v31_candidate.v1','evaluation_kind',kind,
          'game_family',family,'dataset_checksum',result_checksum,'candidate','v31_certified',
          'evaluation_profile',CASE kind WHEN 'paired_replay' THEN
            'policy_only_duplicate_deals' ELSE 'full_brain_duplicate_deal_league' END,
          'scenarios',to_jsonb(eval_scenarios)),
        jsonb_build_object('incumbent_dataset_checksum','legacy_v30','candidate','incumbent'),
        array_length(eval_scenarios,1),0,0,2*array_length(eval_scenarios,1),eval_roles,components)
      RETURNING id INTO result_id;
      eval_id:=public.fn_gto_v31_record_evaluation(dataset,kind,family,result_id);
      IF eval_id IS NULL THEN RAISE EXCEPTION 'evaluation receipt missing'; END IF;
    END LOOP;
  END LOOP;
  IF public.fn_gto_v31_mark_candidate(dataset)<>result_checksum THEN RAISE EXCEPTION 'candidate checksum changed'; END IF;
  IF public.fn_gto_v31_promote_dataset(dataset)<>result_checksum THEN RAISE EXCEPTION 'promotion checksum changed'; END IF;
  IF (SELECT count(*) FROM public.fn_gto_v31_active_cells(0,500))<>array_length(roles,1) THEN
    RAISE EXCEPTION 'active RPC incomplete';
  END IF;
  IF EXISTS (SELECT 1 FROM public.fn_gto_v31_active_cells(0,500)
      WHERE input_bundle_checksum IS NULL OR icm_model_checksum IS NULL OR policy_ev_matrix='{}'::jsonb)
  THEN RAISE EXCEPTION 'active RPC omitted provenance or EV'; END IF;
  status:=public.ca_gto_v31_certification_status(dataset);
  IF status->>'contract'<>'smarter-poker.gto-v31-certification-status.v1'
     OR status#>>'{active_dataset,dataset_checksum}'<>result_checksum
     OR jsonb_array_length(status->'datasets')<>1
     OR jsonb_array_length(status#>'{datasets,0,evaluations}')<>9 THEN
    RAISE EXCEPTION 'certification status did not reconcile the promoted dataset';
  END IF;

  CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $auth$ SELECT 'authenticated'::text $auth$;
  failed:=false;
  BEGIN PERFORM public.ca_gto_v31_revoke_input_bundle(bundle,'probe revocation');
  EXCEPTION WHEN OTHERS THEN failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'active input bundle was revoked'; END IF;
  CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $auth$ SELECT 'service_role'::text $auth$;
END
$probe$;
ROLLBACK;
SELECT 'V31_CERTIFICATION_BEHAVIOR_OK' AS result;
