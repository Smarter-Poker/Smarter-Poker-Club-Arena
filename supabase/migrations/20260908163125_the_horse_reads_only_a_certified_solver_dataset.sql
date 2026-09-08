-- ==========================================================================
-- THE HORSE READS ONLY A CERTIFIED SOLVER DATASET
--
-- The legacy V31 compact table has no provenance and cannot distinguish an
-- open node from a response node. This creates a separate fail-closed release
-- path. A dataset must prove every source row against solved_spots_gold,
-- retain a deterministic train/holdout split, pass held-out frequency, size
-- and EV/regret gates, and tie or beat the incumbent in paired replay and the
-- league before it can become the single active runtime dataset.
-- ==========================================================================

BEGIN;

-- These nullable provenance columns already exist on production from the
-- strict-cache repair. Keep their declaration in the repository so a fresh
-- database can build the certified path without relying on unrecorded DDL.
ALTER TABLE public.solved_spots_gold
  ADD COLUMN IF NOT EXISTS solver_version text,
  ADD COLUMN IF NOT EXISTS solver_binary_checksum text,
  ADD COLUMN IF NOT EXISTS machine_id text,
  ADD COLUMN IF NOT EXISTS pipeline_commit text,
  ADD COLUMN IF NOT EXISTS pipeline_bundle_checksum text,
  ADD COLUMN IF NOT EXISTS manifest_version text,
  ADD COLUMN IF NOT EXISTS manifest_checksum text,
  ADD COLUMN IF NOT EXISTS source_artifact_checksum text,
  ADD COLUMN IF NOT EXISTS quality_status text,
  ADD COLUMN IF NOT EXISTS audited_at timestamptz;

CREATE TABLE IF NOT EXISTS public.gto_v31_input_bundles (
  input_bundle_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_key                    text NOT NULL UNIQUE CHECK (bundle_key ~ '^[a-z0-9][a-z0-9._:-]{2,127}$'),
  bundle_checksum               text NOT NULL UNIQUE CHECK (bundle_checksum ~ '^[0-9a-f]{64}$' AND bundle_checksum <> repeat('0',64)),
  range_bundle_checksum         text NOT NULL CHECK (range_bundle_checksum ~ '^[0-9a-f]{64}$' AND range_bundle_checksum <> repeat('0',64)),
  source_combo_order_checksum   text NOT NULL CHECK (source_combo_order_checksum ~ '^[0-9a-f]{64}$' AND source_combo_order_checksum <> repeat('0',64)),
  icm_model_checksum            text NOT NULL CHECK (icm_model_checksum ~ '^[0-9a-f]{64}$' AND icm_model_checksum <> repeat('0',64)),
  bundle_manifest               jsonb NOT NULL CHECK (jsonb_typeof(bundle_manifest) = 'object'),
  approval_status               text NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('approved','revoked')),
  approved_by                   uuid,
  approved_at                   timestamptz NOT NULL DEFAULT now(),
  revoked_by                    uuid,
  revoked_at                    timestamptz,
  revocation_reason             text,
  CHECK ((approval_status='approved' AND revoked_at IS NULL AND revoked_by IS NULL) OR
         (approval_status='revoked' AND revoked_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS public.gto_v31_datasets (
  dataset_id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_key                   text NOT NULL UNIQUE,
  state                         text NOT NULL DEFAULT 'building'
                                CHECK (state IN ('building','evaluating','candidate','active','rejected','retired')),
  quality_status                text NOT NULL DEFAULT 'building'
                                CHECK (quality_status IN ('building','validated','rejected')),
  solver_version                text NOT NULL,
  solver_binary_checksum        text NOT NULL CHECK (solver_binary_checksum ~ '^[0-9a-f]{64}$' AND solver_binary_checksum <> repeat('0',64)),
  pipeline_commit               text NOT NULL CHECK (pipeline_commit ~ '^[0-9a-f]{40}$'),
  pipeline_bundle_checksum      text NOT NULL CHECK (pipeline_bundle_checksum ~ '^[0-9a-f]{64}$' AND pipeline_bundle_checksum <> repeat('0',64)),
  manifest_version              text NOT NULL,
  manifest_checksum             text NOT NULL CHECK (manifest_checksum ~ '^[0-9a-f]{64}$' AND manifest_checksum <> repeat('0',64)),
  source_combo_order_checksum   text NOT NULL CHECK (source_combo_order_checksum ~ '^[0-9a-f]{64}$' AND source_combo_order_checksum <> repeat('0',64)),
  range_bundle_checksum         text NOT NULL CHECK (range_bundle_checksum ~ '^[0-9a-f]{64}$' AND range_bundle_checksum <> repeat('0',64)),
  icm_model_checksum            text NOT NULL CHECK (icm_model_checksum ~ '^[0-9a-f]{64}$' AND icm_model_checksum <> repeat('0',64)),
  input_bundle_id               uuid NOT NULL REFERENCES public.gto_v31_input_bundles(input_bundle_id),
  input_bundle_checksum         text NOT NULL CHECK (input_bundle_checksum ~ '^[0-9a-f]{64}$' AND input_bundle_checksum <> repeat('0',64)),
  machine_ids                   text[] NOT NULL,
  declared_coverage             jsonb NOT NULL CHECK (jsonb_typeof(declared_coverage) = 'array' AND jsonb_array_length(declared_coverage) > 0),
  quality_gates                 jsonb NOT NULL CHECK (jsonb_typeof(quality_gates) = 'object'),
  source_rows                   bigint NOT NULL DEFAULT 0 CHECK (source_rows >= 0),
  train_source_rows             bigint NOT NULL DEFAULT 0 CHECK (train_source_rows >= 0),
  holdout_source_rows           bigint NOT NULL DEFAULT 0 CHECK (holdout_source_rows >= 0),
  invalid_rows                  bigint NOT NULL DEFAULT 0 CHECK (invalid_rows >= 0),
  source_artifact_checksum      text CHECK (source_artifact_checksum IS NULL OR source_artifact_checksum ~ '^[0-9a-f]{64}$'),
  dataset_checksum              text CHECK (dataset_checksum IS NULL OR dataset_checksum ~ '^[0-9a-f]{64}$'),
  coverage                      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(coverage) = 'object'),
  heldout_metrics               jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(heldout_metrics) = 'object'),
  paired_replay                 jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(paired_replay) = 'object'),
  league_gate                   jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(league_gate) = 'object'),
  created_at                    timestamptz NOT NULL DEFAULT now(),
  sealed_at                     timestamptz,
  candidate_at                  timestamptz,
  audited_at                    timestamptz,
  promoted_at                   timestamptz,
  retired_at                    timestamptz,
  CHECK ('M1' = ANY(machine_ids) AND 'M2' = ANY(machine_ids))
);

CREATE UNIQUE INDEX IF NOT EXISTS gto_v31_one_active_dataset
  ON public.gto_v31_datasets ((state)) WHERE state = 'active';

CREATE TABLE IF NOT EXISTS public.gto_v31_runtime_cells (
  cell_id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id                    uuid NOT NULL REFERENCES public.gto_v31_datasets(dataset_id) ON DELETE CASCADE,
  cell_key_checksum             text NOT NULL CHECK (cell_key_checksum ~ '^[0-9a-f]{64}$' AND cell_key_checksum <> repeat('0',64)),
  street                        text NOT NULL CHECK (street IN ('flop','turn','river')),
  game_family                   text NOT NULL CHECK (game_family IN ('cash','spin','tourney_ev','tourney_icm')),
  objective                     text NOT NULL CHECK (objective IN ('cash_ev','chip_ev','icm')),
  utility_context               text NOT NULL CHECK (utility_context IN ('cash_ev','chip_ev','spin_ladder','satellite','bubble','final_table','in_money','ladder')),
  table_size                    smallint NOT NULL CHECK (table_size BETWEEN 2 AND 10),
  pot_type                      text NOT NULL CHECK (pot_type IN ('limped','srp','3bet','4bet_plus')),
  hero_position                 text NOT NULL CHECK (hero_position IN ('UTG','UTG1','UTG2','UTG3','MP','HJ','CO','BTN','SB','BB')),
  opponent_position             text NOT NULL CHECK (opponent_position IN ('UTG','UTG1','UTG2','UTG3','MP','HJ','CO','BTN','SB','BB') AND opponent_position <> hero_position),
  depth_bucket                  integer NOT NULL CHECK (depth_bucket IN (10,20,40,80,150)),
  texture_class                 text NOT NULL CHECK (texture_class ~ '^[ABML][mtr][pu][cd]$'),
  node_role                     text NOT NULL CHECK (node_role IN ('open','cbet','probe','delayed_cbet','barrel','facing_bet','facing_raise','check_raise','bet_raise','all_in')),
  facing_kind                   text NOT NULL CHECK (facing_kind IN ('none','bet','raise','all_in')),
  facing_size_bucket            text NOT NULL CHECK (facing_size_bucket IN ('none','small','mid','big','all_in')),
  hand_matrix                   jsonb NOT NULL CHECK (jsonb_typeof(hand_matrix) = 'object'),
  action_specs                  jsonb NOT NULL CHECK (jsonb_typeof(action_specs) = 'object'),
  policy_ev_matrix              jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(policy_ev_matrix) = 'object'),
  action_ev_matrix              jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(action_ev_matrix) = 'object'),
  source_rows                   integer NOT NULL CHECK (source_rows > 0),
  train_source_rows             integer NOT NULL CHECK (train_source_rows > 0),
  holdout_source_rows           integer NOT NULL CHECK (holdout_source_rows > 0),
  cell_payload_checksum         text NOT NULL CHECK (cell_payload_checksum ~ '^[0-9a-f]{64}$' AND cell_payload_checksum <> repeat('0',64)),
  lineage_checksum              text NOT NULL CHECK (lineage_checksum ~ '^[0-9a-f]{64}$' AND lineage_checksum <> repeat('0',64)),
  built_at                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, cell_key_checksum),
  UNIQUE (dataset_id, street, game_family, objective, utility_context, table_size,
          pot_type, hero_position, opponent_position, depth_bucket, texture_class,
          node_role, facing_kind, facing_size_bucket),
  CHECK (source_rows = train_source_rows + holdout_source_rows),
  CHECK ((game_family = 'cash' AND objective = 'cash_ev') OR
         (game_family = 'tourney_icm' AND objective = 'icm') OR
         (game_family = 'tourney_ev' AND objective = 'chip_ev') OR
         (game_family = 'spin' AND objective IN ('chip_ev','icm'))),
  CHECK ((objective = 'cash_ev' AND utility_context = 'cash_ev') OR
         (objective = 'chip_ev' AND utility_context = 'chip_ev') OR
         (objective = 'icm' AND game_family = 'spin' AND utility_context = 'spin_ladder') OR
         (objective = 'icm' AND game_family = 'tourney_icm' AND
          utility_context IN ('satellite','bubble','final_table','in_money','ladder'))),
  CHECK ((node_role IN ('open','cbet','probe','delayed_cbet','barrel') AND facing_kind = 'none' AND facing_size_bucket = 'none') OR
         (node_role = 'all_in' AND facing_kind = 'all_in' AND facing_size_bucket = 'all_in') OR
         (node_role = 'facing_bet' AND facing_kind = 'bet' AND facing_size_bucket IN ('small','mid','big')) OR
         (node_role IN ('facing_raise','check_raise','bet_raise') AND facing_kind = 'raise' AND facing_size_bucket IN ('small','mid','big')))
);

CREATE INDEX IF NOT EXISTS gto_v31_runtime_cells_dataset_order
  ON public.gto_v31_runtime_cells
  (dataset_id, street, game_family, objective, utility_context, table_size,
   pot_type, hero_position, opponent_position, depth_bucket, texture_class,
   node_role, facing_kind, facing_size_bucket);

CREATE TABLE IF NOT EXISTS public.gto_v31_cell_source_receipts (
  dataset_id                    uuid NOT NULL REFERENCES public.gto_v31_datasets(dataset_id) ON DELETE CASCADE,
  cell_id                       uuid NOT NULL REFERENCES public.gto_v31_runtime_cells(cell_id) ON DELETE CASCADE,
  source_row_id                 uuid NOT NULL,
  source_node                   text NOT NULL,
  source_node_checksum          text NOT NULL CHECK (source_node_checksum ~ '^[0-9a-f]{64}$' AND source_node_checksum <> repeat('0',64)),
  source_artifact_checksum      text NOT NULL CHECK (source_artifact_checksum ~ '^[0-9a-f]{64}$' AND source_artifact_checksum <> repeat('0',64)),
  machine_id                    text NOT NULL CHECK (machine_id IN ('M1','M2')),
  split                         text NOT NULL CHECK (split IN ('train','holdout')),
  verified_at                   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cell_id, source_row_id, source_node),
  UNIQUE (dataset_id, source_row_id, source_node)
);

CREATE TABLE IF NOT EXISTS public.gto_v31_source_artifacts (
  dataset_id                    uuid NOT NULL REFERENCES public.gto_v31_datasets(dataset_id) ON DELETE CASCADE,
  source_row_id                 uuid NOT NULL,
  machine_id                    text NOT NULL CHECK (machine_id IN ('M1','M2')),
  scenario_hash                 text NOT NULL CHECK (length(scenario_hash) BETWEEN 8 AND 512),
  game_family                   text NOT NULL CHECK (game_family IN ('cash','spin','tourney_ev','tourney_icm')),
  stack_depth                   integer NOT NULL CHECK (stack_depth IN (10,20,40,80,150)),
  street                        text NOT NULL CHECK (street IN ('flop','turn','river')),
  source_artifact_checksum      text NOT NULL CHECK (source_artifact_checksum ~ '^[0-9a-f]{64}$' AND source_artifact_checksum <> repeat('0',64)),
  node_count                    integer NOT NULL CHECK (node_count > 0 AND node_count <= 512),
  solved_at                     timestamptz NOT NULL,
  ingested_at                   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dataset_id, source_row_id),
  UNIQUE (dataset_id, scenario_hash, machine_id)
);

ALTER TABLE public.horse_league_results
  ADD COLUMN IF NOT EXISTS truncated_streets integer NOT NULL DEFAULT 0
    CHECK (truncated_streets >= 0),
  ADD COLUMN IF NOT EXISTS candidate_policy_hits integer NOT NULL DEFAULT 0
    CHECK (candidate_policy_hits >= 0),
  ADD COLUMN IF NOT EXISTS candidate_node_roles text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS candidate_benchmark_components jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(candidate_benchmark_components)='array');

CREATE TABLE IF NOT EXISTS public.gto_v31_release_evaluations (
  evaluation_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id                    uuid NOT NULL REFERENCES public.gto_v31_datasets(dataset_id) ON DELETE CASCADE,
  dataset_checksum              text NOT NULL CHECK (dataset_checksum ~ '^[0-9a-f]{64}$' AND dataset_checksum <> repeat('0',64)),
  evaluation_kind               text NOT NULL CHECK (evaluation_kind IN ('heldout','paired_replay','league')),
  game_family                   text NOT NULL CHECK (game_family IN ('all','cash','spin','tourney_ev','tourney_icm')),
  verdict                       text NOT NULL CHECK (verdict IN ('win','tie','loss','pass','fail')),
  metrics                       jsonb NOT NULL CHECK (jsonb_typeof(metrics)='object'),
  source_result_id              bigint REFERENCES public.horse_league_results(id),
  result_checksum               text NOT NULL CHECK (result_checksum ~ '^[0-9a-f]{64}$' AND result_checksum <> repeat('0',64)),
  evaluated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dataset_id,evaluation_kind,game_family),
  CHECK ((evaluation_kind='heldout' AND game_family='all' AND source_result_id IS NULL AND verdict IN ('pass','fail')) OR
         (evaluation_kind IN ('paired_replay','league') AND game_family<>'all' AND
          source_result_id IS NOT NULL AND verdict IN ('win','tie','loss')))
);

CREATE INDEX IF NOT EXISTS gto_v31_source_receipts_dataset
  ON public.gto_v31_cell_source_receipts(dataset_id, split, source_row_id);

ALTER TABLE public.gto_v31_input_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gto_v31_datasets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gto_v31_runtime_cells ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gto_v31_cell_source_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gto_v31_source_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gto_v31_release_evaluations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.gto_v31_input_bundles FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.gto_v31_datasets FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.gto_v31_runtime_cells FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.gto_v31_cell_source_receipts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.gto_v31_source_artifacts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.gto_v31_release_evaluations FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_json_checksum(p_payload jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public, extensions
AS $fn$
  SELECT encode(digest(convert_to(p_payload::text, 'UTF8'), 'sha256'), 'hex');
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_json_checksum(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_json_checksum(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_source_artifact_checksum(
  p_scenario_hash text,
  p_strategy_matrix_v2 jsonb
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public, extensions
AS $fn$
  SELECT encode(digest(convert_to(
    public.fn_training_canonical_jsonb_text_v1(jsonb_build_object(
      'scenario_hash',p_scenario_hash,
      'strategy_matrix_v2',p_strategy_matrix_v2
    )),
    'UTF8'
  ),'sha256'),'hex');
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_source_artifact_checksum(text,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_source_artifact_checksum(text,jsonb)
  TO service_role;

CREATE OR REPLACE FUNCTION public.ca_gto_v31_approve_input_bundle(p_bundle jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_id uuid;
  v_checksum text;
  v_actor uuid := auth.uid();
  v_file jsonb;
BEGIN
  IF COALESCE(auth.role(),'') <> 'authenticated' OR v_actor IS NULL OR NOT public.fn_is_horse_admin() THEN
    RAISE EXCEPTION 'admin approval required';
  END IF;
  IF p_bundle IS NULL OR jsonb_typeof(p_bundle) <> 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_bundle)) <> 7
     OR NOT (p_bundle ?& ARRAY['bundle_key','bundle_version','range_bundle_checksum',
       'source_combo_order_checksum','icm_model_checksum','files','approval_note'])
     OR COALESCE(p_bundle->>'bundle_key','') !~ '^[a-z0-9][a-z0-9._:-]{2,127}$'
     OR COALESCE(p_bundle->>'bundle_version','') = ''
     OR COALESCE(p_bundle->>'range_bundle_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_bundle->>'range_bundle_checksum' = repeat('0',64)
     OR COALESCE(p_bundle->>'source_combo_order_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_bundle->>'source_combo_order_checksum' = repeat('0',64)
     OR COALESCE(p_bundle->>'icm_model_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_bundle->>'icm_model_checksum' = repeat('0',64)
     OR jsonb_typeof(p_bundle->'files') <> 'array'
     OR jsonb_array_length(p_bundle->'files') = 0
     OR nullif(btrim(p_bundle->>'approval_note'),'') IS NULL THEN
    RAISE EXCEPTION 'approved input bundle is incomplete';
  END IF;
  FOR v_file IN SELECT value FROM jsonb_array_elements(p_bundle->'files') LOOP
    IF jsonb_typeof(v_file) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(v_file)) <> 3
       OR NOT (v_file ?& ARRAY['kind','path','checksum'])
       OR v_file->>'kind' NOT IN ('range','combo_order','icm_model','payout_model','scenario_manifest')
       OR COALESCE(v_file->>'path','') !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{1,255}$'
       OR position('..' IN v_file->>'path') > 0
       OR COALESCE(v_file->>'checksum','') !~ '^[0-9a-f]{64}$'
       OR v_file->>'checksum' = repeat('0',64) THEN
      RAISE EXCEPTION 'approved input bundle contains an invalid file receipt';
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT value->>'path') FROM jsonb_array_elements(p_bundle->'files'))
       <> jsonb_array_length(p_bundle->'files')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_bundle->'files') f(value)
       WHERE f.value->>'kind'='range' AND
             f.value->>'checksum'=p_bundle->>'range_bundle_checksum')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_bundle->'files') f(value)
       WHERE f.value->>'kind'='combo_order' AND
             f.value->>'checksum'=p_bundle->>'source_combo_order_checksum')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_bundle->'files') f(value)
       WHERE f.value->>'kind'='icm_model' AND
             f.value->>'checksum'=p_bundle->>'icm_model_checksum')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_bundle->'files') f(value)
       WHERE f.value->>'kind'='scenario_manifest') THEN
    RAISE EXCEPTION 'approved input bundle does not reconcile its files';
  END IF;

  v_checksum := public.fn_gto_v31_json_checksum(p_bundle);
  INSERT INTO public.gto_v31_input_bundles (
    bundle_key,bundle_checksum,range_bundle_checksum,source_combo_order_checksum,
    icm_model_checksum,bundle_manifest,approved_by
  ) VALUES (
    p_bundle->>'bundle_key',v_checksum,p_bundle->>'range_bundle_checksum',
    p_bundle->>'source_combo_order_checksum',p_bundle->>'icm_model_checksum',p_bundle,v_actor
  ) RETURNING input_bundle_id INTO v_id;
  RETURN v_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_gto_v31_approve_input_bundle(jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.ca_gto_v31_approve_input_bundle(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.ca_gto_v31_revoke_input_bundle(
  p_input_bundle_id uuid,
  p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_actor uuid := auth.uid();
BEGIN
  IF COALESCE(auth.role(),'') <> 'authenticated' OR v_actor IS NULL OR NOT public.fn_is_horse_admin() THEN
    RAISE EXCEPTION 'admin approval required';
  END IF;
  IF nullif(btrim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'revocation reason required'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.gto_v31_datasets
     WHERE input_bundle_id=p_input_bundle_id AND state IN ('evaluating','candidate','active')
  ) THEN
    RAISE EXCEPTION 'retire dependent solver datasets before revoking their inputs';
  END IF;
  UPDATE public.gto_v31_input_bundles SET approval_status='revoked',revoked_by=v_actor,
    revoked_at=now(),revocation_reason=btrim(p_reason)
   WHERE input_bundle_id=p_input_bundle_id AND approval_status='approved';
  RETURN FOUND;
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_gto_v31_revoke_input_bundle(uuid,text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.ca_gto_v31_revoke_input_bundle(uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_node_checksum(p_node jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public, extensions
AS $fn$
  SELECT public.fn_gto_v31_json_checksum(p_node - 'node_checksum');
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_node_checksum(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_node_checksum(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_cell_key_checksum(p_cell jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $fn$
  SELECT public.fn_gto_v31_json_checksum(jsonb_build_object(
    'street',p_cell->'street',
    'game_family',p_cell->'game_family',
    'objective',p_cell->'objective',
    'utility_context',p_cell->'utility_context',
    'table_size',p_cell->'table_size',
    'pot_type',p_cell->'pot_type',
    'hero_position',p_cell->'hero_position',
    'opponent_position',p_cell->'opponent_position',
    'depth_bucket',p_cell->'depth_bucket',
    'texture_class',p_cell->'texture_class',
    'node_role',p_cell->'node_role',
    'facing_kind',p_cell->'facing_kind',
    'facing_size_bucket',p_cell->'facing_size_bucket'
  ));
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_cell_key_checksum(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_cell_key_checksum(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_cell_payload_checksum(p_cell jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $fn$
  SELECT public.fn_gto_v31_json_checksum(jsonb_build_object(
    'cell_key_checksum',public.fn_gto_v31_cell_key_checksum(p_cell),
    'hand_matrix',p_cell->'hand_matrix',
    'action_specs',p_cell->'action_specs',
    'policy_ev_matrix',COALESCE(p_cell->'policy_ev_matrix','{}'::jsonb),
    'action_ev_matrix',COALESCE(p_cell->'action_ev_matrix','{}'::jsonb),
    'source_rows',p_cell->'source_rows',
    'train_source_rows',p_cell->'train_source_rows',
    'holdout_source_rows',p_cell->'holdout_source_rows'
  ));
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_cell_payload_checksum(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_cell_payload_checksum(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_cell_payload_valid(p_cell jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  v_role text := p_cell->>'node_role';
  v_facing text := p_cell->>'facing_kind';
  v_bucket text := p_cell->>'facing_size_bucket';
  v_action record;
  v_hand record;
  v_frequency record;
  v_sum numeric;
  v_family text;
  v_unit text;
  v_size numeric;
  v_actions jsonb := p_cell->'action_specs';
  v_matrix jsonb := p_cell->'hand_matrix';
  v_policy_evs jsonb := COALESCE(p_cell->'policy_ev_matrix', '{}'::jsonb);
  v_action_evs jsonb := COALESCE(p_cell->'action_ev_matrix', '{}'::jsonb);
  v_has_check boolean := false;
  v_has_fold boolean := false;
  v_has_call boolean := false;
  v_has_bet boolean := false;
  v_has_raise boolean := false;
  v_has_all_in boolean := false;
  v_table_size integer := COALESCE((p_cell->>'table_size')::integer,0);
  v_allowed_positions text[];
BEGIN
  IF p_cell IS NULL OR jsonb_typeof(p_cell) <> 'object'
     OR COALESCE(p_cell->>'cell_key_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_cell->>'cell_key_checksum' = repeat('0',64)
     OR p_cell->>'cell_key_checksum' IS DISTINCT FROM public.fn_gto_v31_cell_key_checksum(p_cell)
     OR COALESCE(p_cell->>'cell_payload_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_cell->>'cell_payload_checksum' = repeat('0',64)
     OR p_cell->>'cell_payload_checksum' IS DISTINCT FROM public.fn_gto_v31_cell_payload_checksum(p_cell)
     OR COALESCE(p_cell->>'lineage_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_cell->>'lineage_checksum' = repeat('0',64)
     OR COALESCE(p_cell->>'street','') NOT IN ('flop','turn','river')
     OR COALESCE(p_cell->>'game_family','') NOT IN ('cash','spin','tourney_ev','tourney_icm')
     OR COALESCE(p_cell->>'objective','') NOT IN ('cash_ev','chip_ev','icm')
     OR COALESCE(p_cell->>'utility_context','') NOT IN ('cash_ev','chip_ev','spin_ladder','satellite','bubble','final_table','in_money','ladder')
     OR v_table_size NOT BETWEEN 2 AND 10
     OR COALESCE(p_cell->>'pot_type','') NOT IN ('limped','srp','3bet','4bet_plus')
     OR COALESCE(p_cell->>'hero_position','') NOT IN ('UTG','UTG1','UTG2','UTG3','MP','HJ','CO','BTN','SB','BB')
     OR COALESCE(p_cell->>'opponent_position','') NOT IN ('UTG','UTG1','UTG2','UTG3','MP','HJ','CO','BTN','SB','BB')
     OR p_cell->>'hero_position' = p_cell->>'opponent_position'
     OR COALESCE((p_cell->>'depth_bucket')::integer,0) NOT IN (10,20,40,80,150)
     OR COALESCE(p_cell->>'texture_class','') !~ '^[ABML][mtr][pu][cd]$'
     OR COALESCE(v_role,'') NOT IN ('open','cbet','probe','delayed_cbet','barrel','facing_bet','facing_raise','check_raise','bet_raise','all_in')
     OR COALESCE(v_facing,'') NOT IN ('none','bet','raise','all_in')
     OR COALESCE(v_bucket,'') NOT IN ('none','small','mid','big','all_in')
     OR jsonb_typeof(v_actions) <> 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(v_actions)) < 2
     OR jsonb_typeof(v_matrix) <> 'object'
     OR NOT EXISTS (SELECT 1 FROM jsonb_object_keys(v_matrix))
     OR jsonb_typeof(v_policy_evs) <> 'object'
     OR jsonb_typeof(v_action_evs) <> 'object'
     OR COALESCE((p_cell->>'source_rows')::integer,0) <= 0
     OR COALESCE((p_cell->>'train_source_rows')::integer,0) <= 0
     OR COALESCE((p_cell->>'holdout_source_rows')::integer,0) <= 0 THEN
    RETURN false;
  END IF;

  IF NOT ((p_cell->>'game_family' = 'cash' AND p_cell->>'objective' = 'cash_ev') OR
          (p_cell->>'game_family' = 'tourney_icm' AND p_cell->>'objective' = 'icm') OR
          (p_cell->>'game_family' = 'tourney_ev' AND p_cell->>'objective' = 'chip_ev') OR
          (p_cell->>'game_family' = 'spin' AND p_cell->>'objective' IN ('chip_ev','icm'))) THEN
    RETURN false;
  END IF;
  IF NOT ((p_cell->>'objective' = 'cash_ev' AND p_cell->>'utility_context' = 'cash_ev') OR
          (p_cell->>'objective' = 'chip_ev' AND p_cell->>'utility_context' = 'chip_ev') OR
          (p_cell->>'objective' = 'icm' AND p_cell->>'game_family' = 'spin' AND
           p_cell->>'utility_context' = 'spin_ladder') OR
          (p_cell->>'objective' = 'icm' AND p_cell->>'game_family' = 'tourney_icm' AND
           p_cell->>'utility_context' IN ('satellite','bubble','final_table','in_money','ladder'))) THEN
    RETURN false;
  END IF;

  v_allowed_positions := CASE v_table_size
    WHEN 2 THEN ARRAY['SB','BB']
    WHEN 3 THEN ARRAY['SB','BB','BTN']
    WHEN 4 THEN ARRAY['SB','BB','CO','BTN']
    WHEN 5 THEN ARRAY['SB','BB','HJ','CO','BTN']
    WHEN 6 THEN ARRAY['SB','BB','UTG','HJ','CO','BTN']
    WHEN 7 THEN ARRAY['SB','BB','UTG','MP','HJ','CO','BTN']
    WHEN 8 THEN ARRAY['SB','BB','UTG','UTG1','MP','HJ','CO','BTN']
    WHEN 9 THEN ARRAY['SB','BB','UTG','UTG1','UTG2','MP','HJ','CO','BTN']
    WHEN 10 THEN ARRAY['SB','BB','UTG','UTG1','UTG2','UTG3','MP','HJ','CO','BTN']
  END;
  IF NOT (p_cell->>'hero_position' = ANY(v_allowed_positions))
     OR NOT (p_cell->>'opponent_position' = ANY(v_allowed_positions)) THEN
    RETURN false;
  END IF;

  IF v_role IN ('open','cbet','probe','delayed_cbet','barrel') THEN
    IF v_facing <> 'none' OR v_bucket <> 'none' THEN RETURN false; END IF;
  ELSIF v_role = 'all_in' THEN
    IF v_facing <> 'all_in' OR v_bucket <> 'all_in' THEN RETURN false; END IF;
  ELSIF (v_role = 'facing_bet' AND v_facing <> 'bet')
     OR (v_role IN ('facing_raise','check_raise','bet_raise') AND v_facing <> 'raise')
     OR v_bucket NOT IN ('small','mid','big') THEN
    RETURN false;
  END IF;

  FOR v_action IN SELECT key, value FROM jsonb_each(v_actions) LOOP
    IF v_action.key = '' OR jsonb_typeof(v_action.value) <> 'object' THEN RETURN false; END IF;
    v_family := v_action.value->>'family';
    v_unit := v_action.value->>'size_unit';
    IF v_family NOT IN ('check','fold','call','bet','raise','all_in') THEN RETURN false; END IF;
    IF v_family = 'check' THEN v_has_check := true; END IF;
    IF v_family = 'fold' THEN v_has_fold := true; END IF;
    IF v_family = 'call' THEN v_has_call := true; END IF;
    IF v_family = 'bet' THEN v_has_bet := true; END IF;
    IF v_family = 'raise' THEN v_has_raise := true; END IF;
    IF v_family = 'all_in' THEN v_has_all_in := true; END IF;
    IF v_family IN ('check','fold','call') THEN
      IF v_unit IS DISTINCT FROM 'none'
         OR v_action.value->'size_value' IS DISTINCT FROM 'null'::jsonb
         OR (v_action.value->>'all_in')::boolean IS DISTINCT FROM false THEN RETURN false; END IF;
    ELSIF v_family = 'all_in' THEN
      IF v_unit IS DISTINCT FROM 'all_in'
         OR v_action.value->'size_value' IS DISTINCT FROM 'null'::jsonb
         OR (v_action.value->>'all_in')::boolean IS DISTINCT FROM true THEN RETURN false; END IF;
    ELSE
      BEGIN v_size := (v_action.value->>'size_value')::numeric; EXCEPTION WHEN OTHERS THEN RETURN false; END;
      IF v_size <= 0 OR v_size > 20 OR COALESCE((v_action.value->>'all_in')::boolean,false)
         OR (v_family = 'bet' AND v_unit <> 'pot_fraction')
         OR (v_family = 'raise' AND v_unit <> 'pot_after_call_fraction') THEN RETURN false; END IF;
    END IF;
  END LOOP;

  IF v_role IN ('open','cbet','probe','delayed_cbet','barrel') THEN
    IF NOT v_has_check OR v_has_fold OR v_has_call THEN RETURN false; END IF;
  ELSE
    IF NOT v_has_fold OR NOT v_has_call OR v_has_check OR v_has_bet THEN RETURN false; END IF;
    IF v_role = 'all_in' AND (v_has_raise OR v_has_all_in) THEN RETURN false; END IF;
  END IF;

  FOR v_hand IN SELECT key, value FROM jsonb_each(v_matrix) LOOP
    IF v_hand.key !~ '^[AKQJT98765432]{2}(s|o)?:[0-2]$'
       OR jsonb_typeof(v_hand.value) <> 'object'
       OR NOT EXISTS (SELECT 1 FROM jsonb_object_keys(v_hand.value)) THEN
      RETURN false;
    END IF;
    v_sum := 0;
    FOR v_frequency IN SELECT key, value FROM jsonb_each(v_hand.value) LOOP
      IF NOT (v_actions ? v_frequency.key) OR jsonb_typeof(v_frequency.value) <> 'number' THEN RETURN false; END IF;
      BEGIN v_size := (v_frequency.value #>> '{}')::numeric; EXCEPTION WHEN OTHERS THEN RETURN false; END;
      IF v_size < 0 OR v_size > 1 THEN RETURN false; END IF;
      v_sum := v_sum + v_size;
    END LOOP;
    IF abs(v_sum - 1) > 0.002 THEN RETURN false; END IF;

    IF v_policy_evs ? v_hand.key
       AND jsonb_typeof(v_policy_evs -> (v_hand.key)) NOT IN ('number','null') THEN
      RETURN false;
    END IF;
    IF v_action_evs ? v_hand.key THEN
      IF jsonb_typeof(v_action_evs -> (v_hand.key)) <> 'object' THEN RETURN false; END IF;
      FOR v_frequency IN SELECT key, value FROM jsonb_each(v_action_evs -> (v_hand.key)) LOOP
        IF NOT (v_actions ? v_frequency.key)
           OR jsonb_typeof(v_frequency.value) NOT IN ('number','null') THEN
          RETURN false;
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  IF EXISTS (
       SELECT 1 FROM jsonb_object_keys(v_policy_evs) AS k(value) WHERE NOT (v_matrix ? k.value)
     ) OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(v_action_evs) AS k(value) WHERE NOT (v_matrix ? k.value)
     ) THEN
    RETURN false;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_cell_payload_valid(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_cell_payload_valid(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_register_dataset(p_dataset jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_id uuid;
  v_machines text[];
  v_gates jsonb := p_dataset->'quality_gates';
  v_bundle public.gto_v31_input_bundles%ROWTYPE;
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  IF p_dataset IS NULL OR jsonb_typeof(p_dataset) <> 'object'
     OR jsonb_typeof(p_dataset->'machine_ids') <> 'array'
     OR jsonb_typeof(p_dataset->'declared_coverage') <> 'array'
     OR jsonb_typeof(v_gates) <> 'object' THEN
    RAISE EXCEPTION 'invalid certified dataset declaration';
  END IF;
  SELECT array_agg(value ORDER BY value) INTO v_machines
    FROM jsonb_array_elements_text(p_dataset->'machine_ids');
  IF COALESCE(p_dataset->>'dataset_key','') !~ '^[a-z0-9][a-z0-9._:-]{2,127}$'
     OR COALESCE(p_dataset->>'solver_version','') = ''
     OR COALESCE(p_dataset->>'solver_binary_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_dataset->>'solver_binary_checksum' = repeat('0',64)
     OR COALESCE(p_dataset->>'pipeline_commit','') !~ '^[0-9a-f]{40}$'
     OR COALESCE(p_dataset->>'pipeline_bundle_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_dataset->>'pipeline_bundle_checksum' = repeat('0',64)
     OR COALESCE(p_dataset->>'manifest_version','') = ''
     OR COALESCE(p_dataset->>'manifest_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_dataset->>'manifest_checksum' = repeat('0',64)
     OR COALESCE(p_dataset->>'source_combo_order_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_dataset->>'source_combo_order_checksum' = repeat('0',64)
     OR COALESCE(p_dataset->>'range_bundle_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_dataset->>'range_bundle_checksum' = repeat('0',64)
     OR COALESCE(p_dataset->>'icm_model_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_dataset->>'icm_model_checksum' = repeat('0',64)
     OR COALESCE(p_dataset->>'input_bundle_id','') !~ '^[0-9a-fA-F-]{36}$'
     OR COALESCE(p_dataset->>'input_bundle_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_dataset->>'input_bundle_checksum' = repeat('0',64)
     OR v_machines IS DISTINCT FROM ARRAY['M1','M2']::text[]
     OR jsonb_array_length(p_dataset->'declared_coverage') = 0
     OR COALESCE((v_gates->>'max_frequency_mae')::numeric, 99) NOT BETWEEN 0 AND 0.15
     OR COALESCE((v_gates->>'max_sizing_mae')::numeric, 99) NOT BETWEEN 0 AND 0.25
     OR COALESCE((v_gates->>'max_policy_ev_mae_bb')::numeric, 99) NOT BETWEEN 0 AND 0.50
     OR COALESCE((v_gates->>'max_action_regret_bb')::numeric, 99) NOT BETWEEN 0 AND 0.25
     OR COALESCE((v_gates->>'min_regret_coverage')::numeric, -1) NOT BETWEEN 0.50 AND 1 THEN
    RAISE EXCEPTION 'invalid certified dataset declaration';
  END IF;

  SELECT * INTO v_bundle FROM public.gto_v31_input_bundles
   WHERE input_bundle_id=(p_dataset->>'input_bundle_id')::uuid
     AND approval_status='approved' FOR SHARE;
  IF NOT FOUND
     OR v_bundle.bundle_checksum IS DISTINCT FROM p_dataset->>'input_bundle_checksum'
     OR v_bundle.range_bundle_checksum IS DISTINCT FROM p_dataset->>'range_bundle_checksum'
     OR v_bundle.source_combo_order_checksum IS DISTINCT FROM p_dataset->>'source_combo_order_checksum'
     OR v_bundle.icm_model_checksum IS DISTINCT FROM p_dataset->>'icm_model_checksum' THEN
    RAISE EXCEPTION 'dataset inputs are not the currently approved bundle';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_bundle.bundle_manifest->'files') f(value)
     WHERE f.value->>'kind'='scenario_manifest'
       AND f.value->>'checksum'=p_dataset->>'manifest_checksum'
  ) THEN
    RAISE EXCEPTION 'dataset manifest is not in the approved input bundle';
  END IF;

  INSERT INTO public.gto_v31_datasets (
    dataset_key, solver_version, solver_binary_checksum, pipeline_commit,
    pipeline_bundle_checksum,
    manifest_version, manifest_checksum, source_combo_order_checksum,
    range_bundle_checksum, icm_model_checksum, input_bundle_id,
    input_bundle_checksum, machine_ids, declared_coverage, quality_gates
  ) VALUES (
    p_dataset->>'dataset_key', p_dataset->>'solver_version', p_dataset->>'solver_binary_checksum',
    p_dataset->>'pipeline_commit', p_dataset->>'pipeline_bundle_checksum',
    p_dataset->>'manifest_version', p_dataset->>'manifest_checksum',
    p_dataset->>'source_combo_order_checksum', p_dataset->>'range_bundle_checksum',
    p_dataset->>'icm_model_checksum', (p_dataset->>'input_bundle_id')::uuid,
    p_dataset->>'input_bundle_checksum',
    v_machines, p_dataset->'declared_coverage', v_gates
  ) RETURNING dataset_id INTO v_id;
  RETURN v_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_register_dataset(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_register_dataset(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_worker_contract(p_dataset_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_result jsonb;
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  IF COALESCE(p_dataset_key,'') !~ '^[a-z0-9][a-z0-9._:-]{2,127}$' THEN
    RAISE EXCEPTION 'dataset key is invalid';
  END IF;
  SELECT jsonb_build_object(
    'contract','smarter-poker.gto-v31-worker-contract.v1',
    'dataset_id',d.dataset_id,'dataset_key',d.dataset_key,'state',d.state,
    'quality_status',d.quality_status,'dataset_checksum',d.dataset_checksum,
    'source_artifact_checksum',d.source_artifact_checksum,
    'solver_version',d.solver_version,
    'solver_binary_checksum',d.solver_binary_checksum,
    'pipeline_commit',d.pipeline_commit,
    'pipeline_bundle_checksum',d.pipeline_bundle_checksum,
    'manifest_version',d.manifest_version,'manifest_checksum',d.manifest_checksum,
    'source_combo_order_checksum',d.source_combo_order_checksum,
    'range_bundle_checksum',d.range_bundle_checksum,
    'icm_model_checksum',d.icm_model_checksum,
    'input_bundle_checksum',d.input_bundle_checksum,
    'input_approval_status',b.approval_status,
    'machine_ids',d.machine_ids,'declared_cells',jsonb_array_length(d.declared_coverage)
  ) INTO v_result
    FROM public.gto_v31_datasets d
    JOIN public.gto_v31_input_bundles b ON b.input_bundle_id=d.input_bundle_id
   WHERE d.dataset_key=p_dataset_key;
  RETURN v_result;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_worker_contract(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_worker_contract(text) TO service_role;

-- The caller cannot author compact cells, detached source receipts, or
-- release verdicts. PostgreSQL owns all three through the guarded functions below.

CREATE OR REPLACE FUNCTION public.fn_gto_v31_combo_cards(p_combo_index integer)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = public
AS $fn$
DECLARE
  v_high integer;
  v_low integer;
  v_ranks constant text := '23456789TJQKA';
  v_suits constant text := 'cdhs';
  v_card_low text;
  v_card_high text;
BEGIN
  IF p_combo_index < 0 OR p_combo_index > 1325 THEN RETURN NULL; END IF;
  v_high := floor((1 + sqrt(1 + 8 * p_combo_index)) / 2)::integer;
  WHILE v_high * (v_high - 1) / 2 > p_combo_index LOOP v_high := v_high - 1; END LOOP;
  WHILE (v_high + 1) * v_high / 2 <= p_combo_index LOOP v_high := v_high + 1; END LOOP;
  v_low := p_combo_index - v_high * (v_high - 1) / 2;
  v_card_low := substr(v_ranks, v_low / 4 + 1, 1) || substr(v_suits, mod(v_low,4) + 1, 1);
  v_card_high := substr(v_ranks, v_high / 4 + 1, 1) || substr(v_suits, mod(v_high,4) + 1, 1);
  RETURN ARRAY[v_card_low,v_card_high];
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_combo_cards(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_combo_cards(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_hand_key(p_combo_index integer, p_board text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = public
AS $fn$
DECLARE
  v_cards text[] := public.fn_gto_v31_combo_cards(p_combo_index);
  v_ranks constant text := '23456789TJQKA';
  v_r1 text;
  v_r2 text;
  v_s1 text;
  v_s2 text;
  v_high text;
  v_low text;
  v_suffix text;
  v_flush_suit text := '';
  v_best integer := 1;
  v_count integer;
  v_suit text;
  v_flush_count integer := 0;
BEGIN
  IF p_board !~ '^([2-9TJQKA][cdhs]){3,5}$' THEN RETURN NULL; END IF;
  v_r1 := left(v_cards[1],1); v_s1 := right(v_cards[1],1);
  v_r2 := left(v_cards[2],1); v_s2 := right(v_cards[2],1);
  IF position(v_r1 IN v_ranks) >= position(v_r2 IN v_ranks) THEN
    v_high := v_r1; v_low := v_r2;
  ELSE
    v_high := v_r2; v_low := v_r1;
  END IF;
  v_suffix := CASE WHEN v_high=v_low THEN '' WHEN v_s1=v_s2 THEN 's' ELSE 'o' END;
  FOREACH v_suit IN ARRAY ARRAY['c','d','h','s'] LOOP
    SELECT count(*) INTO v_count FROM generate_series(2,length(p_board),2) n
      WHERE substr(p_board,n,1)=v_suit;
    IF v_count > v_best THEN v_best:=v_count; v_flush_suit:=v_suit; END IF;
  END LOOP;
  IF v_flush_suit<>'' THEN
    v_flush_count := (CASE WHEN v_s1=v_flush_suit THEN 1 ELSE 0 END) +
                     (CASE WHEN v_s2=v_flush_suit THEN 1 ELSE 0 END);
  END IF;
  RETURN v_high || v_low || v_suffix || ':' || v_flush_count;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_hand_key(integer,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_hand_key(integer,text) TO service_role;

-- Reconstruct the public line from the exact Pio node path. The only fact a
-- postflop Pio path cannot contain is the preflop aggressor, so that value is
-- carried by the human-approved scenario manifest and bound below. Everything
-- else, including the player to act, prior-street aggression, check-throughs,
-- and response subtype, is derived here instead of trusted from a worker label.
CREATE OR REPLACE FUNCTION public.fn_gto_v31_node_line_proof(
  p_node text,
  p_preflop_aggressor integer,
  p_root_pot_chips numeric,
  p_effective_stack_chips numeric
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  v_tokens text[]:=string_to_array(p_node,':');
  v_token text;
  v_actor integer:=0;
  v_wager boolean:=false;
  v_closed boolean:=false;
  v_closed_by_checks boolean:=false;
  v_street_index integer:=0;
  v_types text[]:=ARRAY[]::text[];
  v_actors integer[]:=ARRAY[]::integer[];
  v_previous text;
  v_i integer;
  v_hero_aggressive integer;
  v_last_aggressor integer;
  v_flop_aggressor integer;
  v_turn_aggressor integer;
  v_flop_checked boolean:=false;
  v_turn_checked boolean:=false;
  v_previous_aggressor integer;
  v_older_aggressor integer;
  v_previous_checked boolean:=false;
  v_role text;
  v_street text;
  v_pot numeric:=p_root_pot_chips;
  v_contributions numeric[]:=ARRAY[0,0]::numeric[];
  v_spent numeric[]:=ARRAY[0,0]::numeric[];
  v_current_target numeric:=0;
  v_target numeric;
  v_prior_target numeric;
  v_delta numeric;
  v_remaining numeric;
  v_last_target numeric;
  v_last_prior_target numeric;
  v_last_actor_total numeric;
  v_last_kind text;
  v_last_all_in boolean:=false;
  v_fraction numeric;
  v_facing_kind text:='none';
  v_facing_bucket text:='none';
BEGIN
  IF p_node IS NULL
     OR (p_preflop_aggressor IS NOT NULL AND p_preflop_aggressor NOT IN (0,1))
     OR p_root_pot_chips<=0 OR p_effective_stack_chips<=0
     OR p_root_pot_chips<>trunc(p_root_pot_chips)
     OR p_effective_stack_chips<>trunc(p_effective_stack_chips) THEN
    RETURN NULL;
  END IF;
  IF array_length(v_tokens,1)<2 OR v_tokens[1]<>'r' OR v_tokens[2]<>'0' THEN RETURN NULL; END IF;
  IF array_length(v_tokens,1)>=3 THEN
    FOR v_i IN 3..array_length(v_tokens,1) LOOP
      v_token:=v_tokens[v_i];
      IF v_token~'^[2-9TJQKA][cdhs]$' THEN
        IF NOT v_closed THEN RETURN NULL; END IF;
        IF v_street_index=0 THEN
          v_flop_aggressor:=v_last_aggressor;
          v_flop_checked:=v_closed_by_checks;
        ELSIF v_street_index=1 THEN
          v_turn_aggressor:=v_last_aggressor;
          v_turn_checked:=v_closed_by_checks;
        ELSE
          RETURN NULL;
        END IF;
        v_street_index:=v_street_index+1;
        v_actor:=0; v_wager:=false; v_closed:=false;
        v_closed_by_checks:=false; v_last_aggressor:=NULL;
        v_contributions:=ARRAY[0,0]::numeric[]; v_current_target:=0;
        v_last_target:=NULL; v_last_prior_target:=NULL; v_last_actor_total:=NULL;
        v_last_kind:=NULL; v_last_all_in:=false;
        v_types:=ARRAY[]::text[]; v_actors:=ARRAY[]::integer[];
      ELSIF v_token='c' THEN
        IF v_closed THEN RETURN NULL; END IF;
        v_previous:=CASE WHEN array_length(v_types,1)>0 THEN v_types[array_length(v_types,1)] END;
        v_types:=array_append(v_types,CASE WHEN v_wager THEN 'call' ELSE 'check' END);
        v_actors:=array_append(v_actors,v_actor);
        IF v_wager THEN
          v_delta:=v_current_target-v_contributions[v_actor+1];
          v_remaining:=p_effective_stack_chips-v_spent[v_actor+1];
          IF v_delta<0 OR v_delta>v_remaining THEN RETURN NULL; END IF;
          v_contributions[v_actor+1]:=v_contributions[v_actor+1]+v_delta;
          v_spent[v_actor+1]:=v_spent[v_actor+1]+v_delta;
          v_pot:=v_pot+v_delta;
        END IF;
        IF v_wager OR v_previous='check' THEN
          v_closed:=true;
          v_closed_by_checks:=NOT v_wager AND v_previous='check';
          v_wager:=false;
        END IF;
        v_actor:=1-v_actor;
      ELSIF v_token~'^b[1-9][0-9]*$' THEN
        IF v_closed THEN RETURN NULL; END IF;
        v_target:=substring(v_token FROM 2)::numeric;
        v_prior_target:=v_current_target;
        v_remaining:=p_effective_stack_chips-v_spent[v_actor+1];
        v_last_actor_total:=v_contributions[v_actor+1]+v_remaining;
        IF v_target<=v_contributions[v_actor+1]
           OR (v_wager AND v_target<=v_current_target)
           OR v_target>v_last_actor_total THEN RETURN NULL; END IF;
        v_types:=array_append(v_types,CASE WHEN v_wager THEN 'raise' ELSE 'bet' END);
        v_actors:=array_append(v_actors,v_actor);
        v_last_kind:=CASE WHEN v_wager THEN 'raise' ELSE 'bet' END;
        v_last_target:=v_target; v_last_prior_target:=v_prior_target;
        v_last_all_in:=v_target=v_last_actor_total;
        v_delta:=v_target-v_contributions[v_actor+1];
        v_contributions[v_actor+1]:=v_target;
        v_spent[v_actor+1]:=v_spent[v_actor+1]+v_delta;
        v_pot:=v_pot+v_delta; v_current_target:=v_target;
        v_last_aggressor:=v_actor; v_wager:=true; v_actor:=1-v_actor;
      ELSE
        RETURN NULL;
      END IF;
    END LOOP;
  END IF;
  IF v_closed THEN RETURN NULL; END IF;
  v_street:=CASE v_street_index WHEN 0 THEN 'flop' WHEN 1 THEN 'turn' WHEN 2 THEN 'river' END;
  IF v_street IS NULL THEN RETURN NULL; END IF;

  IF v_wager THEN
    IF v_last_all_in THEN
      v_role:='all_in'; v_facing_kind:='all_in'; v_facing_bucket:='all_in';
    ELSIF v_types[array_length(v_types,1)]='bet' THEN
      v_role:='facing_bet';
      v_facing_kind:='bet';
      IF v_pot-v_last_target<=0 THEN RETURN NULL; END IF;
      v_fraction:=v_last_target/(v_pot-v_last_target);
      v_facing_bucket:=CASE WHEN v_fraction<0.6 THEN 'small'
        WHEN v_fraction<1.1 THEN 'mid' ELSE 'big' END;
    ELSIF v_types[array_length(v_types,1)]='raise' THEN
      SELECT min(i) INTO v_hero_aggressive FROM generate_subscripts(v_types,1) i
       WHERE i<array_length(v_types,1) AND v_actors[i]=v_actor
         AND v_types[i] IN ('bet','raise');
      IF v_hero_aggressive IS NULL THEN RETURN NULL; END IF;
      IF v_types[v_hero_aggressive]='raise' THEN
        v_role:='facing_raise';
      ELSIF EXISTS (SELECT 1 FROM generate_subscripts(v_types,1) i
          WHERE i<v_hero_aggressive AND v_actors[i]<>v_actor AND v_types[i]='check') THEN
        v_role:='check_raise';
      ELSE
        v_role:='bet_raise';
      END IF;
      v_facing_kind:='raise';
      IF v_pot+(v_current_target-v_contributions[v_actor+1])<=0 THEN RETURN NULL; END IF;
      v_fraction:=(v_last_target-v_last_prior_target)/
        (v_pot+(v_current_target-v_contributions[v_actor+1]));
      v_facing_bucket:=CASE WHEN v_fraction<0.6 THEN 'small'
        WHEN v_fraction<1.1 THEN 'mid' ELSE 'big' END;
    ELSE
      RETURN NULL;
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM generate_subscripts(v_types,1) i WHERE v_actors[i]=v_actor) THEN
      RETURN NULL;
    END IF;
    IF v_street_index=0 THEN
      v_previous_aggressor:=p_preflop_aggressor;
      IF v_previous_aggressor=v_actor THEN v_role:='cbet';
      ELSIF v_previous_aggressor IS NULL THEN v_role:='open';
      ELSE RETURN NULL;
      END IF;
    ELSE
      IF v_street_index=1 THEN
        v_previous_aggressor:=v_flop_aggressor;
        v_previous_checked:=v_flop_checked;
        v_older_aggressor:=p_preflop_aggressor;
      ELSE
        v_previous_aggressor:=v_turn_aggressor;
        v_previous_checked:=v_turn_checked;
        v_older_aggressor:=v_flop_aggressor;
      END IF;
      IF v_previous_aggressor=v_actor THEN
        v_role:='barrel';
      ELSIF v_previous_aggressor IS NOT NULL THEN
        RETURN NULL;
      ELSIF NOT v_previous_checked THEN
        RETURN NULL;
      ELSIF v_older_aggressor=v_actor THEN
        v_role:='delayed_cbet';
      ELSIF v_older_aggressor IS NOT NULL THEN
        v_role:='probe';
      ELSE
        v_role:='open';
      END IF;
    END IF;
  END IF;
  RETURN jsonb_build_object(
    'street',v_street,
    'current_actor_solver_player',v_actor,
    'derived_node_role',v_role,
    'derived_facing_kind',v_facing_kind,
    'derived_facing_size_bucket',v_facing_bucket,
    'facing_target_chips',CASE WHEN v_wager THEN v_last_target END,
    'facing_actor_total_chips',CASE WHEN v_wager THEN v_last_actor_total END,
    'previous_street_aggressor_solver_player',v_previous_aggressor,
    'previous_street_checked_through',v_previous_checked,
    'older_street_aggressor_solver_player',v_older_aggressor
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_node_line_proof(text,integer,numeric,numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_node_line_proof(text,integer,numeric,numeric)
  TO service_role;

-- Release validator. Besides schema and node-role coherence, it proves all 1,326
-- combo frequencies normalize, dead/unreached combos carry no strategy, and
-- policy EV equals the action-frequency weighted action EV within 0.02 bb.
CREATE OR REPLACE FUNCTION public.fn_gto_v31_source_node_valid(p_node jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  v_context jsonb := p_node->'node_context';
  v_line_proof jsonb := p_node->'line_proof';
  v_specs jsonb := p_node->'action_specs';
  v_frequencies jsonb := p_node->'frequencies';
  v_action_evs jsonb := p_node->'action_evs_bb';
  v_policy_evs jsonb := p_node->'policy_evs_bb';
  v_matchups jsonb := p_node->'matchups';
  v_action record;
  v_family text;
  v_unit text;
  v_size numeric;
  v_role text := v_context->>'node_role';
  v_facing text := v_context->>'facing_kind';
  v_bucket text := v_context->>'facing_size_bucket';
  v_has_check boolean := false;
  v_has_fold boolean := false;
  v_has_call boolean := false;
  v_has_bet boolean := false;
  v_table_size integer;
  v_allowed_positions text[];
  v_board text := v_context->>'board';
  v_cards text[] := ARRAY[]::text[];
  v_card text;
  v_i integer;
  v_weight numeric;
  v_frequency numeric;
  v_frequency_sum numeric;
  v_action_ev numeric;
  v_expected_ev numeric;
  v_policy_ev numeric;
  v_derived_line jsonb;
  v_line_role text;
  v_hero_solver_player integer;
  v_preflop_aggressor integer;
  v_node_cards text[];
  v_expected_node_cards text[]:=ARRAY[]::text[];
  v_facing_target numeric;
  v_facing_actor_total numeric;
  v_root_pot_chips numeric;
  v_effective_stack_chips numeric;
  v_chips_per_bb numeric;
  v_last_token text;
BEGIN
  IF p_node IS NULL OR jsonb_typeof(p_node)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_node))<>12
     OR NOT (p_node ?& ARRAY['schema','node','node_checksum','node_context','line_proof','action_specs',
       'frequencies','policy_evs_bb','action_evs_bb','matchups',
       'source_combo_order_checksum','range_bundle_checksum'])
     OR p_node->>'schema' IS DISTINCT FROM 'smarter-poker.pio-policy.v3'
     OR COALESCE(p_node->>'node','') !~ '^r:[0-9]+(:[cf]|:b[1-9][0-9]*|:[2-9TJQKA][cdhs])*$'
     OR COALESCE(p_node->>'node_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_node->>'node_checksum' IS DISTINCT FROM public.fn_gto_v31_node_checksum(p_node)
     OR COALESCE(p_node->>'source_combo_order_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_node->>'source_combo_order_checksum'=repeat('0',64)
     OR COALESCE(p_node->>'range_bundle_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_node->>'range_bundle_checksum'=repeat('0',64)
     OR jsonb_typeof(v_context)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(v_context))<>16
     OR NOT (v_context ?& ARRAY['street','game_family','objective','utility_context',
       'table_size','pot_type','hero_position','opponent_position','depth_bucket',
       'texture_class','node_role','facing_kind','facing_size_bucket','board',
       'facing_target_chips','facing_actor_total_chips'])
     OR COALESCE(v_board,'') !~ '^([2-9TJQKA][cdhs]){3,5}$'
     OR length(v_board) <> (CASE v_context->>'street'
       WHEN 'flop' THEN 6 WHEN 'turn' THEN 8 WHEN 'river' THEN 10 ELSE 0 END)
     OR COALESCE(v_context->>'game_family','') NOT IN ('cash','spin','tourney_ev','tourney_icm')
     OR COALESCE(v_context->>'objective','') NOT IN ('cash_ev','chip_ev','icm')
     OR COALESCE(v_context->>'utility_context','') NOT IN
       ('cash_ev','chip_ev','spin_ladder','satellite','bubble','final_table','in_money','ladder')
     OR COALESCE(v_context->>'pot_type','') NOT IN ('limped','srp','3bet','4bet_plus')
     OR COALESCE((v_context->>'depth_bucket')::integer,0) NOT IN (10,20,40,80,150)
     OR COALESCE(v_context->>'texture_class','') !~ '^[ABML][mtr][pu][cd]$'
     OR v_context->>'texture_class' IS DISTINCT FROM public.fn_gto_texture_class_any(v_board)
     OR COALESCE(v_role,'') NOT IN ('open','cbet','probe','delayed_cbet','barrel','facing_bet','facing_raise','check_raise','bet_raise','all_in')
     OR jsonb_typeof(v_line_proof)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(v_line_proof))<>7
     OR NOT (v_line_proof ?& ARRAY['schema','manifest_checksum','hero_solver_player',
       'preflop_aggressor_solver_player','root_pot_chips','effective_stack_chips',
       'chips_per_bb'])
     OR v_line_proof->>'schema' IS DISTINCT FROM 'smarter-poker.pio-line-proof.v1'
     OR COALESCE(v_line_proof->>'manifest_checksum','') !~ '^[0-9a-f]{64}$'
     OR v_line_proof->>'manifest_checksum'=repeat('0',64)
     OR jsonb_typeof(v_line_proof->'hero_solver_player')<>'number'
     OR COALESCE((v_line_proof->>'hero_solver_player')::integer,-1) NOT IN (0,1)
     OR jsonb_typeof(v_line_proof->'preflop_aggressor_solver_player') NOT IN ('number','null')
     OR (jsonb_typeof(v_line_proof->'preflop_aggressor_solver_player')='number'
       AND (v_line_proof->>'preflop_aggressor_solver_player')::integer NOT IN (0,1))
     OR jsonb_typeof(v_line_proof->'root_pot_chips')<>'number'
     OR jsonb_typeof(v_line_proof->'effective_stack_chips')<>'number'
     OR jsonb_typeof(v_line_proof->'chips_per_bb')<>'number'
     OR jsonb_typeof(v_specs)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(v_specs))<2
     OR jsonb_typeof(v_frequencies)<>'object'
     OR jsonb_typeof(v_action_evs)<>'object'
     OR jsonb_typeof(v_policy_evs)<>'array' OR jsonb_array_length(v_policy_evs)<>1326
     OR jsonb_typeof(v_matchups)<>'array' OR jsonb_array_length(v_matchups)<>1326
     OR (SELECT count(*) FROM jsonb_object_keys(v_frequencies))<>(SELECT count(*) FROM jsonb_object_keys(v_specs))
     OR (SELECT count(*) FROM jsonb_object_keys(v_action_evs))<>(SELECT count(*) FROM jsonb_object_keys(v_specs)) THEN
    RETURN false;
  END IF;

  v_hero_solver_player:=(v_line_proof->>'hero_solver_player')::integer;
  IF jsonb_typeof(v_line_proof->'preflop_aggressor_solver_player')='number' THEN
    v_preflop_aggressor:=(v_line_proof->>'preflop_aggressor_solver_player')::integer;
  END IF;
  v_root_pot_chips:=(v_line_proof->>'root_pot_chips')::numeric;
  v_effective_stack_chips:=(v_line_proof->>'effective_stack_chips')::numeric;
  v_chips_per_bb:=(v_line_proof->>'chips_per_bb')::numeric;
  IF v_root_pot_chips<=0 OR v_effective_stack_chips<=0 OR v_chips_per_bb<=0
     OR v_root_pot_chips<>trunc(v_root_pot_chips)
     OR v_effective_stack_chips<>trunc(v_effective_stack_chips)
     OR v_chips_per_bb<>trunc(v_chips_per_bb)
     OR v_effective_stack_chips<>((v_context->>'depth_bucket')::numeric*v_chips_per_bb) THEN
    RETURN false;
  END IF;
  IF (v_context->>'pot_type'='limped') IS DISTINCT FROM (v_preflop_aggressor IS NULL) THEN
    RETURN false;
  END IF;

  FOR v_i IN 0..length(v_board)/2-1 LOOP
    v_card:=substr(v_board,v_i*2+1,2);
    IF v_card=ANY(v_cards) THEN RETURN false; END IF;
    v_cards:=array_append(v_cards,v_card);
  END LOOP;
  SELECT COALESCE(array_agg(token ORDER BY ordinal),'{}'::text[]) INTO v_node_cards
    FROM unnest(string_to_array(p_node->>'node',':')) WITH ORDINALITY part(token,ordinal)
   WHERE token~'^[2-9TJQKA][cdhs]$';
  IF length(v_board)/2>3 THEN
    FOR v_i IN 3..length(v_board)/2-1 LOOP
      v_expected_node_cards:=array_append(v_expected_node_cards,substr(v_board,v_i*2+1,2));
    END LOOP;
  END IF;
  IF v_node_cards IS DISTINCT FROM v_expected_node_cards THEN RETURN false; END IF;
  v_derived_line:=public.fn_gto_v31_node_line_proof(
    p_node->>'node',
    v_preflop_aggressor,
    v_root_pot_chips,
    v_effective_stack_chips
  );
  v_line_role:=v_derived_line->>'derived_node_role';
  IF v_derived_line IS NULL
     OR v_derived_line->>'street' IS DISTINCT FROM v_context->>'street'
     OR COALESCE((v_derived_line->>'current_actor_solver_player')::integer,-1)<>v_hero_solver_player
     OR v_line_role<>v_role
     OR v_derived_line->>'derived_facing_kind' IS DISTINCT FROM v_facing
     OR v_derived_line->>'derived_facing_size_bucket' IS DISTINCT FROM v_bucket
     OR v_derived_line->'facing_target_chips' IS DISTINCT FROM v_context->'facing_target_chips'
     OR v_derived_line->'facing_actor_total_chips' IS DISTINCT FROM v_context->'facing_actor_total_chips' THEN
    RETURN false;
  END IF;
  v_last_token := (string_to_array(p_node->>'node',':'))[
    array_length(string_to_array(p_node->>'node',':'),1)
  ];
  IF v_role IN ('open','cbet','probe','delayed_cbet','barrel') THEN
    IF v_context->'facing_target_chips' IS DISTINCT FROM 'null'::jsonb
       OR v_context->'facing_actor_total_chips' IS DISTINCT FROM 'null'::jsonb THEN
      RETURN false;
    END IF;
  ELSE
    IF v_last_token !~ '^b[1-9][0-9]*$'
       OR jsonb_typeof(v_context->'facing_target_chips')<>'number'
       OR jsonb_typeof(v_context->'facing_actor_total_chips')<>'number' THEN
      RETURN false;
    END IF;
    v_facing_target := (v_context->>'facing_target_chips')::numeric;
    v_facing_actor_total := (v_context->>'facing_actor_total_chips')::numeric;
    IF v_facing_target <= 0 OR v_facing_actor_total <= 0
       OR v_facing_target > v_facing_actor_total
       OR v_facing_target <> substring(v_last_token FROM 2)::numeric
       OR (v_role='all_in' AND v_facing_target<>v_facing_actor_total)
       OR (v_role<>'all_in' AND v_facing_target>=v_facing_actor_total) THEN
      RETURN false;
    END IF;
  END IF;
  v_table_size := (v_context->>'table_size')::integer;
  v_allowed_positions := CASE v_table_size
    WHEN 2 THEN ARRAY['SB','BB'] WHEN 3 THEN ARRAY['SB','BB','BTN']
    WHEN 4 THEN ARRAY['SB','BB','CO','BTN'] WHEN 5 THEN ARRAY['SB','BB','HJ','CO','BTN']
    WHEN 6 THEN ARRAY['SB','BB','UTG','HJ','CO','BTN']
    WHEN 7 THEN ARRAY['SB','BB','UTG','MP','HJ','CO','BTN']
    WHEN 8 THEN ARRAY['SB','BB','UTG','UTG1','MP','HJ','CO','BTN']
    WHEN 9 THEN ARRAY['SB','BB','UTG','UTG1','UTG2','MP','HJ','CO','BTN']
    WHEN 10 THEN ARRAY['SB','BB','UTG','UTG1','UTG2','UTG3','MP','HJ','CO','BTN']
    ELSE NULL END;
  IF v_allowed_positions IS NULL
     OR NOT (v_context->>'hero_position'=ANY(v_allowed_positions))
     OR NOT (v_context->>'opponent_position'=ANY(v_allowed_positions))
     OR v_context->>'hero_position'=v_context->>'opponent_position'
     OR NOT ((v_context->>'game_family'='cash' AND v_context->>'objective'='cash_ev' AND v_context->>'utility_context'='cash_ev')
       OR (v_context->>'game_family'='spin' AND v_context->>'objective'='chip_ev' AND v_context->>'utility_context'='chip_ev')
       OR (v_context->>'game_family'='spin' AND v_context->>'objective'='icm' AND v_context->>'utility_context'='spin_ladder')
       OR (v_context->>'game_family'='tourney_ev' AND v_context->>'objective'='chip_ev' AND v_context->>'utility_context'='chip_ev')
       OR (v_context->>'game_family'='tourney_icm' AND v_context->>'objective'='icm' AND
           v_context->>'utility_context' IN ('satellite','bubble','final_table','in_money','ladder'))) THEN
    RETURN false;
  END IF;
  IF (v_role IN ('open','cbet','probe','delayed_cbet','barrel') AND (v_facing<>'none' OR v_bucket<>'none'))
     OR (v_role='all_in' AND (v_facing<>'all_in' OR v_bucket<>'all_in'))
     OR (v_role='facing_bet' AND (v_facing<>'bet' OR v_bucket NOT IN ('small','mid','big')))
     OR (v_role IN ('facing_raise','check_raise','bet_raise') AND
         (v_facing<>'raise' OR v_bucket NOT IN ('small','mid','big'))) THEN RETURN false; END IF;

  FOR v_action IN SELECT key,value FROM jsonb_each(v_specs) LOOP
    IF NOT (v_frequencies?v_action.key) OR NOT (v_action_evs?v_action.key)
       OR jsonb_typeof(v_action.value)<>'object'
       OR jsonb_typeof(v_frequencies->v_action.key)<>'array'
       OR jsonb_array_length(v_frequencies->v_action.key)<>1326
       OR jsonb_typeof(v_action_evs->v_action.key)<>'array'
       OR jsonb_array_length(v_action_evs->v_action.key)<>1326 THEN RETURN false; END IF;
    v_family:=v_action.value->>'family'; v_unit:=v_action.value->>'size_unit';
    IF v_family NOT IN ('check','fold','call','bet','raise','all_in') THEN RETURN false; END IF;
    v_has_check:=v_has_check OR v_family='check'; v_has_fold:=v_has_fold OR v_family='fold';
    v_has_call:=v_has_call OR v_family='call'; v_has_bet:=v_has_bet OR v_family='bet';
    IF v_family IN ('check','fold','call') THEN
      IF v_unit IS DISTINCT FROM 'none' OR v_action.value->'size_value' IS DISTINCT FROM 'null'::jsonb
         OR (v_action.value->>'all_in')::boolean IS DISTINCT FROM false THEN RETURN false; END IF;
    ELSIF v_family='all_in' THEN
      IF v_unit IS DISTINCT FROM 'all_in' OR v_action.value->'size_value' IS DISTINCT FROM 'null'::jsonb
         OR (v_action.value->>'all_in')::boolean IS DISTINCT FROM true THEN RETURN false; END IF;
    ELSE
      v_size:=(v_action.value->>'size_value')::numeric;
      IF v_size<=0 OR v_size>20 OR COALESCE((v_action.value->>'all_in')::boolean,false)
         OR (v_family='bet' AND v_unit<>'pot_fraction')
         OR (v_family='raise' AND v_unit<>'pot_after_call_fraction') THEN RETURN false; END IF;
    END IF;
  END LOOP;
  IF v_role IN ('open','cbet','probe','delayed_cbet','barrel') THEN
    IF NOT v_has_check OR v_has_fold OR v_has_call THEN RETURN false; END IF;
  ELSIF v_role='all_in' THEN
    IF NOT v_has_fold OR NOT v_has_call OR v_has_check OR v_has_bet
       OR EXISTS (SELECT 1 FROM jsonb_each(v_specs) s WHERE s.value->>'family' NOT IN ('fold','call')) THEN RETURN false; END IF;
  ELSE
    IF NOT v_has_fold OR NOT v_has_call OR v_has_check OR v_has_bet THEN RETURN false; END IF;
  END IF;

  FOR v_i IN 0..1325 LOOP
    IF jsonb_typeof(v_matchups->v_i)<>'number' THEN RETURN false; END IF;
    v_weight:=(v_matchups->>v_i)::numeric;
    IF v_weight<0 OR v_weight>1 THEN RETURN false; END IF;
    v_frequency_sum:=0; v_expected_ev:=0;
    FOR v_action IN SELECT key FROM jsonb_each(v_specs) LOOP
      IF jsonb_typeof(v_frequencies->v_action.key->v_i)<>'number' THEN RETURN false; END IF;
      v_frequency:=(v_frequencies->v_action.key->>v_i)::numeric;
      IF v_frequency<0 OR v_frequency>1 THEN RETURN false; END IF;
      v_frequency_sum:=v_frequency_sum+v_frequency;
      IF v_weight>0 THEN
        IF jsonb_typeof(v_action_evs->v_action.key->v_i)<>'number' THEN RETURN false; END IF;
        v_action_ev:=(v_action_evs->v_action.key->>v_i)::numeric;
        v_expected_ev:=v_expected_ev+v_frequency*v_action_ev;
      ELSIF v_frequency<>0 OR jsonb_typeof(v_action_evs->v_action.key->v_i)<>'null' THEN
        RETURN false;
      END IF;
    END LOOP;
    IF v_weight>0 THEN
      IF abs(v_frequency_sum-1)>0.00002 OR jsonb_typeof(v_policy_evs->v_i)<>'number' THEN RETURN false; END IF;
      v_policy_ev:=(v_policy_evs->>v_i)::numeric;
      IF abs(v_policy_ev-v_expected_ev)>0.02 THEN RETURN false; END IF;
    ELSIF v_frequency_sum<>0 OR jsonb_typeof(v_policy_evs->v_i)<>'null' THEN RETURN false;
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(public.fn_gto_v31_combo_cards(v_i)) c(card) WHERE c.card=ANY(v_cards))
       AND v_weight<>0 THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_source_node_valid(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_source_node_valid(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_ingest_source_artifact(
  p_dataset_id uuid,
  p_machine_id text,
  p_artifact jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_dataset public.gto_v31_datasets%ROWTYPE;
  v_matrix jsonb := p_artifact->'strategy_matrix_v2';
  v_node jsonb;
  v_row_id uuid;
  v_solved_at timestamptz;
  v_checksum text;
  v_nodes integer;
  v_inserted integer;
  v_normalized_nodes jsonb := '[]'::jsonb;
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  SELECT * INTO v_dataset FROM public.gto_v31_datasets
   WHERE dataset_id=p_dataset_id AND state='building' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dataset is not building'; END IF;
  IF p_machine_id NOT IN ('M1','M2') OR NOT (p_machine_id=ANY(v_dataset.machine_ids))
     OR p_artifact IS NULL OR jsonb_typeof(p_artifact)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_artifact))<>7
     OR NOT (p_artifact ?& ARRAY['id','scenario_hash','game_family','stack_depth','street','solved_at','strategy_matrix_v2'])
     OR COALESCE(p_artifact->>'id','') !~ '^[0-9a-fA-F-]{36}$'
     OR length(COALESCE(p_artifact->>'scenario_hash','')) NOT BETWEEN 8 AND 512
     OR COALESCE(p_artifact->>'scenario_hash','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
     OR p_artifact->>'game_family' NOT IN ('cash','spin','tourney_ev','tourney_icm')
     OR COALESCE((p_artifact->>'stack_depth')::integer,0) NOT IN (10,20,40,80,150)
     OR p_artifact->>'street' NOT IN ('flop','turn','river')
     OR jsonb_typeof(v_matrix)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(v_matrix))<>3
     OR NOT (v_matrix ?& ARRAY['schema','combo_order','nodes'])
     OR v_matrix->>'schema' IS DISTINCT FROM 'smarter-poker.pio-artifact.v31.1'
     OR v_matrix->>'combo_order' IS DISTINCT FROM
       'card=rank*4+suit; combo=b*(b-1)/2+a; 2c2d=0..AhAs=1325'
     OR jsonb_typeof(v_matrix->'nodes')<>'array'
     OR jsonb_array_length(v_matrix->'nodes') NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'source artifact envelope is invalid';
  END IF;
  v_row_id:=(p_artifact->>'id')::uuid;
  v_solved_at:=(p_artifact->>'solved_at')::timestamptz;
  IF v_solved_at IS NULL OR v_solved_at>now()+interval '5 minutes'
     OR v_solved_at<now()-interval '30 days' THEN
    RAISE EXCEPTION 'source artifact solved_at is outside the admission window';
  END IF;
  v_nodes:=jsonb_array_length(v_matrix->'nodes');
  FOR v_node IN SELECT value FROM jsonb_array_elements(v_matrix->'nodes') LOOP
    -- PostgreSQL owns the canonical node checksum. A worker may omit that one
    -- field, which avoids claiming that Python JSON number rendering is byte
    -- identical to PostgreSQL jsonb. A supplied checksum is still verified
    -- and can never be replaced silently.
    IF jsonb_typeof(v_node)='object'
       AND (SELECT count(*) FROM jsonb_object_keys(v_node))=11
       AND NOT (v_node?'node_checksum')
       AND (v_node ?& ARRAY['schema','node','node_context','line_proof','action_specs',
         'frequencies','policy_evs_bb','action_evs_bb','matchups',
         'source_combo_order_checksum','range_bundle_checksum']) THEN
      v_node:=v_node||jsonb_build_object(
        'node_checksum',public.fn_gto_v31_node_checksum(v_node)
      );
    END IF;
    IF NOT public.fn_gto_v31_source_node_valid(v_node)
       OR v_node#>>'{node_context,game_family}' IS DISTINCT FROM p_artifact->>'game_family'
       OR COALESCE((v_node#>>'{node_context,depth_bucket}')::integer,0)
            IS DISTINCT FROM (p_artifact->>'stack_depth')::integer
       OR v_node#>>'{node_context,street}' IS DISTINCT FROM p_artifact->>'street'
       OR v_node->>'source_combo_order_checksum' IS DISTINCT FROM v_dataset.source_combo_order_checksum
       OR v_node->>'range_bundle_checksum' IS DISTINCT FROM v_dataset.range_bundle_checksum
       OR v_node#>>'{line_proof,manifest_checksum}' IS DISTINCT FROM v_dataset.manifest_checksum THEN
      RAISE EXCEPTION 'source artifact contains an invalid or cross-dataset node';
    END IF;
    v_normalized_nodes:=v_normalized_nodes||jsonb_build_array(v_node);
  END LOOP;
  v_matrix:=jsonb_set(v_matrix,'{nodes}',v_normalized_nodes,false);
  IF (SELECT count(DISTINCT value->>'node') FROM jsonb_array_elements(v_matrix->'nodes'))<>v_nodes THEN
    RAISE EXCEPTION 'source artifact contains duplicate nodes';
  END IF;
  v_checksum:=public.fn_gto_v31_source_artifact_checksum(p_artifact->>'scenario_hash',v_matrix);

  INSERT INTO public.solved_spots_gold (
    id,scenario_hash,game_type,stack_depth,street,strategy_matrix_v2,solved_v2_at,
    solver_version,solver_binary_checksum,machine_id,pipeline_commit,pipeline_bundle_checksum,
    manifest_version,manifest_checksum,source_artifact_checksum,quality_status,audited_at
  ) VALUES (
    v_row_id,p_artifact->>'scenario_hash','gto_v31_'||(p_artifact->>'game_family'),
    (p_artifact->>'stack_depth')::integer,p_artifact->>'street',v_matrix,v_solved_at,
    v_dataset.solver_version,v_dataset.solver_binary_checksum,p_machine_id,
    v_dataset.pipeline_commit,v_dataset.pipeline_bundle_checksum,
    v_dataset.manifest_version,v_dataset.manifest_checksum,
    v_checksum,'validated',clock_timestamp()
  ) ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted=0 AND NOT EXISTS (
    SELECT 1 FROM public.solved_spots_gold s
     WHERE s.id=v_row_id AND s.scenario_hash=p_artifact->>'scenario_hash'
       AND s.game_type='gto_v31_'||(p_artifact->>'game_family')
       AND s.stack_depth=(p_artifact->>'stack_depth')::integer
       AND s.street=p_artifact->>'street' AND s.strategy_matrix_v2=v_matrix
       AND s.solver_version=v_dataset.solver_version
       AND s.solver_binary_checksum=v_dataset.solver_binary_checksum
       AND s.machine_id=p_machine_id AND s.pipeline_commit=v_dataset.pipeline_commit
       AND s.pipeline_bundle_checksum=v_dataset.pipeline_bundle_checksum
       AND s.manifest_version::text=v_dataset.manifest_version
       AND s.manifest_checksum=v_dataset.manifest_checksum
       AND s.source_artifact_checksum=v_checksum AND s.quality_status='validated'
       AND s.audited_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'source artifact id was reused with another immutable payload';
  END IF;

  INSERT INTO public.gto_v31_source_artifacts (
    dataset_id,source_row_id,machine_id,scenario_hash,game_family,stack_depth,
    street,source_artifact_checksum,node_count,solved_at
  ) VALUES (
    p_dataset_id,v_row_id,p_machine_id,p_artifact->>'scenario_hash',p_artifact->>'game_family',
    (p_artifact->>'stack_depth')::integer,p_artifact->>'street',v_checksum,v_nodes,v_solved_at
  ) ON CONFLICT (dataset_id,source_row_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted=0 AND NOT EXISTS (
    SELECT 1 FROM public.gto_v31_source_artifacts a
     WHERE a.dataset_id=p_dataset_id AND a.source_row_id=v_row_id
       AND a.machine_id=p_machine_id AND a.scenario_hash=p_artifact->>'scenario_hash'
       AND a.game_family=p_artifact->>'game_family'
       AND a.stack_depth=(p_artifact->>'stack_depth')::integer
       AND a.street=p_artifact->>'street' AND a.source_artifact_checksum=v_checksum
       AND a.node_count=v_nodes AND a.solved_at=v_solved_at
  ) THEN
    RAISE EXCEPTION 'source artifact receipt id was reused with another payload';
  END IF;
  RETURN jsonb_build_object('source_row_id',v_row_id,'source_artifact_checksum',v_checksum,
    'node_count',v_nodes,'idempotent',v_inserted=0);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_ingest_source_artifact(uuid,text,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_ingest_source_artifact(uuid,text,jsonb)
  TO service_role;

-- The caller cannot author compact cells, detached source receipts, or
-- release verdicts. PostgreSQL owns all three through the guarded functions below.

CREATE OR REPLACE FUNCTION public.fn_gto_v31_build_cell(
  p_dataset_id uuid,
  p_context jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_dataset public.gto_v31_datasets%ROWTYPE;
  v_source_rows integer;
  v_train_rows integer;
  v_holdout_rows integer;
  v_spec_variants integer;
  v_machine_variants integer;
  v_specs jsonb;
  v_hand_matrix jsonb;
  v_policy_evs jsonb;
  v_action_evs jsonb;
  v_lineage text;
  v_cell jsonb;
  v_existing_checksum text;
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  SELECT * INTO v_dataset FROM public.gto_v31_datasets
   WHERE dataset_id=p_dataset_id AND state='building' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dataset is not building'; END IF;
  IF p_context IS NULL OR jsonb_typeof(p_context)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_context))<>13
     OR NOT (p_context ?& ARRAY['street','game_family','objective','utility_context',
       'table_size','pot_type','hero_position','opponent_position','depth_bucket',
       'texture_class','node_role','facing_kind','facing_size_bucket']) THEN
    RAISE EXCEPTION 'compact cell context is invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_dataset.declared_coverage) d(value)
    WHERE d.value=p_context) THEN
    RAISE EXCEPTION 'compact cell is not in declared coverage';
  END IF;
  SELECT c.cell_key_checksum INTO v_existing_checksum
    FROM public.gto_v31_runtime_cells c
   WHERE c.dataset_id=p_dataset_id
     AND c.street=p_context->>'street'
     AND c.game_family=p_context->>'game_family'
     AND c.objective=p_context->>'objective'
     AND c.utility_context=p_context->>'utility_context'
     AND c.table_size=(p_context->>'table_size')::smallint
     AND c.pot_type=p_context->>'pot_type'
     AND c.hero_position=p_context->>'hero_position'
     AND c.opponent_position=p_context->>'opponent_position'
     AND c.depth_bucket=(p_context->>'depth_bucket')::integer
     AND c.texture_class=p_context->>'texture_class'
     AND c.node_role=p_context->>'node_role'
     AND c.facing_kind=p_context->>'facing_kind'
     AND c.facing_size_bucket=p_context->>'facing_size_bucket';
  IF v_existing_checksum IS NOT NULL THEN RETURN v_existing_checksum; END IF;

  WITH source_nodes AS MATERIALIZED (
    SELECT a.source_row_id,a.machine_id,a.source_artifact_checksum,n.value AS node,
           CASE WHEN a.machine_id='M2' THEN 'holdout' ELSE 'train' END AS split
      FROM public.gto_v31_source_artifacts a
      JOIN public.solved_spots_gold s ON s.id=a.source_row_id
       AND s.quality_status='validated' AND s.audited_at IS NOT NULL
       AND s.source_artifact_checksum=a.source_artifact_checksum
       AND s.source_artifact_checksum=public.fn_gto_v31_source_artifact_checksum(s.scenario_hash,s.strategy_matrix_v2)
      CROSS JOIN LATERAL jsonb_array_elements(s.strategy_matrix_v2->'nodes') n(value)
     WHERE a.dataset_id=p_dataset_id
       AND n.value#>>'{node_context,street}'=p_context->>'street'
       AND n.value#>>'{node_context,game_family}'=p_context->>'game_family'
       AND n.value#>>'{node_context,objective}'=p_context->>'objective'
       AND n.value#>>'{node_context,utility_context}'=p_context->>'utility_context'
       AND (n.value#>>'{node_context,table_size}')::integer=(p_context->>'table_size')::integer
       AND n.value#>>'{node_context,pot_type}'=p_context->>'pot_type'
       AND n.value#>>'{node_context,hero_position}'=p_context->>'hero_position'
       AND n.value#>>'{node_context,opponent_position}'=p_context->>'opponent_position'
       AND (n.value#>>'{node_context,depth_bucket}')::integer=(p_context->>'depth_bucket')::integer
       AND n.value#>>'{node_context,texture_class}'=p_context->>'texture_class'
       AND n.value#>>'{node_context,node_role}'=p_context->>'node_role'
       AND n.value#>>'{node_context,facing_kind}'=p_context->>'facing_kind'
       AND n.value#>>'{node_context,facing_size_bucket}'=p_context->>'facing_size_bucket'
  )
  SELECT count(*),count(*) FILTER (WHERE split='train'),count(*) FILTER (WHERE split='holdout'),
         count(DISTINCT node->'action_specs'),count(DISTINCT machine_id),
         (array_agg(node->'action_specs'))[1],
         encode(digest(string_agg(source_row_id::text||':'||(node->>'node')||':'||
           (node->>'node_checksum'),'' ORDER BY source_row_id::text,node->>'node'),'sha256'),'hex')
    INTO v_source_rows,v_train_rows,v_holdout_rows,v_spec_variants,v_machine_variants,v_specs,v_lineage
    FROM source_nodes;
  IF v_source_rows<2 OR v_train_rows<1 OR v_holdout_rows<1 OR v_spec_variants<>1
     OR v_machine_variants<>2 OR v_specs IS NULL OR v_lineage IS NULL THEN
    RAISE EXCEPTION 'cell needs M1 and M2, one action topology, and independent train and holdout sources';
  END IF;

  WITH source_nodes AS MATERIALIZED (
    SELECT n.value AS node,
           CASE WHEN a.machine_id='M2' THEN 'holdout' ELSE 'train' END AS split
      FROM public.gto_v31_source_artifacts a
      JOIN public.solved_spots_gold s ON s.id=a.source_row_id
       AND s.quality_status='validated' AND s.audited_at IS NOT NULL
       AND s.source_artifact_checksum=a.source_artifact_checksum
       AND s.source_artifact_checksum=public.fn_gto_v31_source_artifact_checksum(s.scenario_hash,s.strategy_matrix_v2)
      CROSS JOIN LATERAL jsonb_array_elements(s.strategy_matrix_v2->'nodes') n(value)
     WHERE a.dataset_id=p_dataset_id
       AND n.value#>>'{node_context,street}'=p_context->>'street'
       AND n.value#>>'{node_context,game_family}'=p_context->>'game_family'
       AND n.value#>>'{node_context,objective}'=p_context->>'objective'
       AND n.value#>>'{node_context,utility_context}'=p_context->>'utility_context'
       AND (n.value#>>'{node_context,table_size}')::integer=(p_context->>'table_size')::integer
       AND n.value#>>'{node_context,pot_type}'=p_context->>'pot_type'
       AND n.value#>>'{node_context,hero_position}'=p_context->>'hero_position'
       AND n.value#>>'{node_context,opponent_position}'=p_context->>'opponent_position'
       AND (n.value#>>'{node_context,depth_bucket}')::integer=(p_context->>'depth_bucket')::integer
       AND n.value#>>'{node_context,texture_class}'=p_context->>'texture_class'
       AND n.value#>>'{node_context,node_role}'=p_context->>'node_role'
       AND n.value#>>'{node_context,facing_kind}'=p_context->>'facing_kind'
       AND n.value#>>'{node_context,facing_size_bucket}'=p_context->>'facing_size_bucket'
  ), combo_observations AS MATERIALIZED (
    SELECT public.fn_gto_v31_hand_key(i,n.node#>>'{node_context,board}') AS hand_key,
           i,(n.node->'matchups'->>i)::numeric AS weight,
           (n.node->'policy_evs_bb'->>i)::numeric AS policy_ev,n.node
      FROM source_nodes n CROSS JOIN generate_series(0,1325) i
     WHERE n.split='train' AND (n.node->'matchups'->>i)::numeric>0
  ), action_observations AS MATERIALIZED (
    SELECT o.hand_key,a.key AS action_id,o.weight,
           (o.node->'frequencies'->a.key->>o.i)::numeric AS frequency,
           (o.node->'action_evs_bb'->a.key->>o.i)::numeric AS action_ev
      FROM combo_observations o CROSS JOIN LATERAL jsonb_each(v_specs) a
  ), action_aggregate AS (
    SELECT hand_key,action_id,
           sum(frequency*weight)/sum(weight) AS frequency,
           sum(action_ev*weight)/sum(weight) AS action_ev
      FROM action_observations GROUP BY hand_key,action_id
  ), per_hand AS (
    SELECT hand_key,
           jsonb_object_agg(action_id,to_jsonb(round(frequency,6)) ORDER BY action_id) AS mix,
           jsonb_object_agg(action_id,to_jsonb(round(action_ev,6)) ORDER BY action_id) AS action_evs
      FROM action_aggregate GROUP BY hand_key
  ), policy_aggregate AS (
    SELECT hand_key,sum(policy_ev*weight)/sum(weight) AS policy_ev
      FROM combo_observations GROUP BY hand_key
  )
  SELECT jsonb_object_agg(h.hand_key,h.mix ORDER BY h.hand_key),
         jsonb_object_agg(h.hand_key,to_jsonb(round(p.policy_ev,6)) ORDER BY h.hand_key),
         jsonb_object_agg(h.hand_key,h.action_evs ORDER BY h.hand_key)
    INTO v_hand_matrix,v_policy_evs,v_action_evs
    FROM per_hand h JOIN policy_aggregate p USING (hand_key);
  IF v_hand_matrix IS NULL OR v_policy_evs IS NULL OR v_action_evs IS NULL THEN
    RAISE EXCEPTION 'cell has no live training combinations';
  END IF;

  v_cell:=p_context||jsonb_build_object(
    'hand_matrix',v_hand_matrix,'action_specs',v_specs,
    'policy_ev_matrix',v_policy_evs,'action_ev_matrix',v_action_evs,
    'source_rows',v_source_rows,'train_source_rows',v_train_rows,
    'holdout_source_rows',v_holdout_rows,'lineage_checksum',v_lineage
  );
  v_cell:=v_cell||jsonb_build_object('cell_key_checksum',public.fn_gto_v31_cell_key_checksum(v_cell));
  v_cell:=v_cell||jsonb_build_object('cell_payload_checksum',public.fn_gto_v31_cell_payload_checksum(v_cell));
  IF NOT public.fn_gto_v31_cell_payload_valid(v_cell) THEN
    RAISE EXCEPTION 'database-computed compact cell failed its release validator';
  END IF;

  INSERT INTO public.gto_v31_runtime_cells (
    dataset_id,cell_key_checksum,street,game_family,objective,utility_context,
    table_size,pot_type,hero_position,opponent_position,depth_bucket,texture_class,
    node_role,facing_kind,facing_size_bucket,hand_matrix,action_specs,
    policy_ev_matrix,action_ev_matrix,source_rows,train_source_rows,
    holdout_source_rows,cell_payload_checksum,lineage_checksum
  ) VALUES (
    p_dataset_id,v_cell->>'cell_key_checksum',v_cell->>'street',v_cell->>'game_family',
    v_cell->>'objective',v_cell->>'utility_context',(v_cell->>'table_size')::smallint,
    v_cell->>'pot_type',v_cell->>'hero_position',v_cell->>'opponent_position',
    (v_cell->>'depth_bucket')::integer,v_cell->>'texture_class',v_cell->>'node_role',
    v_cell->>'facing_kind',v_cell->>'facing_size_bucket',v_cell->'hand_matrix',
    v_cell->'action_specs',v_cell->'policy_ev_matrix',v_cell->'action_ev_matrix',
    (v_cell->>'source_rows')::integer,(v_cell->>'train_source_rows')::integer,
    (v_cell->>'holdout_source_rows')::integer,v_cell->>'cell_payload_checksum',v_cell->>'lineage_checksum'
  );

  INSERT INTO public.gto_v31_cell_source_receipts (
    dataset_id,cell_id,source_row_id,source_node,source_node_checksum,
    source_artifact_checksum,machine_id,split
  )
  SELECT p_dataset_id,c.cell_id,a.source_row_id,n.value->>'node',n.value->>'node_checksum',
         a.source_artifact_checksum,a.machine_id,
         CASE WHEN a.machine_id='M2' THEN 'holdout' ELSE 'train' END
    FROM public.gto_v31_runtime_cells c
    JOIN public.gto_v31_source_artifacts a ON a.dataset_id=p_dataset_id
    JOIN public.solved_spots_gold s ON s.id=a.source_row_id
     AND s.quality_status='validated' AND s.source_artifact_checksum=a.source_artifact_checksum
    CROSS JOIN LATERAL jsonb_array_elements(s.strategy_matrix_v2->'nodes') n(value)
   WHERE c.dataset_id=p_dataset_id AND c.cell_key_checksum=v_cell->>'cell_key_checksum'
     AND n.value#>>'{node_context,street}'=p_context->>'street'
     AND n.value#>>'{node_context,game_family}'=p_context->>'game_family'
     AND n.value#>>'{node_context,objective}'=p_context->>'objective'
     AND n.value#>>'{node_context,utility_context}'=p_context->>'utility_context'
     AND (n.value#>>'{node_context,table_size}')::integer=(p_context->>'table_size')::integer
     AND n.value#>>'{node_context,pot_type}'=p_context->>'pot_type'
     AND n.value#>>'{node_context,hero_position}'=p_context->>'hero_position'
     AND n.value#>>'{node_context,opponent_position}'=p_context->>'opponent_position'
     AND (n.value#>>'{node_context,depth_bucket}')::integer=(p_context->>'depth_bucket')::integer
     AND n.value#>>'{node_context,texture_class}'=p_context->>'texture_class'
     AND n.value#>>'{node_context,node_role}'=p_context->>'node_role'
     AND n.value#>>'{node_context,facing_kind}'=p_context->>'facing_kind'
     AND n.value#>>'{node_context,facing_size_bucket}'=p_context->>'facing_size_bucket';
  IF NOT FOUND THEN RAISE EXCEPTION 'database-computed cell did not retain source receipts'; END IF;
  RETURN v_cell->>'cell_key_checksum';
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_build_cell(uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_build_cell(uuid,jsonb) TO service_role;

-- Caller-authored compact values and detached receipts were useful during
-- prototyping but are not release authorities. The production compactor can
-- submit only a declared context; PostgreSQL derives every value above.
DROP FUNCTION IF EXISTS public.fn_gto_v31_put_cells(uuid,jsonb);
DROP FUNCTION IF EXISTS public.fn_gto_v31_put_source_receipts(uuid,jsonb);

CREATE OR REPLACE FUNCTION public.fn_gto_v31_heldout_metrics(
  p_dataset_id uuid,
  p_game_family text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH holdout AS MATERIALIZED (
    SELECT r.source_row_id,r.source_node,c.cell_id,c.game_family,
           c.hand_matrix,c.action_specs,c.policy_ev_matrix,n.value AS node,i,
           public.fn_gto_v31_hand_key(i,n.value#>>'{node_context,board}') AS hand_key,
           (n.value->'matchups'->>i)::numeric AS weight
      FROM public.gto_v31_cell_source_receipts r
      JOIN public.gto_v31_runtime_cells c ON c.cell_id=r.cell_id
      JOIN public.solved_spots_gold s ON s.id=r.source_row_id
      CROSS JOIN LATERAL jsonb_array_elements(s.strategy_matrix_v2->'nodes') n(value)
      CROSS JOIN generate_series(0,1325) i
     WHERE r.dataset_id=p_dataset_id AND r.split='holdout'
       AND (p_game_family IS NULL OR c.game_family=p_game_family)
       AND n.value->>'node'=r.source_node
       AND n.value->>'node_checksum'=r.source_node_checksum
       AND (n.value->'matchups'->>i)::numeric>0
  ), action_observations AS MATERIALIZED (
    SELECT h.*,a.key AS action_id,a.value->>'family' AS action_family,
           CASE WHEN a.value->>'family' IN ('bet','raise')
                THEN (a.value->>'size_value')::numeric ELSE NULL END AS size_value,
           (h.node->'frequencies'->a.key->>h.i)::numeric AS source_frequency,
           (h.hand_matrix->h.hand_key->>a.key)::numeric AS compact_frequency,
           (h.node->'action_evs_bb'->a.key->>h.i)::numeric AS source_action_ev
      FROM holdout h CROSS JOIN LATERAL jsonb_each(h.action_specs) a
  ), per_combo AS MATERIALIZED (
    SELECT source_row_id,source_node,cell_id,game_family,i,hand_key,weight,
           max((node->'policy_evs_bb'->>i)::numeric) AS source_policy_ev,
           max((policy_ev_matrix->>hand_key)::numeric) AS compact_policy_ev,
           sum(source_frequency*COALESCE(size_value,0))
             FILTER (WHERE size_value IS NOT NULL) AS source_size,
           sum(compact_frequency*COALESCE(size_value,0))
             FILTER (WHERE size_value IS NOT NULL) AS compact_size,
           bool_or(size_value IS NOT NULL) AS sizing_eligible,
           max(source_action_ev) AS best_action_ev,
           sum(compact_frequency*source_action_ev) AS compact_mixed_ev,
           bool_and(compact_frequency IS NOT NULL AND source_action_ev IS NOT NULL)
             AS regret_eligible
      FROM action_observations
     GROUP BY source_row_id,source_node,cell_id,game_family,i,hand_key,weight
  )
  SELECT jsonb_build_object(
    'frequency_mae',(SELECT sum(abs(source_frequency-compact_frequency)*weight)/NULLIF(sum(weight),0)
      FROM action_observations),
    'sizing_mae',COALESCE((SELECT sum(abs(source_size-compact_size)*weight)/NULLIF(sum(weight),0)
      FROM per_combo WHERE sizing_eligible),0),
    'policy_ev_mae_bb',(SELECT sum(abs(source_policy_ev-compact_policy_ev)*weight)/NULLIF(sum(weight),0)
      FROM per_combo),
    'mean_action_regret_bb',(SELECT sum(greatest(0,best_action_ev-compact_mixed_ev)*weight)/NULLIF(sum(weight),0)
      FROM per_combo WHERE regret_eligible),
    'regret_coverage',(SELECT count(*)::numeric/NULLIF((SELECT count(*) FROM per_combo),0)
      FROM per_combo WHERE regret_eligible),
    'holdout_source_rows',(SELECT count(DISTINCT source_row_id) FROM holdout),
    'frequency_observations',(SELECT count(*) FROM action_observations),
    'sizing_observations',(SELECT count(*) FROM per_combo WHERE sizing_eligible),
    'policy_ev_observations',(SELECT count(*) FROM per_combo),
    'regret_observations',(SELECT count(*) FROM per_combo WHERE regret_eligible),
    'live_combo_observations',(SELECT count(*) FROM per_combo),
    'missing_observations',(SELECT count(*) FROM holdout WHERE hand_matrix->hand_key IS NULL
      OR policy_ev_matrix->hand_key IS NULL)
  );
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_heldout_metrics(uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_heldout_metrics(uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_seal_build(p_dataset_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_dataset public.gto_v31_datasets%ROWTYPE;
  v_cells bigint;
  v_source bigint;
  v_train bigint;
  v_holdout bigint;
  v_source_nodes bigint;
  v_receipts bigint;
  v_checksum text;
  v_source_checksum text;
  v_coverage jsonb;
  v_metrics jsonb;
  v_metric_checksum text;
  v_frequency_mae numeric;
  v_sizing_mae numeric;
  v_policy_mae numeric;
  v_regret numeric;
  v_regret_coverage numeric;
  v_frequency_observations bigint;
  v_sizing_observations bigint;
  v_policy_observations bigint;
  v_regret_observations bigint;
  v_live_observations bigint;
  v_missing bigint;
  v_pass boolean;
  v_family text;
  v_family_metrics jsonb;
  v_by_family jsonb := '{}'::jsonb;
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  SELECT * INTO v_dataset FROM public.gto_v31_datasets
   WHERE dataset_id=p_dataset_id AND state='building' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dataset is not building'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.gto_v31_input_bundles b
     WHERE b.input_bundle_id=v_dataset.input_bundle_id
       AND b.approval_status='approved' AND b.bundle_checksum=v_dataset.input_bundle_checksum
       AND b.range_bundle_checksum=v_dataset.range_bundle_checksum
       AND b.source_combo_order_checksum=v_dataset.source_combo_order_checksum
       AND b.icm_model_checksum=v_dataset.icm_model_checksum
  ) THEN RAISE EXCEPTION 'dataset input approval is absent or revoked'; END IF;

  SELECT count(*),COALESCE(sum(source_rows),0),COALESCE(sum(train_source_rows),0),
         COALESCE(sum(holdout_source_rows),0)
    INTO v_cells,v_source,v_train,v_holdout
    FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id;
  IF v_cells=0 OR jsonb_array_length(v_dataset.declared_coverage)<>v_cells
     OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(v_dataset.declared_coverage))<>v_cells
     OR EXISTS (
       SELECT 1 FROM public.gto_v31_runtime_cells c
        WHERE c.dataset_id=p_dataset_id AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(v_dataset.declared_coverage) d(value)
           WHERE d.value=jsonb_build_object(
             'street',c.street,'game_family',c.game_family,'objective',c.objective,
             'utility_context',c.utility_context,'table_size',c.table_size,
             'pot_type',c.pot_type,'hero_position',c.hero_position,
             'opponent_position',c.opponent_position,'depth_bucket',c.depth_bucket,
             'texture_class',c.texture_class,'node_role',c.node_role,
             'facing_kind',c.facing_kind,'facing_size_bucket',c.facing_size_bucket)))
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_dataset.declared_coverage) d(value)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.gto_v31_runtime_cells c WHERE c.dataset_id=p_dataset_id
           AND d.value=jsonb_build_object(
             'street',c.street,'game_family',c.game_family,'objective',c.objective,
             'utility_context',c.utility_context,'table_size',c.table_size,
             'pot_type',c.pot_type,'hero_position',c.hero_position,
             'opponent_position',c.opponent_position,'depth_bucket',c.depth_bucket,
             'texture_class',c.texture_class,'node_role',c.node_role,
             'facing_kind',c.facing_kind,'facing_size_bucket',c.facing_size_bucket))) THEN
    RAISE EXCEPTION 'runtime cells do not exactly equal declared coverage';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND street='flop')
     OR NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND street='turn')
     OR NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND street='river')
     OR NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND game_family='cash' AND objective='cash_ev')
     OR NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND game_family='spin' AND objective='chip_ev')
     OR NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND game_family='spin' AND objective='icm')
     OR NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND game_family='tourney_ev' AND objective='chip_ev')
     OR NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id AND game_family='tourney_icm' AND objective='icm')
     OR EXISTS (
       SELECT 1
         FROM (VALUES ('cash','cash_ev'),('spin','chip_ev'),('spin','icm'),
                      ('tourney_ev','chip_ev'),('tourney_icm','icm'))
              required_family(game_family,objective)
         CROSS JOIN unnest(ARRAY['flop','turn','river']) required_street(street)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.gto_v31_runtime_cells c
           WHERE c.dataset_id=p_dataset_id
             AND c.game_family=required_family.game_family
             AND c.objective=required_family.objective
             AND c.street=required_street.street))
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['limped','srp','3bet','4bet_plus']) required(value)
       WHERE NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells c WHERE c.dataset_id=p_dataset_id AND c.pot_type=required.value))
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['cash_ev','chip_ev','spin_ladder','satellite','bubble','final_table','in_money','ladder']) required(value)
       WHERE NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells c WHERE c.dataset_id=p_dataset_id AND c.utility_context=required.value))
     OR EXISTS (SELECT 1 FROM generate_series(2,10) required(value)
       WHERE NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells c WHERE c.dataset_id=p_dataset_id AND c.table_size=required.value))
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['open','cbet','probe','delayed_cbet','barrel','facing_bet','facing_raise','check_raise','bet_raise','all_in']) required(value)
       WHERE NOT EXISTS (SELECT 1 FROM public.gto_v31_runtime_cells c WHERE c.dataset_id=p_dataset_id AND c.node_role=required.value)) THEN
    RAISE EXCEPTION 'required Phase 4 street, family, utility, table, pot, or response coverage is incomplete';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.gto_v31_runtime_cells c
     WHERE c.dataset_id=p_dataset_id
       AND (c.cell_key_checksum<>public.fn_gto_v31_cell_key_checksum(to_jsonb(c))
         OR c.cell_payload_checksum<>public.fn_gto_v31_cell_payload_checksum(to_jsonb(c))
         OR c.source_rows<>c.train_source_rows+c.holdout_source_rows
         OR NOT public.fn_gto_v31_cell_payload_valid(to_jsonb(c)))
  ) THEN RAISE EXCEPTION 'a compact cell seal or payload no longer validates'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.gto_v31_runtime_cells c
    LEFT JOIN LATERAL (
      SELECT count(*) n,count(*) FILTER (WHERE r.split='train') train_n,
             count(*) FILTER (WHERE r.split='holdout') holdout_n,
             encode(digest(string_agg(r.source_row_id::text||':'||r.source_node||':'||
               r.source_node_checksum,'' ORDER BY r.source_row_id::text,r.source_node),'sha256'),'hex') lineage
        FROM public.gto_v31_cell_source_receipts r WHERE r.cell_id=c.cell_id
    ) x ON true
     WHERE c.dataset_id=p_dataset_id AND
       (x.n<>c.source_rows OR x.train_n<>c.train_source_rows OR x.holdout_n<>c.holdout_source_rows
        OR x.lineage IS DISTINCT FROM c.lineage_checksum)
  ) THEN RAISE EXCEPTION 'cell source receipts do not reconcile'; END IF;
  SELECT COALESCE(sum(node_count),0) INTO v_source_nodes
    FROM public.gto_v31_source_artifacts WHERE dataset_id=p_dataset_id;
  SELECT count(*) INTO v_receipts FROM public.gto_v31_cell_source_receipts WHERE dataset_id=p_dataset_id;
  IF v_source_nodes<>v_receipts OR v_source<>v_receipts
     OR EXISTS (
       SELECT 1 FROM public.gto_v31_source_artifacts a
       LEFT JOIN public.solved_spots_gold s ON s.id=a.source_row_id
        WHERE a.dataset_id=p_dataset_id AND (s.id IS NULL OR s.quality_status<>'validated'
          OR s.audited_at IS NULL OR s.source_artifact_checksum<>a.source_artifact_checksum
          OR s.source_artifact_checksum<>public.fn_gto_v31_source_artifact_checksum(s.scenario_hash,s.strategy_matrix_v2)
          OR s.solver_version<>v_dataset.solver_version
          OR s.solver_binary_checksum<>v_dataset.solver_binary_checksum
          OR s.machine_id<>a.machine_id OR s.pipeline_commit<>v_dataset.pipeline_commit
          OR s.pipeline_bundle_checksum<>v_dataset.pipeline_bundle_checksum
          OR s.manifest_version::text<>v_dataset.manifest_version
          OR s.manifest_checksum<>v_dataset.manifest_checksum)) THEN
    RAISE EXCEPTION 'source artifacts are missing, omitted, quarantined, or changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.gto_v31_cell_source_receipts WHERE dataset_id=p_dataset_id AND machine_id='M1')
     OR NOT EXISTS (SELECT 1 FROM public.gto_v31_cell_source_receipts WHERE dataset_id=p_dataset_id AND machine_id='M2') THEN
    RAISE EXCEPTION 'dataset provenance does not include both solver hosts';
  END IF;

  v_metrics:=public.fn_gto_v31_heldout_metrics(p_dataset_id,NULL);
  v_frequency_mae:=(v_metrics->>'frequency_mae')::numeric;
  v_sizing_mae:=(v_metrics->>'sizing_mae')::numeric;
  v_policy_mae:=(v_metrics->>'policy_ev_mae_bb')::numeric;
  v_regret:=(v_metrics->>'mean_action_regret_bb')::numeric;
  v_regret_coverage:=(v_metrics->>'regret_coverage')::numeric;
  v_frequency_observations:=COALESCE((v_metrics->>'frequency_observations')::bigint,0);
  v_sizing_observations:=COALESCE((v_metrics->>'sizing_observations')::bigint,0);
  v_policy_observations:=COALESCE((v_metrics->>'policy_ev_observations')::bigint,0);
  v_regret_observations:=COALESCE((v_metrics->>'regret_observations')::bigint,0);
  v_live_observations:=COALESCE((v_metrics->>'live_combo_observations')::bigint,0);
  v_missing:=COALESCE((v_metrics->>'missing_observations')::bigint,0);
  IF v_missing<>0 OR v_frequency_observations=0 OR v_policy_observations=0
     OR v_regret_observations=0 OR v_live_observations=0
     OR v_frequency_mae IS NULL OR v_sizing_mae IS NULL OR v_policy_mae IS NULL
     OR v_regret IS NULL OR v_regret_coverage IS NULL THEN
    RAISE EXCEPTION 'heldout observations are incomplete or absent';
  END IF;
  v_pass:=v_frequency_mae<=(v_dataset.quality_gates->>'max_frequency_mae')::numeric
    AND v_sizing_mae<=(v_dataset.quality_gates->>'max_sizing_mae')::numeric
    AND v_policy_mae<=(v_dataset.quality_gates->>'max_policy_ev_mae_bb')::numeric
    AND v_regret<=(v_dataset.quality_gates->>'max_action_regret_bb')::numeric
    AND v_regret_coverage>=(v_dataset.quality_gates->>'min_regret_coverage')::numeric;

  FOREACH v_family IN ARRAY ARRAY['cash','spin','tourney_ev','tourney_icm'] LOOP
    v_family_metrics:=public.fn_gto_v31_heldout_metrics(p_dataset_id,v_family);
    IF COALESCE((v_family_metrics->>'frequency_observations')::bigint,0)=0
       OR COALESCE((v_family_metrics->>'policy_ev_observations')::bigint,0)=0
       OR COALESCE((v_family_metrics->>'regret_observations')::bigint,0)=0
       OR COALESCE((v_family_metrics->>'missing_observations')::bigint,0)<>0 THEN
      RAISE EXCEPTION 'heldout observations are incomplete for family %',v_family;
    END IF;
    v_family_metrics:=v_family_metrics||jsonb_build_object('validated',
      (v_family_metrics->>'frequency_mae')::numeric<=(v_dataset.quality_gates->>'max_frequency_mae')::numeric
      AND (v_family_metrics->>'sizing_mae')::numeric<=(v_dataset.quality_gates->>'max_sizing_mae')::numeric
      AND (v_family_metrics->>'policy_ev_mae_bb')::numeric<=(v_dataset.quality_gates->>'max_policy_ev_mae_bb')::numeric
      AND (v_family_metrics->>'mean_action_regret_bb')::numeric<=(v_dataset.quality_gates->>'max_action_regret_bb')::numeric
      AND (v_family_metrics->>'regret_coverage')::numeric>=(v_dataset.quality_gates->>'min_regret_coverage')::numeric);
    v_pass:=v_pass AND (v_family_metrics->>'validated')::boolean;
    v_by_family:=v_by_family||jsonb_build_object(v_family,v_family_metrics);
  END LOOP;

  v_metrics:=v_metrics||jsonb_build_object('validated',v_pass,'by_family',v_by_family);
  v_metric_checksum:=public.fn_gto_v31_json_checksum(v_metrics);
  v_metrics:=v_metrics||jsonb_build_object('metrics_checksum',v_metric_checksum);

  SELECT jsonb_build_object('cells',count(*),'streets',jsonb_agg(DISTINCT street),
    'families',jsonb_agg(DISTINCT game_family||':'||objective),
    'utility_contexts',jsonb_agg(DISTINCT utility_context),
    'table_sizes',jsonb_agg(DISTINCT table_size),'pot_types',jsonb_agg(DISTINCT pot_type),
    'node_roles',jsonb_agg(DISTINCT node_role),'complete',true)
    INTO v_coverage FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id;
  SELECT encode(digest(string_agg(DISTINCT source_artifact_checksum,'' ORDER BY source_artifact_checksum),'sha256'),'hex')
    INTO v_source_checksum FROM public.gto_v31_source_artifacts WHERE dataset_id=p_dataset_id;
  SELECT encode(digest(v_dataset.dataset_key||':'||v_dataset.pipeline_bundle_checksum||':'||
    v_dataset.manifest_checksum||':'||
    v_dataset.input_bundle_checksum||':'||string_agg(cell_key_checksum||':'||
      cell_payload_checksum||':'||lineage_checksum,'' ORDER BY cell_key_checksum),'sha256'),'hex')
    INTO v_checksum FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id;

  UPDATE public.gto_v31_datasets SET
    state=CASE WHEN v_pass THEN 'evaluating' ELSE 'rejected' END,
    quality_status=CASE WHEN v_pass THEN 'validated' ELSE 'rejected' END,
    source_rows=v_source,train_source_rows=v_train,holdout_source_rows=v_holdout,
    invalid_rows=0,source_artifact_checksum=v_source_checksum,dataset_checksum=v_checksum,
    coverage=v_coverage,heldout_metrics=v_metrics,sealed_at=now(),audited_at=now()
   WHERE dataset_id=p_dataset_id;
  INSERT INTO public.gto_v31_release_evaluations (
    dataset_id,dataset_checksum,evaluation_kind,game_family,verdict,metrics,result_checksum
  ) VALUES (
    p_dataset_id,v_checksum,'heldout','all',CASE WHEN v_pass THEN 'pass' ELSE 'fail' END,
    v_metrics,public.fn_gto_v31_json_checksum(jsonb_build_object(
      'dataset_checksum',v_checksum,'kind','heldout','family','all','metrics',v_metrics))
  );
  RETURN v_checksum;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_seal_build(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_seal_build(uuid) TO service_role;

-- The caller cannot author compact cells, detached source receipts, or
-- release verdicts. PostgreSQL owns all three through the guarded functions below.

CREATE OR REPLACE FUNCTION public.fn_gto_v31_record_evaluation(
  p_dataset_id uuid,
  p_evaluation_kind text,
  p_game_family text,
  p_source_result_id bigint
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_dataset public.gto_v31_datasets%ROWTYPE;
  v_result public.horse_league_results%ROWTYPE;
  v_incumbent text;
  v_verdict text;
  v_metrics jsonb;
  v_checksum text;
  v_id uuid;
  v_expected_scenarios text[];
  v_expected_profile text;
  v_actual_scenarios text[];
  v_component_hands bigint;
  v_component_hits bigint;
  v_component_duration bigint;
  v_component_bb100 numeric;
  v_component_stderr numeric;
  v_component_roles text[];
  v_result_roles text[];
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  IF p_evaluation_kind NOT IN ('paired_replay','league')
     OR p_game_family NOT IN ('cash','spin','tourney_ev','tourney_icm') THEN
    RAISE EXCEPTION 'evaluation kind or family is invalid';
  END IF;
  SELECT * INTO v_dataset FROM public.gto_v31_datasets
   WHERE dataset_id=p_dataset_id AND state='evaluating' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dataset is not awaiting evaluation'; END IF;
  SELECT COALESCE((SELECT dataset_checksum FROM public.gto_v31_datasets
    WHERE state='active' AND dataset_id<>p_dataset_id LIMIT 1),'legacy_v30') INTO v_incumbent;
  SELECT * INTO v_result FROM public.horse_league_results WHERE id=p_source_result_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'league result does not exist'; END IF;
  v_expected_scenarios:=CASE p_game_family
    WHEN 'cash' THEN ARRAY['cash_ev']::text[]
    WHEN 'spin' THEN ARRAY['chip_ev','spin_ladder']::text[]
    WHEN 'tourney_ev' THEN ARRAY['chip_ev']::text[]
    ELSE ARRAY['satellite','bubble','final_table','in_money','ladder']::text[]
  END;
  v_expected_profile:=CASE p_evaluation_kind
    WHEN 'paired_replay' THEN 'policy_only_duplicate_deals'
    ELSE 'full_brain_duplicate_deal_league'
  END;

  IF jsonb_typeof(v_result.config_a)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(v_result.config_a))<>7
     OR NOT (v_result.config_a ?& ARRAY['evaluation_contract','evaluation_kind',
       'game_family','dataset_checksum','candidate','evaluation_profile','scenarios']::text[])
     OR jsonb_typeof(v_result.config_b)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(v_result.config_b))<>2
     OR NOT (v_result.config_b ?& ARRAY['incumbent_dataset_checksum','candidate']::text[])
     OR jsonb_typeof(v_result.config_a->'scenarios')<>'array'
     OR v_result.config_a->'scenarios' IS DISTINCT FROM to_jsonb(v_expected_scenarios)
     OR v_result.config_a->>'evaluation_profile'<>v_expected_profile THEN
    RAISE EXCEPTION 'evaluation configuration is incomplete or aliases another test profile';
  END IF;

  IF jsonb_array_length(v_result.candidate_benchmark_components)<>array_length(v_expected_scenarios,1)
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_result.candidate_benchmark_components) component(value)
        WHERE jsonb_typeof(component.value)<>'object'
          OR (SELECT count(*) FROM jsonb_object_keys(component.value))<>9
          OR NOT (component.value ?& ARRAY['scenario','hands','bb100','stderr','duration_ms',
            'illegal_actions','truncated_streets','candidate_policy_hits',
            'candidate_node_roles']::text[])
          OR jsonb_typeof(component.value->'scenario')<>'string'
          OR COALESCE(component.value->>'hands','')!~'^[1-9][0-9]*$'
          OR jsonb_typeof(component.value->'bb100')<>'number'
          OR jsonb_typeof(component.value->'stderr')<>'number'
          OR (component.value->>'stderr')::numeric<0
          OR COALESCE(component.value->>'duration_ms','')!~'^[1-9][0-9]*$'
          OR COALESCE(component.value->>'illegal_actions','')!~'^[0-9]+$'
          OR (component.value->>'illegal_actions')::bigint<>0
          OR COALESCE(component.value->>'truncated_streets','')!~'^[0-9]+$'
          OR (component.value->>'truncated_streets')::bigint<>0
          OR COALESCE(component.value->>'candidate_policy_hits','')!~'^[1-9][0-9]*$'
          OR jsonb_typeof(component.value->'candidate_node_roles')<>'array'
          OR jsonb_array_length(component.value->'candidate_node_roles')=0
          OR jsonb_array_length(component.value->'candidate_node_roles')<>(
            SELECT count(DISTINCT role.value)
              FROM jsonb_array_elements_text(component.value->'candidate_node_roles') role(value))
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(component.value->'candidate_node_roles') role(value)
             WHERE role.value NOT IN ('open','cbet','probe','delayed_cbet','barrel',
               'facing_bet','facing_raise','check_raise','bet_raise','all_in'))
     ) THEN
    RAISE EXCEPTION 'benchmark components do not carry exact scenario and decision evidence';
  END IF;

  SELECT array_agg(component.value->>'scenario' ORDER BY component.ordinality),
         sum((component.value->>'hands')::bigint),
         sum((component.value->>'candidate_policy_hits')::bigint),
         sum((component.value->>'duration_ms')::bigint),
         sum((component.value->>'bb100')::numeric*(component.value->>'hands')::numeric)
           /sum((component.value->>'hands')::numeric),
         sqrt(sum(power((component.value->>'stderr')::numeric*
           (component.value->>'hands')::numeric,2)))
           /sum((component.value->>'hands')::numeric)
    INTO v_actual_scenarios,v_component_hands,v_component_hits,v_component_duration,
         v_component_bb100,v_component_stderr
    FROM jsonb_array_elements(v_result.candidate_benchmark_components)
      WITH ORDINALITY component(value,ordinality);
  SELECT array_agg(DISTINCT role.value ORDER BY role.value)
    INTO v_component_roles
    FROM jsonb_array_elements(v_result.candidate_benchmark_components) component(value)
    CROSS JOIN LATERAL jsonb_array_elements_text(component.value->'candidate_node_roles') role(value);
  SELECT array_agg(DISTINCT role.value ORDER BY role.value) INTO v_result_roles
    FROM unnest(v_result.candidate_node_roles) role(value);

  IF v_result.run_date<current_date-2 OR v_result.run_date>current_date
     OR v_result.hands<10000 OR v_result.illegal_actions<>0 OR v_result.truncated_streets<>0
     OR v_result.candidate_policy_hits<=0
     OR COALESCE(array_length(v_result.candidate_node_roles,1),0)<=0
     OR v_actual_scenarios IS DISTINCT FROM v_expected_scenarios
     OR v_component_hands<>v_result.hands
     OR v_component_hits<>v_result.candidate_policy_hits
     OR v_component_duration<>v_result.duration_ms
     OR abs(v_component_bb100-v_result.bb100)>0.000001
     OR abs(v_component_stderr-v_result.stderr)>0.000001
     OR v_component_roles IS DISTINCT FROM v_result_roles
     OR COALESCE(array_length(v_result.candidate_node_roles,1),0)<>
        COALESCE(array_length(v_result_roles,1),0)
     OR EXISTS (SELECT 1 FROM unnest(v_result.candidate_node_roles) role(value)
       WHERE role.value NOT IN ('open','cbet','probe','delayed_cbet','barrel',
         'facing_bet','facing_raise','check_raise','bet_raise','all_in'))
     OR v_result.duration_ms<=0 OR v_result.stderr<0
     OR v_result.matchup<>'gto_v31_'||p_evaluation_kind||'_'||p_game_family||'_'||left(v_dataset.dataset_checksum,12)
     OR v_result.config_a->>'evaluation_contract'<>'gto_v31_candidate.v1'
     OR v_result.config_a->>'evaluation_kind'<>p_evaluation_kind
     OR v_result.config_a->>'game_family'<>p_game_family
     OR v_result.config_a->>'dataset_checksum'<>v_dataset.dataset_checksum
     OR v_result.config_a->>'candidate'<>'v31_certified'
     OR v_result.config_b->>'incumbent_dataset_checksum'<>v_incumbent
     OR v_result.config_b->>'candidate'<>'incumbent' THEN
    RAISE EXCEPTION 'league result is stale, unsafe, or not bound to this candidate and incumbent';
  END IF;
  v_verdict:=CASE WHEN v_result.bb100>2*v_result.stderr THEN 'win'
                  WHEN v_result.bb100<(-2*v_result.stderr) THEN 'loss' ELSE 'tie' END;
  v_metrics:=jsonb_build_object('source_result_id',v_result.id,'run_date',v_result.run_date,
    'matchup',v_result.matchup,'hands',v_result.hands,'bb100',v_result.bb100,
    'stderr',v_result.stderr,'illegal_actions',v_result.illegal_actions,
    'truncated_streets',v_result.truncated_streets,'duration_ms',v_result.duration_ms,
    'candidate_policy_hits',v_result.candidate_policy_hits,
    'candidate_node_roles',v_result.candidate_node_roles,
    'benchmark_components',v_result.candidate_benchmark_components,
    'candidate_config',v_result.config_a,'incumbent_config',v_result.config_b);
  v_checksum:=public.fn_gto_v31_json_checksum(jsonb_build_object(
    'dataset_checksum',v_dataset.dataset_checksum,'kind',p_evaluation_kind,
    'family',p_game_family,'verdict',v_verdict,'metrics',v_metrics));
  INSERT INTO public.gto_v31_release_evaluations (
    dataset_id,dataset_checksum,evaluation_kind,game_family,verdict,metrics,
    source_result_id,result_checksum
  ) VALUES (
    p_dataset_id,v_dataset.dataset_checksum,p_evaluation_kind,p_game_family,
    v_verdict,v_metrics,p_source_result_id,v_checksum
  ) ON CONFLICT (dataset_id,evaluation_kind,game_family) DO NOTHING
  RETURNING evaluation_id INTO v_id;
  IF v_id IS NULL THEN
    SELECT evaluation_id INTO v_id FROM public.gto_v31_release_evaluations
     WHERE dataset_id=p_dataset_id AND evaluation_kind=p_evaluation_kind
       AND game_family=p_game_family AND result_checksum=v_checksum;
    IF v_id IS NULL THEN RAISE EXCEPTION 'an evaluation receipt already exists with another result'; END IF;
  END IF;
  RETURN v_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_record_evaluation(uuid,text,text,bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_record_evaluation(uuid,text,text,bigint)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_mark_candidate(p_dataset_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_dataset public.gto_v31_datasets%ROWTYPE;
  v_paired jsonb;
  v_league jsonb;
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  SELECT * INTO v_dataset FROM public.gto_v31_datasets
   WHERE dataset_id=p_dataset_id AND state='evaluating' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dataset is not awaiting evaluation'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.gto_v31_input_bundles b
      WHERE b.input_bundle_id=v_dataset.input_bundle_id AND b.approval_status='approved'
        AND b.bundle_checksum=v_dataset.input_bundle_checksum)
     OR NOT EXISTS (SELECT 1 FROM public.gto_v31_release_evaluations e
      WHERE e.dataset_id=p_dataset_id AND e.dataset_checksum=v_dataset.dataset_checksum
        AND e.evaluation_kind='heldout' AND e.game_family='all' AND e.verdict='pass')
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['cash','spin','tourney_ev','tourney_icm']) family(value)
      WHERE NOT EXISTS (SELECT 1 FROM public.gto_v31_release_evaluations e
        WHERE e.dataset_id=p_dataset_id AND e.dataset_checksum=v_dataset.dataset_checksum
          AND e.evaluation_kind='paired_replay' AND e.game_family=family.value
          AND e.verdict IN ('win','tie')))
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['cash','spin','tourney_ev','tourney_icm']) family(value)
      WHERE NOT EXISTS (SELECT 1 FROM public.gto_v31_release_evaluations e
        WHERE e.dataset_id=p_dataset_id AND e.dataset_checksum=v_dataset.dataset_checksum
          AND e.evaluation_kind='league' AND e.game_family=family.value
          AND e.verdict IN ('win','tie')))
     OR EXISTS (
       SELECT 1
         FROM unnest(ARRAY['paired_replay','league']) required_kind(value)
         CROSS JOIN unnest(ARRAY['open','cbet','probe','delayed_cbet','barrel',
           'facing_bet','facing_raise','check_raise','bet_raise','all_in']) required_role(value)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.gto_v31_release_evaluations e
          CROSS JOIN LATERAL jsonb_array_elements_text(e.metrics->'candidate_node_roles') seen(value)
           WHERE e.dataset_id=p_dataset_id AND e.dataset_checksum=v_dataset.dataset_checksum
             AND e.evaluation_kind=required_kind.value AND e.verdict IN ('win','tie')
             AND seen.value=required_role.value)) THEN
    RAISE EXCEPTION 'candidate is missing an approved heldout, paired replay, or league gate';
  END IF;
  SELECT jsonb_build_object('verdict','pass','evaluations',jsonb_agg(to_jsonb(e) ORDER BY e.game_family))
    INTO v_paired FROM public.gto_v31_release_evaluations e
   WHERE e.dataset_id=p_dataset_id AND e.evaluation_kind='paired_replay';
  SELECT jsonb_build_object('verdict','pass','evaluations',jsonb_agg(to_jsonb(e) ORDER BY e.game_family))
    INTO v_league FROM public.gto_v31_release_evaluations e
   WHERE e.dataset_id=p_dataset_id AND e.evaluation_kind='league';
  UPDATE public.gto_v31_datasets SET state='candidate',paired_replay=v_paired,
    league_gate=v_league,candidate_at=now(),audited_at=now()
   WHERE dataset_id=p_dataset_id;
  RETURN v_dataset.dataset_checksum;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_mark_candidate(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_mark_candidate(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_promote_dataset(p_dataset_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_dataset public.gto_v31_datasets%ROWTYPE;
  v_expected_checksum text;
  v_expected_source_checksum text;
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  SELECT * INTO v_dataset FROM public.gto_v31_datasets
   WHERE dataset_id=p_dataset_id AND state='candidate' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dataset is not a candidate'; END IF;
  SELECT encode(digest(v_dataset.dataset_key||':'||v_dataset.pipeline_bundle_checksum||':'||
    v_dataset.manifest_checksum||':'||
    v_dataset.input_bundle_checksum||':'||string_agg(cell_key_checksum||':'||
      cell_payload_checksum||':'||lineage_checksum,'' ORDER BY cell_key_checksum),'sha256'),'hex')
    INTO v_expected_checksum FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id;
  SELECT encode(digest(string_agg(DISTINCT source_artifact_checksum,'' ORDER BY source_artifact_checksum),'sha256'),'hex')
    INTO v_expected_source_checksum FROM public.gto_v31_source_artifacts WHERE dataset_id=p_dataset_id;
  IF v_dataset.quality_status <> 'validated' OR v_dataset.invalid_rows <> 0
     OR v_dataset.dataset_checksum IS NULL OR v_dataset.source_artifact_checksum IS NULL
     OR v_dataset.dataset_checksum IS DISTINCT FROM v_expected_checksum
     OR v_dataset.source_artifact_checksum IS DISTINCT FROM v_expected_source_checksum
     OR COALESCE((v_dataset.coverage->>'complete')::boolean,false) IS NOT true
     OR COALESCE((v_dataset.heldout_metrics->>'frequency_mae')::numeric,99) > (v_dataset.quality_gates->>'max_frequency_mae')::numeric
     OR COALESCE((v_dataset.heldout_metrics->>'sizing_mae')::numeric,99) > (v_dataset.quality_gates->>'max_sizing_mae')::numeric
     OR COALESCE((v_dataset.heldout_metrics->>'policy_ev_mae_bb')::numeric,99) > (v_dataset.quality_gates->>'max_policy_ev_mae_bb')::numeric
     OR COALESCE((v_dataset.heldout_metrics->>'mean_action_regret_bb')::numeric,99) > (v_dataset.quality_gates->>'max_action_regret_bb')::numeric
     OR COALESCE((v_dataset.heldout_metrics->>'regret_coverage')::numeric,-1) < (v_dataset.quality_gates->>'min_regret_coverage')::numeric
     OR v_dataset.paired_replay->>'verdict'<>'pass'
     OR v_dataset.league_gate->>'verdict'<>'pass'
     OR NOT EXISTS (SELECT 1 FROM public.gto_v31_input_bundles b
       WHERE b.input_bundle_id=v_dataset.input_bundle_id AND b.approval_status='approved'
         AND b.bundle_checksum=v_dataset.input_bundle_checksum)
     OR (SELECT count(*) FROM public.gto_v31_release_evaluations e
       WHERE e.dataset_id=p_dataset_id AND e.dataset_checksum=v_dataset.dataset_checksum
         AND ((e.evaluation_kind='heldout' AND e.game_family='all' AND e.verdict='pass')
           OR (e.evaluation_kind IN ('paired_replay','league') AND e.game_family IN
             ('cash','spin','tourney_ev','tourney_icm') AND e.verdict IN ('win','tie'))))<>9 THEN
    RAISE EXCEPTION 'candidate does not meet its protected promotion gates';
  END IF;

  UPDATE public.gto_v31_datasets SET state='retired', retired_at=now()
   WHERE state='active' AND dataset_id <> p_dataset_id;
  UPDATE public.gto_v31_datasets SET state='active', promoted_at=now()
   WHERE dataset_id=p_dataset_id;
  RETURN v_dataset.dataset_checksum;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_promote_dataset(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_promote_dataset(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_active_cells(p_offset integer DEFAULT 0, p_limit integer DEFAULT 500)
RETURNS TABLE (
  dataset_id uuid, dataset_key text, dataset_checksum text,
  solver_version text, solver_binary_checksum text, pipeline_commit text,
  pipeline_bundle_checksum text,
  manifest_version text, manifest_checksum text, source_artifact_checksum text,
  source_combo_order_checksum text, range_bundle_checksum text,
  icm_model_checksum text, input_bundle_checksum text,
  cell_key_checksum text, cell_payload_checksum text, lineage_checksum text,
  quality_status text, dataset_state text, dataset_cells bigint, source_rows bigint,
  train_source_rows bigint, holdout_source_rows bigint, invalid_rows bigint,
  audited_at timestamptz, street text, game_family text, objective text,
  utility_context text, table_size smallint, pot_type text,
  hero_position text, opponent_position text, depth_bucket integer,
  texture_class text, node_role text, facing_kind text, facing_size_bucket text,
  hand_matrix jsonb, action_specs jsonb, policy_ev_matrix jsonb, action_ev_matrix jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT d.dataset_id, d.dataset_key, d.dataset_checksum,
         d.solver_version, d.solver_binary_checksum, d.pipeline_commit,
         d.pipeline_bundle_checksum,
         d.manifest_version, d.manifest_checksum, d.source_artifact_checksum,
         d.source_combo_order_checksum, d.range_bundle_checksum,
         d.icm_model_checksum,d.input_bundle_checksum,
         c.cell_key_checksum, c.cell_payload_checksum, c.lineage_checksum,
         d.quality_status, d.state, (d.coverage->>'cells')::bigint,
         d.source_rows, d.train_source_rows, d.holdout_source_rows,
         d.invalid_rows, d.audited_at,
         c.street, c.game_family, c.objective, c.utility_context, c.table_size,
         c.pot_type, c.hero_position, c.opponent_position,
         c.depth_bucket, c.texture_class, c.node_role, c.facing_kind,
         c.facing_size_bucket, c.hand_matrix, c.action_specs,
         c.policy_ev_matrix, c.action_ev_matrix
    FROM public.gto_v31_datasets d
    JOIN public.gto_v31_input_bundles b ON b.input_bundle_id=d.input_bundle_id
     AND b.approval_status='approved' AND b.bundle_checksum=d.input_bundle_checksum
    JOIN public.gto_v31_runtime_cells c ON c.dataset_id=d.dataset_id
   WHERE d.state='active' AND d.quality_status='validated' AND d.invalid_rows=0
     AND d.dataset_checksum IS NOT NULL AND d.source_artifact_checksum IS NOT NULL
   ORDER BY c.street, c.game_family, c.objective, c.utility_context, c.table_size,
            c.pot_type, c.hero_position, c.opponent_position, c.depth_bucket,
            c.texture_class, c.node_role,
            c.facing_kind, c.facing_size_bucket
   OFFSET greatest(COALESCE(p_offset,0),0)
   LIMIT greatest(1,least(COALESCE(p_limit,500),500));
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_active_cells(integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_active_cells(integer,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_evaluation_cells(
  p_dataset_id uuid,
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 500
)
RETURNS TABLE (
  dataset_id uuid, dataset_key text, dataset_checksum text,
  solver_version text, solver_binary_checksum text, pipeline_commit text,
  pipeline_bundle_checksum text,
  manifest_version text, manifest_checksum text, source_artifact_checksum text,
  source_combo_order_checksum text, range_bundle_checksum text,
  icm_model_checksum text, input_bundle_checksum text,
  cell_key_checksum text, cell_payload_checksum text, lineage_checksum text,
  quality_status text, dataset_state text, dataset_cells bigint, source_rows bigint,
  train_source_rows bigint, holdout_source_rows bigint, invalid_rows bigint,
  audited_at timestamptz, street text, game_family text, objective text,
  utility_context text, table_size smallint, pot_type text,
  hero_position text, opponent_position text, depth_bucket integer,
  texture_class text, node_role text, facing_kind text, facing_size_bucket text,
  hand_matrix jsonb, action_specs jsonb, policy_ev_matrix jsonb, action_ev_matrix jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT d.dataset_id,d.dataset_key,d.dataset_checksum,d.solver_version,
         d.solver_binary_checksum,d.pipeline_commit,d.pipeline_bundle_checksum,
         d.manifest_version,
         d.manifest_checksum,d.source_artifact_checksum,
         d.source_combo_order_checksum,d.range_bundle_checksum,d.icm_model_checksum,
         d.input_bundle_checksum,c.cell_key_checksum,c.cell_payload_checksum,
         c.lineage_checksum,d.quality_status,d.state,(d.coverage->>'cells')::bigint,
         d.source_rows,d.train_source_rows,d.holdout_source_rows,d.invalid_rows,
         d.audited_at,c.street,c.game_family,c.objective,c.utility_context,
         c.table_size,c.pot_type,c.hero_position,c.opponent_position,c.depth_bucket,
         c.texture_class,c.node_role,c.facing_kind,c.facing_size_bucket,
         c.hand_matrix,c.action_specs,c.policy_ev_matrix,c.action_ev_matrix
    FROM public.gto_v31_datasets d
    JOIN public.gto_v31_input_bundles b ON b.input_bundle_id=d.input_bundle_id
     AND b.approval_status='approved' AND b.bundle_checksum=d.input_bundle_checksum
    JOIN public.gto_v31_runtime_cells c ON c.dataset_id=d.dataset_id
   WHERE d.dataset_id=p_dataset_id AND d.state IN ('evaluating','candidate')
     AND d.quality_status='validated' AND d.invalid_rows=0
     AND d.dataset_checksum IS NOT NULL AND d.source_artifact_checksum IS NOT NULL
   ORDER BY c.street,c.game_family,c.objective,c.utility_context,c.table_size,
     c.pot_type,c.hero_position,c.opponent_position,c.depth_bucket,c.texture_class,
     c.node_role,c.facing_kind,c.facing_size_bucket
   OFFSET greatest(COALESCE(p_offset,0),0)
   LIMIT greatest(1,least(COALESCE(p_limit,500),500));
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_evaluation_cells(uuid,integer,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_evaluation_cells(uuid,integer,integer)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fn_audit_gto_v31_certified(p_day date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_result jsonb := '[]'::jsonb;
  v_dataset public.gto_v31_datasets%ROWTYPE;
  v_latest jsonb;
BEGIN
  SELECT * INTO v_dataset FROM public.gto_v31_datasets WHERE state='active' LIMIT 1;
  IF NOT FOUND THEN
    SELECT jsonb_build_object(
      'dataset_key',d.dataset_key,'state',d.state,'quality_status',d.quality_status,
      'source_rows',d.source_rows,'train_source_rows',d.train_source_rows,
      'holdout_source_rows',d.holdout_source_rows,'invalid_rows',d.invalid_rows,
      'runtime_cells',(SELECT count(*) FROM public.gto_v31_runtime_cells c
        WHERE c.dataset_id=d.dataset_id),
      'declared_cells',jsonb_array_length(d.declared_coverage),
      'coverage',d.coverage,'heldout_metrics',d.heldout_metrics,
      'input_approval_status',b.approval_status,
      'evaluation_receipts',(SELECT count(*) FROM public.gto_v31_release_evaluations e
        WHERE e.dataset_id=d.dataset_id),
      'passing_release_receipts',(SELECT count(*) FROM public.gto_v31_release_evaluations e
        WHERE e.dataset_id=d.dataset_id AND e.verdict IN ('pass','win','tie')),
      'created_at',d.created_at,'sealed_at',d.sealed_at,'candidate_at',d.candidate_at
    ) INTO v_latest
      FROM public.gto_v31_datasets d
      JOIN public.gto_v31_input_bundles b ON b.input_bundle_id=d.input_bundle_id
     ORDER BY d.created_at DESC LIMIT 1;
    RETURN jsonb_build_array(jsonb_build_object(
      'severity','critical','category','gto','code','certified_v31_missing',
      'title','No certified V31 solver dataset is active',
      'evidence',jsonb_build_object('day',p_day,'latest_dataset',v_latest),
      'recommendation','Keep the legacy response inference labeled derived. Restore both solver hosts, generate sealed source rows, pass held-out, paired replay and league gates, then promote exactly one dataset.'
    ));
  END IF;
  IF v_dataset.invalid_rows <> 0 OR v_dataset.quality_status <> 'validated'
     OR v_dataset.dataset_checksum IS NULL OR v_dataset.source_artifact_checksum IS NULL THEN
    v_result := v_result || jsonb_build_object(
      'severity','critical','category','gto','code','certified_v31_invalid',
      'title','The active V31 dataset is not fully sealed',
      'evidence',jsonb_build_object('dataset',v_dataset.dataset_key,'invalid_rows',v_dataset.invalid_rows,'quality',v_dataset.quality_status),
      'recommendation','Retire the dataset and fall back. An active cell may never be served without complete source and dataset checksums.'
    );
  ELSE
    v_result := v_result || jsonb_build_object(
      'severity','info','category','gto','code','certified_v31_active',
      'title','Certified V31 dataset is active',
      'evidence',jsonb_build_object('dataset',v_dataset.dataset_key,'checksum',v_dataset.dataset_checksum,'coverage',v_dataset.coverage,'heldout',v_dataset.heldout_metrics),
      'recommendation','Continue daily decision-level agreement and worker-liveness checks.'
    );
  END IF;
  RETURN v_result;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_audit_gto_v31_certified(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_audit_gto_v31_certified(date) TO service_role;

COMMENT ON TABLE public.gto_v31_datasets IS
  'Phase 4 certified solver releases. Exactly one active dataset; candidate promotion requires complete source receipts, independent holdout metrics, paired replay and league gates.';
COMMENT ON TABLE public.gto_v31_runtime_cells IS
  'Sealed suit-aware NLH postflop cells keyed by exact node semantics, objective, both positions, depth and texture. Runtime reads only through fn_gto_v31_active_cells.';
COMMENT ON TABLE public.gto_v31_cell_source_receipts IS
  'Database-verified lineage from each compact cell back to certified solved_spots_gold rows and explicit v3 source nodes. M1 is the build source and independently solved M2 artifacts are the holdout.';

COMMIT;
