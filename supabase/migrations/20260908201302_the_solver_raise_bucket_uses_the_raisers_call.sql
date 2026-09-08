-- 20260908201302_the_solver_raise_bucket_uses_the_raisers_call
--
-- Phase 4's independent Python and PostgreSQL line reconstructions both used
-- the pot after the *next* player called when classifying a raise.  The action
-- contract defines raise size over the pot after the raiser calls, so the old
-- denominator systematically understated raises and could select the wrong
-- V31 facing-size cell.  Deep raise wars also inspected the hero's first prior
-- aggression instead of the immediately prior one, turning a raise-facing
-- response back into bet-raise.
--
-- This forward migration repairs the database authority to match the corrected
-- worker and carries behavior assertions for both regressions.  No strategy,
-- range, threshold, or active dataset is changed; production has no V31 corpus.

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
  v_last_raise_pot_after_call numeric;
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
        v_last_raise_pot_after_call:=NULL;
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
        IF v_wager THEN
          v_last_raise_pot_after_call:=v_pot+(v_current_target-v_contributions[v_actor+1]);
          IF v_last_raise_pot_after_call<=0 THEN RETURN NULL; END IF;
        ELSE
          v_last_raise_pot_after_call:=NULL;
        END IF;
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
      SELECT max(i) INTO v_hero_aggressive FROM generate_subscripts(v_types,1) i
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
      IF v_last_raise_pot_after_call IS NULL OR v_last_raise_pot_after_call<=0 THEN RETURN NULL; END IF;
      v_fraction:=(v_last_target-v_last_prior_target)/v_last_raise_pot_after_call;
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

DO $assert$
DECLARE
  v_mid jsonb;
  v_deep jsonb;
  v_check_raise jsonb;
  v_bet_raise jsonb;
BEGIN
  v_mid:=public.fn_gto_v31_node_line_proof('r:0:b50:b250',NULL,100,1000);
  IF v_mid->>'derived_node_role'<>'bet_raise'
     OR v_mid->>'derived_facing_kind'<>'raise'
     OR v_mid->>'derived_facing_size_bucket'<>'mid' THEN
    RAISE EXCEPTION 'a pot-sized raise was not classified over the raiser pot-after-call';
  END IF;

  v_deep:=public.fn_gto_v31_node_line_proof(
    'r:0:b50:b150:b300:b600',NULL,100,1000
  );
  IF v_deep->>'derived_node_role'<>'facing_raise'
     OR v_deep->>'derived_facing_kind'<>'raise'
     OR v_deep->>'derived_facing_size_bucket'<>'small' THEN
    RAISE EXCEPTION 'a deep re-raise used the first rather than latest hero aggression';
  END IF;

  v_check_raise:=public.fn_gto_v31_node_line_proof('r:0:c:b50:b150',NULL,100,1000);
  v_bet_raise:=public.fn_gto_v31_node_line_proof('r:0:b50:b150',NULL,100,1000);
  IF v_check_raise->>'derived_node_role'<>'check_raise'
     OR v_bet_raise->>'derived_node_role'<>'bet_raise' THEN
    RAISE EXCEPTION 'the raise fix regressed ordinary check-raise or bet-raise roles';
  END IF;
END;
$assert$;
