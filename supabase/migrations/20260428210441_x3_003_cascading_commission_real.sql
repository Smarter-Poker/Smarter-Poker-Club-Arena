-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260428210441 "x3_003_cascading_commission_real"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 793b5406f40156173591ca0c75d8aec6 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.calculate_cascading_commission(
  p_hand_id        uuid    DEFAULT NULL,
  p_club_id        uuid    DEFAULT NULL,
  p_player_user_id uuid    DEFAULT NULL,
  p_rake_amount    numeric DEFAULT 0,
  p_rake_record_id uuid    DEFAULT NULL
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_assignment      record;
  v_sub_agent       record;
  v_agent           record;
  v_club_owner_id   uuid;
  v_remaining       numeric;
  v_slice           numeric;
  v_results         jsonb := '[]'::jsonb;
  v_commission_id   uuid;
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
        v_slice := ROUND(v_remaining * (v_sub_agent.commission_pct / 100.0)::numeric, 4);
        IF v_slice > 0 THEN
          INSERT INTO public.agent_commissions
            (club_id, user_id, amount, commission_rate, source_type, source_id, notes)
          VALUES
            (p_club_id, v_sub_agent.user_id, v_slice, v_sub_agent.commission_pct,
             'rake', COALESCE(p_rake_record_id, p_hand_id),
             'sub_agent slice')
          RETURNING id INTO v_commission_id;

          v_results := v_results || jsonb_build_object(
            'tier', 'sub_agent', 'user_id', v_sub_agent.user_id,
            'amount', v_slice, 'commission_id', v_commission_id
          );
          v_remaining := v_remaining - v_slice;
        END IF;

        SELECT id, user_id, commission_rate INTO v_agent
          FROM public.agents
         WHERE id = v_sub_agent.parent_agent_id AND status = 'active';
      END IF;
    ELSIF v_assignment.agent_id IS NOT NULL THEN
      SELECT id, user_id, commission_rate INTO v_agent
        FROM public.agents
       WHERE id = v_assignment.agent_id AND status = 'active';
    END IF;

    IF v_agent.id IS NOT NULL THEN
      v_slice := ROUND(v_remaining * (v_agent.commission_rate / 100.0)::numeric, 4);
      IF v_slice > 0 THEN
        INSERT INTO public.agent_commissions
          (club_id, user_id, amount, commission_rate, source_type, source_id, notes)
        VALUES
          (p_club_id, v_agent.user_id, v_slice, v_agent.commission_rate,
           'rake', COALESCE(p_rake_record_id, p_hand_id),
           'agent slice')
        RETURNING id INTO v_commission_id;

        v_results := v_results || jsonb_build_object(
          'tier', 'agent', 'user_id', v_agent.user_id,
          'amount', v_slice, 'commission_id', v_commission_id
        );
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
       'rake', COALESCE(p_rake_record_id, p_hand_id),
       'club owner residual')
    RETURNING id INTO v_commission_id;

    v_results := v_results || jsonb_build_object(
      'tier', 'owner', 'user_id', v_club_owner_id,
      'amount', v_remaining, 'commission_id', v_commission_id
    );
  END IF;

  IF p_club_id IS NOT NULL THEN
    UPDATE public.club_wallets
       SET period_commission_paid   = period_commission_paid   + p_rake_amount,
           lifetime_commission_paid = lifetime_commission_paid + p_rake_amount,
           updated_at = NOW()
     WHERE club_id = p_club_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'hand_id', p_hand_id,
    'club_id', p_club_id,
    'player_user_id', p_player_user_id,
    'rake_amount', p_rake_amount,
    'commissions', v_results
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.calculate_cascading_commission(uuid, uuid, uuid, numeric, uuid)
  TO service_role, authenticated;
