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
  i integer; role text; facing text; bucket text; board text; holdout_board text;
  holdout_node_id text; specs jsonb; context jsonb;
  preflop_aggressor integer; hero_solver_player integer; line_proof jsonb; derived_line jsonb;
  node_raw jsonb; node jsonb; holdout_node_raw jsonb; holdout_node jsonb;
  forged jsonb; matrix jsonb; holdout_matrix jsonb; live jsonb; zeros jsonb; nulls jsonb;
  holdout_live jsonb; holdout_zeros jsonb; holdout_nulls jsonb;
  holdout_frequencies jsonb; holdout_action_evs jsonb; selected_action text;
  train_id uuid; holdout_id uuid; duplicate_id uuid;
  train_art jsonb; holdout_art jsonb; duplicate_art jsonb; result_checksum text;
  failed boolean; kind text; family text; result_id bigint; eval_id uuid; status jsonb;
  eval_scenarios text[]; eval_roles text[]:=ARRAY['all_in','barrel','bet_raise','cbet',
    'check_raise','delayed_cbet','facing_bet','facing_raise','open','probe'];
  components jsonb; scenario_hands integer; component_stderr numeric;
  hand_key text; action_key text;
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

  failed:=false;
  BEGIN
    UPDATE public.gto_v31_datasets SET solver_version=' PioSOLVER-edge'
     WHERE dataset_id=dataset;
  EXCEPTION WHEN check_violation THEN failed:=true;
  END;
  IF NOT failed THEN RAISE EXCEPTION 'noncanonical solver identity was accepted'; END IF;
  failed:=false;
  BEGIN
    UPDATE public.gto_v31_datasets SET manifest_version=E'5\nforged'
     WHERE dataset_id=dataset;
  EXCEPTION WHEN check_violation THEN failed:=true;
  END;
  IF NOT failed THEN RAISE EXCEPTION 'control-bearing manifest identity was accepted'; END IF;

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
    holdout_board:=CASE streets[i] WHEN 'flop' THEN 'AhQc6d'
      WHEN 'turn' THEN 'AhQc6d3s' ELSE 'AhQc6d3s4c' END;
    holdout_node_id:=replace(replace(nodes[i],':3s',':4c'),':2h',':3s');
    WITH train_keys AS MATERIALIZED (
      SELECT DISTINCT public.fn_gto_v31_hand_key(train_n,board) AS hand_key
        FROM generate_series(0,1325) train_n
       WHERE NOT EXISTS (
         SELECT 1 FROM unnest(public.fn_gto_v31_combo_cards(train_n)) c(card)
          WHERE position(c.card IN board)>0)
    ), holdout_combos AS MATERIALIZED (
      SELECT n,NOT EXISTS (
               SELECT 1 FROM unnest(public.fn_gto_v31_combo_cards(n)) c(card)
                WHERE position(c.card IN holdout_board)>0
             ) AND public.fn_gto_v31_hand_key(n,holdout_board) IN (
               SELECT tk.hand_key FROM train_keys tk
             ) AS eligible
        FROM generate_series(0,1325) n
    )
    SELECT jsonb_agg(to_jsonb(CASE WHEN eligible THEN 1.0 ELSE 0.0 END) ORDER BY n),
           jsonb_agg(to_jsonb(0.0::numeric) ORDER BY n),
           jsonb_agg(CASE WHEN eligible THEN to_jsonb(1.0::numeric)
             ELSE 'null'::jsonb END ORDER BY n)
      INTO holdout_live,holdout_zeros,holdout_nulls FROM holdout_combos;
    selected_action:=CASE WHEN facing='none' THEN 'bet75'
      WHEN role='all_in' THEN 'call' ELSE 'call' END;
    SELECT jsonb_object_agg(key,CASE WHEN key=selected_action THEN holdout_live ELSE holdout_zeros END),
           jsonb_object_agg(key,holdout_nulls)
      INTO holdout_frequencies,holdout_action_evs FROM jsonb_object_keys(specs) key;
    holdout_node_raw:=jsonb_set(node-'node_checksum','{node}',to_jsonb(holdout_node_id));
    holdout_node_raw:=jsonb_set(holdout_node_raw,'{node_context,board}',to_jsonb(holdout_board));
    holdout_node_raw:=jsonb_set(holdout_node_raw,'{frequencies}',holdout_frequencies);
    holdout_node_raw:=jsonb_set(holdout_node_raw,'{policy_evs_bb}',holdout_nulls);
    holdout_node_raw:=jsonb_set(holdout_node_raw,'{action_evs_bb}',holdout_action_evs);
    holdout_node_raw:=jsonb_set(holdout_node_raw,'{matchups}',holdout_live);
    holdout_node:=holdout_node_raw||jsonb_build_object(
      'node_checksum',public.fn_gto_v31_node_checksum(holdout_node_raw));
    IF public.fn_gto_texture_class_any(holdout_board)<>(coverage->(i-1)->>'texture_class')
       OR NOT public.fn_gto_v31_source_node_valid(holdout_node) THEN
      RAISE EXCEPTION 'holdout board fixture % does not preserve the compact context (train texture %, holdout texture %, source valid %, node %)',
        i,coverage->(i-1)->>'texture_class',public.fn_gto_texture_class_any(holdout_board),
        public.fn_gto_v31_source_node_valid(holdout_node),holdout_node_id;
    END IF;
    holdout_matrix:=jsonb_build_object('schema','smarter-poker.pio-artifact.v31.1',
      'combo_order','card=rank*4+suit; combo=b*(b-1)/2+a; 2c2d=0..AhAs=1325',
      'nodes',jsonb_build_array(holdout_node));
    train_id:=gen_random_uuid();
    holdout_id:=gen_random_uuid();
    train_art:=jsonb_build_object('id',train_id,'scenario_hash','phase4.'||i||'.m1',
      'game_family',families[i],'stack_depth',80,'street',streets[i],
      'solved_at',now(),'strategy_matrix_v2',matrix);
    holdout_art:=jsonb_build_object('id',holdout_id,'scenario_hash','phase4.'||i||'.m2',
      'game_family',families[i],'stack_depth',80,'street',streets[i],
      'solved_at',now(),'strategy_matrix_v2',holdout_matrix);
    IF i=1 THEN
      failed:=false;
      BEGIN
        PERFORM public.fn_gto_v31_ingest_source_artifact(dataset,'M1',
          jsonb_set(train_art,'{strategy_matrix_v2,nodes,0,frequencies,bet75,0}','0.5'::jsonb));
      EXCEPTION WHEN OTHERS THEN failed:=true; END;
      IF NOT failed THEN RAISE EXCEPTION 'unnormalized source was accepted'; END IF;
      forged:=jsonb_set(node_raw,'{matchups,0}','4'::jsonb);
      forged:=forged||jsonb_build_object(
        'node_checksum',public.fn_gto_v31_node_checksum(forged));
      IF NOT public.fn_gto_v31_source_node_valid(forged) THEN
        RAISE EXCEPTION 'valid calc_ev matchup mass above one was rejected';
      END IF;
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
    IF i=1 THEN
      duplicate_id:=gen_random_uuid();
      duplicate_art:=jsonb_build_object('id',duplicate_id,
        'scenario_hash','phase4.1.m2.duplicate-board',
        'game_family',families[i],'stack_depth',80,'street',streets[i],
        'solved_at',now(),'strategy_matrix_v2',matrix);
      PERFORM public.fn_gto_v31_ingest_source_artifact(dataset,'M2',duplicate_art);
      failed:=false;
      BEGIN
        PERFORM public.fn_gto_v31_build_cell(dataset,coverage->(i-1));
      EXCEPTION WHEN OTHERS THEN failed:=true; END;
      IF NOT failed THEN
        RAISE EXCEPTION 'an M2 copy of an M1 board was accepted as held-out evidence';
      END IF;
      DELETE FROM public.gto_v31_source_artifacts
       WHERE dataset_id=dataset AND source_row_id=duplicate_id;
      DELETE FROM public.solved_spots_gold WHERE id=duplicate_id;
    END IF;
    PERFORM public.fn_gto_v31_ingest_source_artifact(dataset,'M2',holdout_art);
    PERFORM public.fn_gto_v31_build_cell(dataset,coverage->(i-1));
  END LOOP;

  SELECT to_jsonb(c) INTO forged
    FROM public.gto_v31_runtime_cells c WHERE c.dataset_id=dataset LIMIT 1;
  SELECT key INTO hand_key FROM jsonb_object_keys(forged->'hand_matrix') key LIMIT 1;
  SELECT key INTO action_key FROM jsonb_object_keys(forged->'action_specs') key LIMIT 1;
  node_raw:=jsonb_set(forged,'{policy_ev_matrix}',(forged->'policy_ev_matrix')-hand_key);
  node_raw:=jsonb_set(node_raw,'{cell_payload_checksum}',
    to_jsonb(public.fn_gto_v31_cell_payload_checksum(node_raw)));
  IF public.fn_gto_v31_cell_payload_valid(node_raw) THEN
    RAISE EXCEPTION 'a compact cell missing one policy EV was accepted';
  END IF;
  node_raw:=jsonb_set(forged,ARRAY['action_ev_matrix',hand_key],
    ((forged->'action_ev_matrix')->hand_key)-action_key);
  node_raw:=jsonb_set(node_raw,'{cell_payload_checksum}',
    to_jsonb(public.fn_gto_v31_cell_payload_checksum(node_raw)));
  IF public.fn_gto_v31_cell_payload_valid(node_raw) THEN
    RAISE EXCEPTION 'a compact cell missing one action EV was accepted';
  END IF;

  -- Prove the release gate rejects a corpus whose sizing score is merely the
  -- COALESCE(…, 0) of no measured non-all-in sizes. The temporary wrapper is
  -- transaction-local because this entire behavior probe rolls back.
  EXECUTE 'ALTER FUNCTION public.fn_gto_v31_heldout_metrics(uuid,text) RENAME TO fn_gto_v31_heldout_metrics_probe_real';
  EXECUTE $ddl$
    CREATE FUNCTION public.fn_gto_v31_heldout_metrics(
      p_dataset_id uuid,
      p_game_family text DEFAULT NULL
    ) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $mock$
      SELECT public.fn_gto_v31_heldout_metrics_probe_real($1,$2)
        || jsonb_build_object('sizing_observations',0)
    $mock$
  $ddl$;
  failed:=false;
  BEGIN
    PERFORM public.fn_gto_v31_seal_build(dataset);
  EXCEPTION WHEN OTHERS THEN
    failed:=true;
  END;
  IF NOT failed OR (SELECT state FROM public.gto_v31_datasets WHERE dataset_id=dataset)<>'building' THEN
    RAISE EXCEPTION 'a dataset with no measured sizing evidence was sealed';
  END IF;
  EXECUTE 'DROP FUNCTION public.fn_gto_v31_heldout_metrics(uuid,text)';
  EXECUTE 'ALTER FUNCTION public.fn_gto_v31_heldout_metrics_probe_real(uuid,text) RENAME TO fn_gto_v31_heldout_metrics';

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
