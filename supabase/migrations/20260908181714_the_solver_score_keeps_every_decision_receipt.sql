-- ==========================================================================
-- THE SOLVER SCORE KEEPS EVERY DECISION RECEIPT
--
-- A nightly average without its denominator is not auditable. Persist the
-- exact state, final action, reference distribution, regret availability and
-- source seal for every eligible decision, then derive and reconcile the
-- summary inside the database. Historical summary-only rows remain visible
-- but are explicitly unreconciled until that day is re-run.
-- ==========================================================================

BEGIN;

ALTER TABLE public.horse_solver_agreement
  ADD COLUMN IF NOT EXISTS eligible_spots integer NOT NULL DEFAULT 0 CHECK (eligible_spots >= 0),
  ADD COLUMN IF NOT EXISTS reconciled_spots integer NOT NULL DEFAULT 0 CHECK (reconciled_spots >= 0),
  ADD COLUMN IF NOT EXISTS action_regret_bb numeric CHECK (action_regret_bb IS NULL OR action_regret_bb >= 0),
  ADD COLUMN IF NOT EXISTS regret_eligible_spots integer NOT NULL DEFAULT 0 CHECK (regret_eligible_spots >= 0),
  ADD COLUMN IF NOT EXISTS decision_checksum text CHECK (decision_checksum IS NULL OR decision_checksum ~ '^[0-9a-f]{64}$');

CREATE TABLE IF NOT EXISTS public.horse_solver_agreement_decisions (
  run_date                    date NOT NULL,
  reference                   text NOT NULL,
  state_key                   text NOT NULL CHECK (length(state_key) BETWEEN 8 AND 256),
  decision_state              jsonb NOT NULL CHECK (jsonb_typeof(decision_state) = 'object'),
  kind                        text NOT NULL CHECK (kind IN ('open_jam','bb_defend')),
  game_type                   text NOT NULL CHECK (game_type IN ('Cash','Tournament')),
  position                    text NOT NULL CHECK (position IN ('UTG','MP','HJ','CO','BTN','SB','BB')),
  stack_bb                    numeric NOT NULL CHECK (stack_bb > 0 AND stack_bb <= 25),
  hand                        text NOT NULL CHECK (hand ~ '^[AKQJT98765432]{2}(s|o)?$'),
  final_action                text NOT NULL CHECK (final_action IN ('push','call','fold')),
  reference_distribution      jsonb NOT NULL CHECK (jsonb_typeof(reference_distribution) = 'object'),
  chosen_probability          numeric NOT NULL CHECK (chosen_probability BETWEEN 0 AND 1),
  action_regret_bb            numeric CHECK (action_regret_bb IS NULL OR action_regret_bb >= 0),
  regret_eligible             boolean NOT NULL,
  pure_miss                   boolean NOT NULL,
  source_seal                 jsonb NOT NULL CHECK (jsonb_typeof(source_seal) = 'object'),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_date, reference, state_key),
  FOREIGN KEY (run_date, reference)
    REFERENCES public.horse_solver_agreement(run_date, reference) ON DELETE CASCADE,
  CHECK ((regret_eligible AND action_regret_bb IS NOT NULL) OR
         (NOT regret_eligible AND action_regret_bb IS NULL)),
  CHECK ((kind = 'open_jam' AND final_action IN ('push','fold')) OR
         (kind = 'bb_defend' AND final_action IN ('call','fold')))
);

CREATE INDEX IF NOT EXISTS horse_solver_agreement_decisions_source
  ON public.horse_solver_agreement_decisions (run_date DESC, reference, (source_seal->>'policy_checksum'));

ALTER TABLE public.horse_solver_agreement_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.horse_solver_agreement_decisions FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.fn_horse_solver_agreement_decision_valid(jsonb,text);

CREATE OR REPLACE FUNCTION public.fn_horse_solver_agreement_decision(
  p_decision jsonb,
  p_reference text
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  v_distribution jsonb := p_decision->'reference_distribution';
  v_state jsonb := p_decision->'decision_state';
  v_seal jsonb := p_decision->'source_seal';
  v_sum numeric;
  v_chosen numeric;
  v_expected_key text;
  v_expected_chart text;
BEGIN
  IF p_decision IS NULL OR jsonb_typeof(p_decision) <> 'object'
     OR p_reference <> 'gto_charts'
     OR NOT (p_decision ?& ARRAY[
       'state_key','decision_state','kind','game_type','position','stack_bb','hand','final_action',
       'reference_distribution','chosen_probability','action_regret_bb',
       'regret_eligible','pure_miss','source_seal'
     ])
     OR (SELECT count(*) FROM jsonb_object_keys(p_decision)) <> 14
     OR COALESCE(p_decision->>'kind','') NOT IN ('open_jam','bb_defend')
     OR COALESCE(p_decision->>'game_type','') NOT IN ('Cash','Tournament')
     OR COALESCE(p_decision->>'position','') NOT IN ('UTG','MP','HJ','CO','BTN','SB','BB')
     OR COALESCE(p_decision->>'hand','') !~ '^[AKQJT98765432]{2}(s|o)?$'
     OR COALESCE((p_decision->>'stack_bb')::numeric,0) <= 0
     OR COALESCE((p_decision->>'stack_bb')::numeric,99) > 25
     OR jsonb_typeof(v_state) <> 'object'
     OR NOT (v_state ?& ARRAY[
       'schema_version','stage','game_variant','game_type','format','kind','position',
       'stack_bb','hand','chart','villain_action','legal_actions'
     ])
     OR (SELECT count(*) FROM jsonb_object_keys(v_state)) <> 12
     OR COALESCE((v_state->>'schema_version')::integer,0) <> 1
     OR v_state->>'stage' IS DISTINCT FROM 'preflop'
     OR v_state->>'game_variant' IS DISTINCT FROM 'nlh'
     OR v_state->>'game_type' IS DISTINCT FROM p_decision->>'game_type'
     OR v_state->>'format' IS DISTINCT FROM
          (CASE WHEN p_decision->>'game_type'='Tournament' THEN 'mtt' ELSE 'cash' END)
     OR v_state->>'kind' IS DISTINCT FROM p_decision->>'kind'
     OR v_state->>'position' IS DISTINCT FROM p_decision->>'position'
     OR (v_state->>'stack_bb')::numeric <> (p_decision->>'stack_bb')::numeric
     OR v_state->>'hand' IS DISTINCT FROM p_decision->>'hand'
     OR jsonb_typeof(v_distribution) <> 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(v_distribution)) <> 2
     OR jsonb_typeof(v_seal) <> 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(v_seal)) <> 9
     OR NOT (v_seal ?& ARRAY[
       'quality_seal','policy_version','policy_checksum','system','artifact_id',
       'scenario_hash','source_artifact_checksum','provenance_complete','audited_at'
     ])
     OR v_seal->>'quality_seal' IS DISTINCT FROM 'CHART_AUDITED'
     OR COALESCE(v_seal->>'policy_version','') = ''
     OR COALESCE(v_seal->>'policy_checksum','') !~ '^[0-9a-f]{64}$'
     OR v_seal->>'policy_checksum' = repeat('0',64)
     OR COALESCE(v_seal->>'system','') = ''
     OR COALESCE((v_seal->>'provenance_complete')::boolean,false) IS NOT true THEN
    RETURN false;
  END IF;

  IF p_decision->>'kind' = 'open_jam' THEN
    IF NOT (v_distribution ? 'push' AND v_distribution ? 'fold')
       OR p_decision->>'final_action' NOT IN ('push','fold')
       OR v_state->>'villain_action' IS DISTINCT FROM 'fold_to_hero'
       OR v_state->'legal_actions' IS DISTINCT FROM '["push","fold"]'::jsonb THEN RETURN false; END IF;
  ELSE
    IF NOT (v_distribution ? 'call' AND v_distribution ? 'fold')
       OR p_decision->>'final_action' NOT IN ('call','fold')
       OR v_state->>'villain_action' IS DISTINCT FROM 'sb_push'
       OR v_state->'legal_actions' IS DISTINCT FROM '["call","fold"]'::jsonb THEN RETURN false; END IF;
  END IF;

  SELECT sum(value::numeric) INTO v_sum FROM jsonb_each_text(v_distribution);
  IF v_sum IS NULL OR abs(v_sum - 1) > 0.000001
     OR EXISTS (
       SELECT 1 FROM jsonb_each_text(v_distribution)
        WHERE value::numeric < 0 OR value::numeric > 1
     ) THEN RETURN false; END IF;

  v_chosen := (v_distribution->>(p_decision->>'final_action'))::numeric;
  IF abs(v_chosen - (p_decision->>'chosen_probability')::numeric) > 0.000001 THEN
    RETURN false;
  END IF;
  IF ((p_decision->>'regret_eligible')::boolean AND p_decision->'action_regret_bb' = 'null'::jsonb)
     OR (NOT (p_decision->>'regret_eligible')::boolean AND p_decision->'action_regret_bb' <> 'null'::jsonb)
     OR (p_decision->'action_regret_bb' <> 'null'::jsonb AND (p_decision->>'action_regret_bb')::numeric < 0) THEN
    RETURN false;
  END IF;

  v_expected_key := concat_ws('|', p_decision->>'game_type', p_decision->>'kind',
    p_decision->>'position', p_decision->>'stack_bb', p_decision->>'hand');
  v_expected_chart := concat_ws('|', p_decision->>'game_type',
    CASE WHEN p_decision->>'kind'='open_jam' THEN 'fold_to_hero' ELSE 'sb_push' END,
    p_decision->>'position', p_decision->>'stack_bb');
  IF p_decision->>'state_key' IS DISTINCT FROM v_expected_key
     OR v_state->>'chart' IS DISTINCT FROM v_expected_chart THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_horse_solver_agreement_decision(jsonb,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_solver_agreement_decision(jsonb,text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fn_horse_solver_agreement_add(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  r jsonb;
  d jsonb;
  n integer := 0;
  v_run_date date;
  v_reference text;
  v_decisions jsonb;
  v_count integer;
  v_pure integer;
  v_regret_count integer;
  v_agreement numeric;
  v_regret numeric;
  v_checksum text;
  v_canonical_decisions jsonb;
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'p_rows must be a nonempty array';
  END IF;

  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    v_run_date := (r->>'run_date')::date;
    v_reference := r->>'reference';
    v_decisions := r->'decisions';
    IF v_reference <> 'gto_charts'
       OR jsonb_typeof(v_decisions) <> 'array'
       OR jsonb_array_length(v_decisions) = 0 THEN
      RAISE EXCEPTION 'solver agreement row is incomplete';
    END IF;

    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_decisions) item(value)
       WHERE NOT public.fn_horse_solver_agreement_decision(item.value, v_reference)
    ) THEN RAISE EXCEPTION 'solver agreement contains an invalid decision'; END IF;
    IF (SELECT count(DISTINCT value->>'state_key') FROM jsonb_array_elements(v_decisions))
       <> jsonb_array_length(v_decisions) THEN
      RAISE EXCEPTION 'solver agreement contains duplicate state keys';
    END IF;
    SELECT jsonb_agg(value ORDER BY value->>'state_key') INTO v_canonical_decisions
      FROM jsonb_array_elements(v_decisions);

    SELECT count(*), count(*) FILTER (WHERE (value->>'pure_miss')::boolean),
           count(*) FILTER (WHERE (value->>'regret_eligible')::boolean),
           avg((value->>'chosen_probability')::numeric),
           avg((value->>'action_regret_bb')::numeric)
             FILTER (WHERE (value->>'regret_eligible')::boolean)
      INTO v_count, v_pure, v_regret_count, v_agreement, v_regret
      FROM jsonb_array_elements(v_decisions);
    IF COALESCE((r->>'spots')::integer,-1) <> v_count
       OR COALESCE((r->>'eligible_spots')::integer,-1) <> v_count
       OR COALESCE((r->>'reconciled_spots')::integer,-1) <> v_count
       OR COALESCE((r->>'pure_misses')::integer,-1) <> v_pure
       OR COALESCE((r->>'regret_eligible_spots')::integer,-1) <> v_regret_count
       OR abs(COALESCE((r->>'agreement')::numeric,-1) - v_agreement) > 0.0001
       OR (v_regret IS NULL AND r->'action_regret_bb' <> 'null'::jsonb)
       OR (v_regret IS NOT NULL AND abs(COALESCE((r->>'action_regret_bb')::numeric,-1) - v_regret) > 0.0001) THEN
      RAISE EXCEPTION 'solver agreement summary does not reconcile to decisions';
    END IF;

    v_checksum := public.fn_gto_v31_json_checksum(v_canonical_decisions);
    INSERT INTO public.horse_solver_agreement AS t (
      run_date, reference, spots, agreement, pure_misses, eligible_spots,
      reconciled_spots, action_regret_bb, regret_eligible_spots, decision_checksum
    ) VALUES (
      v_run_date, v_reference, v_count, v_agreement, v_pure, v_count,
      v_count, v_regret, v_regret_count, v_checksum
    ) ON CONFLICT (run_date, reference) DO UPDATE SET
      spots=excluded.spots, agreement=excluded.agreement,
      pure_misses=excluded.pure_misses, eligible_spots=excluded.eligible_spots,
      reconciled_spots=excluded.reconciled_spots,
      action_regret_bb=excluded.action_regret_bb,
      regret_eligible_spots=excluded.regret_eligible_spots,
      decision_checksum=excluded.decision_checksum, created_at=now();

    DELETE FROM public.horse_solver_agreement_decisions
     WHERE run_date=v_run_date AND reference=v_reference;
    FOR d IN SELECT value FROM jsonb_array_elements(v_decisions) LOOP
      INSERT INTO public.horse_solver_agreement_decisions (
        run_date, reference, state_key, decision_state, kind, game_type, position, stack_bb, hand,
        final_action, reference_distribution, chosen_probability, action_regret_bb,
        regret_eligible, pure_miss, source_seal
      ) VALUES (
        v_run_date, v_reference, d->>'state_key', d->'decision_state', d->>'kind', d->>'game_type',
        d->>'position', (d->>'stack_bb')::numeric, d->>'hand', d->>'final_action',
        d->'reference_distribution', (d->>'chosen_probability')::numeric,
        (d->>'action_regret_bb')::numeric, (d->>'regret_eligible')::boolean,
        (d->>'pure_miss')::boolean, d->'source_seal'
      );
    END LOOP;
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_horse_solver_agreement_add(jsonb)
  FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.fn_horse_solver_agreement_add(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_audit_solver_agreement(p_day date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v jsonb := '[]'::jsonb;
  r record;
  prev numeric;
  v_details integer;
  v_checksum text;
BEGIN
  FOR r IN
    SELECT * FROM public.horse_solver_agreement
     WHERE run_date > p_day - 3 AND run_date <= p_day + 1
     ORDER BY run_date DESC LIMIT 1
  LOOP
    SELECT count(*),
           CASE WHEN count(*) > 0 THEN public.fn_gto_v31_json_checksum(
             jsonb_agg(jsonb_build_object(
               'state_key',d.state_key,'decision_state',d.decision_state,
               'kind',d.kind,'game_type',d.game_type,
               'position',d.position,'stack_bb',d.stack_bb,'hand',d.hand,
               'final_action',d.final_action,'reference_distribution',d.reference_distribution,
               'chosen_probability',d.chosen_probability,'action_regret_bb',d.action_regret_bb,
               'regret_eligible',d.regret_eligible,'pure_miss',d.pure_miss,
               'source_seal',d.source_seal
             ) ORDER BY d.state_key)
           ) END
      INTO v_details, v_checksum
      FROM public.horse_solver_agreement_decisions d
     WHERE d.run_date=r.run_date AND d.reference=r.reference;
    SELECT agreement INTO prev FROM public.horse_solver_agreement
     WHERE reference=r.reference AND run_date<r.run_date
     ORDER BY run_date DESC LIMIT 1;

    IF r.eligible_spots <> r.reconciled_spots OR r.reconciled_spots <> v_details
       OR r.decision_checksum IS NULL OR r.decision_checksum IS DISTINCT FROM v_checksum THEN
      v := v || jsonb_build_object('severity','critical','category','gto','code','solver_agreement_unreconciled',
        'title','Solver agreement decisions do not reconcile',
        'evidence',jsonb_build_object('run_date',r.run_date,'eligible',r.eligible_spots,
          'reconciled',r.reconciled_spots,'decision_rows',v_details,'checksum',r.decision_checksum),
        'recommendation','Re-run the agreement probe through fn_horse_solver_agreement_add. Never use a summary-only score as release evidence.');
    ELSIF r.spots < 50 THEN
      v := v || jsonb_build_object('severity','warn','category','gto','code','solver_agreement_thin',
        'title','Solver agreement probed only '||r.spots||' spots on '||r.run_date,
        'evidence',jsonb_build_object('spots',r.spots,'reference',r.reference),
        'recommendation','Check the in-memory chart artifact loader. Thin coverage is a reference-data failure, not evidence that the brain improved.');
    ELSIF prev IS NOT NULL AND r.agreement < prev - 0.03 THEN
      v := v || jsonb_build_object('severity','critical','category','gto','code','solver_agreement_dropped',
        'title','Solver agreement fell to '||round(r.agreement,3)||' from '||round(prev,3),
        'evidence',jsonb_build_object('agreement',r.agreement,'previous',prev,'spots',r.spots,
          'pure_misses',r.pure_misses,'reference',r.reference,'checksum',r.decision_checksum),
        'recommendation','Diff the engine deploy against HorsePreflop and the canonical policy consult, then inspect the persisted pure-miss decisions.');
    ELSE
      v := v || jsonb_build_object('severity','info','category','gto','code','solver_agreement',
        'title','Solver agreement '||round(r.agreement,3)||' over '||r.spots||' reconciled spots',
        'evidence',jsonb_build_object('agreement',r.agreement,'previous',prev,'spots',r.spots,
          'pure_misses',r.pure_misses,'reference',r.reference,'action_regret_bb',r.action_regret_bb,
          'regret_eligible_spots',r.regret_eligible_spots,'checksum',r.decision_checksum),
        'recommendation','Use the decision receipts for diagnosis. This is chart agreement, not exploitability; null regret means the chart has no measured per-action EV.');
    END IF;
  END LOOP;
  IF v = '[]'::jsonb THEN
    v := v || jsonb_build_object('severity','critical','category','gto','code','solver_agreement_missing',
      'title','No solver agreement row in the last three days','evidence',jsonb_build_object('day',p_day),
      'recommendation','HorseLeague writes this before the matchup card. Check horse_error_log for HorseLeague.agreement and the chart loader.');
  END IF;
  RETURN v;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_audit_solver_agreement(date) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.fn_audit_solver_agreement(date) TO service_role;

DROP FUNCTION IF EXISTS public.ca_horse_solver_agreement(integer);
CREATE FUNCTION public.ca_horse_solver_agreement(p_runs integer DEFAULT 14)
RETURNS TABLE (
  run_date date, reference text, spots integer, agreement numeric, pure_misses integer,
  eligible_spots integer, reconciled_spots integer, action_regret_bb numeric,
  regret_eligible_spots integer, decision_checksum text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NOT public.fn_is_horse_admin() THEN RAISE EXCEPTION 'admin only'; END IF;
  RETURN QUERY
    SELECT a.run_date,a.reference,a.spots,a.agreement,a.pure_misses,
           a.eligible_spots,a.reconciled_spots,a.action_regret_bb,
           a.regret_eligible_spots,a.decision_checksum
      FROM public.horse_solver_agreement a
     ORDER BY a.run_date DESC
     LIMIT least(greatest(COALESCE(p_runs,14),1),90);
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_horse_solver_agreement(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_horse_solver_agreement(integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ca_horse_solver_agreement_decisions(
  p_day date DEFAULT NULL,
  p_reference text DEFAULT 'gto_charts',
  p_limit integer DEFAULT 100
)
RETURNS TABLE (
  run_date date, reference text, state_key text, decision_state jsonb, kind text, game_type text,
  hero_position text, stack_bb numeric, hand text, final_action text,
  reference_distribution jsonb, chosen_probability numeric,
  action_regret_bb numeric, regret_eligible boolean, pure_miss boolean,
  source_seal jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_day date;
BEGIN
  IF NOT public.fn_is_horse_admin() THEN RAISE EXCEPTION 'admin only'; END IF;
  SELECT COALESCE(p_day,max(d.run_date)) INTO v_day
    FROM public.horse_solver_agreement_decisions d
   WHERE d.reference=p_reference;
  IF v_day IS NULL THEN RETURN; END IF;
  RETURN QUERY
    SELECT d.run_date,d.reference,d.state_key,d.decision_state,d.kind,d.game_type,d.position,
           d.stack_bb,d.hand,d.final_action,d.reference_distribution,
           d.chosen_probability,d.action_regret_bb,d.regret_eligible,
           d.pure_miss,d.source_seal
      FROM public.horse_solver_agreement_decisions d
     WHERE d.run_date=v_day AND d.reference=p_reference
     ORDER BY d.pure_miss DESC,d.action_regret_bb DESC NULLS LAST,d.state_key
     LIMIT least(greatest(COALESCE(p_limit,100),1),1000);
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_horse_solver_agreement_decisions(date,text,integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_horse_solver_agreement_decisions(date,text,integer)
  TO authenticated, service_role;

COMMENT ON TABLE public.horse_solver_agreement_decisions IS
  'Phase 4 immutable per-decision evidence behind each nightly solver-agreement summary. The database recomputes every aggregate before accepting a row.';

COMMIT;
