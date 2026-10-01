-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260720032637 "fix_cascading_commission_rate_normalization_20260719"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 fcb643a9b7ac8fcdd99dd7169182138d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- FIX-C-CASCADE 2026-07-19 — defuse the dead-but-buggy calculate_cascading_
-- commission landmine. This RPC is NOT in the live flow (the server engine pays
-- agents via settle-period -> commission_records -> fn_credit_chips; the only
-- callers of THIS rpc are dead client-engine files + a never-invoked record-rake
-- endpoint). But it divided commission_rate by 100 while agents.commission_rate
-- is stored as a FRACTION (0.30-0.70, verified 68 agents) — so if anyone ever
-- re-wires it, every agent slice would be ~100x too small. Normalize defensively:
-- a value > 1 is treated as a whole percent (/100), <= 1 as an already-normalized
-- fraction. Zero live behavior change today (nothing calls it); removes the trap.
CREATE OR REPLACE FUNCTION public.calculate_cascading_commission(
  p_hand_id uuid DEFAULT NULL::uuid, p_club_id uuid DEFAULT NULL::uuid,
  p_player_user_id uuid DEFAULT NULL::uuid, p_rake_amount numeric DEFAULT 0,
  p_rake_record_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_assignment    record;
  v_sub_agent     record;
  v_agent         record;
  v_club_owner_id uuid;
  v_remaining     numeric;
  v_slice         numeric;
  v_rate          numeric;
  v_results       jsonb := '[]'::jsonb;
  v_commission_id uuid;
BEGIN
  IF p_rake_amount IS NULL OR p_rake_amount <= 0 OR p_club_id IS NULL OR p_player_user_id IS NULL THEN
    RETURN jsonb_build_object('success', true, 'commissions', v_results, 'skipped', 'missing_inputs');
  END IF;

  v_remaining := p_rake_amount;

  SELECT * INTO v_assignment
    FROM public.player_agent_assignments
   WHERE player_id = p_player_user_id AND club_id = p_club_id;

  IF FOUND THEN
    IF v_assignment.sub_agent_id IS NOT NULL THEN
      SELECT s.id, s.parent_agent_id, s.commission_pct, s.user_id
        INTO v_sub_agent
        FROM public.sub_agents s
       WHERE s.id = v_assignment.sub_agent_id AND s.status = 'active';

      IF FOUND THEN
        -- Defensive normalization: >1 = whole percent, <=1 = fraction.
        v_rate := CASE WHEN v_sub_agent.commission_pct > 1
                       THEN v_sub_agent.commission_pct / 100.0
                       ELSE v_sub_agent.commission_pct END;
        v_slice := ROUND(v_remaining * v_rate::numeric, 4);
        IF v_slice > 0 THEN
          INSERT INTO public.agent_commissions
            (club_id, user_id, amount, commission_rate, source_type, source_id, notes)
          VALUES
            (p_club_id, v_sub_agent.user_id, v_slice, v_sub_agent.commission_pct,
             'rake', COALESCE(p_rake_record_id, p_hand_id), 'sub_agent slice')
          RETURNING id INTO v_commission_id;
          v_results := v_results || jsonb_build_object('tier', 'sub_agent',
            'user_id', v_sub_agent.user_id, 'amount', v_slice, 'commission_id', v_commission_id);
          v_remaining := v_remaining - v_slice;
        END IF;

        SELECT id, user_id, commission_rate INTO v_agent
          FROM public.agents WHERE id = v_sub_agent.parent_agent_id AND status = 'active';
      END IF;
    ELSIF v_assignment.agent_id IS NOT NULL THEN
      SELECT id, user_id, commission_rate INTO v_agent
        FROM public.agents WHERE id = v_assignment.agent_id AND status = 'active';
    END IF;

    IF v_agent.id IS NOT NULL THEN
      v_rate := CASE WHEN v_agent.commission_rate > 1
                     THEN v_agent.commission_rate / 100.0
                     ELSE v_agent.commission_rate END;
      v_slice := ROUND(v_remaining * v_rate::numeric, 4);
      IF v_slice > 0 THEN
        INSERT INTO public.agent_commissions
          (club_id, user_id, amount, commission_rate, source_type, source_id, notes)
        VALUES
          (p_club_id, v_agent.user_id, v_slice, v_agent.commission_rate,
           'rake', COALESCE(p_rake_record_id, p_hand_id), 'agent slice')
        RETURNING id INTO v_commission_id;
        v_results := v_results || jsonb_build_object('tier', 'agent',
          'user_id', v_agent.user_id, 'amount', v_slice, 'commission_id', v_commission_id);
        v_remaining := v_remaining - v_slice;
      END IF;
    END IF;
  END IF;

  SELECT owner_id INTO v_club_owner_id FROM public.clubs WHERE id = p_club_id;
  IF v_club_owner_id IS NOT NULL AND v_remaining > 0 THEN
    INSERT INTO public.agent_commissions
      (club_id, user_id, amount, commission_rate, source_type, source_id, notes)
    VALUES
      (p_club_id, v_club_owner_id, v_remaining, NULL,
       'rake', COALESCE(p_rake_record_id, p_hand_id), 'club owner residual')
    RETURNING id INTO v_commission_id;
    v_results := v_results || jsonb_build_object('tier', 'owner',
      'user_id', v_club_owner_id, 'amount', v_remaining, 'commission_id', v_commission_id);
  END IF;

  IF p_club_id IS NOT NULL THEN
    UPDATE public.club_wallets
       SET period_commission_paid   = period_commission_paid   + p_rake_amount,
           lifetime_commission_paid = lifetime_commission_paid + p_rake_amount,
           updated_at = NOW()
     WHERE club_id = p_club_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'hand_id', p_hand_id, 'club_id', p_club_id,
    'player_user_id', p_player_user_id, 'rake_amount', p_rake_amount, 'commissions', v_results);
END;
$function$;
